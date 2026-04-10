#!/bin/bash
set -euo pipefail

# Validate fortress src/ and dist/ for IP leaks.
# Scans for proprietary identifiers that must not appear in the ship repo.
# Zero matches required — any hit is a leak.

FORTRESS="${1:-$(pwd)}"
cd "$FORTRESS"

echo "=== IP VALIDATION (mentu-mcp-ship) ==="

PATTERNS=(
    # CIR substrate
    'CIRKnowledge'
    'CIRClient'
    'CIRSocketClient'
    'cir-client'
    'cir-knowledge'
    'cir_signal'
    'CIREpistemics'
    # Intelligence layers
    'PerceptionProvider'
    'HeuristicPerception'
    'PerceptionMode'
    'JudgmentPolicy'
    'RecursiveExtractor'
    'buildPerceptionScoreMap'
    'perception\.ts'
    'judgment\.ts'
    'recursive\.ts'
    # Cortex / ANE
    'MentuCortexPerceptionProvider'
    'cortex-perception-provider'
    'ANEClient'
    'ANEStatus'
    'ane-control'
    'ane\.sock'
    'mentu-ane'
    'Apple Neural Engine'
    'ANEInference'
    'ane-embedder'
    'ane-finetune'
    'ane-config'
    'startANEProbe'
    'stopANEProbe'
    'cortex healer'
    'Mentu Cortex'
    'MentuANE'
    'local-cortex-embedder'
    # Cortex class (but not intelligence-client cortex references)
    "from './cortex"
    "from './cortex-perception"
    # Recipe compiler
    'recipe-compiler'
    'RecipeCompiler'
    'BuildDecomposer'
    'build-decomposer'
    'compile-loop'
    'CompileLoop'
    'ManifestFixer'
    'manifest-fixer'
    'recipe-directory'
    'RecipeDirectory'
    'recipe-matcher'
    'RecipeMatcher'
    # Trust evolution
    'TrustEvolution'
    'trust-evolution'
    'JITActivation'
    'jit-activation'
    'loadActivation'
    'isActivated'
    'getTier'
    # Daemon integration
    'daemon-client'
    'daemon-listener'
    'DaemonClient'
    'DaemonListener'
    'startDaemonListener'
    'stopDaemonListener'
    'event-bus-client'
    'EventBusClient'
    "from './event-bus"
    # Mentu SDK
    'mentu-sdk'
    'MentuSDK'
    'mentu-sdk-types'
    # VM / Transport
    'vm-provider'
    'VMExecutionProvider'
    'unix-http-transport'
    'unix-jsonrpc-transport'
    'vsock-transport'
    'VsockTransport'
    # Mesh
    'mesh-client'
    'MeshClient'
    'mesh-peer'
    'mesh-state'
    'mesh-config'
    'mesh-types'
    'mesh-tls'
    # Intent intelligence
    'intent-mapper'
    'IntentMapper'
    'intent-registry'
    'IntentRegistry'
    'intent-types'
    # Server index
    'server-index'
    'ServerIndex'
    'capability-index'
    'CapabilityIndex'
    # Misc proprietary
    'training-extractor'
    'TrainingExtractor'
    'script-runner'
    'worker-bundler'
    'mcp_control'
    'recipe_directory'
    'cir_search_hybrid'
    'vmIsolation'
    'mentu-runtime'
    'createHandlers'
)

TOTAL_HITS=0
for pattern in "${PATTERNS[@]}"; do
    # Scan src/ (exclude intelligence-client.ts which legitimately references API types)
    SRC_HITS=0
    if [ -d "src" ]; then
        SRC_HITS=$(grep -rlE "$pattern" src/ 2>/dev/null | grep -v 'src/intelligence-client.ts' | grep -v '__tests__/' | wc -l | tr -d ' ' || true)
    fi
    # Scan dist/
    DIST_HITS=0
    if [ -d "dist" ]; then
        DIST_HITS=$(grep -rlE "$pattern" dist/ 2>/dev/null | grep -v '__tests__/' | wc -l | tr -d ' ' || true)
    fi
    HITS=$((${SRC_HITS:-0} + ${DIST_HITS:-0}))
    if [ "$HITS" -gt 0 ]; then
        echo "  LEAK: '$pattern' found in $HITS file(s):"
        if [ "${SRC_HITS:-0}" -gt 0 ]; then
            grep -rlE "$pattern" src/ 2>/dev/null | grep -v 'src/intelligence-client.ts' | grep -v '__tests__/' | sed 's/^/    [src] /'
        fi
        if [ "${DIST_HITS:-0}" -gt 0 ]; then
            grep -rlE "$pattern" dist/ 2>/dev/null | grep -v '__tests__/' | sed 's/^/    [dist] /'
        fi
        TOTAL_HITS=$((TOTAL_HITS + HITS))
    fi
done

echo ""
if [ "$TOTAL_HITS" -gt 0 ]; then
    echo "FAILED: $TOTAL_HITS IP leak(s) detected"
    exit 1
else
    echo "PASSED: 0 IP leaks in src/ and dist/"
fi
echo "=== VALIDATION COMPLETE ==="
