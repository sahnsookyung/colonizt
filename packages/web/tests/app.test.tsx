// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeSetup, createDemoGame, withResources } from "@colonizt/demo-state";
import { applyCommand, cityCost, emptyResources, getLegalActions, serializeForViewer, type GameCommand, type GameEvent, type GameState } from "@colonizt/game-core";
import { App, networkErrorMessage } from "../src/App.js";
import { clearResumeState, writeResumeState } from "../src/resume.js";

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

const renderOnlineGame = async (game: GameState, options: { replayResponse?: () => Response | Promise<Response> } = {}) => {
  const sentMessages: Array<{ type: string; command?: unknown }> = [];
  const sockets: FakeWebSocket[] = [];
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
      sockets.push(this);
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

    receive(message: unknown): void {
      this.dispatchEvent(new MessageEvent("message", { data: typeof message === "string" ? message : JSON.stringify(message) }));
    }
  }

  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/sessions")) return new Response(JSON.stringify({ token: "s_host", userId: "p1", displayName: "Browser Host" }), { status: 200 });
    if (url.endsWith("/rooms")) return new Response(JSON.stringify(room), { status: 200 });
    if (url.endsWith("/ws-tickets")) return new Response(JSON.stringify({ ticket: "wst_1", expiresAt: "2026-06-22T00:00:00.000Z", ttlMs: 30_000 }), { status: 201 });
    if (url.includes("/matches/") && url.endsWith("/replay")) {
      return options.replayResponse?.() ?? new Response(JSON.stringify({ config: game.config, board: game.board, events: [] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }));

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));
  expect(await screen.findByLabelText("Game board and actions")).toBeInTheDocument();
  return { room, sentMessages, sockets };
};

