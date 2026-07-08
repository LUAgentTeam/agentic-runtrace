// @leapunion/agentic-runtrace/engine — SERVER engine core (subpath "./engine")
// ─────────────────────────────────────────────────────────────────────────────
// 🟧 SKELETON (Phase B step 1 · ADR-0004). `runAgentic` + the Adapter contract
// move here from the skill `templates/agentic-orchestrator.ts` +
// `agentic-adapter.ts` in B-2 (MANIFEST.md §1). SERVER-ONLY (uses Node fs/path).
// A project's API route imports `runAgentic` from here and injects its own
// Adapter — the ONLY brand-specific code (tools/data/keys stay in the project,
// §0/§11). The engine is Token=0 (LLM only via adapter.llm) — it is NOT a
// microservice (ADR-0004 rejects that): it runs in-process in the project's
// serverless function, next to the data.
// B-2 = uncomment once src/engine/{orchestrator,adapter}.ts land.
// ─────────────────────────────────────────────────────────────────────────────

export const ENGINE = "@leapunion/agentic-runtrace/engine";

// ── B-2 public API (activated on move) ───────────────────────────────────────
// Note: WireEvent + AgenticInput are declared in ./orchestrator (the wire
// contract + input), while the Adapter contract types live in ./adapter.
export { runAgentic } from "./orchestrator";
export { createLocalSnapshotAdapter } from "./adapter";
export type { WireEvent, AgenticInput } from "./orchestrator";
export type { AgenticAdapter, ToolMatch, AdapterLLM } from "./adapter";
