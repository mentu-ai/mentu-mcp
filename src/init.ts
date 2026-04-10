/**
 * mentu-mcp init — Auto-configure Mentu MCP as MCP server across all supported clients.
 *
 * Discovers the binary path, writes config to 9+ client locations,
 * returns structured JSON for programmatic consumption.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --- Types ---

export interface InitResult {
  success: boolean;
  binaryPath: string;
  configuredClients: Array<{ client: string; path: string; status: 'added' | 'created' }>;
  failedClients: Array<{ client: string; path: string; error: string }>;
  errors: string[];
}

type ConfigFormat = 'json' | 'toml' | 'zed';

interface ConfigTarget {
  client: string;
  path: string;
  serverKey: string;
  format: ConfigFormat;
}

interface InitOptions {
  yes: boolean;
  json: boolean;
}

// --- Binary Discovery ---

function discoverBinaryPath(): string | null {
  const home = homedir();
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = dirname(thisFile);

  const candidates = [
    join(distDir, 'index.js'),
    process.argv[1]?.endsWith('index.js') ? resolve(process.argv[1]) : null,
    join(home, '.mentu', 'bin', 'mentu-mcp'),
    join(home, '.local', 'bin', 'mentu-mcp'),
    join(home, 'Desktop', 'metamcp', 'dist', 'index.js'),
    '/opt/homebrew/bin/mentu-mcp',
    '/usr/local/bin/mentu-mcp',
    join(home, '.metamcp', 'bin', 'metamcp'),
    '/opt/homebrew/bin/metamcp',
    '/usr/local/bin/metamcp',
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  for (const bin of ['mentu-mcp', 'metamcp']) {
    try {
      const result = execSync(`which ${bin}`, { encoding: 'utf-8', timeout: 5_000 }).trim();
      if (result && existsSync(result)) return result;
    } catch {
      // not in PATH
    }
  }

  return null;
}

// --- Config Targets ---

function getConfigTargets(): ConfigTarget[] {
  const home = homedir();
  return [
    { client: 'Global', path: join(home, '.mcp.json'), serverKey: 'mcpServers', format: 'json' },
    { client: 'Claude Code', path: join(home, '.claude.json'), serverKey: 'mcpServers', format: 'json' },
    { client: 'Claude Desktop', path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), serverKey: 'mcpServers', format: 'json' },
    { client: 'Cursor', path: join(home, '.cursor', 'mcp.json'), serverKey: 'mcpServers', format: 'json' },
    { client: 'VS Code', path: join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'), serverKey: 'servers', format: 'json' },
    { client: 'Windsurf', path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), serverKey: 'mcpServers', format: 'json' },
    { client: 'Zed', path: join(home, 'Library', 'Application Support', 'Zed', 'settings.json'), serverKey: 'context_servers', format: 'zed' },
    { client: 'Gemini CLI', path: join(home, '.gemini', 'settings.json'), serverKey: 'mcpServers', format: 'json' },
    { client: 'GitHub Copilot CLI', path: join(home, '.copilot', 'mcp-config.json'), serverKey: 'mcpServers', format: 'json' },
    { client: 'Codex', path: join(home, '.codex', 'config.toml'), serverKey: 'mcp_servers', format: 'toml' },
    { client: 'Codex (XDG)', path: join(home, '.config', 'codex', 'config.toml'), serverKey: 'mcp_servers', format: 'toml' },
  ];
}

// --- Migration ---

function migrateClientConfig(target: ConfigTarget): void {
  try {
    if (!existsSync(target.path)) return;
    if (target.format === 'toml') return;

    const raw = readFileSync(target.path, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const servers = config[target.serverKey] as Record<string, unknown> | undefined;

    if (!servers?.['metamcp'] || servers?.['mentu-mcp']) return;

    servers['mentu-mcp'] = servers['metamcp'];
    const entry = servers['mentu-mcp'] as Record<string, unknown>;

    if (typeof entry.command === 'string' && entry.command.includes('metamcp')) {
      entry.command = entry.command.replace(/metamcp/g, 'mentu-mcp');
    }
    if (typeof entry.command === 'object' && entry.command !== null) {
      const cmd = entry.command as Record<string, unknown>;
      if (typeof cmd.path === 'string' && cmd.path.includes('metamcp')) {
        cmd.path = cmd.path.replace(/metamcp/g, 'mentu-mcp');
      }
    }
    if (Array.isArray(entry.args)) {
      entry.args = entry.args.map((a: unknown) =>
        typeof a === 'string' && a.includes('metamcp') ? a.replace(/metamcp/g, 'mentu-mcp') : a,
      );
    }

    delete servers['metamcp'];
    writeFileSync(target.path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    process.stderr.write(`  ~ Migrated ${target.client}: metamcp → mentu-mcp\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  ! Migration skipped for ${target.client}: ${message}\n`);
  }
}

// --- Legacy Symlinks ---

function createLegacySymlinks(): void {
  const symlinks = [
    { target: 'mentu-mcp', link: 'metamcp' },
    { target: 'mentu-mcp-init', link: 'metamcp-init' },
  ];

  for (const { target, link } of symlinks) {
    try {
      const targetPath = execSync(`which ${target}`, { encoding: 'utf-8', timeout: 5_000 }).trim();
      if (!targetPath) continue;
      const linkPath = join(dirname(targetPath), link);
      try { unlinkSync(linkPath); } catch { /* may not exist */ }
      symlinkSync(targetPath, linkPath);
      process.stderr.write(`  ~ Legacy symlink: ${link} → ${target}\n`);
    } catch {
      // non-fatal
    }
  }
}

