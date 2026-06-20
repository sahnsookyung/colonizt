import { useState } from "react";
import { emptyResources, type ResourceBundle } from "@colonizt/game-core";
import type { TradeDraft } from "../trade-draft.js";

export const useTradeDraft = () => {
  const [tradeOffer, setTradeOffer] = useState<ResourceBundle>(() => emptyResources());
  const [tradeRequest, setTradeRequest] = useState<ResourceBundle>(() => emptyResources());
  const [tradeOpen, setTradeOpen] = useState(false);

  const setTradeDraft = (draft: TradeDraft): void => {
    setTradeOffer(draft.offer);
    setTradeRequest(draft.request);
  };

  const clearTradeDraft = (): void => setTradeDraft({ offer: emptyResources(), request: emptyResources() });

  return {
    tradeOffer,
    setTradeOffer,
    tradeRequest,
    setTradeRequest,
    tradeOpen,
    setTradeOpen,
    setTradeDraft,
    clearTradeDraft,
  };
};
