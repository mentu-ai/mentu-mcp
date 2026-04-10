#!/usr/bin/env node
/**
 * mentu-mcp — MCP intelligence layer (ship/fortress edition).
 *
 * 12 tools, API-backed intelligence via api.mentu.ai.
 * No local proprietary modules — perception, judgment, cortex, CIR
 * are served by IntelligenceClient.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import type { MetaMcpConfig } from './config.js';
import { ChildManager } from './child-manager.js';
import { IntentRouter } from './intent.js';
import { TrustPolicy } from './trust.js';
import { log } from './log.js';
import { EvidenceSessionManager } from './evidence.js';
import { VectorStore } from './vector-store.js';
import { Embedder } from './embedder.js';
import { ElicitationHandler } from './elicitation.js';
import { ConnectionState } from './types.js';
import type { ServerConfig, IntentRouteMap } from './types.js';
import { execute as sandboxExecute } from './sandbox.js';
import { recordLedger } from './ledger.js';
import { SkillCatalog } from './skill-catalog.js';
import { findSkillForServer } from './skill-catalog.js';
import { IntelligenceClient } from './intelligence-client.js';
import { runInit } from './init.js';

// --- Types ---

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

// --- CLI argument parsing ---

interface CliOptions {
  configPath?: string;
  maxConnections: number;
  idleTimeout: number;
  failureThreshold: number;
  cooldown: number;
}

function readPackageVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  const help = `mentu-mcp — MCP intelligence layer

Usage: mentu-mcp [options]

Options:
  --config <path>            Path to .mcp.json (default: .mcp.json)
  --max-connections <n>      Pool max connections (default: 20)
  --idle-timeout <ms>        Idle connection timeout in ms (default: 300000)
  --failure-threshold <n>    Circuit breaker consecutive failures (default: 5)
  --cooldown <ms>            Circuit breaker cooldown in ms (default: 30000)
  --help                     Show this help message
  --version                  Show version number
`;
  process.stderr.write(help);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    maxConnections: 20,
    idleTimeout: 300_000,
    failureThreshold: 5,
    cooldown: 30_000,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--version':
        process.stderr.write(readPackageVersion() + '\n');
        process.exit(0);
        break;
      case '--config':
        opts.configPath = argv[++i];
        break;
      case '--max-connections':
        opts.maxConnections = Number(argv[++i]);
        break;
      case '--idle-timeout':
        opts.idleTimeout = Number(argv[++i]);
        break;
      case '--failure-threshold':
        opts.failureThreshold = Number(argv[++i]);
        break;
      case '--cooldown':
        opts.cooldown = Number(argv[++i]);
        break;
      default:
        process.stderr.write(`Unknown option: ${arg}\n`);
        printHelp();
        process.exit(1);
    }
  }

  return opts;
}

// --- Init subcommand dispatch ---
if (process.argv.includes('init')) {
  await runInit({ yes: false, json: false });
  process.exit(0);
}

const cliOptions = parseArgs(process.argv);

// --- Server setup ---

const server = new Server(
  { name: 'mentu-mcp', version: readPackageVersion() },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  }
);

let vectorStore: VectorStore | undefined;
try {
  vectorStore = new VectorStore();
} catch (err) {
  log('warn', 'vector store unavailable', { error: err instanceof Error ? err.message : String(err) });
}

const embedder = new Embedder();
const elicitationHandler = new ElicitationHandler();

const childManager = new ChildManager(
  {
    poolSize: cliOptions.maxConnections,
    resPoolSize: 0,
    idleTimeoutMs: cliOptions.idleTimeout,
    failureThreshold: cliOptions.failureThreshold,
    cooldownMs: cliOptions.cooldown,
  },
  { vectorStore, embedder },
  (srv, request) => elicitationHandler.handle(srv, request),
);

const intentRouter = new IntentRouter();
const trustPolicy = new TrustPolicy();
const evidenceManager = new EvidenceSessionManager();
const skillCatalog = new SkillCatalog();

// Intelligence client (API-backed perception, judgment, cortex, CIR)
const apiKey = process.env.MENTU_API_KEY ?? '';
const intelligenceClient = apiKey ? new IntelligenceClient(apiKey) : null;
if (!intelligenceClient) {
  log('warn', 'MENTU_API_KEY not set — mcp_do, mcp_cortex, mcp_consult will be limited');
}

let serverConfigs: ServerConfig[] = [];
let intentRoutes: IntentRouteMap = {};
const elevatedServers = new Set<string>();

// --- Connection helpers ---

const ENSURE_CONNECT_TIMEOUT_MS = 15_000;

async function ensureServersConnected(serverNames?: string[]): Promise<void> {
  const configs = serverNames && serverNames.length > 0
    ? serverConfigs.filter(c => serverNames.includes(c.name))
    : serverConfigs;

  if (configs.length === 0) return;

  const toSpawn = configs.filter(c => {
    const s = childManager.getServerState(c.name);
    return !s || s.state === ConnectionState.CLOSED || s.state === ConnectionState.FAILED;
  });

  if (toSpawn.length > 0) {
    log('info', 'ensureServersConnected', { total: configs.length, toSpawn: toSpawn.length });
    await Promise.race([
      Promise.allSettled(
        toSpawn.map(config =>
          childManager.spawn(config).catch(err => {
            log('error', 'failed to spawn server', {
              server: config.name,
              error: err instanceof Error ? err.message : String(err),
            });
          })
        )
      ),
      new Promise<PromiseSettledResult<void>[]>(r => setTimeout(() => r([]), ENSURE_CONNECT_TIMEOUT_MS)),
    ]);
  }
}

async function ensureAllConnected(): Promise<void> {
  return ensureServersConnected();
}

// --- Inline handlers ---

async function handleDiscover(args?: Record<string, unknown>): Promise<CallToolResult> {
  const query = args?.query as string | undefined;
  const serverFilter = args?.server as string | undefined;

  if (serverFilter) {
    await ensureServersConnected([serverFilter]);
  } else {
    await ensureAllConnected();
  }

  if (!query) {
    const states = childManager.getAllStates();
    const health = childManager.getHealth();
    const servers = states.map(s => ({
      name: s.name,
      state: s.state,
      toolCount: s.toolCount,
      criticality: s.criticality,
      connection: (health.servers[s.name] as Record<string, unknown>) ?? null,
    }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ servers }, null, 2) }],
    };
  }

  const catalog = childManager.getCatalog();

  if (serverFilter) {
    const allTools = catalog.getAllTools().filter(t => t.server === serverFilter);
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const filtered = allTools.filter(t => {
      const name = t.name.toLowerCase();
      const desc = (t.description ?? '').toLowerCase();
      return words.some(w => name.includes(w) || desc.includes(w));
    });
    const tools = (filtered.length > 0 ? filtered : allTools).map(t => ({
      name: t.name,
      server: t.server,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ server: serverFilter, tools }, null, 2) }],
    };
  }

  const matches = await catalog.search(query, undefined);
  const tools = matches.map(m => ({
    name: m.tool.name,
    server: m.tool.server,
    description: m.tool.description,
    score: m.score,
    confidence: Math.round(m.confidence * 100) / 100,
  }));

  // API-backed perception enrichment when available
  if (intelligenceClient && tools.length > 0) {
    try {
      const artifacts = tools.map(t => ({ name: t.name, description: t.description ?? '', server: t.server }));
      const perception = await intelligenceClient.filterAndRank(artifacts, query, 15);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          results: tools,
          perception: perception.ranked.slice(0, 10),
          domain_distribution: perception.domain_distribution,
        }, null, 2) }],
      };
    } catch {
      // Perception API unavailable — fall through to basic results
    }
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ results: tools }, null, 2) }],
  };
}

function computeRegistryConfidence(intent: string, name: string, description: string): number {
  const intentWords = intent.toLowerCase().split(/\s+/);
  const nameWords = name.toLowerCase().split(/[-_\s]+/);
  const descWords = (description ?? '').toLowerCase().split(/\s+/);
  let score = 0;
  for (const w of intentWords) {
    if (nameWords.some(n => n.includes(w) || w.includes(n))) score += 0.3;
    if (descWords.some(d => d.includes(w))) score += 0.1;
  }
  return Math.min(score, 1.0);
}

async function handleProvision(args?: Record<string, unknown>): Promise<CallToolResult> {
  const intent = args?.intent as string;
  const context = args?.context as string | undefined;
  const autoProvision = (args?.autoProvision as boolean) ?? false;

  if (!intent) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: intent' }], isError: true };
  }

  const route = intentRoutes[intent];
  if (route) {
    const dotIdx = route.indexOf('.');
    const srv = route.substring(0, dotIdx);
    const tool = route.substring(dotIdx + 1);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ source: 'intent_route', server: srv, tool, route }, null, 2) }],
    };
  }

  await ensureAllConnected();

  const catalog = childManager.getCatalog();
  const result = await intentRouter.resolve(intent, catalog, context);

  if (result.source === 'local' || result.localMatches.length > 0) {
    const tools = result.localMatches.map(m => ({
      tool: m.tool.name,
      server: m.tool.server,
      description: m.tool.description,
      confidence: Math.round(m.confidence * 100) / 100,
    }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ source: 'local', tools }, null, 2) }],
    };
  }

  if (result.registryMatches.length > 0) {
    const matches = result.registryMatches.map(entry => {
      const confidence = computeRegistryConfidence(intent, entry.name, entry.description);
      if (autoProvision) {
        const decision = trustPolicy.evaluate(entry.name, confidence);
        return {
          name: entry.name,
          description: entry.description,
          confidence: Math.round(confidence * 100) / 100,
          trusted: decision.trusted,
          autoProvisionable: decision.decision === 'allow',
          installCommand: `npx -y ${entry.name}`,
        };
      }
      return {
        name: entry.name,
        description: entry.description,
        confidence: Math.round(confidence * 100) / 100,
        installCommand: `npx -y ${entry.name}`,
      };
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ source: 'registry', matches }, null, 2) }],
    };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ source: 'none', message: 'No matching servers found' }, null, 2) }],
  };
}

async function handleCall(args?: Record<string, unknown>): Promise<CallToolResult> {
  const serverName = args?.server as string;
  const toolName = args?.tool as string;
  const toolArgs = args?.args as Record<string, unknown> | undefined;

  if (!serverName || !toolName) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameters: server, tool' }], isError: true };
  }

  if (serverName === 'mentu-mcp' && toolName === 'health') {
    const health = childManager.getHealth();
    return { content: [{ type: 'text' as const, text: JSON.stringify(health, null, 2) }] };
  }

  if (!childManager.hasServer(serverName)) {
    const config = serverConfigs.find(c => c.name === serverName);
    if (config) {
      try {
        await childManager.spawn(config);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to connect to server ${serverName}: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    } else {
      return { content: [{ type: 'text' as const, text: `Unknown server: ${serverName}` }], isError: true };
    }
  }

  const startTime = Date.now();
  try {
    const result = await childManager.callTool(serverName, toolName, toolArgs);
    const duration = Date.now() - startTime;
    recordLedger({
      timestamp: new Date().toISOString(),
      tool: 'mcp_call',
      server: serverName,
      childTool: toolName,
      duration_ms: duration,
      success: true,
    });

    const contentItems: Array<{ type: 'text'; text: string }> = [];
    if (typeof result === 'object' && result !== null && 'content' in result) {
      const r = result as { content: Array<{ type: 'text'; text: string }> };
      contentItems.push(...r.content);
    } else {
      contentItems.push({ type: 'text' as const, text: JSON.stringify(result, null, 2) });
    }

    return { content: contentItems };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    recordLedger({
      timestamp: new Date().toISOString(),
      tool: 'mcp_call',
      server: serverName,
      childTool: toolName,
      duration_ms: Date.now() - startTime,
      success: false,
      error: errorMsg,
    });

    return {
      content: [{ type: 'text' as const, text: `Error calling ${toolName} on ${serverName}: ${errorMsg}` }],
      isError: true,
    };
  }
}

async function handleExecute(args?: Record<string, unknown>): Promise<CallToolResult> {
  const code = args?.code as string;
  if (!code) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: code' }], isError: true };
  }

  await ensureAllConnected();
  const catalog = childManager.getCatalog();

  const startTime = Date.now();
  try {
    const result = await sandboxExecute(code, childManager, catalog);
    recordLedger({
      timestamp: new Date().toISOString(),
      tool: 'mcp_execute',
      server: null,
      duration_ms: Date.now() - startTime,
      success: true,
    });
    const parts: string[] = [];
    if (result.console.length > 0) parts.push(result.console.join('\n'));
    if (result.value !== undefined) {
      parts.push(typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2));
    }
    return { content: [{ type: 'text' as const, text: parts.join('\n') || '(no output)' }] };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    recordLedger({
      timestamp: new Date().toISOString(),
      tool: 'mcp_execute',
      server: null,
      duration_ms: Date.now() - startTime,
      success: false,
      error: errorMsg,
    });
    return { content: [{ type: 'text' as const, text: `mcp_execute error: ${errorMsg}` }], isError: true };
  }
}

// --- Intent parsing helpers ---

function parseDirectCall(intent: string): { server: string; tool: string; args?: Record<string, unknown> } | null {
  const callMatch = intent.match(/^call\s+([\w-]+)[\s.]([\w_]+)(?:\s+(.+))?$/i);
  if (callMatch) {
    const args = callMatch[3] ? parseInlineArgs(callMatch[3]) : undefined;
    return { server: callMatch[1]!, tool: callMatch[2]!, args };
  }
  const codeMatch = intent.match(/^([\w-]+)\.([\w_]+)\(([^)]*)\)/);
  if (codeMatch) {
    const args = codeMatch[3] ? parseInlineArgs(codeMatch[3]) : undefined;
    return { server: codeMatch[1]!, tool: codeMatch[2]!, args };
  }
  return null;
}

function parseInlineArgs(argsStr: string): Record<string, unknown> {
  const flat: Record<string, string> = {};
  const tokenRegex = /(\S+?)=(?:"([^"]*?)"|'([^']*?)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(argsStr)) !== null) {
    flat[match[1]!] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  if (Object.keys(flat).length === 0) {
    try { return JSON.parse(argsStr); } catch { /* ignore */ }
    return {};
  }
  return flat;
}

