"use client";

// ───────────────────────────────────────────────────────────────────────────
// agentic-run-trace.tsx — Perplexity 风「思维链 · 行动链」运行轨迹的 2 栏外壳
// (brand-agnostic template · LIVE-only).
//
// A real streaming run driven by the user's question (from ./use-agentic-run).
// Steps STREAM in from the engine (Token=0 → they arrive ~instantly), so this
// shell adds a CLIENT reveal cadence: `revealedCount` advances toward
// run.steps.length by +1 every ~700ms — the last revealed step is the "active"
// (executing) one, the rest settle.
//
// LEFT  = <ReasoningActionChain> 步骤流(scroll 容器)。
// RIGHT = 右侧状态栏 · a SUPERSET of ChatBot UI.md §2.3 AgenticSidebar 的 5 模块:
//         ① PlannerState(规划:Goal + 已执行 X/计划 N 步 + Replan 标记)
//         ② ToolsState(技能·工具·连接器 + 状态/耗时 + 成功率 + 错误日志可折叠)
//         ③ MemoryState(上下文摘要 + 长期记忆 KB + Memory 更新记录)
//         ④ ErrorState(结构化:类型 / 恢复策略 / 是否需人介入)
//         ⑤ MetricsState(总耗时 + Token 用量 + 工具调用/Planner 步数/Trace 节点)
//         并保留增强面板(数据来源 / 协调机制 / 进度 / 工件)。
//         每个面板均可折叠(G13);整条状态栏可隐藏(G14 · 隐藏后左栏满宽);
//         `config?: AgenticUIConfig` 驱动 showMemory/showMetrics/sidebar(G12)。
//
// Live cadence engine: `revealedCount` advances toward run.steps.length +1 每
// ~700ms(setTimeout-in-effect · deterministic · Token=0 · 无 Date.now /
// Math.random)。run 复位为 null → revealedCount 归 0;approved re-run 令 steps
// 变短 → clamp 回落。prefers-reduced-motion → revealedCount 直接跳到全展开。
//
// Chart / markdown are PLUGGABLE — pass `chartRenderer` / `markdownRenderer`
// (threaded to <ReasoningActionChain>); text fallbacks render when absent.
// De-brand: no brand word; third-party connector product names are OK.
// Backward-compatible: `config` / `onHideSidebar` are OPTIONAL — existing
// callers that don't pass them still work (everything defaults ON).
// Import paths (`./…`) resolve against the sibling templates once scaffolded.
// ───────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Icon } from "@iconify/react";
import {
  type AgenticRun,
  type AgenticUIConfig,
  type ChainStep,
  type ChartData,
  type DataMode,
  type RunError,
  type StepKind,
  COORD_LEGEND,
} from "../types/chain-data";
import { CoordBadge, ReasoningActionChain } from "./reasoning-action-chain";

