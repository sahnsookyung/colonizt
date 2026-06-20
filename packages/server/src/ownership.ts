import type pg from "pg";
import { acquireRoomLease, releaseRoomLease } from "@colonizt/db";

export interface RoomOwnershipStore {
  acquire(roomId: string, ownerId: string, ttlMs: number): Promise<boolean>;
  release(roomId: string, ownerId: string): Promise<boolean>;
  ownerOf(roomId: string): Promise<string | undefined>;
}

export class MemoryRoomOwnershipStore implements RoomOwnershipStore {
  private readonly leases = new Map<string, { ownerId: string; expiresAt: number }>();

  async acquire(roomId: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const existing = this.leases.get(roomId);
    if (existing && existing.ownerId !== ownerId && existing.expiresAt > Date.now()) return false;
    this.leases.set(roomId, { ownerId, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async release(roomId: string, ownerId: string): Promise<boolean> {
    const existing = this.leases.get(roomId);
    if (!existing || existing.ownerId !== ownerId) return false;
    this.leases.delete(roomId);
    return true;
  }

  async ownerOf(roomId: string): Promise<string | undefined> {
    const existing = this.leases.get(roomId);
    if (!existing) return undefined;
    if (existing.expiresAt <= Date.now()) {
      this.leases.delete(roomId);
      return undefined;
    }
    return existing.ownerId;
  }
}

export class PostgresRoomOwnershipStore implements RoomOwnershipStore {
  constructor(private readonly pool: pg.Pool) {}

  async acquire(roomId: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const lease = await acquireRoomLease(this.pool, roomId, ownerId, ttlMs);
    return lease?.ownerId === ownerId;
  }

  async release(roomId: string, ownerId: string): Promise<boolean> {
    return releaseRoomLease(this.pool, roomId, ownerId);
  }

  async ownerOf(roomId: string): Promise<string | undefined> {
    const result = await this.pool.query(
      "SELECT owner_id FROM room_leases WHERE room_id = $1 AND expires_at > now()",
      [roomId],
    );
    return result.rows[0]?.owner_id;
  }
}
