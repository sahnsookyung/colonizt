import type {
  GameCommand,
  GameEvent,
  PlayerId,
  ViewerState,
} from "@colonizt/game-core";
import type {
  CommandAck,
  PendingGameCommand,
  PublicRoomPayload,
} from "@colonizt/protocol";
import { track, platform } from "./analytics.js";
import {
  createNetworkClient,
  type NetworkClient,
  type NetworkTimer,
} from "./network.js";
import {
  isTerminalOnlineError,
  networkErrorMessage,
} from "./network-errors.js";
import { writeResumeState } from "./resume.js";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "joining"
  | "synchronizing"
  | "connected"
  | "offline"
  | "retrying"
  | "expired";
export interface SessionStatus {
  state: ConnectionState;
  message: string;
  retryAt: number | null;
  pending: number;
  clockOffsetMs: number;
}
interface Callbacks {
  onEvents(
    events: GameEvent[],
    snapshot?: ViewerState,
    timer?: NetworkTimer,
  ): void;
  onRoom(room: PublicRoomPayload): void;
  onError(error: unknown): void;
  onConfirmed(command: GameCommand): void;
}
interface Session {
  token: string;
  userId: PlayerId;
}

/** Snapshots supersede their event prefix. Only a contiguous unseen tail is reduced. */
export const reconcileServerUpdate = (
  lastSeq: number,
  events: GameEvent[],
  snapshot?: ViewerState,
) => {
  const usableSnapshot =
    snapshot && snapshot.eventSeq >= lastSeq ? snapshot : undefined;
  const base = usableSnapshot?.eventSeq ?? lastSeq;
  const tail = [
    ...new Map(
      events
        .filter((event) => event.seq > base)
        .map((event) => [event.seq, event]),
    ).values(),
  ].sort((a, b) => a.seq - b.seq);
  let cursor = base;
  for (const event of tail) {
    if (event.seq !== cursor + 1)
      return {
        gap: true,
        lastSeq,
        events: [] as GameEvent[],
        snapshot: undefined,
      };
    cursor = event.seq;
  }
  return {
    gap: false,
    lastSeq: cursor,
    events: tail,
    snapshot: usableSnapshot,
  };
};

