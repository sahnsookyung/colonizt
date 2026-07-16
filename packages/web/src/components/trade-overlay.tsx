import { emptyResources, hasResources, resourceCount, resources, type GameState, type PlayerId, type Resource, type ResourceBundle, type TradeOffer } from "@colonizt/game-core";
import { TradeBundle, TradeResourceButton, formatTimer } from "./game-ui.js";
import { AccessibleDialog } from "./accessible-dialog.js";

interface TradeOverlayProps {
  visible: boolean;
  state: GameState;
  humanPlayerId: PlayerId;
  online: boolean;
  activeTrade?: TradeOffer;
  recipientIds: PlayerId[];
  selectedResponder: PlayerId | null;
  selectedResponderCanFinalize: boolean;
  stagedTradeSeconds?: number;
  selectedMaritimeTrade?: { ratio: number };
  bankOfferResource?: Resource;
  previewMaritimeRatio: number;
  tradeOffer: ResourceBundle;
  tradeRequest: ResourceBundle;
  canSubmitOfferTrade: boolean;
  onClose(): void;
  onSelectResponder(playerId: PlayerId): void;
  onCancel(tradeId: string): void;
  onFinalize(tradeId: string, playerId: PlayerId): void;
  onRespond(tradeId: string, response: "WANTS_ACCEPT" | "REJECTED"): void;
  onIncrement(side: "offer" | "request", resource: Resource): void;
  onDecrement(side: "offer" | "request", resource: Resource): void;
  onClear(): void;
  onBank(): void;
  onOffer(): void;
}

export const TradeOverlay = ({
  visible,
  state,
  humanPlayerId,
  online,
  activeTrade,
  recipientIds,
  selectedResponder,
  selectedResponderCanFinalize,
  stagedTradeSeconds,
  selectedMaritimeTrade,
  bankOfferResource,
  previewMaritimeRatio,
  tradeOffer,
  tradeRequest,
  canSubmitOfferTrade,
  onClose,
  onSelectResponder,
  onCancel,
  onFinalize,
  onRespond,
  onIncrement,
  onDecrement,
  onClear,
  onBank,
  onOffer,
}: TradeOverlayProps) => {
  if (!visible) return null;
  const humanPlayer = state.players[humanPlayerId];
  return (
    <AccessibleDialog className="trade-panel trade-overlay" label="Trade interface" {...(!activeTrade ? { onClose } : {})}>
      <div className="panel-title">
        <strong>{activeTrade ? "Trade Responses" : "Trade"}</strong>
        <span>{activeTrade
          ? stagedTradeSeconds !== undefined ? `${formatTimer(stagedTradeSeconds)} left` : "waiting"
          : selectedMaritimeTrade ? `${selectedMaritimeTrade.ratio}:1 bank ready` : bankOfferResource ? `${previewMaritimeRatio}:1 bank` : "select cards"}</span>
        {!activeTrade ? <button type="button" className="icon-button" onClick={onClose} aria-label="Close trade">x</button> : null}
      </div>
      {activeTrade ? (
        <div className="staged-trade" aria-label="Staged trade response overlay">
          <div className="incoming-trade-bundles"><TradeBundle bundle={activeTrade.offered} /><span>for</span><TradeBundle bundle={activeTrade.requested} /></div>
          {activeTrade.fromPlayerId === humanPlayerId ? (
            <>
              <div className="trade-response-list" aria-live="polite">
                {recipientIds.map((playerId) => {
                  const response = activeTrade.responses?.[playerId]?.status ?? "PENDING";
                  const canAfford = online || hasResources(state.players[playerId]?.resources ?? emptyResources(), activeTrade.requested);
                  return (
                    <button key={playerId} type="button" className={`trade-response-row ${selectedResponder === playerId ? "selected" : ""}`} onClick={() => onSelectResponder(playerId)} disabled={response !== "WANTS_ACCEPT" || !canAfford}>
                      <span style={{ color: state.players[playerId]?.color }}>{state.players[playerId]?.name ?? playerId}</span>
                      <strong>{!canAfford ? "Cannot afford" : response === "WANTS_ACCEPT" ? "Wants to accept" : response === "REJECTED" ? "Rejected" : "Pending"}</strong>
                    </button>
                  );
                })}
              </div>
              <div className="trade-actions">
                <button type="button" onClick={() => onCancel(activeTrade.id)}>Cancel</button>
                <button type="button" onClick={() => selectedResponder && onFinalize(activeTrade.id, selectedResponder)} disabled={!selectedResponderCanFinalize}>Trade</button>
              </div>
            </>
          ) : (
            <div className="incoming-trade">
              <div>
                <strong>{state.players[activeTrade.fromPlayerId]?.name ?? activeTrade.fromPlayerId} offers</strong>
                <span>{activeTrade.responses?.[humanPlayerId]?.status === "WANTS_ACCEPT" ? "Waiting for the offerer." : activeTrade.responses?.[humanPlayerId]?.status === "REJECTED" ? "You rejected this offer." : "Choose your response."}</span>
              </div>
              <div className="incoming-trade-actions">
                <button type="button" onClick={() => onRespond(activeTrade.id, "WANTS_ACCEPT")} disabled={!humanPlayer || !hasResources(humanPlayer.resources, activeTrade.requested)}>Want to accept</button>
                <button type="button" onClick={() => onRespond(activeTrade.id, "REJECTED")}>Reject</button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="trade-picker"><span>Give</span><div className="trade-card-grid">
            {resources.map((resource) => <TradeResourceButton key={resource} resource={resource} owned={humanPlayer?.resources[resource] ?? 0} selected={tradeOffer[resource]} onIncrement={() => onIncrement("offer", resource)} onDecrement={() => onDecrement("offer", resource)} />)}
          </div></div>
          <div className="trade-picker"><span>Want</span><div className="trade-card-grid">
            {resources.map((resource) => <TradeResourceButton key={resource} resource={resource} owned={0} selected={tradeRequest[resource]} request onIncrement={() => onIncrement("request", resource)} onDecrement={() => onDecrement("request", resource)} />)}
          </div></div>
          <div className="trade-actions">
            <button type="button" onClick={onClear} disabled={resourceCount(tradeOffer) + resourceCount(tradeRequest) === 0}>Clear</button>
            <button type="button" onClick={onBank} disabled={!selectedMaritimeTrade}>Bank</button>
            <button type="button" onClick={onOffer} disabled={!canSubmitOfferTrade}>Offer</button>
          </div>
        </>
      )}
    </AccessibleDialog>
  );
};