describe("App", () => {
  it("translates stable network failure codes and preserves useful fallback messages", () => {
    expect([
      "ROOM_NOT_FOUND",
      "ROOM_EXPIRED",
      "ROOM_ABANDONED",
      "ROOM_CLOSED",
      "ROOM_FULL",
      "ROOM_PAUSED",
      "REPLAY_NOT_READY",
      "REPLAY_FORBIDDEN",
      "REPLAY_NOT_FOUND",
      "RATE_LIMITED",
      "UNAUTHORIZED",
    ].map((code) => networkErrorMessage({ code }))).toEqual([
      "Room not found",
      "Room expired",
      "Room abandoned",
      "Room closed",
      "Room is full",
      "Room is paused",
      "Replay is available after the game is finished",
      "Replay is only available to players in this match",
      "Replay not found",
      "Too many attempts. Try again shortly.",
      "Session expired",
    ]);
    expect(networkErrorMessage(new Error("socket failed"))).toBe("socket failed");
    expect(networkErrorMessage({ message: "server explained the failure" })).toBe("server explained the failure");
    expect(networkErrorMessage({ code: "NEW_SERVER_CODE" })).toBe("NEW_SERVER_CODE");
    expect(networkErrorMessage(null)).toBe("Online action failed");
  });

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
    fireEvent.click(screen.getByLabelText("Random special card cost"));
    expect(screen.getByLabelText("Random special card cost")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Random special card cost"));
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

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("Place setup settlement")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /Place setup settlement at corner/ })[0]!);

    fireEvent.click(screen.getByLabelText("Resource board"));

    expect(screen.getByText("Place setup settlement")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Pending setup settlement at corner/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Place setup settlement at corner/ }).length).toBeGreaterThan(0);

    const legalVertices = screen.getAllByRole("button", { name: /Place setup settlement at corner/ });
    fireEvent.click(legalVertices[0]!);
    fireEvent.click(legalVertices[1]!);
    expect(screen.getByText("Place setup settlement")).toBeInTheDocument();
  });

  it("uses the SVG hit regions for pointer setup placement", () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    const vertexHit = container.querySelector<SVGRectElement>(".vertex-target.legal-target .vertex-hit");
    if (!vertexHit) throw new Error("expected a legal vertex hit region");
    fireEvent.click(vertexHit);
    expect(screen.getByText("Place setup road")).toBeInTheDocument();

    const edgeHit = container.querySelector<SVGRectElement>(".edge-build-control .edge-build-target");
    if (!edgeHit) throw new Error("expected a legal edge hit region");
    fireEvent.click(edgeHit);
    expect(screen.getByText("Active: Briar")).toBeInTheDocument();
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
    expect(within(actionBar).getByRole("button", { name: /Draw special card\. Cost:/ })).toHaveClass("special-action");
    expect(within(actionBar).getByRole("button", { name: "Build road" })).toHaveClass("road-action");
    expect(within(actionBar).getByRole("button", { name: "Build settlement" })).toHaveClass("settlement-action");
    expect(within(actionBar).getByRole("button", { name: "Upgrade city" })).toHaveClass("city-action");

    const sidebar = screen.getByLabelText("Match information and players");
    expect(within(sidebar).queryByLabelText("Development cards")).not.toBeInTheDocument();
    expect(within(sidebar).getByLabelText("Gameplay log")).toBeInTheDocument();
    fireEvent.click(within(sidebar).getByRole("button", { name: "Details" }));
    expect(within(sidebar).getByRole("button", { name: "Hide" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps online room actions out of the information sidebar", async () => {
    const game = completeSetup(createDemoGame("web-online-sidebar-info-only")).state;
    await renderOnlineGame(game);

    const sidebar = screen.getByLabelText("Match information and players");
    expect(within(sidebar).queryByRole("button", { name: /Copy Invite|Copy/ })).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole("button", { name: "Leave" })).not.toBeInTheDocument();

    const roomControls = screen.getAllByLabelText("Room controls");
    expect(roomControls.length).toBeGreaterThan(0);
    expect(roomControls.some((controls) => within(controls).queryByRole("button", { name: /Copy Invite|Copy/ }) !== null)).toBe(true);
    expect(roomControls.some((controls) => within(controls).queryByRole("button", { name: "Leave" }) !== null)).toBe(true);
  });

  it("shows randomized special-card costs on the in-board action button", async () => {
    let game = completeSetup(createDemoGame("web-special-cost-visible")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game.config.rules = {
      ...game.config.rules,
      specialCardCostRandomized: true,
      specialCardCost: { ...emptyResources(), timber: 1, brick: 1, fiber: 1 },
    };
    game = withResources(game, "p1", { timber: 1, brick: 1, fiber: 1 });

    const { sentMessages } = await renderOnlineGame(game);

    const specialButton = screen.getByRole("button", { name: "Draw special card. Cost: 1 Timber, 1 Brick, 1 Fiber" });
    expect(specialButton).toHaveAttribute("data-tooltip", "Special card cost: 1 Timber, 1 Brick, 1 Fiber");
    expect(specialButton.querySelector(".action-cost-icons .resource-icon-timber")).not.toBeNull();
    expect(specialButton.querySelector(".action-cost-icons .resource-icon-brick")).not.toBeNull();
    expect(specialButton.querySelector(".action-cost-icons .resource-icon-fiber")).not.toBeNull();
    fireEvent.click(specialButton);
    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "COMMAND", command: { type: "BUY_SPECIAL_CARD", playerId: "p1" } }),
    ])));
  });

  it("submits settlement and road construction from their explicit board modes", async () => {
    let game = completeSetup(createDemoGame("web-construction-actions")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game = withResources(game, "p1", { timber: 10, brick: 10, grain: 10, fiber: 10, ore: 10 });
    let road = getLegalActions(game, "p1").find((action) => action.type === "BUILD_ROAD");
    for (let index = 0; index < 8 && !getLegalActions(game, "p1").some((action) => action.type === "BUILD_SETTLEMENT"); index += 1) {
      if (road?.type !== "BUILD_ROAD" || !road.edges[0]) break;
      game = applyOrThrow(game, { type: "BUILD_ROAD", playerId: "p1", edgeId: road.edges[0] });
      road = getLegalActions(game, "p1").find((action) => action.type === "BUILD_ROAD");
    }
    const { sentMessages } = await renderOnlineGame(game);
    const actionBar = screen.getByLabelText("Turn actions");
    const settlementButton = within(actionBar).getByRole("button", { name: "Build settlement" });
    expect(settlementButton).toBeEnabled();
    fireEvent.click(settlementButton);
    fireEvent.click(screen.getAllByRole("button", { name: /Build settlement at corner/ })[0]!);
    fireEvent.click(within(actionBar).getByRole("button", { name: "Build road" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Build road here/ })[0]!);

    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "COMMAND", command: expect.objectContaining({ type: "BUILD_SETTLEMENT" }) }),
      expect.objectContaining({ type: "COMMAND", command: expect.objectContaining({ type: "BUILD_ROAD" }) }),
    ])));
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

  it("falls back from stale city and settlement modes after canonical resource changes", async () => {
    let game = completeSetup(createDemoGame("web-build-mode-fallback")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game = withResources(game, "p1", { timber: 10, brick: 10, grain: 10, fiber: 10, ore: 10 });
    for (let index = 0; index < 8 && !getLegalActions(game, "p1").some((action) => action.type === "BUILD_SETTLEMENT"); index += 1) {
      const road = getLegalActions(game, "p1").find((action) => action.type === "BUILD_ROAD");
      if (road?.type !== "BUILD_ROAD" || !road.edges[0]) break;
      game = applyOrThrow(game, { type: "BUILD_ROAD", playerId: "p1", edgeId: road.edges[0] });
    }
    const { room, sockets } = await renderOnlineGame(game);
    const socket = sockets[0];
    if (!socket) throw new Error("expected online socket");
    const actions = screen.getByLabelText("Turn actions");
    const roadButton = within(actions).getByRole("button", { name: "Build road" });

    fireEvent.click(within(actions).getByRole("button", { name: "Upgrade city" }));
    const roadOnly = withResources(game, "p1", { timber: 10, brick: 10, grain: 0, fiber: 0, ore: 0 });
    act(() => socket.receive({ type: "ROOM_STATE", room: { ...room, game: serializeForViewer(roadOnly, "p1") } }));
    await waitFor(() => expect(roadButton).toHaveClass("selected"));

    act(() => socket.receive({ type: "ROOM_STATE", room: { ...room, game: serializeForViewer(game, "p1") } }));
    const settlementButton = within(actions).getByRole("button", { name: "Build settlement" });
    await waitFor(() => expect(settlementButton).toBeEnabled());
    fireEvent.click(settlementButton);
    act(() => socket.receive({ type: "ROOM_STATE", room: { ...room, game: serializeForViewer(roadOnly, "p1") } }));
    await waitFor(() => expect(roadButton).toHaveClass("selected"));
  });

  it("renders settlement houses from ownership when building details are absent", async () => {
    const game = completeSetup(createDemoGame("web-legacy-settlement-rendering")).state;
    const settlementCount = Object.keys(game.settlements).length;
    expect(settlementCount).toBeGreaterThan(0);
    game.buildings = {};

    await renderOnlineGame(game);

    expect(document.querySelectorAll(".house-building")).toHaveLength(settlementCount);
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
    expect(screen.getByLabelText("Bank holdings")).toBeInTheDocument();
    const handDevCards = screen.getByLabelText("Your development cards in hand");
    expect(within(handDevCards).getByRole("button", { name: "Victory Point: Secret +1 VP" })).toHaveAttribute("aria-disabled", "true");
    const roadBuildingButton = within(handDevCards).getByRole("button", { name: "Road Building: Ready" });
    expect(roadBuildingButton).toBeEnabled();
    expect(screen.queryByLabelText("Development cards")).not.toBeInTheDocument();
    expect(within(handDevCards).queryByRole("button", { name: /^e\d+$/ })).not.toBeInTheDocument();

    fireEvent.click(roadBuildingButton);
    expect(within(handDevCards).getByRole("button", { name: "Road Building: 0/2 roads" })).toBeInTheDocument();
    expect(within(handDevCards).queryByRole("button", { name: /^e\d+$/ })).not.toBeInTheDocument();

    const firstRoad = screen.getAllByRole("button", { name: /Build road here/ })[0]!;
    fireEvent.click(firstRoad);
    expect(within(handDevCards).getByRole("button", { name: "Road Building: 1/2 roads" })).toBeInTheDocument();
    const selectedRoad = document.querySelector<SVGElement>(".edge-build-target.selected")?.closest<SVGElement>(".edge-build-control");
    if (!selectedRoad) throw new Error("expected the selected Road Building edge");
    fireEvent.click(selectedRoad);
    expect(within(handDevCards).getByRole("button", { name: "Road Building: 0/2 roads" })).toBeInTheDocument();
    const refreshedFirstRoad = screen.getAllByRole("button", { name: /Build road here/ })[0]!;
    fireEvent.click(refreshedFirstRoad);
    const secondRoad = screen.getAllByRole("button", { name: /Build road here/ }).find((button) => button !== refreshedFirstRoad);
    if (!secondRoad) throw new Error("expected a second Road Building edge");
    fireEvent.click(secondRoad);

    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "COMMAND",
        command: expect.objectContaining({ type: "PLAY_ROAD_BUILDING", playerId: "p1", cardId: "road-card", edgeIds: expect.any(Array) }),
      }),
    ])));
  });

  it("groups repeated development cards in the hand rack", async () => {
    const game = completeSetup(createDemoGame("web-dev-card-groups")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game.players.p1!.developmentCards = [
      { id: "knight-a", type: "KNIGHT", ownerId: "p1", boughtTurn: game.turn - 1 },
      { id: "knight-b", type: "KNIGHT", ownerId: "p1", boughtTurn: game.turn - 1 },
      { id: "vp-a", type: "VICTORY_POINT", ownerId: "p1", boughtTurn: game.turn - 1 },
    ];
    game.players.p1!.specialCards = 3;
    game.players.p2!.resources = { ...emptyResources(), timber: 1 };

    await renderOnlineGame(game);

    const handDevCards = screen.getByLabelText("Your development cards in hand");
    expect(within(handDevCards).getByRole("button", { name: "Knight x2: Ready" })).toBeEnabled();
    expect(within(handDevCards).getByText("x2")).toBeInTheDocument();
    expect(within(handDevCards).queryAllByRole("button", { name: /Knight/ })).toHaveLength(1);
    expect(within(handDevCards).getByRole("button", { name: "Victory Point: Secret +1 VP" })).toHaveAttribute("aria-disabled", "true");
  });

  it("limits Year of Plenty picks to resources the bank can supply", async () => {
    const game = completeSetup(createDemoGame("web-year-of-plenty-bank")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game.players.p1!.developmentCards = [{ id: "plenty-card", type: "YEAR_OF_PLENTY", ownerId: "p1", boughtTurn: game.turn - 1 }];
    game.players.p1!.specialCards = 1;
    game.resourceBank = { ...emptyResources(), timber: 1, brick: 2, grain: 1, fiber: 1, ore: 0 };

    const { sentMessages } = await renderOnlineGame(game);

    const handDevCards = screen.getByLabelText("Your development cards in hand");
    fireEvent.click(within(handDevCards).getByRole("button", { name: "Year of Plenty: Ready" }));
    const overlay = screen.getByLabelText("Year of Plenty card choice");
    expect(within(overlay).queryByRole("button", { name: "Choose Ore as first Year of Plenty resource" })).not.toBeInTheDocument();
    expect(within(overlay).queryByRole("button", { name: "Choose Ore as second Year of Plenty resource" })).not.toBeInTheDocument();

    fireEvent.click(within(overlay).getByRole("button", { name: "Choose Timber as first Year of Plenty resource" }));
    expect(within(overlay).queryByRole("button", { name: "Choose Timber as second Year of Plenty resource" })).not.toBeInTheDocument();
    expect(within(overlay).getByRole("button", { name: "Choose Brick as second Year of Plenty resource" })).toBeInTheDocument();
    fireEvent.click(within(overlay).getByRole("button", { name: "Choose Brick as second Year of Plenty resource" }));
    fireEvent.click(within(overlay).getByRole("button", { name: "Take resources" }));
    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "COMMAND", command: { type: "PLAY_YEAR_OF_PLENTY", playerId: "p1", cardId: "plenty-card", resources: ["timber", "brick"] } }),
    ])));
  });

  it("uses the board robber chooser for Knight targeting", async () => {
    const game = completeSetup(createDemoGame("web-knight-targeting")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game.players.p1!.developmentCards = [{ id: "knight-card", type: "KNIGHT", ownerId: "p1", boughtTurn: game.turn - 1 }];
    game.players.p1!.specialCards = 1;
    game.players.p2!.resources = { ...emptyResources(), timber: 1 };

    const { sentMessages } = await renderOnlineGame(game);
    const handDevCards = screen.getByLabelText("Your development cards in hand");
    fireEvent.click(within(handDevCards).getByRole("button", { name: "Knight: Ready" }));

    expect(screen.queryByRole("button", { name: /Steal from/ })).not.toBeInTheDocument();
    const targetHex = screen.getAllByRole("button", { name: /Select robber destination on/ })[0];
    expect(targetHex).toBeDefined();
    fireEvent.keyDown(targetHex!, { key: "Enter" });
    fireEvent.click(within(screen.getByLabelText("Choose player to rob")).getByRole("button", { name: "Close robber chooser" }));
    expect(screen.queryByLabelText("Choose player to rob")).not.toBeInTheDocument();
    fireEvent.keyDown(targetHex!, { key: "Enter" });
    const chooser = screen.getByLabelText("Choose player to rob");
    fireEvent.click(within(chooser).getAllByRole("button", { name: /Steal from/ })[0]!);

    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "COMMAND",
        command: expect.objectContaining({ type: "PLAY_KNIGHT", playerId: "p1", cardId: "knight-card", stealFromPlayerId: expect.any(String) }),
      }),
    ])));
  });

  it("moves the robber immediately when no adjacent player has a card to steal", async () => {
    const game = completeSetup(createDemoGame("web-empty-robber-target")).state;
    game.phase = { type: "MOVING_THIEF", activePlayerId: "p1", rollerId: "p1" };
    for (const player of Object.values(game.players)) player.resources = emptyResources();
    const { sentMessages } = await renderOnlineGame(game);

    const targetHex = screen.getAllByRole("button", { name: /Move robber to/ })[0];
    if (!targetHex) throw new Error("expected an empty robber destination");
    fireEvent.click(targetHex);

    expect(screen.queryByLabelText("Choose player to rob")).not.toBeInTheDocument();
    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "COMMAND",
        command: expect.objectContaining({ type: "MOVE_THIEF", playerId: "p1" }),
      }),
    ])));
  });

  it("selects discard cards from the hand rack instead of opening trade", async () => {
    const game = completeSetup(createDemoGame("web-discard-hand")).state;
    game.players.p1!.resources = { ...emptyResources(), timber: 8 };
    game.phase = { type: "DISCARDING", activePlayerId: "p1", rollerId: "p2", pending: { p1: 4 }, submitted: {} };

    const { sentMessages } = await renderOnlineGame(game);

    expect(screen.getByLabelText("Discard resources")).toBeInTheDocument();
    const discardPanel = screen.getByLabelText("Discard resources");
    expect(within(screen.getByLabelText("Match information and players")).queryByLabelText("Discard resources")).not.toBeInTheDocument();
    await waitFor(() => expect(within(discardPanel).getByText(/0\/4 · \d+:\d{2}/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Select Timber to discard" }));
    expect(screen.queryByLabelText("Trade interface")).not.toBeInTheDocument();
    expect(screen.getByText("x1")).toBeInTheDocument();
    expect(within(discardPanel).getByRole("button", { name: "Clear" })).toBeInTheDocument();
    expect(within(discardPanel).queryByRole("button", { name: "+" })).not.toBeInTheDocument();
    fireEvent.click(within(discardPanel).getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("x1")).not.toBeInTheDocument();
    for (let index = 0; index < 4; index += 1) fireEvent.click(screen.getByRole("button", { name: "Select Timber to discard" }));
    fireEvent.click(within(discardPanel).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "COMMAND", command: expect.objectContaining({ type: "DISCARD_RESOURCES", resources: expect.objectContaining({ timber: 4 }) }) }),
    ])));
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

  it("lets an online offerer cancel a staged trade", async () => {
    let game = completeSetup(createDemoGame("web-online-trade-cancel")).state;
    game = applyOrThrow(game, { type: "ROLL_DICE", playerId: "p1" });
    game = withResources({ ...game, phase: { type: "ACTION_PHASE", activePlayerId: "p1" } }, "p1", { timber: 1 });
    game = applyOrThrow(game, {
      type: "OFFER_TRADE",
      playerId: "p1",
      tradeId: "online-cancel",
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
    });
    const { sentMessages } = await renderOnlineGame(game);

    fireEvent.click(within(screen.getByLabelText("Trade interface")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "COMMAND", command: { type: "CANCEL_TRADE", playerId: "p1", tradeId: "online-cancel" } }),
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
    const completed = completeSetup(createDemoGame("web-finished-replay"));
    const game = completed.state;
    game.phase = { type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" };

    await renderOnlineGame(game, {
      replayResponse: () => new Response(JSON.stringify({ config: game.config, board: game.board, events: completed.events }), { status: 200 }),
    });

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
    const eventCount = completed.events.length;
    fireEvent.click(screen.getByRole("button", { name: "Prev" }));
    expect(screen.getByText(`${eventCount - 1}/${eventCount}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(`${eventCount}/${eventCount}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(screen.queryByLabelText("Replay controls")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open replay" }));
    expect(await screen.findByLabelText("Replay controls")).toBeInTheDocument();
  });

  it("surfaces replay hydration and explicit replay-loading failures", async () => {
    const game = completeSetup(createDemoGame("web-replay-failure")).state;
    game.phase = { type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" };
    let replayRequests = 0;
    await renderOnlineGame(game, {
      replayResponse: () => {
        replayRequests += 1;
        return Promise.reject(new Error("replay request failed"));
      },
    });

    await waitFor(() => expect(replayRequests).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));

    await waitFor(() => expect(replayRequests).toBe(2));
    expect(await screen.findByText("replay request failed")).toBeInTheDocument();
    expect(screen.queryByLabelText("Replay controls")).not.toBeInTheDocument();
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

  it("rejects lobby mutations that race with a disconnected socket and still leaves cleanly", async () => {
    const sentMessages: Array<{ type: string }> = [];
    const lobbyRoom = {
      id: "room_race", code: "RACE01", status: "LOBBY", hostUserId: "u_host",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4, botDifficulty: "medium", rules: { mapPreset: "standard" } },
      seats: [
        { seatIndex: 0, userId: "u_host", displayName: "Host", ready: true, connected: true },
        { seatIndex: 1, userId: "u_guest", displayName: "Guest", ready: true, connected: true },
        { seatIndex: 2, botId: "bot_3", displayName: "Bot 3", ready: true, connected: true },
        { seatIndex: 3, ready: false, connected: false },
      ],
      spectatorCount: 0, events: [],
    };
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static latest: FakeWebSocket | undefined;
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string) {
        super();
        FakeWebSocket.latest = this;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(payload: string): void {
        const message = JSON.parse(payload) as { type: string };
        sentMessages.push(message);
        if (message.type === "JOIN_ROOM") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: lobbyRoom }) })));
      }
      close(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/sessions")) return new Response(JSON.stringify({ token: "s_host", userId: "u_host", displayName: "Host" }), { status: 200 });
      if (url.endsWith("/rooms")) return new Response(JSON.stringify(lobbyRoom), { status: 200 });
      if (url.endsWith("/ws-tickets")) return new Response(JSON.stringify({ ticket: "wst_race", expiresAt: "2026-07-16T00:01:00.000Z", ttlMs: 30_000 }), { status: 201 });
      return new Response("not found", { status: 404 });
    }));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));
    expect(await screen.findByLabelText("Online lobby")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Name cannot be empty")).toBeInTheDocument();

    const socket = FakeWebSocket.latest;
    if (!socket) throw new Error("expected lobby socket");
    socket.readyState = 3;
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Host Again" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Unready" }));
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    const bots = within(screen.getByRole("group", { name: "Lobby bots" }));
    fireEvent.click(bots.getByRole("button", { name: "Add Bot" }));
    fireEvent.click(bots.getByRole("button", { name: "Remove Bot" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Lobby map" })).getByRole("button", { name: "Continent" }));
    expect(screen.getByText("Online room is not connected yet")).toBeInTheDocument();
    expect(sentMessages.filter((message) => message.type !== "JOIN_ROOM")).toEqual([]);

    socket.readyState = FakeWebSocket.OPEN;
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(sentMessages).toContainEqual({ type: "LEAVE_ROOM", roomId: "RACE01" });
    expect(screen.getByLabelText("Match setup")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Unready" }));
    fireEvent.click(go);

    expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "READY", roomId: "GO1234", ready: false }),
      expect.objectContaining({ type: "START_ROOM", roomId: "GO1234" }),
    ]));
  });

  it("applies ordered server events, requests a resync for gaps, and accepts canonical snapshots", async () => {
    const game = completeSetup(createDemoGame("online-event-stream")).state;
    const { sentMessages, sockets } = await renderOnlineGame(game);
    const socket = sockets[0];
    if (!socket) throw new Error("expected online socket");
    const rolled = applyCommand(game, { type: "ROLL_DICE", playerId: "p1" });
    if (!rolled.ok) throw new Error(rolled.error.message);

    act(() => socket.receive({ type: "EVENTS", events: rolled.value.events }));
    await waitFor(() => expect(screen.getByText("ACTION PHASE")).toBeInTheDocument());

    const lastSeq = rolled.value.events.at(-1)?.seq ?? game.eventSeq;
    const gapEvent: GameEvent = {
      schemaVersion: game.schemaVersion,
      seq: lastSeq + 2,
      type: "TURN_ENDED",
      playerId: "p1",
      nextPlayerId: "p2",
    };
    act(() => socket.receive({ type: "EVENTS", events: [gapEvent] }));
    expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "RESYNC", roomId: "PLAY01", lastSeq }),
    ]));

    const canonical = serializeForViewer(rolled.value.nextState, "p1");
    act(() => socket.receive({ type: "RESYNC", events: [], snapshot: canonical }));
    await waitFor(() => expect(screen.getByLabelText("Game board and actions")).toBeInTheDocument());

    act(() => socket.receive({ type: "COMMAND_ACK" }));
    act(() => socket.receive("{"));
    expect(await screen.findByText("BAD_JSON")).toBeInTheDocument();
  });

  it("hydrates a finished online replay and closes terminal rooms on server errors", async () => {
    const game = completeSetup(createDemoGame("online-game-over")).state;
    const { sockets } = await renderOnlineGame(game);
    const socket = sockets[0];
    if (!socket) throw new Error("expected online socket");
    const gameOver: GameEvent = {
      schemaVersion: game.schemaVersion,
      seq: game.eventSeq + 1,
      type: "GAME_OVER",
      winnerId: "p1",
      reason: "VICTORY_POINTS",
    };

    act(() => socket.receive({ type: "EVENTS", events: [gameOver] }));
    await waitFor(() => expect(screen.getAllByText("Game over").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByRole("button", { name: "Replay" })).toBeEnabled());

    act(() => socket.receive({ type: "COMMAND_REJECTED", code: "ROOM_CLOSED", message: "closed by server" }));
    await waitFor(() => expect(screen.getAllByText("Room closed").length).toBeGreaterThan(0));
  });

  it("surfaces room lookup and online creation failures without entering a stale lobby", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rooms/EXPIRE")) {
        return new Response(JSON.stringify({ code: "ROOM_EXPIRED", status: "EXPIRED", cleanupReason: "EMPTY_LOBBY_TTL" }), { status: 404 });
      }
      return new Response("not found", { status: 404 });
    }));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Room code"), { target: { value: "expire" } });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByText("Room expired")).toBeInTheDocument();
    expect(screen.queryByLabelText("Online lobby")).not.toBeInTheDocument();

    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Player Match/ }));
    expect(await screen.findByText("Session creation failed")).toBeInTheDocument();
    expect(screen.queryByLabelText("Online lobby")).not.toBeInTheDocument();
  });

  it("surfaces a thrown room lookup failure without creating a session", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("room lookup transport failed");
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<App />);
    fireEvent.change(screen.getByLabelText("Room code"), { target: { value: "throw1" } });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    expect(await screen.findByText("room lookup transport failed")).toBeInTheDocument();
    expect(screen.queryByLabelText("Online lobby")).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("activates, cancels, and submits Monopoly from the development-card rack", async () => {
    const game = completeSetup(createDemoGame("web-monopoly-choice")).state;
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    game.players.p1!.developmentCards = [{ id: "monopoly-card", type: "MONOPOLY", ownerId: "p1", boughtTurn: game.turn - 1 }];
    game.players.p1!.specialCards = 1;
    const { sentMessages } = await renderOnlineGame(game);
    const hand = screen.getByLabelText("Your development cards in hand");

    fireEvent.click(within(hand).getByRole("button", { name: "Monopoly: Ready" }));
    expect(screen.getByLabelText("Monopoly card choice")).toBeInTheDocument();
    fireEvent.click(within(screen.getByLabelText("Monopoly card choice")).getByRole("button", { name: "Close Monopoly chooser" }));
    expect(screen.queryByLabelText("Monopoly card choice")).not.toBeInTheDocument();

    fireEvent.click(within(hand).getByRole("button", { name: "Monopoly: Ready" }));
    fireEvent.click(within(screen.getByLabelText("Monopoly card choice")).getByRole("button", { name: "Choose Ore for Monopoly" }));
    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "COMMAND", command: { type: "PLAY_MONOPOLY", playerId: "p1", cardId: "monopoly-card", resource: "ore" } }),
    ])));
  });

  it("edits, clears, offers, and submits bank trades from actual resource holdings", async () => {
    let game = completeSetup(createDemoGame("web-trade-controls")).state;
    game = withResources(game, "p1", { timber: 6 });
    game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    const { sentMessages } = await renderOnlineGame(game);

    fireEvent.click(screen.getByRole("button", { name: "Open trade" }));
    const panel = screen.getByLabelText("Trade interface");
    fireEvent.click(within(panel).getByRole("button", { name: "Close trade" }));
    expect(screen.queryByLabelText("Trade interface")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open trade" }));
    const reopenedPanel = screen.getByLabelText("Trade interface");
    fireEvent.click(within(reopenedPanel).getByRole("button", { name: "Offer Timber" }));
    fireEvent.click(within(reopenedPanel).getByRole("button", { name: "Request Grain" }));
    const enabledRemoveGrain = within(reopenedPanel).getAllByRole("button", { name: "Remove Grain" })
      .find((button) => !(button as HTMLButtonElement).disabled);
    if (!enabledRemoveGrain) throw new Error("expected selected grain to be removable");
    fireEvent.click(enabledRemoveGrain);
    fireEvent.click(within(reopenedPanel).getByRole("button", { name: "Request Grain" }));
    const enabledRemoveTimber = within(reopenedPanel).getAllByRole("button", { name: "Remove Timber" })
      .find((button) => !(button as HTMLButtonElement).disabled);
    if (!enabledRemoveTimber) throw new Error("expected selected timber to be removable");
    fireEvent.click(enabledRemoveTimber);
    expect(within(reopenedPanel).getByRole("button", { name: "Offer" })).toBeDisabled();

    fireEvent.click(within(reopenedPanel).getByRole("button", { name: "Offer Timber" }));
    fireEvent.click(within(reopenedPanel).getByRole("button", { name: "Clear" }));
    expect(within(reopenedPanel).getByRole("button", { name: "Clear" })).toBeDisabled();

    for (let count = 0; count < 4; count += 1) fireEvent.click(within(reopenedPanel).getByRole("button", { name: "Offer Timber" }));
    fireEvent.click(within(reopenedPanel).getByRole("button", { name: "Request Grain" }));
    expect(within(reopenedPanel).getByRole("button", { name: "Bank" })).toBeEnabled();
    fireEvent.click(within(reopenedPanel).getByRole("button", { name: "Bank" }));
    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "COMMAND", command: { type: "MARITIME_TRADE", playerId: "p1", offered: "timber", requested: "grain" } }),
    ])));

    fireEvent.click(screen.getByRole("button", { name: "Open trade" }));
    const reopened = screen.getByLabelText("Trade interface");
    fireEvent.click(within(reopened).getByRole("button", { name: "Offer Timber" }));
    fireEvent.click(within(reopened).getByRole("button", { name: "Request Grain" }));
    fireEvent.click(within(reopened).getByRole("button", { name: "Offer" }));
    await waitFor(() => expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "COMMAND", command: expect.objectContaining({ type: "OFFER_TRADE", playerId: "p1", recipients: "ANY" }) }),
    ])));
  });

  it("joins invite links, copies fallback invites, and retries a dropped lobby socket", async () => {
    const sentMessages: Array<{ type: string }> = [];
    const sockets: FakeWebSocket[] = [];
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { userAgent: window.navigator.userAgent, maxTouchPoints: 0, clipboard: { writeText } });
    const lobbyRoom = {
      id: "room_joined", code: "JOIN01", status: "LOBBY", hostUserId: "host",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4, botDifficulty: "medium", rules: { mapPreset: "standard" } },
      seats: [{ seatIndex: 0, userId: "host", displayName: "Host", ready: false, connected: true }, { seatIndex: 1, userId: "guest", displayName: "Guest", ready: false, connected: true }],
      spectatorCount: 0, events: [],
    };
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string) {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(payload: string): void {
        const message = JSON.parse(payload) as { type: string };
        sentMessages.push(message);
        if (message.type === "JOIN_ROOM") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: lobbyRoom }) })));
      }
      close(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rooms/JOIN01")) return new Response(JSON.stringify(lobbyRoom), { status: 200 });
      if (url.endsWith("/sessions")) return new Response(JSON.stringify({ token: "s_guest", userId: "guest", displayName: "Guest" }), { status: 200 });
      if (url.endsWith("/ws-tickets")) return new Response(JSON.stringify({ ticket: `wst_${sockets.length}`, expiresAt: "2026-07-14T00:01:00.000Z", ttlMs: 30_000 }), { status: 201 });
      return new Response("not found", { status: 404 });
    }));
    window.history.replaceState({}, "", "/?room=join01");

    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByLabelText("Online lobby")).toBeInTheDocument();
    expect(sentMessages).toEqual(expect.arrayContaining([expect.objectContaining({ type: "JOIN_ROOM" })]));

    fireEvent.click(screen.getByRole("button", { name: "Copy Invite" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?room=JOIN01`));
    writeText.mockRejectedValueOnce(new Error("clipboard blocked"));
    fireEvent.click(screen.getByRole("button", { name: "Copy Invite" }));
    expect(await screen.findByText(`${window.location.origin}/?room=JOIN01`)).toBeInTheDocument();

    act(() => sockets[0]?.close());
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(sockets.length).toBe(2));
  });

  it("offers a retry when the initial websocket ticket request fails", async () => {
    const sockets: FakeWebSocket[] = [];
    let ticketRequests = 0;
    const lobbyRoom = {
      id: "room_retry", code: "RETRY1", status: "LOBBY", hostUserId: "host",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4, botDifficulty: "medium", rules: { mapPreset: "standard" } },
      seats: [{ seatIndex: 0, userId: "host", displayName: "Host", ready: false, connected: true }, { seatIndex: 1, ready: false, connected: false }],
      spectatorCount: 0, events: [],
    };
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string) {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(payload: string): void {
        const message = JSON.parse(payload) as { type: string };
        if (message.type === "JOIN_ROOM") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: lobbyRoom }) })));
      }
      close(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rooms/RETRY1")) return new Response(JSON.stringify(lobbyRoom), { status: 200 });
      if (url.endsWith("/sessions")) return new Response(JSON.stringify({ token: "s_guest", userId: "guest", displayName: "Guest" }), { status: 200 });
      if (url.endsWith("/ws-tickets")) {
        ticketRequests += 1;
        if (ticketRequests === 1) return new Response(JSON.stringify({ code: "UNAVAILABLE" }), { status: 503 });
        return new Response(JSON.stringify({ ticket: "wst_retry", expiresAt: "2026-07-16T00:01:00.000Z", ttlMs: 30_000 }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }));
    window.history.replaceState({}, "", "/?room=RETRY1");

    render(<App />);

    expect(await screen.findByLabelText("Online lobby")).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("WebSocket ticket creation failed")).toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(ticketRequests).toBe(2));
    await waitFor(() => expect(sockets).toHaveLength(1));
  });

  it("resumes a saved online room without creating a replacement session", async () => {
    const sentMessages: Array<{ type: string; roomId?: string }> = [];
    const savedValues = new Map<string, string>();
    const resumeStorage = {
      getItem: (key: string) => savedValues.get(key) ?? null,
      setItem: (key: string, value: string) => savedValues.set(key, value),
      removeItem: (key: string) => savedValues.delete(key),
    };
    vi.stubGlobal("localStorage", resumeStorage);
    const lobbyRoom = {
      id: "room_resumed", code: "RESUME", status: "LOBBY", hostUserId: "u_saved",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4, botDifficulty: "medium", rules: { mapPreset: "standard" } },
      seats: [{ seatIndex: 0, userId: "u_saved", displayName: "Saved", ready: false, connected: true }, { seatIndex: 1, ready: false, connected: false }],
      spectatorCount: 0, events: [],
    };
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(payload: string): void {
        const message = JSON.parse(payload) as { type: string; roomId?: string };
        sentMessages.push(message);
        if (message.type === "JOIN_ROOM") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: lobbyRoom }) })));
      }
      close(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/ws-tickets")) return new Response(JSON.stringify({ ticket: "wst_resumed", expiresAt: "2026-07-16T00:01:00.000Z", ttlMs: 30_000 }), { status: 201 });
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    writeResumeState(
      { token: "s_saved", userId: "u_saved", roomId: lobbyRoom.id, roomCode: lobbyRoom.code, clientSeq: 7, lastSeq: 3 },
      resumeStorage,
    );
    expect(resumeStorage.getItem("colonizt.resume")).not.toBeNull();

    render(<App />);

    expect(await screen.findByLabelText("Online lobby")).toBeInTheDocument();
    expect(sentMessages).toContainEqual({ type: "JOIN_ROOM", roomId: "RESUME" });
    expect(fetchSpy.mock.calls.some(([input]) => String(input).endsWith("/sessions"))).toBe(false);
    expect(screen.getByText("RESUME")).toBeInTheDocument();
  });
});
