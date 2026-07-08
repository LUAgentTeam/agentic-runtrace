"use client";

// ───────────────────────────────────────────────────────────────────────────
// agentic-chatbot.tsx — the progressive-disclosure Agentic ChatBot shell
// (brand-agnostic template · the headline deliverable).
//
// UX (phase machine · phase: "idle" | "running" | "done"):
//   • idle   — render ONLY a centered/embedded composer (input + submit); the
//              run trace is NOT mounted. Nothing awakened until the user asks.
//   • submit — (a) ensure an active chat (createChat if none, else reuse → 续问);
//              (b) record the user turn; (c) RELOCATE the composer to the BOTTOM
//              via a flex-column layout (content = order-first flex-1
//              overflow-y-auto, composer = order-last · smooth transition ·
//              reduced-motion → instant); (d) mount <AgenticRunTrace> in the
//              content area and start the run via useAgenticRun(apiPath).start().
//   • done   — persist the turn (question + answer + the run's `trace` steps +
//              chart) via chatStore.appendTurn; the run collapses into an
//              expandable history turn; composer stays at the bottom; further
//              input = 续问 (same chat · a new turn appends → multi-turn stacks).
//
// Multi-turn history: prior turns render in order (user bubble + that turn's
// collapsed/expandable run trace + answer); the newest run is active below.
// Reopening a chat (different activeChatId) restores ALL turns WITH their saved
// traces (replayable).
//
// Config (ChatBot UI.md §5.2 · optional · ABSENT → all ON · backward-compatible):
// `config` toggles feature visibility — showCoT / showToolParams (honored on the
// history chain here + threaded to <AgenticRunTrace>), allowInterrupt (renders a
// 「停止 · Stop」button while running · agentic.reset() aborts the stream · the
// partial run is DISCARDED — nothing persisted for it), allowReplay (a per-turn
// 「回放 · Replay」that CLIENT-re-reveals the saved trace step-by-step · NO engine
// re-call · deterministic · reduced-motion → instant).
//
// Layout: `grid lg:grid-cols-[1fr_320px]` lives INSIDE <AgenticRunTrace> (the
// right status rail is the trace's own column · mobile 1-col · rail collapsible).
//
// Pluggable: `chartRenderer` / `markdownRenderer` are threaded to the trace +
// history answer blocks (text fallbacks render when absent). `chatStore` is
// injectable (defaults to ./chat-store). `user` is injected (or use
// useCurrentUser from ./chat-store in the host).
//
// Rules: light-first + dark: · every inline <Icon> in its own <span> · reduced-
// motion guards ALL animation + the input-to-bottom transition · aria-live on the
// active run · focus mgmt (composer refocus on reset; gate autofocus lives in the
// trace) · Token=0 (turn ids via a ref counter · no Date.now / Math.random at
// module scope) · bilingual 中文叙述 + English terms · de-brand.
// ───────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";
import { Icon } from "@iconify/react";
import { useAgenticRun } from "../hooks/use-agentic-run";
import { AgenticRunTrace } from "./agentic-run-trace";
import {
  DefaultChartFallback,
  DefaultMarkdown,
  ReasoningActionChain,
} from "./reasoning-action-chain";
import * as defaultChatStore from "../chat-store/store";
import type { ChatMessage, ChatSession, TurnMeta } from "../chat-store/store";
import type { AgenticRun, AgenticUIConfig, ChainStep, ChartData } from "../types/chain-data";

