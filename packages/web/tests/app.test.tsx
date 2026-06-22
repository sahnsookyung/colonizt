// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeSetup, createDemoGame } from "@colonizt/demo-state";
import { emptyResources, serializeForViewer, type GameState } from "@colonizt/game-core";
import { App } from "../src/App.js";
import { clearResumeState } from "../src/resume.js";

afterEach(() => {
  cleanup();
  clearResumeState(window.localStorage);
  window.history.replaceState({}, "", "/");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const placeHumanSetup = () => {
  fireEvent.click(screen.getAllByRole("button", { name: /Place setup settlement at corner/ })[0]!);
  fireEvent.click(screen.getAllByRole("button", { name: /Build road here/ })[0]!);
};

const advanceTimersUntil = (predicate: () => boolean, stepMs = 500, maxSteps = 24) => {
  for (let index = 0; index < maxSteps; index += 1) {
    if (predicate()) return;
    act(() => {
      vi.advanceTimersByTime(stepMs);
    });
  }
  if (!predicate()) throw new Error("Timed out waiting for UI state");
};

const completeLocalSetup = () => {
  vi.useFakeTimers();
  placeHumanSetup();
  advanceTimersUntil(() => screen.queryByText("Place setup settlement") !== null);
  placeHumanSetup();
  expect(screen.getByText(/WAITING FOR ROLL|ACTION PHASE/)).toBeInTheDocument();
};

const moveRobberIfPrompted = () => {
  if (!screen.queryByLabelText("Move robber")) return;
  const target = screen.getAllByRole("button", { name: /Move robber to/ })[0];
  if (target) fireEvent.click(target);
};

const renderOnlineGame = async (game: GameState) => {
  const sentMessages: Array<{ type: string; command?: unknown }> = [];
  const room = {
    id: `room_${game.config.matchId}`,
    code: "PLAY01",
    inviteUrl: "https://play.example/?room=PLAY01",
    status: "ACTIVE",
    hostUserId: "p1",
    settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4, botDifficulty: "medium", rules: game.config.rules },
    seats: [
      { seatIndex: 0, userId: "p1", ready: true, connected: true },
      { seatIndex: 1, userId: "p2", ready: true, connected: true },
      { seatIndex: 2, userId: "p3", ready: true, connected: true },
      { seatIndex: 3, userId: "p4", ready: true, connected: true },
    ],
    spectatorCount: 0,
    events: [],
    game: serializeForViewer(game, "p1"),
  };

  class FakeWebSocket extends EventTarget {
    static readonly OPEN = 1;
    readyState = FakeWebSocket.OPEN;

    constructor(readonly url: string) {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send(payload: string): void {
      const message = JSON.parse(payload) as { type: string; command?: unknown };
      sentMessages.push(message);
      if (message.type === "JOIN_ROOM") {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room }) })));
      }
    }

    close(): void {
      this.dispatchEvent(new Event("close"));
    }
  }

  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/sessions")) return new Response(JSON.stringify({ token: "s_host", userId: "p1", displayName: "Browser Host" }), { status: 200 });
    if (url.endsWith("/rooms")) return new Response(JSON.stringify(room), { status: 200 });
    if (url.endsWith("/ws-tickets")) return new Response(JSON.stringify({ ticket: "wst_1", expiresAt: "2026-06-22T00:00:00.000Z", ttlMs: 30_000 }), { status: 201 });
    return new Response("not found", { status: 404 });
  }));

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));
  expect(await screen.findByLabelText("Game board and actions")).toBeInTheDocument();
  return { room, sentMessages };
};

