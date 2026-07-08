// ───────────────────────────────────────────────────────────────────────────
// agentic-adapter.ts — the ONLY project-specific plug-in point of the Agentic
// Run-Trace ChatBot engine (brand-agnostic template + reference factory).
//
// The generic orchestrator (`agentic-orchestrator.ts`) knows NOTHING about a
// project's intents / data stores / connectors / charts. It drives the 5-coord
// state machine and asks an `AgenticAdapter` for:
//   • matchTools(question)     — which tools/intents fire (the fan-out)
//   • tool.run()               — Token=0 data fetch → summary / rows / chart
//   • synthesize?(...)         — optional custom answer composition
//   • detectConnector?(...)    — optional external-connector authorization gate
//   • llm?                     — optional AI-Gateway LLM (master + answer only)
//
// A project ships ~1 file implementing `AgenticAdapter`. The reference factory
// `createLocalSnapshotAdapter` turns the common「keyword-matched intents over
// local snapshot rows」pattern (the reference INTENTS shape, generalized) into a
// full adapter with zero boilerplate — Token=0, no LLM required. (This is how a
// project's keyword-matched-intents pattern generalizes into the engine.)
//
// Red lines: Token=0 at the engine (LLM only via `adapter.llm`, which the PROJECT
// implements against an AI Gateway using an env key — never here). Zero brand
// values in this template; all project data flows through the adapter instance.
// ───────────────────────────────────────────────────────────────────────────

import type { ChainSource, ChartData, ConnectorAuth, MemoryInfo } from "../types/chain-data";

// ── ToolMatch — one fired tool/intent the harness will execute ────────────────
// `run()` is the Token=0 (or project-defined) data fetch: it returns a human
// summary + optional structured rows + optional chart + source badges. A tool
// that is itself an EXTERNAL connector marks `source:"external"` + `authRequired`
// and carries the `connector` payload for the authorization gate.
export interface ToolMatch {
  id: string;
  label: string;
  source: "local" | "external";
  authRequired?: boolean;
  connector?: ConnectorAuth;
  run(): Promise<{
    summary: string;
    rows?: Record<string, unknown>[];
    chart?: ChartData;
    sources?: ChainSource[];
  }>;
}

// ── LLM contract — implemented by the PROJECT against its AI Gateway ──────────
// The engine calls this ONLY to decorate the Master narrative + synthesize the
// answer, and ONLY when `configured()` is true (an env key is present). §0: the
// gateway key is read inside the project's impl from env, never in this skill.
export interface AdapterLLM {
  configured(): boolean;
  chat(args: {
    model?: string;
    system: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{
    text: string;
    // OPTIONAL token usage — when the gateway returns it the engine accumulates
    // prompt/completion into RunMetrics; absent → the sidebar honestly shows 0
    // (Token=0 path never reports usage). Backward-compatible: existing impls
    // that return only { text } still satisfy this (usage is optional).
    usage?: { promptTokens?: number; completionTokens?: number };
  }>;
  fallbackModel: string;
}

// ── AgenticAdapter — the project plug-in contract ─────────────────────────────
export interface AgenticAdapter {
  /** Intent/tool matching (project implements). Returns the tools to actually run. */
  matchTools(question: string): ToolMatch[];
  /** Optional custom answer composition from the collected tool results. */
  synthesize?(
    question: string,
    results: {
      id: string;
      label: string;
      summary: string;
      rows?: Record<string, unknown>[];
      chart?: ChartData;
    }[],
  ): { title: string; markdown: string; chart?: ChartData };
  /** Optional external-connector authorization trigger (Gmail-style demo gate). */
  detectConnector?(question: string): ConnectorAuth | null;
  /**
   * Optional memory/context model (ChatBot UI.md §2.3 MemoryState). The engine
   * calls this near the END of a run with the question + collected tool results;
   * the project returns a rolling context summary / long-term KB refs / facts
   * written back this run. Token=0 by default (a project may read a snapshot / KV
   * store). Absent → run.memory stays undefined and the sidebar shows an honest
   * empty state ("no memory written this session").
   */
  memory?(
    question: string,
    results: {
      id: string;
      label: string;
      summary: string;
      rows?: Record<string, unknown>[];
      chart?: ChartData;
    }[],
  ): MemoryInfo | Promise<MemoryInfo>;
  /** Optional AI-Gateway LLM. When absent/unconfigured the engine stays Token=0. */
  llm?: AdapterLLM;
}

// ═══════════════════════════════════════════════════════════════════════════
// Reference factory — createLocalSnapshotAdapter
// Generalizes the common「INTENTS + snapshot loader + intent.chart」pattern into
// an AgenticAdapter. Token=0: every summary/chart is computed from real rows.
// ═══════════════════════════════════════════════════════════════════════════

// Intent-style chart spec (matches the common project shape) → converted to the
// engine's `ChartData` inside the generated tool.run().
export type ChartSpec =
  | { type: "none" }
  | { type: "bar"; dataKey: string; nameKey: string; rows: Record<string, unknown>[] }
  | { type: "line"; dataKey: string; xKey: string; rows: Record<string, unknown>[] }
  | { type: "pie"; dataKey: string; nameKey: string; rows: Record<string, unknown>[] };

// One local tool = one intent over a snapshot dataKey (the common Intent shape).
export interface LocalTool {
  id: string;
  label: string; // the chip / display name (rendered → keep brand-free)
  keywords: string[];
  dataKey: string; // snapshot key passed to loadRows()
  summarize: (rows: Record<string, unknown>[]) => string;
  chart?: (rows: Record<string, unknown>[]) => ChartSpec;
}

// Optional external-connector definition (a CONNECTOR_MAP pattern, generalized).
export interface ConnectorDef {
  id: string;
  label: string;
  icon: string;
  scopes: string[];
  keywords: string[];
}

export interface LocalSnapshotAdapterOptions {
  /** Load the rows for a dataKey (read a snapshot JSON / query a store). Token=0. */
  loadRows: (dataKey: string) => Record<string, unknown>[];
  tools: LocalTool[];
  /** Optional external connectors → drives detectConnector(). */
  connectors?: ConnectorDef[];
  /** Optional AI-Gateway LLM pass-through (engine uses it for master + answer). */
  llm?: AdapterLLM;
  /** Optional memory/context model passthrough (§2.3 MemoryState · project-owned). */
  memory?: AgenticAdapter["memory"];
  /** When no tool matches, run the top-N nearest tools instead of nothing. */
  fallbackToNearest?: boolean; // default true
  nearestN?: number; // default 3
  /** Honesty note attached to a detected connector's authorization gate. */
  connectorAuthNote?: string;
}

// ── Internal matchers (mirror the reference orchestrator, Token=0, pure) ──────
function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9一-龥]+/)
      .filter((w) => w.length > 1),
  );
}

