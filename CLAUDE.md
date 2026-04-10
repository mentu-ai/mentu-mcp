# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

**mentu-mcp** -- A meta-MCP server that acts as an operating system for MCP servers. Sits in front of N child MCP servers, collapsing hundreds of tools into 12 meta-tools. Supports lazy spawning, connection pooling, code-mode composition, intent-based routing, and API-backed intelligence.

## Architecture

12 tools exposed to the LLM:

| Tool | Purpose | Backend |
|------|---------|---------|
| `mcp_discover` | Semantic/keyword search across tool catalogs | Local + API perception |
| `mcp_provision` | Intent-based server provisioning | Local |
| `mcp_call` | Forward a tool call to a child server | Local |
| `mcp_execute` | Sandboxed code-mode execution | Local (V8) |
| `mcp_do` | Autonomous multi-server orchestration | API (perception + judgment) |
| `mcp_cortex` | Diagnostic advisory | API (cortex) |
| `mcp_consult` | CIR knowledge query | API (CIR query) |
| `mcp_reload` | Reload server configuration | Local |
| `mcp_elevate` | Trust elevation for auto-provision | Local |
| `mcp_register` | Runtime server registration | Local |
| `mcp_skill_discover` | Skill catalog search | Local |
| `mcp_skill_advise` | Skill recommendation | Local |

Intelligence features (perception, judgment, cortex, CIR) are served by `api.mentu.ai` via `IntelligenceClient`.

## Commands

```bash
npm install     # Install dependencies
npm run build   # Build (TypeScript -> dist/, injects shebang)
npm test        # Build + run all 6 test suites
npm start       # Run the server
```

## Fortress

This is a distribution-safe (ship) repo. Do not add proprietary code.

- Sync from sanctum: `bash scripts/sync-from-sanctum.sh`
- Strip proprietary paths: `bash scripts/strip-proprietary.sh`
- Validate IP leaks: `bash scripts/release-validate.sh`
- Full pipeline: `mentu run mcp-fortress`