// ── Minimal className joiner (self-contained · no host dep) ───────────────────
type ClassValue = string | false | null | undefined;
function cn(...parts: ClassValue[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

const LIVE_STEP_MS = 700; // live reveal cadence

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ── Step-kind sets (module-static · Token=0) ─────────────────────────────────
// "action steps" = everything the planner executed EXCEPT pure narration /
// checklist meta (used for the「已执行 X 步」count when the engine omits it).
const NON_ACTION_KINDS = new Set<StepKind>(["reasoning", "progress"]);
// tool-call kinds = steps that invoke a tool / connector (derived toolCalls).
const TOOL_CALL_KINDS = new Set<StepKind>([
  "action",
  "results",
  "read",
  "wait",
  "chart",
  "connector-auth",
]);

// ── Task-nature derivations (pure · Token=0) ─────────────────────────────────

/** Split a connector field like "PitchBook / Statista" into individual labels. */
function splitConnectors(s: string): string[] {
  return s
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Run-level data mode, derived from the streamed steps' `dataSource`.
 *  external + local → mixed · all external → external · else → local. */
function deriveDataMode(steps: ChainStep[]): DataMode {
  let hasExternal = false;
  let hasLocal = false;
  for (const s of steps) {
    if (s.dataSource === "external") hasExternal = true;
    else if (s.dataSource === "local") hasLocal = true;
  }
  if (hasExternal && hasLocal) return "mixed";
  if (hasExternal) return "external";
  return "local";
}

/** Executed action-step count (skips pure reasoning + progress meta). */
function countActionSteps(steps: ChainStep[]): number {
  let n = 0;
  for (const s of steps) if (!NON_ACTION_KINDS.has(s.kind)) n++;
  return n;
}

/** Derived tool-call count — a step that invokes a tool / connector. */
function countToolCalls(steps: ChainStep[]): number {
  let n = 0;
  for (const s of steps) if (TOOL_CALL_KINDS.has(s.kind) || s.connector || s.skill) n++;
  return n;
}

/** A fan-out step's child count — a good「planned total」proxy when the engine
 *  doesn't supply run.planner.totalSteps. */
function fanoutChildrenLen(steps: ChainStep[]): number | null {
  for (const s of steps) {
    if (s.kind === "fanout" && s.children?.length) return s.children.length;
  }
  return null;
}

type StepOutcome = "success" | "failed" | "retry";

/** A step's outcome — explicit `status`, else derived from its children
 *  (any failed → failed · all done → success), else undefined (unknown). */
function deriveStepOutcome(s: ChainStep): StepOutcome | undefined {
  if (s.status) return s.status;
  if (s.children?.length) {
    if (s.children.some((c) => c.status === "failed")) return "failed";
    if (s.children.every((c) => c.status === "done")) return "success";
  }
  return undefined;
}

interface ToolStats {
  success: number;
  failed: number;
  retry: number;
  attempted: number; // success + failed (rate denominator)
  successRate: number | null; // % · null when nothing has a known outcome
  errorLog: { label: string; note?: string }[];
}

/** ToolsState success-rate + error log, derived from step / child outcomes. */
function deriveToolStats(steps: ChainStep[]): ToolStats {
  let success = 0;
  let failed = 0;
  let retry = 0;
  const errorLog: { label: string; note?: string }[] = [];
  for (const s of steps) {
    const outcome = deriveStepOutcome(s);
    if (outcome === "success") success++;
    else if (outcome === "retry") retry++;
    else if (outcome === "failed") {
      failed++;
      const childFails = s.children?.filter((c) => c.status === "failed") ?? [];
      if (childFails.length) {
        for (const c of childFails) errorLog.push({ label: c.label, note: s.title });
      } else {
        errorLog.push({ label: s.title ?? s.id, note: s.note });
      }
    }
  }
  const attempted = success + failed;
  const successRate = attempted > 0 ? Math.round((success / attempted) * 100) : null;
  return { success, failed, retry, attempted, successRate, errorLog };
}

/** Structured ErrorState — prefer the engine's RunError, else derive a minimal
 *  one from the first failed step; null when the run had no failure. */
function deriveError(steps: ChainStep[]): RunError | null {
  for (const s of steps) {
    if (deriveStepOutcome(s) === "failed") {
      return {
        type: "tool",
        message: s.note ?? s.title ?? "工具步骤执行失败 · A tool step failed",
        recovery: "retry",
        needsUser: false,
      };
    }
  }
  return null;
}

type InvStatus = "local" | "pending" | "authorized";
interface InvItem {
  kind: "skill" | "connector";
  label: string;
  status: InvStatus;
  durationMs?: number; // latest per-tool timing (ToolsState)
  outcome?: StepOutcome; // latest per-tool outcome (ToolsState)
}

/** Deduped Skills / Tools / Connectors inventory, derived from the run's steps.
 *  Skills load locally (Token=0). A connector named by a connector-auth gate —
 *  or on a step marked dataSource==="external" — is EXTERNAL: `pending` while its
 *  gate is still open, else `authorized`. Everything else is a local snapshot.
 *  Each item also carries the latest matching step's `durationMs` / `outcome`. */
function deriveInventory(steps: ChainStep[], awaitingApproval: boolean): InvItem[] {
  const last = steps.length > 0 ? steps[steps.length - 1] : null;
  const authGateOpen = awaitingApproval && last?.kind === "connector-auth";
  const pendingLabel =
    authGateOpen && last?.connectorAuth ? last.connectorAuth.connectorLabel : null;

  // Which connector labels are EXTERNAL (auth-gated, or on an external step).
  const externalLabels = new Set<string>();
  for (const s of steps) {
    if (s.kind === "connector-auth" && s.connectorAuth) {
      externalLabels.add(s.connectorAuth.connectorLabel);
    }
    if (s.connector && s.dataSource === "external") {
      for (const l of splitConnectors(s.connector)) externalLabels.add(l);
    }
  }
  const connectorStatus = (label: string): InvStatus =>
    label === pendingLabel ? "pending" : "authorized";

  const items: InvItem[] = [];
  const seen = new Map<string, InvItem>();
  const add = (
    kind: InvItem["kind"],
    label: string,
    status: InvStatus,
    meta?: { durationMs?: number; outcome?: StepOutcome },
  ) => {
    const key = `${kind}:${label}`;
    const existing = seen.get(key);
    if (existing) {
      // last-wins enrichment for per-tool timing / outcome.
      if (meta?.durationMs != null) existing.durationMs = meta.durationMs;
      if (meta?.outcome) existing.outcome = meta.outcome;
      return;
    }
    const item: InvItem = { kind, label, status, durationMs: meta?.durationMs, outcome: meta?.outcome };
    seen.set(key, item);
    items.push(item);
  };

  // Skills — always loaded locally (Token=0 snapshot), no auth.
  for (const s of steps) {
    if (s.skill) add("skill", s.skill, "local", { durationMs: s.durationMs, outcome: deriveStepOutcome(s) });
  }
  // Connectors named by an auth gate — external.
  for (const s of steps) {
    if (s.kind === "connector-auth" && s.connectorAuth) {
      const l = s.connectorAuth.connectorLabel;
      add("connector", l, connectorStatus(l), {
        durationMs: s.durationMs,
        outcome: deriveStepOutcome(s),
      });
    }
  }
  // Connectors referenced by regular steps.
  for (const s of steps) {
    if (!s.connector) continue;
    for (const l of splitConnectors(s.connector)) {
      add("connector", l, externalLabels.has(l) ? connectorStatus(l) : "local", {
        durationMs: s.durationMs,
        outcome: deriveStepOutcome(s),
      });
    }
  }
  return items;
}

/** A short label for the currently-executing step (title → text → fallback). */
function nowRunningLabel(step: ChainStep | null): string {
  if (!step) return "准备中… · Preparing";
  if (step.title) return step.title;
  if (step.text) return step.text;
  return "执行中… · Executing";
}

// ── Style maps (LITERAL Tailwind class strings — JIT must see them) ──────────

const DATA_MODE_STYLE: Record<DataMode, { chip: string; icon: string; label: string; note: string }> =
  {
    local: {
      chip: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300",
      icon: "lucide:hard-drive",
      label: "本地数据 · Local · Token=0",
      note: "全部来自本地快照读取,无外部呼叫、无需授权。",
    },
    external: {
      chip: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300",
      icon: "lucide:plug-zap",
      label: "外部连接器 · External · 需授权",
      note: "需连接外部连接器,授权门通过后才访问(演示授权 · 不建立真实连接)。",
    },
    mixed: {
      chip: "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300",
      icon: "lucide:layers",
      label: "混合 · Mixed",
      note: "本地快照 + 外部连接器混合;外部部分需授权门通过后才访问。",
    },
  };

const INV_STATUS_STYLE: Record<InvStatus, { badge: string; icon: string; label: string }> = {
  local: {
    badge:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300",
    icon: "lucide:hard-drive",
    label: "本地 ✓",
  },
  pending: {
    badge:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300",
    icon: "lucide:shield-alert",
    label: "需授权 ⚠",
  },
  authorized: {
    badge:
      "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300",
    icon: "lucide:shield-check",
    label: "已授权 ✓",
  },
};

const INV_KIND_ICON: Record<InvItem["kind"], string> = {
  skill: "lucide:sparkles",
  connector: "lucide:plug",
};

const OUTCOME_STYLE: Record<StepOutcome, { cls: string; icon: string; label: string }> = {
  success: { cls: "text-emerald-600 dark:text-emerald-400", icon: "lucide:check", label: "success" },
  failed: { cls: "text-red-600 dark:text-red-400", icon: "lucide:x", label: "failed" },
  retry: { cls: "text-amber-600 dark:text-amber-400", icon: "lucide:rotate-ccw", label: "retry" },
};

const ERROR_TYPE_STYLE: Record<RunError["type"], { icon: string; label: string }> = {
  llm: { icon: "lucide:brain-circuit", label: "LLM 模型 · Model" },
  tool: { icon: "lucide:wrench", label: "工具 · Tool" },
  network: { icon: "lucide:wifi-off", label: "网络 · Network" },
  permission: { icon: "lucide:shield-x", label: "权限 · Permission" },
  unknown: { icon: "lucide:help-circle", label: "未知 · Unknown" },
};

const RECOVERY_LABEL: Record<NonNullable<RunError["recovery"]>, string> = {
  retry: "重试 · Retry",
  degrade: "降级 · Degrade",
  skip: "跳过 · Skip",
  abort: "中止 · Abort",
};

export function AgenticRunTrace({
  onClose,
  run,
  running,
  awaitingApproval,
  llm,
  usage,
  onApprove,
  onReset,
  chartRenderer,
  markdownRenderer,
  config,
  onHideSidebar,
}: {
  onClose?: () => void;
  run?: AgenticRun | null;
  running?: boolean;
  awaitingApproval?: boolean;
  llm?: boolean;
  usage?: string | null;
  onApprove?: () => void;
  onReset?: () => void;
  chartRenderer?: (chart: ChartData) => ReactNode;
  markdownRenderer?: (text: string) => ReactNode;
  // ── UI-suite alignment (all OPTIONAL · backward-compatible) ────────────────
  config?: AgenticUIConfig; // §5.2 host toggles — everything defaults ON when absent
  onHideSidebar?: () => void; // fired when the user collapses the status rail (G14)
}): ReactElement {
  // ── LIVE reveal cadence (self-contained · deterministic · Token=0) ─────────
  const [revealedCount, setRevealedCount] = useState(0);
  const [railOpen, setRailOpen] = useState(true); // status-rail visible (G14)

  // Config gates (default ON when config / individual flags absent · G12).
  const sidebarEnabled = config?.sidebar !== false;
  const showMemory = config?.showMemory !== false;
  const showMetrics = config?.showMetrics !== false;
  const showRail = sidebarEnabled && railOpen;

  // Mobile default-collapsed (client-only · avoids an SSR width guess · G14).
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) setRailOpen(false);
  }, []);

  // Reset the reveal cursor whenever the run is cleared (new run / reset).
  useEffect(() => {
    if (run == null) setRevealedCount(0);
  }, [run]);

  // Advance the cursor toward the streamed step count. `run` changes reference
  // on every appended step, so this re-fires as steps arrive.
  useEffect(() => {
    if (run == null) return;
    const total = run.steps.length;
    if (revealedCount > total) {
      // A fresh / approved re-run replaced steps with a shorter array — clamp.
      setRevealedCount(total);
      return;
    }
    if (revealedCount >= total) return; // caught up — nothing to reveal
    if (prefersReducedMotion()) {
      setRevealedCount(total); // no cadence — reveal everything at once
      return;
    }
    const id = window.setTimeout(
      () => setRevealedCount((c) => Math.min(c + 1, total)),
      LIVE_STEP_MS,
    );
    return () => window.clearTimeout(id);
  }, [run, revealedCount]);

  const toggleRail = () => {
    const next = !railOpen;
    setRailOpen(next);
    if (!next) onHideSidebar?.();
  };

  // ── Live derivations (guard the pre-`meta` null-run frame) ─────────────────
  const steps = run?.steps ?? [];
  const total = steps.length;
  const catchingUp = revealedCount < total;
  const activeIndex = running || catchingUp ? revealedCount - 1 : -1;
  const activeStep = activeIndex >= 0 && activeIndex < total ? steps[activeIndex] : null;
  const isNowRunning = !!running || catchingUp;

  const hasAnswer = steps.some((s) => s.kind === "answer");

  // 数据来源 + Skills/Tools/Connectors inventory — derived from the steps.
  const dataMode: DataMode = deriveDataMode(steps);
  const inventory = deriveInventory(steps, !!awaitingApproval);

  // Pending-gate disambiguation: the LAST step decides which gate UI to show.
  const pendingStep = awaitingApproval && total > 0 ? steps[total - 1] : null;
  const connectorAuthGate =
    pendingStep && pendingStep.kind === "connector-auth"
      ? (pendingStep.connectorAuth ?? null)
      : null;
  const showRiskHitl = !!pendingStep && !connectorAuthGate;

  // ── ① PlannerState — Goal + 已执行 X / 计划 N 步 + Replan(engine or derived) ──
  const plannerGoal = run?.planner?.goal ?? run?.query ?? "";
  const actionCount = countActionSteps(steps);
  const plannerStepIndex = run?.planner?.stepIndex ?? actionCount;
  const plannerTotal =
    run?.planner?.totalSteps ?? fanoutChildrenLen(steps) ?? Math.max(plannerStepIndex, actionCount);
  const replanned = !!run?.planner?.replanned;
  const plannerPct =
    plannerTotal > 0 ? Math.min(100, Math.round((plannerStepIndex / plannerTotal) * 100)) : 0;

  // ── ② ToolsState — success rate + error log (from step / child outcomes) ────
  const toolStats = deriveToolStats(steps);

  // ── ③ MemoryState — engine-provided (honest empty when absent) ──────────────
  const memory = run?.memory ?? null;
  const memoryCount = memory
    ? (memory.kbRefs?.length ?? 0) + (memory.updates?.length ?? 0)
    : undefined;

  // ── ④ ErrorState — engine RunError, else derived from a failed step ─────────
  const runError: RunError | null = run?.error ?? deriveError(steps);

  // ── ⑤ MetricsState — usage + tokens + counts (engine or derived) ────────────
  const promptTokens = run?.metrics?.promptTokens;
  const completionTokens = run?.metrics?.completionTokens;
  const hasTokens = (promptTokens ?? 0) > 0 || (completionTokens ?? 0) > 0;
  const tokenValue = hasTokens
    ? `${promptTokens ?? 0} / ${completionTokens ?? 0}`
    : llm
      ? "未上报 · n/a"
      : "Token=0 · 无 LLM";
  const metricToolCalls = run?.metrics?.toolCalls ?? countToolCalls(steps);
  const metricPlannerSteps = run?.metrics?.plannerSteps ?? plannerStepIndex;
  const metricTraceNodes = run?.metrics?.traceNodes ?? total;

  // 进度 · derive from progress-step checklists (+ a "N 步已执行" summary line).
  const liveProgress: { label: string; done: boolean }[] = [];
  liveProgress.push({ label: `已执行 ${total} 步`, done: !running });
  for (const s of steps) {
    if (s.kind === "progress" && s.children) {
      for (const c of s.children) {
        liveProgress.push({ label: c.label, done: c.status === "done" });
      }
    }
  }
  if (hasAnswer) {
    liveProgress.push({ label: "已输出最终答案 · Final answer", done: true });
  } else if (running) {
    liveProgress.push({ label: "生成中… · streaming", done: false });
  }

  // 工件 · derive from any artifact steps.
  const liveArtifacts = steps
    .filter((s) => s.kind === "artifact" && s.artifact)
    .map((s) => ({
      name: s.artifact!.name,
      sub: s.artifact!.sub,
      icon: s.icon ?? "lucide:file-text",
    }));

  // 用量 · usage string with a running / idle fallback.
  const liveUsage = usage ?? (running ? "运行中…" : "—");

  return (
    <div className="flex flex-col gap-4 text-foreground">
      {/* ── Header row ──────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex flex-col gap-1.5">
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-brand"
            >
              <span className="inline-flex">
                <Icon icon="lucide:arrow-left" width={13} height={13} />
              </span>
              返回 · Back
            </button>
          ) : null}
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-white">
              <Icon icon="lucide:brain-circuit" width={16} height={16} />
            </span>
            Agentic 思维链 · 行动链 · Run Trace
          </h2>
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Master-Agent 编排 · 多 Agent handoff 接力 · Harness/Loop 自动 · HITL 人审 ——
            以下为你本次提问的实时运行轨迹(live run · 由真实问题驱动 · 逐步揭示)。
          </p>
          {run ? (
            <div className="flex max-w-3xl items-start gap-1.5 rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 text-xs text-foreground dark:bg-neutral-800/40">
              <span className="mt-0.5 inline-flex shrink-0 text-brand">
                <Icon icon="lucide:message-square-quote" width={13} height={13} />
              </span>
              <span className="min-w-0 break-words">
                <span className="font-medium text-muted-foreground">问题 · Question:</span>{" "}
                {run.query}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Controls bar (live) ────────────────────────────────────────────
          status pill (running/done) + model badge + step-count + Hide rail + New run. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 shadow-sm">
        {running ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300">
            <span className="inline-flex animate-spin motion-reduce:animate-none">
              <Icon icon="lucide:loader-2" width={13} height={13} />
            </span>
            运行中 · streaming
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
            <span className="inline-flex text-emerald-500">
              <Icon icon="lucide:check-circle-2" width={13} height={13} />
            </span>
            完成 · done
          </span>
        )}

        {llm ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/5 px-2.5 py-1 text-[11px] font-medium text-brand dark:bg-brand/10">
            <span className="inline-flex">
              <Icon icon="lucide:sparkles" width={12} height={12} />
            </span>
            Claude · AI Gateway
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
            <span className="inline-flex">
              <Icon icon="lucide:cpu" width={12} height={12} />
            </span>
            Token=0 · 无 LLM
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{total}</span> 步已执行
          </span>
          {sidebarEnabled ? (
            <button
              type="button"
              onClick={toggleRail}
              aria-expanded={railOpen}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <span className="inline-flex">
                <Icon
                  icon={railOpen ? "lucide:panel-right-close" : "lucide:panel-right-open"}
                  width={13}
                  height={13}
                />
              </span>
              {railOpen ? "隐藏状态栏 · Hide" : "显示状态栏 · Show"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <span className="inline-flex">
              <Icon icon="lucide:rotate-ccw" width={13} height={13} />
            </span>
            新运行 · New run
          </button>
        </div>
      </div>

      {/* ── Connector authorization gate (pending step is connector-auth) ──── */}
      {awaitingApproval && connectorAuthGate ? (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="连接器授权 · Connector authorization"
          className="flex flex-col gap-3 rounded-xl border border-indigo-300 bg-indigo-50 px-4 py-3.5 shadow-sm dark:border-indigo-500/40 dark:bg-indigo-500/10"
        >
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-indigo-200 bg-white text-indigo-600 dark:border-indigo-500/40 dark:bg-neutral-900 dark:text-indigo-300">
              <Icon icon={connectorAuthGate.icon} width={18} height={18} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-indigo-900 dark:text-indigo-100">
                连接 {connectorAuthGate.connectorLabel} · Connect {connectorAuthGate.connectorLabel}
              </p>
              <p className="mt-0.5 text-xs text-indigo-700/80 dark:text-indigo-300/80">
                该步骤需访问外部连接器,请授权以继续 · Authorize this connector to continue.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-indigo-200 bg-white/70 px-3 py-2 dark:border-indigo-500/30 dark:bg-neutral-900/50">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-indigo-700/80 dark:text-indigo-300/80">
              将访问 · Requested access
            </p>
            <ul className="flex flex-col gap-1">
              {connectorAuthGate.scopes.map((sc, i) => (
                <li
                  key={i}
                  className="flex items-start gap-1.5 text-xs text-indigo-900 dark:text-indigo-100"
                >
                  <span className="mt-0.5 inline-flex shrink-0 text-indigo-500 dark:text-indigo-400">
                    <Icon icon="lucide:check" width={12} height={12} />
                  </span>
                  <span className="min-w-0 break-words">{sc}</span>
                </li>
              ))}
            </ul>
          </div>

          {connectorAuthGate.note ? (
            <p className="flex items-start gap-1.5 text-[11px] italic text-indigo-700/80 dark:text-indigo-300/70">
              <span className="mt-0.5 inline-flex shrink-0">
                <Icon icon="lucide:info" width={12} height={12} />
              </span>
              <span className="min-w-0 break-words">{connectorAuthGate.note}</span>
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onApprove}
              autoFocus
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 dark:hover:bg-indigo-500"
            >
              <span className="inline-flex">
                <Icon icon="lucide:shield-check" width={13} height={13} />
              </span>
              授权 · Authorize
            </button>
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-white px-3.5 py-1.5 text-xs font-medium text-indigo-800 transition-colors hover:bg-indigo-100 dark:border-indigo-500/40 dark:bg-neutral-900 dark:text-indigo-200 dark:hover:bg-neutral-800"
            >
              <span className="inline-flex">
                <Icon icon="lucide:x" width={13} height={13} />
              </span>
              取消 · Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* ── HITL gate (pending step is a risk gate) ─────────────────────────── */}
      {awaitingApproval && showRiskHitl ? (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="人审确认 · Human review"
          className="flex flex-col gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-2 text-sm text-amber-800 dark:text-amber-200">
            <span className="mt-0.5 inline-flex shrink-0 text-amber-600 dark:text-amber-400">
              <Icon icon="lucide:shield-alert" width={16} height={16} />
            </span>
            <span className="min-w-0">
              <span className="font-semibold">高风险/不可逆动作已拦截 · 待人审</span>
              <span className="ml-1.5 font-normal text-amber-700/80 dark:text-amber-300/80">
                Human review required before continuing.
              </span>
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onApprove}
              autoFocus
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 dark:hover:bg-emerald-500"
            >
              <span className="inline-flex">
                <Icon icon="lucide:check" width={13} height={13} />
              </span>
              通过 · Approve
            </button>
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-500/40 dark:bg-neutral-900 dark:text-amber-200 dark:hover:bg-neutral-800"
            >
              <span className="inline-flex">
                <Icon icon="lucide:x" width={13} height={13} />
              </span>
              驳回 · Reject
            </button>
          </div>
        </div>
      ) : null}

      {/* ── 正在执行 · Now running (above the grid · mobile-visible) ────────── */}
      <div
        aria-live="polite"
        aria-busy={isNowRunning}
        className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm shadow-sm"
      >
        {isNowRunning ? (
          <>
            <span className="inline-flex shrink-0 animate-spin text-brand motion-reduce:animate-none">
              <Icon icon="lucide:loader-2" width={15} height={15} />
            </span>
            <span className="shrink-0 font-medium text-foreground">正在执行 · Now running</span>
            <span className="hidden shrink-0 text-muted-foreground sm:inline">·</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {nowRunningLabel(activeStep)}
            </span>
          </>
        ) : awaitingApproval ? (
          <>
            <span className="inline-flex shrink-0 text-amber-500">
              <Icon icon="lucide:pause-circle" width={15} height={15} />
            </span>
            <span className="shrink-0 font-medium text-foreground">已暂停 · Paused</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              等待确认 · awaiting confirmation
            </span>
          </>
        ) : (
          <>
            <span className="inline-flex shrink-0 text-emerald-500">
              <Icon icon="lucide:check-circle-2" width={15} height={15} />
            </span>
            <span className="shrink-0 font-medium text-foreground">完成 · Done</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {total} 步 · {liveUsage}
            </span>
          </>
        )}
      </div>

      {/* ── 2-column grid (rail collapses → left spans full width · G14) ────── */}
      <div className={cn("grid grid-cols-1 gap-4", showRail && "lg:grid-cols-[1fr_320px]")}>
        {/* LEFT — reasoning/action chain */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="min-w-0 overflow-y-auto overflow-x-hidden rounded-xl border border-border bg-card p-4 shadow-sm lg:max-h-[72vh]">
            {run ? (
              <ReasoningActionChain
                run={run}
                revealed={revealedCount}
                activeIndex={activeIndex}
                onApprove={onApprove}
                onReject={onReset}
                chartRenderer={chartRenderer}
                markdownRenderer={markdownRenderer}
              />
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="inline-flex animate-spin text-brand motion-reduce:animate-none">
                  <Icon icon="lucide:loader-2" width={15} height={15} />
                </span>
                正在启动运行… · Starting run
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — status rail (5-module superset · each panel foldable · G13) */}
        {showRail ? (
          <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
            {/* ── ① PlannerState · 规划 ────────────────────────── */}
            <Panel icon="lucide:target" title="规划" en="Planner">
              <div className="flex flex-col gap-2">
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    目标 · Goal
                  </p>
                  <p className="break-words text-[11px] leading-relaxed text-foreground">
                    {plannerGoal || "—"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-medium text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300">
                    <span className="inline-flex">
                      <Icon icon="lucide:list-ordered" width={12} height={12} />
                    </span>
                    已执行 {plannerStepIndex} / 计划 {plannerTotal} 步
                  </span>
                  {replanned ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                      <span className="inline-flex">
                        <Icon icon="lucide:refresh-cw" width={12} height={12} />
                      </span>
                      已重规划 · Replanned
                    </span>
                  ) : null}
                </div>
                {/* progress bar — width is a runtime value (inline style, not a class) */}
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-indigo-500 dark:bg-indigo-400"
                    style={{ width: `${plannerPct}%` }}
                  />
                </div>
              </div>
            </Panel>

            {/* ── ④ ErrorState · 错误(only when a failure exists) ─── */}
            {runError ? (
              <Panel icon="lucide:alert-octagon" title="错误" en="Error">
                <div className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50/60 p-2.5 dark:border-red-500/30 dark:bg-red-500/10">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex text-red-500 dark:text-red-400">
                      <Icon icon={ERROR_TYPE_STYLE[runError.type].icon} width={13} height={13} />
                    </span>
                    <span className="text-[11px] font-semibold text-red-700 dark:text-red-300">
                      错误类型 · Type:
                    </span>
                    <span className="text-[11px] text-red-700 dark:text-red-300">
                      {ERROR_TYPE_STYLE[runError.type].label}
                    </span>
                  </div>
                  <p className="break-words text-[11px] leading-relaxed text-red-800/90 dark:text-red-200/90">
                    {runError.message}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
                    {runError.recovery ? (
                      <span className="inline-flex items-center gap-1 text-red-700/90 dark:text-red-300/90">
                        <span className="inline-flex">
                          <Icon icon="lucide:life-buoy" width={11} height={11} />
                        </span>
                        恢复策略 · Recovery:
                        <span className="font-medium">{RECOVERY_LABEL[runError.recovery]}</span>
                      </span>
                    ) : null}
                    <span className="inline-flex items-center gap-1 text-red-700/90 dark:text-red-300/90">
                      <span className="inline-flex">
                        <Icon
                          icon={runError.needsUser ? "lucide:user-check" : "lucide:bot"}
                          width={11}
                          height={11}
                        />
                      </span>
                      需人介入 · Needs human:
                      <span className="font-medium">
                        {runError.needsUser ? "是 · Yes" : "否 · No"}
                      </span>
                    </span>
                  </div>
                </div>
              </Panel>
            ) : null}

            {/* ── 数据来源 · Data Source (enrichment) ──────────── */}
            <Panel icon="lucide:database" title="数据来源" en="Data Source">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
                  DATA_MODE_STYLE[dataMode].chip,
                )}
              >
                <span className="inline-flex">
                  <Icon icon={DATA_MODE_STYLE[dataMode].icon} width={12} height={12} />
                </span>
                {DATA_MODE_STYLE[dataMode].label}
              </span>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {DATA_MODE_STYLE[dataMode].note}
              </p>
            </Panel>

            {/* ── 协调机制 · Coordination (enrichment · collapsed default) ─── */}
            <Panel icon="lucide:git-fork" title="协调机制" en="Coordination" defaultOpen={false}>
              <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
                每个动作标注「谁在驱动这一步」—— 主控编排、Agent 接力、Harness 自动、Loop
                成果环、人审。这是编排架构的答案。
              </p>
              <ul className="flex flex-col gap-2.5">
                {COORD_LEGEND.map((m) => (
                  <li key={m.id} className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <CoordBadge coord={m.id} />
                      <span className="text-xs font-semibold text-foreground">{m.label}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{m.en}</span>
                    </div>
                    <p className="break-words text-[11px] leading-relaxed text-muted-foreground">
                      {m.desc}
                    </p>
                  </li>
                ))}
              </ul>
            </Panel>

            {/* ── 进度 · Progress (enrichment) ─────────────────── */}
            <Panel icon="lucide:list-checks" title="进度" en="Progress">
              <ul className="flex flex-col gap-1.5">
                {liveProgress.map((p, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px]">
                    <span
                      className={cn(
                        "mt-0.5 inline-flex shrink-0",
                        p.done ? "text-emerald-500" : "text-muted-foreground",
                      )}
                    >
                      <Icon
                        icon={p.done ? "lucide:check-circle-2" : "lucide:arrow-right"}
                        width={13}
                        height={13}
                      />
                    </span>
                    <span
                      className={cn(
                        "min-w-0 break-words",
                        p.done ? "text-muted-foreground line-through" : "text-foreground",
                      )}
                    >
                      {p.label}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>

            {/* ── ② ToolsState · 技能·工具·连接器 + 成功率 + 错误日志 ─── */}
            <Panel
              icon="lucide:blocks"
              title="技能 · 工具 · 连接器"
              en="Skills · Tools · Connectors"
              count={inventory.length}
            >
              {toolStats.successRate != null ? (
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 text-[11px] dark:bg-neutral-800/40">
                  <span className="inline-flex text-emerald-500">
                    <Icon icon="lucide:activity" width={12} height={12} />
                  </span>
                  <span className="text-muted-foreground">成功率 · Success rate</span>
                  <span className="ml-auto font-mono font-semibold text-foreground">
                    {toolStats.successRate}%
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    ({toolStats.success}/{toolStats.attempted})
                  </span>
                </div>
              ) : null}

              {inventory.length > 0 ? (
                <ul className="flex flex-col gap-1.5">
                  {inventory.map((it, i) => (
                    <li key={i} className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="inline-flex shrink-0 text-muted-foreground">
                          <Icon icon={INV_KIND_ICON[it.kind]} width={13} height={13} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                          {it.label}
                        </span>
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                            INV_STATUS_STYLE[it.status].badge,
                          )}
                        >
                          <span className="inline-flex">
                            <Icon icon={INV_STATUS_STYLE[it.status].icon} width={10} height={10} />
                          </span>
                          {INV_STATUS_STYLE[it.status].label}
                        </span>
                      </div>
                      {it.outcome || it.durationMs != null ? (
                        <div className="ml-5 flex items-center gap-2 text-[10px]">
                          {it.outcome ? (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 font-medium",
                                OUTCOME_STYLE[it.outcome].cls,
                              )}
                            >
                              <span className="inline-flex">
                                <Icon icon={OUTCOME_STYLE[it.outcome].icon} width={10} height={10} />
                              </span>
                              {OUTCOME_STYLE[it.outcome].label}
                            </span>
                          ) : null}
                          {it.durationMs != null ? (
                            <span className="font-mono text-muted-foreground">
                              · {(it.durationMs / 1000).toFixed(1)}s
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {running
                    ? "运行中,尚未识别 skill / connector…"
                    : "本次运行未使用外部 skill 或 connector。"}
                </p>
              )}

              {toolStats.errorLog.length > 0 ? (
                <ErrorLogDisclosure entries={toolStats.errorLog} />
              ) : null}
            </Panel>

            {/* ── ③ MemoryState · 记忆(config.showMemory) ────────── */}
            {showMemory ? (
              <Panel
                icon="lucide:database-zap"
                title="记忆"
                en="Memory"
                count={memoryCount}
                defaultOpen={false}
              >
                {memory &&
                (memory.contextSummary || memory.kbRefs?.length || memory.updates?.length) ? (
                  <div className="flex flex-col gap-2.5">
                    {memory.contextSummary ? (
                      <div>
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          上下文摘要 · Context
                        </p>
                        <p className="break-words text-[11px] leading-relaxed text-foreground">
                          {memory.contextSummary}
                        </p>
                      </div>
                    ) : null}
                    {memory.kbRefs?.length ? (
                      <div>
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          长期记忆 · KB refs
                        </p>
                        <ul className="flex flex-col gap-1">
                          {memory.kbRefs.map((k, i) => (
                            <li key={i} className="flex min-w-0 items-center gap-1.5 text-[11px]">
                              <span className="inline-flex shrink-0 text-brand">
                                <Icon icon="lucide:book-marked" width={11} height={11} />
                              </span>
                              <span className="min-w-0 flex-1 truncate text-foreground">
                                {k.label}
                              </span>
                              {k.source ? (
                                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                                  {k.source}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {memory.updates?.length ? (
                      <div>
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          记忆更新 · Writes
                        </p>
                        <ul className="flex flex-col gap-1">
                          {memory.updates.map((u, i) => (
                            <li
                              key={i}
                              className="flex min-w-0 items-start gap-1.5 text-[11px] text-foreground"
                            >
                              <span className="mt-0.5 inline-flex shrink-0 text-emerald-500">
                                <Icon icon="lucide:plus-circle" width={11} height={11} />
                              </span>
                              <span className="min-w-0 break-words">{u}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="flex items-start gap-1.5 text-[11px] italic leading-relaxed text-muted-foreground">
                    <span className="mt-0.5 inline-flex shrink-0">
                      <Icon icon="lucide:info" width={11} height={11} />
                    </span>
                    <span className="min-w-0">本会话暂无记忆写入 · No memory writes this run</span>
                  </p>
                )}
              </Panel>
            ) : null}

            {/* ── 工件 · Artifacts (enrichment · collapsed default) ─── */}
            <Panel
              icon="lucide:package"
              title="工件"
              en="Artifacts"
              count={liveArtifacts.length}
              defaultOpen={false}
            >
              {liveArtifacts.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {liveArtifacts.map((a, i) => (
                    <li
                      key={i}
                      className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-muted/50 px-2.5 py-2 dark:bg-neutral-800/40"
                    >
                      <span className="mt-0.5 inline-flex shrink-0 text-brand">
                        <Icon icon={a.icon} width={15} height={15} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-[11px] font-medium text-foreground">
                          {a.name}
                        </span>
                        <span className="block break-words text-[10px] text-muted-foreground">
                          {a.sub}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {running ? "运行中,尚无工件产出…" : "本次运行无工件产出。"}
                </p>
              )}
            </Panel>

            {/* ── ⑤ MetricsState · 指标(config.showMetrics) ─────── */}
            {showMetrics ? (
              <Panel icon="lucide:gauge" title="指标" en="Metrics">
                <ul className="flex flex-col gap-1.5">
                  <MetricRow icon="lucide:clock" label="总耗时 · Duration" value={liveUsage} />
                  <MetricRow icon="lucide:coins" label="Token 用量 · P/C" value={tokenValue} />
                  <MetricRow
                    icon="lucide:wrench"
                    label="工具调用 · Tool calls"
                    value={String(metricToolCalls)}
                  />
                  <MetricRow
                    icon="lucide:list-ordered"
                    label="Planner 步数 · Steps"
                    value={`${metricPlannerSteps} / ${plannerTotal}`}
                  />
                  <MetricRow
                    icon="lucide:network"
                    label="Trace 节点 · Nodes"
                    value={String(metricTraceNodes)}
                  />
                </ul>
              </Panel>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

/** A collapsible status panel — click the header to fold (G13). */
function Panel({
  icon,
  title,
  en,
  count,
  defaultOpen = true,
  children,
}: {
  icon: string;
  title: string;
  en: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      >
        <span className="inline-flex shrink-0 text-brand">
          <Icon icon={icon} width={14} height={14} />
        </span>
        <span className="text-xs font-semibold text-foreground">{title}</span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">{en}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {typeof count === "number" ? (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              {count}
            </span>
          ) : null}
          <span className="inline-flex text-muted-foreground">
            <Icon
              icon={open ? "lucide:chevron-up" : "lucide:chevron-down"}
              width={14}
              height={14}
            />
          </span>
        </span>
      </button>
      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </section>
  );
}

/** A right-aligned metric row (label + mono value) for MetricsState. */
function MetricRow({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}): ReactElement {
  return (
    <li className="flex items-center gap-2 text-[11px]">
      <span className="inline-flex shrink-0 text-muted-foreground">
        <Icon icon={icon} width={12} height={12} />
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
      <span className="shrink-0 font-mono text-[11px] font-semibold text-foreground">{value}</span>
    </li>
  );
}

/** Collapsible error log for ToolsState — failed steps' labels + notes. */
function ErrorLogDisclosure({
  entries,
}: {
  entries: { label: string; note?: string }[];
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 rounded-lg border border-red-200 bg-red-50/60 p-2 dark:border-red-500/30 dark:bg-red-500/10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-[11px] font-medium text-red-700 dark:text-red-300"
      >
        <span className="inline-flex shrink-0">
          <Icon icon="lucide:alert-triangle" width={11} height={11} />
        </span>
        错误日志 · Error log
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-100 px-1 text-[10px] font-semibold text-red-700 dark:bg-red-500/20 dark:text-red-300">
          {entries.length}
        </span>
        <span className="ml-auto inline-flex shrink-0">
          <Icon icon={open ? "lucide:chevron-up" : "lucide:chevron-down"} width={12} height={12} />
        </span>
      </button>
      {open ? (
        <ul className="mt-1.5 flex flex-col gap-1">
          {entries.map((e, i) => (
            <li
              key={i}
              className="flex min-w-0 items-start gap-1.5 text-[10px] text-red-700/90 dark:text-red-300/90"
            >
              <span className="mt-0.5 inline-flex shrink-0">
                <Icon icon="lucide:x-circle" width={10} height={10} />
              </span>
              <span className="min-w-0 break-words">
                <span className="font-medium">{e.label}</span>
                {e.note ? (
                  <span className="text-red-600/70 dark:text-red-400/70"> · {e.note}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
