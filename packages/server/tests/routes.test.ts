import { describe, expect, it } from "vitest";
import { buildServer, MemoryEventStore } from "../src/index.js";
import { RoomManager } from "../src/room-manager.js";

describe("REST routes", () => {
  it("serves public runtime config for deployed clients", async () => {
    const app = await buildServer({
      manager: new RoomManager(),
      publicApiBaseUrl: "https://api.play.example",
      publicWsBaseUrl: "wss://api.play.example",
      publicWebUrl: "https://play.example",
    });
    const response = await app.inject({ method: "GET", url: "/config" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 2,
      protocolVersion: 2,
      apiBaseUrl: "https://api.play.example",
      wsBaseUrl: "wss://api.play.example",
      webOrigin: "https://play.example",
      auth: { webSocket: "ticket" },
    });
  });

  it("reports health and accepts product analytics", async () => {
    const app = await buildServer({ manager: new RoomManager() });
    const health = await app.inject({ method: "GET", url: "/health" });
    const analytics = await app.inject({
      method: "POST",
      url: "/analytics",
      payload: { eventName: "test_event", payload: { mode: "test" } },
    });
    await app.close();

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });
    expect(["memory", "redis"]).toContain(health.json().presence);
    expect(analytics.statusCode).toBe(202);
  });

  it("lists match history and serves replay by room id or match id", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Host");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
    await manager.setReady(room.id, session, true);
    const app = await buildServer({ manager });

    const matchesResponse = await app.inject({ method: "GET", url: "/matches" });
    const matchResponse = await app.inject({ method: "GET", url: `/matches/match_${room.id}` });
    const unauthenticatedReplayResponse = await app.inject({ method: "GET", url: `/matches/${room.id}/replay` });
    const byRoomResponse = await app.inject({ method: "GET", url: `/matches/${room.id}/replay`, headers: { "x-session-token": session.token } });
    const byMatchResponse = await app.inject({ method: "GET", url: `/matches/match_${room.id}/replay`, headers: { "x-session-token": session.token } });
    await app.close();

    expect(matchesResponse.statusCode).toBe(200);
    expect(matchesResponse.json()[0]).toMatchObject({ id: `match_${room.id}`, roomId: room.id, eventCount: 0 });
    expect(matchResponse.statusCode).toBe(200);
    expect(matchResponse.json()).toMatchObject({ id: `match_${room.id}`, roomId: room.id });
    expect(unauthenticatedReplayResponse.statusCode).toBe(401);
    expect(byRoomResponse.statusCode).toBe(200);
    expect(byRoomResponse.json()).toMatchObject({ config: { matchId: `match_${room.id}` }, events: [] });
    expect(byMatchResponse.statusCode).toBe(200);
    expect(byMatchResponse.json()).toMatchObject({ config: { matchId: `match_${room.id}` }, events: [] });
  });

  it("creates moderation reports for seated users", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Reporter");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
    await manager.setReady(room.id, session, true);
    const app = await buildServer({ manager });
    const response = await app.inject({
      method: "POST",
      url: `/rooms/${room.id}/reports`,
      headers: { "x-session-token": session.token },
      payload: { reportedUserId: "bot_2", reason: "chat spam" },
    });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reporterUserId: session.userId, reportedUserId: "bot_2", status: "OPEN" });
  });

  it("issues websocket tickets only for authenticated sessions", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Ticketed");
    const app = await buildServer({ manager });

    const unauthenticated = await app.inject({ method: "POST", url: "/ws-tickets" });
    const authenticated = await app.inject({ method: "POST", url: "/ws-tickets", headers: { "x-session-token": session.token } });
    await app.close();

    expect(unauthenticated.statusCode).toBe(401);
    expect(authenticated.statusCode).toBe(201);
    expect(authenticated.json()).toMatchObject({ ticket: expect.stringMatching(/^wst_/), ttlMs: 30_000 });
  });

  it("issues websocket tickets for persisted sessions after a manager restart", async () => {
    const store = new MemoryEventStore();
    const originalManager = new RoomManager(store);
    const session = await originalManager.createSession("Persisted");
    const restartedManager = new RoomManager(store);
    const app = await buildServer({ manager: restartedManager });

    const response = await app.inject({ method: "POST", url: "/ws-tickets", headers: { "x-session-token": session.token } });
    await app.close();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ ticket: expect.stringMatching(/^wst_/) });
    expect(restartedManager.getSession(session.token)?.userId).toBe(session.userId);
  });

  it("keeps classic player rooms human-only until all four occupied seats are ready", async () => {
    const manager = new RoomManager();
    const sessions = await Promise.all(["Host", "Guest 1", "Guest 2", "Guest 3"].map((name) => manager.createSession(name)));
    const [host, guestOne, guestTwo, guestThree] = sessions;
    if (!host || !guestOne || !guestTwo || !guestThree) throw new Error("missing test sessions");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });

    const hostReady = await manager.setReady(room.id, host, true);
    expect(hostReady.ok).toBe(true);
    expect(room.status).toBe("LOBBY");
    expect(room.seats.some((seat) => seat.botId)).toBe(false);

    for (const guest of [guestOne, guestTwo, guestThree]) {
      const joined = await manager.joinRoom(room.id, guest);
      expect(joined.ok).toBe(true);
    }
    const secondReady = await manager.setReady(room.id, guestOne, true);
    expect(secondReady.ok).toBe(true);
    expect(room.status).toBe("LOBBY");
    const thirdReady = await manager.setReady(room.id, guestTwo, true);
    expect(thirdReady.ok).toBe(true);
    expect(room.status).toBe("LOBBY");
    const fourthReady = await manager.setReady(room.id, guestThree, true);
    expect(fourthReady.ok).toBe(true);

    expect(room.status).toBe("IN_GAME");
    expect(room.game?.playerOrder).toEqual(sessions.map((session) => session.userId));
    expect(room.seats.some((seat) => seat.botId)).toBe(false);
  });
});
