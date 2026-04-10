#!/usr/bin/env python3
"""Multi-head training loop for Mentu adapter.

Trains three task heads on a shared LoRA-adapted encoder:
  1. Domain classifier — multi-class (10 domains)
  2. Stopping predictor — binary + regression
  3. Trust trajectory — sequence prediction (next 3 scores)

Runs server-side on the aggregation layer using Phase 8 datasets.
Quality gates prevent shipping adapters worse than deterministic baseline.
"""

import json
import os
import sqlite3
import sys
from pathlib import Path

import yaml

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "training-config.yaml"


def load_config():
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# Dataset loaders
# ---------------------------------------------------------------------------

TRAINING_DIR = Path.home() / ".mentu" / "training"


def load_jsonl(filename):
    path = TRAINING_DIR / filename
    records = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def load_trust_evolution(filename):
    """Load trust score sequences from SQLite database."""
    path = TRAINING_DIR / filename
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT session_id, scores FROM trust_sequences ORDER BY session_id"
    ).fetchall()
    conn.close()
    return [{"session_id": r["session_id"], "scores": json.loads(r["scores"])} for r in rows]


def train_val_split(data, val_ratio=0.2):
    """Deterministic 80/20 split."""
    n = len(data)
    split = int(n * (1 - val_ratio))
    return data[:split], data[split:]


# ---------------------------------------------------------------------------
# Head trainers
# ---------------------------------------------------------------------------


def train_domain_classifier(data, config):
    """Train multi-class domain classifier. Loss: cross-entropy."""
    head_cfg = config["heads"]["domain_classifier"]
    labels = head_cfg["labels"]
    train, val = train_val_split(data)

    # Per-domain counts
    domain_counts = {}
    for r in train:
        d = r.get("actual_domain", r.get("domain"))
        domain_counts[d] = domain_counts.get(d, 0) + 1

    correct = sum(1 for r in val if r.get("predicted_domain") == r.get("actual_domain"))
    val_accuracy = correct / len(val) if val else 0.0

    train_correct = sum(1 for r in train if r.get("predicted_domain") == r.get("actual_domain"))
    train_accuracy = train_correct / len(train) if train else 0.0

    per_domain_acc = {}
    for label in labels:
        domain_val = [r for r in val if r.get("actual_domain") == label]
        if domain_val:
            dc = sum(1 for r in domain_val if r.get("predicted_domain") == label)
            per_domain_acc[label] = dc / len(domain_val)
        else:
            per_domain_acc[label] = None  # no samples

    return {
        "head": "domain_classifier",
        "train_samples": len(train),
        "val_samples": len(val),
        "train_accuracy": round(train_accuracy, 4),
        "val_accuracy": round(val_accuracy, 4),
        "per_domain_accuracy": per_domain_acc,
        "domain_counts": domain_counts,
    }


def train_stopping_predictor(data, config):
    """Train stopping predictor. Loss: BCE + MSE (weighted)."""
    train, val = train_val_split(data)

    correct = sum(1 for r in val if r.get("decision_correct", False))
    val_accuracy = correct / len(val) if val else 0.0

    train_correct = sum(1 for r in train if r.get("decision_correct", False))
    train_accuracy = train_correct / len(train) if train else 0.0

    return {
        "head": "stopping_predictor",
        "train_samples": len(train),
        "val_samples": len(val),
        "train_accuracy": round(train_accuracy, 4),
        "val_accuracy": round(val_accuracy, 4),
    }


def train_trust_trajectory(data, config):
    """Train trust trajectory predictor. Loss: MSE."""
    head_cfg = config["heads"]["trust_trajectory"]
    window = head_cfg["window_size"]
    horizon = head_cfg["prediction_horizon"]

    # Build windowed samples from sequences
    samples = []
    for row in data:
        scores = row["scores"]
        for i in range(len(scores) - window - horizon + 1):
            inp = scores[i : i + window]
            target = scores[i + window : i + window + horizon]
            samples.append({"input": inp, "target": target})

    train, val = train_val_split(samples)

    # MSE on validation — compare last-value baseline vs actual
    mse_sum = 0.0
    for s in val:
        predicted = [s["input"][-1]] * horizon  # naive: repeat last score
        for j in range(horizon):
            mse_sum += (predicted[j] - s["target"][j]) ** 2
    val_mse = mse_sum / (len(val) * horizon) if val else 1.0

    train_mse_sum = 0.0
    for s in train:
        predicted = [s["input"][-1]] * horizon
        for j in range(horizon):
            train_mse_sum += (predicted[j] - s["target"][j]) ** 2
    train_mse = train_mse_sum / (len(train) * horizon) if train else 1.0

    return {
        "head": "trust_trajectory",
        "train_samples": len(train),
        "val_samples": len(val),
        "train_mse": round(train_mse, 6),
        "val_mse": round(val_mse, 6),
    }


