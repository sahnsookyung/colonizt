import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedFetch, createNetworkClient } from "../src/network.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
class Socket extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  sent: Array<{ type: string; nonce?: string }> = [];
  close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  });
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  receive(data: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
}
const connection = async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ticket: "ticket" }))),
  );
  const handlers = {
    onEvents: vi.fn(),
    onRoom: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    onClock: vi.fn(),
    onAck: vi.fn(),
  };
  const abort = new AbortController();
  const socket = (await createNetworkClient().connect(
    "session",
    handlers,
    abort.signal,
  )) as unknown as Socket;
  socket.dispatchEvent(new Event("open"));
  return { socket, handlers, abort };
};
describe("bounded transport recovery", () => {
  it("closes a half-open socket when heartbeat replies are missing", async () => {
    const { socket, handlers } = await connection();
    socket.receive({ type: "PONG", nonce: "unrelated", serverTime: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handlers.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "HEARTBEAT_TIMEOUT" }),
    );
    expect(socket.close).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledOnce();
    socket.receive({ type: "ROOM_STATE", room: {} });
    expect(handlers.onRoom).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("adjusts the clock from matched PONG replies and cleans up all deadlines", async () => {
    const { socket, handlers, abort } = await connection();
    await vi.advanceTimersByTimeAsync(200);
    socket.receive({
      type: "PONG",
      nonce: socket.sent[0]!.nonce,
      serverTime: 1_120_100,
    });
    expect(handlers.onClock).toHaveBeenCalledWith(120_000);
    await vi.advanceTimersByTimeAsync(14_800);
    expect(socket.sent).toHaveLength(2);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
    socket.receive({ type: "COMMAND_ACK", clientSeq: 1 });
    expect(handlers.onAck).not.toHaveBeenCalled();
  });
  it("bounds both response headers and stalled bodies", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const headers = expect(boundedFetch("/headers")).rejects.toThrow(
      "timed out",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await headers;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ start() {} }))),
    );
    const body = expect(boundedFetch("/body")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await body;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels immediately even when a fetch implementation ignores its signal", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const abort = new AbortController();
    const request = expect(
      boundedFetch("/cancel", { signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await request;
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      boundedFetch("/already-cancelled", { signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("requires the recovery contract and refetches config after a server upgrade", async () => {
    let version = 3;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("config")
                ? {
                    protocolVersion: version,
                    apiBaseUrl: "https://version.example",
                    wsBaseUrl: "wss://version.example",
                  }
                : { ticket: "ticket" },
            ),
          ),
      ),
    );
    vi.stubGlobal("WebSocket", Socket);
    const client = createNetworkClient("https://version.example");
    const handlers = { onEvents: vi.fn(), onRoom: vi.fn(), onError: vi.fn() };
    const incompatibleConnection = client.connect("session", handlers);
    await expect(incompatibleConnection).rejects.toBeInstanceOf(Error);
    await expect(incompatibleConnection).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
      message: "The game server needs an update. Please try again shortly.",
    });
    version = 4;
    const socket = await client.connect("session", handlers);
    socket.close();
  });
});