function parseOpsIntent(intent: string): { action: string; server?: string } | null {
  const lower = intent.toLowerCase().trim();
  if (/\b(health|status|all servers)\b/.test(lower)) return { action: 'health' };
  if (/^restart\s+(\w[\w-]*)/.test(lower)) return { action: 'restart', server: lower.match(/^restart\s+(\w[\w-]*)/)?.[1] };
  if (/^diagnose\s+(\w[\w-]*)/.test(lower)) return { action: 'diagnose', server: lower.match(/^diagnose\s+(\w[\w-]*)/)?.[1] };
  if (/^start\s+(\w[\w-]*)/.test(lower)) return { action: 'start', server: lower.match(/^start\s+(\w[\w-]*)/)?.[1] };
  return null;
}

async function handleDo(args?: Record<string, unknown>): Promise<CallToolResult> {
  const what = args?.what as string | undefined;

  if (!what) {
    return { content: [{ type: 'text' as const, text: 'Missing parameter: what (describe what you want to do)' }], isError: true };
  }

  const whatStr = what.trim();

  // 1. Direct call pattern: "call server.tool" or "server.tool(args)"
  const directCall = parseDirectCall(whatStr);
  if (directCall) {
    return handleCall({ server: directCall.server, tool: directCall.tool, args: directCall.args });
  }

  // 2. Ops intent: "health", "restart server", "diagnose server"
  const ops = parseOpsIntent(whatStr);
  if (ops) {
    return handleCortex({ action: ops.action, server: ops.server });
  }

  // 3. Consult pattern: questions
  if (/^(how|what|why|when|where|can|does|is|should)\b/i.test(whatStr) || whatStr.endsWith('?')) {
    return handleConsult({ question: whatStr });
  }

  // 4. Discover pattern: "find", "search", "list"
  if (/^(find|search|list|show|discover)\b/i.test(whatStr)) {
    return handleDiscover({ query: whatStr });
  }

  // 5. API-backed intent compilation via IntelligenceClient
  if (intelligenceClient) {
    await ensureAllConnected();
    const catalog = childManager.getCatalog();
    const allTools = catalog.getAllTools();

    try {
      // Use perception to find relevant tools
      const artifacts = allTools.map(t => ({ name: t.name, description: t.description ?? '', server: t.server }));
      const perception = await intelligenceClient.filterAndRank(artifacts, whatStr, 5);

      if (perception.ranked.length > 0) {
        const top = perception.ranked[0]!;

        // Use judgment to decide if we should proceed
        const serverInfos = [...new Set(perception.ranked.map(r => r.server))].map(s => ({
          server: s,
          toolCount: allTools.filter(t => t.server === s).length,
          trusted: true,
        }));

        const evidenceState = {
          overall_confidence: 0,
          blocking_gaps: 0,
          findings_count: 0,
          servers_used: [],
          methods_used: [],
          call_count: 0,
          success_count: 0,
          failure_count: 0,
        };

        const judgment = await intelligenceClient.evaluate(serverInfos, evidenceState);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              intent: whatStr,
              recommended: {
                server: top.server,
                tool: top.name,
                score: top.combinedScore,
                domain: top.domain?.label,
              },
              alternatives: perception.ranked.slice(1, 4).map(r => ({
                server: r.server,
                tool: r.name,
                score: r.combinedScore,
              })),
              judgment: {
                should_stop: judgment.should_stop,
                prioritized: judgment.prioritized?.slice(0, 3),
              },
              hint: `Use mcp_call(server="${top.server}", tool="${top.name}", args={...}) to execute`,
            }, null, 2),
          }],
        };
      }
    } catch (err) {
      log('warn', 'intelligence API error in mcp_do', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 6. Fallback: discover tools matching the intent
  const fallback = await handleDiscover({ query: whatStr });
  const fallbackContent = fallback.content[0]?.text ?? '{}';
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        intent: whatStr,
        compiled: false,
        message: 'Could not compile intent directly. Use the discovered tools below.',
        discovery: JSON.parse(fallbackContent),
      }, null, 2),
    }],
  };
}

