"use client";

// ─────────────────────────────────────────────────────────────────────────────
// reasoning-action-chain.tsx — LEFT-column renderer of a Perplexity-style
// agentic "reasoning + action" stream · live-trace 2.0 (brand-agnostic template).
//
// Consumes an `AgenticRun` trace (from ./agentic-chain-data) and renders the
// StepKind variants (reasoning / action / fanout / results / progress /
// artifact / read / wait / handoff / hitl / connector-auth / chart / answer) in
// order, with a coordination badge on every ACTION-class step (谁在驱动这一步:
// master / a2a / harness / loop / hitl).
//
// Live-trace 2.0 treatments:
//   • 推理 vs 行动 差异化 — reasoning renders as a COOL, italic「思绪 · thought」
//     (brain glyph, no coord badge); action-class steps render as STRUCTURED
//     execution rows with a coord badge + tool chips.
//   • active-step live indicators — reasoning →「思考中 · thinking」pulsing brain +
//     bouncing dots; action →「执行中 · executing」spinner glyph + shimmer bar.
//     done steps settle (✓ + `· 0.4s` timing when durationMs present).
//   • connector-auth — a distinct blue/indigo authorization card (scopes + honesty
//     note + Authorize/Cancel), separate from the amber/rose HITL risk gate.
//   • chart / answer chart — PLUGGABLE: pass `chartRenderer` (a project's own
//     SmartChart / ECharts) via props; a minimal text-table fallback renders when
//     absent.
//   • answer markdown — PLUGGABLE: pass `markdownRenderer`; a minimal built-in
//     (DefaultMarkdown: headings / bold / code / lists / tables) renders when absent.
//   • functional gates — HITL + connector-auth buttons wire to onApprove/onReject.
//
// Rules honored: light-first + dark: on every element · design token `text-brand`
// for accents · every inline <Icon> wrapped in its own <span> (async-Icon
// insertBefore guard, via <Ico>) · Tailwind class strings are LITERAL (Record
// lookups / per-branch literals, never string-built) so the JIT can see them ·
// Token=0 (pure props, no Math.random / Date.now) · third-party connector product
// names (Gmail etc.) are OK · all animations respect prefers-reduced-motion ·
// bilingual 中文叙述 + English terms.
//
// Import paths (`./…`) resolve against the sibling templates once scaffolded into
// a host project alongside ./agentic-chain-data.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Icon } from "@iconify/react";
import {
  type AgenticRun,
  type ChainChild,
  type ChainStep,
  type ChartData,
  type Coord,
  COORD_LEGEND,
} from "../types/chain-data";

