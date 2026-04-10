/**
 * Intelligence Client — fortress equivalent of ANE's CloudCompileClient.
 *
 * Wraps api.mentu.ai intelligence endpoints so the ship version can offer
 * perception, judgment, cortex, and CIR features without local IP.
 */

export interface ToolArtifact {
  name: string;
  description: string;
  server: string;
}

export interface PerceptionResult {
  label: string;
  score: number;
  adapter: string;
  latency_ms: number;
}

export interface RankedTool {
  name: string;
  server: string;
  domain: PerceptionResult;
  relevance: PerceptionResult;
  pattern?: PerceptionResult;
  combinedScore: number;
}

export interface ServerInfo {
  server: string;
  toolCount?: number;
  trusted?: boolean;
  circuitOpen?: boolean;
  successRate?: number;
  perceptionScore?: number;
  perceptionLabel?: string;
}

export interface EvidenceState {
  overall_confidence: number;
  blocking_gaps: number;
  findings_count: number;
  servers_used: string[];
  methods_used: string[];
  call_count: number;
  success_count: number;
  failure_count: number;
}

export interface ServerScore {
  server: string;
  score: number;
  features: Record<string, number>;
}

export interface Diagnosis {
  server: string;
  cause: string;
  detail: string;
  autoFixable: boolean;
  fixAction?: string;
}

export class IntelligenceClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://api.mentu.ai') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  // ─── Perception ─────────────────────────────────────────────────────────

  async filterAndRank(
    tools: ToolArtifact[],
    query: string,
    topK = 15,
  ): Promise<{ ranked: RankedTool[]; domain_distribution: Record<string, number> }> {
    return this.post('/v1/intelligence/perception', { tools, query, topK });
  }

  // ─── Judgment ───────────────────────────────────────────────────────────

  async evaluate(
    servers: ServerInfo[],
    evidenceState: EvidenceState,
    budget?: { max_calls?: number; exploration_reserve?: number },
    recentYields?: boolean[],
  ): Promise<{
    prioritized: ServerScore[];
    allocations: Record<string, number>;
    should_stop: boolean;
    stop_reason?: string;
    exploration_picks: string[];
  }> {
    return this.post('/v1/intelligence/judgment', {
      servers,
      evidence_state: evidenceState,
      budget,
      recent_yields: recentYields,
    });
  }

  // ─── Cortex Advisory ────────────────────────────────────────────────────

  async diagnose(
    server: string,
    state: string,
    errorMessage?: string,
    exitCode?: number,
    command?: string,
  ): Promise<{ action: string; diagnosis: Diagnosis }> {
    return this.post('/v1/intelligence/cortex', {
      action: 'diagnose',
      diagnose: { server, state, errorMessage, exitCode, command },
    });
  }

  async tuneWeights(
    sessionHistory: Array<{ server: string; success: boolean; latency_ms?: number; relevance_score?: number }>,
  ): Promise<{ action: string; weights: Record<string, number> }> {
    return this.post('/v1/intelligence/cortex', {
      action: 'tune_weights',
      tune_weights: { sessionHistory },
    });
  }

  // ─── CIR Query ──────────────────────────────────────────────────────────

  async queryCIR(opts: {
    domain?: string;
    kind?: string;
    query?: string;
    limit?: number;
  }): Promise<{ signals: unknown[]; count: number }> {
    return this.post('/cir/query', opts);
  }

  // ─── Existing Endpoints ─────────────────────────────────────────────────

  async computeTrust(evidence: {
    exitCode: number;
    duration: number;
    loopComplete: boolean;
    contextUtilization?: number;
  }): Promise<{ confidence: number; verification: string; chain: string[] }> {
    return this.post('/v1/intelligence/trust', evidence);
  }

  async classify(
    text: string,
  ): Promise<{ labels: Array<{ label: string; score: number }> }> {
    return this.post('/v1/intelligence/classify', { text });
  }

  async embed(
    text: string,
    dimensions?: number,
  ): Promise<{ vector: number[]; dimensions: number; model: string }> {
    return this.post('/v1/intelligence/embed', { text, dimensions });
  }

  // ─── HTTP Client ────────────────────────────────────────────────────────

  private async post<T>(path: string, body: unknown): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Intelligence API ${path} returned ${resp.status}: ${text}`);
    }

    return resp.json() as Promise<T>;
  }
}
