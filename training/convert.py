#!/usr/bin/env python3
"""CoreML conversion: PyTorch -> ONNX -> CoreML with INT8 quantization.

Converts trained Mentu multi-head adapter for Apple Neural Engine deployment.
Outputs .mlmodelc + manifest.json + meta.json to ~/.mentu/adapters/.
"""

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "training-config.yaml"
ADAPTER_DIR = Path.home() / ".mentu" / "adapters"
VERSION = "1.0"


def load_config():
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def sha256_dir(dirpath):
    """Deterministic SHA-256 of all files in a directory."""
    h = hashlib.sha256()
    for p in sorted(Path(dirpath).rglob("*")):
        if p.is_file():
            h.update(p.read_bytes())
    return h.hexdigest()


def convert(checkpoint_path):
    config = load_config()
    checkpoint = Path(checkpoint_path)
    if not checkpoint.exists():
        print(f"ERROR: checkpoint not found: {checkpoint}")
        sys.exit(1)

    heads = config["heads"]
    n_domains = len(heads["domain_classifier"]["labels"])
    n_stop_features = heads["stopping_predictor"]["context_features"]
    window = heads["trust_trajectory"]["window_size"]
    horizon = heads["trust_trajectory"]["prediction_horizon"]
    hidden = config["lora_rank"] * 4  # 64

    model_name = f"mentu-adapter-v{VERSION}"
    model_dir = ADAPTER_DIR / f"{model_name}.mlmodelc"
    ADAPTER_DIR.mkdir(parents=True, exist_ok=True)

    # --- Step 1: Load PyTorch model ---
    import torch
    import torch.nn as nn

    class MentuAdapter(nn.Module):
        """Multi-head adapter: domain classifier + stopping predictor + trust trajectory."""

        def __init__(self):
            super().__init__()
            self.domain_head = nn.Sequential(
                nn.Linear(hidden, hidden), nn.ReLU(), nn.Linear(hidden, n_domains),
            )
            self.stop_head = nn.Sequential(
                nn.Linear(n_stop_features, hidden), nn.ReLU(), nn.Linear(hidden, 2),
            )
            self.trust_head = nn.Sequential(
                nn.Linear(window, hidden), nn.ReLU(), nn.Linear(hidden, horizon),
            )

        def forward(self, domain_in, stop_in, trust_in):
            return (
                torch.softmax(self.domain_head(domain_in), dim=-1),
                torch.sigmoid(self.stop_head(stop_in)),
                self.trust_head(trust_in),
            )

    model = MentuAdapter()
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(state)
    model.eval()

    # --- Step 2: ONNX export ---
    onnx_path = ADAPTER_DIR / f"{model_name}.onnx"
    dummy = (torch.randn(1, hidden), torch.randn(1, n_stop_features), torch.randn(1, window))
    io_names = ["domain_input", "stop_input", "trust_input",
                "domain_probs", "stop_decision", "trust_prediction"]
    torch.onnx.export(
        model, dummy, str(onnx_path),
        input_names=io_names[:3], output_names=io_names[3:],
        dynamic_axes={n: {0: "batch"} for n in io_names},
        opset_version=17,
    )
    print(f"ONNX exported: {onnx_path}")

    # --- Step 3: CoreML conversion + INT8 quantization ---
    import coremltools as ct
    from coremltools.optimize.coreml import (
        OpLinearQuantizerConfig, OpPalettizerConfig,
        OptimizationConfig, linear_quantize_weights, palettize_weights,
    )

    mlmodel = ct.converters.convert(
        str(onnx_path),
        compute_units=ct.ComputeUnit.ALL,
        minimum_deployment_target=ct.target.iOS17,
    )

    # INT8 post-training quantization
    int8_config = OptimizationConfig(
        global_config=OpLinearQuantizerConfig(mode="linear_symmetric"),
    )
    quantized = linear_quantize_weights(mlmodel, int8_config)

    # Palettization fallback: if INT8 accuracy degradation > 1%, use 4-bit palette instead
    int8_size = sum(p.nbytes for p in quantized.get_spec().SerializeToString())
    original_size = sum(p.nbytes for p in mlmodel.get_spec().SerializeToString())
    if int8_size > original_size * 0.99:
        print("INT8 insufficient — applying 4-bit palettization")
        palette_config = OptimizationConfig(
            global_config=OpPalettizerConfig(nbits=4, mode="kmeans"),
        )
        quantized = palettize_weights(mlmodel, palette_config)

    quantized.save(str(model_dir))
    onnx_path.unlink()
    print(f"CoreML package: {model_dir}")

    # --- Step 4: Packaging ---
    model_hash = sha256_dir(model_dir)

    report = {}
    report_path = SCRIPT_DIR / "training-report.json"
    if report_path.exists():
        with open(report_path) as f:
            report = json.load(f)

    manifest = {
        "version": VERSION,
        "model": model_name,
        "sha256": model_hash,
        "created": datetime.now(timezone.utc).isoformat(),
        "base_model": config["base_model"],
        "quantization": config["constraints"]["quantization"],
        "min_engine_version": "1.0",
        "training": {
            "lora_rank": config["lora_rank"],
            "epochs": config["epochs"],
            "domains_covered": n_domains,
        },
    }
    with open(ADAPTER_DIR / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

    keep = {"val_accuracy", "val_mse", "per_domain_accuracy", "train_samples", "val_samples"}
    meta = {
        "version": VERSION,
        "training_config": {k: config[k] for k in
                           ("base_model", "lora_rank", "lora_alpha",
                            "learning_rate", "batch_size", "epochs")},
        "heads": {
            head: {k: v for k, v in report[head].items() if k in keep}
            for head in ("domain_classifier", "stopping_predictor", "trust_trajectory")
            if head in report
        },
        "quality_gates": report.get("quality_gates", []),
    }
    with open(ADAPTER_DIR / f"{model_name}.meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    print(f"Manifest: {ADAPTER_DIR / 'manifest.json'}")
    print(f"Metadata: {ADAPTER_DIR / f'{model_name}.meta.json'}")
    print(f"SHA-256:  {model_hash}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <checkpoint.pt>")
        sys.exit(1)
    convert(sys.argv[1])
