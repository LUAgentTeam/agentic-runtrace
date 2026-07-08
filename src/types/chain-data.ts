// ───────────────────────────────────────────────────────────────────────────
// agentic-chain-data.ts — Agentic Run-Trace ChatBot 的共享数据契约(wire contract)
// (Token=0 · 纯数据 · zero React · brand-agnostic 通用模板)
//
// 这是「推理链 + 行动链」运行轨迹 UI 的数据模型(reasoning + action chain):
// 左侧 reasoning/action 流 + 右侧 progress / artifacts / sources 状态栏。
// NO live external calls · 无 Date.now / 无 Math.random(模块级全静态)。
//
// 架构表达(核心):每个 ACTION 携带 coord 字段,标注驱动它的协同机制——
// master 主控编排 / a2a Agent 接力 / harness 确定性执行 / loop 外层成果环 / hitl 人审。
// 纯 reasoning 叙述(仅旁白)可省略 coord。
//
// De-brand(红线):渲染文本零品牌词。双语:中文叙述 + 英文业务/工具术语
// (connector / skill / model / metric 保持英文)。诚实红线:数值来自项目 Adapter
// 的真实 data 或标 illustrative,非实时抓取。
//
// ⚠ 本文件是「引擎模板」的一部分:类型是通用契约,任何项目的 Adapter 都据此产出
// ChainStep。此处 NO 项目数据 —— 项目专属的 tools / data / seed 全走 Adapter。
// ───────────────────────────────────────────────────────────────────────────

// ── Coordination legend ─────────────────────────────────────────────────────

export type Coord = "master" | "a2a" | "harness" | "loop" | "hitl";

export interface CoordMode {
  id: Coord;
  label: string; // 中文短标
  en: string; // English name
  desc: string; // 一句话解释该协同机制
  icon: string; // iconify (lucide:*)
  color: string; // tailwind hue token stem: indigo / teal / slate / amber / rose
}

/** 5 种协同机制 —— 渲染为 badge,即「谁在驱动这一步」的架构答案。 */
export const COORD_LEGEND: CoordMode[] = [
  {
    id: "master",
    label: "主控编排",
    en: "Master Orchestration",
    desc: "Master-Agent 拥有北极星 + DAG:目标理解、任务拆解、fan-out 调度、汇聚、重规划。",
    icon: "lucide:git-branch-plus",
    color: "indigo",
  },
  {
    id: "a2a",
    label: "Agent 接力",
    en: "Agent-to-Agent handoff",
    desc: "上游 Agent 完成即 handoff 输出+上下文给下游 Agent 接力,不回主控;用于有依赖的顺序步骤。",
    icon: "lucide:arrow-right-left",
    color: "teal",
  },
  {
    id: "harness",
    label: "Harness 自动",
    en: "Harness (deterministic)",
    desc: "确定性 harness(Token=0 · 无 LLM)执行工具/连接器调用、限流退避、串并行调度、重试、读文件。",
    icon: "lucide:cpu",
    color: "slate",
  },
  {
    id: "loop",
    label: "Loop 自动",
    en: "Outcome Loop",
    desc: "外层 Perceive→Decide→Execute→Outcome 环:更新进度、验收、收尾,直到 DoD 达成。",
    icon: "lucide:repeat",
    color: "amber",
  },
  {
    id: "hitl",
    label: "人审",
    en: "Human-in-the-loop",
    desc: "高风险/不可逆动作(发布、花钱、外发、改价)前暂停,等人审通过再继续。",
    icon: "lucide:user-check",
    color: "rose",
  },
];

// ── Chain step model ────────────────────────────────────────────────────────

export type StepKind =
  | "reasoning"
  | "action"
  | "fanout"
  | "results"
  | "progress"
  | "artifact"
  | "read"
  | "wait"
  | "handoff"
  | "hitl"
  | "connector-auth" // external connector authorization gate (Gmail-style)
  | "chart" // a data-visualization step (renders SmartChart from `chart` rows)
  | "answer";

