import { emptyResources, resources, type Resource, type ResourceBundle } from "@colonizt/game-core";

export interface TradeDraft {
  offer: ResourceBundle;
  request: ResourceBundle;
}

const maxTradeWantCount = 9;

export const normalizeTradeDraft = (
  draft: TradeDraft,
  playerResources: ResourceBundle,
  bankRatioByResource: Partial<Record<Resource, number>> = {},
): TradeDraft => {
  const offer = emptyResources();
  const request = emptyResources();
  for (const resource of resources) {
    offer[resource] = Math.max(0, Math.min(playerResources[resource], Math.floor(draft.offer[resource] ?? 0)));
    request[resource] = Math.max(0, Math.min(maxTradeWantCount, Math.floor(draft.request[resource] ?? 0)));
    if (offer[resource] > 0 && request[resource] > 0) request[resource] = 0;
    const ratio = bankRatioByResource[resource];
    if (ratio && offer[resource] > 0 && offer[resource] < ratio) offer[resource] = Math.min(offer[resource], playerResources[resource]);
  }
  return { offer, request };
};
