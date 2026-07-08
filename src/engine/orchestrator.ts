// ─────────────────────────────────────────────────────────────────────────────
// agentic-orchestrator.ts — GENERIC server-side agentic orchestrator (async
// generator). Drives the "Reasoning + Action Trace" UI over the SHARED wire
// contract (ChainStep). Brand-agnostic: it knows NOTHING about any project's
// intents / data / connectors — everything project-specific flows through the
// injected `AgenticAdapter`.
//
//   • Token=0 by default: the tool selection + data fetch is deterministic
//     (adapter.matchTools + tool.run()); no LLM is required.
//   • LLM ONLY via `adapter.llm` and ONLY when `configured()` is true — used to
//     decorate the Master narrative + synthesize the answer. It degrades to fully
//     deterministic Token=0 when unconfigured or on runtime error.
//
// 5-coord state machine: master (reasoning + fan-out) → harness (results per
// tool) → a2a (handoff) → hitl (conditional gate) → loop (progress + answer).
//
// Honesty: when no LLM is configured, Master/answer strings say Token=0/无 LLM;
// the connector-authorization gate is a DEMO gate (no real external write unless
// the project's adapter wires a real OAuth flow); the HITL gate blocks the
// "execute" branch on high-risk goals (read-only answers are always safe).
//
// §0: any gateway key is read INSIDE the project's `adapter.llm` impl from env,
// never here. No Date.now() at module scope — elapsed is measured at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ChainStep,
  ChainChild,
  ChartData,
  RunError,
  RunMetrics,
  MemoryInfo,
} from "../types/chain-data";
import type { AgenticAdapter } from "./adapter";

// ── Wire contract (pinned — the streaming client depends on this) ────────────
// UI-suite alignment (ChatBot UI.md §2.3): meta/done/error gain OPTIONAL fields
// (planner / metrics / memory / structured error). Existing consumers that ignore
// them are unaffected — every added field is optional and absent by default.
// ⚠ Keep this shape in SYNC with the duplicate WireEvent in `use-agentic-run.ts`.
export type WireEvent =
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
  | { t: "hitl"; step: ChainStep } // gate reached; generator returns after this UNLESS input.approved
  | { t: "error"; message: string; error?: RunError } // §2.3 ErrorState (optional structured)
  | { t: "done"; usage: string; steps: number; metrics?: RunMetrics; memory?: MemoryInfo };

// ── Input ────────────────────────────────────────────────────────────────────
export interface AgenticInput {
  question: string;
  model?: string;
  approved?: boolean;
}

interface Collected {
  id: string;
  label: string;
  summary: string;
  rows?: Record<string, unknown>[];
  chart?: ChartData;
}

// ── Banned-tool scrub (safety net — applied to every emitted string) ──────────
// GENERIC: only the banned-tool rule (n8n → harness). Brand-scrubbing is NOT the
// engine's job — the adapter owns its own strings (a project that needs to strip
// its brand word does so inside its adapter). No hardcoded brand here (§11).
function scrub(s: unknown): string {
  return String(s ?? "").replace(/\bn8n\b/gi, "harness");
}

