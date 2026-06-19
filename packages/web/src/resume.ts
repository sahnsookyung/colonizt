import type { PlayerId } from "@colonizt/game-core";

export interface NetworkResumeState {
  token: string;
  userId: PlayerId;
  roomId: string;
  clientSeq: number;
  lastSeq: number;
}

export const resumeStorageKey = "colonizt.resume";

export const readResumeState = (storage: Pick<Storage, "getItem"> = localStorage): NetworkResumeState | null => {
  try {
    const raw = storage.getItem(resumeStorageKey);
    return raw ? JSON.parse(raw) as NetworkResumeState : null;
  } catch {
    return null;
  }
};

export const writeResumeState = (
  state: NetworkResumeState,
  storage: Pick<Storage, "setItem"> = localStorage,
): void => {
  storage.setItem(resumeStorageKey, JSON.stringify(state));
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
