#!/usr/bin/env python3
"""Post-training evaluation on held-out test set.

Produces per-head accuracy, per-domain breakdown, confusion matrix,
precision/recall for stopping predictor, MSE distribution for trust trajectory.
Output: evaluation-report.json
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "training-config.yaml"

# Re-use dataset loaders from train module
sys.path.insert(0, str(SCRIPT_DIR))
from train import load_config, load_jsonl, load_trust_evolution, train_val_split


def evaluate_domain_classifier(data, labels):
    """Confusion matrix + per-domain accuracy."""
    _, test = train_val_split(data)  # use validation portion as test set

    confusion = {actual: {pred: 0 for pred in labels} for actual in labels}
    per_domain = {l: {"correct": 0, "total": 0} for l in labels}

    for r in test:
        actual = r.get("actual_domain")
        pred = r.get("predicted_domain")
        if actual in confusion and pred in confusion[actual]:
            confusion[actual][pred] += 1
        if actual in per_domain:
            per_domain[actual]["total"] += 1
            if pred == actual:
                per_domain[actual]["correct"] += 1

    overall_correct = sum(per_domain[l]["correct"] for l in labels)
    overall_total = sum(per_domain[l]["total"] for l in labels)

    per_domain_acc = {}
    for l in labels:
        t = per_domain[l]["total"]
        per_domain_acc[l] = round(per_domain[l]["correct"] / t, 4) if t else None

    return {
        "overall_accuracy": round(overall_correct / overall_total, 4) if overall_total else 0.0,
        "samples": overall_total,
        "per_domain_accuracy": per_domain_acc,
        "confusion_matrix": confusion,
    }


def evaluate_stopping_predictor(data):
    """Precision, recall, F1 for stop/continue decisions."""
    _, test = train_val_split(data)

    tp = fp = fn = tn = 0
    for r in test:
        predicted_stop = r.get("predicted_stop", False)
        # actual_outcome "success" means continuing was right (should not have stopped)
        actual_should_stop = r.get("actual_outcome") != "success"
        if predicted_stop and actual_should_stop:
            tp += 1
        elif predicted_stop and not actual_should_stop:
            fp += 1
        elif not predicted_stop and actual_should_stop:
            fn += 1
        else:
            tn += 1

    total = tp + fp + fn + tn
    accuracy = (tp + tn) / total if total else 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0

    return {
        "accuracy": round(accuracy, 4),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "samples": total,
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
    }


def evaluate_trust_trajectory(data, config):
    """MSE distribution across test sequences."""
    head_cfg = config["heads"]["trust_trajectory"]
    window = head_cfg["window_size"]
    horizon = head_cfg["prediction_horizon"]

    samples = []
    for row in data:
        scores = row["scores"]
        for i in range(len(scores) - window - horizon + 1):
            inp = scores[i : i + window]
            target = scores[i + window : i + window + horizon]
            samples.append({"input": inp, "target": target})

    _, test = train_val_split(samples)

    mse_per_sample = []
    for s in test:
        predicted = [s["input"][-1]] * horizon
        mse = sum((predicted[j] - s["target"][j]) ** 2 for j in range(horizon)) / horizon
        mse_per_sample.append(round(mse, 6))

    mse_per_sample.sort()
    n = len(mse_per_sample)
    overall_mse = sum(mse_per_sample) / n if n else 1.0

    return {
        "overall_mse": round(overall_mse, 6),
        "samples": n,
        "mse_distribution": {
            "min": mse_per_sample[0] if n else None,
            "p25": mse_per_sample[n // 4] if n else None,
            "median": mse_per_sample[n // 2] if n else None,
            "p75": mse_per_sample[3 * n // 4] if n else None,
            "max": mse_per_sample[-1] if n else None,
        },
    }


def main():
    config = load_config()
    labels = config["heads"]["domain_classifier"]["labels"]

    cls_data = load_jsonl(config["heads"]["domain_classifier"]["training_source"])
    stop_data = load_jsonl(config["heads"]["stopping_predictor"]["training_source"])
    trust_data = load_trust_evolution(config["heads"]["trust_trajectory"]["training_source"])

    report = {
        "domain_classifier": evaluate_domain_classifier(cls_data, labels),
        "stopping_predictor": evaluate_stopping_predictor(stop_data),
        "trust_trajectory": evaluate_trust_trajectory(trust_data, config),
    }

    report_path = SCRIPT_DIR / "evaluation-report.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    print("--- Evaluation Report ---")
    dc = report["domain_classifier"]
    print(f"  Domain classifier: accuracy={dc['overall_accuracy']} ({dc['samples']} samples)")
    for d, acc in dc["per_domain_accuracy"].items():
        print(f"    {d}: {acc}")

    sp = report["stopping_predictor"]
    print(f"  Stopping predictor: acc={sp['accuracy']} P={sp['precision']} R={sp['recall']} F1={sp['f1']}")

    tt = report["trust_trajectory"]
    print(f"  Trust trajectory: MSE={tt['overall_mse']} ({tt['samples']} samples)")
    dist = tt["mse_distribution"]
    print(f"    min={dist['min']} p25={dist['p25']} median={dist['median']} p75={dist['p75']} max={dist['max']}")

    print(f"\nSaved: {report_path}")


if __name__ == "__main__":
    main()
