import { nanoid } from "nanoid";
import type { Session } from "./room-manager.js";

export interface WebSocketTicket {
  token: string;
  expiresAt: number;
}

interface StoredTicket extends WebSocketTicket {
  sessionToken: string;
  consumed: boolean;
}

export class WebSocketTicketStore {
  private readonly tickets = new Map<string, StoredTicket>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = () => `wst_${nanoid(24)}`,
  ) {}

  issue(session: Session): WebSocketTicket {
    const ticket: StoredTicket = {
      token: this.createToken(),
      sessionToken: session.token,
      expiresAt: this.now() + this.ttlMs,
      consumed: false,
    };
    this.tickets.set(ticket.token, ticket);
    return { token: ticket.token, expiresAt: ticket.expiresAt };
  }

  async consume(token: string | null, resolveSession: (sessionToken: string) => Promise<Session | undefined>): Promise<Session | undefined> {
    if (!token) return undefined;
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.consumed || ticket.expiresAt <= this.now()) {
      if (ticket) this.tickets.delete(token);
      return undefined;
    }
    ticket.consumed = true;
    this.tickets.delete(token);
    return resolveSession(ticket.sessionToken);
  }

  sweep(): void {
    const now = this.now();
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt <= now || ticket.consumed) this.tickets.delete(token);
    }
  }

  size(): number {
    return this.tickets.size;
  }
}
