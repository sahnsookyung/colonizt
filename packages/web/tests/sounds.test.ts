// @vitest-environment jsdom
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameEvent, ResourceBundle } from "@colonizt/game-core";

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
const emptyBundle = (): ResourceBundle => ({ timber: 0, brick: 0, grain: 0, fiber: 0, ore: 0 });

const soundAssetExists = (source: string): boolean => {
  const relative = source.replace(/^\//, "");
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, "public", relative))) return true;
    if (existsSync(join(directory, "packages/web/public", relative))) return true;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return false;
};

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
    expect(createdAudio[0]?.src).toBe("/sounds/dice-roll.wav");
    expect(createdAudio[0]?.preload).toBe("auto");
    expect(createdAudio[0]?.volume).toBe(0.28);
    expect(createdAudio[0]?.currentTime).toBe(0);
    expect(createdAudio[0]?.play).toHaveBeenCalledOnce();

    createdAudio[0]!.currentTime = 4;
    playSound("dice");

    expect(createdAudio).toHaveLength(1);
    expect(createdAudio[0]?.currentTime).toBe(0);
    expect(createdAudio[0]?.play).toHaveBeenCalledTimes(2);
  });

  it("collapses a multi-event human action to one priority cue", async () => {
    const { playSoundForEvents } = await import("../src/sounds.js");

    playSoundForEvents([
      { type: "DEVELOPMENT_CARD_PLAYED", playerId: "p1", cardId: "card_1", cardType: "ROAD_BUILDING" },
      { type: "ROAD_BUILDING_PLAYED", playerId: "p1", cardId: "card_1", edgeIds: ["edge_1", "edge_2"] },
      { type: "ROAD_BUILT", playerId: "p1", edgeId: "edge_1", cost: emptyBundle() },
    ] as GameEvent[], "p1");

    expect(createdAudio.map((audio) => audio.src)).toEqual(["/sounds/dev-card.wav"]);
    expect(createdAudio[0]?.play).toHaveBeenCalledOnce();
  });

  it("maps human progress events to distinct action sounds", async () => {
    const { playSoundForEvents } = await import("../src/sounds.js");

    playSoundForEvents([{ type: "SETUP_PLACED", playerId: "p1", vertexId: "v1", edgeId: "e1", startingResources: {} }] as GameEvent[], "p1");
    playSoundForEvents([{ type: "ROAD_BUILT", playerId: "p1", edgeId: "e1", cost: emptyBundle() }] as GameEvent[], "p1");
    playSoundForEvents([{ type: "CITY_UPGRADED", playerId: "p1", vertexId: "v1", cost: emptyBundle() }] as GameEvent[], "p1");
    playSoundForEvents([{ type: "MARITIME_TRADED", playerId: "p1", offered: "timber", requested: "grain", ratio: 4 }] as GameEvent[], "p1");
    playSoundForEvents([{ type: "THIEF_MOVED", playerId: "p1", fromHexId: "h1", toHexId: "h2", reason: "ROLL_7" }] as GameEvent[], "p1");
    playSoundForEvents([{ type: "RESOURCES_DISCARDED", playerId: "p1", resources: emptyBundle() }] as GameEvent[], "p1");

    expect(createdAudio.map((audio) => audio.src)).toEqual([
      "/sounds/build-settlement.wav",
      "/sounds/build-road.wav",
      "/sounds/upgrade-city.wav",
      "/sounds/trade.wav",
      "/sounds/thief.wav",
      "/sounds/discard.wav",
    ]);
  });

  it("keeps bot-only actions quiet but plays key events for the human", async () => {
    const { playSoundForEvents } = await import("../src/sounds.js");

    playSoundForEvents([{ type: "ROAD_BUILT", playerId: "bot", edgeId: "e1", cost: emptyBundle() }] as GameEvent[], "p1");
    playSoundForEvents([{ type: "TURN_ENDED", playerId: "bot", nextPlayerId: "p1" }] as GameEvent[], "p1");
    playSoundForEvents([{ type: "TRADE_OFFERED", trade: { id: "trade_1", fromPlayerId: "bot", offered: emptyBundle(), requested: { ...emptyBundle(), timber: 1 }, recipients: ["p1"], status: "COLLECTING_RESPONSES", responses: {}, createdAtSeq: 1, expiresAtSeq: 5 } }] as GameEvent[], "p1");
    playSoundForEvents([{ type: "RESOURCES_PRODUCED", gains: { p1: { timber: 1 } } }] as GameEvent[], "p1");

    expect(createdAudio.map((audio) => audio.src)).toEqual([
      "/sounds/turn-handoff.wav",
      "/sounds/trade.wav",
      "/sounds/dice-roll.wav",
    ]);
  });

  it("does not play sound in jsdom-like user agents", async () => {
    const { playSound } = await import("../src/sounds.js");
    setUserAgent("jsdom");

    playSound("select");

    expect(createdAudio).toHaveLength(0);
  });

  it("has every configured sound asset checked in", async () => {
    const { soundSources } = await import("../src/sounds.js");

    for (const source of Object.values(soundSources)) {
      expect(soundAssetExists(source), source).toBe(true);
    }
  });
});
