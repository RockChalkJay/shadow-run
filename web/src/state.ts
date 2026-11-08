import { DEFAULT_SCREEN_RULES, type CharacterView, type CombatState, type EdgeView, type GmStatus, type RollRequest, type ScreenRules, type ServerEvent, type TranscriptEntry } from "@shadow-run/shared";
import type { CharacterSheet } from "@shadow-run/shared";

/** The GM's narration as it streams in, before the finished entry arrives. */
export interface Streaming {
  turnId: number;
  blocks: string[];
}

export interface TableState {
  /** Is the socket open right now? */
  connected: boolean;
  /** Reconnection attempts since the connection was lost. */
  attempt: number;
  /** Has the first snapshot arrived? */
  ready: boolean;
  party: CharacterSheet[];
  characters: CharacterView[];
  edge: EdgeView[];
  combat: CombatState | null;
  pending: RollRequest[];
  transcript: TranscriptEntry[];
  gm: GmStatus;
  streaming: Streaming | null;
  /** Roll entries that arrived live and are still shown open, with their dice; they close when the GM finishes narrating what came of them, or asks for the next roll. */
  fresh: number[];
  /** The last message the server refused with, until the player does something else. */
  error: string | null;
  /** The rules the screen reads, as the server has them. */
  rules: ScreenRules;
}

export const initialState: TableState = {
  connected: false,
  attempt: 0,
  ready: false,
  party: [],
  characters: [],
  edge: [],
  combat: null,
  pending: [],
  transcript: [],
  gm: { phase: "idle" },
  streaming: null,
  fresh: [],
  error: null,
  rules: DEFAULT_SCREEN_RULES,
};

export type Action =
  | { type: "server"; event: ServerEvent }
  | { type: "connection"; connected: boolean; attempt: number }
  /** The player did something, so an old refusal no longer applies. */
  | { type: "acted" };

const replaceBy = <T extends { id: string }>(list: T[], item: T): T[] => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]);

export function reduce(state: TableState, action: Action): TableState {
  if (action.type === "connection") return { ...state, connected: action.connected, attempt: action.attempt };
  if (action.type === "acted") return state.error === null ? state : { ...state, error: null };

  const event = action.event;
  switch (event.type) {
    case "snapshot":
      return { ...state, ready: true, party: event.party, characters: event.characters, edge: event.edge, combat: event.combat, pending: event.pendingRolls, transcript: event.transcript, gm: event.gm, streaming: null, fresh: [], error: null, rules: event.rules };
    case "gm.status":
      return { ...state, gm: event.status };
    case "gm.block":
      return { ...state, streaming: { turnId: event.turnId, blocks: [...(state.streaming?.blocks ?? []), ""] } };
    case "gm.text": {
      const blocks = state.streaming?.turnId === event.turnId ? [...state.streaming.blocks] : [""];
      blocks[blocks.length - 1] = (blocks.at(-1) ?? "") + event.text;
      return { ...state, streaming: { turnId: event.turnId, blocks } };
    }
    case "gm.turn_done":
      return { ...state, streaming: null };
    case "entry": {
      if (state.transcript.some((e) => e.id === event.entry.id)) return state;
      const entry = event.entry;
      let next: TableState = { ...state, transcript: [...state.transcript, entry] };
      if (entry.kind === "gm") next = { ...next, streaming: null, fresh: [] };
      if (entry.kind === "roll") next = { ...next, pending: next.pending.filter((r) => r.id !== entry.resolved.request.id), fresh: [...next.fresh, entry.id] };
      return next;
    }
    case "roll.requested":
      return { ...state, fresh: [], pending: replaceBy(state.pending, event.request) };
    case "roll.updated":
      return { ...state, pending: replaceBy(state.pending, event.request) };
    case "roll.cancelled":
      return { ...state, pending: state.pending.filter((r) => r.id !== event.requestId) };
    case "edge.updated": {
      const known = state.edge.some((e) => e.id === event.edge.id);
      return { ...state, edge: known ? state.edge.map((e) => (e.id === event.edge.id ? event.edge : e)) : [...state.edge, event.edge] };
    }
    case "character.updated":
      return { ...state, characters: state.characters.some((c) => c.kind === event.character.kind && c.id === event.character.id) ? state.characters.map((c) => (c.kind === event.character.kind && c.id === event.character.id ? event.character : c)) : [...state.characters, event.character] };
    case "combat.updated":
      return { ...state, combat: event.combat };
    case "error":
      return { ...state, error: event.message };
    case "usage":
      return state;
  }
}
