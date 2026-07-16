import type { SocketClient } from "./websocket-transport.js";

export interface SocketBroadcastFailure {
  client: SocketClient;
  error: unknown;
}

export class SocketRegistry {
  private readonly clients = new Set<SocketClient>();
  private readonly byRoom = new Map<string, Set<SocketClient>>();
  private readonly bySocket = new Map<string, SocketClient>();

  track(socketId: string, client: SocketClient): void {
    this.clients.add(client);
    this.bySocket.set(socketId, client);
  }

  untrack(socketId: string, client: SocketClient): { tracked: boolean; roomId?: string } {
    const tracked = this.clients.delete(client);
    this.bySocket.delete(socketId);
    const roomId = client.roomId;
    this.detach(client, roomId);
    return { tracked, ...(roomId ? { roomId } : {}) };
  }

  find(socketId: string): SocketClient | undefined {
    return this.bySocket.get(socketId);
  }

  attach(client: SocketClient, roomId: string): void {
    if (client.roomId && client.roomId !== roomId) this.detach(client, client.roomId);
    client.roomId = roomId;
    const roomClients = this.byRoom.get(roomId) ?? new Set<SocketClient>();
    roomClients.add(client);
    this.byRoom.set(roomId, roomClients);
  }

  detach(client: SocketClient, roomId = client.roomId): void {
    if (!roomId) return;
    const roomClients = this.byRoom.get(roomId);
    roomClients?.delete(client);
    if (roomClients?.size === 0) this.byRoom.delete(roomId);
    if (client.roomId === roomId) delete client.roomId;
  }

  roomClients(roomId: string): SocketClient[] {
    return [...(this.byRoom.get(roomId) ?? [])];
  }

  roomUserIds(roomId: string): Set<string> {
    return new Set(this.roomClients(roomId).map((client) => client.session.userId));
  }

  broadcast(roomId: string, payloadFor: (client: SocketClient) => unknown): SocketBroadcastFailure[] {
    const failures: SocketBroadcastFailure[] = [];
    for (const client of this.byRoom.get(roomId) ?? []) {
      try {
        client.socket.send(JSON.stringify(payloadFor(client)));
      } catch (error) {
        failures.push({ client, error });
      }
    }
    return failures;
  }

  sweepEmptyRooms(): void {
    for (const [roomId, clients] of this.byRoom) if (clients.size === 0) this.byRoom.delete(roomId);
  }

  size(): number {
    return this.clients.size;
  }
}