describe("App", () => {
  it("renders the match setup menu first", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Colonizt" })).toBeInTheDocument();
    expect(screen.getByLabelText("Match setup")).toBeInTheDocument();
    expect(screen.getByLabelText("Game options")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bot Match/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Player Match/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Join by room code")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Map" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Standard" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Islands" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continent" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Players" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "4" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Random special card cost")).not.toBeChecked();
    expect(screen.queryByLabelText("Game board and actions")).not.toBeInTheDocument();
    expect(screen.queryByText(/welcome/i)).not.toBeInTheDocument();
  });

  it("applies pre-game bot difficulty and optional rules", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "hard" }));
    fireEvent.click(screen.getByLabelText("Dice doubles x2"));
    fireEvent.click(screen.getByLabelText("Plight on turn 20"));
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));

    expect(screen.getByText("Difficulty hard · Map Standard · Doubles x2 · Plight turn 20")).toBeInTheDocument();
  });

  it("starts local games with the selected map preset", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Islands" }));
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));

    expect(screen.getByText("Difficulty medium · Map Islands")).toBeInTheDocument();
  });

  it("keeps readiness and replay/history controls out of active local play", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Continent" }));
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));

    expect(screen.getByText("Difficulty medium · Map Continent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ready" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "History" })).not.toBeInTheDocument();
  });

  it("hosts online rooms with the selected player capacity", async () => {
    let roomPayload: unknown;
    const lobbyRoom = {
      id: "room_two",
      code: "TWO222",
      inviteUrl: "https://play.example/?room=TWO222",
      status: "LOBBY",
      hostUserId: "u_host",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 2, botDifficulty: "medium", rules: { mapPreset: "standard" } },
      seats: [
        { seatIndex: 0, userId: "u_host", ready: false, connected: true },
        { seatIndex: 1, ready: false, connected: false },
      ],
      spectatorCount: 0,
      events: [],
    };
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = FakeWebSocket.OPEN;

      constructor(readonly url: string) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        const message = JSON.parse(payload) as { type: string };
        if (message.type === "JOIN_ROOM") {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: lobbyRoom }) })));
        }
      }

      close(): void {
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sessions")) return new Response(JSON.stringify({ token: "s_host", userId: "u_host", displayName: "Browser Host" }), { status: 200 });
      if (url.endsWith("/rooms")) {
        roomPayload = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify(lobbyRoom), { status: 200 });
      }
      if (url.endsWith("/ws-tickets")) return new Response(JSON.stringify({ ticket: "wst_1", expiresAt: "2026-06-22T00:00:00.000Z", ttlMs: 30_000 }), { status: 201 });
      return new Response("not found", { status: 404 });
    }));

    render(<App />);
    fireEvent.click(within(screen.getByRole("group", { name: "Players" })).getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));

    expect(await screen.findByLabelText("Online lobby")).toBeInTheDocument();
    expect(roomPayload).toMatchObject({ minPlayers: 2, maxPlayers: 2 });
    expect(screen.getByText("0/2 ready · 1/2 seats")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("marks the two settlement corners that grant each harbor bonus", () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));

    const harbors = screen.getAllByRole("img", { name: /harbor.*either marked corner/i });
    expect(harbors.length).toBeGreaterThan(0);
    for (const harbor of harbors) expect(harbor.querySelectorAll(".port-vertex-marker")).toHaveLength(2);
    expect(container.querySelectorAll(".port-pier")).toHaveLength(harbors.length);
    expect(container.querySelector(".port-pier")?.tagName.toLowerCase()).toBe("path");
  });

  it("exposes keyboard board actions and named resource cards", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    const rack = screen.getByLabelText("Your resources");
    expect(rack).toHaveTextContent("Timber");
    expect(rack).toHaveTextContent("Brick");
    expect(rack).toHaveTextContent("Grain");
    const setupActions = screen.getAllByRole("button", { name: /Place setup settlement at corner/ });
    expect(setupActions.length).toBeGreaterThan(0);
    fireEvent.keyDown(setupActions[0]!, { key: "Enter" });
    expect(screen.getByText("Place setup road")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Pending setup settlement at corner/ })).toBeInTheDocument();
    const setupRoads = screen.getAllByRole("button", { name: /Build road here/ });
    fireEvent.keyDown(setupRoads[0]!, { key: "Enter" });
    expect(screen.getByText("Active: Briar")).toBeInTheDocument();
  });

  it("cancels pending setup construction when the map is clicked elsewhere", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    const setupActions = screen.getAllByRole("button", { name: /Place setup settlement at corner/ });
    fireEvent.click(setupActions[0]!);

    expect(screen.getByText("Place setup road")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Pending setup settlement at corner/ })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Resource board"));

    expect(screen.getByText("Place setup settlement")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Pending setup settlement at corner/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Place setup settlement at corner/ }).length).toBeGreaterThan(0);
  });

  it("autoplays bot turns without a manual bots button", () => {
    vi.useFakeTimers();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    expect(screen.queryByRole("button", { name: "Bots" })).not.toBeInTheDocument();
    const setupActions = screen.getAllByRole("button", { name: /Place setup settlement at corner/ });
    fireEvent.click(setupActions[0]!);
    const setupRoads = screen.getAllByRole("button", { name: /Build road here/ });
    fireEvent.click(setupRoads[0]!);
    expect(screen.getByText("Active: Briar")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText("Active: Briar")).not.toBeInTheDocument();
  });

  it("disables invalid selected player trades", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    completeLocalSetup();
    fireEvent.click(screen.getByRole("button", { name: "Roll dice" }));
    moveRobberIfPrompted();
    expect(screen.queryByLabelText("Trade interface")).not.toBeInTheDocument();
    const handButtons = [...screen.getByLabelText("Your resources").querySelectorAll("button")];
    const ownedButton = handButtons.find((button) => Number(button.querySelector(".resource-count")?.textContent ?? "0") > 0);
    expect(ownedButton).toBeDefined();
    fireEvent.click(ownedButton!);
    expect(screen.getByLabelText("Trade interface")).toBeInTheDocument();
    const offeredResource = ownedButton!.getAttribute("aria-label")!.replace("Open trade with ", "");
    const requestResource = ["Timber", "Brick", "Grain", "Fiber", "Ore"].find((resource) => resource !== offeredResource)!;
    fireEvent.click(screen.getByRole("button", { name: `Request ${requestResource}` }));
    expect(screen.getByRole("button", { name: "Offer" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: `Request ${offeredResource}` }));
    expect(screen.getByRole("button", { name: "Offer" })).toBeDisabled();
  });

  it("supports R and E shortcuts for roll and end", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    completeLocalSetup();
    expect(screen.getByRole("button", { name: "Roll dice" })).toHaveAttribute("aria-keyshortcuts", "R");
    fireEvent.keyDown(window, { key: "r" });
    expect(screen.getByText(/Roll \d+/)).toBeInTheDocument();
    moveRobberIfPrompted();
    expect(screen.getByRole("button", { name: "End Turn" })).toHaveAttribute("aria-keyshortcuts", "E");
    fireEvent.keyDown(window, { key: "e" });
    expect(screen.getByText("Active: Briar")).toBeInTheDocument();
  });

  it("hides and ignores keyboard shortcuts on mobile", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query.includes("760px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    completeLocalSetup();

    expect(screen.getByRole("button", { name: "Roll dice" })).not.toHaveAttribute("aria-keyshortcuts");
    expect(screen.getByRole("button", { name: "End Turn" })).not.toHaveAttribute("aria-keyshortcuts");
    fireEvent.keyDown(window, { key: "r" });
    expect(screen.getByRole("button", { name: "Roll dice" })).toHaveTextContent("Roll --");
  });

  it("renders explicit board action buttons and sidebar panels", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));

    const actionBar = screen.getByLabelText("Turn actions");
    expect(actionBar).toHaveTextContent("Trade");
    expect(actionBar).toHaveTextContent("Special");
    expect(actionBar).toHaveTextContent("Road");
    expect(actionBar).toHaveTextContent("Settlement");
    expect(actionBar).toHaveTextContent("City");
    expect(actionBar).toHaveTextContent("End Turn");
    expect(within(actionBar).getByRole("button", { name: "Open trade" })).toHaveClass("trade-action");
    expect(within(actionBar).getByRole("button", { name: "Draw special card" })).toHaveClass("special-action");
    expect(within(actionBar).getByRole("button", { name: "Build road" })).toHaveClass("road-action");
    expect(within(actionBar).getByRole("button", { name: "Build settlement" })).toHaveClass("settlement-action");
    expect(within(actionBar).getByRole("button", { name: "Upgrade city" })).toHaveClass("city-action");

    const sidebar = screen.getByLabelText("Players and controls");
    expect(within(sidebar).getByLabelText("Development cards")).toBeInTheDocument();
    expect(within(sidebar).getByLabelText("Gameplay log")).toBeInTheDocument();
  });

  it("componentizes own secret VP and keeps Road Building on the board", async () => {
    const game = completeSetup(createDemoGame("web-road-building-vp")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game.players.p1!.score = 4;
    game.players.p1!.developmentCards = [
      { id: "vp-card", type: "VICTORY_POINT", ownerId: "p1", boughtTurn: game.turn - 1 },
      { id: "road-card", type: "ROAD_BUILDING", ownerId: "p1", boughtTurn: game.turn - 1 },
    ];
    game.players.p1!.specialCards = 2;
    game.players.p2!.score = 5;
    game.players.p2!.developmentCards = [{ id: "opponent-vp", type: "VICTORY_POINT", ownerId: "p2", boughtTurn: game.turn - 1 }];
    game.players.p2!.specialCards = 1;

    const { sentMessages } = await renderOnlineGame(game);

    expect(screen.getByText("(4+1) VP")).toBeInTheDocument();
    expect(screen.queryByText("(5+1) VP")).not.toBeInTheDocument();
    expect(screen.getByText("Secret +1 VP")).toBeInTheDocument();

    const devPanel = screen.getByLabelText("Development cards");
    expect(within(devPanel).queryByRole("button", { name: /^e\d+$/ })).not.toBeInTheDocument();
    fireEvent.click(within(devPanel).getByRole("button", { name: "Use" }));
    expect(within(devPanel).getByRole("button", { name: "0/2 roads" })).toBeInTheDocument();
    expect(within(devPanel).queryByRole("button", { name: /^e\d+$/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /Build road here/ })[0]!);
    expect(within(devPanel).getByRole("button", { name: "1/2 roads" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Build road here/ })[0]!);

    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "COMMAND",
        command: expect.objectContaining({ type: "PLAY_ROAD_BUILDING", playerId: "p1", cardId: "road-card", edgeIds: expect.any(Array) }),
      }),
    ])));
  });

  it("uses board victim badges for Knight robber targeting", async () => {
    const game = completeSetup(createDemoGame("web-knight-targeting")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game.players.p1!.developmentCards = [{ id: "knight-card", type: "KNIGHT", ownerId: "p1", boughtTurn: game.turn - 1 }];
    game.players.p1!.specialCards = 1;
    game.players.p2!.resources = { ...emptyResources(), timber: 1 };

    const { sentMessages } = await renderOnlineGame(game);
    const devPanel = screen.getByLabelText("Development cards");
    fireEvent.click(within(devPanel).getByRole("button", { name: "Use" }));

    const victimBadge = screen.getAllByRole("button", { name: /steal from Briar/ })[0];
    expect(victimBadge).toBeDefined();
    fireEvent.click(victimBadge!);

    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "COMMAND",
        command: expect.objectContaining({ type: "PLAY_KNIGHT", playerId: "p1", cardId: "knight-card", stealFromPlayerId: "p2" }),
      }),
    ])));
  });

  it("selects discard cards from the hand rack instead of opening trade", async () => {
    const game = completeSetup(createDemoGame("web-discard-hand")).state;
    game.players.p1!.resources = { ...emptyResources(), timber: 8 };
    game.phase = { type: "DISCARDING", activePlayerId: "p1", rollerId: "p2", pending: { p1: 4 }, submitted: {} };

    await renderOnlineGame(game);

    expect(screen.getByLabelText("Discard resources")).toBeInTheDocument();
    const discardPanel = screen.getByLabelText("Discard resources");
    await waitFor(() => expect(within(discardPanel).getByText(/0\/4 · \d+:\d{2}/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Select Timber to discard" }));
    expect(screen.queryByLabelText("Trade interface")).not.toBeInTheDocument();
    expect(screen.getByText("x1")).toBeInTheDocument();
    expect(within(discardPanel).getByRole("button", { name: "Clear" })).toBeInTheDocument();
    expect(within(discardPanel).queryByRole("button", { name: "+" })).not.toBeInTheDocument();
  });

  it("auto-rolls and auto-ends when phase timers expire", () => {
    vi.useFakeTimers();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    completeLocalSetup();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/Roll \d+/)).toBeInTheDocument();

    for (let index = 0; index < 3 && !screen.queryByText("Active: Briar"); index += 1) {
      act(() => {
        vi.advanceTimersByTime(240_000);
      });
    }
    expect(screen.getByText("Active: Briar")).toBeInTheDocument();
  });

  it("renders multiplayer lobbies without stale local game state or resync failures", async () => {
    const sentMessages: unknown[] = [];
    const lobbyRoom = {
      id: "room_abc",
      code: "ABC123",
      inviteUrl: "https://play.example/?room=ABC123",
      status: "LOBBY",
      hostUserId: "u_host",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4, botDifficulty: "medium", rules: { mapPreset: "continent" } },
      seats: [
        { seatIndex: 0, userId: "u_host", ready: false, connected: true },
        { seatIndex: 1, ready: false, connected: false },
        { seatIndex: 2, ready: false, connected: false },
        { seatIndex: 3, ready: false, connected: false },
      ],
      spectatorCount: 0,
      events: [],
    };
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = FakeWebSocket.OPEN;

      constructor(readonly url: string) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        const message = JSON.parse(payload) as { type: string };
        sentMessages.push(message);
        if (message.type === "JOIN_ROOM") {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: lobbyRoom }) })));
        }
      }

      close(): void {
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/sessions")) return new Response(JSON.stringify({ token: "s_host", userId: "u_host", displayName: "Browser Host" }), { status: 200 });
      if (url.endsWith("/rooms")) return new Response(JSON.stringify(lobbyRoom), { status: 200 });
      if (url.endsWith("/ws-tickets")) return new Response(JSON.stringify({ ticket: "wst_1", expiresAt: "2026-06-22T00:00:00.000Z", ttlMs: 30_000 }), { status: 201 });
      return new Response("not found", { status: 404 });
    }));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    expect(screen.getByLabelText("Game board and actions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New Match" }));
    fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));

    expect(await screen.findByLabelText("Online lobby")).toBeInTheDocument();
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ready" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Game board and actions")).not.toBeInTheDocument();
    expect(screen.queryByText("RESYNC_FAILED")).not.toBeInTheDocument();
    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([expect.objectContaining({ type: "JOIN_ROOM", roomId: "ABC123" })])));
    expect(sentMessages).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "RESYNC" })]));
  });

  it("ignores stale online room creation after switching back to local play", async () => {
    let resolveSession!: () => void;
    const sessionResponse = new Promise<Response>((resolve) => {
      resolveSession = () => resolve(new Response(JSON.stringify({ token: "s_host", userId: "u_host", displayName: "Browser Host" }), { status: 200 }));
    });
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/sessions")) return sessionResponse;
      if (url.endsWith("/rooms")) return new Response(JSON.stringify({ id: "room_stale", code: "STALE1", status: "LOBBY", seats: [] }), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    expect(screen.getByLabelText("Game board and actions")).toBeInTheDocument();

    await act(async () => {
      resolveSession();
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Game board and actions")).toBeInTheDocument();
    expect(screen.queryByLabelText("Online lobby")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining("/rooms"), expect.anything());
  });
});
