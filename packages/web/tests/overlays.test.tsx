// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { emptyResources, serializeForViewer, type TradeOffer } from "@colonizt/game-core";
import { createDemoGame } from "@colonizt/demo-state";
import { SpecialCardOverlays } from "../src/components/special-card-overlays.js";
import { TradeOverlay } from "../src/components/trade-overlay.js";
import { AccessibleDialog } from "../src/components/accessible-dialog.js";

afterEach(cleanup);

describe("accessible dialog", () => {
  it("moves focus into the dialog, closes on Escape, and restores focus", () => {
    const Harness = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
          {open ? <AccessibleDialog className="dialog" label="Test dialog" onClose={() => setOpen(false)}><button type="button">Action</button><button type="button">Secondary</button></AccessibleDialog> : null}
        </>
      );
    };
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Test dialog" });
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(opener).toHaveAttribute("inert");
    fireEvent.keyDown(dialog, { key: "Tab" });
    const action = screen.getByRole("button", { name: "Action" });
    const secondary = screen.getByRole("button", { name: "Secondary" });
    expect(action).toHaveFocus();
    secondary.focus();
    fireEvent.keyDown(secondary, { key: "Tab" });
    expect(action).toHaveFocus();
    fireEvent.keyDown(action, { key: "Tab", shiftKey: true });
    expect(secondary).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Test dialog" })).not.toBeInTheDocument();
    expect(opener).not.toHaveAttribute("inert");
    expect(opener).toHaveFocus();
  });
});