// ── Minimal className joiner (self-contained · no host dep) ───────────────────
type ClassValue = string | false | null | undefined;
function cn(...parts: ClassValue[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

// ── Reduced-motion preference (guards animation + the input-to-bottom move) ──
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

// ── Replay cadence — client re-reveal of a saved trace (Token=0 · no engine) ──
const REPLAY_STEP_MS = 600;

// ── Honor config.showCoT / showToolParams where WE render the chain directly
// (HistoryTurn). Live runs thread `config` to <AgenticRunTrace> instead; this is
// the "else" branch for the chain we own. showCoT=false → drop reasoning (CoT)
// steps; showToolParams=false → strip tool input-param summaries. Absent config
// → unchanged (everything shown). Pure · deterministic · Token=0.
function applyChainConfig(steps: ChainStep[], config?: AgenticUIConfig): ChainStep[] {
  let out = steps;
  if (config?.showCoT === false) out = out.filter((s) => s.kind !== "reasoning");
  if (config?.showToolParams === false) {
    out = out.map((s) => (s.input != null ? { ...s, input: undefined } : s));
  }
  return out;
}

// ── Injectable chat-store surface (structurally matched by ./chat-store) ─────
export interface AgenticChatStore {
  useActiveChatId: () => string | null;
  setActiveChatId: (id: string | null) => void;
  createChat: (user: string, title?: string) => ChatSession;
  getChat: (user: string, chatId: string) => ChatSession | null;
  appendTurn: (
    user: string,
    chatId: string,
    userText: string,
    assistantText: string,
    meta?: TurnMeta,
  ) => void;
}

type Phase = "idle" | "running" | "done";

interface Turn {
  id: string;
  question: string;
  answerText: string;
  trace?: ChainStep[];
  chart?: ChartData;
}

export interface AgenticChatbotProps {
  /** NDJSON streaming route consumed by useAgenticRun (defaults to the hook's own). */
  apiPath?: string;
  /** Logged-in user for per-user persistence. null → runs work, nothing persists. */
  user: string | null;
  /** Injectable persistence (defaults to ./chat-store). */
  chatStore?: AgenticChatStore;
  /** Optional hero / intro shown above the idle composer. */
  welcome?: ReactNode;
  /** Plug in the host's real chart component; a text table renders when absent. */
  chartRenderer?: (chart: ChartData) => ReactNode;
  /** Plug in the host's real markdown renderer; a minimal built-in is the default. */
  markdownRenderer?: (text: string) => ReactNode;
  /**
   * UI feature toggles (ChatBot UI.md §5.2). ABSENT → everything ON (backward-
   * compatible). Threaded to <AgenticRunTrace>; showCoT / showToolParams are also
   * honored on the history chain here; allowInterrupt gates the Stop button while
   * running; allowReplay gates the per-turn Replay control. Defaults: all ON.
   */
  config?: AgenticUIConfig;
  className?: string;
}

// ── Restore: pair a stored message list into rendered turns (trace preserved) ─
function messagesToTurns(messages: ChatMessage[], nextId: () => string): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") {
      const next = messages[i + 1];
      const a = next && next.role === "assistant" ? next : null;
      if (a) i++; // consume the paired answer
      turns.push({
        id: nextId(),
        question: m.text,
        answerText: a?.text ?? "",
        trace: a?.trace,
        chart: a?.chart,
      });
    } else {
      // orphan assistant message (rare) — render standalone
      turns.push({ id: nextId(), question: "", answerText: m.text, trace: m.trace, chart: m.chart });
    }
  }
  return turns;
}

// ── User bubble ──────────────────────────────────────────────────────────────
function UserBubble({ text }: { text: string }): ReactElement {
  return (
    <div className="flex items-start justify-end gap-2">
      <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-brand/10 px-3.5 py-2 text-sm text-foreground dark:bg-brand/15 dark:text-neutral-100">
        {text}
      </div>
      <span className="mt-1 inline-flex shrink-0 text-muted-foreground">
        <Icon icon="lucide:circle-user-round" width={18} height={18} />
      </span>
    </div>
  );
}

