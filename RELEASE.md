# mentu-mcp v1.0.0 — Release Document

**Date:** 2026-04-10
**Package:** `mentu-mcp`
**License:** Apache-2.0
**Status:** Pre-release (awaiting npm publish + API deployment)

---

## What Ships

A meta-MCP server that sits in front of N child MCP servers, collapsing hundreds of tools into 12 meta-tools (~1,000 schema tokens). Supports lazy spawning, connection pooling, code-mode composition, intent-based routing, and API-backed intelligence.

### 12 Tools

| Tool | Purpose | Implementation |
|------|---------|---------------|
| `mcp_discover` | Search across all servers' tool catalogs | Local catalog + API perception |
| `mcp_provision` | Intent-based server provisioning | Local |
| `mcp_call` | Forward a tool call to a child server | Local |
| `mcp_execute` | Sandboxed code-mode execution (V8) | Local |
| `mcp_do` | Autonomous multi-server orchestration | API judgment + API cortex |
| `mcp_cortex` | Diagnostic advisory | API cortex |
| `mcp_consult` | Knowledge query | API CIR query |
| `mcp_reload` | Reload server configuration | Local |
| `mcp_elevate` | Trust elevation for auto-provision | Local |
| `mcp_register` | Runtime server registration | Local |
| `mcp_skill_discover` | Skill catalog search | Local |
| `mcp_skill_advise` | Skill recommendation | Local |

4 tools are API-backed via `IntelligenceClient` (calls `api.mentu.ai`). 8 tools run entirely locally. Without `MENTU_API_KEY`, the 4 API-backed tools return errors; all other tools work normally.

---

## Architecture

```
mentu-mcp (ship)                           api.mentu.ai
+--------------------------+              +---------------------------+
| 12 MCP tools             |              | /v1/intelligence/         |
| IntelligenceClient ------+-- REST ----->|   perception              |
|   filterAndRank()        |              |   judgment                |
|   evaluate()             |              |   cortex                  |
|   diagnose()             |              |   trust, classify, embed  |
|   queryCIR()             |              | /cir/query                |
|                          |              +---------------------------+
| Local modules:           |
|   config, catalog,       |
|   child-manager, intent, |
|   trust, evidence,       |
|   sandbox, registry,     |
|   skill-catalog, embedder|
+--------------------------+
```

---

## Distribution Artifacts

| Artifact | Contents |
|----------|----------|
| `dist/index.js` | Compiled entry point with `#!/usr/bin/env node` shebang |
| `dist/**/*.js` | All compiled modules |
| `package.json` | `"bin": { "mentu-mcp": "dist/index.js" }` |
| `README.md` | Install + usage docs |
| `LICENSE` | Apache-2.0 |

Excluded from npm package (via `.npmignore`): `src/`, `scripts/`, `tsconfig.json`, `.claude/`, `.mentu/`, `*.ts` (except dist/).

---

## Pre-Release Checklist

All items completed and verified:

