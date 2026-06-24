import { z } from "zod";
import type { BoardGraph, BotDifficulty, GameConfig, GameEvent, PlayerId, ViewerState } from "@colonizt/game-core";

export const protocolVersion = 3;
export const websocketAuthMode = "ticket";
export const defaultWebSocketTicketTtlMs = 30_000;

const resourceBundleSchema = z.object({
  timber: z.number().int().min(0),
  brick: z.number().int().min(0),
  grain: z.number().int().min(0),
  fiber: z.number().int().min(0),
  ore: z.number().int().min(0),
});

const resourceSchema = z.enum(["timber", "brick", "grain", "fiber", "ore"]);
const botDifficultySchema = z.enum(["easy", "medium", "hard"]);
const mapPresetSchema = z.enum(["standard", "islands", "continent"]);
const onlinePlayerCountSchema = z.number().int().min(2).max(4);

export const gameRulesSchema = z.object({
  diceDoubles: z.boolean().default(false),
  plight: z.boolean().default(false),
  plightTurn: z.number().int().positive().default(20),
  mapRandomized: z.boolean().default(false),
  mapPreset: mapPresetSchema.optional(),
  specialCardCostRandomized: z.boolean().default(false),
  specialCardCost: resourceBundleSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  maxTurnAdjudication: z.literal("leader").optional(),
}).partial();

export const gameCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PLACE_SETUP"), playerId: z.string(), vertexId: z.string(), edgeId: z.string() }),
  z.object({ type: z.literal("ROLL_DICE"), playerId: z.string() }),
  z.object({ type: z.literal("DISCARD_RESOURCES"), playerId: z.string(), resources: resourceBundleSchema, forced: z.boolean().optional() }),
  z.object({ type: z.literal("MOVE_THIEF"), playerId: z.string(), hexId: z.string(), stealFromPlayerId: z.string().optional() }),
  z.object({ type: z.literal("BUILD_ROAD"), playerId: z.string(), edgeId: z.string() }),
  z.object({ type: z.literal("BUILD_SETTLEMENT"), playerId: z.string(), vertexId: z.string() }),
  z.object({ type: z.literal("UPGRADE_CITY"), playerId: z.string(), vertexId: z.string() }),
  z.object({ type: z.literal("BUY_SPECIAL_CARD"), playerId: z.string() }),
  z.object({ type: z.literal("PLAY_KNIGHT"), playerId: z.string(), cardId: z.string(), hexId: z.string(), stealFromPlayerId: z.string().optional() }),
  z.object({ type: z.literal("PLAY_ROAD_BUILDING"), playerId: z.string(), cardId: z.string(), edgeIds: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]) }),
  z.object({ type: z.literal("PLAY_MONOPOLY"), playerId: z.string(), cardId: z.string(), resource: resourceSchema }),
  z.object({ type: z.literal("PLAY_YEAR_OF_PLENTY"), playerId: z.string(), cardId: z.string(), resources: z.tuple([resourceSchema, resourceSchema]) }),
  z.object({ type: z.literal("MARITIME_TRADE"), playerId: z.string(), offered: resourceSchema, requested: resourceSchema }),
  z.object({
    type: z.literal("OFFER_TRADE"),
    playerId: z.string(),
    tradeId: z.string(),
    offered: resourceBundleSchema,
    requested: resourceBundleSchema,
    recipients: z.union([z.literal("ANY"), z.array(z.string())]),
    ttlEvents: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("CANCEL_TRADE"), playerId: z.string(), tradeId: z.string() }),
  z.object({ type: z.literal("RESPOND_TRADE"), playerId: z.string(), tradeId: z.string(), response: z.enum(["WANTS_ACCEPT", "REJECTED"]) }),
  z.object({ type: z.literal("FINALIZE_TRADE"), playerId: z.string(), tradeId: z.string(), toPlayerId: z.string() }),
  z.object({ type: z.literal("END_TURN"), playerId: z.string() }),
]);

export const lobbySettingsUpdateSchema = z.object({
  botFill: z.boolean().optional(),
  ranked: z.boolean().optional(),
  minPlayers: onlinePlayerCountSchema.optional(),
  maxPlayers: onlinePlayerCountSchema.optional(),
  botDifficulty: botDifficultySchema.optional(),
  rules: gameRulesSchema.optional(),
}).refine(
  (settings) => settings.minPlayers === undefined || settings.maxPlayers === undefined || settings.minPlayers <= settings.maxPlayers,
  { path: ["minPlayers"], message: "minPlayers cannot exceed maxPlayers" },
);

export const wsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("JOIN_ROOM"), roomId: z.string(), asSpectator: z.boolean().optional() }),
  z.object({ type: z.literal("LEAVE_ROOM"), roomId: z.string() }),
  z.object({ type: z.literal("READY"), roomId: z.string(), ready: z.boolean() }),
  z.object({ type: z.literal("START_ROOM"), roomId: z.string() }),
  z.object({ type: z.literal("ADD_BOT"), roomId: z.string() }),
  z.object({ type: z.literal("REMOVE_BOT"), roomId: z.string(), seatIndex: z.number().int().min(0).max(3) }),
  z.object({ type: z.literal("UPDATE_ROOM_SETTINGS"), roomId: z.string(), settings: lobbySettingsUpdateSchema }),
  z.object({ type: z.literal("UPDATE_DISPLAY_NAME"), displayName: z.string().trim().min(1).max(40) }),
  z.object({ type: z.literal("COMMAND"), roomId: z.string(), clientSeq: z.number().int().nonnegative(), command: gameCommandSchema }),
  z.object({ type: z.literal("CHAT"), roomId: z.string(), message: z.string().min(1).max(300) }),
  z.object({ type: z.literal("RESYNC"), roomId: z.string(), lastSeq: z.number().int().nonnegative() }),
  z.object({ type: z.literal("PING"), nonce: z.string().optional() }),
]);