// ── A completed turn — user bubble + collapsible trace (+ Replay) + answer ────
function HistoryTurn({
  turn,
  defaultOpen,
  config,
  chartRenderer,
  markdownRenderer,
  reduced,
}: {
  turn: Turn;
  defaultOpen: boolean;
  config?: AgenticUIConfig;
  chartRenderer?: (chart: ChartData) => ReactNode;
  markdownRenderer?: (text: string) => ReactNode;
  reduced: boolean;
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  // Replay cursor over this turn's SAVED trace (null = settled → shows all steps).
  const [replayCount, setReplayCount] = useState<number | null>(null);

  const allowReplay = config?.allowReplay !== false;
  // Honor showCoT / showToolParams on the chain we render directly (see helper).
  const trace = applyChainConfig(turn.trace ?? [], config);
  const answerStep = trace.find((s) => s.kind === "answer") ?? null;
  const chainSteps = trace.filter((s) => s.kind !== "answer");
  const stepCount = chainSteps.length;
  const chainRun: AgenticRun | null = stepCount
    ? {
        query: "",
        skills: [],
        connectors: [],
        stepsDoneLabel: `已完成 ${stepCount} 步骤 · steps`,
        steps: chainSteps,
      }
    : null;
  const answerText = answerStep?.text ?? turn.answerText;

  // ── Replay — a lightweight CLIENT re-run of the reveal cadence over the SAVED
  // trace (NO engine re-call · deterministic · Token=0). `revealed`/`activeIndex`
  // drive ReasoningActionChain's live reveal; reduced-motion → instant (stay full).
  const replaying = replayCount !== null && replayCount < stepCount;
  const revealed = replayCount === null ? undefined : replayCount;
  const activeIndex = replayCount === null ? -1 : replayCount - 1;

  const startReplay = useCallback(() => {
    if (!stepCount) return;
    setOpen(true);
    setReplayCount(reduced ? null : 0); // reduced-motion → stay settled (instant)
  }, [stepCount, reduced]);

  useEffect(() => {
    if (replayCount === null) return;
    if (reduced || replayCount >= stepCount) {
      setReplayCount(null); // finished (or reduced-motion) → settle back to full
      return;
    }
    const id = window.setTimeout(
      () => setReplayCount((c) => (c === null ? null : Math.min(c + 1, stepCount))),
      REPLAY_STEP_MS,
    );
    return () => window.clearTimeout(id);
  }, [replayCount, stepCount, reduced]);

  return (
    <div className="space-y-2">
      {turn.question ? <UserBubble text={turn.question} /> : null}

      {/* collapsible run trace (+ optional Replay) */}
      {chainRun ? (
        <div className="rounded-xl border border-border bg-card">
          <div className="flex items-center gap-1 pr-2">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-brand"
            >
              <span className="inline-flex text-brand">
                <Icon icon="lucide:brain-circuit" width={14} height={14} />
              </span>
              <span>运行轨迹 · Run trace</span>
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {stepCount} 步
              </span>
              <span
                className={cn(
                  "ml-auto inline-flex",
                  !reduced && "transition-transform",
                  open && "rotate-180",
                )}
              >
                <Icon icon="lucide:chevron-down" width={14} height={14} />
              </span>
            </button>
            {allowReplay ? (
              <button
                type="button"
                onClick={startReplay}
                disabled={replaying}
                aria-label="回放运行轨迹 · Replay run trace"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className={cn("inline-flex", replaying && !reduced && "animate-spin")}>
                  <Icon
                    icon={replaying ? "lucide:loader-2" : "lucide:play"}
                    width={12}
                    height={12}
                  />
                </span>
                {replaying ? "回放中 · Replaying" : "回放 · Replay"}
              </button>
            ) : null}
          </div>
          {open ? (
            <div
              className={cn(
                "border-t border-border px-3 py-3",
                !reduced && "motion-safe:animate-fade-in",
              )}
            >
              <ReasoningActionChain
                run={chainRun}
                revealed={revealed}
                activeIndex={activeIndex}
                chartRenderer={chartRenderer}
                markdownRenderer={markdownRenderer}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* answer (always visible even when the trace is collapsed) */}
      {answerText ? (
        <div className="rounded-xl border border-border bg-white p-3.5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-2 flex items-center gap-2 border-b border-border pb-1.5 dark:border-neutral-800">
            <span className="inline-flex text-brand">
              <Icon icon="lucide:sparkles" width={14} height={14} />
            </span>
            <span className="text-xs font-semibold text-foreground dark:text-neutral-100">
              {answerStep?.title ?? "回答 · Answer"}
            </span>
          </div>
          <div className="overflow-x-auto">
            {markdownRenderer ? markdownRenderer(answerText) : <DefaultMarkdown text={answerText} />}
          </div>
          {turn.chart ? (
            <div className="mt-2">
              {chartRenderer ? chartRenderer(turn.chart) : <DefaultChartFallback chart={turn.chart} />}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Composer (controlled · Enter submits · Shift+Enter newline) ──────────────
function ComposerForm({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled: boolean;
  placeholder: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}): ReactElement {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
      className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2 shadow-sm focus-within:border-brand/40"
    >
      <span className="mb-1 inline-flex shrink-0 text-muted-foreground">
        <Icon icon="lucide:sparkles" width={16} height={16} />
      </span>
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit(value);
          }
        }}
        placeholder={placeholder}
        aria-label="Message"
        className="max-h-40 min-h-[24px] min-w-0 flex-1 resize-none bg-transparent py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed dark:text-neutral-100"
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        aria-label="Send"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="inline-flex">
          <Icon icon="lucide:arrow-up" width={15} height={15} />
        </span>
      </button>
    </form>
  );
}

// ── Default welcome (host may override via the `welcome` prop) ───────────────
function DefaultWelcome(): ReactElement {
  return (
    <div className="mb-6 text-center">
      <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
        <span className="inline-flex">
          <Icon icon="lucide:brain-circuit" width={26} height={26} />
        </span>
      </div>
      <h2 className="text-lg font-semibold tracking-tight text-foreground dark:text-neutral-100">
        有什么可以帮你? · How can I help?
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        问一个问题或分派一个任务 —— 我会实时展示思维链与行动链。 · Ask a question or assign a task —
        the reasoning + action trace runs live below.
      </p>
    </div>
  );
}

// ── Run-error panel (with retry / cancel) ────────────────────────────────────
function RunErrorPanel({
  message,
  onRetry,
  onCancel,
}: {
  message: string;
  onRetry: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-red-300 bg-red-50 px-4 py-3 dark:border-red-500/40 dark:bg-red-500/10 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2 text-sm text-red-800 dark:text-red-200">
        <span className="mt-0.5 inline-flex shrink-0 text-red-500">
          <Icon icon="lucide:triangle-alert" width={16} height={16} />
        </span>
        <span className="min-w-0">
          <span className="font-semibold">运行失败 · Run failed</span>
          <span className="ml-1.5 break-words font-normal text-red-700/80 dark:text-red-300/80">
            {message}
          </span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-700"
        >
          <span className="inline-flex">
            <Icon icon="lucide:rotate-ccw" width={13} height={13} />
          </span>
          重试 · Retry
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <span className="inline-flex">
            <Icon icon="lucide:x" width={13} height={13} />
          </span>
          取消 · Cancel
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell
// ─────────────────────────────────────────────────────────────────────────────
export function AgenticChatbot({
  apiPath,
  user,
  chatStore = defaultChatStore,
  welcome,
  chartRenderer,
  markdownRenderer,
  config,
  className,
}: AgenticChatbotProps): ReactElement {
  const reduced = usePrefersReducedMotion();
  const agentic = useAgenticRun(apiPath);
  const activeChatId = chatStore.useActiveChatId();

  // §5.2 toggles — absent config → everything ON (backward-compatible defaults).
  const allowInterrupt = config?.allowInterrupt !== false;

  const [phase, setPhase] = useState<Phase>("idle");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeQuestion, setActiveQuestion] = useState<string | null>(null);

  const chatIdRef = useRef<string | null>(activeChatId);
  const restoredRef = useRef<string | null>(null);
  const finalizedRef = useRef(false);
  const turnSeq = useRef(0);
  const nextTurnId = () => `t${turnSeq.current++}`;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatIdRef.current = activeChatId;
  }, [activeChatId]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "end" });
  }, [reduced]);

  // ── Restore a chat's full multi-turn history when a DIFFERENT chat opens ───
  // restoredRef guards against clobbering the turns we just persisted for a chat
  // created inside this shell.
  useEffect(() => {
    if (!user || !activeChatId) return;
    if (restoredRef.current === activeChatId) return;
    restoredRef.current = activeChatId;
    const chat = chatStore.getChat(user, activeChatId);
    const restored = chat ? messagesToTurns(chat.messages, nextTurnId) : [];
    agentic.reset();
    finalizedRef.current = false;
    setActiveQuestion(null);
    setInput("");
    setTurns(restored);
    setPhase(restored.length ? "done" : "idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, activeChatId]);

  // ── Finalize a completed run → persist turn + move into history ────────────
  // Fires once the stream is done (running false · no open gate · no error) and
  // the live run exists. finalizedRef prevents double-finalize as `run` settles.
  useEffect(() => {
    if (phase !== "running") return;
    if (agentic.running || agentic.awaitingApproval || agentic.error) return;
    const run = agentic.run;
    if (!run) return;
    if (finalizedRef.current) return;
    finalizedRef.current = true;

    const answerStep = [...run.steps].reverse().find((s) => s.kind === "answer") ?? null;
    const answerText = answerStep?.text ?? "";
    const chartStep = answerStep?.chart
      ? answerStep
      : [...run.steps].reverse().find((s) => s.chart);
    const chart = answerStep?.chart ?? chartStep?.chart;
    const q = activeQuestion ?? run.query;

    const turn: Turn = { id: nextTurnId(), question: q, answerText, trace: run.steps, chart };
    setTurns((prev) => [...prev, turn]);

    if (user && chatIdRef.current) {
      chatStore.appendTurn(user, chatIdRef.current, q, answerText, {
        trace: run.steps,
        chart,
        llm: agentic.llm,
        usage: agentic.usage,
      });
    }
    setActiveQuestion(null);
    setPhase("done");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, agentic.running, agentic.awaitingApproval, agentic.error, agentic.run]);

  // Keep the newest content in view as the run streams / turns append.
  useEffect(() => {
    if (phase !== "idle") scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, turns.length, agentic.run?.steps.length]);

  // ── Submit — create-or-reuse chat · relocate composer · start the run ──────
  const submit = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (!q || phase === "running") return;

      if (user) {
        let chatId = chatIdRef.current;
        if (!chatId) {
          const c = chatStore.createChat(user, q.slice(0, 40));
          chatId = c.id;
          chatIdRef.current = chatId;
          restoredRef.current = chatId; // skip the restore effect for this new chat
        }
      }

      finalizedRef.current = false;
      setActiveQuestion(q);
      setInput("");
      setPhase("running");
      void agentic.start(q);
      requestAnimationFrame(scrollToBottom);
    },
    [phase, user, chatStore, agentic, scrollToBottom],
  );

  // ── New chat — reset to idle + createChat (续问 resumes the existing one) ───
  const newChat = useCallback(() => {
    agentic.reset();
    finalizedRef.current = false;
    setTurns([]);
    setActiveQuestion(null);
    setInput("");
    setPhase("idle");
    if (user) {
      const c = chatStore.createChat(user); // "New chat" until the first turn titles it
      chatIdRef.current = c.id;
      restoredRef.current = c.id;
    } else {
      chatIdRef.current = null;
      restoredRef.current = null;
      chatStore.setActiveChatId(null);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [agentic, user, chatStore]);

  // ── Cancel / Stop the in-flight run (gate reject · error dismiss · explicit
  // Stop · G1 §2.1). agentic.reset() aborts the stream; the partial run is
  // DISCARDED — nothing persisted for it (finalize only fires while running, and
  // phase now falls back to done/idle). Honest: a stopped run leaves no trace.
  const cancelRun = useCallback(() => {
    agentic.reset();
    finalizedRef.current = false;
    setActiveQuestion(null);
    setPhase(turns.length ? "done" : "idle");
  }, [agentic, turns.length]);

  const retryRun = useCallback(() => {
    if (!activeQuestion) return;
    finalizedRef.current = false;
    setPhase("running");
    void agentic.start(activeQuestion);
  }, [activeQuestion, agentic]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  if (phase === "idle") {
    return (
      <div className={cn("flex min-h-0 flex-col", className)}>
        {/* CONTENT area (order-first) — centered composer · trace NOT mounted */}
        <div
          className={cn(
            "order-first flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8",
            !reduced && "transition-all duration-300",
          )}
        >
          <div className={cn("w-full max-w-2xl", !reduced && "motion-safe:animate-fade-in")}>
            {welcome ?? <DefaultWelcome />}
            <ComposerForm
              value={input}
              onChange={setInput}
              onSubmit={submit}
              disabled={false}
              inputRef={inputRef}
              placeholder="问点什么,或分派一个任务… · Ask anything or assign a task"
            />
          </div>
        </div>
      </div>
    );
  }

  // running / done — composer relocated to the BOTTOM (order-last)
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {/* CONTENT — order-first, scrollable (history turns → active run) */}
      <div
        className={cn(
          "order-first min-h-0 flex-1 overflow-y-auto",
          !reduced && "transition-all duration-300",
        )}
      >
        <div className="mx-auto w-full max-w-4xl px-4 py-4">
          {/* thread header + new-chat affordance */}
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground dark:text-neutral-100">
              <span className="inline-flex text-brand">
                <Icon icon="lucide:messages-square" width={15} height={15} />
              </span>
              对话 · Conversation
              {turns.length ? (
                <span className="text-xs font-normal text-muted-foreground">· {turns.length} 轮</span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={newChat}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-brand/40 hover:text-brand"
            >
              <span className="inline-flex">
                <Icon icon="lucide:plus" width={13} height={13} />
              </span>
              新对话 · New chat
            </button>
          </div>

          <div className="space-y-5">
            {/* prior + completed turns (newest expanded in the done state) */}
            {turns.map((t, i) => (
              <HistoryTurn
                key={t.id}
                turn={t}
                defaultOpen={i === turns.length - 1 && phase === "done"}
                config={config}
                chartRenderer={chartRenderer}
                markdownRenderer={markdownRenderer}
                reduced={reduced}
              />
            ))}

            {/* the active run (newest · below history) */}
            {phase === "running" ? (
              <div className="space-y-2">
                {activeQuestion ? <UserBubble text={activeQuestion} /> : null}
                {agentic.error ? (
                  <RunErrorPanel message={agentic.error} onRetry={retryRun} onCancel={cancelRun} />
                ) : (
                  <AgenticRunTrace
                    run={agentic.run}
                    running={agentic.running}
                    awaitingApproval={agentic.awaitingApproval}
                    llm={agentic.llm}
                    usage={agentic.usage}
                    onApprove={agentic.approve}
                    onReset={cancelRun}
                    config={config}
                    chartRenderer={chartRenderer}
                    markdownRenderer={markdownRenderer}
                  />
                )}
              </div>
            ) : null}
          </div>

          <div ref={bottomRef} />
        </div>
      </div>

      {/* COMPOSER — order-last, pinned to the bottom (chat layout) */}
      <div
        className={cn(
          "order-last shrink-0 border-t border-border bg-background/85 px-4 py-3 backdrop-blur",
          !reduced && "transition-all duration-300",
        )}
      >
        <div className="mx-auto w-full max-w-4xl">
          {/* Stop — interrupt the in-flight run (G1 §2.1 · ChatGPT-style, above
              the composer). Aborts the stream; the partial run is discarded. */}
          {phase === "running" && allowInterrupt ? (
            <div className="mb-2 flex justify-center">
              <button
                type="button"
                onClick={cancelRun}
                aria-label="停止运行 · Stop the run"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-foreground shadow-sm transition-colors hover:border-red-300 hover:text-red-600 dark:hover:border-red-500/40 dark:hover:text-red-400"
              >
                <span className="inline-flex">
                  <Icon icon="lucide:square" width={13} height={13} />
                </span>
                停止 · Stop
              </button>
            </div>
          ) : null}
          <ComposerForm
            value={input}
            onChange={setInput}
            onSubmit={submit}
            disabled={phase === "running"}
            inputRef={inputRef}
            placeholder={
              phase === "running"
                ? "运行中,请稍候… · Running…"
                : "继续追问,或分派新任务… · Ask a follow-up or assign a task"
            }
          />
          <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
            {phase === "running"
              ? "运行中 · 完成后可继续追问(续问将追加到本对话)。 · Running — you can follow up once it finishes."
              : "续问将追加到本对话;「新对话」开启一个新会话。 · Follow-ups append to this chat."}
          </p>
        </div>
      </div>
    </div>
  );
}
