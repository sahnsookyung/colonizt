import type { GameState, PlayerId } from "@colonizt/game-core";

export const localBotPlayerIds = ["p2", "p3", "p4"] as const satisfies readonly PlayerId[];
export const localBotIds = new Set<PlayerId>(localBotPlayerIds);

export const isLocalBotPlayer = (playerId: PlayerId | undefined): playerId is PlayerId =>
  Boolean(playerId && localBotIds.has(playerId));

export const localBotAutomationKey = ({
  enabled,
  state,
  activePlayer,
}: {
  enabled: boolean;
  state: GameState;
  activePlayer: PlayerId | undefined;
}): string | null => {
  if (!enabled || state.phase.type === "GAME_OVER" || !isLocalBotPlayer(activePlayer)) return null;
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
