// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("renders the match setup menu first", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Colonizt" })).toBeInTheDocument();
    expect(screen.getByLabelText("Match setup")).toBeInTheDocument();
    expect(screen.getByLabelText("Game options")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bot Match/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Player Match/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Randomized balanced map")).toBeChecked();
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

    expect(screen.getByText("Difficulty hard · Random map · Doubles x2 · Plight turn 20")).toBeInTheDocument();
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
    const setupRoads = screen.getAllByRole("button", { name: /Build road on edge/ });
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
    const setupRoads = screen.getAllByRole("button", { name: /Build road on edge/ });
    fireEvent.click(setupRoads[0]!);
    expect(screen.getByText("Active: Briar")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText("Active: Briar")).not.toBeInTheDocument();
  });

  it("can ready a local bot-filled game", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ready" }));
    expect(screen.getByText(/WAITING FOR ROLL|ACTION PHASE|SETUP PLACEMENT/)).toBeInTheDocument();
  });

  it("disables invalid selected player trades", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ready" }));
    fireEvent.click(screen.getByRole("button", { name: "Roll dice" }));
    const thiefPanel = screen.queryByLabelText("Move robber");
    if (thiefPanel) {
      fireEvent.click(within(thiefPanel).getAllByRole("button")[0]!);
    }
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
    fireEvent.click(screen.getByRole("button", { name: "Ready" }));
    expect(screen.getByRole("button", { name: "Roll dice" })).toHaveAttribute("aria-keyshortcuts", "R");
    fireEvent.keyDown(window, { key: "r" });
    expect(screen.getByText(/Roll \d+/)).toBeInTheDocument();
    const thiefPanel = screen.queryByLabelText("Move robber");
    if (thiefPanel) fireEvent.click(within(thiefPanel).getAllByRole("button")[0]!);
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
    fireEvent.click(screen.getByRole("button", { name: "Ready" }));

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

  it("auto-rolls and auto-ends when phase timers expire", () => {
    vi.useFakeTimers();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ready" }));

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

  it("opens replay mode", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(screen.getByText(/^Replay \d+\/\d+/)).toBeInTheDocument();
  }, 15_000);

  it("loads persisted match history on demand", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      {
        id: "match_demo",
        roomId: "room_demo",
        mode: "CLASSIC",
        ranked: false,
        startedAt: "2026-06-14T00:00:00.000Z",
        eventCount: 3,
        playerIds: ["p1", "p2"],
      },
    ]), { status: 200 })));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByRole("button", { name: "CLASSIC · 3 events" })).toBeInTheDocument();
  });
});