// ── Headline extractor for the answer step title ─────────────────────────────
function headline(md: string): string {
  const line =
    md
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "运营应答";
  return line.replace(/^#+\s*/, "").replace(/\*\*/g, "").slice(0, 80);
}

// ── High-risk verb detector (triggers the HITL gate — safety) ─────────────────
const RISK_RE =
  /(发布|publish|发送|send|下单|purchase|付款|pay|改价|price|删除|delete|授权|grant|外发|export|上线|deploy)/i;

// ── Deterministic per-step duration (200–1400ms) from a title/seed string ─────
// Pure · no Math.random / Date.now — safe at module scope.
function hashDuration(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return 200 + (h % 1200);
}

// ── Fixed non-tool phases the master plans (master reasoning + fanout + handoff
// + progress + answer) — feeds PlannerInfo.totalSteps + metrics.plannerSteps. ──
const FIXED_PHASES = 5;

// ── Best-effort error classifier → structured RunError (§2.3 ErrorState) ──────
// Maps a thrown error to a coarse type + a sensible recovery/needsUser hint. This
// is a heuristic (keyword-based), never a fabricated claim — the message is real.
function classifyError(e: unknown): RunError {
  const message = scrub(e instanceof Error ? e.message : String(e ?? "run failed"));
  const lower = message.toLowerCase();
  let type: RunError["type"] = "unknown";
  if (/permission|forbidden|denied|unauthor|401|403/.test(lower)) type = "permission";
  else if (/network|fetch|timeout|econn|socket|dns|offline/.test(lower)) type = "network";
  else if (/llm|gateway|model|token|completion|prompt|rate.?limit|429/.test(lower)) type = "llm";
  else if (/tool|adapter|snapshot|load|run/.test(lower)) type = "tool";
  return {
    type,
    message,
    recovery: type === "permission" ? "abort" : "retry",
    needsUser: type === "permission",
  };
}

// ── Public entry ─────────────────────────────────────────────────────────────
// Thin async-generator wrapper over the core state machine: any UNEXPECTED throw
// surfaces as a structured {t:"error"} event (§2.3 ErrorState) with a best-effort
// message + RunError, instead of rejecting the stream. Signature is unchanged so
// existing routes importing `runAgentic` are unaffected.
export async function* runAgentic(
  input: AgenticInput,
  adapter: AgenticAdapter,
): AsyncGenerator<WireEvent, void, unknown> {
  try {
    yield* runAgenticCore(input, adapter);
  } catch (e) {
    yield {
      t: "error",
      message: scrub(e instanceof Error ? e.message : "run failed"),
      error: classifyError(e),
    };
  }
}

// ── The orchestrator (core state machine) ────────────────────────────────────
async function* runAgenticCore(
  input: AgenticInput,
  adapter: AgenticAdapter,
): AsyncGenerator<WireEvent, void, unknown> {
  const startMs = Date.now();
  const question = scrub(input.question).trim();

  const llmApi = adapter.llm;
  const llm = llmApi?.configured() ?? false;
  // The composer's model picker may send UI tier ids ("auto", "gpt-x", "gemini-x")
  // that are NOT valid gateway model ids. Only honor an explicit Claude-family id;
  // otherwise fall back to the adapter's configured fallbackModel.
  const rawModel = (input.model && String(input.model).trim()) || "";
  const resolvedModel = /claude|opus|sonnet|haiku|fable/i.test(rawModel)
    ? rawModel
    : llmApi?.fallbackModel ?? "Token=0 deterministic";
  const modelLabel = llm ? resolvedModel : "Token=0 deterministic";

  let sid = 0;
  const nextId = () => `s${String(++sid).padStart(2, "0")}`;
  let stepCount = 0;

  // ── Metrics accumulators (§2.3 MetricsState) ────────────────────────────────
  let toolCalls = 0; // number of tool.run() invocations (attempts, success or fail)
  let plannedTotal = 0; // matched tools + FIXED_PHASES (set after matchTools)
  let promptTokens = 0; // accumulated ONLY when a gateway call returns usage
  let completionTokens = 0;
  let sawUsage = false; // stays false on the Token=0 path → tokens omitted (honest 0)
  const buildMetrics = (): RunMetrics => {
    const m: RunMetrics = { toolCalls, traceNodes: stepCount };
    if (plannedTotal > 0) m.plannerSteps = plannedTotal;
    // Only surface token counts when the LLM path actually reported usage; on the
    // Token=0 path these stay omitted so the sidebar honestly shows 0.
    if (sawUsage) {
      m.promptTokens = promptTokens;
      m.completionTokens = completionTokens;
    }
    return m;
  };
  // Short input-params summary for a tool step (§2.2 ActionChainView `input`).
  const toolInput = (label: string) =>
    scrub(`query: "${question.slice(0, 48)}" · tool: ${label}`);

  // ── 0. Connector-auth gate (from adapter.detectConnector) ───────────────────
  // If the goal references an EXTERNAL connector (Gmail / Slack / …), pause the
  // stream at an authorization gate until approved. DEMO gate: no real external
  // connection is made unless the project's adapter wires a real OAuth flow — the
  // honest note + true-intent scopes say so. On the approved re-run we fall
  // through to the normal tool path but mark data steps external.
  const connectorHit = adapter.detectConnector?.(question) ?? null;
  if (connectorHit && input.approved !== true) {
    yield {
      t: "meta",
      query: question,
      skills: ["Master Orchestration"],
      connectors: [connectorHit.connectorLabel],
      model: modelLabel,
      llm,
      planner: { goal: question }, // totalSteps unknown until tools matched
    };
    stepCount += 1;
    yield {
      t: "step",
      step: {
        id: nextId(),
        kind: "reasoning",
        coord: "master",
        icon: "lucide:git-branch-plus",
        title: "识别到需接入外部连接器",
        text: scrub(
          `识别到需接入外部连接器「${connectorHit.connectorLabel}」· 外部数据源需先授权后再获取。` +
            "本次为演示授权(demo)· 不建立真实连接。请确认授权以继续。",
        ),
      },
    };
    const gateStep: ChainStep = {
      id: nextId(),
      kind: "connector-auth",
      coord: "hitl",
      icon: connectorHit.icon,
      title: scrub(`连接器授权 · ${connectorHit.connectorLabel}`),
      connectorAuth: {
        connectorId: connectorHit.connectorId,
        connectorLabel: connectorHit.connectorLabel,
        icon: connectorHit.icon,
        scopes: connectorHit.scopes,
        note: connectorHit.note ?? "演示授权 · 不建立真实连接",
      },
    };
    stepCount += 1;
    yield { t: "hitl", step: gateStep };
    yield {
      t: "done",
      usage: `等待连接器授权 · ${((Date.now() - startMs) / 1000).toFixed(1)}s`,
      steps: stepCount,
      metrics: buildMetrics(),
    };
    return;
  }
  // Approved re-run of a connector-gated goal → external-data mode.
  const externalMode = connectorHit !== null && input.approved === true;
  const dataOrigin: "local" | "external" = externalMode ? "external" : "local";

  // ── 1. matchTools + meta ────────────────────────────────────────────────────
  // The adapter decides which tools fire (the fan-out). `connectors` advertises
  // the tools the harness will actually touch (deduped by label).
  const tools = adapter.matchTools(question);
  plannedTotal = tools.length + FIXED_PHASES; // matched tools + fixed non-tool phases
  const touchedLabels = [...new Set(tools.map((t) => t.label))];
  const connectors = externalMode
    ? [...new Set([...touchedLabels, connectorHit!.connectorLabel])]
    : touchedLabels;
  yield {
    t: "meta",
    query: question,
    skills: ["Master Orchestration", "Outcome Loop"],
    connectors,
    model: modelLabel,
    llm,
    planner: { goal: question, totalSteps: plannedTotal },
  };

  // Approved connector-auth re-run → announce the (demo) authorization first.
  if (externalMode) {
    stepCount += 1;
    yield {
      t: "step",
      step: {
        id: nextId(),
        kind: "reasoning",
        coord: "master",
        icon: "lucide:plug-zap",
        title: "连接器已授权(演示)",
        text: scrub(
          `连接器已授权(演示)· 继续获取数据。外部连接器「${connectorHit!.connectorLabel}」` +
            "为演示授权,不建立真实连接。",
        ),
        dataSource: "external",
      },
    };
  }

  // ── 2. Master · 目标理解 + 拆解 (coord "master") ────────────────────────────
  let masterText: string;
  if (llm && llmApi) {
    try {
      const out = await llmApi.chat({
        model: resolvedModel,
        system:
          "你是企业 Agentic 编排器的 Master Orchestrator。将用户目标:(1) 用一句话复述目标;" +
          "(2) 拆解为 2–4 个可执行子任务。使用简体中文叙述,业务术语/指标/字段保留英文。" +
          "输出格式:第一行以「目标:」开头写一句话;随后每行一个子任务,以「- 」开头。不要多余解释。",
        user: question,
        maxTokens: 300,
        temperature: 0,
      });
      masterText = scrub(out.text) || `理解目标:「${question}」。`;
      if (out.usage) {
        sawUsage = true;
        promptTokens += out.usage.promptTokens ?? 0;
        completionTokens += out.usage.completionTokens ?? 0;
      }
    } catch {
      // LLM configured but the call failed at runtime — degrade honestly.
      masterText = `LLM 调用未成功,回退 Token=0 确定性拆解。理解目标:「${question}」。`;
    }
  } else {
    masterText = `理解目标:「${question}」。Token=0 无 LLM · 按关键词确定性拆解为子任务。`;
  }

  stepCount += 1;
  yield {
    t: "step",
    step: {
      id: nextId(),
      kind: "reasoning",
      coord: "master",
      icon: "lucide:git-branch-plus",
      title: "目标理解 + 任务拆解",
      text: masterText,
    },
  };

  const fanoutChildren: ChainChild[] = tools.length
    ? tools.map((t) => ({ label: scrub(t.label), status: "queued" }))
    : [{ label: `语义检索:「${question.slice(0, 40)}」`, status: "queued" }];
  stepCount += 1;
  yield {
    t: "step",
    step: {
      id: nextId(),
      kind: "fanout",
      coord: "master",
      icon: "lucide:git-fork",
      title: "任务拆解 · fan-out",
      children: fanoutChildren,
    },
  };

  // ── 3. Harness · 每个 tool 执行 (coord "harness", Token=0 deterministic) ─────
  const collected: Collected[] = [];
  for (const tool of tools) {
    toolCalls += 1; // every tool.run() attempt counts toward metrics.toolCalls
    let res: Awaited<ReturnType<typeof tool.run>>;
    try {
      res = await tool.run();
    } catch (e) {
      // A single tool throwing must NOT abort the whole run — emit a failed step
      // (status:"failed", note = error message) and continue with remaining tools.
      stepCount += 1;
      yield {
        t: "step",
        step: {
          id: nextId(),
          kind: "action",
          coord: "harness",
          icon: "lucide:alert-triangle",
          title: scrub(`${tool.label} · 执行失败`),
          note: scrub(e instanceof Error ? e.message : "tool run failed"),
          durationMs: hashDuration(tool.label),
          dataSource: tool.source === "external" ? "external" : dataOrigin,
          input: toolInput(tool.label),
          status: "failed",
        },
      };
      continue;
    }
    const summary = scrub(res.summary);
    const snippet = summary.replace(/\s+/g, " ").trim().slice(0, 120);
    collected.push({
      id: tool.id,
      label: tool.label,
      summary,
      rows: res.rows,
      chart: res.chart,
    });
    stepCount += 1;
    yield {
      t: "step",
      step: {
        id: nextId(),
        kind: "results",
        coord: "harness",
        icon: "lucide:cpu",
        title: scrub(tool.label),
        connector: scrub(tool.label),
        sources:
          res.sources ??
          [{ title: snippet || "Token=0 检索", source: scrub(tool.label), premium: false }],
        note: snippet,
        durationMs: hashDuration(tool.label),
        dataSource: tool.source === "external" ? "external" : dataOrigin,
        input: toolInput(tool.label),
        status: "success",
      },
    };
  }

  // ── 4. A2A · 接力 (coord "a2a") ─────────────────────────────────────────────
  stepCount += 1;
  yield {
    t: "step",
    step: {
      id: nextId(),
      kind: "handoff",
      coord: "a2a",
      icon: "lucide:arrow-right-left",
      title: "汇聚上游结果 → 交付合成",
      fromAgent: "Master Agent",
      toAgent: "Synthesis Agent",
    },
  };

  // ── 5. HITL · 人审 (coord "hitl", CONDITIONAL) ──────────────────────────────
  // No real risky/irreversible write is EVER performed here regardless of
  // approval — this gate honestly blocks the "execute" branch; the answer below
  // is read-only. Approval only lets the stream continue.
  if (RISK_RE.test(question)) {
    const gateStep: ChainStep = {
      id: nextId(),
      kind: "hitl",
      coord: "hitl",
      icon: "lucide:user-check",
      title: "人审门 · 高风险/不可逆动作",
      gate: {
        risk: "HIGH",
        question: "检测到高风险/不可逆动作,是否放行执行?",
      },
    };
    stepCount += 1;
    yield { t: "hitl", step: gateStep };
    if (input.approved !== true) {
      // Stream ends awaiting approval — nothing was executed.
      yield {
        t: "done",
        usage: `实时运行 · ${((Date.now() - startMs) / 1000).toFixed(1)}s`,
        steps: stepCount,
        metrics: buildMetrics(),
      };
      return;
    }
    // Approved → continue (still no destructive action; answer is read-only).
  }

  // ── 6. Loop · 验收/收尾 (coord "loop") ──────────────────────────────────────
  const progressChildren: ChainChild[] = (
    collected.length ? collected.map((c) => c.label) : ["语义检索"]
  )
    .map<ChainChild>((label) => ({ label: scrub(label), status: "done" }))
    .concat([{ label: "汇总输出", status: "done" }]);
  stepCount += 1;
  yield {
    t: "step",
    step: {
      id: nextId(),
      kind: "progress",
      coord: "loop",
      icon: "lucide:list-checks",
      title: "验收 · 收尾",
      children: progressChildren,
    },
  };

  // ── 7. Master/Loop · 汇聚 → answer (coord "loop") ───────────────────────────
  let answerText: string;
  let answerTitle: string;
  let answerChart: ChartData | undefined;

  if (collected.length > 0 && adapter.synthesize) {
    // Adapter-owned synthesis takes precedence (it decides Token=0 vs LLM inside).
    const out = adapter.synthesize(
      question,
      collected.map((c) => ({
        id: c.id,
        label: c.label,
        summary: c.summary,
        rows: c.rows,
        chart: c.chart,
      })),
    );
    answerText = scrub(out.markdown) || scrub(collected[0].summary);
    answerTitle = scrub(out.title) || headline(answerText);
    answerChart = out.chart ?? collected[0].chart;
  } else if (collected.length > 0 && llm && llmApi) {
    try {
      const userMsg =
        `目标:${question}\n\n检索到的真实数据结果(禁止编造未出现的数字):\n` +
        collected
          .map((c, i) => `### ${i + 1}. ${c.label}\n${c.summary}`)
          .join("\n\n");
      const out = await llmApi.chat({
        model: resolvedModel,
        system:
          "你是企业编排器的 Synthesis Agent。基于下方真实数据检索结果,产出简洁 Markdown 应答:" +
          "(1) 一句话复述目标;(2) 3–6 条要点发现;(3) 一条简短的下一步建议。" +
          "使用简体中文叙述,业务术语/指标/字段保留英文。严禁编造未在结果中出现的数字或来源。",
        user: userMsg,
        maxTokens: 700,
        temperature: 0.2,
      });
      answerText = scrub(out.text) || scrub(collected[0].summary);
      if (out.usage) {
        sawUsage = true;
        promptTokens += out.usage.promptTokens ?? 0;
        completionTokens += out.usage.completionTokens ?? 0;
      }
    } catch {
      answerText = scrub(collected[0].summary);
    }
    answerTitle = headline(answerText);
    answerChart = collected[0].chart;
  } else if (collected.length > 0) {
    // Token=0: render the best-matched tool's full deterministic summary.
    answerText = scrub(collected[0].summary);
    answerTitle = headline(answerText);
    answerChart = collected[0].chart;
  } else {
    // Nothing matched — honest fallback (no fabricated data).
    answerText =
      "未匹配到直接意图/工具。请补充更具体的目标或关键词。" +
      (llm ? "" : "\n\n*(Token=0 无 LLM · 确定性路径未命中任何已注册工具)*");
    answerTitle = "未匹配到直接意图 · 建议补充";
  }

  stepCount += 1;
  yield {
    t: "step",
    step: {
      id: nextId(),
      kind: "answer",
      coord: "loop",
      icon: "lucide:repeat",
      title: answerTitle,
      text: answerText,
      durationMs: hashDuration(answerTitle),
      dataSource: collected.length > 0 ? dataOrigin : "local",
      chart: answerChart,
    },
  };

  // ── 8. Memory writeback (optional · adapter-provided · §2.3 MemoryState) ─────
  // If the project's adapter supplies a memory model, capture this run's rolling
  // context summary / long-term KB refs / facts written back. Best-effort: any
  // failure is swallowed so it never breaks the run. Absent adapter.memory →
  // runMemory stays undefined and the sidebar shows an honest empty state.
  let runMemory: MemoryInfo | undefined;
  if (adapter.memory) {
    try {
      runMemory = await adapter.memory(
        question,
        collected.map((c) => ({
          id: c.id,
          label: c.label,
          summary: c.summary,
          rows: c.rows,
          chart: c.chart,
        })),
      );
    } catch {
      runMemory = undefined; // memory is best-effort; never fails the run
    }
  }

  // ── 9. done ─────────────────────────────────────────────────────────────────
  yield {
    t: "done",
    usage: `实时运行 · ${((Date.now() - startMs) / 1000).toFixed(1)}s`,
    steps: stepCount,
    metrics: buildMetrics(),
    memory: runMemory,
  };
}