describe("special card overlays", () => {
  it("routes Monopoly and Year of Plenty choices through explicit callbacks", () => {
    const state = createDemoGame("special-overlays");
    const onClose = vi.fn();
    const onPlayMonopoly = vi.fn();
    const onSetYearOfPlenty = vi.fn();
    const onPlayYearOfPlenty = vi.fn();
    render(
      <SpecialCardOverlays
        state={state}
        viewer={serializeForViewer(state, "p1")}
        monopolyCardId="monopoly_1"
        yearOfPlentyCardId="plenty_1"
        yearOfPlentyFirstOptions={["timber", "grain"]}
        yearOfPlentySecondOptions={["brick", "ore"]}
        selectedYearOfPlenty={["timber", "brick"]}
        canTakeYearOfPlenty
        onClose={onClose}
        onPlayMonopoly={onPlayMonopoly}
        onSetYearOfPlenty={onSetYearOfPlenty}
        onPlayYearOfPlenty={onPlayYearOfPlenty}
      />,
    );

    fireEvent.click(within(screen.getByLabelText("Monopoly card choice")).getByRole("button", { name: "Choose Ore for Monopoly" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose Grain as first Year of Plenty resource" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose Ore as second Year of Plenty resource" }));
    fireEvent.click(screen.getByRole("button", { name: "Take resources" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Monopoly chooser" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Year of Plenty chooser" }));

    expect(onPlayMonopoly).toHaveBeenCalledWith("monopoly_1", "ore");
    expect(onSetYearOfPlenty).toHaveBeenCalledWith(0, "grain");
    expect(onSetYearOfPlenty).toHaveBeenCalledWith(1, "ore");
    expect(onPlayYearOfPlenty).toHaveBeenCalledWith("plenty_1", ["timber", "brick"]);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders no modal and disables an unaffordable Year of Plenty choice", () => {
    const state = createDemoGame("special-overlays-disabled");
    const { rerender } = render(
      <SpecialCardOverlays
        state={state}
        viewer={serializeForViewer(state, "p1")}
        yearOfPlentyFirstOptions={[]}
        yearOfPlentySecondOptions={[]}
        selectedYearOfPlenty={["timber", "timber"]}
        canTakeYearOfPlenty={false}
        onClose={vi.fn()}
        onPlayMonopoly={vi.fn()}
        onSetYearOfPlenty={vi.fn()}
        onPlayYearOfPlenty={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(
      <SpecialCardOverlays
        state={state}
        viewer={serializeForViewer(state, "p1")}
        yearOfPlentyCardId="plenty_2"
        yearOfPlentyFirstOptions={[]}
        yearOfPlentySecondOptions={[]}
        selectedYearOfPlenty={["timber", "timber"]}
        canTakeYearOfPlenty={false}
        onClose={vi.fn()}
        onPlayMonopoly={vi.fn()}
        onSetYearOfPlenty={vi.fn()}
        onPlayYearOfPlenty={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Take resources" })).toBeDisabled();
  });

  it("falls back from viewer bank data to authoritative and exhausted bank counts", () => {
    const state = createDemoGame("special-overlays-bank-fallback");
    state.resourceBank!.ore = 4;
    const viewer = { ...serializeForViewer(state, "p1"), resourceBank: undefined };
    const { rerender } = render(
      <SpecialCardOverlays
        state={state}
        viewer={viewer}
        monopolyCardId="monopoly_fallback"
        yearOfPlentyFirstOptions={["ore"]}
        yearOfPlentySecondOptions={["grain"]}
        selectedYearOfPlenty={["ore", "grain"]}
        canTakeYearOfPlenty
        onClose={vi.fn()}
        onPlayMonopoly={vi.fn()}
        onSetYearOfPlenty={vi.fn()}
        onPlayYearOfPlenty={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Choose Ore for Monopoly" })).toHaveTextContent("4");

    const exhaustedState = { ...state, resourceBank: undefined };
    rerender(
      <SpecialCardOverlays
        state={exhaustedState}
        viewer={viewer}
        monopolyCardId="monopoly_exhausted"
        yearOfPlentyCardId="plenty_exhausted"
        yearOfPlentyFirstOptions={["ore"]}
        yearOfPlentySecondOptions={["grain"]}
        selectedYearOfPlenty={["ore", "grain"]}
        canTakeYearOfPlenty={false}
        onClose={vi.fn()}
        onPlayMonopoly={vi.fn()}
        onSetYearOfPlenty={vi.fn()}
        onPlayYearOfPlenty={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Choose Ore for Monopoly" })).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: "Choose Ore as first Year of Plenty resource" })).toHaveTextContent("0");
  });
});

describe("trade overlay", () => {
  const callbacks = () => ({
    onClose: vi.fn(), onSelectResponder: vi.fn(), onCancel: vi.fn(), onFinalize: vi.fn(), onRespond: vi.fn(),
    onIncrement: vi.fn(), onDecrement: vi.fn(), onClear: vi.fn(), onBank: vi.fn(), onOffer: vi.fn(),
  });

  it("supports draft editing, bank trading, offer submission, and closing", () => {
    const state = createDemoGame("trade-draft-overlay");
    state.players.p1!.resources.timber = 3;
    const handlers = callbacks();
    render(
      <TradeOverlay
        visible
        state={state}
        humanPlayerId="p1"
        online={false}
        recipientIds={[]}
        selectedResponder={null}
        selectedResponderCanFinalize={false}
        stagedTradeSeconds={8}
        selectedMaritimeTrade={{ ratio: 3 }}
        bankOfferResource="timber"
        previewMaritimeRatio={3}
        tradeOffer={{ ...emptyResources(), timber: 2 }}
        tradeRequest={{ ...emptyResources(), grain: 1, ore: 1 }}
        canSubmitOfferTrade
        {...handlers}
      />,
    );
    const overlay = screen.getByLabelText("Trade interface");
    fireEvent.click(within(overlay).getByRole("button", { name: "Offer Timber" }));
    fireEvent.click(within(overlay).getAllByRole("button", { name: "Remove Timber" }).find((button) => !button.hasAttribute("disabled"))!);
    fireEvent.click(within(overlay).getByRole("button", { name: "Request Grain" }));
    fireEvent.click(within(overlay).getAllByRole("button", { name: "Remove Grain" }).find((button) => !button.hasAttribute("disabled"))!);
    fireEvent.click(within(overlay).getByRole("button", { name: "Clear" }));
    fireEvent.click(within(overlay).getByRole("button", { name: "Bank" }));
    fireEvent.click(within(overlay).getByRole("button", { name: "Offer" }));
    fireEvent.click(within(overlay).getByRole("button", { name: "Close trade" }));
    expect(handlers.onIncrement).toHaveBeenCalledWith("offer", "timber");
    expect(handlers.onDecrement).toHaveBeenCalledWith("offer", "timber");
    expect(handlers.onIncrement).toHaveBeenCalledWith("request", "grain");
    expect(handlers.onDecrement).toHaveBeenCalledWith("request", "grain");
    expect(handlers.onClear).toHaveBeenCalledOnce();
    expect(handlers.onBank).toHaveBeenCalledOnce();
    expect(handlers.onOffer).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("lets the offerer select an affordable acceptance and finalize or cancel", () => {
    const state = createDemoGame("trade-offerer-overlay");
    state.players.p2!.resources.ore = 1;
    const trade: TradeOffer = {
      id: "trade_1", fromPlayerId: "p1", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 },
      recipients: ["p2", "p3"], status: "COLLECTING_RESPONSES", createdAtSeq: 1, expiresAtSeq: 10,
      responses: {
        p2: { playerId: "p2", status: "WANTS_ACCEPT", respondedAtSeq: 2 },
        p3: { playerId: "p3", status: "REJECTED", respondedAtSeq: 3 },
      },
    };
    const handlers = callbacks();
    render(
      <TradeOverlay visible state={state} humanPlayerId="p1" online={false} activeTrade={trade} recipientIds={["p2", "p3"]} selectedResponder="p2" selectedResponderCanFinalize stagedTradeSeconds={5} previewMaritimeRatio={4} tradeOffer={emptyResources()} tradeRequest={emptyResources()} canSubmitOfferTrade={false} {...handlers} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Briar.*Wants to accept/i }));
    fireEvent.click(screen.getByRole("button", { name: "Trade" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Close trade" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Trade interface" }), { key: "Escape" });
    expect(handlers.onSelectResponder).toHaveBeenCalledWith("p2");
    expect(handlers.onFinalize).toHaveBeenCalledWith("trade_1", "p2");
    expect(handlers.onCancel).toHaveBeenCalledWith("trade_1");
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("lets a recipient accept or reject and stays absent when closed", () => {
    const state = createDemoGame("trade-recipient-overlay");
    state.players.p2!.resources.ore = 1;
    const trade: TradeOffer = {
      id: "trade_2", fromPlayerId: "p1", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 },
      recipients: ["p2"], status: "COLLECTING_RESPONSES", createdAtSeq: 1, expiresAtSeq: 10,
      responses: { p2: { playerId: "p2", status: "PENDING" } },
    };
    const handlers = callbacks();
    const { rerender } = render(
      <TradeOverlay visible state={state} humanPlayerId="p2" online activeTrade={trade} recipientIds={["p2"]} selectedResponder={null} selectedResponderCanFinalize={false} previewMaritimeRatio={4} tradeOffer={emptyResources()} tradeRequest={emptyResources()} canSubmitOfferTrade={false} {...handlers} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Want to accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(handlers.onRespond).toHaveBeenNthCalledWith(1, "trade_2", "WANTS_ACCEPT");
    expect(handlers.onRespond).toHaveBeenNthCalledWith(2, "trade_2", "REJECTED");
    rerender(<TradeOverlay visible={false} state={state} humanPlayerId="p2" online recipientIds={[]} selectedResponder={null} selectedResponderCanFinalize={false} previewMaritimeRatio={4} tradeOffer={emptyResources()} tradeRequest={emptyResources()} canSubmitOfferTrade={false} {...handlers} />);
    expect(screen.queryByLabelText("Trade interface")).not.toBeInTheDocument();
  });

  it("shows pending, rejected, unaffordable, and online offerer response states", () => {
    const state = createDemoGame("trade-response-states");
    state.players.p2!.resources.ore = 1;
    state.players.p3!.resources.ore = 1;
    state.players.p4!.resources.ore = 1;
    const trade: TradeOffer = {
      id: "trade_states", fromPlayerId: "p1", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 },
      recipients: ["p2", "p3", "p4", "departed"], status: "COLLECTING_RESPONSES", createdAtSeq: 1, expiresAtSeq: 10,
      responses: {
        p2: { playerId: "p2", status: "WANTS_ACCEPT" },
        p3: { playerId: "p3", status: "REJECTED" },
        departed: { playerId: "departed", status: "WANTS_ACCEPT" },
      },
    };
    const handlers = callbacks();
    const props = { visible: true, state, humanPlayerId: "p1", activeTrade: trade, recipientIds: ["p2", "p3", "p4", "departed"], selectedResponder: null, selectedResponderCanFinalize: false, previewMaritimeRatio: 4, tradeOffer: emptyResources(), tradeRequest: emptyResources(), canSubmitOfferTrade: false, ...handlers } as const;
    const { rerender } = render(<TradeOverlay {...props} online={false} />);

    expect(screen.getByText("waiting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Briar.*Wants to accept/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Cyra.*Rejected/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Dax.*Pending/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /departed.*Cannot afford/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Trade" })).toBeDisabled();

    rerender(<TradeOverlay {...props} online selectedResponder="departed" />);
    expect(screen.getByRole("button", { name: /departed.*Wants to accept/i })).toHaveClass("selected");
  });

  it("renders recipient status transitions and disables acceptance without a seated player", () => {
    const state = createDemoGame("trade-recipient-statuses");
    const baseTrade: TradeOffer = {
      id: "trade_recipient_states", fromPlayerId: "departed_offerer", offered: { ...emptyResources(), brick: 1 }, requested: { ...emptyResources(), ore: 1 },
      recipients: ["p2"], status: "COLLECTING_RESPONSES", createdAtSeq: 1, expiresAtSeq: 10,
      responses: { p2: { playerId: "p2", status: "WANTS_ACCEPT" } },
    };
    const handlers = callbacks();
    const props = { visible: true, state, online: false, activeTrade: baseTrade, recipientIds: ["p2"], selectedResponder: null, selectedResponderCanFinalize: false, previewMaritimeRatio: 4, tradeOffer: emptyResources(), tradeRequest: emptyResources(), canSubmitOfferTrade: false, ...handlers } as const;
    const { rerender } = render(<TradeOverlay {...props} humanPlayerId="p2" />);
    expect(screen.getByText("departed_offerer offers")).toBeInTheDocument();
    expect(screen.getByText("Waiting for the offerer.")).toBeInTheDocument();

    rerender(<TradeOverlay {...props} humanPlayerId="p2" activeTrade={{ ...baseTrade, responses: { p2: { playerId: "p2", status: "REJECTED" } } }} />);
    expect(screen.getByText("You rejected this offer.")).toBeInTheDocument();

    rerender(<TradeOverlay {...props} humanPlayerId="departed_recipient" activeTrade={{ ...baseTrade, responses: {} }} />);
    expect(screen.getByText("Choose your response.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Want to accept" })).toBeDisabled();
  });

  it("disables empty draft actions and distinguishes bank previews", () => {
    const state = createDemoGame("trade-empty-draft");
    const handlers = callbacks();
    const props = { visible: true, state, humanPlayerId: "departed", online: false, recipientIds: [], selectedResponder: null, selectedResponderCanFinalize: false, previewMaritimeRatio: 4, tradeOffer: emptyResources(), tradeRequest: emptyResources(), canSubmitOfferTrade: false, ...handlers } as const;
    const { rerender } = render(<TradeOverlay {...props} />);
    expect(screen.getByText("select cards")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bank" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Offer" })).toBeDisabled();

    rerender(<TradeOverlay {...props} bankOfferResource="timber" />);
    expect(screen.getByText("4:1 bank")).toBeInTheDocument();
  });
});
