"use client";

// ───────────────────────────────────────────────────────────────────────────
// chat-store.ts — per-user, client-side chat/session store for Agent chats
// (brand-agnostic template).
//
// WHAT: persists user↔Agent conversations as "chat sessions" in localStorage,
// scoped PER logged-in user. Each user gets an isolated saved list — like a
// per-user folder — under the key `<storePrefix><username>` (default
// `agentic-chats::<username>`). The current user is resolved once from a
// configurable identity endpoint (default GET /api/auth/me) and cached.
//
// Each turn stores the assistant message's run `trace` (ChainStep[]) + optional
// `chart`, so REOPENING a chat can REPLAY the reasoning + action run — not just
// the text.
//
// HOW REACTIVITY WORKS: a tiny module-level event bus (a Set of listener fns +
// subscribe/emit) drives re-renders. Hooks read via React's useSyncExternalStore
// so any component (sidebar, chatbot shell, chat page) stays in sync after a
// mutation. subscribe() also attaches a `window` "storage" listener so edits in
// OTHER tabs sync here too. Snapshots are memoized per-user (snapCache) so
// useSyncExternalStore gets a stable reference until the store actually changes.
//
// SSR-SAFE: imported by client components but still evaluates during SSR. Every
// window/localStorage/crypto access is guarded; hooks return stable server
// snapshots (empty array / null). No exported fn ever throws.
//
// DE-BRAND: no brand word in defaults. No seed by default — a host may inject a
// generic seed via configureChatStore({ seed }). Token=0: no Math.random / no
// Date.now at module scope (both are used only inside function bodies).
// ───────────────────────────────────────────────────────────────────────────
import { useEffect, useSyncExternalStore } from "react";
import type { ChainStep, ChartData } from "../types/chain-data";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
  // ── run-trace persistence (assistant turns) ──
  trace?: ChainStep[]; // the reasoning + action steps → replay on reopen
  chart?: ChartData; // structured chart payload (client re-renders)
  meta?: Record<string, unknown>; // e.g. { llm, usage }
}
export interface ChatSession {
  id: string;
  user: string; // owner username (per-user scoping)
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  messages: ChatMessage[];
}

/** Optional metadata attached to the assistant message when a turn is appended. */
export interface TurnMeta {
  trace?: ChainStep[];
  chart?: ChartData;
  llm?: boolean;
  usage?: string | null;
}

// ── Configuration (host-overridable · de-branded defaults) ───────────────────
let STORE_PREFIX = "agentic-chats::";
let CURRENT_USER_KEY = "agentic-current-user";
let ME_ENDPOINT = "/api/auth/me";
let seedFactory: ((user: string) => ChatSession[]) | null = null;

export interface ChatStoreConfig {
  storePrefix?: string;
  currentUserKey?: string;
  meEndpoint?: string;
  /** Return a generic starter list on a user's FIRST access. Omit for no seed. */
  seed?: (user: string) => ChatSession[];
}

/** Configure store keys / identity endpoint / optional seed. Call once at boot,
 *  before any hook mounts (e.g. in a top-level client provider). */
export function configureChatStore(cfg: ChatStoreConfig): void {
  if (cfg.storePrefix) STORE_PREFIX = cfg.storePrefix;
  if (cfg.currentUserKey) CURRENT_USER_KEY = cfg.currentUserKey;
  if (cfg.meEndpoint) ME_ENDPOINT = cfg.meEndpoint;
  if (cfg.seed) seedFactory = cfg.seed;
}

const HOUR = 3_600_000;
const isBrowser = typeof window !== "undefined";
const EMPTY: ChatSession[] = []; // stable server/empty snapshot (never mutated)

// keep HOUR referenced (used by host seed factories via re-export pattern)
export const CHAT_HOUR_MS = HOUR;

// ── Event bus ───────────────────────────────────────────────────────────────
const listeners = new Set<() => void>();
const snapCache = new Map<string, ChatSession[]>(); // per-user memoized snapshot
let storageBound = false;

function emit(): void {
  snapCache.clear(); // invalidate memoized snapshots → hooks recompute
  listeners.forEach((fn) => fn());
}

function onStorage(e: StorageEvent): void {
  if (e.key === CURRENT_USER_KEY) {
    currentUser = readCurrentUserFromLS();
    emit();
    return;
  }
  if (!e.key || e.key.startsWith(STORE_PREFIX)) emit(); // another tab changed chats
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (isBrowser && !storageBound) {
    storageBound = true;
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(fn);
  };
}

