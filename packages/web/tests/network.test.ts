import { afterEach, describe, expect, it, vi } from "vitest";
import { createNetworkClient, resolveRuntimeConfig } from "../src/network.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("network client", () => {
  it("prefers same-origin runtime API config over build-time fallback", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/config") {
        return new Response(JSON.stringify({
          apiBaseUrl: "https://same-origin-api.example",
          wsBaseUrl: "wss://same-origin-socket.example",
        }), { status: 200 });
      }
      if (url === "https://same-origin-api.example/matches?limit=7") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    await expect(createNetworkClient("https://bootstrap-primary.example").listMatches(7)).resolves.toEqual([]);
    expect(requests).toEqual(["/config", "https://same-origin-api.example/matches?limit=7"]);
  });

  it("falls back to build-time runtime API config when same-origin config is unavailable", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://bootstrap.example/config") {
        return new Response(JSON.stringify({
          apiBaseUrl: "https://api.example",
          wsBaseUrl: "wss://socket.example",
        }), { status: 200 });
      }
      if (url === "https://api.example/matches?limit=7") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    await expect(createNetworkClient("https://bootstrap.example").listMatches(7)).resolves.toEqual([]);
    expect(requests).toEqual(["/config", "https://bootstrap.example/config", "https://api.example/matches?limit=7"]);
  });

  it("keeps the configured endpoint usable when runtime config cannot be fetched offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(resolveRuntimeConfig("https://offline-fallback.example/")).resolves.toEqual({
      apiBaseUrl: "https://offline-fallback.example",
      wsBaseUrl: "wss://offline-fallback.example",
    });
  });

  it("sends selected map presets in room creation payloads", async () => {
    let roomPayload: unknown;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://room-bootstrap.example/config") {
        return new Response(JSON.stringify({
          apiBaseUrl: "https://room-api.example",
          wsBaseUrl: "wss://room-socket.example",
        }), { status: 200 });
      }
      if (url === "https://room-api.example/rooms") {
        roomPayload = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ id: "room_1", code: "ABC123" }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }));

    await expect(createNetworkClient("https://room-bootstrap.example").createRoom("s1", {
      mode: "CLASSIC",
      botFill: false,
      ranked: false,
      minPlayers: 4,
      maxPlayers: 4,
      rules: { mapPreset: "continent", mapRandomized: true },
    })).resolves.toMatchObject({ id: "room_1" });
    expect(roomPayload).toMatchObject({
      mode: "CLASSIC",
      botFill: false,
      ranked: false,
      minPlayers: 4,
      maxPlayers: 4,
      rules: { mapPreset: "continent", mapRandomized: true },
    });
  });

  it("preserves structured replay load errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://replay-bootstrap.example/config") {
        return new Response(JSON.stringify({
          apiBaseUrl: "https://replay-api.example",
          wsBaseUrl: "wss://replay-socket.example",
        }), { status: 200 });
      }
      if (url === "https://replay-api.example/matches/match_1/replay") {
        return new Response(JSON.stringify({ code: "REPLAY_NOT_READY", message: "Replay is available after the game is finished" }), { status: 409 });
      }
      return new Response("not found", { status: 404 });
    }));

    await expect(createNetworkClient("https://replay-bootstrap.example").loadReplay("match_1", "s1")).rejects.toMatchObject({
      code: "REPLAY_NOT_READY",
      message: "Replay is available after the game is finished",
      status: 409,
    });
  });

  it("uses advertised runtime WSS config for websocket connections", async () => {
    class FakeWebSocket {
      static readonly OPEN = 1;
      static readonly urls: string[] = [];
      readonly readyState = FakeWebSocket.OPEN;
      private readonly listeners = new Map<string, Array<() => void>>();

      constructor(readonly url: string) {
        FakeWebSocket.urls.push(url);
        queueMicrotask(() => this.emit("open"));
      }

      addEventListener(event: string, listener: () => void): void {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      }

      send(): void {
        return;
      }

      close(): void {
        this.emit("close");
      }

      private emit(event: string): void {
        for (const listener of this.listeners.get(event) ?? []) listener();
      }
    }

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://bootstrap-ws.example/config") {
        return new Response(JSON.stringify({
          apiBaseUrl: "https://api-ws.example",
          wsBaseUrl: "wss://socket-ws.example",
        }), { status: 200 });
      }
      if (url === "https://api-ws.example/ws-tickets") {
        return new Response(JSON.stringify({ ticket: "ticket_1", expiresAt: "2026-06-17T00:00:00.000Z", ttlMs: 30_000 }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }));
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const socket = await createNetworkClient("https://bootstrap-ws.example").connect("token", {
      onEvents: () => undefined,
      onRoom: () => undefined,
      onError: () => undefined,
    });

    expect(FakeWebSocket.urls).toEqual(["wss://socket-ws.example/ws?ticket=ticket_1"]);
    socket.close();
  });

  it("sends heartbeats only while a websocket remains open", async () => {
    vi.useFakeTimers();
    class FakeWebSocket {
      static readonly OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      readonly sent: string[] = [];
      private readonly listeners = new Map<string, Array<() => void>>();

      constructor(readonly url: string) {
        queueMicrotask(() => this.emit("open"));
      }

      addEventListener(event: string, listener: () => void): void {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      }

      send(payload: string): void {
        this.sent.push(payload);
      }

      close(): void {
        this.readyState = 3;
        this.emit("close");
      }

      private emit(event: string): void {
        for (const listener of this.listeners.get(event) ?? []) listener();
      }
    }

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://heartbeat-bootstrap.example/config") {
        return new Response(JSON.stringify({
          apiBaseUrl: "https://heartbeat-api.example",
          wsBaseUrl: "wss://heartbeat-socket.example",
        }), { status: 200 });
      }
      if (url === "https://heartbeat-api.example/ws-tickets") {
        return new Response(JSON.stringify({ ticket: "heartbeat_ticket", expiresAt: "2026-06-17T00:00:00.000Z", ttlMs: 30_000 }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }));
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const socket = await createNetworkClient("https://heartbeat-bootstrap.example").connect("token", {
      onEvents: () => undefined,
      onRoom: () => undefined,
      onError: () => undefined,
    }) as unknown as FakeWebSocket;
    await Promise.resolve();
    vi.advanceTimersByTime(15_000);

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "PING" });
    socket.close();
    vi.advanceTimersByTime(30_000);
    expect(socket.sent).toHaveLength(1);
  });

  it("returns typed room preflight results", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://lookup-bootstrap.example/config") {
        return new Response(JSON.stringify({
          apiBaseUrl: "https://lookup-api.example",
          wsBaseUrl: "wss://lookup-socket.example",
        }), { status: 200 });
      }
      if (url === "https://lookup-api.example/rooms/ABC123") {
        return new Response(JSON.stringify({ id: "room_1", code: "ABC123", status: "LOBBY" }), { status: 200 });
      }
      if (url === "https://lookup-api.example/rooms/CLOSED") {
        return new Response(JSON.stringify({ code: "ROOM_EXPIRED", status: "EXPIRED", cleanupReason: "EMPTY_LOBBY_TTL" }), { status: 410 });
      }
      return new Response("not found", { status: 404 });
    }));

    const client = createNetworkClient("https://lookup-bootstrap.example");

    await expect(client.getRoom("ABC123")).resolves.toMatchObject({ ok: true, room: { id: "room_1", code: "ABC123" } });
    await expect(client.getRoom("CLOSED")).resolves.toEqual({
      ok: false,
      code: "ROOM_EXPIRED",
      status: "EXPIRED",
      cleanupReason: "EMPTY_LOBBY_TTL",
    });
  });

  it("dispatches websocket protocol frames and reports malformed frames", async () => {
    class FakeWebSocket {
      static readonly OPEN = 1;
      readonly readyState = FakeWebSocket.OPEN;
      private readonly listeners = new Map<string, Array<(event?: { data?: unknown }) => void>>();

      addEventListener(event: string, listener: (event?: { data?: unknown }) => void): void {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      }

      send(): void {
        return;
      }

      close(): void {
        this.emit("close");
      }

      emit(event: string, data?: unknown): void {
        for (const listener of this.listeners.get(event) ?? []) listener({ data });
      }
    }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://frames-bootstrap.example/config") {
        return new Response(JSON.stringify({ apiBaseUrl: "https://frames-api.example", wsBaseUrl: "wss://frames-socket.example" }), { status: 200 });
      }
      if (url === "https://frames-api.example/ws-tickets") {
        return new Response(JSON.stringify({ ticket: "frames_ticket", expiresAt: "2026-06-17T00:00:00.000Z", ttlMs: 30_000 }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onEvents = vi.fn();
    const onRoom = vi.fn();
    const onError = vi.fn();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const onAck = vi.fn();
    const socket = await createNetworkClient("https://frames-bootstrap.example").connect("token", { onEvents, onRoom, onError, onOpen, onClose, onAck }) as unknown as FakeWebSocket;

    socket.emit("open");
    socket.emit("message", "not json");
    socket.emit("message", JSON.stringify({ type: "EVENTS" }));
    socket.emit("message", JSON.stringify({ type: "RESYNC", events: [{ seq: 1 }], snapshot: { phase: "TEST" } }));
    socket.emit("message", JSON.stringify({ type: "ROOM_STATE", room: { id: "room_1" } }));
    socket.emit("message", JSON.stringify({ type: "COMMAND_ACK" }));
    socket.emit("message", JSON.stringify({ type: "ERROR", code: "ROOM_ERROR" }));
    socket.emit("message", JSON.stringify({ type: "COMMAND_REJECTED", code: "ILLEGAL_COMMAND" }));
    socket.emit("message", JSON.stringify({ type: "UNRECOGNIZED" }));
    socket.close();

    expect(onOpen).toHaveBeenCalledWith(socket);
    expect(onEvents).toHaveBeenNthCalledWith(1, [], undefined);
    expect(onEvents).toHaveBeenNthCalledWith(2, [{ seq: 1 }], { phase: "TEST" });
    expect(onRoom).toHaveBeenCalledWith({ id: "room_1" });
    expect(onAck).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenNthCalledWith(1, { type: "ERROR", code: "BAD_JSON" });
    expect(onError).toHaveBeenNthCalledWith(2, { type: "ERROR", code: "ROOM_ERROR" });
    expect(onError).toHaveBeenNthCalledWith(3, { type: "COMMAND_REJECTED", code: "ILLEGAL_COMMAND" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("creates sessions, sends commands, and preserves endpoint failure behavior", async () => {
    const sent: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, init });
      if (url === "https://operations-bootstrap.example/config") {
        return new Response(JSON.stringify({ apiBaseUrl: "https://operations-api.example", wsBaseUrl: "wss://operations-socket.example" }), { status: 200 });
      }
      if (url === "https://operations-api.example/sessions") {
        return new Response(JSON.stringify({ token: "token_1", userId: "p1", displayName: "Ada" }), { status: 201 });
      }
      if (url === "https://operations-api.example/rooms") return new Response("denied", { status: 403 });
      if (url === "https://operations-api.example/matches?limit=12") return new Response("failed", { status: 500 });
      if (url === "https://operations-api.example/ws-tickets") return new Response("failed", { status: 401 });
      if (url === "https://operations-api.example/rooms/MISSING") return new Response("not-json", { status: 404 });
      if (url === "https://operations-api.example/matches/missing/replay") return new Response("not-json", { status: 404 });
      return new Response("not found", { status: 404 });
    }));
    const client = createNetworkClient("https://operations-bootstrap.example");

    await expect(client.createSession("Ada")).resolves.toMatchObject({ token: "token_1", displayName: "Ada" });
    await expect(client.createRoom("token_1")).rejects.toThrow("Room creation failed");
    await expect(client.listMatches()).rejects.toThrow("Match history failed");
    await expect(client.createWebSocketTicket("token_1")).rejects.toThrow("WebSocket ticket creation failed");
    await expect(client.getRoom("MISSING")).resolves.toEqual({ ok: false, code: "ROOM_NOT_FOUND" });
    await expect(client.loadReplay("missing")).rejects.toEqual({
      code: "REPLAY_NOT_FOUND", message: "Replay load failed", status: 404,
    });

    const socket = { send: vi.fn() } as unknown as WebSocket;
    client.sendCommand(socket, "room_1", 9, { type: "ROLL_DICE", playerId: "p1" });
    expect(JSON.parse((socket.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toEqual({
      type: "COMMAND", roomId: "room_1", clientSeq: 9, command: { type: "ROLL_DICE", playerId: "p1" },
    });
    expect(JSON.parse(String(sent.find((request) => request.url.endsWith("/sessions"))?.init?.body))).toEqual({ displayName: "Ada" });
  });
});