async function handleCortex(args?: Record<string, unknown>): Promise<CallToolResult> {
  const action = args?.action as string;
  if (!action) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: action' }], isError: true };
  }

  try {
    switch (action) {
      case 'health': {
        const states = childManager.getAllStates();
        const health = childManager.getHealth();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              servers: states.map(s => ({
                name: s.name,
                state: s.state,
                toolCount: s.toolCount,
                health: (health.servers[s.name] as Record<string, unknown>) ?? null,
              })),
              totalServers: states.length,
              connected: states.filter(s => s.state === ConnectionState.IDLE || s.state === ConnectionState.ACTIVE).length,
            }, null, 2),
          }],
        };
      }

      case 'start': {
        const serverName = args?.server as string;
        if (!serverName) return { content: [{ type: 'text' as const, text: 'Missing server parameter' }], isError: true };
        const config = serverConfigs.find(c => c.name === serverName);
        if (!config) return { content: [{ type: 'text' as const, text: `Unknown server: ${serverName}` }], isError: true };
        const tools = await childManager.spawn(config);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ started: true, server: serverName, toolCount: tools.length }, null, 2) }] };
      }

      case 'restart': {
        const serverName = args?.server as string;
        if (!serverName) return { content: [{ type: 'text' as const, text: 'Missing server parameter' }], isError: true };
        await childManager.shutdown(serverName);
        const config = serverConfigs.find(c => c.name === serverName);
        if (!config) return { content: [{ type: 'text' as const, text: `Unknown server: ${serverName}` }], isError: true };
        const tools = await childManager.spawn(config);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ restarted: true, server: serverName, toolCount: tools.length }, null, 2) }] };
      }

      case 'diagnose': {
        const serverName = args?.server as string;
        if (!serverName) return { content: [{ type: 'text' as const, text: 'Missing server parameter' }], isError: true };

        const state = childManager.getServerState(serverName);
        if (!state) return { content: [{ type: 'text' as const, text: `Server not found: ${serverName}` }], isError: true };

        // API-backed diagnosis when available
        if (intelligenceClient) {
          try {
            const diagnosis = await intelligenceClient.diagnose(serverName, state.state);
            return { content: [{ type: 'text' as const, text: JSON.stringify(diagnosis, null, 2) }] };
          } catch { /* fall through to local */ }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              server: serverName,
              state: state.state,
              toolCount: state.toolCount,
              criticality: state.criticality,
            }, null, 2),
          }],
        };
      }

      default:
        return { content: [{ type: 'text' as const, text: `Unknown cortex action: ${action}` }], isError: true };
    }
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Cortex error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

