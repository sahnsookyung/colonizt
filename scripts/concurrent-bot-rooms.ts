import { replay, type GameEvent, type GameState, type MapPreset, type PlayerId } from "@colonizt/game-core";
import { MetricsRegistry, RoomAutomationScheduler, RoomManager, createStructuredLogger, defaultRoomCleanupPolicy } from "@colonizt/server";
import type { CommandResult } from "../packages/server/src/room-manager.js";

interface ConcurrentRoomResult {
  roomId: string;
  code: string;
  mapPreset: MapPreset;
  botIds: PlayerId[];
  events: number;
  turns: number;
  winnerId: PlayerId;
}

export interface ConcurrentBotRoomSummary {
  ok: true;
  roomCount: number;
  botsPerRoom: number;
  totalBots: number;
  ticks: number;
  rooms: ConcurrentRoomResult[];
}

const roomCount = Number(process.env.CONCURRENT_BOT_ROOMS ?? 5);
const botsPerRoom = Number(process.env.CONCURRENT_BOTS_PER_ROOM ?? 4);
const maxTicks = Number(process.env.CONCURRENT_BOT_MAX_TICKS ?? 4_000);
const maxTurns = Number(process.env.CONCURRENT_BOT_MAX_TURNS ?? 18);
const tickMs = Number(process.env.CONCURRENT_BOT_TICK_MS ?? 1_000);
const mapSequence: MapPreset[] = ["standard", "islands", "continent", "standard", "continent"];

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const stableStateHash = (state: GameState): string => stableStringify(state);

const assertCondition = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

const assertContiguousEvents = (roomId: string, events: readonly GameEvent[]): void => {
  events.forEach((event, index) => {
    assertCondition(event.seq === index + 1, `${roomId} event sequence is not contiguous at ${event.seq}`);
  });
};

const assertFinalReplay = (room: NonNullable<ReturnType<RoomManager["roomForRef"]>>): void => {
  assertCondition(room.game, `${room.id} finished without game state`);
  assertCondition(room.board, `${room.id} finished without board`);
  const replayed = replay({ config: room.game.config, board: room.board, events: room.events });
  assertCondition(stableStateHash(replayed) === stableStateHash(room.game), `${room.id} replay reconstruction differs from live state`);
};