// ── Task-nature primitives (live trace 2.0) ──────────────────────────────────
// Where a step's data comes from — drives the right-panel「数据来源」+ whether an
// authorization gate is needed. `local` = snapshot / Token=0, no external call,
// no auth. `external` = an outside connector (needs a human authorization gate).
export type DataSource = "local" | "external";

// Run-level data mode — derived CLIENT-side from the steps' dataSource.
export type DataMode = "local" | "external" | "mixed";

// Connector-authorization gate payload (for kind === "connector-auth"). Mirrors
// a real OAuth consent screen but is a DEMO gate: unless the project's Adapter
// wires a real OAuth flow, this makes NO real external connection — `note` states
// this honestly (§12 pre-authorization safety).
export interface ConnectorAuth {
  connectorId: string; // "gmail"
  connectorLabel: string; // "Gmail"
  icon: string; // iconify (logos:* / lucide:*)
  scopes: string[]; // what it would access (真实意图描述)
  note?: string; // honesty line, e.g. "演示授权 · 不建立真实连接"
}

// Chart payload — raw structured rows + hints. The CLIENT builds the ChartPick
// (deriveSpec → pickChart → SmartChart, ECharts is client-only) and renders it.
// Rows are capped (≤12) and come from the Adapter's REAL data (Token=0).
export interface ChartData {
  rows: Record<string, unknown>[];
  dataKey?: string; // numeric value key
  nameKey?: string; // category / name key (bar / pie)
  xKey?: string; // x-axis key (line / time)
  preferred?: "bar" | "line" | "pie" | "auto";
  label?: string; // caption
}

export interface ChainChild {
  label: string;
  tool?: string;
  status?: "done" | "running" | "queued" | "failed";
  link?: boolean;
}

export interface ChainSource {
  title: string;
  source: string;
  premium?: boolean;
}

export interface ChainStep {
  id: string;
  kind: StepKind;
  coord?: Coord; // omit for pure reasoning narration; set on actions
  icon?: string; // iconify (lucide:* / flat-color-icons:*)
  title?: string; // action/step title
  text?: string; // reasoning narrative, or the final answer markdown
  agent?: string; // owning agent label
  connector?: string; // connector / data store used (project-defined via Adapter)
  skill?: string; // skill loaded (project-defined via Adapter)
  children?: ChainChild[]; // fan-out sub-calls / checklist items
  sources?: ChainSource[]; // results list with source badges
  note?: string; // e.g. rate-limit note
  fromAgent?: string; // for handoff
  toAgent?: string; // for handoff
  gate?: { risk: "HIGH" | "MID" | "LOW"; question: string }; // for hitl
  artifact?: { name: string; sub: string; model?: string }; // for artifact card
  // ── live trace 2.0 (all optional · backward-compatible · WireEvent unchanged) ─
  durationMs?: number; // real per-step timing (from the engine) → "· 0.4s"
  dataSource?: DataSource; // this step's data origin (local snapshot vs external)
  connectorAuth?: ConnectorAuth; // for kind === "connector-auth"
  chart?: ChartData; // structured data → client renders <SmartChart>
  // ── UI-suite alignment (ChatBot UI.md §2.2 ActionChainView) ──────────────────
  input?: string; // tool input-params summary (action / results steps)
  status?: "success" | "failed" | "retry"; // action outcome (drives ToolsState)
}

