import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  emptyResources,
  hasResources,
  type GameCommand,
  type GameEvent,
  type GameState,
  type PlayerId,
} from "@colonizt/game-core";
import { createBotTradeId, createBotView, evaluateTrade, greedyBot, randomLegalBot, scoreTradeResponder } from "@colonizt/bots";
import { isLocalBotPlayer, localBotAutomationKey, localBotIds, nextLocalTradeDeadlines } from "../local-automation.js";

const botById = {
  p2: randomLegalBot,
  p3: greedyBot,
  p4: randomLegalBot,
};

const botActionDelays = {
  PLACE_SETUP: 450,
  ROLL_DICE: 900,
  BUILD_ROAD: 550,
  DEFAULT: 450,
} as const;

interface LocalCommandResult {
  state: GameState;
  events: GameEvent[];
  error?: string;
}

export interface UseLocalAutomationOptions {
  enabled: boolean;
  state: GameState;
  events: readonly GameEvent[];
  activePlayer: PlayerId | undefined;
  humanPlayerId: PlayerId;
  localTradeDeadlines: Record<string, number>;
  setLocalTradeDeadlines: Dispatch<SetStateAction<Record<string, number>>>;
  stateRef: MutableRefObject<GameState>;
  eventsRef: MutableRefObject<GameEvent[]>;
  applyLocalCommandRef: MutableRefObject<(command: GameCommand) => LocalCommandResult>;
  postRollAnimationMs: number;
}

