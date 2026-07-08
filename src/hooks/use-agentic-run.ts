"use client";

// ───────────────────────────────────────────────────────────────────────────
// use-agentic-run.ts — client hook that drives one REAL streaming agentic run.
//
// POSTs the question to a configurable NDJSON route (default "/api/agentic-run"),
// LIVE-consumes each line-delimited JSON event, and incrementally builds an
// `AgenticRun` whose `steps` grow as the server emits — so the UI renders the
// real executing reasoning + action trace (not a seeded replay).
//
// De-brand(红线):无品牌词字面量。诚实红线:一切来自 stream,无捏造数据。
// 双语:中文叙述 + 英文业务/工具术语(model / connector / skill 保持英文)。
//
// Client hook —— 无 "use client" 指令(lib hook 由 client 组件 import 即可)。
// Endpoint is a parameter → the same hook works in any project / any route path.
// ───────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";

import type { AgenticRun, ChainStep, MemoryInfo, RunError, RunMetrics } from "../types/chain-data";

// ── Wire protocol(路由每行 emit 一个 JSON 对象)─────────────────────────────
// ⚠ Keep this shape in SYNC with the DUPLICATE WireEvent in
// `agentic-orchestrator.ts`. UI-suite (§2.3) additions are all OPTIONAL — events
// emitted without them keep the corresponding run modules undefined.
type WireEvent =
  | {
      t: "meta";
      query: string;
      skills: string[];
      connectors: string[];
      model: string;
      llm: boolean;
      planner?: { goal?: string; totalSteps?: number }; // §2.3 PlannerState (optional)
    }
  | { t: "step"; step: ChainStep }
  | { t: "hitl"; step: ChainStep } // gate reached; stream ends; await approval
  | { t: "error"; message: string; error?: RunError } // §2.3 ErrorState (optional structured)
  | { t: "done"; usage: string; steps: number; metrics?: RunMetrics; memory?: MemoryInfo };

// ── Public state shape(pinned)────────────────────────────────────────────────

export interface AgenticRunState {
  run: AgenticRun | null; // live-built: {query, skills, connectors, stepsDoneLabel, steps}
  running: boolean;
  awaitingApproval: boolean; // true after an hitl gate; UI shows Approve/Reject
  llm: boolean; // whether the server used a real LLM
  usage: string | null;
  error: string | null;
}

const DEFAULT_ENDPOINT = "/api/agentic-run";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** action-ish 步骤计数(排除纯 reasoning 旁白)—— 与轨迹「已完成 N 步骤」口径一致。 */
function countActionSteps(steps: ChainStep[]): number {
  return steps.reduce((n, s) => (s.kind === "reasoning" ? n : n + 1), 0);
}

function stepsDoneLabel(steps: ChainStep[]): string {
  return `已完成 ${countActionSteps(steps)} 步骤`;
}

/** narrow unknown → WireEvent on the `.t` discriminant(no `any`)。 */
function isWireEvent(v: unknown): v is WireEvent {
  if (typeof v !== "object" || v === null || !("t" in v)) return false;
  const t = (v as { t: unknown }).t;
  return t === "meta" || t === "step" || t === "hitl" || t === "error" || t === "done";
}

