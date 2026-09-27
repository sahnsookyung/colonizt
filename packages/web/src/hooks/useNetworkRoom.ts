import { useEffect, useState, useSyncExternalStore } from "react";
import type { PlayerId } from "@colonizt/game-core";
import { SessionController } from "../session-controller.js";

export interface NetworkRoomInfo {
  id: string;
  code?: string;
  inviteUrl?: string;
  timer?: { activePlayerId: PlayerId; expiresAt: number };
}

export const useNetworkRoom = () => {
  const [controller] = useState(() => new SessionController());
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [networkStatus, setNetworkStatus] = useState("Local game");
  const [networkSession, setNetworkSession] = useState<{ token: string; userId: PlayerId } | null>(null);
  const [networkRoomId, setNetworkRoomId] = useState<string | null>(null);
  const [networkRoomInfo, setNetworkRoomInfo] = useState<NetworkRoomInfo | null>(null);
  useEffect(() => setNetworkStatus(status.message), [status.message]);
  useEffect(() => () => controller.stop(false), [controller]);
  return { controller, connectionState: status.state, serverClockOffsetMs: status.clockOffsetMs,
    networkStatus, setNetworkStatus, networkSession, setNetworkSession, networkRoomId, setNetworkRoomId,
    networkRoomInfo, setNetworkRoomInfo, reconnectRetryAt: status.retryAt, pendingCommandCount: status.pending,
    socketRef: controller.socketRef, shouldReconnectRef: controller.shouldReconnectRef,
    clientSeqRef: controller.clientSeqRef, lastServerSeqRef: controller.lastServerSeqRef,
  };
};
