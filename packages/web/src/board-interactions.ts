import {
  eligibleStealTargets,
  emptyResources,
  resourceCount,
  type EdgeId,
  type GameState,
  type HexId,
  type PlayerId,
} from "@colonizt/game-core";

export const firstStealTarget = (state: GameState, playerId: PlayerId, hexId: HexId): PlayerId | undefined =>
  eligibleStealTargets(state, playerId, hexId)
    .sort((left, right) =>
      (state.players[right]?.score ?? 0) - (state.players[left]?.score ?? 0)
      || resourceCount(state.players[right]?.resources ?? emptyResources()) - resourceCount(state.players[left]?.resources ?? emptyResources())
      || state.playerOrder.indexOf(left) - state.playerOrder.indexOf(right),
    )[0];

export const roadBuildingCandidateEdgesFor = (options: EdgeId[][], selected: EdgeId[], requiredCount: number): EdgeId[] => {
  if (selected.length === 0) return [...new Set(options.map((option) => option[0]).filter((edgeId): edgeId is EdgeId => Boolean(edgeId)))];
  if (selected.length >= requiredCount) return [];
  return [...new Set(options
    .filter((option) => option[0] === selected[0])
    .map((option) => option[1])
    .filter((edgeId): edgeId is EdgeId => Boolean(edgeId)))];
};

export const boardBounds = (state: Pick<GameState, "board">): { minX: number; minY: number; width: number; height: number } => {
  const vertices = Object.values(state.board.vertices);
  const xs = vertices.map((vertex) => vertex.x);
  const ys = vertices.map((vertex) => vertex.y);
  const minX = Math.min(...xs) - 1.1;
  const maxX = Math.max(...xs) + 1.1;
  const minY = Math.min(...ys) - 1.1;
  const maxY = Math.max(...ys) + 3.0;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
};