function parseLine(line: string): WireEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  return isWireEvent(raw) ? raw : null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAgenticRun(apiPath: string = DEFAULT_ENDPOINT): AgenticRunState & {
  start: (question: string, model?: string) => Promise<void>;
  approve: () => Promise<void>; // re-runs with approved:true, continuing past the gate
  reset: () => void;
} {
  const [run, setRun] = useState<AgenticRun | null>(null);
  const [running, setRunning] = useState(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [llm, setLlm] = useState(false);
  const [usage, setUsage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Kept for approve() re-run + abort of any in-flight stream.
  const lastQuestion = useRef<string>("");
  const lastModel = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const endpointRef = useRef<string>(apiPath);
  endpointRef.current = apiPath;

  const abortInFlight = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const applyEvent = useCallback((ev: WireEvent) => {
    switch (ev.t) {
      case "meta": {
        setLlm(ev.llm);
        // Initialize (or replace, on approved re-run) the live run object.
        setRun({
          query: ev.query,
          skills: ev.skills,
          connectors: ev.connectors,
          stepsDoneLabel: stepsDoneLabel([]),
          steps: [],
          planner: ev.planner, // §2.3 PlannerState (undefined if the server omitted it)
        });
        break;
      }
      case "step": {
        setRun((prev) => {
          if (!prev) return prev;
          const steps = [...prev.steps, ev.step]; // new array each time → React re-renders
          return { ...prev, steps, stepsDoneLabel: stepsDoneLabel(steps) };
        });
        break;
      }
      case "hitl": {
        setRun((prev) => {
          if (!prev) return prev;
          const steps = [...prev.steps, ev.step]; // append the gate step
          return { ...prev, steps, stepsDoneLabel: stepsDoneLabel(steps) };
        });
        setAwaitingApproval(true);
        setRunning(false);
        break;
      }
      case "error": {
        setError(ev.message);
        // Attach the structured RunError (§2.3 ErrorState) to the live run too —
        // the `error` string is kept for backward compatibility.
        const structured = ev.error;
        if (structured) {
          setRun((prev) => (prev ? { ...prev, error: structured } : prev));
        }
        setRunning(false);
        break;
      }
      case "done": {
        setUsage(ev.usage);
        // Attach optional MetricsState / MemoryState modules to the live run.
        const metrics = ev.metrics;
        const memory = ev.memory;
        if (metrics || memory) {
          setRun((prev) =>
            prev
              ? {
                  ...prev,
                  ...(metrics ? { metrics } : {}),
                  ...(memory ? { memory } : {}),
                }
              : prev,
          );
        }
        setRunning(false);
        setAwaitingApproval(false);
        break;
      }
    }
  }, []);

  const consume = useCallback(
    async (body: Record<string, unknown>) => {
      abortInFlight();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(endpointRef.current, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          setRunning(false);
          return;
        }
        if (!res.body) {
          setError("响应缺少可读流 (missing response body)");
          setRunning(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Split on newlines; keep the trailing partial line buffered.
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line) continue;
            const ev = parseLine(line);
            if (ev) applyEvent(ev);
          }
        }

        // Flush any trailing line the stream ended on without a newline.
        buffer += decoder.decode();
        const tail = buffer.trim();
        if (tail) {
          const ev = parseLine(tail);
          if (ev) applyEvent(ev);
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return; // superseded / unmounted
        setError(e instanceof Error ? e.message : "streaming failed");
        setRunning(false);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [abortInFlight, applyEvent],
  );

  const start = useCallback(
    async (question: string, model?: string) => {
      lastQuestion.current = question;
      lastModel.current = model;
      // Reset state, then open the live stream.
      setRun(null);
      setUsage(null);
      setError(null);
      setAwaitingApproval(false);
      setLlm(false);
      setRunning(true);
      await consume({ question, model });
    },
    [consume],
  );

  const approve = useCallback(async () => {
    if (!awaitingApproval) return;
    setRunning(true);
    setAwaitingApproval(false);
    setError(null);
    setUsage(null);
    // Re-run the same question with approved:true; the fresh `meta` event
    // replaces run.steps, and the re-emitted run passes the gate.
    await consume({ question: lastQuestion.current, model: lastModel.current, approved: true });
  }, [awaitingApproval, consume]);

  const reset = useCallback(() => {
    abortInFlight();
    setRun(null);
    setRunning(false);
    setAwaitingApproval(false);
    setLlm(false);
    setUsage(null);
    setError(null);
  }, [abortInFlight]);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortInFlight(), [abortInFlight]);

  return { run, running, awaitingApproval, llm, usage, error, start, approve, reset };
}
