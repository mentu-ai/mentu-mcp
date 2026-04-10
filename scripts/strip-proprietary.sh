#!/bin/bash
set -euo pipefail

# strip-proprietary.sh — Deterministic removal of proprietary code paths
# from 9 shared TypeScript source files after sync from sanctum.
#
# Pure shell (sed). No LLMs. Fully idempotent.
# Run after scripts/sync-from-sanctum.sh copies sanctum sources.

cd /Users/rashid/Desktop/mentu-mcp-ship

# ─── 1. src/intent.ts ────────────────────────────────────────────────────────
# Remove perception/judgment imports, JudgmentContext interface, ranked/serverScores
# from IntentResult, perception field from IntentRouter, judgment logic from resolve(),
# buildPerceptionScoreMap() function.

FILE=src/intent.ts

# Delete perception import line
sed -i '' "/^import type { PerceptionMode, PerceptionResult, RankedTool } from '\.\/perception\.js';$/d" "$FILE"

# Delete judgment import line
sed -i '' "/^import type { JudgmentPolicy, ServerMeta, ServerScore, EvidenceState } from '\.\/judgment\.js';$/d" "$FILE"

# Delete JudgmentContext interface block (6 lines)
sed -i '' '/^export interface JudgmentContext {$/,/^}$/d' "$FILE"

# Delete ranked/serverScores from IntentResult
sed -i '' '/^  ranked?: RankedTool\[\];$/d' "$FILE"
sed -i '' '/^  serverScores?: ServerScore\[\];$/d' "$FILE"

# Delete perception field from IntentRouter class
sed -i '' '/^  private perception: PerceptionMode | null;$/d' "$FILE"

# Fix constructor: remove perception parameter
sed -i '' 's/constructor(registry?: MCPRegistry, perception?: PerceptionMode)/constructor(registry?: MCPRegistry)/' "$FILE"

# Delete perception init in constructor
sed -i '' '/^    this\.perception = perception ?? null;$/d' "$FILE"

# Fix jsdoc: remove "NON-NEGOTIABLE" and proprietary resolution steps
sed -i '' 's/Resolution order (NON-NEGOTIABLE):/Resolution order:/' "$FILE"

# Replace 4 proprietary resolution steps with 2 open-source steps
sed -i '' '/\* 2\. If perception available, filter and rank by domain + relevance$/d' "$FILE"
sed -i '' '/\* 3\. If judgment available, re-order by server priority (budget-aware)$/d' "$FILE"
sed -i '' 's/\* 4\. Registry fallback/\* 2. Registry fallback/' "$FILE"
sed -i '' 's/\* 5\. Return ranked matches with confidence scores/\* 3. Return ranked matches with confidence scores/' "$FILE"

# Delete judgmentCtx parameter from resolve()
sed -i '' '/^    judgmentCtx?: JudgmentContext,$/d' "$FILE"

# Delete perception filter block (4 lines: comment + 3 code lines)
sed -i '' '/\/\/ 2\. Perception filter (if available)/,/: undefined;$/d' "$FILE"

# Delete judgment server prioritization block (comment + 14 code lines)
sed -i '' '/\/\/ 3\. Judgment: server prioritization/,/^      }$/d' "$FILE"

# Delete ranked/serverScores from return statement
sed -i '' '/^        ranked,$/d' "$FILE"
sed -i '' '/^        serverScores,$/d' "$FILE"

# Fix registry fallback comment number
sed -i '' 's/\/\/ 3\. Registry fallback/\/\/ 2. Registry fallback/' "$FILE"

# Delete buildPerceptionScoreMap function block (jsdoc + function, from blank line before /** to final })
# The function sits at module level after the class closing brace, preceded by a blank line.
# Match from "Build a per-server perception" backward to /** and forward to closing }
sed -i '' '/^ \* Build a per-server perception score map/,/^}$/d' "$FILE"
# Now clean up the orphaned /** and any trailing blank line + /**
sed -i '' '/^\/\*\*$/{N;/^\/\*\*\n$/d;}' "$FILE"

echo "[strip] intent.ts — removed perception/judgment imports, JudgmentContext, buildPerceptionScoreMap"

# ─── 2. src/catalog.ts ───────────────────────────────────────────────────────
# Remove perception imports, perceptionProvider field, perceptionMode parameter,
# 3-tier scoring, searchByPerception/classifyDomain/scoreRelevance methods.

FILE=src/catalog.ts

# Delete perception type import
sed -i '' "/^import type { PerceptionProvider, PerceptionResult, ToolArtifact, RankedTool } from '\.\/perception\.js';$/d" "$FILE"

# Delete perception value import
sed -i '' "/^import { toArtifact, DOMAIN_KEYWORDS, PerceptionMode } from '\.\/perception\.js';$/d" "$FILE"

# Fix score formula comment: remove 3-tier line
sed -i '' 's/Score formula (2-tier): 0\.6/Score formula: 0.6/' "$FILE"
sed -i '' "/Score formula (3-tier, when perception batch ready)/d" "$FILE"