- [x] Ship repo created and initial commit (`a856777`)
- [x] Fortress pipeline ran: sync (`d7cbea5`) + strip (`707b653`)
- [x] IP validation: 125 patterns scanned across `src/` and `dist/` — 0 leaks
- [x] Build verification: `tsc` clean, shebang injected
- [x] 47 proprietary source files excluded from sync
- [x] 14 proprietary test files excluded from sync
- [x] 9 shared files stripped of proprietary code paths (deterministic sed)
- [x] API server intelligence endpoints committed (`f837095` wiring + `a2ca86b` engines)
- [x] API server builds clean (`swift build` exit 0)
- [x] Fortress recipe gated (`cmt_a8516cd0`, confidence 0.97)
- [x] Fortress recipe in `fortress-all` compound (wave-1-mcp)
- [x] SKILL.md updated (7th fortress product, all cross-cutting sections)
- [x] meta-authoring-complete ran 5/5 steps ($2.73) — `mcp_compile` tool registered in sanctum
- [x] Compile routing fix applied (dead code removed, `buildDoc` guard added)
- [x] `README.md`, `LICENSE`, `.npmignore`, `CLAUDE.md` — all ship-specific
- [x] `.github/workflows/ci.yml`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` present

---

## Testing Matrix

### Automated (run before every publish)

| Test | Command | What it validates |
|------|---------|-------------------|
| Build | `npm run build` | TypeScript compiles, shebang injected |
| IP scan | `bash scripts/release-validate.sh` | 0 proprietary patterns in src/ + dist/ |
| Unit: store | `node dist/__tests__/store.test.js` | Key-value store operations |
| Unit: vector-catalog | `node dist/__tests__/vector-catalog.test.js` | Vector similarity search |
| Unit: bpe-tokenizer | `node dist/__tests__/bpe-tokenizer.test.js` | Token counting |
| Unit: evidence | `node dist/__tests__/evidence.test.js` | Evidence tracking + confidence |
| Unit: sandbox | `node dist/__tests__/sandbox.test.js` | V8 sandbox isolation |
| Unit: child-manager | `node dist/__tests__/child-manager.test.js` | Server lifecycle management |
| Typecheck | `npx tsc --noEmit` | Type safety without emit |

### Manual (run before first publish)

| Test | Steps | Expected |
|------|-------|----------|
| Auto-config | `npx mentu-mcp --init` | Detects MCP client, writes config |
| Tool discovery | Connect from Claude Code, call `mcp_discover` | Returns tool catalog |
| Tool forwarding | Call `mcp_call` with a child server tool | Forwards and returns result |
| Code execution | Call `mcp_execute` with JS code | Runs in V8 sandbox |
| API perception | Set `MENTU_API_KEY`, call `mcp_discover` | Uses API-backed perception scoring |
| API cortex | Call `mcp_cortex` with diagnostic request | Returns diagnosis from api.mentu.ai |
| API consult | Call `mcp_consult` with knowledge query | Returns CIR signals from api.mentu.ai |
| No-key graceful | Unset `MENTU_API_KEY`, call `mcp_do` | Returns clear error, no crash |

### Fortress Pipeline (re-validate after sanctum changes)

```bash
mentu run mcp-fortress
# sync -> strip -> build -> validate -> test -> verify
# 25 grep_absent + 11 grep_present + tool count + API wiring checks
```

---

## Pending / Not Yet Done

### Blockers for npm publish

| Item | What's needed | Who |
|------|---------------|-----|
| GitHub repo | Create `mentu-ai/mentu-mcp`, `git remote add origin`, `git push -u origin main` | Rashid |
| npm auth | `npm login` or `.npmrc` token for `mentu-mcp` package | Rashid |
| API deployment | Deploy api-server to api.mentu.ai (intelligence endpoints committed but not live) | Rashid |

### Non-blockers (acceptable for v1.0.0)

| Item | Status | Notes |
|------|--------|-------|
| 4 unused IntelligenceClient methods | Dead code | `tuneWeights`, `computeTrust`, `classify`, `embed` — defined but uncalled. Reserved for future use. |
| `~/.metamcp` legacy path | Known leak | In `trust.ts`, `registry.ts` — migration compat path, reveals old project name only |
| `component: 'metamcp'` in log.ts | Known leak | Logger identifier, reveals old project name only |
| VS Code Marketplace extension | Blocked | Requires Azure DevOps PAT. Not in v1.0.0 scope. |
| CI/CD pipeline | Exists but inactive | `.github/workflows/ci.yml` present, needs GitHub repo to trigger |
| Cloudflare Workers edge endpoints | Blocked | CF Workers for Platforms not yet enabled. `/v1/edge/*` returns 501. |

---

## Commit History

### Ship Repo (`mentu-mcp-ship`)

```
707b653 chore: auto-commit after step fortress-strip (mcp-fortress)
d7cbea5 chore: auto-commit after step fortress-sync (mcp-fortress)
a856777 chore: initial ship repo — 12 tools, API-backed intelligence
```

### API Server (`api-server`)

```
a2ca86b feat: add perception/judgment/cortex intelligence engines
f837095 feat: wire perception/judgment/cortex handlers + CIR query endpoint
```

### Sanctum (`mentu-complete`) — relevant commits only

```
3e3e626 fix: compile routing guard + evidence test thresholds + mentu-hooks scaffold
8823b2f chore: auto-commit after step mcp-compile-register (meta-authoring-complete)
779a7e6 chore: auto-commit after step llm-decomposer (meta-authoring-complete)
76ed4f4 chore: auto-commit after step async-scaffold (meta-authoring-complete)
751d89a fix: add auth parameter to SequenceDefinition init calls in tests
```

---

## Fortress Protection Summary

| Protection | Method |
|------------|--------|
| 47 proprietary source files | Excluded from rsync |
| 14 proprietary test files | Excluded from rsync |
| 9 shared files (intent, catalog, config, child-manager, mcp-client, types, skill-catalog, embedder, sandbox) | Deterministic sed stripping |
| docs/, .mcp.test.json, .env.example | Excluded from rsync |
| CLAUDE.md | Fortress-only version (no OAuth, no proprietary paths) |
| index.ts, init.ts, intelligence-client.ts | Fortress-only files (not in sanctum) |
| 125 proprietary patterns | Scanned in src/ + dist/ by release-validate.sh |
| 25 grep_absent rules | Verified by fortress-verify step |
| 11 grep_present rules | Verified by fortress-verify step |
