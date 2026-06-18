import { createClient } from "redis";
import type { Session } from "./room-manager.js";

type RedisClient = ReturnType<typeof createClient>;

export interface PresenceStore {
  kind: "memory" | "redis";
  connect(session: Session, socketId: string): Promise<void>;
  joinRoom(session: Session, socketId: string, roomId: string): Promise<void>;
  disconnect(session: Session, socketId: string, roomId?: string): Promise<void>;
  roomUserCount(roomId: string): Promise<number>;
  roomUserIds(roomId: string): Promise<Set<string>>;
  close(): Promise<void>;
}

export class MemoryPresenceStore implements PresenceStore {
  readonly kind = "memory";
  private readonly sockets = new Map<string, { userId: string; roomId?: string }>();

  async connect(session: Session, socketId: string): Promise<void> {
    this.sockets.set(socketId, { userId: session.userId });
  }

  async joinRoom(session: Session, socketId: string, roomId: string): Promise<void> {
    this.sockets.set(socketId, { userId: session.userId, roomId });
  }

  async disconnect(_session: Session, socketId: string, _roomId?: string): Promise<void> {
    this.sockets.delete(socketId);
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
    });
    await this.client.expire(this.socketKey(socketId), 90);
  }

  async joinRoom(session: Session, socketId: string, roomId: string): Promise<void> {
    await this.client.hSet(this.socketKey(socketId), { roomId });
    await this.client.sAdd(this.roomKey(roomId), socketId);
    await this.client.expire(this.roomKey(roomId), 3600);
  }

  async disconnect(_session: Session, socketId: string, roomId?: string): Promise<void> {
    await this.client.del(this.socketKey(socketId));
    if (roomId) await this.client.sRem(this.roomKey(roomId), socketId);
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
}

export const createPresenceStore = async (redisUrl?: string): Promise<PresenceStore> => {
  if (!redisUrl) return new MemoryPresenceStore();
  const client = createClient({ url: redisUrl });
  await client.connect();
  return new RedisPresenceStore(client);
};