// ── Minimal className joiner (self-contained · no host dep) ───────────────────
// Conditional literal classes only (no conflicting-utility merging needed here).
type ClassValue = string | false | null | undefined;
function cn(...parts: ClassValue[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

// ── Step lifecycle phase (from the shell's activeIndex) ──────────────────────
// active  = this step is executing right now (spinner / thinking indicators)
// done    = this step already executed in a LIVE run (settled → ✓ + timing)
// settled = the run is not live-revealing (static / fully-arrived) — completed
type Phase = "active" | "done" | "settled";

// ── Coordination hue map (LITERAL class strings — Tailwind must see them) ─────
const COORD_STYLE: Record<Coord, { text: string; bg: string; border: string }> = {
  master: {
    text: "text-indigo-700 dark:text-indigo-300",
    bg: "bg-indigo-50 dark:bg-indigo-500/10",
    border: "border-indigo-200 dark:border-indigo-500/30",
  },
  a2a: {
    text: "text-teal-700 dark:text-teal-300",
    bg: "bg-teal-50 dark:bg-teal-500/10",
    border: "border-teal-200 dark:border-teal-500/30",
  },
  harness: {
    text: "text-slate-700 dark:text-slate-300",
    bg: "bg-slate-100 dark:bg-slate-500/10",
    border: "border-slate-200 dark:border-slate-500/30",
  },
  loop: {
    text: "text-amber-700 dark:text-amber-300",
    bg: "bg-amber-50 dark:bg-amber-500/10",
    border: "border-amber-200 dark:border-amber-500/30",
  },
  hitl: {
    text: "text-rose-700 dark:text-rose-300",
    bg: "bg-rose-50 dark:bg-rose-500/10",
    border: "border-rose-200 dark:border-rose-500/30",
  },
};

// ── Child status dot (LITERAL class strings) ─────────────────────────────────
const STATUS_DOT: Record<NonNullable<ChainChild["status"]>, string> = {
  done: "bg-emerald-500",
  running: "bg-amber-500 animate-pulse",
  queued: "bg-slate-400 dark:bg-slate-600",
  failed: "bg-red-500",
};

// ── HITL risk chip (LITERAL class strings) ───────────────────────────────────
const RISK_STYLE: Record<"HIGH" | "MID" | "LOW", string> = {
  HIGH: "border-red-300 bg-red-100 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300",
  MID: "border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300",
  LOW: "border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300",
};

// ── Reduced-motion preference (guards every animation) ───────────────────────
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

// ── Icon wrapper — guarantees every inline Icon sits in its own <span> ────────
function Ico({ icon, className }: { icon: string; className?: string }): ReactElement {
  return (
    <span className="inline-flex shrink-0 items-center justify-center">
      <Icon icon={icon} className={className} />
    </span>
  );
}

// ── Small chip (connector / skill / model) ───────────────────────────────────
function Chip({ icon, label }: { icon?: string; label: string }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground dark:border-neutral-800 dark:bg-neutral-800/60 dark:text-neutral-300">
      {icon ? <Ico icon={icon} className="h-3 w-3" /> : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

function StatusDot({ status }: { status?: ChainChild["status"] }): ReactElement {
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        STATUS_DOT[status ?? "queued"],
      )}
    />
  );
}

function RiskChip({ risk }: { risk: "HIGH" | "MID" | "LOW" }): ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        RISK_STYLE[risk],
      )}
    >
      {risk}
    </span>
  );
}

// ── The coordination badge — "谁在驱动这一步" ─────────────────────────────────
export function CoordBadge({ coord }: { coord: Coord }): ReactElement | null {
  const mode = COORD_LEGEND.find((m) => m.id === coord);
  if (!mode) return null;
  const s = COORD_STYLE[coord];
  return (
    <span
      title={mode.desc}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
        s.text,
        s.bg,
        s.border,
      )}
    >
      <Ico icon={mode.icon} className="h-3 w-3" />
      <span>{mode.label}</span>
      <span className="hidden opacity-60 sm:inline">· {mode.en}</span>
    </span>
  );
}

// ── Timing / done marker — "✓ · 0.4s" ────────────────────────────────────────
function DoneMark({ ms }: { ms?: number }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
      <Ico icon="lucide:check" className="h-3 w-3" />
      {ms != null ? (
        <span className="text-muted-foreground dark:text-neutral-500">
          · {(ms / 1000).toFixed(1)}s
        </span>
      ) : null}
    </span>
  );
}

// ── "执行中 · executing" tag (spinner lives in the ActionGlyph) ───────────────
function ExecutingTag(): ReactElement {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-neutral-400">
      <span>执行中 · executing</span>
    </span>
  );
}

// ── Indeterminate shimmer progress bar (reduced-motion → static bar) ──────────
function ShimmerBar({ reduced }: { reduced: boolean }): ReactElement {
  const inner = reduced
    ? "h-full w-full rounded-full bg-slate-300 dark:bg-neutral-600"
    : "h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-slate-500 to-transparent animate-pulse dark:via-neutral-300";
  return (
    <div
      className="ml-7 mt-1.5 h-0.5 w-full max-w-[220px] overflow-hidden rounded-full bg-slate-200 dark:bg-neutral-800"
      aria-hidden="true"
    >
      <div className={inner} />
    </div>
  );
}