// ── IDs / time ────────────────────────────────────────────────────────────────
let idCounter = 0;
function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${idCounter++}`;
}

// ── Persistence ───────────────────────────────────────────────────────────────
function persist(user: string, chats: ChatSession[]): void {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(STORE_PREFIX + user, JSON.stringify(chats));
  } catch {
    /* quota / private mode — ignore, store stays in-memory for this render */
  }
}

// readStore: parse `<prefix><user>`; on FIRST access (nothing stored yet) run
// the optional seedFactory (persisting a non-empty seed), else return EMPTY.
// Returns a seed on corruption. Never emits (safe to call from getSnapshot).
function readStore(user: string): ChatSession[] {
  if (!isBrowser || !user) return EMPTY;
  const raw = window.localStorage.getItem(STORE_PREFIX + user);
  if (raw === null) {
    const seed = seedFactory ? seedFactory(user) : [];
    if (seed.length) {
      persist(user, seed);
      return seed;
    }
    return EMPTY;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ChatSession[];
    return seedFactory ? seedFactory(user) : EMPTY;
  } catch {
    return seedFactory ? seedFactory(user) : EMPTY;
  }
}

function writeStore(user: string, chats: ChatSession[]): void {
  persist(user, chats);
  emit(); // notify subscribers + cross-tab awareness via memoized snapshot reset
}

// Memoized, newest-first snapshot (updatedAt desc). Archived NOT filtered —
// that (plus pinned ordering) is the consumer's job.
function chatsSnapshot(user: string): ChatSession[] {
  const cached = snapCache.get(user);
  if (cached) return cached;
  const sorted = readStore(user)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  snapCache.set(user, sorted);
  return sorted;
}

// ── Active chat id (shared app-wide) ──────────────────────────────────────────
let activeChatId: string | null = null;

export function setActiveChatId(id: string | null): void {
  activeChatId = id;
  emit();
}

export function useActiveChatId(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => activeChatId,
    () => null,
  );
}

// ── Reactive chat list ────────────────────────────────────────────────────────
export function useChats(user: string | null): ChatSession[] {
  return useSyncExternalStore(
    subscribe,
    () => (user && isBrowser ? chatsSnapshot(user) : EMPTY),
    () => EMPTY,
  );
}

// ── Non-reactive reads ────────────────────────────────────────────────────────
export function getChats(user: string): ChatSession[] {
  if (!isBrowser || !user) return EMPTY;
  return chatsSnapshot(user);
}

export function getChat(user: string, chatId: string): ChatSession | null {
  if (!isBrowser || !user) return null;
  return readStore(user).find((c) => c.id === chatId) ?? null;
}

// ── Mutations ─────────────────────────────────────────────────────────────────
export function createChat(user: string, title?: string): ChatSession {
  const now = Date.now();
  const chat: ChatSession = {
    id: uid(),
    user,
    title: title && title.trim() ? title.trim() : "New chat",
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false,
    messages: [],
  };
  if (isBrowser && user) {
    writeStore(user, [chat, ...readStore(user)]);
    setActiveChatId(chat.id);
  }
  return chat;
}

/** Append one user+assistant turn. The assistant message carries the run trace /
 *  chart / meta so reopening the chat can replay the reasoning + action run. */
export function appendTurn(
  user: string,
  chatId: string,
  userText: string,
  assistantText: string,
  meta?: TurnMeta,
): void {
  if (!isBrowser || !user) return;
  const chats = readStore(user);
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return;
  const now = Date.now();
  const hasMeta = meta != null && (meta.llm != null || meta.usage != null);
  chat.messages.push(
    { role: "user", text: userText, ts: now },
    {
      role: "assistant",
      text: assistantText,
      ts: now,
      trace: meta?.trace,
      chart: meta?.chart,
      meta: hasMeta ? { llm: meta?.llm, usage: meta?.usage } : undefined,
    },
  );
  chat.updatedAt = now;
  if (!chat.title || chat.title === "New chat") {
    chat.title = userText.trim().slice(0, 40) || "New chat";
  }
  writeStore(user, chats);
}

export function renameChat(user: string, chatId: string, title: string): void {
  if (!isBrowser || !user) return;
  const chats = readStore(user);
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return;
  chat.title = title.trim() || chat.title;
  chat.updatedAt = Date.now();
  writeStore(user, chats);
}

export function togglePin(user: string, chatId: string): void {
  if (!isBrowser || !user) return;
  const chats = readStore(user);
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return;
  chat.pinned = !chat.pinned;
  writeStore(user, chats);
}

export function toggleArchive(user: string, chatId: string): void {
  if (!isBrowser || !user) return;
  const chats = readStore(user);
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return;
  chat.archived = !chat.archived;
  if (chat.archived) chat.pinned = false; // archiving also unpins
  writeStore(user, chats);
}

export function deleteChat(user: string, chatId: string): void {
  if (!isBrowser || !user) return;
  writeStore(
    user,
    readStore(user).filter((c) => c.id !== chatId),
  );
  if (activeChatId === chatId) setActiveChatId(null);
}

// ── Current user (per-user scoping key) ───────────────────────────────────────
let currentUser: { user: string; name: string } | null = null;
let cuLoaded = false;
let cuFetching = false;

function readCurrentUserFromLS(): { user: string; name: string } | null {
  if (!isBrowser) return null;
  try {
    const raw = window.localStorage.getItem(CURRENT_USER_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as { user?: unknown; name?: unknown };
    if (d && typeof d.user === "string") {
      return { user: d.user, name: typeof d.name === "string" ? d.name : d.user };
    }
  } catch {
    /* corrupt cache — ignore */
  }
  return null;
}

// Resolve identity once: hydrate from localStorage immediately (fast paint),
// then refresh from GET <meEndpoint> → { user, name, role }. Failures are
// swallowed (returns cached / null); never throws.
function ensureCurrentUser(): void {
  if (!isBrowser || cuLoaded || cuFetching) return;
  if (!currentUser) {
    const ls = readCurrentUserFromLS();
    if (ls) {
      currentUser = ls;
      emit();
    }
  }
  cuFetching = true;
  fetch(ME_ENDPOINT)
    .then((r) => (r.ok ? r.json() : null))
    .then((raw) => {
      cuLoaded = true;
      cuFetching = false;
      const d = raw as { user?: unknown; name?: unknown } | null;
      if (d && typeof d.user === "string") {
        const next = {
          user: d.user,
          name: typeof d.name === "string" ? d.name : d.user,
        };
        currentUser = next;
        try {
          window.localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        emit();
      }
    })
    .catch(() => {
      cuLoaded = true;
      cuFetching = false;
    });
}

/** Reactive current-user hook. Optional — a host may pass `user` explicitly to
 *  the shell instead of using this identity resolver. */
export function useCurrentUser(): { user: string; name: string } | null {
  const value = useSyncExternalStore(
    subscribe,
    () => currentUser,
    () => null,
  );
  useEffect(() => {
    ensureCurrentUser();
  }, []);
  return value;
}