# Delete 3-tier weight constants (4 lines including comment)
sed -i '' '/^\/\/ 3-tier weights/d' "$FILE"
sed -i '' '/^const SEMANTIC_WEIGHT_3T/d' "$FILE"
sed -i '' '/^const KEYWORD_WEIGHT_3T/d' "$FILE"
sed -i '' '/^const PERCEPTION_WEIGHT/d' "$FILE"

# Delete perceptionProvider from CatalogOptions interface
sed -i '' '/^  perceptionProvider?: PerceptionProvider;$/d' "$FILE"

# Delete perceptionProvider field from class
sed -i '' '/^  private perceptionProvider: PerceptionProvider | null;$/d' "$FILE"

# Delete perceptionProvider init in constructor
sed -i '' '/^    this\.perceptionProvider = options?\.perceptionProvider ?? null;$/d' "$FILE"

# Fix search() signature: remove perceptionMode parameter
sed -i '' 's/async search(query: string, server?: string, topN: number = DEFAULT_TOP_N, perceptionMode?: PerceptionMode)/async search(query: string, server?: string, topN: number = DEFAULT_TOP_N)/' "$FILE"

# Fix hybridSearch call: remove perceptionMode argument
sed -i '' 's/return this\.hybridSearch(queryEmbedding, words, server, topN, perceptionMode);/return this.hybridSearch(queryEmbedding, words, server, topN);/' "$FILE"

# Fix hybridSearch signature: remove perceptionMode parameter
sed -i '' '/^    perceptionMode?: PerceptionMode,$/d' "$FILE"

# Delete 3-tier perception block in hybridSearch (15 lines: from "Third tier" to normPerception)
sed -i '' '/\/\/ Third tier: perception-boosted scores from batch cache/,/const normPerception/d' "$FILE"

# Replace "Combine: 3-tier when perception available, 2-tier otherwise" comment
sed -i '' 's/\/\/ Combine: 3-tier when perception available, 2-tier otherwise/\/\/ Combine: 2-tier weighted scoring/' "$FILE"

# Replace the 3-tier ternary with simple 2-tier scoring (3 lines -> 1 line)
sed -i '' '/const combined = use3Tier$/,/: SEMANTIC_WEIGHT \* semanticScores\[i\] + KEYWORD_WEIGHT \* keywordScores\[i\];$/c\
      const combined = SEMANTIC_WEIGHT * semanticScores[i] + KEYWORD_WEIGHT * keywordScores[i];' "$FILE"

# Delete searchByPerception method block: jsdoc (starting with "Third search tier") through closing }
sed -i '' '/Third search tier: perception-boosted/,/^  }$/d' "$FILE"
# Clean up orphaned /** left before the deleted searchByPerception block
# Pattern: line is "  /**" followed by empty line — means the jsdoc body was deleted
sed -i '' '/^  \/\*\*$/{N;/^  \/\*\*\n$/d;}' "$FILE"

# Delete classifyDomain method: jsdoc + 3 code lines
sed -i '' '/Classify a tool.*domain via the perception provider/,/^  }$/d' "$FILE"
# Clean up orphaned /**
sed -i '' '/^  \/\*\*$/{N;/^  \/\*\*\n$/d;}' "$FILE"

# Delete scoreRelevance method: jsdoc + 3 code lines
sed -i '' '/Score a tool.*relevance to a query via the perception provider/,/^  }$/d' "$FILE"
# Clean up orphaned /**
sed -i '' '/^  \/\*\*$/{N;/^  \/\*\*\n$/d;}' "$FILE"

echo "[strip] catalog.ts — removed perception imports, 3-tier scoring, searchByPerception/classifyDomain/scoreRelevance"

# ─── 3. src/config.ts ────────────────────────────────────────────────────────
# Remove activation import, vmIsolation/engine from McpJsonEntry,
# activation gate block, filteredConfigs->serverConfigs.

FILE=src/config.ts

# Delete activation import line
sed -i '' "/^import { loadActivation, isActivated, getTier } from '\.\/activation\.js';$/d" "$FILE"

# Delete vmIsolation from McpJsonEntry
sed -i '' '/^  vmIsolation?: boolean;.*Run inside mentu-runtime VM$/d' "$FILE"

# Delete engine from McpJsonEntry
sed -i '' "/^  engine?: 'hybrid' | 'native' | 'bridge';.*Execution engine mode$/d" "$FILE"

# Delete vmIsolation mapping in serverConfigs
sed -i '' '/^        vmIsolation: entry\.vmIsolation,$/d' "$FILE"

# Delete engine mapping in serverConfigs
sed -i '' "/^        engine: entry\.engine ?? 'hybrid',$/d" "$FILE"

# Replace activation gate block + "if (!full) return filteredConfigs" with "if (!full) return serverConfigs"
# The block starts at "// Activation gate:" and ends before "// Parse intent routing config"
sed -i '' '/^  \/\/ Activation gate: filter by activated\.json/,/^  if (!full) return filteredConfigs;$/c\
  if (!full) return serverConfigs;' "$FILE"

