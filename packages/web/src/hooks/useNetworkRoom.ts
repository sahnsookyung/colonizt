import { useCallback, useRef, useState } from "react";
import type { PlayerId } from "@colonizt/game-core";

export interface NetworkRoomInfo {
  id: string;
  code?: string;
  inviteUrl?: string;
}

const maxReconnectAttempts = 8;
const reconnectJitterMs = 250;

const randomJitter = (exclusiveMax: number): number => {
  if (exclusiveMax <= 1) return 0;
  const sample = new Uint32Array(1);
  const bucketSize = 0x1_0000_0000;
  const unbiasedLimit = bucketSize - (bucketSize % exclusiveMax);
  let value = bucketSize;
  while (value >= unbiasedLimit) {
    globalThis.crypto.getRandomValues(sample);
    value = sample[0] ?? bucketSize;
  }
  return value % exclusiveMax;
};

export const useNetworkRoom = () => {
  const [networkStatus, setNetworkStatus] = useState("Local game");
  const [networkSession, setNetworkSession] = useState<{ token: string; userId: PlayerId } | null>(null);
  const [networkRoomId, setNetworkRoomId] = useState<string | null>(null);
  const [networkRoomInfo, setNetworkRoomInfo] = useState<NetworkRoomInfo | null>(null);
  const [reconnectRetryAt, setReconnectRetryAt] = useState<number | null>(null);
  const [pendingCommandCount, setPendingCommandCount] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(true);
  const clientSeqRef = useRef(1);
  const lastServerSeqRef = useRef(0);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    setReconnectRetryAt(null);
  }, []);

  const resetReconnectState = useCallback(() => {
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
  }, [clearReconnectTimer]);

  const scheduleReconnect = useCallback((connect: () => void): boolean => {
    if (!shouldReconnectRef.current) return false;
    clearReconnectTimer();
    reconnectAttemptRef.current += 1;
    if (reconnectAttemptRef.current > maxReconnectAttempts) {
      shouldReconnectRef.current = false;
      setNetworkStatus("Reconnect paused");
      return false;
    }
    const delay = Math.min(15_000, 750 * 2 ** Math.min(reconnectAttemptRef.current - 1, 5)) + randomJitter(reconnectJitterMs);
    const retryAt = Date.now() + delay;
    setReconnectRetryAt(retryAt);
    setNetworkStatus(`Reconnecting in ${Math.ceil(delay / 1000)}s`);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      setReconnectRetryAt(null);
      setNetworkStatus("Reconnecting...");
      connect();
    }, delay);
    return true;
  }, [clearReconnectTimer]);

  const retryReconnectNow = useCallback((connect: () => void) => {
    clearReconnectTimer();
    setNetworkStatus("Reconnecting...");
    connect();
  }, [clearReconnectTimer]);

  const markCommandPending = useCallback(() => {
    setPendingCommandCount((count) => Math.min(99, count + 1));
  }, []);

  const clearPendingCommands = useCallback(() => {
    setPendingCommandCount(0);
  }, []);

  return {
    networkStatus,
    setNetworkStatus,
    networkSession,
    setNetworkSession,
    networkRoomId,
    setNetworkRoomId,
    networkRoomInfo,
    setNetworkRoomInfo,
    reconnectRetryAt,
    pendingCommandCount,
    socketRef,
    reconnectTimerRef,
    reconnectAttemptRef,
    shouldReconnectRef,
    clientSeqRef,
    lastServerSeqRef,
    clearReconnectTimer,
    resetReconnectState,
    scheduleReconnect,
    retryReconnectNow,
    markCommandPending,
    clearPendingCommands,
  };
};
