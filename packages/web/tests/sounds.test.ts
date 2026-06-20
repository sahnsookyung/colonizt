// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameEvent } from "@colonizt/game-core";

class FakeAudio {
  readonly src: string;
  preload = "";
  volume = 0;
  currentTime = 7;
  readonly play = vi.fn(() => Promise.resolve());

  constructor(src: string) {
    this.src = src;
    createdAudio.push(this);
  }
}

const createdAudio: FakeAudio[] = [];

const setUserAgent = (value: string): void => {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true });
};

describe("sound cues", () => {
  beforeEach(() => {
    createdAudio.length = 0;
    vi.resetModules();
    setUserAgent("Mozilla/5.0 ColoniztTest");
    vi.stubGlobal("Audio", FakeAudio);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads and reuses audio elements for direct cues", async () => {
    const { playSound } = await import("../src/sounds.js");

    playSound("dice");

    expect(createdAudio).toHaveLength(1);
    expect(createdAudio[0]?.src).toBe("/sounds/dice-roll.mp3");
    expect(createdAudio[0]?.preload).toBe("auto");
    expect(createdAudio[0]?.volume).toBe(0.36);
    expect(createdAudio[0]?.currentTime).toBe(0);
    expect(createdAudio[0]?.play).toHaveBeenCalledOnce();

    createdAudio[0]!.currentTime = 4;
    playSound("dice");

    expect(createdAudio).toHaveLength(1);
    expect(createdAudio[0]?.currentTime).toBe(0);
    expect(createdAudio[0]?.play).toHaveBeenCalledTimes(2);
  });

  it("maps game events to expected cues", async () => {
    const { playSoundForEvent } = await import("../src/sounds.js");

    playSoundForEvent({ type: "DICE_ROLLED" } as GameEvent);
    playSoundForEvent({ type: "SETUP_PLACED" } as GameEvent);
    playSoundForEvent({ type: "TRADE_OFFERED" } as GameEvent);
    playSoundForEvent({ type: "SEVEN_ROLLED" } as GameEvent);
    playSoundForEvent({ type: "TURN_ENDED" } as GameEvent);

    expect(createdAudio.map((audio) => audio.src)).toEqual([
      "/sounds/dice-roll.mp3",
      "/sounds/action-complete.mp3",
      "/sounds/trade-bonus.mp3",
      "/sounds/ui-click.mp3",
    ]);
    expect(createdAudio[0]?.play).toHaveBeenCalledTimes(2);
  });

  it("does not play sound in jsdom-like user agents", async () => {
    const { playSound } = await import("../src/sounds.js");
    setUserAgent("jsdom");

    playSound("select");

    expect(createdAudio).toHaveLength(0);
  });
});
