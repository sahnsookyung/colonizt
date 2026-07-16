import { useCallback, useMemo, useState } from "react";
import { replayAtIndex, type ReplayLogState } from "../replay-state.js";

export const useReplayController = () => {
  const [log, setLog] = useState<ReplayLogState | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const isReplaying = log !== null && index !== null;
  const state = useMemo(
    () => (log && index !== null ? replayAtIndex(log, index) : null),
    [index, log],
  );
  const visibleEvents = useMemo(
    () => (log && index !== null ? log.events.slice(0, index) : []),
    [index, log],
  );

  const start = useCallback((nextLog: ReplayLogState) => {
    setLog(nextLog);
    setIndex(nextLog.events.length);
  }, []);

  const step = useCallback((delta: number) => {
    setIndex((current) => {
      if (!log || current === null) return current;
      return Math.max(0, Math.min(log.events.length, current + delta));
    });
  }, [log]);

  const exit = useCallback(() => {
    setLog(null);
    setIndex(null);
  }, []);

  const replaceIfActive = useCallback((nextLog: ReplayLogState) => {
    setLog((current) => current ? nextLog : current);
    setIndex((current) => current === null ? current : Math.min(current, nextLog.events.length));
  }, []);

  return { log, index, isReplaying, state, visibleEvents, start, step, exit, replaceIfActive };
};
