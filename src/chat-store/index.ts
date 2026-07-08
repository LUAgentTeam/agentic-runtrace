// @leapunion/agentic-runtrace/chat-store — persistence (subpath "./chat-store")
// ─────────────────────────────────────────────────────────────────────────────
// 🟧 SKELETON (Phase B step 1 · ADR-0004). Moves here from the skill
// `templates/chat-store.ts` in B-2 (MANIFEST.md §1). CLIENT persistence:
// per-user localStorage by default (no backend needed); `configureChatStore`
// lets a project inject server persistence + de-branded keys/identity endpoint.
// Stores the full run `trace` per turn so a reopened Chat replays it.
// Centralized cross-device chat history = a SEPARATE persistence service, NOT
// this + NOT the engine microservice (ADR-0004 §When-to-reconsider #4).
// B-2 = uncomment once src/chat-store/store.ts lands.
// ─────────────────────────────────────────────────────────────────────────────

export const CHAT_STORE = "@leapunion/agentic-runtrace/chat-store";

// ── B-2 public API (activated on move) ───────────────────────────────────────
export {
  createChat, getChat, getChats, appendTurn, renameChat, togglePin,
  toggleArchive, deleteChat, setActiveChatId, useActiveChatId, useChats,
  useCurrentUser, configureChatStore,
} from "./store";
export type { ChatSession, ChatMessage, TurnMeta } from "./store";