export const createRoomSchema = z.object({
  mode: z.enum(["CLASSIC", "DUEL", "RUSH"]).default("CLASSIC"),
  botFill: z.boolean().default(true),
  ranked: z.boolean().default(false),
  minPlayers: onlinePlayerCountSchema.optional(),
  maxPlayers: onlinePlayerCountSchema.optional(),
  botDifficulty: botDifficultySchema.default("medium"),
  rules: gameRulesSchema.default({}),
}).refine(
  (settings) => settings.minPlayers === undefined || settings.maxPlayers === undefined || settings.minPlayers <= settings.maxPlayers,
  { path: ["minPlayers"], message: "minPlayers cannot exceed maxPlayers" },
);

export const analyticsEventSchema = z.object({
  userId: z.string().optional(),
  matchId: z.string().optional(),
  eventName: z.string().min(1).max(120),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export interface RuntimeNetworkConfig {
  schemaVersion: number;
  protocolVersion: typeof protocolVersion;
  apiBaseUrl: string;
  wsBaseUrl: string;
  webOrigin?: string;
  auth: {
    webSocket: typeof websocketAuthMode;
    ticketTtlMs: number;
  };
  nodeId?: string;
  instanceMode?: "single";
}

export interface MatchSummaryPayload {
  id: string;
  roomId: string;
  mode: string;
  ranked: boolean;
  startedAt: string;
  endedAt?: string;
  winnerUserId?: string;
  eventCount: number;
  playerIds: string[];
}

export interface ReplayLogPayload {
  config: GameConfig;
  board: BoardGraph;
  events: GameEvent[];
}

export interface CreateSessionResponse {
  token: string;
  userId: string;
  displayName: string;
}

export interface RoomSeatPayload {
  seatIndex: number;
  userId?: PlayerId;
  botId?: PlayerId;
  displayName?: string;
  ready: boolean;
  connected: boolean;
}

export interface LobbyReadiness {
  readyCount: number;
  occupiedCount: number;
  connectedOccupiedCount: number;
  canStart: boolean;
}

type LobbySeatLike = Pick<RoomSeatPayload, "userId" | "botId" | "ready" | "connected">;

export const isLobbySeatOccupied = (seat: Pick<LobbySeatLike, "userId" | "botId">): boolean =>
  Boolean(seat.userId || seat.botId);

export const isLobbySeatConnected = (seat: Pick<LobbySeatLike, "userId" | "botId" | "connected">): boolean =>
  Boolean(seat.botId || (seat.userId && seat.connected));

export const isLobbySeatReadyToStart = (seat: LobbySeatLike): boolean =>
  isLobbySeatOccupied(seat) && isLobbySeatConnected(seat) && seat.ready;

export const lobbyReadiness = (seats: readonly LobbySeatLike[], minPlayers: number): LobbyReadiness => {
  const occupiedSeats = seats.filter(isLobbySeatOccupied);
  const connectedOccupiedSeats = occupiedSeats.filter(isLobbySeatConnected);
  const startableSeats = connectedOccupiedSeats.filter((seat) => seat.ready);
  return {
    readyCount: startableSeats.length,
    occupiedCount: occupiedSeats.length,
    connectedOccupiedCount: connectedOccupiedSeats.length,
    canStart: startableSeats.length >= minPlayers && connectedOccupiedSeats.every((seat) => seat.ready),
  };
};

export interface WsTicketResponse {
  ticket: string;
  expiresAt: string;
  ttlMs: number;
}

export interface PublicRoomPayload {
  id: string;
  code?: string;
  inviteUrl?: string;
  hostUserId?: PlayerId;
  status: string;
  pauseReason?: "EMPTY_ROOM" | "STALLED_AUTOMATION";
  liveness?: "ACTIVE" | "IDLE_LOBBY" | "PAUSED_EMPTY" | "STALLED" | "FINISHED_UNLOADED" | "CLOSED";
  settings?: {
    mode?: "CLASSIC" | "DUEL" | "RUSH";
    botFill?: boolean;
    ranked?: boolean;
    minPlayers?: number;
    maxPlayers?: number;
    botDifficulty?: BotDifficulty;
    rules?: GameConfig["rules"];
  };
  seats?: RoomSeatPayload[];
  spectatorCount?: number;
  createdAt?: string;
  lastActivityAt?: string;
  pausedAt?: string;
  cleanupReason?: string;
  timer?: {
    activePlayerId: PlayerId;
    expiresAt: number;
  };
  events?: GameEvent[];
  game?: ViewerState;
}

export type GameRulesInput = z.input<typeof gameRulesSchema>;
export type CreateRoomInput = z.input<typeof createRoomSchema>;
export type CreateRoomSettings = z.output<typeof createRoomSchema>;
export type LobbySettingsUpdate = z.output<typeof lobbySettingsUpdateSchema>;
export type AnalyticsEventInput = z.input<typeof analyticsEventSchema>;
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