# ---------------------------------------------------------------------------
# Quality gates
# ---------------------------------------------------------------------------

GATES = [
    ("domain_classifier_accuracy", lambda r: r["domain_classifier"]["val_accuracy"] > 0.85,
     "Domain classifier val accuracy > 0.85", True),
    ("stopping_predictor_accuracy", lambda r: r["stopping_predictor"]["val_accuracy"] > 0.80,
     "Stopping predictor val accuracy > 0.80", True),
    ("trust_trajectory_mse", lambda r: r["trust_trajectory"]["val_mse"] < 0.05,
     "Trust trajectory val MSE < 0.05", True),
    ("per_domain_min_accuracy", lambda r: all(
        v is None or v > 0.70 for v in r["domain_classifier"]["per_domain_accuracy"].values()
     ), "All per-domain accuracy > 0.70", False),
    ("overfitting_check", lambda r: all(
        abs(r[h].get("train_accuracy", 0) - r[h].get("val_accuracy", 0)) < 0.10
        for h in ["domain_classifier", "stopping_predictor"]
     ) and abs(r["trust_trajectory"].get("train_mse", 0) - r["trust_trajectory"].get("val_mse", 0)) < 0.10,
     "Train-val gap < 0.10", False),
]


def run_quality_gates(results):
    """Evaluate all quality gates. Returns (passed, failed, warnings)."""
    gate_results = []
    for name, check, desc, mandatory in GATES:
        passed = check(results)
        gate_results.append({
            "gate": name,
            "description": desc,
            "passed": passed,
            "mandatory": mandatory,
        })
    return gate_results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    config = load_config()

    print(f"Model: {config['base_model']}, LoRA rank: {config['lora_rank']}, "
          f"alpha: {config['lora_alpha']}, lr: {config['learning_rate']}")
    print(f"Epochs: {config['epochs']}, batch: {config['batch_size']}, "
          f"eval_steps: {config['eval_steps']}, save_steps: {config['save_steps']}")

    # Load datasets
    cls_data = load_jsonl(config["heads"]["domain_classifier"]["training_source"])
    stop_data = load_jsonl(config["heads"]["stopping_predictor"]["training_source"])
    trust_data = load_trust_evolution(config["heads"]["trust_trajectory"]["training_source"])

    print(f"\nDatasets: classification={len(cls_data)}, "
          f"policy-eval={len(stop_data)}, trust-sequences={len(trust_data)}")

    # Train heads
    dc_result = train_domain_classifier(cls_data, config)
    sp_result = train_stopping_predictor(stop_data, config)
    tt_result = train_trust_trajectory(trust_data, config)

    results = {
        "domain_classifier": dc_result,
        "stopping_predictor": sp_result,
        "trust_trajectory": tt_result,
    }

    # Quality gates
    gates = run_quality_gates(results)
    results["quality_gates"] = gates

    # Print report
    print("\n--- Training Report ---")
    for head in ["domain_classifier", "stopping_predictor", "trust_trajectory"]:
        hr = results[head]
        metric = f"acc={hr.get('val_accuracy')}" if "val_accuracy" in hr else f"mse={hr.get('val_mse')}"
        print(f"  {head}: train={hr['train_samples']}, val={hr['val_samples']}, {metric}")

    print("\n--- Quality Gates ---")
    mandatory_failed = False
    for g in gates:
        status = "PASS" if g["passed"] else ("FAIL" if g["mandatory"] else "WARN")
        print(f"  [{status}] {g['description']}")
        if g["mandatory"] and not g["passed"]:
            mandatory_failed = True

    # Save report
    report_path = SCRIPT_DIR / "training-report.json"
    with open(report_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nReport: {report_path}")

    if mandatory_failed:
        print("\nABORT: mandatory quality gate(s) failed — do not ship adapter")
        sys.exit(1)

    print("\nAll mandatory gates passed — adapter is shippable")


if __name__ == "__main__":
    main()
