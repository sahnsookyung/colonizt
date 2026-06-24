// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as DemoState from "@colonizt/demo-state";
import type * as GameCore from "@colonizt/game-core";

vi.mock("@colonizt/demo-state", async () => {
  const actual = await vi.importActual<typeof DemoState>("@colonizt/demo-state");
  const core = await vi.importActual<typeof GameCore>("@colonizt/game-core");
  return {
    ...actual,
    createDemoGame(seed?: string) {
      let state = actual.createDemoGame(seed);
      state = actual.withResources(state, "p1", { timber: 0, brick: 0, grain: 0, fiber: 0, ore: 1 });
      state = actual.withResources(state, "p2", { timber: 1, brick: 0, grain: 0, fiber: 0, ore: 0 });
      state.phase = { type: "ACTION_PHASE", activePlayerId: "p2" };
      state.eventSeq = 1;
      state.trades.bot_offer = {
        id: "bot_offer",
        fromPlayerId: "p2",
        offered: { ...core.emptyResources(), timber: 1 },
        requested: { ...core.emptyResources(), ore: 1 },
        recipients: "ANY",
        status: "COLLECTING_RESPONSES",
        createdAtSeq: 1,
        expiresAtSeq: 20,
        responses: {
          p1: { playerId: "p1", status: "PENDING" },
          p3: { playerId: "p3", status: "PENDING" },
          p4: { playerId: "p4", status: "PENDING" },
        },
      };
      return state;
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("incoming bot trades", () => {
  it("lets the human signal interest in a bot-originated offer", async () => {
    const { App } = await import("../src/App.js");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Bot Match/ }));
    expect(screen.getByLabelText("Staged trade response overlay")).toBeInTheDocument();
    expect(screen.getByText("Briar offers")).toBeInTheDocument();

    const accept = screen.getByRole("button", { name: "Want to accept" });
    expect(accept).toBeEnabled();
    fireEvent.click(accept);

    expect(screen.getByText("Waiting for the offerer.")).toBeInTheDocument();
  });
});