// ── Bouncing "…" thinking dots (reduced-motion → static ellipsis) ────────────
function ThinkingDots({ reduced }: { reduced: boolean }): ReactElement {
  if (reduced) {
    return (
      <span aria-hidden="true" className="text-indigo-400 dark:text-indigo-300">
        ···
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-0.5">
      <span className="h-1 w-1 animate-bounce rounded-full bg-indigo-400 [animation-delay:0ms] dark:bg-indigo-300" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-indigo-400 [animation-delay:150ms] dark:bg-indigo-300" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-indigo-400 [animation-delay:300ms] dark:bg-indigo-300" />
    </span>
  );
}

// ── Leading glyph square for action-class steps ──────────────────────────────
function ActionGlyph({
  icon,
  phase,
  reduced,
}: {
  icon?: string;
  phase: Phase;
  reduced: boolean;
}): ReactElement {
  if (phase === "active") {
    return (
      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-slate-100 text-slate-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
        <Ico icon="lucide:loader-2" className={cn("h-3.5 w-3.5", reduced ? "" : "animate-spin")} />
      </span>
    );
  }
  return (
    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground dark:border-neutral-800 dark:bg-neutral-800/60 dark:text-neutral-400">
      {icon ? (
        <Ico icon={icon} className="h-3.5 w-3.5" />
      ) : (
        <span className="font-mono text-[10px] leading-none">{">_"}</span>
      )}
    </span>
  );
}

// ── A structured action-style header row (execution treatment) ───────────────
function ActionRow({
  icon,
  title,
  coord,
  phase,
  durationMs,
  reduced,
  children,
}: {
  icon?: string;
  title?: string;
  coord?: Coord;
  phase: Phase;
  durationMs?: number;
  reduced: boolean;
  children?: ReactNode;
}): ReactElement {
  const showDone = phase === "done" || (phase === "settled" && durationMs != null);
  return (
    <div>
      <div className="flex items-start gap-2">
        <ActionGlyph icon={icon} phase={phase} reduced={reduced} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground dark:text-neutral-100">{title}</span>
          {children}
          {phase === "active" ? <ExecutingTag /> : null}
          {showDone ? <DoneMark ms={durationMs} /> : null}
        </div>
        {coord ? <CoordBadge coord={coord} /> : null}
      </div>
      {phase === "active" ? <ShimmerBar reduced={reduced} /> : null}
    </div>
  );
}

function IndentList({ children }: { children: ReactNode }): ReactElement {
  return (
    <ul className="ml-2.5 mt-2 space-y-1 border-l border-border pl-4 dark:border-neutral-800">
      {children}
    </ul>
  );
}

// ── Minimal built-in Markdown (default `markdownRenderer`) ────────────────────
// Supports headings (#..######), **bold**, `code`, ordered / unordered lists,
// and GitHub-style tables. Purely deterministic (Token=0). Pass a richer
// `markdownRenderer` prop to override with the host's own component.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) nodes.push(text.slice(lastIndex, m.index));
    if (m[2] != null) {
      nodes.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold text-foreground dark:text-neutral-100">
          {m[2]}
        </strong>,
      );
    } else if (m[3] != null) {
      nodes.push(
        <code
          key={`${keyPrefix}-c${i}`}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground dark:bg-neutral-800 dark:text-neutral-200"
        >
          {m[3]}
        </code>,
      );
    }
    lastIndex = regex.lastIndex;
    i++;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function splitCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function renderTable(rows: string[], key: number): ReactElement {
  const header = splitCells(rows[0]);
  const bodyRows = rows.slice(2).map(splitCells); // rows[1] is the |---| separator
  return (
    <div key={`tbl-${key}`} className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {header.map((h, j) => (
              <th
                key={j}
                className="border border-border bg-muted px-2 py-1 text-left font-semibold text-foreground dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
              >
                {renderInline(h, `th${key}-${j}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td
                  key={ci}
                  className="border border-border px-2 py-1 align-top text-foreground dark:border-neutral-800 dark:text-neutral-200"
                >
                  {renderInline(c, `td${key}-${ri}-${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const HEADING_CLASS: Record<1 | 2 | 3, string> = {
  1: "mb-1.5 mt-3 text-base font-bold text-foreground dark:text-neutral-100",
  2: "mb-1 mt-2.5 text-sm font-bold text-foreground dark:text-neutral-100",
  3: "mb-1 mt-2 text-sm font-semibold text-foreground dark:text-neutral-200",
};

export function DefaultMarkdown({ text }: { text: string }): ReactElement {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const isTable = (l: string) => l.trim().startsWith("|");
  const isUl = (l: string) => /^\s*[-*]\s+/.test(l);
  const isOl = (l: string) => /^\s*\d+\.\s+/.test(l);
  const isHeading = (l: string) => /^(#{1,6})\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = Math.min(3, h[1].length) as 1 | 2 | 3;
      blocks.push(
        <p key={key} className={HEADING_CLASS[lvl]}>
          {renderInline(h[2], `h${key}`)}
        </p>,
      );
      key++;
      i++;
      continue;
    }
    if (isTable(line)) {
      const tbl: string[] = [];
      while (i < lines.length && isTable(lines[i])) {
        tbl.push(lines[i]);
        i++;
      }
      if (tbl.length >= 2) {
        blocks.push(renderTable(tbl, key));
      } else {
        blocks.push(
          <p key={key} className="my-1.5 text-sm leading-7 text-foreground dark:text-neutral-200">
            {renderInline(tbl.join(" "), `p${key}`)}
          </p>,
        );
      }
      key++;
      continue;
    }
    if (isOl(line)) {
      const items: string[] = [];
      while (i < lines.length && isOl(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol
          key={key}
          className="my-1.5 ml-5 list-decimal space-y-1 text-sm leading-7 text-foreground dark:text-neutral-200"
        >
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, `ol${key}-${j}`)}</li>
          ))}
        </ol>,
      );
      key++;
      continue;
    }
    if (isUl(line)) {
      const items: string[] = [];
      while (i < lines.length && isUl(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul
          key={key}
          className="my-1.5 ml-5 list-disc space-y-1 text-sm leading-7 text-foreground dark:text-neutral-200"
        >
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, `ul${key}-${j}`)}</li>
          ))}
        </ul>,
      );
      key++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !isHeading(lines[i]) &&
      !isTable(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key} className="my-1.5 text-sm leading-7 text-foreground dark:text-neutral-200">
        {renderInline(para.join(" "), `p${key}`)}
      </p>,
    );
    key++;
  }
  return <div className="text-sm leading-7 text-foreground dark:text-neutral-200">{blocks}</div>;
}