/** Owns transport lifetimes and durable command identity; UI callbacks only project state. */
export class SessionController {
  readonly socketRef = { current: null as WebSocket | null };
  readonly clientSeqRef = { current: 1 };
  readonly lastServerSeqRef = { current: 0 };
  readonly shouldReconnectRef = { current: true };
  pendingCommand: PendingGameCommand | undefined;
  private status: SessionStatus = {
    state: "idle",
    message: "Local game",
    retryAt: null,
    pending: 0,
    clockOffsetMs: 0,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private attempts = 0;
  private abort: AbortController | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private joinTimer: ReturnType<typeof setTimeout> | undefined;
  private commandTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private config:
    | {
        session: Session;
        roomId: string;
        ready: boolean;
        callbacks: Callbacks;
        code?: string;
      }
    | undefined;
  private ack: CommandAck | undefined;
  private sentAt = 0;
  private transmitted: { epoch: number; clientSeq: number } | undefined;
  private resyncPending = false;
  private listening = false;
  constructor(private client: NetworkClient = createNetworkClient()) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.status;
  private update(
    state: ConnectionState,
    message: string,
    retryAt: number | null = null,
  ) {
    this.status = {
      ...this.status,
      state,
      message,
      retryAt,
      pending: this.pendingCommand ? 1 : 0,
    };
    for (const listener of this.listeners) listener();
  }
  private persist() {
    const config = this.config;
    if (!config) return;
    writeResumeState({
      ...config.session,
      roomId: config.roomId,
      ...(config.code ? { roomCode: config.code } : {}),
      clientSeq: this.clientSeqRef.current,
      lastSeq: this.lastServerSeqRef.current,
      ...(this.pendingCommand ? { pendingCommand: this.pendingCommand } : {}),
    });
  }
  start(
    session: Session,
    roomId: string,
    ready: boolean,
    callbacks: Callbacks,
  ) {
    this.config = { session, roomId, ready, callbacks };
    this.shouldReconnectRef.current = true;
    this.attempts = 0;
    this.listen();
    this.attempt();
  }
  private listen() {
    if (this.listening || typeof window === "undefined") return;
    this.listening = true;
    window.addEventListener("online", this.wake);
    window.addEventListener("offline", this.offline);
    window.addEventListener("pageshow", this.wake);
    window.addEventListener("pagehide", this.suspend);
    document.addEventListener("visibilitychange", this.visibility);
    document.addEventListener("freeze", this.suspend);
    document.addEventListener("resume", this.wake);
  }
  private visibility = () => {
    if (document.visibilityState === "visible") this.wake();
    else this.persist();
  };
  private wake = () => {
    if (this.config && this.status.state !== "expired") this.retry();
  };
  private offline = () => {
    this.disconnect();
    this.update("offline", "Offline · your seat is saved");
  };
  private suspend = () => {
    this.persist();
    this.disconnect();
    this.update("offline", "Your seat is saved");
  };
  retry = () => {
    this.shouldReconnectRef.current = true;
    this.attempts = 0;
    this.attempt();
  };
  resetAttempts = () => {
    this.attempts = 0;
  };
  private disconnect() {
    this.epoch += 1;
    clearTimeout(this.retryTimer);
    clearTimeout(this.joinTimer);
    clearTimeout(this.commandTimer);
    clearTimeout(this.syncTimer);
    this.resyncPending = false;
    this.abort?.abort();
    this.abort = undefined;
    this.socketRef.current?.close();
    this.socketRef.current = null;
  }
  stop(clearPending = true) {
    this.shouldReconnectRef.current = false;
    this.disconnect();
    if (this.listening) {
      window.removeEventListener("online", this.wake);
      window.removeEventListener("offline", this.offline);
      window.removeEventListener("pageshow", this.wake);
      window.removeEventListener("pagehide", this.suspend);
      document.removeEventListener("visibilitychange", this.visibility);
      document.removeEventListener("freeze", this.suspend);
      document.removeEventListener("resume", this.wake);
      this.listening = false;
    }
    if (clearPending) {
      this.pendingCommand = undefined;
      this.ack = undefined;
    }
    this.update("idle", "Local game");
  }
  private schedule() {
    this.disconnect();
    if (!this.shouldReconnectRef.current) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.update("offline", "Offline · your seat is saved");
      return;
    }
    if (++this.attempts > 8) {
      this.update("retrying", "Connection paused · tap Retry");
      return;
    }
    const delay =
      Math.min(15_000, 750 * 2 ** (this.attempts - 1)) +
      Math.floor(Math.random() * 250);
    this.update("retrying", "Reconnecting to your table…", Date.now() + delay);
    this.retryTimer = setTimeout(() => this.attempt(), delay);
    track("network_reconnect", {
      mode: "network",
      attempt: this.attempts,
      platform: platform(),
    });
  }
  private attempt() {
    if (!this.config || !this.shouldReconnectRef.current) return;
    this.disconnect();
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.update("offline", "Offline · your seat is saved");
      return;
    }
    const epoch = this.epoch;
    const current = () => epoch === this.epoch;
    const config = this.config;
    this.abort = new AbortController();
    this.update("connecting", "Connecting to your table…");
    void this.client
      .connect(
        config.session.token,
        {
          onOpen: (socket) => {
            if (!current()) {
              socket.close();
              return;
            }
            this.socketRef.current = socket;
            this.update("joining", "Restoring your seat…");
            this.joinTimer = setTimeout(() => this.schedule(), 10_000);
            socket.send(
              JSON.stringify({ type: "JOIN_ROOM", roomId: config.roomId }),
            );
            if (config.ready)
              socket.send(
                JSON.stringify({
                  type: "READY",
                  roomId: config.roomId,
                  ready: true,
                }),
              );
          },
          onRoom: (input) => {
            if (!current()) return;
            const room = input as PublicRoomPayload;
            if (!room || typeof room.id !== "string") {
              this.schedule();
              return;
            }
            if (
              room.game &&
              room.game.eventSeq < this.lastServerSeqRef.current
            ) {
              this.resync();
              return;
            }
            clearTimeout(this.joinTimer);
            clearTimeout(this.syncTimer);
            this.resyncPending = false;
            config.roomId = room.id;
            if (room.code) config.code = room.code;
            if (room.game) this.lastServerSeqRef.current = room.game.eventSeq;
            config.callbacks.onRoom(room);
            this.connected();
            if (!this.finishAck() && this.ack) this.resync();
            if (this.pendingCommand && !this.ack) this.transmitPending();
          },
          onEvents: (events, snapshot, timer) => {
            if (!current()) return;
            const update = reconcileServerUpdate(
              this.lastServerSeqRef.current,
              events,
              snapshot,
            );
            if (update.gap) {
              this.resync();
              return;
            }
            const previousSeq = this.lastServerSeqRef.current;
            this.lastServerSeqRef.current = update.lastSeq;
            // Timer metadata belongs to the same state update; stale packets
            // must not replace the current player's deadline.
            const acceptsTimer = snapshot
              ? Boolean(update.snapshot)
              : update.events.length > 0;
            // An accepted snapshot is already at its event sequence. Never reduce its prefix.
            config.callbacks.onEvents(
              update.snapshot
                ? [
                    ...new Map(
                      events
                        .filter((event) => event.seq > previousSeq)
                        .map((event) => [event.seq, event]),
                    ).values(),
                  ]
                : update.events,
              update.snapshot,
              acceptsTimer ? timer : undefined,
            );
            if (snapshot && update.snapshot) {
              clearTimeout(this.syncTimer);
              this.resyncPending = false;
              this.connected();
            }
            this.persist();
            this.finishAck();
          },
          onAck: (ack) => {
            if (
              !current() ||
              ack.clientSeq !== this.pendingCommand?.clientSeq ||
              ack.roomId !== config.roomId
            )
              return;
            this.ack = ack;
            clearTimeout(this.commandTimer);
            if (!this.finishAck()) this.resync();
          },
          onClock: (clockOffsetMs) => {
            if (!current()) return;
            this.status = { ...this.status, clockOffsetMs };
            this.update(
              this.status.state,
              this.status.message,
              this.status.retryAt,
            );
          },
          onError: (error) => {
            if (!current()) return;
            if (isTerminalOnlineError(error)) {
              this.stop();
              this.update("expired", networkErrorMessage(error));
            } else if (
              error &&
              typeof error === "object" &&
              "type" in error &&
              error.type === "COMMAND_REJECTED" &&
              "clientSeq" in error &&
              error.clientSeq === this.pendingCommand?.clientSeq
            ) {
              this.pendingCommand = undefined;
              this.ack = undefined;
              clearTimeout(this.commandTimer);
              this.persist();
              this.resync();
            }
            config.callbacks.onError(error);
          },
          onClose: () => {
            if (current()) this.schedule();
          },
        },
        this.abort.signal,
      )
      .then((socket) => {
        if (!current()) socket.close();
      })
      .catch((error: unknown) => {
        if (!current()) return;
        if (isTerminalOnlineError(error)) {
          this.stop();
          this.update("expired", networkErrorMessage(error));
          config.callbacks.onError(error);
        } else {
          config.callbacks.onError(error);
          this.schedule();
        }
      });
  }
  private connected() {
    this.attempts = 0;
    this.update(
      "connected",
      `Online ${this.config?.code ?? this.config?.roomId ?? ""}`,
    );
    this.persist();
  }
  private resync() {
    if (
      this.resyncPending ||
      !this.config ||
      this.socketRef.current?.readyState !== WebSocket.OPEN
    )
      return;
    this.resyncPending = true;
    this.update("synchronizing", "Catching up with your table…");
    this.socketRef.current.send(
      JSON.stringify({
        type: "RESYNC",
        roomId: this.config.roomId,
        lastSeq: this.lastServerSeqRef.current,
      }),
    );
    this.syncTimer = setTimeout(() => this.schedule(), 10_000);
    track("network_resync", { mode: "network", platform: platform() });
  }
  send(command: GameCommand): boolean {
    if (
      this.status.state !== "connected" ||
      this.pendingCommand ||
      !this.config
    )
      return false;
    this.pendingCommand = {
      clientSeq: this.clientSeqRef.current++,
      expectedEventSeq: this.lastServerSeqRef.current,
      command: structuredClone(command),
    };
    this.ack = undefined;
    this.persist();
    this.update("connected", this.status.message);
    this.transmitPending();
    return true;
  }
  private transmitPending() {
    const pending = this.pendingCommand;
    if (
      !pending ||
      !this.config ||
      this.socketRef.current?.readyState !== WebSocket.OPEN
    )
      return;
    if (
      this.transmitted?.epoch === this.epoch &&
      this.transmitted.clientSeq === pending.clientSeq
    )
      return;
    this.transmitted = { epoch: this.epoch, clientSeq: pending.clientSeq };
    this.sentAt = performance.now();
    clearTimeout(this.commandTimer);
    try {
      this.client.sendCommand(
        this.socketRef.current,
        this.config.roomId,
        pending.clientSeq,
        pending.command,
        pending.expectedEventSeq,
      );
      this.commandTimer = setTimeout(() => this.schedule(), 10_000);
    } catch {
      this.schedule();
    }
  }
  private finishAck(): boolean {
    if (
      !this.ack ||
      !this.pendingCommand ||
      (this.ack.seqEnd !== undefined &&
        this.lastServerSeqRef.current < this.ack.seqEnd)
    )
      return false;
    const command = this.pendingCommand.command;
    this.pendingCommand = undefined;
    this.ack = undefined;
    clearTimeout(this.commandTimer);
    this.persist();
    this.update(this.status.state, this.status.message, this.status.retryAt);
    this.config?.callbacks.onConfirmed(command);
    track("network_command_ack", {
      mode: "network",
      command: command.type,
      latencyMs: Math.max(0, performance.now() - this.sentAt),
      platform: platform(),
    });
    return true;
  }
}
