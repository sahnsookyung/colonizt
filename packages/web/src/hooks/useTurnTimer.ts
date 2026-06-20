import { useEffect, useRef, useState } from "react";
import type { GameState, PlayerId } from "@colonizt/game-core";

export interface TurnDeadline {
  key: string;
  dueAt: number;
  durationMs: number;
  mode: "roll" | "action";
}

export interface UseTurnTimerOptions {
  state: GameState;
  activePlayer: PlayerId | undefined;
  paused: boolean;
  networkRoomId: string | null;
  rollDeadlineMs: number;
  actionDeadlineMs: number;
  onLocalTimeout(key: string): void;
}

export const useTurnTimer = ({
  state,
  activePlayer,
  paused,
  networkRoomId,
  rollDeadlineMs,
  actionDeadlineMs,
  onLocalTimeout,
}: UseTurnTimerOptions) => {
  const [turnDeadline, setTurnDeadline] = useState<TurnDeadline | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const timeoutRef = useRef(onLocalTimeout);

  useEffect(() => {
    timeoutRef.current = onLocalTimeout;
  }, [onLocalTimeout]);

  useEffect(() => {
    const phaseMode = state.phase.type === "WAITING_FOR_ROLL"
      ? "roll"
      : state.phase.type === "ACTION_PHASE"
        ? "action"
        : null;
    if (!phaseMode || !activePlayer || paused || state.phase.type === "GAME_OVER") {
      setTurnDeadline(null);
      return undefined;
    }

    const durationMs = phaseMode === "roll" ? rollDeadlineMs : actionDeadlineMs;
    const key = `${state.config.matchId}:${state.turn}:${state.phase.type}:${activePlayer}`;
    const dueAt = Date.now() + durationMs;
    setNowMs(Date.now());
    setTurnDeadline((current) => current?.key === key ? current : { key, dueAt, durationMs, mode: phaseMode });

    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    const timeout = setTimeout(() => {
      if (!networkRoomId) timeoutRef.current(key);
    }, durationMs);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [actionDeadlineMs, activePlayer, networkRoomId, paused, rollDeadlineMs, state.config.matchId, state.phase.type, state.turn]);

  return { nowMs, turnDeadline };
};