function detectServerFromQuestion(question: string): string | null {
  const lower = question.toLowerCase();
  for (const config of serverConfigs) {
    if (lower.includes(config.name.toLowerCase())) return config.name;
  }
  const domainServerMap: Record<string, string[]> = {
    'reverse engineering': ['spectre'], 'binary analysis': ['spectre'], 'decompile': ['spectre'],
    'web crawling': ['crawlio'], 'crawl': ['crawlio'],
    'browser': ['crawlio-agent-headless', 'playwright'],
    'database': ['Neon', 'neon'], 'sql': ['Neon', 'neon'],
    'email': ['resend'], 'search': ['perplexity'],
    'documentation': ['context7'], 'billing': ['paddle'],
  };
  for (const [keywords, servers] of Object.entries(domainServerMap)) {
    if (keywords.split(' ').some(kw => lower.includes(kw))) {
      const match = servers.find(s => serverConfigs.some(c => c.name.toLowerCase() === s.toLowerCase()));
      if (match) return serverConfigs.find(c => c.name.toLowerCase() === match.toLowerCase())?.name ?? match;
    }
  }
  return null;
}

async function handleConsult(args?: Record<string, unknown>): Promise<CallToolResult> {
  const question = args?.question as string;
  if (!question) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: question' }], isError: true };
  }

  const serverHint = args?.server as string | undefined;
  const serverName = serverHint ?? detectServerFromQuestion(question);

  // Skill guidance lookup
  let guidance: string | null = null;
  let skillName: string | null = null;
  if (serverName) {
    const match = findSkillForServer(serverName);
    if (match?.skillPath) {
      skillName = match.skillName;
      try {
        guidance = readFileSync(match.skillPath, 'utf-8').slice(0, 2000);
      } catch { /* skill file unreadable */ }
    }
  }

  // Tool search
  const catalog = childManager.getCatalog();
  let tools: Array<{ name: string; server: string; description?: string }> = [];
  if (serverName) {
    const serverTools = catalog.getServerTools(serverName);
    const questionWords = question.toLowerCase().split(/[\s\W]+/).filter(w => w.length > 2);
    tools = serverTools
      .filter(t => questionWords.some(w =>
        t.name.toLowerCase().includes(w) || (t.description ?? '').toLowerCase().includes(w)
      ))
      .slice(0, 3)
      .map(t => ({ name: t.name, server: t.server, description: t.description }));
    if (tools.length === 0) {
      tools = serverTools.slice(0, 3).map(t => ({ name: t.name, server: t.server, description: t.description }));
    }
  } else {
    const results = await catalog.search(question, undefined, 5);
    tools = results.map(r => ({ name: r.tool.name, server: r.tool.server, description: r.tool.description }));
  }

  // API-backed CIR query when available
  let cirResults: unknown[] | undefined;
  if (intelligenceClient && serverName) {
    try {
      const cir = await intelligenceClient.queryCIR({ query: question, limit: 3 });
      if (cir.count > 0) cirResults = cir.signals;
    } catch { /* CIR unavailable */ }
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        server: serverName,
        skill: skillName,
        guidance,
        tools,
        cir: cirResults,
        hint: guidance ? undefined : 'No skill file found for this server',
      }, null, 2),
    }],
  };
}

