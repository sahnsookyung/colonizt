import { describe, expect, it } from "vitest";
import { clearResumeState, readResumeState, resumeStorageKey, writeResumeState } from "../src/resume.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("network resume storage", () => {
  it("round-trips and clears persisted resume state", () => {
    const storage = new MemoryStorage();
    const state = { token: "s_1", userId: "u_1", roomId: "room_1", roomCode: "ABC123", clientSeq: 3, lastSeq: 9 };
    writeResumeState(state, storage);
    expect(readResumeState(storage)).toEqual(state);
    clearResumeState(storage);
    expect(storage.values.has(resumeStorageKey)).toBe(false);
  });

  it("treats malformed storage as absent", () => {
    const storage = new MemoryStorage();
    storage.setItem(resumeStorageKey, "{bad");
    expect(readResumeState(storage)).toBeNull();
  });

  it("ignores storage write failures", () => {
    expect(() => writeResumeState(
      { token: "s_1", userId: "u_1", roomId: "room_1", clientSeq: 3, lastSeq: 9 },
      { setItem: () => { throw new Error("storage disabled"); } },
    )).not.toThrow();
  });
});
