// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoGame } from "@colonizt/demo-state";
import { serializeForViewer, type GameEvent } from "@colonizt/game-core";
import type { PublicRoomPayload } from "@colonizt/protocol";
import type { NetworkClient } from "../src/network.js";
import {
  SessionController,
  reconcileServerUpdate,
} from "../src/session-controller.js";
import { readResumeState } from "../src/resume.js";
import { createMemoryStorage } from "./memory-storage.js";
vi.mock("../src/analytics.js", () => ({
  track: vi.fn(),
  platform: () => "desktop",
}));
const game = createDemoGame("recovery");
const snapshot = (eventSeq: number) => ({
  ...serializeForViewer(game, "p1"),
  eventSeq,
});
const event = (seq: number) =>
  ({
    type: "TURN_ENDED",
    seq,
    playerId: "p1",
    nextPlayerId: "p2",
    turn: 1,
  }) as GameEvent;
const room = (seq = 0): PublicRoomPayload => ({
  id: "room_1",
  code: "PLAY01",
  status: "IN_GAME",
  game: snapshot(seq),
});
const command = { type: "ROLL_DICE" as const, playerId: "p1" };
const controllers: SessionController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  controllers.forEach((c) => c.stop());
  controllers.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const harness = () => {
  const connections: Array<{
    handlers: Parameters<NetworkClient["connect"]>[1];
    signal: AbortSignal | undefined;
    socket: WebSocket;
    send: ReturnType<typeof vi.fn>;
  }> = [];
  const client = {
    connect: vi.fn((_token, handlers, signal) => {
      const send = vi.fn();
      const socket = {
        readyState: 1,
        send,
        close: vi.fn(),
      } as unknown as WebSocket;
      connections.push({ handlers, signal, socket, send });
      return Promise.resolve(socket);
    }),
    sendCommand: vi.fn(),
  } as unknown as NetworkClient;
  const callbacks = {
    onRoom: vi.fn(),
    onEvents: vi.fn(),
    onError: vi.fn(),
    onConfirmed: vi.fn(),
  };
  const controller = new SessionController(client);
  controllers.push(controller);
  const start = () =>
    controller.start(
      { token: "token", userId: "p1" },
      "PLAY01",
      false,
      callbacks,
    );
  const open = (seq = 0) => {
    const latest = connections.at(-1)!;
    latest.handlers.onOpen?.(latest.socket);
    latest.handlers.onRoom(room(seq));
    return latest;
  };
  return { controller, client, callbacks, connections, start, open };
};

it.each([
  { sample: 0, delay: 750 },
  { sample: 249, delay: 999 },
])("keeps reconnect jitter within the backoff window for random sample $sample", async ({ sample, delay }) => {
  vi.spyOn(crypto, "getRandomValues").mockReturnValue(new Uint8Array([sample]));
  const h = harness();
  h.start();
  h.open().handlers.onClose?.();

  expect(h.controller.getSnapshot()).toMatchObject({ state: "retrying", retryAt: 100_000 + delay });
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(h.client.connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.connect).toHaveBeenCalledTimes(2);
});

it("rejects random bytes outside the reconnect jitter range", () => {
  const random = vi.spyOn(crypto, "getRandomValues")
    .mockReturnValueOnce(new Uint8Array([250]))
    .mockReturnValueOnce(new Uint8Array([255]))
    .mockReturnValue(new Uint8Array([249]));
  const h = harness();
  h.start();
  h.open().handlers.onClose?.();
  expect(random).toHaveBeenCalledTimes(3);
  expect(h.controller.getSnapshot()).toMatchObject({ state: "retrying", retryAt: 100_999 });
});