export const useLocalAutomation = ({
  enabled,
  state,
  events,
  activePlayer,
  humanPlayerId,
  localTradeDeadlines,
  setLocalTradeDeadlines,
  stateRef,
  eventsRef,
  applyLocalCommandRef,
  postRollAnimationMs,
}: UseLocalAutomationOptions): { clearAutomationTimers: () => void } => {
  const botTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tradeResponseTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastBotRollSeqRef = useRef<number | null>(null);

  const clearAutomationTimers = useCallback(() => {
    if (botTimerRef.current) clearTimeout(botTimerRef.current);
    botTimerRef.current = null;
    for (const timer of tradeResponseTimersRef.current.values()) clearTimeout(timer);
    tradeResponseTimersRef.current.clear();
  }, []);

  const botAutomationKey = localBotAutomationKey({ enabled, state, activePlayer });

  useEffect(() => {
    if (!botAutomationKey || !isLocalBotPlayer(activePlayer)) return undefined;
    const latestBotRoll = [...eventsRef.current].reverse().find((event) => event.type === "DICE_ROLLED" && event.playerId === activePlayer);
    const isPostRollAction = state.phase.type === "ACTION_PHASE" && latestBotRoll?.type === "DICE_ROLLED" && lastBotRollSeqRef.current !== latestBotRoll.seq;
    const activeCollectingTrade = Object.values(state.trades).find((trade) =>
      trade.status === "COLLECTING_RESPONSES"
      && trade.fromPlayerId === activePlayer,
    );
    const activeTradeIncludesHuman = activeCollectingTrade
      ? activeCollectingTrade.recipients === "ANY" || activeCollectingTrade.recipients.includes(humanPlayerId)
      : false;
    const baseDelay = state.phase.type === "WAITING_FOR_ROLL"
      ? botActionDelays.ROLL_DICE
      : state.phase.type === "SETUP_PLACEMENT"
        ? botActionDelays.PLACE_SETUP
        : botActionDelays.DEFAULT;
    const tradePauseDelay = activeCollectingTrade ? (activeTradeIncludesHuman ? 3200 : 1450) : undefined;
    const delay = tradePauseDelay ?? (isPostRollAction ? Math.max(botActionDelays.BUILD_ROAD, postRollAnimationMs + 120) : baseDelay);
    if (isPostRollAction && latestBotRoll?.type === "DICE_ROLLED") lastBotRollSeqRef.current = latestBotRoll.seq;
    botTimerRef.current = setTimeout(() => {
      const current = stateRef.current;
      const currentActive = "activePlayerId" in current.phase ? current.phase.activePlayerId : undefined;
      const currentKey = current.phase.type !== "GAME_OVER" && isLocalBotPlayer(currentActive)
        ? `${current.config.matchId}:${current.eventSeq}:${current.phase.type}:${currentActive}`
        : null;
      if (currentKey !== botAutomationKey || !currentActive) return;
      if (Object.values(current.trades).some((trade) => trade.status === "COLLECTING_RESPONSES" && trade.fromPlayerId === currentActive)) return;
      const controller = botById[currentActive as keyof typeof botById] ?? randomLegalBot;
      const view = createBotView(current, currentActive, controller.profile);
      const command = controller.chooseCommand(view, (prefix: string) => createBotTradeId(current, currentActive, controller.profile) || prefix);
      if (!command) return;
      const result = applyLocalCommandRef.current(command);
      if (result.error && current.phase.type === "ACTION_PHASE") {
        applyLocalCommandRef.current({ type: "END_TURN", playerId: currentActive });
      }
    }, delay);
    return () => {
      if (botTimerRef.current) clearTimeout(botTimerRef.current);
      botTimerRef.current = null;
    };
  }, [activePlayer, botAutomationKey, eventsRef, humanPlayerId, postRollAnimationMs, state.phase.type, state.trades, stateRef, applyLocalCommandRef]);

  useEffect(() => {
    if (!enabled) {
      clearAutomationTimers();
      return;
    }

    const collecting = Object.values(state.trades).filter((trade) => trade.status === "COLLECTING_RESPONSES");
    setLocalTradeDeadlines((current) => {
      const next = nextLocalTradeDeadlines(current, collecting);
      const currentEntries = Object.entries(current);
      const nextEntries = Object.entries(next);
      if (currentEntries.length === nextEntries.length && nextEntries.every(([tradeId, deadline]) => current[tradeId] === deadline)) {
        return current;
      }
      return next;
    });
    collecting.forEach((trade) => {
      const recipients = trade.recipients === "ANY"
        ? [...localBotIds].filter((botId) => botId !== trade.fromPlayerId)
        : trade.recipients.filter((botId) => localBotIds.has(botId));
      recipients.forEach((botId, index) => {
        if (trade.responses?.[botId]?.status !== "PENDING") return;
        const key = `response:${trade.id}:${botId}:${trade.createdAtSeq}`;
        if (tradeResponseTimersRef.current.has(key)) return;
        const timer = setTimeout(() => {
          tradeResponseTimersRef.current.delete(key);
          const current = stateRef.current;
          const currentTrade = current.trades[trade.id];
          if (!currentTrade || currentTrade.status !== "COLLECTING_RESPONSES") return;
          if (currentTrade.recipients !== "ANY" && !currentTrade.recipients.includes(botId)) return;
          const controller = botById[botId as keyof typeof botById] ?? greedyBot;
          const view = createBotView(current, botId, controller.profile);
          const response = evaluateTrade(view, currentTrade, controller.profile) === "ACCEPT" ? "WANTS_ACCEPT" : "REJECTED";
          applyLocalCommandRef.current({ type: "RESPOND_TRADE", playerId: botId, tradeId: currentTrade.id, response });
        }, 650 + index * 450);
        tradeResponseTimersRef.current.set(key, timer);
      });

      const deadlineKey = `deadline:${trade.id}:${trade.createdAtSeq}`;
      if (tradeResponseTimersRef.current.has(deadlineKey)) return;
      const timer = setTimeout(() => {
        tradeResponseTimersRef.current.delete(deadlineKey);
        const current = stateRef.current;
        const currentTrade = current.trades[trade.id];
        if (!currentTrade || currentTrade.status !== "COLLECTING_RESPONSES") return;
        if (!localBotIds.has(currentTrade.fromPlayerId)) {
          applyLocalCommandRef.current({ type: "EXPIRE_TRADE", playerId: currentTrade.fromPlayerId, tradeId: currentTrade.id, reason: "RESPONSE_TIMEOUT" });
          return;
        }
        const controller = botById[currentTrade.fromPlayerId as keyof typeof botById] ?? greedyBot;
        const candidates = current.playerOrder
          .filter((playerId) => playerId !== currentTrade.fromPlayerId)
          .filter((playerId) => currentTrade.recipients === "ANY" || currentTrade.recipients.includes(playerId))
          .filter((playerId) => currentTrade.responses?.[playerId]?.status === "WANTS_ACCEPT")
          .filter((playerId) =>
            hasResources(current.players[currentTrade.fromPlayerId]?.resources ?? emptyResources(), currentTrade.offered)
            && hasResources(current.players[playerId]?.resources ?? emptyResources(), currentTrade.requested),
          )
          .map((playerId) => ({ playerId, score: scoreTradeResponder(current, currentTrade, playerId, controller.profile, current.config.botDifficulty ?? "medium") }))
          .sort((left, right) => right.score - left.score || current.playerOrder.indexOf(left.playerId) - current.playerOrder.indexOf(right.playerId));
        const selected = candidates[0]?.playerId;
        applyLocalCommandRef.current(selected
          ? { type: "FINALIZE_TRADE", playerId: currentTrade.fromPlayerId, tradeId: currentTrade.id, toPlayerId: selected }
          : { type: "CANCEL_TRADE", playerId: currentTrade.fromPlayerId, tradeId: currentTrade.id });
      }, Math.max(0, (localTradeDeadlines[trade.id] ?? Date.now() + 15_000) - Date.now()));
      tradeResponseTimersRef.current.set(deadlineKey, timer);
    });
  }, [
    applyLocalCommandRef,
    clearAutomationTimers,
    enabled,
    events,
    humanPlayerId,
    localTradeDeadlines,
    setLocalTradeDeadlines,
    state.trades,
    stateRef,
  ]);

  return { clearAutomationTimers };
};