// --- Config Writers ---

function buildServerEntry(binaryPath: string): Record<string, unknown> {
  return { command: 'node', args: [binaryPath] };
}

function buildZedEntry(binaryPath: string): Record<string, unknown> {
  return { command: { path: 'node', args: [binaryPath] }, settings: {} };
}

function backupFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  copyFileSync(filePath, filePath + '.bak');
}

function writeJsonConfig(target: ConfigTarget, entry: Record<string, unknown>): 'added' | 'created' {
  const { path: filePath, serverKey } = target;
  mkdirSync(dirname(filePath), { recursive: true });

  let existing: Record<string, unknown> | null = null;
  let status: 'added' | 'created' = 'created';

  if (existsSync(filePath)) {
    backupFile(filePath);
    try {
      existing = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      status = 'added';
    } catch {
      existing = null;
    }
  }

  const config = existing ?? {};
  const servers = (config[serverKey] as Record<string, unknown>) ?? {};
  servers['mentu-mcp'] = entry;
  config[serverKey] = servers;
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return status;
}

function writeZedConfig(target: ConfigTarget, binaryPath: string): 'added' | 'created' {
  const { path: filePath } = target;
  mkdirSync(dirname(filePath), { recursive: true });

  let existing: Record<string, unknown> | null = null;
  let status: 'added' | 'created' = 'created';

  if (existsSync(filePath)) {
    backupFile(filePath);
    try {
      existing = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      status = 'added';
    } catch {
      existing = null;
    }
  }

  const config = existing ?? {};
  const contextServers = (config['context_servers'] as Record<string, unknown>) ?? {};
  contextServers['mentu-mcp'] = buildZedEntry(binaryPath);
  config['context_servers'] = contextServers;
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return status;
}

function writeTomlConfig(target: ConfigTarget, binaryPath: string): 'added' | 'created' {
  const { path: filePath } = target;
  mkdirSync(dirname(filePath), { recursive: true });

  let status: 'added' | 'created' = 'created';
  let lines: string[] = [];

  if (existsSync(filePath)) {
    backupFile(filePath);
    status = 'added';
    const content = readFileSync(filePath, 'utf-8');

    let skip = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '[mcp_servers.mentu-mcp]' || trimmed === '[mcp_servers.metamcp]') {
        skip = true;
        continue;
      }
      if (skip && trimmed.startsWith('[')) skip = false;
      if (!skip) lines.push(line);
    }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  }

  lines.push('');
  lines.push('[mcp_servers.mentu-mcp]');
  lines.push(`command = "node"`);
  lines.push(`args = ["${binaryPath}"]`);
  lines.push('');
  writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return status;
}

// --- Main ---

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const result: InitResult = {
    success: false,
    binaryPath: '',
    configuredClients: [],
    failedClients: [],
    errors: [],
  };

  const binaryPath = discoverBinaryPath();
  if (!binaryPath) {
    result.errors.push('Could not discover Mentu MCP binary path');
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      process.stderr.write('Error: Could not discover Mentu MCP binary path\n');
    }
    return result;
  }
  result.binaryPath = binaryPath;

  if (!opts.json) process.stderr.write(`Binary: ${binaryPath}\n`);

  const targets = getConfigTargets();
  for (const target of targets) migrateClientConfig(target);

  const entry = buildServerEntry(binaryPath);
  const seen = new Set<string>();

  for (const target of targets) {
    if (seen.has(target.client)) continue;

    try {
      let status: 'added' | 'created';

      switch (target.format) {
        case 'toml': {
          if (!existsSync(target.path) && !existsSync(dirname(target.path))) continue;
          status = writeTomlConfig(target, binaryPath);
          break;
        }
        case 'zed': {
          if (!existsSync(target.path)) continue;
          status = writeZedConfig(target, binaryPath);
          break;
        }
        default: {
          status = writeJsonConfig(target, entry);
          break;
        }
      }

      seen.add(target.client);
      result.configuredClients.push({ client: target.client, path: target.path, status });

      if (!opts.json) {
        process.stderr.write(`  + ${target.client}: ${target.path} (${status === 'added' ? 'updated' : 'created'})\n`);
      }
    } catch (err) {
      seen.add(target.client);
      const message = err instanceof Error ? err.message : String(err);
      result.failedClients.push({ client: target.client, path: target.path, error: message });
      if (!opts.json) process.stderr.write(`  x ${target.client}: ${message}\n`);
    }
  }

  createLegacySymlinks();
  result.success = result.configuredClients.length > 0;

  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stderr.write(`\nDone: ${result.configuredClients.length} configured, ${result.failedClients.length} failed\n`);
  }

  return result;
}

// --- CLI entrypoint ---
const isDirectRun = process.argv[1]?.endsWith('/init.js') || process.argv[1]?.endsWith('/init.ts');
if (isDirectRun) {
  await runInit({
    yes: process.argv.includes('--yes'),
    json: process.argv.includes('--json'),
  });
  process.exit(0);
}
