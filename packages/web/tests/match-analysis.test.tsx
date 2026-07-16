// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResources, serializeForViewer, type GameEvent } from "@colonizt/game-core";
import { createDemoGame } from "@colonizt/demo-state";
import { MatchAnalysis, victoryPointAria, victoryPointText } from "../src/components/match-analysis.js";

afterEach(cleanup);

describe("match analysis", () => {
  it("renders every analysis tab from match events and routes actions", () => {
    const state = createDemoGame("match-analysis");
    state.phase = { type: "GAME_OVER", winnerId: "p1" };
    state.players.p1!.score = 10;
    const players = serializeForViewer(state, "p1").players;
    players[0]!.victoryPointBreakdown = { settlements: 2, cities: 2, longestRoad: 2, largestArmy: 2, secret: 1, otherPublic: 1, total: 10 };
    const events = [
      { schemaVersion: 3, seq: 1, type: "DICE_ROLLED", playerId: "p1", dice: [3, 4], sum: 7, rngIndex: 0, rngPolicy: "SEEDED_DETERMINISTIC" },
      { schemaVersion: 3, seq: 2, type: "RESOURCES_PRODUCED", gains: { p1: { ...emptyResources(), timber: 2 } } },
      { schemaVersion: 3, seq: 3, type: "SPECIAL_CARD_BOUGHT", playerId: "p1", cost: emptyResources(), cardIndex: 0, cardId: "card_1", cardType: "KNIGHT" },
    ] as GameEvent[];
    const onTabChange = vi.fn();
    const onReplay = vi.fn();
    const onNewMatch = vi.fn();
    const props = { state, players, events, botPlayerIds: new Set(["p2"]), onTabChange, onReplay, onNewMatch };
    const { rerender } = render(<MatchAnalysis {...props} tab="overview" />);
    expect(screen.getByText(`${state.players.p1!.name} wins`)).toBeInTheDocument();
    expect(screen.getAllByText("10 VP").length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-controls", "analysis-panel-overview");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "analysis-tab-overview");
    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    fireEvent.keyDown(overviewTab, { key: "ArrowLeft" });
    expect(onTabChange).toHaveBeenCalledWith("development");
    expect(screen.getByRole("tab", { name: "Development Cards" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Development Cards" }), { key: "Home" });
    expect(onTabChange).toHaveBeenCalledWith("overview");
    expect(overviewTab).toHaveFocus();
    fireEvent.keyDown(overviewTab, { key: "End" });
    expect(onTabChange).toHaveBeenCalledWith("development");
    fireEvent.click(screen.getByRole("tab", { name: "Dice Stats" }));
    expect(onTabChange).toHaveBeenCalledWith("dice");
    fireEvent.click(screen.getByRole("button", { name: "Open replay" }));
    fireEvent.click(screen.getByRole("button", { name: "New Match" }));
    expect(onReplay).toHaveBeenCalledOnce();
    expect(onNewMatch).toHaveBeenCalledOnce();

    rerender(<MatchAnalysis {...props} tab="dice" />);
    expect(screen.getByLabelText("Dice roll counts")).toHaveTextContent("7");
    rerender(<MatchAnalysis {...props} tab="resources" />);
    expect(screen.getByLabelText("Resource cards drawn")).toHaveTextContent("2");
    rerender(<MatchAnalysis {...props} tab="development" />);
    expect(screen.getByLabelText("Development cards drawn")).toHaveTextContent("Knight");
  });

  it("formats public and secret victory points and hides outside game over", () => {
    const state = createDemoGame("match-analysis-hidden");
    const player = serializeForViewer(state, "p1").players[0]!;
    expect(victoryPointText(player)).toBe("0 VP");
    expect(victoryPointText(player, true)).toBe("0VP");
    expect(victoryPointAria(player)).toBe("0 victory points");
    const secretPlayer = { ...player, score: 4, publicVictoryPoints: 3, visibleVictoryPoints: 4, secretVictoryPoints: 1 };
    expect(victoryPointText(secretPlayer)).toBe("3 (4) VP");
    expect(victoryPointText(secretPlayer, true)).toBe("3(4)VP");
    expect(victoryPointAria(secretPlayer)).toBe("4 victory points, including 1 secret victory point");
    expect(render(<MatchAnalysis state={state} players={[player]} events={[]} botPlayerIds={new Set()} tab="overview" onTabChange={vi.fn()} onReplay={vi.fn()} onNewMatch={vi.fn()} />).container).toBeEmptyDOMElement();
  });

  it("handles departed winners and incomplete historical scoring metadata", () => {
    const state = createDemoGame("match-analysis-historical-fallbacks");
    state.phase = { type: "GAME_OVER", winnerId: "departed_winner" };
    const serialized = serializeForViewer(state, "p1").players;
    const first = {
      ...serialized[0]!,
      score: 5,
      visibleVictoryPoints: undefined,
      publicVictoryPoints: undefined,
      secretVictoryPoints: 2,
      victoryPointBreakdown: { settlements: 2, cities: 0, longestRoad: 2, largestArmy: 0, secret: 2, otherPublic: 0, total: 6 },
    };
    const second = {
      ...serialized[1]!,
      score: 5,
      visibleVictoryPoints: undefined,
      publicVictoryPoints: undefined,
      secretVictoryPoints: 0,
      victoryPointBreakdown: { settlements: 1, cities: 1, longestRoad: 0, largestArmy: 2, secret: 0, otherPublic: 1, total: 5 },
    };
    const legacy = {
      ...serialized[2]!,
      score: 1,
      visibleVictoryPoints: undefined,
      publicVictoryPoints: undefined,
      secretVictoryPoints: undefined,
      victoryPointBreakdown: undefined,
    };

    render(
      <MatchAnalysis
        state={state}
        players={[second, legacy, first]}
        events={[]}
        botPlayerIds={new Set([second.id])}
        tab="overview"
        onTabChange={vi.fn()}
        onReplay={vi.fn()}
        onNewMatch={vi.fn()}
      />,
    );

    expect(screen.getByText("departed_winner wins")).toBeInTheDocument();
    expect(screen.getByText("3 (5) VP")).toHaveClass("vp-secret");
    const settlementParts = screen.getAllByTitle("Settlements");
    expect(settlementParts[0]).toHaveClass("best");
    expect(settlementParts[1]).not.toHaveClass("best");
    expect(victoryPointAria(first)).toBe("5 victory points, including 2 secret victory points");
    expect(victoryPointAria({ ...first, secretVictoryPoints: undefined })).toBe("5 victory points");
    expect(victoryPointText({ ...first, publicVictoryPoints: 5 })).toBe("5 VP");
  });
});