// ── Run-level status modules (ChatBot UI.md §2.3 AgenticSidebar · all optional) ─
// PlannerState — 第几步 / 总步 / 当前 Goal / 是否重规划(Replan).
export interface PlannerInfo {
  goal?: string; // current goal (defaults to run.query)
  stepIndex?: number; // steps executed so far
  totalSteps?: number; // planned total (if known)
  replanned?: boolean; // true if the master re-planned mid-run
}
// MemoryState — 上下文摘要 / 长期记忆引用(KB) / Memory 更新记录.
export interface MemoryInfo {
  contextSummary?: string; // rolling conversation context
  kbRefs?: { label: string; source?: string }[]; // long-term memory / KB refs
  updates?: string[]; // facts written back this run
}
// ErrorState — 结构化错误(类型 / 恢复策略 / 是否需人介入).
export interface RunError {
  type: "llm" | "tool" | "network" | "permission" | "unknown";
  message: string;
  recovery?: "retry" | "degrade" | "skip" | "abort";
  needsUser?: boolean;
}
// MetricsState — 总耗时(usage) + token 用量 + 计数(工具/步/节点).
export interface RunMetrics {
  promptTokens?: number; // LLM path only (gateway usage); Token=0 → 0/omitted
  completionTokens?: number;
  toolCalls?: number;
  plannerSteps?: number;
  traceNodes?: number;
}

export interface AgenticRun {
  query: string;
  skills: string[]; // ["Deep Research","model-council"]
  connectors: string[]; // ["store-a","store-b"]
  stepsDoneLabel: string; // "已完成 12 步骤"
  steps: ChainStep[];
  // ── UI-suite sidebar modules (all optional · derived or engine-provided) ──────
  planner?: PlannerInfo; // §2.3 PlannerState
  memory?: MemoryInfo; // §2.3 MemoryState
  error?: RunError; // §2.3 ErrorState (structured)
  metrics?: RunMetrics; // §2.3 MetricsState (tokens / counts)
}

// ── Pluggable config (ChatBot UI.md §5.2 · host toggles · all default-on-ish) ──
export interface AgenticUIConfig {
  showCoT?: boolean; // 展示完整思维链 (default true)
  showToolParams?: boolean; // 展示工具入参摘要 (default true)
  showMemory?: boolean; // 展示 MemoryState 面板 (default true)
  showMetrics?: boolean; // 展示 MetricsState 面板 (default true)
  allowInterrupt?: boolean; // 运行中显示 Stop 按钮 (default true)
  allowReplay?: boolean; // 完成/历史轨迹回放控件 (default true)
  sidebar?: boolean; // 显示右侧状态栏 (default true · 可隐藏)
}

// ── EXAMPLE_RUN — a tiny, brand-agnostic seed for previewing the renderer ─────
// The production shell is LIVE-ONLY (the run is built by the streaming engine +
// project Adapter). This 4-step seed exists ONLY so a project can render the
// ReasoningActionChain / AgenticRunTrace components in isolation (Storybook /
// visual test) before wiring the engine. It touches NO real data.
export const EXAMPLE_RUN: AgenticRun = {
  query: "示例目标 · preview the run-trace renderer",
  skills: ["Master Orchestration", "Outcome Loop"],
  connectors: ["example-store"],
  stepsDoneLabel: "已完成 3 步骤",
  steps: [
    {
      id: "s01",
      kind: "reasoning",
      coord: "master",
      icon: "lucide:git-branch-plus",
      text: "目标理解 + 任务拆解:Token=0 确定性拆解为可执行子任务(preview seed)。",
    },
    {
      id: "s02",
      kind: "fanout",
      coord: "master",
      icon: "lucide:git-fork",
      title: "任务拆解 · fan-out",
      children: [
        { label: "sub-task A", status: "done" },
        { label: "sub-task B", status: "done" },
      ],
    },
    {
      id: "s03",
      kind: "results",
      coord: "harness",
      icon: "lucide:cpu",
      title: "example-store · Token=0 检索",
      connector: "example-store",
      durationMs: 420,
      dataSource: "local",
      sources: [{ title: "example summary snippet", source: "example-store", premium: false }],
    },
    {
      id: "s04",
      kind: "answer",
      coord: "loop",
      icon: "lucide:repeat",
      title: "运营应答(preview)",
      text: "### 示例应答\n\n这是 ReasoningActionChain 渲染预览用的占位应答。真实运行由引擎 + 项目 Adapter 产出。",
      durationMs: 300,
      dataSource: "local",
    },
  ],
};
