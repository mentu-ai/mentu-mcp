# mentu-mcp

[![npm version](https://img.shields.io/npm/v/mentu-mcp)](https://www.npmjs.com/package/mentu-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/mentu-ai/mentu-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mentu-ai/mentu-mcp/actions/workflows/ci.yml)
![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

A meta-MCP server that collapses hundreds of tools into 12 meta-tools (~1,000 schema tokens).

## How It Works

mentu-mcp sits between your MCP client and any number of child MCP servers. Instead of registering every tool from every server (which can exceed context limits), it exposes 12 meta-tools that discover, route, and execute calls across all connected servers.

```
Client (Claude Code, Cursor, VS Code, Windsurf...)
  |
  +-- mentu-mcp (12 meta-tools, ~1,000 tokens)
        |
        +-- mcp_discover    search across all servers
        +-- mcp_provision   intent-based provisioning
        +-- mcp_call        forward tool calls
        +-- mcp_execute     V8 sandboxed code execution
        +-- mcp_do          autonomous orchestration (API)
        +-- mcp_cortex      diagnostic advisory (API)
        +-- mcp_consult     knowledge query (API)
        +-- mcp_reload      reload configuration
        +-- mcp_elevate     trust elevation
        +-- mcp_register    runtime server registration
        +-- mcp_skill_*     skill catalog (2 tools)
        |
        +-- child-server-1 (50 tools)
        +-- child-server-2 (30 tools)
        +-- child-server-N (...)
```

## Quick Start

```bash
# Install globally
npm install -g mentu-mcp

# Auto-configure for your MCP client
mentu-mcp --init

# Verify
mentu-mcp --version
```

`--init` detects your MCP client (Claude Code, Cursor, VS Code, Windsurf, Zed, Claude Desktop, Gemini CLI, Amazon Q) and writes the appropriate configuration file.

## Supported Clients

| Client | Config file | Auto-detected |
|--------|-------------|:---:|
| Claude Code | `.mcp.json` | Yes |
| Cursor | `.cursor/mcp.json` | Yes |
| VS Code | `.vscode/mcp.json` | Yes |
| Windsurf | `~/.windsurf/mcp.json` | Yes |
| Zed | `~/.config/zed/settings.json` | Yes |
| Claude Desktop | `claude_desktop_config.json` | Yes |
| Gemini CLI | `.gemini/settings.json` | Yes |
| Amazon Q | `.amazonq/mcp.json` | Yes |
| Any MCP-compatible client | Manual `.mcp.json` | -- |

## Tools

| Tool | Description | Requires API |
|------|-------------|:---:|
| `mcp_discover` | Search across all servers' tool catalogs | -- |
| `mcp_provision` | Intent-based server provisioning from npm | -- |
| `mcp_call` | Forward a tool call to a child server | -- |
| `mcp_execute` | Run code in a V8 sandbox | -- |
| `mcp_reload` | Reload `.mcp.json` configuration at runtime | -- |
| `mcp_elevate` | Elevate trust level for auto-provisioned servers | -- |
| `mcp_register` | Register a new server at runtime | -- |
| `mcp_skill_discover` | Search the skill catalog | -- |
| `mcp_skill_advise` | Get skill recommendations for a task | -- |
| `mcp_do` | Autonomous multi-server orchestration | Yes |
| `mcp_cortex` | Diagnostic advisory | Yes |
| `mcp_consult` | Knowledge query | Yes |

## Configuration

Add child MCP servers to `~/.mcp.json` (or use `--init` to generate):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "my-server": {
      "command": "node",
      "args": ["./path/to/server.js"]
    }
  }
}
```

mentu-mcp spawns child servers lazily on first use, manages connection pooling with circuit breakers, and tears them down on idle timeout.

## API Intelligence

9 of 12 tools run entirely locally with no network calls. 3 tools (`mcp_do`, `mcp_cortex`, `mcp_consult`) are backed by the mentu intelligence API for perception scoring, judgment evaluation, and diagnostic advisory.

**Without an API key:** all local tools work normally. API-backed tools return a clear error explaining the requirement.

**With an API key:**

```bash
export MENTU_API_KEY=your_key
```

Or set it in your `.mcp.json`:

```json
{
  "mcpServers": {
    "mentu": {
      "command": "npx",
      "args": ["-y", "mentu-mcp"],
      "env": {
        "MENTU_API_KEY": "your_key"
      }
    }
  }
}
```

100 free API calls per day. No credit card required.

## Intent Routing

Map natural-language intents to specific tools in your config:

```json
{
  "intents": {
    "crawl": "crawlio.start_crawl",
    "analyze": "crawlio.analyze_page",
    "browse": "playwright.execute"
  }
}
```

When `mcp_provision` receives a request matching an intent, it routes directly to the mapped tool without searching.

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|:---:|
| `MENTU_API_KEY` | API key for intelligence features | No |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and pull request guidelines.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[Apache-2.0](LICENSE)
