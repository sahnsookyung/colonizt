import { createClient } from "redis";
import type { Session } from "./room-manager.js";

type RedisClient = ReturnType<typeof createClient>;
const redisSocketTtlSeconds = 180;

export interface StalePresence {
  socketId: string;
  userId?: string;
  roomId?: string;
}

export interface PresenceStore {
  kind: "memory" | "redis";
  connect(session: Session, socketId: string): Promise<void>;
  joinRoom(session: Session, socketId: string, roomId: string): Promise<void>;
  refresh(session: Session, socketId: string, roomId?: string): Promise<void>;
  disconnect(session: Session, socketId: string, roomId?: string): Promise<void>;
  sweepStale(maxAgeMs: number, now?: number): Promise<StalePresence[]>;
  roomUserCount(roomId: string): Promise<number>;
  roomUserIds(roomId: string): Promise<Set<string>>;
  close(): Promise<void>;
}

export class MemoryPresenceStore implements PresenceStore {
  readonly kind = "memory";
  private readonly sockets = new Map<string, { userId: string; roomId?: string; lastSeenAt: number }>();

  async connect(session: Session, socketId: string): Promise<void> {
    this.sockets.set(socketId, { userId: session.userId, lastSeenAt: Date.now() });
  }

  async joinRoom(session: Session, socketId: string, roomId: string): Promise<void> {
    this.sockets.set(socketId, { userId: session.userId, roomId, lastSeenAt: Date.now() });
  }

  async refresh(session: Session, socketId: string, roomId?: string): Promise<void> {
    const current = this.sockets.get(socketId);
    const nextRoomId = roomId ?? current?.roomId;
    this.sockets.set(socketId, nextRoomId ? { userId: session.userId, roomId: nextRoomId, lastSeenAt: Date.now() } : { userId: session.userId, lastSeenAt: Date.now() });
  }

  async disconnect(_session: Session, socketId: string, _roomId?: string): Promise<void> {
    this.sockets.delete(socketId);
  }

  async sweepStale(maxAgeMs: number, now = Date.now()): Promise<StalePresence[]> {
    const stale: StalePresence[] = [];
    for (const [socketId, socket] of this.sockets.entries()) {
      if (now - socket.lastSeenAt < maxAgeMs) continue;
      stale.push({ socketId, userId: socket.userId, ...(socket.roomId ? { roomId: socket.roomId } : {}) });
      this.sockets.delete(socketId);
    }
    return stale;
  }

  async roomUserCount(roomId: string): Promise<number> {
    return (await this.roomUserIds(roomId)).size;
  }

  async roomUserIds(roomId: string): Promise<Set<string>> {
    return new Set([...this.sockets.values()].filter((socket) => socket.roomId === roomId).map((socket) => socket.userId));
  }

  async close(): Promise<void> {
    this.sockets.clear();
  }
}

export class RedisPresenceStore implements PresenceStore {
  readonly kind = "redis";
  private readonly prefix = "colonizt:presence";

  constructor(private readonly client: RedisClient) {}

  async connect(session: Session, socketId: string): Promise<void> {
    await this.client.hSet(this.socketKey(socketId), {
      userId: session.userId,
      displayName: session.displayName,
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
    await this.client.expire(this.socketKey(socketId), redisSocketTtlSeconds);
  }

  async joinRoom(session: Session, socketId: string, roomId: string): Promise<void> {
    const previousRoomId = await this.client.hGet(this.socketKey(socketId), "roomId");
    if (previousRoomId && previousRoomId !== roomId) {
      await this.client.sRem(this.roomKey(previousRoomId), socketId);
      if ((await this.client.sCard(this.roomKey(previousRoomId))) === 0) {
        await this.client.sRem(this.roomsKey(), previousRoomId);
      }
    }
    await this.client.hSet(this.socketKey(socketId), { roomId });
    await this.refresh(session, socketId, roomId);
    await this.client.sAdd(this.roomKey(roomId), socketId);
    await this.client.sAdd(this.roomsKey(), roomId);
    await this.client.expire(this.roomKey(roomId), 3600);
  }

  async refresh(session: Session, socketId: string, roomId?: string): Promise<void> {
    await this.client.hSet(this.socketKey(socketId), {
      userId: session.userId,
      displayName: session.displayName,
      lastSeenAt: new Date().toISOString(),
      ...(roomId ? { roomId } : {}),
    });
    await this.client.expire(this.socketKey(socketId), redisSocketTtlSeconds);
    if (roomId) await this.client.expire(this.roomKey(roomId), 3600);
  }

  async disconnect(_session: Session, socketId: string, roomId?: string): Promise<void> {
    await this.client.del(this.socketKey(socketId));
    if (roomId) await this.client.sRem(this.roomKey(roomId), socketId);
  }

  async sweepStale(maxAgeMs: number, now = Date.now()): Promise<StalePresence[]> {
    const stale: StalePresence[] = [];
    const roomIds = await this.client.sMembers(this.roomsKey());
    for (const roomId of roomIds) {
      const socketIds = await this.client.sMembers(this.roomKey(roomId));
      for (const socketId of socketIds) {
        const key = this.socketKey(socketId);
        const [userId, lastSeenAt] = await Promise.all([
          this.client.hGet(key, "userId"),
          this.client.hGet(key, "lastSeenAt"),
        ]);
        const staleSocket = !userId || !lastSeenAt || now - Date.parse(lastSeenAt) >= maxAgeMs;
        if (!staleSocket) continue;
        stale.push({ socketId, ...(userId ? { userId } : {}), roomId });
        await this.client.del(key);
        await this.client.sRem(this.roomKey(roomId), socketId);
      }
      if ((await this.client.sCard(this.roomKey(roomId))) === 0) {
        await this.client.sRem(this.roomsKey(), roomId);
      }
    }
    return stale;
  }

  async roomUserCount(roomId: string): Promise<number> {
    return (await this.roomUserIds(roomId)).size;
  }

  async roomUserIds(roomId: string): Promise<Set<string>> {
    const socketIds = await this.client.sMembers(this.roomKey(roomId));
    const users = new Set<string>();
    for (const socketId of socketIds) {
      const userId = await this.client.hGet(this.socketKey(socketId), "userId");
      if (userId) users.add(userId);
      else await this.client.sRem(this.roomKey(roomId), socketId);
    }
    return users;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }

  private socketKey(socketId: string): string {
    return `${this.prefix}:socket:${socketId}`;
  }

  private roomKey(roomId: string): string {
    return `${this.prefix}:room:${roomId}:users`;
  }

  private roomsKey(): string {
    return `${this.prefix}:rooms`;
  }
}

interface PresenceStoreFactoryOptions {
  createRedisClient?: (url: string) => RedisClient;
  onFallback?(error: unknown): void;
}

export const createPresenceStore = async (redisUrl?: string, options: PresenceStoreFactoryOptions = {}): Promise<PresenceStore> => {
  if (!redisUrl) return new MemoryPresenceStore();
  const client = options.createRedisClient?.(redisUrl) ?? createClient({ url: redisUrl });
  try {
    await client.connect();
    return new RedisPresenceStore(client);
  } catch (error) {
    try {
      client.destroy();
    } catch {
      // The client may already be closed after a failed connect.
    }
    options.onFallback?.(error);
    return new MemoryPresenceStore();
  }
};