describe("authoritative stream reconciliation", () => {
  it("deduplicates overlaps and rejects holes anywhere in a batch", () => {
    expect(
      reconcileServerUpdate(2, [event(2), event(4), event(3), event(3)]),
    ).toMatchObject({ gap: false, lastSeq: 4, events: [event(3), event(4)] });
    expect(reconcileServerUpdate(2, [event(3), event(5)])).toMatchObject({
      gap: true,
      lastSeq: 2,
    });
  });
  it("replaces with a canonical snapshot without reducing its event prefix", () => {
    expect(
      reconcileServerUpdate(2, [event(3), event(4), event(5)], snapshot(4)),
    ).toMatchObject({
      gap: false,
      lastSeq: 5,
      events: [event(5)],
      snapshot: snapshot(4),
    });
    expect(reconcileServerUpdate(5, [event(2)], snapshot(2))).toMatchObject({
      gap: false,
      lastSeq: 5,
      events: [],
      snapshot: undefined,
    });
  });
});
describe("session recovery", () => {
  it("gates actions until joined and allows only one outstanding command", () => {
    const h = harness();
    expect(h.controller.send(command)).toBe(false);
    h.start();
    expect(h.controller.getSnapshot().state).toBe("connecting");
    const connection = h.open(4);
    expect(h.controller.getSnapshot().state).toBe("connected");
    expect(h.controller.send(command)).toBe(true);
    expect(h.controller.send(command)).toBe(false);
    expect(h.client.sendCommand).toHaveBeenCalledWith(
      connection.socket,
      "room_1",
      1,
      command,
      4,
    );
    expect(readResumeState()).toMatchObject({
      clientSeq: 2,
      lastSeq: 4,
      pendingCommand: { clientSeq: 1, command, expectedEventSeq: 4 },
    });
  });
  it("does not clear a pending action for unrelated events or acknowledgements", () => {
    const h = harness();
    h.start();
    const c = h.open();
    h.controller.send(command);
    c.handlers.onEvents([event(1)], snapshot(1));
    c.handlers.onAck?.({
      type: "COMMAND_ACK",
      roomId: "room_1",
      clientSeq: 99,
      seqEnd: 1,
    });
    c.handlers.onAck?.({
      type: "COMMAND_ACK",
      roomId: "another_room",
      clientSeq: 1,
      seqEnd: 1,
    });
    expect(h.controller.getSnapshot().pending).toBe(1);
    c.handlers.onAck?.({
      type: "COMMAND_ACK",
      roomId: "room_1",
      clientSeq: 1,
      seqEnd: 1,
    });
    expect(h.callbacks.onConfirmed).toHaveBeenCalledExactlyOnceWith(command);
    expect(readResumeState()?.pendingCommand).toBeUndefined();
  });
  it("recovers a lost acknowledgement with the original identity after a fresh snapshot", async () => {
    const h = harness();
    h.start();
    const c = h.open();
    h.controller.send(command);
    c.handlers.onEvents([event(1)], snapshot(1));
    c.handlers.onClose?.();
    expect(h.controller.getSnapshot().state).toBe("retrying");
    await vi.advanceTimersByTimeAsync(1100);
    const fresh = h.open(1);
    expect(h.client.sendCommand).toHaveBeenLastCalledWith(
      fresh.socket,
      "room_1",
      1,
      command,
      0,
    );
    fresh.handlers.onAck?.({
      type: "COMMAND_ACK",
      roomId: "room_1",
      clientSeq: 1,
      seqEnd: 1,
    });
    expect(h.callbacks.onConfirmed).toHaveBeenCalledTimes(1);
  });
  it("waits for acknowledged events and sends only one outstanding resync", () => {
    const h = harness();
    h.start();
    const c = h.open();
    h.controller.send(command);
    c.handlers.onAck?.({
      type: "COMMAND_ACK",
      roomId: "room_1",
      clientSeq: 1,
      seqEnd: 2,
    });
    c.handlers.onEvents([event(4)]);
    c.handlers.onEvents([event(5)]);
    expect(
      c.send.mock.calls.filter(([v]) => JSON.parse(v).type === "RESYNC"),
    ).toHaveLength(1);
    expect(h.callbacks.onConfirmed).not.toHaveBeenCalled();
    expect(h.controller.send(command)).toBe(false);
    c.handlers.onEvents([], snapshot(2));
    expect(h.callbacks.onConfirmed).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot().state).toBe("connected");
  });
  it("keeps old snapshots and old socket callbacks from rolling the board backwards", () => {
    const h = harness();
    h.start();
    const old = h.open(8);
    old.handlers.onEvents([], snapshot(4));
    expect(h.callbacks.onEvents).toHaveBeenLastCalledWith(
      [],
      undefined,
      undefined,
    );
    h.controller.retry();
    h.open(9);
    const count = h.callbacks.onRoom.mock.calls.length;
    old.handlers.onRoom(room(3));
    old.handlers.onClose?.();
    old.handlers.onError({ code: "UNAUTHORIZED" });
    expect(h.callbacks.onRoom).toHaveBeenCalledTimes(count);
    expect(h.controller.lastServerSeqRef.current).toBe(9);
    expect(h.controller.getSnapshot().state).toBe("connected");
    expect(old.signal?.aborted).toBe(true);
  });
  it("only replaces timers with accepted snapshots or fresh incremental events", () => {
    const h = harness();
    h.start();
    const c = h.open(8);
    const currentTimer = { activePlayerId: "p2", expiresAt: 300_000 };
    const staleTimer = { activePlayerId: "p1", expiresAt: 150_000 };
    c.handlers.onEvents([], snapshot(8), currentTimer);
    expect(h.callbacks.onEvents).toHaveBeenLastCalledWith([], snapshot(8), currentTimer);

    c.handlers.onEvents([event(4)], snapshot(4), staleTimer);
    expect(h.callbacks.onEvents).toHaveBeenLastCalledWith([], undefined, undefined);
    expect(h.controller.lastServerSeqRef.current).toBe(8);

    // Even if an unseen event tail is usable, a rejected snapshot's timer is not.
    c.handlers.onEvents([event(9)], snapshot(4), staleTimer);
    expect(h.callbacks.onEvents).toHaveBeenLastCalledWith([event(9)], undefined, undefined);
    c.handlers.onEvents([event(9)], undefined, staleTimer);
    expect(h.callbacks.onEvents).toHaveBeenLastCalledWith([], undefined, undefined);
    c.handlers.onEvents([], undefined, staleTimer);
    expect(h.callbacks.onEvents).toHaveBeenLastCalledWith([], undefined, undefined);

    c.handlers.onEvents([event(10)], undefined, currentTimer);
    expect(h.callbacks.onEvents).toHaveBeenLastCalledWith([event(10)], undefined, currentTimer);
    // An authoritative resync can refresh a deadline without advancing the cursor.
    const refreshedTimer = { ...currentTimer, expiresAt: 320_000 };
    c.handlers.onEvents([], snapshot(10), refreshedTimer);
    expect(h.callbacks.onEvents).toHaveBeenLastCalledWith([], snapshot(10), refreshedTimer);
  });
  it("retains the seat across pagehide/pageshow and offline/online transitions", () => {
    const h = harness();
    h.start();
    h.open(3);
    window.dispatchEvent(new Event("pagehide"));
    expect(h.controller.getSnapshot().state).toBe("offline");
    expect(readResumeState()).toMatchObject({
      roomId: "room_1",
      userId: "p1",
      lastSeq: 3,
    });
    window.dispatchEvent(new Event("pageshow"));
    h.open(4);
    window.dispatchEvent(new Event("offline"));
    expect(h.controller.getSnapshot().state).toBe("offline");
    window.dispatchEvent(new Event("online"));
    h.open(5);
    expect(h.connections).toHaveLength(3);
    expect(h.controller.lastServerSeqRef.current).toBe(5);
  });
  it("resumes on visibility restoration and stops listening after disposal", () => {
    const h = harness();
    h.start();
    h.open();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.connections).toHaveLength(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.connections).toHaveLength(2);
    h.controller.stop();
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.connections).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a stale action visibly and resumes only after resync", () => {
    const h = harness();
    h.start();
    const c = h.open();
    h.controller.send(command);
    const error = {
      type: "COMMAND_REJECTED",
      clientSeq: 1,
      code: "STALE_STATE",
    };
    c.handlers.onError(error);
    expect(h.callbacks.onError).toHaveBeenCalledWith(error);
    expect(h.controller.pendingCommand).toBeUndefined();
    expect(h.controller.getSnapshot().state).toBe("synchronizing");
    c.handlers.onEvents([], snapshot(2));
    expect(h.controller.send(command)).toBe(true);
  });
  it("bounds join and acknowledgement waits, with fresh sockets on retry", async () => {
    const h = harness();
    h.start();
    const c = h.connections[0]!;
    c.handlers.onOpen?.(c.socket);
    await vi.advanceTimersByTimeAsync(11_100);
    expect(h.connections).toHaveLength(2);
    h.open();
    h.controller.send(command);
    await vi.advanceTimersByTimeAsync(11_100);
    expect(h.connections).toHaveLength(3);
    expect(h.controller.pendingCommand?.clientSeq).toBe(1);
  });
  it("clears a terminal session and cannot revive it through browser events", () => {
    const h = harness();
    h.start();
    const c = h.open();
    h.controller.send(command);
    c.handlers.onError({ code: "UNAUTHORIZED" });
    expect(h.controller.getSnapshot().state).toBe("expired");
    window.dispatchEvent(new Event("online"));
    expect(h.connections).toHaveLength(1);
    expect(h.controller.pendingCommand).toBeUndefined();
  });
  it("retains a restored pending command and publishes clock updates", () => {
    const h = harness();
    h.controller.pendingCommand = {
      clientSeq: 4,
      expectedEventSeq: 8,
      command,
    };
    h.controller.clientSeqRef.current = 5;
    h.start();
    const c = h.open(9);
    c.handlers.onClock?.(120_000);
    expect(h.controller.getSnapshot()).toMatchObject({
      pending: 1,
      clockOffsetMs: 120_000,
    });
    expect(h.client.sendCommand).toHaveBeenCalledWith(
      c.socket,
      "room_1",
      4,
      command,
      8,
    );
  });
  it("does not retransmit a pending action for duplicate room broadcasts", () => {
    const h = harness();
    h.start();
    const c = h.open();
    h.controller.send(command);
    c.handlers.onRoom(room(0));
    c.handlers.onRoom(room(1));
    expect(h.client.sendCommand).toHaveBeenCalledTimes(1);
  });
  it("backs off to a bounded pause and supports an explicit retry", async () => {
    vi.spyOn(crypto, "getRandomValues").mockReturnValue(new Uint8Array([0]));
    const h = harness();
    h.start();
    for (let attempt = 0; attempt < 8; attempt++) {
      h.connections.at(-1)!.handlers.onClose?.();
      await vi.advanceTimersByTimeAsync(Math.min(15_000, 750 * 2 ** attempt));
    }
    h.connections.at(-1)!.handlers.onClose?.();
    expect(h.controller.getSnapshot()).toMatchObject({
      state: "retrying",
      retryAt: null,
    });
    expect(h.connections).toHaveLength(9);
    expect(vi.getTimerCount()).toBe(0);
    h.controller.retry();
    expect(h.connections).toHaveLength(10);
  });
  it("avoids network attempts while offline and ignores late connection promises", async () => {
    const h = harness();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    h.start();
    expect(h.connections).toHaveLength(0);
    expect(h.controller.getSnapshot().state).toBe("offline");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    h.controller.retry();
    const old = h.connections[0]!;
    h.controller.retry();
    old.handlers.onOpen?.(old.socket);
    old.handlers.onEvents([], snapshot(9));
    old.handlers.onClock?.(999);
    await Promise.resolve();
    expect(old.socket.close).toHaveBeenCalled();
    expect(h.controller.lastServerSeqRef.current).toBe(0);
    expect(h.controller.getSnapshot().clockOffsetMs).toBe(0);
  });
  it("recovers from malformed joins, stale snapshots, and stalled resyncs", async () => {
    const h = harness();
    h.start();
    const c = h.open(8);
    c.handlers.onRoom(room(7));
    c.handlers.onRoom(room(6));
    expect(
      c.send.mock.calls.filter(([v]) => JSON.parse(v).type === "RESYNC"),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(11_100);
    expect(h.connections).toHaveLength(2);
    h.connections[1]!.handlers.onRoom({});
    expect(h.controller.getSnapshot().state).toBe("retrying");
  });
  it("preserves pending commands when transmission throws", () => {
    const h = harness();
    h.start();
    h.open();
    vi.mocked(h.client.sendCommand).mockImplementationOnce(() => {
      throw new Error("Socket closed");
    });
    expect(h.controller.send(command)).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({
      state: "retrying",
      pending: 1,
    });
  });
  it("handles rejected connection promises without reviving expired sessions", async () => {
    const h = harness();
    vi.mocked(h.client.connect).mockRejectedValueOnce(new Error("Unavailable"));
    h.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.controller.getSnapshot().state).toBe("retrying");
    vi.mocked(h.client.connect).mockRejectedValueOnce({ code: "UNAUTHORIZED" });
    h.controller.retry();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.controller.getSnapshot().state).toBe("expired");
    expect(h.callbacks.onError).toHaveBeenCalledTimes(2);
  });
});
