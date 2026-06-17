import { z } from "zod";

const resourceBundleSchema = z.object({
  timber: z.number().int().min(0),
  brick: z.number().int().min(0),
  grain: z.number().int().min(0),
  fiber: z.number().int().min(0),
  ore: z.number().int().min(0),
});

const resourceSchema = z.enum(["timber", "brick", "grain", "fiber", "ore"]);
const botDifficultySchema = z.enum(["easy", "medium", "hard"]);
const gameRulesSchema = z.object({
  diceDoubles: z.boolean().default(false),
  plight: z.boolean().default(false),
  plightTurn: z.number().int().positive().default(20),
  mapRandomized: z.boolean().default(false),
  specialCardCostRandomized: z.boolean().default(false),
  specialCardCost: resourceBundleSchema.optional(),
}).partial();

export const gameCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PLACE_SETUP"), playerId: z.string(), vertexId: z.string(), edgeId: z.string() }),
  z.object({ type: z.literal("ROLL_DICE"), playerId: z.string() }),
  z.object({ type: z.literal("BUILD_ROAD"), playerId: z.string(), edgeId: z.string() }),
  z.object({ type: z.literal("BUILD_SETTLEMENT"), playerId: z.string(), vertexId: z.string() }),
  z.object({ type: z.literal("UPGRADE_CITY"), playerId: z.string(), vertexId: z.string() }),
  z.object({ type: z.literal("BUY_SPECIAL_CARD"), playerId: z.string() }),
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

export const wsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("JOIN_ROOM"), roomId: z.string(), asSpectator: z.boolean().optional() }),
  z.object({ type: z.literal("READY"), roomId: z.string(), ready: z.boolean() }),
  z.object({ type: z.literal("COMMAND"), roomId: z.string(), clientSeq: z.number().int().nonnegative(), command: gameCommandSchema }),
  z.object({ type: z.literal("CHAT"), roomId: z.string(), message: z.string().min(1).max(300) }),
  z.object({ type: z.literal("RESYNC"), roomId: z.string(), lastSeq: z.number().int().nonnegative() }),
  z.object({ type: z.literal("PING"), nonce: z.string().optional() }),
]);

export const createRoomSchema = z.object({
  mode: z.enum(["CLASSIC", "DUEL", "RUSH"]).default("CLASSIC"),
  botFill: z.boolean().default(true),
  ranked: z.boolean().default(false),
  minPlayers: z.number().int().min(2).max(4).optional(),
  botDifficulty: botDifficultySchema.default("medium"),
  rules: gameRulesSchema.default({}),
});

export const analyticsEventSchema = z.object({
  userId: z.string().optional(),
  matchId: z.string().optional(),
  eventName: z.string().min(1).max(120),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
