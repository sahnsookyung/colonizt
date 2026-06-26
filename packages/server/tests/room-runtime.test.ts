import { describe, expect, it } from "vitest";
import { connectedSeatedHumanCount, connectedUserCount, livenessStateForRoom, roomTimerKey } from "../src/room-runtime.js";
import type { Room } from "../src/room-manager.js";

const baseRoom = (overrides: Partial<Room> = {}): Room => ({
  id: "room_runtime",
  code: "RUNTIME",
  hostUserId: "u_host",
  status: "LOBBY",
  settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 },
  seats: [
    { seatIndex: 0, userId: "u_host", ready: true, connected: true },
    { seatIndex: 1, userId: "u_guest", ready: false, connected: false },
    { seatIndex: 2, botId: "bot_3", ready: true, connected: true },
    { seatIndex: 3, ready: false, connected: false },
  ],
  spectators: new Set(["spec_1"]),
  createdAt: "2026-06-26T00:00:00.000Z",
  lastActivityAt: "2026-06-26T00:00:00.000Z",
  events: [],
  chat: [],
  reports: [],
  processedClientCommands: new Map(),
  tradeResponseDeadlines: new Map(),
  ...overrides,
});

describe("room-runtime helpers", () => {
  it("counts connected humans separately from bots and spectators", () => {
    const room = baseRoom();

    expect(connectedSeatedHumanCount(room)).toBe(1);
    expect(connectedUserCount(room)).toBe(2);
  });

  it("derives liveness from the shared lifecycle state", () => {
    expect(livenessStateForRoom(baseRoom())).toBe("ACTIVE");
    expect(livenessStateForRoom(baseRoom({ seats: baseRoom().seats.map((seat) => ({ ...seat, connected: false })), emptySince: "2026-06-26T00:00:00.000Z" }))).toBe("IDLE_LOBBY");
    expect(livenessStateForRoom(baseRoom({ status: "IN_GAME", pausedAt: "2026-06-26T00:00:00.000Z", pauseReason: "EMPTY_ROOM" }))).toBe("PAUSED_EMPTY");
    expect(livenessStateForRoom(baseRoom({ pausedAt: "2026-06-26T00:00:00.000Z", pauseReason: "STALLED_AUTOMATION" }))).toBe("STALLED");
    expect(livenessStateForRoom(baseRoom({ status: "FINISHED", archivedAt: "2026-06-26T00:00:00.000Z", cleanupReason: "FINISHED_UNLOADED" }))).toBe("FINISHED_UNLOADED");
  });

  it("builds stable turn timer keys for active phases", () => {
    const room = baseRoom();
    room.game = {
      schemaVersion: 3,
      config: {
        matchId: "match_timer",
        seed: "timer",
        victoryPoints: 10,
        maxPlayers: 2,
        turnSeconds: 45,
        playerOrder: ["u_host", "u_guest"],
        playerNames: { u_host: "Host", u_guest: "Guest" },
        playerColors: { u_host: "#2563eb", u_guest: "#dc2626" },
      },
      board: { hexes: {}, vertices: {}, edges: {}, ports: {}, adjacency: { hexToVertices: {}, vertexToEdges: {}, edgeToVertices: {} } },
      players: {},
      playerOrder: ["u_host", "u_guest"],
      resourceBank: { timber: 0, brick: 0, grain: 0, fiber: 0, ore: 0 },
      phase: { type: "ACTION_PHASE", activePlayerId: "u_host" },
      turn: 4,
      roads: {},
      settlements: {},
      buildings: {},
      playedKnightCounts: {},
      trades: {},
      developmentDeck: [],
      developmentDeckCursor: 0,
      eventSeq: 0,
      rng: { seed: "timer", index: 0, policy: "SEEDED_DETERMINISTIC" },
    };

    expect(roomTimerKey(room.game)).toBe("match_timer:4:ACTION_PHASE:u_host");
  });
});
