#!/bin/bash
set -euo pipefail

# Sync from sanctum (full source) to ship (distribution-safe).
# Pattern: identical to mentu-complete-ship.
# Sanctum is NEVER modified. Ship repo gets updated files + fortress-only files restored.

SANCTUM="$HOME/Desktop/mentu-complete/mentu-mcp"
FORTRESS="$HOME/Desktop/mentu-mcp-ship"

if [ ! -d "$SANCTUM" ]; then
    echo "FATAL: Sanctum not found at $SANCTUM"
    exit 1
fi
if [ ! -d "$FORTRESS" ]; then
    echo "FATAL: Fortress not found at $FORTRESS"
    exit 1
fi

echo "=== Syncing mentu-mcp sanctum → ship ==="
echo "  Source: $SANCTUM"
echo "  Target: $FORTRESS"

# Backup fortress-only files
mkdir -p "$FORTRESS/.pre-sync-backup/src"
cp -r "$FORTRESS/scripts" "$FORTRESS/.pre-sync-backup/" 2>/dev/null || true
cp "$FORTRESS/src/index.ts" "$FORTRESS/.pre-sync-backup/src/" 2>/dev/null || true
cp "$FORTRESS/src/init.ts" "$FORTRESS/.pre-sync-backup/src/" 2>/dev/null || true
cp "$FORTRESS/src/intelligence-client.ts" "$FORTRESS/.pre-sync-backup/src/" 2>/dev/null || true
cp "$FORTRESS/package.json" "$FORTRESS/.pre-sync-backup/" 2>/dev/null || true
cp "$FORTRESS/.gitignore" "$FORTRESS/.pre-sync-backup/" 2>/dev/null || true
cp "$FORTRESS/.npmignore" "$FORTRESS/.pre-sync-backup/" 2>/dev/null || true
cp "$FORTRESS/README.md" "$FORTRESS/.pre-sync-backup/" 2>/dev/null || true
cp "$FORTRESS/LICENSE" "$FORTRESS/.pre-sync-backup/" 2>/dev/null || true
cp "$FORTRESS/CLAUDE.md" "$FORTRESS/.pre-sync-backup/" 2>/dev/null || true

