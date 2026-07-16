import type { PlayerId } from "@colonizt/game-core";
import { z } from "zod";

export interface NetworkResumeState {
  token: string;
  userId: PlayerId;
  roomId: string;
  roomCode?: string;
  clientSeq: number;
  lastSeq: number;
}

export const resumeStorageKey = "colonizt.resume";

const networkResumeStateSchema = z.object({
  token: z.string().min(1),
  userId: z.string().min(1),
  roomId: z.string().min(1),
  roomCode: z.string().min(1).optional(),
  clientSeq: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
});

export const readResumeState = (storage: Pick<Storage, "getItem"> = localStorage): NetworkResumeState | null => {
  try {
    const raw = storage.getItem(resumeStorageKey);
    if (!raw) return null;
    const parsed = networkResumeStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { roomCode, ...required } = parsed.data;
    return roomCode ? { ...required, roomCode } : required;
  } catch {
    return null;
  }
};

export const writeResumeState = (
  state: NetworkResumeState,
  storage: Pick<Storage, "setItem"> = localStorage,
): void => {
  try {
    storage.setItem(resumeStorageKey, JSON.stringify(state));
  } catch {
    // Resume state is opportunistic; online play should continue when storage is unavailable.
  }
};

export const clearResumeState = (
  storage: Pick<Storage, "removeItem" | "setItem"> = localStorage,
): void => {
  try {
    if (typeof storage.removeItem === "function") storage.removeItem(resumeStorageKey);
    else storage.setItem(resumeStorageKey, "");
  } catch {
    // Resume state is opportunistic; match startup should not depend on storage availability.
  }
};