function chartSpecToData(spec: ChartSpec, label: string): ChartData | undefined {
  if (spec.type === "none") return undefined;
  return {
    rows: spec.rows.slice(0, 12),
    dataKey: spec.dataKey,
    nameKey: "nameKey" in spec ? spec.nameKey : undefined,
    xKey: "xKey" in spec ? spec.xKey : undefined,
    preferred: spec.type,
    label,
  };
}

/**
 * Build an AgenticAdapter from local tools + a row loader.
 * matchTools: exact-label hit → single tool; else longest-keyword collect (all
 * matches, sorted); else (optional) top-N nearest by token overlap.
 */
export function createLocalSnapshotAdapter(
  opts: LocalSnapshotAdapterOptions,
): AgenticAdapter {
  const {
    loadRows,
    tools,
    connectors = [],
    llm,
    memory,
    fallbackToNearest = true,
    nearestN = 3,
    connectorAuthNote = "演示授权 · 不建立真实连接 (demo gate · no real connection)",
  } = opts;

  const toToolMatch = (t: LocalTool): ToolMatch => ({
    id: t.id,
    label: t.label,
    source: "local",
    async run() {
      const rows = loadRows(t.dataKey);
      const summary = t.summarize(rows);
      const chart = t.chart ? chartSpecToData(t.chart(rows), t.label) : undefined;
      const snippet = summary.replace(/\s+/g, " ").trim().slice(0, 120);
      return {
        summary,
        rows,
        chart,
        sources: [{ title: snippet || "Token=0 检索", source: t.dataKey, premium: false }],
      };
    },
  });

  const matchTools = (question: string): ToolMatch[] => {
    const q = question.toLowerCase().trim();
    // 1) exact label/chip match wins outright.
    for (const t of tools) {
      if (t.label.toLowerCase().trim() === q) return [toToolMatch(t)];
    }
    // 2) longest-keyword collect (every tool with any hit, best-first).
    const matched: { t: LocalTool; len: number }[] = [];
    for (const t of tools) {
      let bestLen = 0;
      for (const kw of t.keywords) {
        const k = kw.toLowerCase();
        if (q.includes(k) && k.length > bestLen) bestLen = k.length;
      }
      if (bestLen > 0) matched.push({ t, len: bestLen });
    }
    if (matched.length) {
      matched.sort((a, b) => b.len - a.len);
      return matched.map((m) => toToolMatch(m.t));
    }
    // 3) optional nearest-neighbour fallback (token overlap).
    if (!fallbackToNearest) return [];
    const qWords = tokenize(question);
    const scored = tools.map((t) => {
      const bag = tokenize([t.label, ...t.keywords].join(" "));
      let score = 0;
      for (const w of qWords) if (bag.has(w)) score += 1;
      return { t, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, nearestN)
      .map((s) => toToolMatch(s.t));
  };

  const detectConnector = (question: string): ConnectorAuth | null => {
    if (!connectors.length) return null;
    const q = question.toLowerCase();
    let best: { c: ConnectorDef; len: number } | null = null;
    for (const c of connectors) {
      for (const kw of c.keywords) {
        const k = kw.toLowerCase();
        if (q.includes(k) && (best === null || k.length > best.len)) {
          best = { c, len: k.length };
        }
      }
    }
    if (!best) return null;
    return {
      connectorId: best.c.id,
      connectorLabel: best.c.label,
      icon: best.c.icon,
      scopes: best.c.scopes,
      note: connectorAuthNote,
    };
  };

  return {
    matchTools,
    detectConnector: connectors.length ? detectConnector : undefined,
    memory,
    llm,
  };
}