# Delete blank line that was between the replaced block and intent routing
sed -i '' '/^  if (!full) return serverConfigs;$/{
  N
  s/\n$//
}' "$FILE"

# Fix final return to use serverConfigs instead of filteredConfigs
sed -i '' 's/return { servers: filteredConfigs,/return { servers: serverConfigs,/' "$FILE"

echo "[strip] config.ts — removed activation import, vmIsolation/engine, activation gate"

# ─── 4. src/child-manager.ts ─────────────────────────────────────────────────
# Remove cir_signal emission, change 'cortex healer' to 'auto-healer'.

FILE=src/child-manager.ts

# Fix stateChange handler: remove timestamp from destructured params
sed -i '' "s/{ server, from, to, timestamp }: { server: string; from: string; to: string; timestamp: number }/{ server, from, to }: { server: string; from: string; to: string; timestamp: number }/" "$FILE"

# Delete CIR signal block (comment + if block, 9 lines)
sed -i '' '/\/\/ CIR signal on degraded states/,/^      }$/d' "$FILE"

# Replace 'cortex healer' with 'auto-healer' in all log messages
sed -i '' "s/cortex healer/auto-healer/g" "$FILE"

echo "[strip] child-manager.ts — removed cir_signal emission, renamed cortex healer to auto-healer"

# ─── 5. src/mcp-client.ts ────────────────────────────────────────────────────
# Remove mentu-runtime sandbox branch in connect().

FILE=src/mcp-client.ts

# Replace the entire connect() method body from let/if-else block to simple assignments.
# The proprietary version has: let command/args/env -> if (sandbox) { mentu-runtime } else { local }
# The ship version has: const command/args/env (direct assignment)
sed -i '' '/^    let command: string;$/,/^    }$/{
      /^    let command: string;$/c\
    const command = this.config.command;\
    const args = this.config.args ?? [];\
    const env = {\
      ...process.env,\
      ...this.config.env,\
    } as Record<string, string>;
      /^    let command: string;$/!{
        /^    this\.transport = new StdioClientTransport/!d
      }
    }' "$FILE"

echo "[strip] mcp-client.ts — removed mentu-runtime sandbox branch"

# ─── 6. src/types.ts ─────────────────────────────────────────────────────────
# Remove 'mesh-tls' from ServerTransport, remove vmIsolation/engine from ServerConfig.

FILE=src/types.ts

# Remove 'mesh-tls' from ServerTransport union
sed -i '' "s/ | 'mesh-tls'//" "$FILE"

# Delete vmIsolation from ServerConfig
sed -i '' '/^  vmIsolation?: boolean;.*Run inside mentu-runtime VM/d' "$FILE"

# Delete engine from ServerConfig
sed -i '' "/^  engine?: 'hybrid' | 'native' | 'bridge';.*Execution engine mode/d" "$FILE"

echo "[strip] types.ts — removed mesh-tls, vmIsolation, engine"

# ─── 7. src/skill-catalog.ts ─────────────────────────────────────────────────
# Remove mentu-ane and mentu-runtime from SERVER_SKILL_MAP.

FILE=src/skill-catalog.ts

sed -i '' "/^  'mentu-ane': 'mentu-ane',$/d" "$FILE"
sed -i '' "/^  'mentu-runtime': 'mentu-runtime',$/d" "$FILE"

echo "[strip] skill-catalog.ts — removed mentu-ane, mentu-runtime from SERVER_SKILL_MAP"

# ─── 8. src/embedder.ts ─────────────────────────────────────────────────────
# Generic-ify ANE/Cortex comments.

FILE=src/embedder.ts

# Fix top-level doc comment (3 lines -> 2 lines)
sed -i '' 's/so we can swap the cloud Anthropic embedder for a local/so we can swap the cloud embedder for a local hardware/' "$FILE"
sed -i '' '/MentuANE hardware embedder (Mentu Cortex, zero-latency,/d' "$FILE"
sed -i '' "s/zero-cost, air-gapped) when mentu-cortex is ready\./embedder (zero-latency, zero-cost, air-gapped) when ready./" "$FILE"

# Fix Embedder facade doc comment
sed -i '' 's/Provider selection order: Local Cortex/Provider selection order: Local/' "$FILE"

echo "[strip] embedder.ts — genericified ANE/Cortex comments"

# ─── 9. src/sandbox.ts ──────────────────────────────────────────────────────
# Generic-ify script-runner comment.

FILE=src/sandbox.ts

sed -i '' 's/Inject extra globals (e\.g\., mentu SDK for script-runner)/Inject extra globals (e.g., for extended sandbox capabilities)/' "$FILE"

echo "[strip] sandbox.ts — genericified script-runner comment"

# ─── Verify TypeScript compilation ───────────────────────────────────────────

echo ""
echo "[strip] Running TypeScript compilation check..."
npx tsc --noEmit 2>&1 || {
  echo "[strip] ERROR: TypeScript compilation failed after strip"
  exit 1
}

echo ""
echo "FORTRESS_STRIP_COMPLETE"
