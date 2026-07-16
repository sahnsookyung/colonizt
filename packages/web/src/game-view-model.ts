import {
  emptyResources,
  hasResources,
  maritimeTradeRatio,
  resourceCount,
  resources,
  type GameState,
  type PlayerId,
  type Resource,
  type ResourceBundle,
  type ViewerState,
} from "@colonizt/game-core";
import { mapPresetLabels } from "./match-options.js";

export interface MaritimeTradeOption {
  offered: Resource;
  requested: Resource;
  ratio: number;
}

export const selectMaritimeTradeDraft = (
  state: GameState,
  humanPlayerId: PlayerId,
  tradeOffer: ResourceBundle,
  tradeRequest: ResourceBundle,
  maritimeTrades: MaritimeTradeOption[],
) => {
  const humanPlayer = state.players[humanPlayerId];
  const offered = resources.filter((resource) => tradeOffer[resource] > 0);
  const requested = resources.filter((resource) => tradeRequest[resource] > 0);
  const singleOfferResource = offered.length === 1 ? offered[0] : undefined;
  const previewMaritimeRatio = humanPlayer && singleOfferResource
    ? maritimeTradeRatio(state, humanPlayerId, singleOfferResource)
    : 4;
  const bankOfferResource = singleOfferResource && tradeOffer[singleOfferResource] === previewMaritimeRatio
    ? singleOfferResource
    : undefined;
  const bankRequestResource = requested.length === 1 && tradeRequest[requested[0]!] === 1
    ? requested[0]
    : undefined;
  const selectedMaritimeTrade = bankOfferResource && bankRequestResource
    ? maritimeTrades.find((trade) => trade.offered === bankOfferResource && trade.requested === bankRequestResource)
    : undefined;
  return { previewMaritimeRatio, bankOfferResource, bankRequestResource, selectedMaritimeTrade };
};

export const selectYearOfPlentyDraft = (
  state: Pick<GameState, "resourceBank">,
  available: Resource[],
  draft: [Resource, Resource],
) => {
  const optionsFor = (otherPick?: Resource): Resource[] =>
    available.filter((resource) => (state.resourceBank?.[resource] ?? 0) > (otherPick === resource ? 1 : 0));
  const firstOptions = available;
  const first = firstOptions.includes(draft[0]) ? draft[0] : firstOptions[0] ?? "timber";
  const secondOptions = optionsFor(first);
  const second = secondOptions.includes(draft[1]) ? draft[1] : secondOptions[0] ?? available[0] ?? "timber";
  const selected: [Resource, Resource] = [first, second];
  const canTake = available.length > 0 && hasResources(state.resourceBank, {
    ...emptyResources(),
    [first]: first === second ? 2 : 1,
    [second]: first === second ? 2 : 1,
  });
  return { firstOptions, secondOptions, selected, canTake };
};

export const viewerPlayer = (viewer: ViewerState, playerId: PlayerId) =>
  viewer.players.find((player) => player.id === playerId);

export const visiblePlayerResourceCount = (
  state: GameState,
  viewer: ViewerState,
  playerId: PlayerId,
): number => viewerPlayer(viewer, playerId)?.resourceCount
  ?? resourceCount(state.players[playerId]?.resources ?? emptyResources());

export const visibleStealTargets = (
  state: GameState,
  viewer: ViewerState,
  humanPlayerId: PlayerId,
  hexId: string,
): PlayerId[] => {
  const targets = new Set<PlayerId>();
  for (const vertexId of state.board.adjacency.hexToVertices[hexId] ?? []) {
    const owner = state.settlements[vertexId];
    if (!owner || owner === humanPlayerId || visiblePlayerResourceCount(state, viewer, owner) <= 0) continue;
    targets.add(owner);
  }
  return [...targets].sort((left, right) =>
    (viewerPlayer(viewer, right)?.visibleVictoryPoints ?? state.players[right]?.score ?? 0)
      - (viewerPlayer(viewer, left)?.visibleVictoryPoints ?? state.players[left]?.score ?? 0)
    || visiblePlayerResourceCount(state, viewer, right) - visiblePlayerResourceCount(state, viewer, left)
    || state.playerOrder.indexOf(left) - state.playerOrder.indexOf(right));
};

export const displayPlayersForViewer = (
  state: GameState,
  viewer: ViewerState,
  humanPlayerId: PlayerId,
): ViewerState["players"] => viewer.players.map((player) => {
  if (player.id === humanPlayerId || state.phase.type === "GAME_OVER") return player;
  const publicPoints = player.publicVictoryPoints
    ?? Math.max(0, (player.visibleVictoryPoints ?? player.score) - (player.secretVictoryPoints ?? 0));
  return {
    ...player,
    score: publicPoints,
    secretVictoryPoints: 0,
    visibleVictoryPoints: publicPoints,
    victoryPointBreakdown: {
      ...player.victoryPointBreakdown,
      secret: 0,
      total: publicPoints,
    },
  };
});

export const activeRuleLabels = (state: GameState): string[] => [
  `Map ${mapPresetLabels[state.config.rules?.mapPreset ?? "standard"]}`,
  state.config.rules?.diceDoubles ? "Doubles x2" : undefined,
  state.config.rules?.plight ? `Plight turn ${state.config.rules.plightTurn ?? 20}` : undefined,
  state.config.rules?.specialCardCostRandomized ? "Random special cost" : undefined,
].filter((rule): rule is string => Boolean(rule));
