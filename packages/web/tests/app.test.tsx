// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeSetup, createDemoGame, withResources } from "@colonizt/demo-state";
import { applyCommand, cityCost, emptyResources, serializeForViewer, type GameCommand, type GameState } from "@colonizt/game-core";
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

const applyOrThrow = (state: GameState, command: GameCommand): GameState => {
  const result = applyCommand(state, command);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.nextState;
};

const moveRobberIfPrompted = () => {
  const victimHex = screen.queryAllByRole("button", { name: /Select robber destination on/ })[0];
  if (victimHex) {
    fireEvent.click(victimHex);
    const chooser = screen.queryByLabelText("Choose player to rob");
    const victim = chooser ? within(chooser).queryAllByRole("button", { name: /Steal from/ })[0] : undefined;
    if (victim) fireEvent.click(victim);
    return;
  }
  const target = screen.queryAllByRole("button", { name: /Move robber to/ })[0];
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
    if (url.includes("/matches/") && url.endsWith("/replay")) return new Response(JSON.stringify({ config: game.config, board: game.board, events: [] }), { status: 200 });
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

    expect(screen.getByText("Active: Player")).toBeInTheDocument();
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
        { seatIndex: 0, userId: "u_host", displayName: "Browser Host", ready: false, connected: true },
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
    expect(screen.getByText("2-4 player online room")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Players" })).getByRole("button", { name: "2" }));
    expect(screen.getByText("2 player online room")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));

    expect(await screen.findByLabelText("Online lobby")).toBeInTheDocument();
    expect(roomPayload).toMatchObject({ minPlayers: 2, maxPlayers: 2 });
    expect(screen.getByText("0/2 ready · 1/2 open seats")).toBeInTheDocument();
    expect(screen.getByText("1/2 open")).toBeInTheDocument();
    expect(screen.getAllByText("Closed")).toHaveLength(4);
    expect(screen.getByLabelText("Your name")).toHaveValue("Browser Host");
    expect(screen.getByRole("button", { name: "Go" })).toBeDisabled();
    expect(screen.getByRole("group", { name: "Lobby map" })).toBeInTheDocument();
  });

  it("enables lobby Go for the ready connected minimum despite stale disconnected seats", async () => {
    const lobbyRoom = {
      id: "room_stale",
      code: "STALE1",
      inviteUrl: "https://play.example/?room=STALE1",
      status: "LOBBY",
      hostUserId: "u_host",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4, botDifficulty: "medium", rules: { mapPreset: "standard" } },
      seats: [
        { seatIndex: 0, userId: "u_host", displayName: "Browser Host", ready: true, connected: true },
        { seatIndex: 1, userId: "u_guest", displayName: "Guest", ready: true, connected: true },
        { seatIndex: 2, userId: "u_stale", displayName: "Stale", ready: false, connected: false },
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
    fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));

    expect(await screen.findByLabelText("Online lobby")).toBeInTheDocument();
    expect(screen.getByText("2/2 ready · 3/4 open seats")).toBeInTheDocument();
    expect(screen.getByText("Ready to start 2 players")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go" })).toBeEnabled();
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
    const actionBar = screen.getByLabelText("Turn actions");
    fireEvent.click(within(actionBar).getByRole("button", { name: "Open trade" }));
    expect(screen.queryByLabelText("Trade interface")).not.toBeInTheDocument();
    fireEvent.click(within(actionBar).getByRole("button", { name: "Open trade" }));
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

  it("enables city upgrades before city mode is selected", async () => {
    let game = completeSetup(createDemoGame("web-city-upgrade")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game = withResources(game, "p1", cityCost());

    const { sentMessages } = await renderOnlineGame(game);

    const actionBar = screen.getByLabelText("Turn actions");
    const cityButton = within(actionBar).getByRole("button", { name: "Upgrade city" });
    expect(cityButton).toBeEnabled();

    fireEvent.click(cityButton);
    fireEvent.click(screen.getAllByRole("button", { name: /Upgrade city at corner/ })[0]!);

    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "COMMAND",
        command: expect.objectContaining({ type: "UPGRADE_CITY", playerId: "p1" }),
      }),
    ])));
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
    game.players.p3!.score = 3;
    game.players.p3!.developmentCards = [
      { id: "cyra-vp-1", type: "VICTORY_POINT", ownerId: "p3", boughtTurn: game.turn - 1 },
      { id: "cyra-vp-2", type: "VICTORY_POINT", ownerId: "p3", boughtTurn: game.turn - 1 },
    ];
    game.players.p3!.specialCards = 2;

    const { sentMessages } = await renderOnlineGame(game);

    expect(screen.getByText("4 (5) VP")).toBeInTheDocument();
    expect(screen.queryByText("5 (6) VP")).not.toBeInTheDocument();
    expect(screen.queryByText("3 (5) VP")).not.toBeInTheDocument();
    expect(screen.getByText("Secret +1 VP")).toBeInTheDocument();
    expect(screen.getByLabelText("Bank holdings")).toBeInTheDocument();
    const handDevCards = screen.getByLabelText("Your development cards in hand");
    expect(within(handDevCards).getByRole("button", { name: "Victory Point: Secret +1 VP" })).toHaveAttribute("aria-disabled", "true");
    expect(within(handDevCards).getByRole("button", { name: "Road Building: Ready" })).toBeEnabled();

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

  it("limits Year of Plenty picks to resources the bank can supply", async () => {
    const game = completeSetup(createDemoGame("web-year-of-plenty-bank")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game.players.p1!.developmentCards = [{ id: "plenty-card", type: "YEAR_OF_PLENTY", ownerId: "p1", boughtTurn: game.turn - 1 }];
    game.players.p1!.specialCards = 1;
    game.resourceBank = { ...emptyResources(), timber: 1, brick: 2, grain: 1, fiber: 1, ore: 0 };

    await renderOnlineGame(game);

    const devPanel = screen.getByLabelText("Development cards");
    fireEvent.click(within(devPanel).getByRole("button", { name: "Use" }));
    const overlay = screen.getByLabelText("Year of Plenty card choice");
    expect(within(overlay).queryByRole("button", { name: "Choose Ore as first Year of Plenty resource" })).not.toBeInTheDocument();
    expect(within(overlay).queryByRole("button", { name: "Choose Ore as second Year of Plenty resource" })).not.toBeInTheDocument();

    fireEvent.click(within(overlay).getByRole("button", { name: "Choose Timber as first Year of Plenty resource" }));
    expect(within(overlay).queryByRole("button", { name: "Choose Timber as second Year of Plenty resource" })).not.toBeInTheDocument();
    expect(within(overlay).getByRole("button", { name: "Choose Brick as second Year of Plenty resource" })).toBeInTheDocument();
  });

  it("uses the board robber chooser for Knight targeting", async () => {
    const game = completeSetup(createDemoGame("web-knight-targeting")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game.players.p1!.developmentCards = [{ id: "knight-card", type: "KNIGHT", ownerId: "p1", boughtTurn: game.turn - 1 }];
    game.players.p1!.specialCards = 1;
    game.players.p2!.resources = { ...emptyResources(), timber: 1 };

    const { sentMessages } = await renderOnlineGame(game);
    const devPanel = screen.getByLabelText("Development cards");
    fireEvent.click(within(devPanel).getByRole("button", { name: "Use" }));

    expect(screen.queryByRole("button", { name: /Steal from/ })).not.toBeInTheDocument();
    const targetHex = screen.getAllByRole("button", { name: /Select robber destination on/ })[0];
    expect(targetHex).toBeDefined();
    fireEvent.click(targetHex!);
    const chooser = screen.getByLabelText("Choose player to rob");
    fireEvent.click(within(chooser).getAllByRole("button", { name: /Steal from/ })[0]!);

    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "COMMAND",
        command: expect.objectContaining({ type: "PLAY_KNIGHT", playerId: "p1", cardId: "knight-card", stealFromPlayerId: expect.any(String) }),
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

  it("lets online offerers finalize staged trades without seeing responder resources", async () => {
    let game = completeSetup(createDemoGame("web-online-trade-finalize")).state;
    game = applyOrThrow(game, { type: "ROLL_DICE", playerId: "p1" });
    game = { ...game, phase: { type: "ACTION_PHASE", activePlayerId: "p1" } };
    game = withResources(game, "p1", { timber: 1 });
    game = withResources(game, "p2", { ore: 1 });
    game = applyOrThrow(game, {
      type: "OFFER_TRADE",
      playerId: "p1",
      tradeId: "online-finalize",
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
    });
    game = applyOrThrow(game, { type: "RESPOND_TRADE", playerId: "p2", tradeId: "online-finalize", response: "WANTS_ACCEPT" });

    const { sentMessages } = await renderOnlineGame(game);

    fireEvent.click(screen.getByRole("button", { name: /Briar\s*Wants to accept/ }));
    fireEvent.click(screen.getByRole("button", { name: "Trade" }));

    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "COMMAND",
        command: expect.objectContaining({ type: "FINALIZE_TRADE", playerId: "p1", tradeId: "online-finalize", toPlayerId: "p2" }),
      }),
    ])));
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

  it("shows replay only after game over and opens finished replay controls", async () => {
    const game = completeSetup(createDemoGame("web-finished-replay")).state;
    game.phase = { type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" };

    await renderOnlineGame(game);

    expect(screen.getByLabelText("Victory analysis")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Dice Stats" }));
    expect(screen.getByRole("heading", { name: "Dice Rolls" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Resource Cards" }));
    expect(screen.getByRole("heading", { name: "Resource Cards Drawn" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Development Cards" }));
    expect(screen.getByRole("heading", { name: "Development Cards Drawn" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "History" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));

    expect(await screen.findByLabelText("Replay controls")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live" })).toBeInTheDocument();
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

  it("sends lobby display-name and settings updates from the host controls", async () => {
    const sentMessages: unknown[] = [];
    const lobbyRoom = {
      id: "room_settings",
      code: "SET123",
      inviteUrl: "https://play.example/?room=SET123",
      status: "LOBBY",
      hostUserId: "u_host",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4, botDifficulty: "medium", rules: { mapPreset: "standard" } },
      seats: [
        { seatIndex: 0, userId: "u_host", displayName: "Browser Host", ready: false, connected: true },
        { seatIndex: 1, ready: false, connected: false },
        { seatIndex: 2, ready: false, connected: false },
        { seatIndex: 3, ready: false, connected: false },
      ],
      spectatorCount: 0,
      events: [],
    };
    let currentLobbyRoom = lobbyRoom;
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = FakeWebSocket.OPEN;

      constructor(readonly url: string) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        const message = JSON.parse(payload) as { type: string; settings?: Partial<typeof lobbyRoom.settings> };
        sentMessages.push(message);
        if (message.type === "JOIN_ROOM") {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: currentLobbyRoom }) })));
        }
        if (message.type === "UPDATE_ROOM_SETTINGS" && message.settings) {
          const maxPlayers = message.settings.maxPlayers ?? currentLobbyRoom.settings.maxPlayers;
          const seats = currentLobbyRoom.seats.slice(0, maxPlayers);
          while (seats.length < maxPlayers) seats.push({ seatIndex: seats.length, ready: false, connected: false });
          currentLobbyRoom = {
            ...currentLobbyRoom,
            settings: {
              ...currentLobbyRoom.settings,
              ...message.settings,
              rules: message.settings.rules
                ? { ...currentLobbyRoom.settings.rules, ...message.settings.rules }
                : currentLobbyRoom.settings.rules,
            },
            seats: seats.map((seat, index) => ({ ...seat, seatIndex: index, ready: false })),
          };
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: currentLobbyRoom }) })));
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
    fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));
    expect(await screen.findByLabelText("Online lobby")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const lobbyStartGroup = within(screen.getByRole("group", { name: "Lobby start players" }));
    expect(lobbyStartGroup.getByRole("button", { name: "2" })).toBeDisabled();
    fireEvent.click(lobbyStartGroup.getByRole("button", { name: "3" }));
    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "UPDATE_ROOM_SETTINGS",
        roomId: "SET123",
        settings: expect.objectContaining({ minPlayers: 3 }),
      }),
    ])));
    const lobbyOpenSeatsGroup = within(screen.getByRole("group", { name: "Lobby open seats" }));
    await waitFor(() => expect(lobbyOpenSeatsGroup.getByRole("button", { name: "2" })).toBeEnabled());
    fireEvent.click(lobbyOpenSeatsGroup.getByRole("button", { name: "2" }));
    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "UPDATE_ROOM_SETTINGS",
        roomId: "SET123",
        settings: expect.objectContaining({ minPlayers: 2, maxPlayers: 2 }),
      }),
    ])));
    const lobbyMapGroup = within(screen.getByRole("group", { name: "Lobby map" }));
    expect(lobbyMapGroup.getByRole("button", { name: "Standard" })).toBeDisabled();
    const settingsBeforeNoop = sentMessages.filter((message) => (message as { type?: string }).type === "UPDATE_ROOM_SETTINGS").length;
    fireEvent.click(lobbyMapGroup.getByRole("button", { name: "Standard" }));
    expect(sentMessages.filter((message) => (message as { type?: string }).type === "UPDATE_ROOM_SETTINGS")).toHaveLength(settingsBeforeNoop);
    await waitFor(() => expect(lobbyMapGroup.getByRole("button", { name: "Continent" })).toBeEnabled());
    fireEvent.click(lobbyMapGroup.getByRole("button", { name: "Continent" }));

    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "UPDATE_DISPLAY_NAME", displayName: "Ada" }),
      expect.objectContaining({
        type: "UPDATE_ROOM_SETTINGS",
        roomId: "SET123",
        settings: expect.objectContaining({ minPlayers: 3 }),
      }),
      expect.objectContaining({
        type: "UPDATE_ROOM_SETTINGS",
        roomId: "SET123",
        settings: expect.objectContaining({ minPlayers: 2, maxPlayers: 2 }),
      }),
      expect.objectContaining({
        type: "UPDATE_ROOM_SETTINGS",
        roomId: "SET123",
        settings: expect.objectContaining({ rules: expect.objectContaining({ mapPreset: "continent", mapRandomized: true }) }),
      }),
    ])));
  });

  it("sends lobby bot add and remove controls from the host", async () => {
    const sentMessages: unknown[] = [];
    type TestSeat = { seatIndex: number; userId?: string; botId?: string; displayName?: string; ready: boolean; connected: boolean };
    const initialSeats: TestSeat[] = [
      { seatIndex: 0, userId: "u_host", displayName: "Browser Host", ready: false, connected: true },
      { seatIndex: 1, ready: false, connected: false },
      { seatIndex: 2, ready: false, connected: false },
      { seatIndex: 3, ready: false, connected: false },
    ];
    const lobbyRoom = {
      id: "room_bots",
      code: "BOT123",
      inviteUrl: "https://play.example/?room=BOT123",
      status: "LOBBY",
      hostUserId: "u_host",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4, botDifficulty: "medium", rules: { mapPreset: "standard" } },
      seats: initialSeats,
      spectatorCount: 0,
      events: [],
    };
    let currentLobbyRoom = lobbyRoom;
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = FakeWebSocket.OPEN;

      constructor(readonly url: string) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        const message = JSON.parse(payload) as { type: string; seatIndex?: number };
        sentMessages.push(message);
        if (message.type === "JOIN_ROOM") {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: currentLobbyRoom }) })));
        }
        if (message.type === "ADD_BOT") {
          const seats = currentLobbyRoom.seats.map((seat) => ({ ...seat }));
          const seat = seats.find((candidate) => !candidate.userId && !candidate.botId);
          if (seat) {
            seat.botId = `bot_${seat.seatIndex + 1}`;
            seat.displayName = `Bot ${seat.seatIndex + 1}`;
            seat.ready = true;
            seat.connected = true;
          }
          currentLobbyRoom = { ...currentLobbyRoom, seats };
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: currentLobbyRoom }) })));
        }
        if (message.type === "REMOVE_BOT" && message.seatIndex !== undefined) {
          const seats = currentLobbyRoom.seats.map((seat) => seat.seatIndex === message.seatIndex
            ? { seatIndex: seat.seatIndex, ready: false, connected: false }
            : { ...seat });
          currentLobbyRoom = { ...currentLobbyRoom, seats };
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: currentLobbyRoom }) })));
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
    fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));
    expect(await screen.findByLabelText("Online lobby")).toBeInTheDocument();

    const lobbyBotGroup = within(screen.getByRole("group", { name: "Lobby bots" }));
    expect(lobbyBotGroup.getByText("0/4")).toBeInTheDocument();
    expect(lobbyBotGroup.getByRole("button", { name: "Remove Bot" })).toBeDisabled();
    fireEvent.click(lobbyBotGroup.getByRole("button", { name: "Add Bot" }));

    expect(await screen.findByText("Bot 2")).toBeInTheDocument();
    expect(lobbyBotGroup.getByText("1/4")).toBeInTheDocument();
    await waitFor(() => expect(lobbyBotGroup.getByRole("button", { name: "Remove Bot" })).toBeEnabled());
    fireEvent.click(lobbyBotGroup.getByRole("button", { name: "Remove Bot" }));

    await waitFor(() => expect(screen.queryByText("Bot 2")).not.toBeInTheDocument());
    expect(lobbyBotGroup.getByText("0/4")).toBeInTheDocument();
    expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ADD_BOT", roomId: "BOT123" }),
      expect.objectContaining({ type: "REMOVE_BOT", roomId: "BOT123", seatIndex: 1 }),
    ]));
  });

  it("sends host Go for a two-player ready lobby without waiting for all seats", async () => {
    const sentMessages: unknown[] = [];
    const lobbyRoom = {
      id: "room_go",
      code: "GO1234",
      inviteUrl: "https://play.example/?room=GO1234",
      status: "LOBBY",
      hostUserId: "u_host",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4, botDifficulty: "medium", rules: { mapPreset: "standard" } },
      seats: [
        { seatIndex: 0, userId: "u_host", displayName: "Host", ready: true, connected: true },
        { seatIndex: 1, userId: "u_guest", displayName: "Guest", ready: true, connected: true },
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
      if (url.endsWith("/sessions")) return new Response(JSON.stringify({ token: "s_host", userId: "u_host", displayName: "Host" }), { status: 200 });
      if (url.endsWith("/rooms")) return new Response(JSON.stringify(lobbyRoom), { status: 200 });
      if (url.endsWith("/ws-tickets")) return new Response(JSON.stringify({ ticket: "wst_1", expiresAt: "2026-06-22T00:00:00.000Z", ttlMs: 30_000 }), { status: 201 });
      return new Response("not found", { status: 404 });
    }));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));
    expect(await screen.findByLabelText("Online lobby")).toBeInTheDocument();

    const go = screen.getByRole("button", { name: "Go" });
    expect(go).toBeEnabled();
    fireEvent.click(go);

    expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "START_ROOM", roomId: "GO1234" }),
    ]));
  });
});
