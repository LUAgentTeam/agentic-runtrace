// @leapunion/agentic-runtrace — CLIENT UI + shared types (subpath ".")
// ─────────────────────────────────────────────────────────────────────────────
// 🟧 SKELETON (Phase B step 1 · ADR-0004). Component/type source moves here from
// the `agentic-runtrace-chatbot` skill `templates/` in B-2 (see MANIFEST.md §1).
// This subpath is CLIENT-ONLY — it must NOT pull the Node engine (fs/path). The
// server engine lives at "@leapunion/agentic-runtrace/engine".
// B-2 = uncomment the re-exports once src/components + src/hooks + src/types land.
// ─────────────────────────────────────────────────────────────────────────────

export const PACKAGE = "@leapunion/agentic-runtrace";
export const VERSION = "0.1.0";

// ── B-2 public API (activated on move) ───────────────────────────────────────
export { AgenticChatbot } from "./components/agentic-chatbot";
export { AgenticRunTrace } from "./components/agentic-run-trace";
export {
  ReasoningActionChain,
  CoordBadge,
  DefaultMarkdown,
  DefaultChartFallback,
} from "./components/reasoning-action-chain";
export { useAgenticRun } from "./hooks/use-agentic-run";
export { COORD_LEGEND } from "./types/chain-data";
export type {
  AgenticRun, ChainStep, ChainChild, ChainSource, Coord, StepKind,
  ConnectorAuth, ChartData, DataSource, DataMode,
  PlannerInfo, MemoryInfo, RunError, RunMetrics, AgenticUIConfig,
} from "./types/chain-data";
