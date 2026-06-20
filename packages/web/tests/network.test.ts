import { afterEach, describe, expect, it, vi } from "vitest";
import { createNetworkClient } from "../src/network.js";

afterEach(() => {
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
});