export const runConcurrentBotRooms = async (): Promise<ConcurrentBotRoomSummary> => {
  assertCondition(roomCount === 5, "Concurrent isolation gate must run exactly five rooms");
  assertCondition(botsPerRoom === 4, "Concurrent isolation gate must run exactly four bots per room");

  const manager = new RoomManager(undefined, {
    automationStallTickLimit: 120,
    maxAutomatedCommandsPerMinute: 120,
    botTradeCooldownTurns: defaultRoomCleanupPolicy.botTradeCooldownTurns,
  });
  const eventBatches = new Map<string, Array<Extract<CommandResult, { ok: true }>>>();
  const automationRejections: Array<{ roomId: string; result: Extract<CommandResult, { ok: false }> }> = [];
  const scheduler = new RoomAutomationScheduler({
    manager,
    cleanupPolicy: {
      ...defaultRoomCleanupPolicy,
      automationStallTickLimit: 120,
      maxAutomatedCommandsPerMinute: 120,
    },
    logger: createStructuredLogger("concurrent-bot-rooms", "single", () => undefined),
    metrics: new MetricsRegistry("concurrent-bot-rooms", "single"),
    onEvents: (roomId, result) => {
      assertCondition(result.state.config.matchId === `match_${roomId}`, `${roomId} broadcast carried another room state`);
      const room = manager.rooms.get(roomId);
      assertCondition(room?.game, `${roomId} broadcast for missing game`);
      assertCondition(room.game.playerOrder.every((playerId) => result.state.playerOrder.includes(playerId)), `${roomId} broadcast player order mismatch`);
      eventBatches.set(roomId, [...(eventBatches.get(roomId) ?? []), result]);
    },
    onAutomationRejected: (roomId, result) => {
      automationRejections.push({ roomId, result });
    },
    onRoomClosed: (closed) => {
      throw new Error(`${closed.roomId} closed during concurrent bot gate: ${closed.cleanupReason ?? closed.status}`);
    },
  });

  const originalDateNow = Date.now;
  let fakeNow = Date.parse("2026-06-22T00:00:00.000Z");
  Date.now = () => fakeNow;
  try {
    const rooms = [];
    for (let roomIndex = 0; roomIndex < roomCount; roomIndex += 1) {
      const botIds = Array.from({ length: botsPerRoom }, (_, botIndex) => `bot_r${roomIndex + 1}_${botIndex + 1}` as PlayerId);
      const mapPreset = mapSequence[roomIndex % mapSequence.length]!;
      const room = await manager.createAllBotRoomForTest({
        mode: "CLASSIC",
        botFill: true,
        ranked: false,
        botDifficulty: "medium",
        rules: {
          mapPreset,
          mapRandomized: true,
          maxTurns,
          maxTurnAdjudication: "leader",
        },
      }, botIds);
      assertCondition(room.game?.playerOrder.join(",") === botIds.join(","), `${room.id} player order did not stay scoped to its bot ids`);
      rooms.push({ room, botIds, mapPreset });
    }
    for (const { room } of rooms) {
      delete room.pausedAt;
      delete room.pauseReason;
      delete room.emptySince;
      manager.refreshRoomDueWork(room.id, fakeNow);
    }

    let ticks = 0;
    while (rooms.some(({ room }) => room.game?.phase.type !== "GAME_OVER") && ticks < maxTicks) {
      const before = new Map(rooms.map(({ room }) => [room.id, {
        hash: room.game ? stableStateHash(room.game) : "",
        events: room.events.length,
        batches: eventBatches.get(room.id)?.length ?? 0,
      }]));
      fakeNow += tickMs;
      await scheduler.tickAutomation();
      ticks += 1;
      assertCondition(automationRejections.length === 0, `Bot automation rejected commands: ${JSON.stringify(automationRejections)}`);

      for (const { room, botIds } of rooms) {
        assertCondition(room.pauseReason !== "STALLED_AUTOMATION", `${room.id} stalled automation`);
        assertCondition(room.status === "IN_GAME" || room.status === "FINISHED", `${room.id} entered unexpected status ${room.status}`);
        assertCondition(room.game, `${room.id} lost game state`);
        assertCondition(room.game.playerOrder.join(",") === botIds.join(","), `${room.id} bot ids changed`);
        assertContiguousEvents(room.id, room.events);
        const previous = before.get(room.id);
        assertCondition(previous, `${room.id} missing before state`);
        const changed = stableStateHash(room.game) !== previous.hash;
        const newEvents = room.events.length > previous.events;
        const newBatches = (eventBatches.get(room.id)?.length ?? 0) > previous.batches;
        assertCondition(!changed || (newEvents && newBatches), `${room.id} state changed without a matching event broadcast`);
      }
    }

    assertCondition(ticks < maxTicks, `Concurrent bot rooms did not complete within ${maxTicks} ticks: ${JSON.stringify(rooms.map(({ room }) => ({
      roomId: room.id,
      status: room.status,
      pauseReason: room.pauseReason,
      phase: room.game?.phase,
      turn: room.game?.turn,
      events: room.events.length,
    })))}`);
    const results = rooms.map(({ room, botIds, mapPreset }) => {
      assertCondition(room.game?.phase.type === "GAME_OVER", `${room.id} did not reach GAME_OVER`);
      assertCondition(room.game.phase.reason === "TURN_LIMIT" || room.game.phase.reason === "VICTORY_POINTS", `${room.id} ended for an unexpected reason`);
      assertFinalReplay(room);
      return {
        roomId: room.id,
        code: room.code,
        mapPreset,
        botIds,
        events: room.events.length,
        turns: room.game.turn,
        winnerId: room.game.phase.winnerId,
      };
    });

    return {
      ok: true,
      roomCount,
      botsPerRoom,
      totalBots: roomCount * botsPerRoom,
      ticks,
      rooms: results,
    };
  } finally {
    Date.now = originalDateNow;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runConcurrentBotRooms()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
