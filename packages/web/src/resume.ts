import type { PlayerId } from "@colonizt/game-core";
import { gameCommandSchema, type PendingGameCommand } from "@colonizt/protocol";
import { z } from "zod";

export interface NetworkResumeState {
  token: string;
  userId: PlayerId;
  roomId: string;
  roomCode?: string;
  clientSeq: number;
  lastSeq: number;
  pendingCommand?: PendingGameCommand;
}

export const resumeStorageKey = "colonizt.resume";

const networkResumeStateSchema = z.object({
  token: z.string().min(1),
  userId: z.string().min(1),
  roomId: z.string().min(1),
  roomCode: z.string().min(1).optional(),
  clientSeq: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  pendingCommand: z.object({ clientSeq: z.number().int().nonnegative(), expectedEventSeq: z.number().int().nonnegative(), command: gameCommandSchema }).optional(),
});

export const readResumeState = (storage?: Pick<Storage, "getItem">): NetworkResumeState | null => {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(resumeStorageKey);
    if (!raw) return null;
    const parsed = networkResumeStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { roomCode, pendingCommand, ...required } = parsed.data;
    return { ...required, ...(roomCode ? { roomCode } : {}), ...(pendingCommand ? { pendingCommand: pendingCommand as PendingGameCommand } : {}) };
  } catch {
    return null;
  }
};

export const writeResumeState = (
  state: NetworkResumeState,
  storage?: Pick<Storage, "setItem">,
): void => {
  try {
    (storage ?? globalThis.localStorage).setItem(resumeStorageKey, JSON.stringify(state));
  } catch {
    // Resume state is opportunistic; online play should continue when storage is unavailable.
  }
};

export const clearResumeState = (
  storage?: Pick<Storage, "setItem"> & Partial<Pick<Storage, "removeItem">>,
): void => {
  try {
    storage ??= globalThis.localStorage;
    if (typeof storage.removeItem === "function") storage.removeItem(resumeStorageKey);
    else storage.setItem(resumeStorageKey, "");
  } catch {
    // Resume state is opportunistic; match startup should not depend on storage availability.
  }
};
