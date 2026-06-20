import { useState } from "react";
import type { ReplayLogState } from "../replay-state.js";

export const useReplayControls = () => {
  const [replayLog, setReplayLog] = useState<ReplayLogState | null>(null);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);

  return {
    replayLog,
    setReplayLog,
    replayIndex,
    setReplayIndex,
    isReplaying: replayIndex !== null,
  };
};
