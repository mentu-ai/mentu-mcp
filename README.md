# mentu-mcp

A meta-MCP server that acts as an operating system for MCP servers. Sits in front of N child MCP servers, collapsing hundreds of tools into 12 meta-tools (~1,000 schema tokens). Supports lazy spawning, connection pooling, code-mode composition, intent-based routing, and API-backed intelligence.

## Install

```bash
npm install -g mentu-mcp
```

Or auto-configure for your MCP client:

```bash
npx mentu-mcp --init
```

Supports: Claude Code, Cursor, VS Code, Windsurf, Zed, Gemini CLI, Claude Desktop, Amazon Q, and more.

## Tools

| Tool | Purpose |
|------|---------|
| `mcp_discover` | Search across all servers' tool catalogs |
| `mcp_provision` | Intent-based server provisioning |
| `mcp_call` | Forward a tool call to a child server |
| `mcp_execute` | Sandboxed code-mode execution (V8) |
| `mcp_do` | Autonomous multi-server orchestration |
| `mcp_cortex` | Diagnostic advisory |
| `mcp_consult` | Knowledge query |
| `mcp_reload` | Reload server configuration |
| `mcp_elevate` | Trust elevation for auto-provision |
| `mcp_register` | Runtime server registration |
| `mcp_skill_discover` | Skill catalog search |
| `mcp_skill_advise` | Skill recommendation |

## Configuration

Add MCP servers to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"]
    }
  }
}
```

## Environment

| Variable | Purpose |
|----------|---------|
| `MENTU_API_KEY` | API key for intelligence features (optional) |

## License

Apache-2.0