// ── Minimal built-in chart fallback (default when `chartRenderer` absent) ─────
// A compact text table of the chart's rows — honest placeholder. Pass a
// `chartRenderer` prop to plug in the host's real chart component.
export function DefaultChartFallback({ chart }: { chart: ChartData }): ReactElement | null {
  const rows = chart.rows.slice(0, 8);
  if (!rows.length) return null;
  const keySet = rows.reduce((set, r) => {
    Object.keys(r).forEach((k) => set.add(k));
    return set;
  }, new Set<string>());
  const keys = Array.from(keySet);
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-2 dark:border-neutral-800 dark:bg-neutral-800/40">
      <div className="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground">
        <Ico icon="lucide:table" className="h-3 w-3" />
        <span>数据表 · Data (text fallback · pass chartRenderer for a chart)</span>
      </div>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {keys.map((k) => (
              <th
                key={k}
                className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground dark:border-neutral-700"
              >
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {keys.map((k) => (
                <td
                  key={k}
                  className="border-b border-border/50 px-2 py-1 text-foreground dark:border-neutral-800 dark:text-neutral-200"
                >
                  {String(r[k] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Chart sub-render — used by kind "chart" AND any step carrying `chart` ─────
function StepChart({
  step,
  chartRenderer,
}: {
  step: ChainStep;
  chartRenderer?: (chart: ChartData) => ReactNode;
}): ReactElement | null {
  const chart = step.chart;
  if (!chart?.rows?.length) return null;
  return (
    <div className="mt-2">
      {chart.label ? (
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground dark:text-neutral-400">
          <Ico icon="lucide:bar-chart-3" className="h-3 w-3" />
          <span>{chart.label}</span>
        </div>
      ) : null}
      {chartRenderer ? chartRenderer(chart) : <DefaultChartFallback chart={chart} />}
    </div>
  );
}

// ── Per-step body renderer (the kind switch) ─────────────────────────────────
function StepBody({
  step,
  phase,
  reduced,
  onApprove,
  onReject,
  markdownRenderer,
}: {
  step: ChainStep;
  phase: Phase;
  reduced: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  markdownRenderer?: (text: string) => ReactNode;
}): ReactNode {
  switch (step.kind) {
    // 1) reasoning — a COOL, italic「思绪 · thought」: brain glyph, no coord badge
    case "reasoning":
      return (
        <div className="border-l-2 border-indigo-200 pl-3 dark:border-indigo-500/40">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-500/15">
              <Ico
                icon="lucide:brain"
                className={cn(
                  "h-2.5 w-2.5 text-indigo-500 dark:text-indigo-300",
                  phase === "active" && !reduced && "animate-pulse",
                )}
              />
            </span>
            <span className="text-[11px] font-medium uppercase tracking-wide text-indigo-500/90 dark:text-indigo-300/90">
              {phase === "active" ? "思考中 · thinking" : "思绪 · thought"}
            </span>
            {phase === "active" ? <ThinkingDots reduced={reduced} /> : null}
            {phase !== "active" && step.durationMs != null ? (
              <span className="text-[11px] text-muted-foreground dark:text-neutral-500">
                · {(step.durationMs / 1000).toFixed(1)}s
              </span>
            ) : null}
          </div>
          <p className="text-sm italic leading-7 text-slate-600 dark:text-neutral-300">
            {step.text}
          </p>
          {step.note ? (
            <p className="mt-1 flex items-center gap-1 text-xs italic text-muted-foreground/80 dark:text-neutral-500">
              <Ico icon="lucide:info" className="h-3 w-3" />
              <span>{step.note}</span>
            </p>
          ) : null}
        </div>
      );

    // 2) action — glyph + title + connector/skill chip + coord badge
    case "action":
      return (
        <ActionRow
          icon={step.icon}
          title={step.title}
          coord={step.coord}
          phase={phase}
          durationMs={step.durationMs}
          reduced={reduced}
        >
          {step.connector ? <Chip icon="lucide:plug" label={step.connector} /> : null}
          {step.skill ? <Chip icon="lucide:sparkles" label={step.skill} /> : null}
          {step.input ? <Chip icon="lucide:terminal" label={step.input} /> : null}
        </ActionRow>
      );

    // 3) fanout — parent row + indented child tree
    case "fanout":
      return (
        <div>
          <ActionRow
            icon={step.icon ?? "lucide:git-fork"}
            title={step.title}
            coord={step.coord}
            phase={phase}
            durationMs={step.durationMs}
            reduced={reduced}
          >
            {step.skill ? <Chip icon="lucide:sparkles" label={step.skill} /> : null}
            {step.connector ? <Chip icon="lucide:plug" label={step.connector} /> : null}
          </ActionRow>
          {step.children?.length ? (
            <IndentList>
              {step.children.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <StatusDot status={c.status} />
                  <span className="font-mono text-[10px] text-muted-foreground dark:text-neutral-500">
                    {">_"}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      c.link
                        ? "text-brand hover:underline"
                        : "text-foreground dark:text-neutral-200",
                    )}
                  >
                    {c.label}
                  </span>
                  {c.status === "failed" ? (
                    <span className="shrink-0 text-[11px] text-red-500">failed</span>
                  ) : null}
                </li>
              ))}
            </IndentList>
          ) : null}
        </div>
      );

    // 4) results — connector query + indented source list
    case "results":
      return (
        <div>
          <ActionRow
            icon={step.icon ?? "lucide:search"}
            title={step.title}
            coord={step.coord}
            phase={phase}
            durationMs={step.durationMs}
            reduced={reduced}
          >
            {step.connector ? <Chip icon="lucide:plug" label={step.connector} /> : null}
            {step.input ? <Chip icon="lucide:terminal" label={step.input} /> : null}
          </ActionRow>
          {step.sources?.length ? (
            <IndentList>
              {step.sources.map((s, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <Ico
                    icon="lucide:file-text"
                    className="h-3.5 w-3.5 text-muted-foreground dark:text-neutral-500"
                  />
                  <span className="min-w-0 truncate text-foreground dark:text-neutral-200">
                    {s.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground dark:text-neutral-500">
                    {s.source}
                  </span>
                  {s.premium ? (
                    <Ico icon="lucide:crown" className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  ) : null}
                </li>
              ))}
            </IndentList>
          ) : null}
        </div>
      );

    // 5) progress — checklist
    case "progress":
      return (
        <div>
          <ActionRow
            icon="lucide:list-checks"
            title={step.title}
            coord={step.coord}
            phase={phase}
            durationMs={step.durationMs}
            reduced={reduced}
          />
          {step.children?.length ? (
            <IndentList>
              {step.children.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <Ico
                    icon={c.status === "done" ? "lucide:check-square" : "lucide:square"}
                    className={cn(
                      "h-3.5 w-3.5",
                      c.status === "done"
                        ? "text-emerald-500"
                        : "text-muted-foreground dark:text-neutral-500",
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0",
                      c.status === "done"
                        ? "text-foreground dark:text-neutral-200"
                        : "text-muted-foreground dark:text-neutral-400",
                    )}
                  >
                    {c.label}
                  </span>
                </li>
              ))}
            </IndentList>
          ) : null}
        </div>
      );

    // 6) artifact — card
    case "artifact":
      return (
        <div className="rounded-xl border border-border bg-white p-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-start gap-2">
            <ActionGlyph icon={step.icon ?? "lucide:file-text"} phase={phase} reduced={reduced} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold text-foreground dark:text-neutral-100">
                  {step.title ?? step.artifact?.name}
                </span>
                {step.artifact?.model ? (
                  <Chip icon="lucide:cpu" label={step.artifact.model} />
                ) : null}
                {phase === "active" ? <ExecutingTag /> : null}
                {phase !== "active" && step.durationMs != null ? (
                  <DoneMark ms={step.durationMs} />
                ) : null}
              </div>
              {step.artifact?.sub ? (
                <div className="mt-0.5 truncate text-xs text-muted-foreground dark:text-neutral-500">
                  {step.artifact.sub}
                </div>
              ) : null}
              {step.note ? (
                <div className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground dark:text-neutral-400">
                  <Ico icon="lucide:info" className="mt-0.5 h-3 w-3" />
                  <span>{step.note}</span>
                </div>
              ) : null}
              {step.fromAgent && step.toAgent ? (
                <div className="mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-md bg-teal-50 px-2 py-1 text-xs text-teal-700 dark:bg-teal-500/10 dark:text-teal-300">
                  <span className="font-medium">{step.fromAgent}</span>
                  <Ico icon="lucide:arrow-right" className="h-3.5 w-3.5" />
                  <span className="font-medium">{step.toAgent}</span>
                </div>
              ) : null}
              {phase === "active" ? (
                <div className="mt-1.5">
                  <ShimmerBar reduced={reduced} />
                </div>
              ) : null}
            </div>
            {step.coord ? <CoordBadge coord={step.coord} /> : null}
          </div>
        </div>
      );

    // 7) read
    case "read":
      return (
        <ActionRow
          icon={step.icon ?? "lucide:file-search"}
          title={step.title}
          coord={step.coord}
          phase={phase}
          durationMs={step.durationMs}
          reduced={reduced}
        />
      );

    // 8) wait — the ActionGlyph spinner reads as "waiting / executing"
    case "wait":
      return (
        <ActionRow
          icon={step.icon ?? "lucide:loader"}
          title={step.title}
          coord={step.coord}
          phase={phase}
          durationMs={step.durationMs}
          reduced={reduced}
        >
          {step.agent ? <Chip icon="lucide:bot" label={step.agent} /> : null}
        </ActionRow>
      );

    // 9) handoff — teal marker
    case "handoff":
      return (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 dark:border-teal-500/30 dark:bg-teal-500/10">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-teal-700 dark:text-teal-300">
            <Ico icon="lucide:arrow-right-left" className="h-4 w-4" />
            <span className="font-medium">{step.fromAgent}</span>
            <Ico icon="lucide:arrow-right" className="h-3.5 w-3.5" />
            <span className="font-medium">{step.toAgent}</span>
            {step.title ? (
              <span className="truncate text-teal-600/80 dark:text-teal-400/80">· {step.title}</span>
            ) : null}
            {phase !== "active" && step.durationMs != null ? (
              <DoneMark ms={step.durationMs} />
            ) : null}
          </div>
          {step.coord ? <CoordBadge coord={step.coord} /> : null}
        </div>
      );

    // 10) hitl — amber/rose risk gate with FUNCTIONAL approve / reject buttons
    case "hitl": {
      const resolved = phase === "done"; // already approved in a live run
      return (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Ico
                icon="lucide:shield-alert"
                className="h-4 w-4 text-amber-600 dark:text-amber-400"
              />
              {step.gate ? <RiskChip risk={step.gate.risk} /> : null}
              <span className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                {step.title ?? "人审确认 · Human review"}
              </span>
            </div>
            {step.coord ? <CoordBadge coord={step.coord} /> : null}
          </div>
          {step.gate ? (
            <p className="mt-1.5 text-sm text-amber-800/90 dark:text-amber-200/90">
              {step.gate.question}
            </p>
          ) : null}
          {resolved ? (
            <div className="mt-2.5 inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <Ico icon="lucide:check-circle" className="h-3.5 w-3.5" />
              <span>已通过 · Approved</span>
            </div>
          ) : (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onApprove}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
              >
                <Ico icon="lucide:check" className="h-3.5 w-3.5" />
                <span>通过 · Approve</span>
              </button>
              <button
                type="button"
                onClick={onReject}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <Ico icon="lucide:x" className="h-3.5 w-3.5" />
                <span>驳回 · Reject</span>
              </button>
            </div>
          )}
        </div>
      );
    }

    // 11) connector-auth — a DISTINCT blue/indigo external-connect gate
    case "connector-auth": {
      const ca = step.connectorAuth;
      const authorized = phase === "done"; // gate already passed in a live run
      return (
        <div className="rounded-xl border border-blue-300 bg-blue-50 p-3 dark:border-blue-500/40 dark:bg-blue-500/10">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-start gap-2">
              <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-blue-200 bg-white dark:border-blue-500/30 dark:bg-neutral-900">
                <Ico
                  icon={ca?.icon ?? "lucide:plug-zap"}
                  className="h-4 w-4 text-blue-600 dark:text-blue-300"
                />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold text-blue-800 dark:text-blue-200">
                    连接授权 · Authorize {ca?.connectorLabel ?? "connector"}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:border-blue-500/30 dark:bg-neutral-900 dark:text-blue-300">
                    <Ico icon="lucide:lock" className="h-2.5 w-2.5" />
                    <span>external · auth required</span>
                  </span>
                </div>
                {step.title ? (
                  <p className="mt-0.5 text-xs text-blue-700/90 dark:text-blue-300/80">
                    {step.title}
                  </p>
                ) : null}
              </div>
            </div>
            {step.coord ? <CoordBadge coord={step.coord} /> : null}
          </div>

          {ca?.scopes?.length ? (
            <div className="mt-2.5">
              <div className="mb-1 text-[11px] font-medium text-blue-700/80 dark:text-blue-300/70">
                将访问 · Will access
              </div>
              <ul className="space-y-1">
                {ca.scopes.map((sc, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-1.5 text-xs text-blue-800/90 dark:text-blue-200/90"
                  >
                    <Ico icon="lucide:check" className="h-3 w-3 shrink-0 text-blue-500 dark:text-blue-300" />
                    <span className="min-w-0">{sc}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {ca?.note ? (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-blue-700/80 dark:text-blue-300/70">
              <Ico icon="lucide:shield-check" className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{ca.note}</span>
            </p>
          ) : null}

          {authorized ? (
            <div className="mt-2.5 inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <Ico icon="lucide:check-circle" className="h-3.5 w-3.5" />
              <span>已授权 · Authorized</span>
            </div>
          ) : (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onApprove}
                className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                <Ico icon="lucide:plug-zap" className="h-3.5 w-3.5" />
                <span>授权 · Authorize</span>
              </button>
              <button
                type="button"
                onClick={onReject}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <Ico icon="lucide:x" className="h-3.5 w-3.5" />
                <span>取消 · Cancel</span>
              </button>
            </div>
          )}
        </div>
      );
    }

    // 12) chart — a data-visualization step (header; chart appended below via StepChart)
    case "chart":
      return (
        <ActionRow
          icon={step.icon ?? "lucide:bar-chart-3"}
          title={step.title ?? step.chart?.label ?? "数据可视化 · Data visualization"}
          coord={step.coord}
          phase={phase}
          durationMs={step.durationMs}
          reduced={reduced}
        >
          {step.connector ? <Chip icon="lucide:plug" label={step.connector} /> : null}
        </ActionRow>
      );

    // 13) answer — final answer block with (pluggable) markdown; chart appended below
    case "answer":
      return (
        <div className="rounded-xl border border-border bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-2.5 flex items-start justify-between gap-2 border-b border-border pb-2 dark:border-neutral-800">
            <div className="flex items-center gap-2">
              <Ico icon="lucide:sparkles" className="h-4 w-4 text-brand" />
              <span className="text-sm font-semibold text-foreground dark:text-neutral-100">
                {step.title}
              </span>
            </div>
            {step.coord ? <CoordBadge coord={step.coord} /> : null}
          </div>
          <div className="overflow-x-auto">
            {markdownRenderer ? (
              markdownRenderer(step.text ?? "")
            ) : (
              <DefaultMarkdown text={step.text ?? ""} />
            )}
          </div>
        </div>
      );

    default:
      return null;
  }
}

// ── Per-step renderer — body + (any) chart appended below ─────────────────────
function StepView({
  step,
  phase,
  reduced,
  onApprove,
  onReject,
  chartRenderer,
  markdownRenderer,
}: {
  step: ChainStep;
  phase: Phase;
  reduced: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  chartRenderer?: (chart: ChartData) => ReactNode;
  markdownRenderer?: (text: string) => ReactNode;
}): ReactElement {
  return (
    <>
      <StepBody
        step={step}
        phase={phase}
        reduced={reduced}
        onApprove={onApprove}
        onReject={onReject}
        markdownRenderer={markdownRenderer}
      />
      {step.chart ? <StepChart step={step} chartRenderer={chartRenderer} /> : null}
    </>
  );
}

// ── Public: the full left-column stream ──────────────────────────────────────
export function ReasoningActionChain({
  run,
  revealed,
  activeIndex,
  onApprove,
  onReject,
  chartRenderer,
  markdownRenderer,
}: {
  run: AgenticRun;
  revealed?: number;
  activeIndex?: number;
  onApprove?: () => void;
  onReject?: () => void;
  chartRenderer?: (chart: ChartData) => ReactNode;
  markdownRenderer?: (text: string) => ReactNode;
}): ReactElement {
  const reduced = usePrefersReducedMotion();
  const visible = run.steps.slice(0, revealed ?? run.steps.length);

  // A step is "active" only when the shell supplies a live pointer that lands
  // inside the currently-visible window. Otherwise the run is settled.
  const hasActive =
    typeof activeIndex === "number" && activeIndex >= 0 && activeIndex < visible.length;

  const phaseOf = (i: number): Phase => {
    if (!hasActive) return "settled";
    if (i === activeIndex) return "active";
    return "done";
  };

  return (
    <div className="space-y-4">
      {/* 1) Query bubble + pill row */}
      <div className="space-y-2">
        {run.skills.length || run.connectors.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {run.skills.map((s, i) => (
              <Chip
                key={`sk-${i}`}
                icon={i % 2 === 0 ? "lucide:sparkles" : "lucide:layers"}
                label={s}
              />
            ))}
            {run.connectors.map((c, i) => (
              <Chip key={`co-${i}`} icon="lucide:plug" label={c} />
            ))}
          </div>
        ) : null}
        {run.query ? (
          <div className="rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed text-foreground dark:bg-neutral-800/60 dark:text-neutral-100">
            {run.query}
          </div>
        ) : null}
      </div>

      {/* 2) steps-done collapsible-looking header */}
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground dark:text-neutral-400">
        <span>{run.stepsDoneLabel}</span>
        <Ico icon="lucide:chevron-down" className="h-3.5 w-3.5" />
      </div>

      {/* 3) The reasoning + action stream */}
      <div className="space-y-3">
        {visible.map((step, i) => {
          const phase = phaseOf(i);
          const active = phase === "active";
          return (
            <div
              key={step.id}
              aria-live={active ? "polite" : undefined}
              aria-busy={active ? true : undefined}
              className={cn(
                active &&
                  "-mx-2 rounded-lg bg-brand/[0.04] px-2 py-1.5 ring-1 ring-brand/10 dark:bg-brand/10 dark:ring-brand/20",
                active && !reduced && "animate-fade-in",
              )}
            >
              <StepView
                step={step}
                phase={phase}
                reduced={reduced}
                onApprove={onApprove}
                onReject={onReject}
                chartRenderer={chartRenderer}
                markdownRenderer={markdownRenderer}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