rsync -av --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.mentu/' \
  --exclude='.claude/' \
  --exclude='.env' \
  --exclude='.DS_Store' \
  --exclude='.pre-sync-backup/' \
  \
  `# Fortress-only files (preserve)` \
  --exclude='scripts/' \
  --exclude='src/index.ts' \
  --exclude='src/init.ts' \
  --exclude='src/intelligence-client.ts' \
  --exclude='package.json' \
  --exclude='.gitignore' \
  --exclude='.npmignore' \
  --exclude='README.md' \
  --exclude='LICENSE' \
  --exclude='CLAUDE.md' \
  \
  `# Sanctum-only: docs, configs, dev files` \
  --exclude='docs/' \
  --exclude='.mcp.test.json' \
  --exclude='.env.example' \
  --exclude='.editorconfig' \
  \
  `# Proprietary: CIR substrate` \
  --exclude='src/cir-client.ts' \
  --exclude='src/cir-knowledge.ts' \
  \
  `# Proprietary: Cortex / ANE` \
  --exclude='src/cortex.ts' \
  --exclude='src/cortex-perception-provider.ts' \
  --exclude='src/local-cortex-embedder.ts' \
  --exclude='src/ane-config.ts' \
  --exclude='src/ane-embedder-provider.ts' \
  --exclude='src/ane-finetune-provider.ts' \
  \
  `# Proprietary: Intelligence layers` \
  --exclude='src/perception.ts' \
  --exclude='src/judgment.ts' \
  --exclude='src/recursive.ts' \
  \
  `# Proprietary: Compiler / Recipe pipeline` \
  --exclude='src/compiler.ts' \
  --exclude='src/recipe-compiler.ts' \
  --exclude='src/recipe-matcher.ts' \
  --exclude='src/recipe-directory.ts' \
  --exclude='src/recipe-directory-handler.ts' \
  --exclude='src/compile-loop.ts' \
  --exclude='src/build-decomposer.ts' \
  --exclude='src/manifest.ts' \
  --exclude='src/manifest-fixer.ts' \
  \
  `# Proprietary: Trust evolution / activation` \
  --exclude='src/trust-evolution.ts' \
  --exclude='src/activation.ts' \
  --exclude='src/jit-activation.ts' \
  \
  `# Proprietary: Daemon / Engine integration` \
  --exclude='src/daemon-client.ts' \
  --exclude='src/daemon-listener.ts' \
  --exclude='src/event-bus.ts' \
  --exclude='src/event-bus-client.ts' \
  \
  `# Proprietary: Handlers (ship has its own inline)` \
  --exclude='src/handlers.ts' \
  \
  `# Proprietary: Mentu SDK` \
  --exclude='src/mentu-sdk.ts' \
  --exclude='src/mentu-sdk-types.ts' \
  \
  `# Proprietary: VM / Transport` \
  --exclude='src/vm-provider.ts' \
  --exclude='src/unix-http-transport.ts' \
  --exclude='src/unix-jsonrpc-transport.ts' \
  --exclude='src/vsock-transport.ts' \
  \
  `# Proprietary: Mesh networking` \
  --exclude='src/mesh-client.ts' \
  --exclude='src/mesh-config.ts' \
  --exclude='src/mesh-peer-registry.ts' \
  --exclude='src/mesh-state-tracker.ts' \
  --exclude='src/mesh-types.ts' \
  \
  `# Proprietary: Intent intelligence` \
  --exclude='src/intent-mapper.ts' \
  --exclude='src/intent-registry.ts' \
  --exclude='src/intent-types.ts' \
  \
  `# Proprietary: Server/capability index` \
  --exclude='src/server-index.ts' \
  --exclude='src/capability-index.ts' \
  \
  `# Proprietary: Misc` \
  --exclude='src/crawlio.ts' \
  --exclude='src/training-extractor.ts' \
  --exclude='src/script-runner.ts' \
  --exclude='src/worker-bundler.ts' \
  \
  `# Proprietary: Tests for proprietary modules` \
  --exclude='src/__tests__/perception.test.ts' \
  --exclude='src/__tests__/judgment.test.ts' \
  --exclude='src/__tests__/recursive.test.ts' \
  --exclude='src/__tests__/integration.test.ts' \
  --exclude='src/__tests__/compiler.test.ts' \
  --exclude='src/__tests__/cortex-healer.test.ts' \
  --exclude='src/__tests__/cortex-budget-advisor.test.ts' \
  --exclude='src/__tests__/cortex-dependency-graph.test.ts' \
  --exclude='src/__tests__/e2e-godnode.test.ts' \
  --exclude='src/__tests__/e2e-vm-pipeline.test.ts' \
  --exclude='src/__tests__/cir-latency-profile.ts' \
  --exclude='src/__tests__/training-extractor.test.ts' \
  --exclude='src/__tests__/vsock-transport.test.ts' \
  --exclude='src/__tests__/unix-transport.test.ts' \
  \
  "$SANCTUM/" "$FORTRESS/"

# Restore fortress-only files
echo "  Restoring fortress-only files..."
cp -r "$FORTRESS/.pre-sync-backup/scripts" "$FORTRESS/" 2>/dev/null || true
cp "$FORTRESS/.pre-sync-backup/src/index.ts" "$FORTRESS/src/" 2>/dev/null || true
cp "$FORTRESS/.pre-sync-backup/src/init.ts" "$FORTRESS/src/" 2>/dev/null || true
cp "$FORTRESS/.pre-sync-backup/src/intelligence-client.ts" "$FORTRESS/src/" 2>/dev/null || true
cp "$FORTRESS/.pre-sync-backup/package.json" "$FORTRESS/" 2>/dev/null || true
cp "$FORTRESS/.pre-sync-backup/.gitignore" "$FORTRESS/" 2>/dev/null || true
cp "$FORTRESS/.pre-sync-backup/.npmignore" "$FORTRESS/" 2>/dev/null || true
cp "$FORTRESS/.pre-sync-backup/README.md" "$FORTRESS/" 2>/dev/null || true
cp "$FORTRESS/.pre-sync-backup/LICENSE" "$FORTRESS/" 2>/dev/null || true
cp "$FORTRESS/.pre-sync-backup/CLAUDE.md" "$FORTRESS/" 2>/dev/null || true
rm -rf "$FORTRESS/.pre-sync-backup"

# Count what synced
SYNCED=$(find "$FORTRESS/src" -name "*.ts" -not -path "*__tests__*" -not -name "index.ts" -not -name "init.ts" -not -name "intelligence-client.ts" | wc -l | tr -d ' ')
echo ""
echo "  Synced $SYNCED core source files from sanctum"
echo "  Fortress-only files preserved: index.ts, init.ts, intelligence-client.ts, package.json, scripts/"
echo "=== SYNC COMPLETE ==="
