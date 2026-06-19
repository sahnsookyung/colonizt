import { createFixedBoard, replay, type BoardGraph, type GameConfig, type GameEvent, type GameState } from "@colonizt/game-core";
import { createDemoConfig, playBotGame } from "@colonizt/demo-state";

export interface ReplayLogState {
  config: GameConfig;
  board: BoardGraph;
  events: GameEvent[];
}

export const createDemoReplayLog = (seed = "web-replay", maxCommands = 220): ReplayLogState => {
  const played = playBotGame(seed, maxCommands);
  return { config: createDemoConfig(seed), board: createFixedBoard(), events: played.events };
};

export const replayAtIndex = (log: ReplayLogState, index: number): GameState => {
  const clamped = Math.max(0, Math.min(log.events.length, index));
  return replay({ ...log, events: log.events.slice(0, clamped) });
};
