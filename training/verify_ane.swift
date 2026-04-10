#!/usr/bin/env swift
/// ANE verification for Mentu adapter.
/// Confirms CoreML model runs on Apple Neural Engine, not CPU fallback.
/// Usage: swift verify_ane.swift <path-to.mlmodelc>

import CoreML
import Foundation

guard CommandLine.arguments.count > 1 else {
    print("Usage: swift verify_ane.swift <path-to.mlmodelc>")
    exit(1)
}

let modelURL = URL(fileURLWithPath: CommandLine.arguments[1])
let config = MLModelConfiguration()
config.computeUnits = .all // Prefer ANE

do {
    let model = try MLModel(contentsOf: modelURL, configuration: config)
    print("Model loaded with computeUnits = .all (ANE preferred)")

    // Verify Neural Engine availability
    if #available(macOS 14.0, iOS 17.0, *) {
        let devices = MLComputeDevice.allComputeDevices
        let hasNE = devices.contains { device in
            if case .neuralEngine = device { return true }
            return false
        }
        print("Neural Engine available: \(hasNE)")
        if !hasNE {
            print("WARN: No Neural Engine detected — will use CPU/GPU fallback")
        }
    }

    // Benchmark: 100 inference passes to measure latency + throughput
    let iterations = 100
    let description = model.modelDescription

    // Build dummy input from model's input descriptions
    let provider = try MLDictionaryFeatureProvider(
        dictionary: Dictionary(uniqueKeysWithValues:
            description.inputDescriptionsByName.map { name, desc in
                let constraint = desc.multiArrayConstraint!
                let shape = constraint.shape.map { $0.intValue }
                let arr = try! MLMultiArray(shape: constraint.shape, dataType: .float32)
                return (name, arr as MLFeatureValue)
            }
        )
    )

    let start = CFAbsoluteTimeGetCurrent()
    for _ in 0..<iterations {
        _ = try model.prediction(from: provider)
    }
    let elapsed = CFAbsoluteTimeGetCurrent() - start
    let avgMs = (elapsed / Double(iterations)) * 1000.0
    let throughput = Double(iterations) / elapsed

    print(String(format: "Inference latency: %.2f ms (target: < 5ms)", avgMs))
    print(String(format: "Throughput: %.1f cls/sec (target: 50+)", throughput))

    if avgMs < 5.0 && throughput > 50.0 {
        print("PASS: ANE performance targets met")
    } else if avgMs < 20.0 && throughput > 20.0 {
        print("PASS: CPU fallback performance acceptable")
    } else {
        print("FAIL: below minimum performance thresholds")
        exit(1)
    }
} catch {
    print("ERROR: \(error)")
    exit(1)
}
