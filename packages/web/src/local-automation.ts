import type { GameState, PlayerId } from "@colonizt/game-core";

export const localBotPlayerIdsForState = (state: Pick<GameState, "playerOrder">, humanPlayerId: PlayerId): PlayerId[] =>
  state.playerOrder.filter((playerId) => playerId !== humanPlayerId);

export const isLocalBotPlayer = (state: Pick<GameState, "playerOrder">, humanPlayerId: PlayerId, playerId: PlayerId | undefined): playerId is PlayerId =>
  Boolean(playerId && localBotPlayerIdsForState(state, humanPlayerId).includes(playerId));

export const localBotAutomationKey = ({
  enabled,
  state,
  activePlayer,
  humanPlayerId,
}: {
  enabled: boolean;
  state: GameState;
  activePlayer: PlayerId | undefined;
  humanPlayerId: PlayerId;
}): string | null => {
  if (!enabled || state.phase.type === "GAME_OVER" || !isLocalBotPlayer(state, humanPlayerId, activePlayer)) return null;
  return `${state.config.matchId}:${state.eventSeq}:${state.phase.type}:${activePlayer}`;
};

export const nextLocalTradeDeadlines = (
  current: Record<string, number>,
  collectingTrades: Array<GameState["trades"][string]>,
  now = Date.now(),
  responseWindowMs = 15_000,
): Record<string, number> => {
  const next: Record<string, number> = {};
  for (const trade of collectingTrades) {
    if (trade.status === "COLLECTING_RESPONSES") {
      next[trade.id] = current[trade.id] ?? now + responseWindowMs;
    }
  }
  return next;
};