function serverConfigChanged(a: ServerConfig, b: ServerConfig): boolean {
  if (a.command !== b.command) return true;
  if (a.transport !== b.transport) return true;
  if (a.url !== b.url) return true;
  if (a.criticality !== b.criticality) return true;
  if (a.timeoutMs !== b.timeoutMs) return true;
  if (a.socketPath !== b.socketPath) return true;
  if (a.auth !== b.auth) return true;
  if (a.sandbox !== b.sandbox) return true;
  if (JSON.stringify(a.args) !== JSON.stringify(b.args)) return true;
  if (JSON.stringify(a.env) !== JSON.stringify(b.env)) return true;
  if (JSON.stringify(a.headers) !== JSON.stringify(b.headers)) return true;
  return false;
}

async function handleReload(_args?: Record<string, unknown>): Promise<CallToolResult> {
  let newConfig: MetaMcpConfig;
  try {
    newConfig = loadConfig(cliOptions.configPath, true);
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Reload failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  const oldNames = new Set(serverConfigs.map(c => c.name));
  const newNames = new Set(newConfig.servers.map(c => c.name));
  const newConfigMap = new Map(newConfig.servers.map(c => [c.name, c]));
  const oldConfigMap = new Map(serverConfigs.map(c => [c.name, c]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const name of oldNames) {
    if (!newNames.has(name)) removed.push(name);
  }
  for (const name of newNames) {
    if (!oldNames.has(name)) {
      added.push(name);
    } else if (serverConfigChanged(oldConfigMap.get(name)!, newConfigMap.get(name)!)) {
      changed.push(name);
    } else {
      unchanged.push(name);
    }
  }

  const toShutdown = [...removed, ...changed];
  const shutdownErrors: string[] = [];
  await Promise.allSettled(
    toShutdown.map(async (name) => {
      try {
        await childManager.shutdown(name);
      } catch (err) {
        shutdownErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  serverConfigs.length = 0;
  serverConfigs.push(...newConfig.servers);

  for (const name of elevatedServers) {
    if (!newNames.has(name)) elevatedServers.delete(name);
  }

  for (const key of Object.keys(intentRoutes)) {
    delete intentRoutes[key];
  }
  Object.assign(intentRoutes, newConfig.intents);

  elicitationHandler.updateConfig(newConfig.elicitation);

  const toSpawn = [...added, ...changed];
  const spawnErrors: string[] = [];
  const spawnResults: Array<{ name: string; toolCount: number }> = [];

  if (toSpawn.length > 0) {
    const spawnConfigs = toSpawn.map(name => newConfigMap.get(name)!);
    await Promise.race([
      Promise.allSettled(
        spawnConfigs.map(async (config) => {
          try {
            const tools = await childManager.spawn(config);
            spawnResults.push({ name: config.name, toolCount: tools.length });
          } catch (err) {
            spawnErrors.push(`${config.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        })
      ),
      new Promise<void>(r => setTimeout(r, 15_000)),
    ]);
  }

  if (elevatedServers.size > 0 && (toShutdown.some(n => elevatedServers.has(n)) || added.length > 0)) {
    server.notification({ method: 'notifications/tools/list_changed', params: {} }).catch(() => {});
  }

  const allErrors = [...shutdownErrors, ...spawnErrors];
  log('info', 'config reloaded', { added: added.length, removed: removed.length, changed: changed.length });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        reloaded: true,
        added: added.length > 0 ? added : undefined,
        removed: removed.length > 0 ? removed : undefined,
        changed: changed.length > 0 ? changed : undefined,
        unchanged: unchanged.length,
        totalServers: newConfig.servers.length,
        intentRoutes: Object.keys(newConfig.intents).length,
        errors: allErrors.length > 0 ? allErrors : undefined,
      }, null, 2),
    }],
  };
}

async function handleElevate(args?: Record<string, unknown>): Promise<CallToolResult> {
  const serverName = args?.server as string;
  if (!serverName) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: server' }], isError: true };
  }

  const remove = args?.remove === true;

  if (remove) {
    if (!elevatedServers.has(serverName)) {
      return { content: [{ type: 'text' as const, text: `Server "${serverName}" is not elevated` }], isError: true };
    }
    elevatedServers.delete(serverName);
    server.notification({ method: 'notifications/tools/list_changed', params: {} }).catch(() => {});
    return { content: [{ type: 'text' as const, text: JSON.stringify({ elevated: false, server: serverName }, null, 2) }] };
  }

  const config = serverConfigs.find(c => c.name === serverName);
  if (!config) {
    return { content: [{ type: 'text' as const, text: `Unknown server: ${serverName}` }], isError: true };
  }

  await ensureServersConnected([serverName]);

  const catalog = childManager.getCatalog();
  const tools = catalog.getServerTools(serverName);

  elevatedServers.add(serverName);
  server.notification({ method: 'notifications/tools/list_changed', params: {} }).catch(() => {});

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        elevated: true,
        server: serverName,
        toolCount: tools.length,
        tools: tools.map(t => t.name),
      }, null, 2),
    }],
  };
}

async function handleRegister(args?: Record<string, unknown>): Promise<CallToolResult> {
  const name = args?.name as string;
  if (!name) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: name' }], isError: true };
  }

  if (childManager.hasServer(name) || serverConfigs.some(c => c.name === name)) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'already_exists', name, message: `Server "${name}" is already registered` }, null, 2) }],
      isError: true,
    };
  }

  const transport = (args?.type as string) ?? 'stdio';
  const command = args?.command as string ?? '';
  const url = args?.url as string | undefined;

  if (transport === 'stdio' && !command) {
    return { content: [{ type: 'text' as const, text: 'stdio servers require "command" parameter' }], isError: true };
  }
  if ((transport === 'http' || transport === 'sse') && !url) {
    return { content: [{ type: 'text' as const, text: `${transport} servers require "url" parameter` }], isError: true };
  }

  const config: ServerConfig = {
    name,
    command,
    args: args?.args as string[] | undefined,
    env: args?.env as Record<string, string> | undefined,
    criticality: 'vital' as const,
    transport: transport as ServerConfig['transport'],
    url,
    headers: args?.headers as Record<string, string> | undefined,
  };

  const configPath = cliOptions.configPath ?? resolve(process.cwd(), '.mcp.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;

    const entry: Record<string, unknown> = {};
    if (transport !== 'stdio') entry.type = transport;
    if (command) entry.command = command;
    if (config.args) entry.args = config.args;
    if (config.env) entry.env = config.env;
    if (url) entry.url = url;
    if (config.headers) entry.headers = config.headers;

    servers[name] = entry;
    parsed.mcpServers = servers;
    writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n');
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Failed to write config: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  serverConfigs.push(config);
  let toolCount = 0;
  let health = 'ok';
  try {
    const tools = await childManager.spawn(config);
    toolCount = tools.length;
  } catch (err) {
    health = 'failed';
    log('warn', 'server registered but failed to connect', { name, error: err instanceof Error ? err.message : String(err) });
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        registered: true,
        name,
        toolCount,
        transport,
        health,
        message: health === 'ok'
          ? `Registered "${name}": ${toolCount} tools discovered`
          : `Registered "${name}" in config but connection failed — will retry on next mcp_call`,
      }, null, 2),
    }],
  };
}

function handleSkillDiscover(args?: Record<string, unknown>): CallToolResult {
  const query = args?.query as string | undefined;
  const domain = args?.domain as string | undefined;

  const matches = skillCatalog.search(query ?? '', domain);

  const enriched = skillCatalog.enrichWithReadiness(matches, (srv) => {
    if (!childManager.hasServer(srv)) {
      const config = serverConfigs.find(c => c.name === srv);
      return { available: config !== undefined, state: config ? 'configured' : '' };
    }
    const states = childManager.getAllStates();
    const serverState = states.find(s => s.name === srv);
    if (!serverState) return { available: false, state: '' };
    return {
      available: serverState.state === ConnectionState.IDLE || serverState.state === ConnectionState.ACTIVE,
      state: serverState.state,
    };
  });

  const result = enriched.map(m => ({
    skill: m.skill.name,
    description: m.skill.description,
    domain: m.skill.domain,
    archetype: m.skill.archetype,
    score: Math.round(m.score * 100) / 100,
    mcpReady: m.mcpReady,
    requiresMcp: m.skill.requiresMcp,
    source: m.skill.source,
    canonical: m.skill.canonical,
  }));

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

function handleSkillAdvise(args?: Record<string, unknown>): CallToolResult {
  const skillName = args?.skill as string;
  if (!skillName) {
    return { content: [{ type: 'text' as const, text: 'Missing required parameter: skill' }], isError: true };
  }

  const advice = skillCatalog.advise(skillName, (srv) => {
    if (!childManager.hasServer(srv)) {
      const config = serverConfigs.find(c => c.name === srv);
      return { available: false, state: config ? 'configured_not_spawned' : 'not_configured' };
    }
    const states = childManager.getAllStates();
    const serverState = states.find(s => s.name === srv);
    if (!serverState) return { available: false, state: 'unknown' };
    return {
      available: serverState.state === ConnectionState.IDLE || serverState.state === ConnectionState.ACTIVE,
      state: serverState.state,
    };
  });

  if (!advice) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'skill_not_found', skill: skillName, message: `Skill "${skillName}" not found in catalog` }, null, 2),
      }],
      isError: true,
    };
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        skill: advice.skill.name,
        domain: advice.skill.domain,
        archetype: advice.skill.archetype,
        version: advice.skill.version,
        ready: advice.allMcpReady && advice.allSubSkillsReady,
        mcpStatus: advice.mcpStatus,
        subSkillStatus: Object.keys(advice.subSkillStatus).length > 0 ? advice.subSkillStatus : undefined,
        recommendations: advice.recommendations.length > 0 ? advice.recommendations : undefined,
      }, null, 2),
    }],
  };
}

// --- Tool definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Collect elevated server tools
  const elevatedTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
  for (const serverName of elevatedServers) {
    const catalog = childManager.getCatalog();
    const tools = catalog.getServerTools(serverName);
    for (const tool of tools) {
      elevatedTools.push({
        name: `${serverName}__${tool.name}`,
        description: `[${serverName}] ${tool.description ?? ''}`,
        inputSchema: tool.inputSchema ?? { type: 'object' as const, properties: {} },
      });
    }
  }

  return {
    tools: [
      {
        name: 'mcp_discover',
        description: 'Search tool catalogs across all child MCP servers + list server status. If no query, returns server list with status and tool counts.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search query for tools' },
            server: { type: 'string', description: 'Filter to a specific server' },
          },
        },
      },
      {
        name: 'mcp_provision',
        description: 'Intent-based provisioning. Describe what you need, Mentu MCP resolves and provisions the right server.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            intent: { type: 'string', description: 'What capability you need' },
            context: { type: 'string', description: 'Additional context for resolution' },
            autoProvision: { type: 'boolean', description: 'Auto-provision if trusted (default: false)' },
          },
          required: ['intent'],
        },
      },
      {
        name: 'mcp_call',
        description: 'Forward a tool call to a specific child MCP server. Retries once on crash.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            server: { type: 'string', description: 'Target server name' },
            tool: { type: 'string', description: 'Tool name to call' },
            args: { type: 'object', description: 'Arguments to pass to the tool' },
          },
          required: ['server', 'tool'],
        },
      },
      {
        name: 'mcp_execute',
        description: 'Code-mode execution in V8 sandbox. Access provisioned servers via `servers.<name>.call(tool, args)`. Supports async/await, sleep(ms), console.log.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            code: { type: 'string', description: 'Code to execute' },
          },
          required: ['code'],
        },
      },
      {
        name: 'mcp_do',
        description: 'Intent compilation — describe what you want in natural language or structured steps. Routes to the best tool via intelligence API.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            what: { type: 'string', description: 'Natural language intent (e.g. "analyze this binary for vulnerabilities")' },
          },
        },
      },
      {
        name: 'mcp_cortex',
        description: 'Intelligence layer — manage server health, diagnostics, start/restart servers.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: { type: 'string', enum: ['health', 'start', 'restart', 'diagnose'], description: 'Cortex action' },
            server: { type: 'string', description: 'Target server name (for start/restart/diagnose)' },
          },
          required: ['action'],
        },
      },
      {
        name: 'mcp_consult',
        description: 'Consult the intelligence layer — ask questions about servers, tools, skills, or the system. Returns guidance with optional skill context.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            question: { type: 'string', description: 'Question to consult about' },
            server: { type: 'string', description: 'Hint: which server context to consult in' },
          },
          required: ['question'],
        },
      },
      {
        name: 'mcp_reload',
        description: 'Hot-reload server configuration. Detects added/removed/changed servers and reconnects as needed.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'mcp_elevate',
        description: 'Elevate a server — expose its tools directly as top-level tools (server__tool pattern). Use remove:true to de-elevate.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            server: { type: 'string', description: 'Server name to elevate' },
            remove: { type: 'boolean', description: 'De-elevate instead of elevate (default: false)' },
          },
          required: ['server'],
        },
      },
      {
        name: 'mcp_register',
        description: 'Register a new MCP server at runtime. Supports stdio, sse, and streamable-http transports.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'Server name (unique identifier)' },
            type: { type: 'string', enum: ['stdio', 'sse', 'streamable-http'], description: 'Transport type (default: stdio)' },
            command: { type: 'string', description: 'Command to run (for stdio)' },
            args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (for stdio)' },
            url: { type: 'string', description: 'URL (for sse/streamable-http)' },
            env: { type: 'object', description: 'Environment variables' },
          },
          required: ['name'],
        },
      },
      {
        name: 'mcp_skill_discover',
        description: 'Discover available skills — searchable catalog of capabilities with MCP readiness status.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search query' },
            domain: { type: 'string', description: 'Filter by domain' },
          },
        },
      },
      {
        name: 'mcp_skill_advise',
        description: 'Get detailed advice for a specific skill — prerequisites, setup steps, and usage guidance.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            skill: { type: 'string', description: 'Skill name to get advice for' },
          },
          required: ['skill'],
        },
      },
      ...elevatedTools,
    ],
  };
});

// --- Call tool handler ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: toolName, arguments: args } = request.params;

  switch (toolName) {
    case 'mcp_discover':
      return handleDiscover(args);
    case 'mcp_provision':
      return handleProvision(args);
    case 'mcp_call':
      return handleCall(args);
    case 'mcp_execute':
      return handleExecute(args);
    case 'mcp_do':
      return handleDo(args);
    case 'mcp_cortex':
      return handleCortex(args);
    case 'mcp_consult':
      return handleConsult(args);
    case 'mcp_reload':
      return handleReload(args);
    case 'mcp_elevate':
      return handleElevate(args);
    case 'mcp_register':
      return handleRegister(args);
    case 'mcp_skill_discover':
      return handleSkillDiscover(args);
    case 'mcp_skill_advise':
      return handleSkillAdvise(args);
    default:
      // Elevated server passthrough: server__tool pattern
      if (toolName.includes('__')) {
        const [serverName, tool] = toolName.split('__', 2);
        return handleCall({ server: serverName, tool, args });
      }
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
  }
});

// --- Main ---

async function main() {
  const fullConfig: MetaMcpConfig = loadConfig(cliOptions.configPath, true);
  serverConfigs = fullConfig.servers;
  intentRoutes = fullConfig.intents;

  elicitationHandler.updateConfig(fullConfig.elicitation);
  log('info', 'config loaded', {
    serverCount: serverConfigs.length,
    intentRoutes: Object.keys(intentRoutes).length,
    elicitationMode: fullConfig.elicitation.mode,
    intelligenceApi: intelligenceClient ? 'connected' : 'disabled',
  });

  // Data directory migration: ~/.metamcp → ~/.mentu/mcp
  const oldDataDir = join(homedir(), '.metamcp');
  const newDataDir = join(homedir(), '.mentu', 'mcp');
  if (existsSync(oldDataDir) && !existsSync(newDataDir)) {
    try {
      mkdirSync(dirname(newDataDir), { recursive: true });
      cpSync(oldDataDir, newDataDir, { recursive: true });
      log('info', 'migrated data directory', { from: oldDataDir, to: newDataDir });
    } catch (err) {
      log('warn', 'data directory migration failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', 'server started', { transport: 'stdio' });

  let shuttingDown = false;
  async function gracefulShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await childManager.shutdownAll();
    vectorStore?.close();
    await server.close();
    process.exit(0);
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

main().catch(err => {
  log('error', 'fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
