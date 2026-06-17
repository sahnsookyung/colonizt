export const schemaVersion = 2;
export type SchemaVersion = 1 | 2;

export const resources = ["timber", "brick", "grain", "fiber", "ore"] as const;
export type Resource = (typeof resources)[number];
export type Terrain = Resource | "desert";
export type ResourceBundle = Record<Resource, number>;
export type BotDifficulty = "easy" | "medium" | "hard";

export interface GameRules {
  diceDoubles?: boolean | undefined;
  plight?: boolean | undefined;
  plightTurn?: number | undefined;
  mapRandomized?: boolean | undefined;
  specialCardCostRandomized?: boolean | undefined;
  specialCardCost?: ResourceBundle | undefined;
}

export type PlayerId = string;
export type HexId = string;
export type VertexId = string;
export type EdgeId = string;
export type TradeId = string;

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface HexTile {
  id: HexId;
  q: number;
  r: number;
  resource: Terrain;
  token?: number;
}

export interface VertexNode {
  id: VertexId;
  x: number;
  y: number;
  adjacentHexes: HexId[];
}

export interface EdgeNode {
  id: EdgeId;
  vertices: [VertexId, VertexId];
  adjacentHexes: HexId[];
}

export interface Port {
  id: string;
  edgeId: EdgeId;
  vertexIds: [VertexId, VertexId];
  ratio: 2 | 3;
  resource?: Resource;
}

export interface BoardGraph {
  hexes: Record<HexId, HexTile>;
  vertices: Record<VertexId, VertexNode>;
  edges: Record<EdgeId, EdgeNode>;
  ports: Record<string, Port>;
  adjacency: {
    hexToVertices: Record<HexId, VertexId[]>;
    vertexToEdges: Record<VertexId, EdgeId[]>;
    edgeToVertices: Record<EdgeId, [VertexId, VertexId]>;
  };
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: string;
  resources: ResourceBundle;
  specialCards: number;
  score: number;
  longestRoadLength: number;
  hasLongestRoad: boolean;
}

export interface GameConfig {
  matchId: string;
  seed: string;
  victoryPoints: number;
  maxPlayers: number;
  turnSeconds: number;
  playerOrder: PlayerId[];
  playerNames: Record<PlayerId, string>;
  playerColors: Record<PlayerId, string>;
  botDifficulty?: BotDifficulty | undefined;
  rules?: GameRules | undefined;
}

export type Phase =
  | { type: "SETUP_PLACEMENT"; activePlayerId: PlayerId; setupIndex: number }
  | { type: "WAITING_FOR_ROLL"; activePlayerId: PlayerId }
  | { type: "ACTION_PHASE"; activePlayerId: PlayerId }
  | { type: "GAME_OVER"; winnerId: PlayerId };

export interface TradeOffer {
  id: TradeId;
  fromPlayerId: PlayerId;
  offered: ResourceBundle;
  requested: ResourceBundle;
  recipients: PlayerId[] | "ANY";
  status: "OPEN" | "COLLECTING_RESPONSES" | "ACCEPTED" | "CANCELLED" | "REJECTED" | "EXPIRED" | "CLOSED";
  createdAtSeq: number;
  expiresAtSeq: number;
  responses?: Record<PlayerId, TradeResponse>;
  closedReason?: TradeClosedReason;
}

export type TradeResponseStatus = "PENDING" | "WANTS_ACCEPT" | "REJECTED";

export interface TradeResponse {
  playerId: PlayerId;
  status: TradeResponseStatus;
  respondedAtSeq?: number;
}

export type TradeClosedReason = "TTL" | "RESPONSE_TIMEOUT" | "ALL_REJECTED" | "TURN_ENDED" | "MIGRATED";

export interface GameState {
  schemaVersion: SchemaVersion;
  config: GameConfig;
  board: BoardGraph;
  players: Record<PlayerId, PlayerState>;
  playerOrder: PlayerId[];
  phase: Phase;
  turn: number;
  roads: Record<EdgeId, PlayerId>;
  settlements: Record<VertexId, PlayerId>;
  buildings: Record<VertexId, { owner: PlayerId; type: "settlement" | "city" }>;
  longestRoadOwner?: PlayerId;
  trades: Record<TradeId, TradeOffer>;
  eventSeq: number;
  rng: {
    seed: string;
    index: number;
    policy: "SEEDED_DETERMINISTIC";
  };
  plightApplied?: boolean;
  lastRoll?: {
    dice: [number, number];
    sum: number;
    doublesMultiplier?: number;
  };
}

export type GameCommand =
  | { type: "PLACE_SETUP"; playerId: PlayerId; vertexId: VertexId; edgeId: EdgeId }
  | { type: "ROLL_DICE"; playerId: PlayerId }
  | { type: "BUILD_ROAD"; playerId: PlayerId; edgeId: EdgeId }
  | { type: "BUILD_SETTLEMENT"; playerId: PlayerId; vertexId: VertexId }
  | { type: "UPGRADE_CITY"; playerId: PlayerId; vertexId: VertexId }
  | { type: "BUY_SPECIAL_CARD"; playerId: PlayerId }
  | { type: "MARITIME_TRADE"; playerId: PlayerId; offered: Resource; requested: Resource }
  | { type: "OFFER_TRADE"; playerId: PlayerId; tradeId: TradeId; offered: ResourceBundle; requested: ResourceBundle; recipients: PlayerId[] | "ANY"; ttlEvents?: number }
  | { type: "CANCEL_TRADE"; playerId: PlayerId; tradeId: TradeId }
  | { type: "RESPOND_TRADE"; playerId: PlayerId; tradeId: TradeId; response: Exclude<TradeResponseStatus, "PENDING"> }
  | { type: "FINALIZE_TRADE"; playerId: PlayerId; tradeId: TradeId; toPlayerId: PlayerId }
  | { type: "ACCEPT_TRADE"; playerId: PlayerId; tradeId: TradeId }
  | { type: "REJECT_TRADE"; playerId: PlayerId; tradeId: TradeId }
  | { type: "EXPIRE_TRADE"; playerId: PlayerId; tradeId: TradeId; reason?: "TTL" | "RESPONSE_TIMEOUT" }
  | { type: "END_TURN"; playerId: PlayerId };

export type GameEvent =
  | { schemaVersion: SchemaVersion; seq: number; type: "SETUP_PLACED"; playerId: PlayerId; vertexId: VertexId; edgeId: EdgeId; startingResources: Partial<ResourceBundle> }
  | { schemaVersion: SchemaVersion; seq: number; type: "DICE_ROLLED"; playerId: PlayerId; dice: [number, number]; sum: number; rngIndex: number; rngPolicy: "SEEDED_DETERMINISTIC"; doublesMultiplier?: number }
  | { schemaVersion: SchemaVersion; seq: number; type: "SEVEN_ROLLED"; playerId: PlayerId }
  | { schemaVersion: SchemaVersion; seq: number; type: "RESOURCES_PRODUCED"; gains: Record<PlayerId, Partial<ResourceBundle>>; multiplier?: number }
  | { schemaVersion: SchemaVersion; seq: number; type: "ROAD_BUILT"; playerId: PlayerId; edgeId: EdgeId; cost: ResourceBundle }
  | { schemaVersion: SchemaVersion; seq: number; type: "SETTLEMENT_BUILT"; playerId: PlayerId; vertexId: VertexId; cost: ResourceBundle }
  | { schemaVersion: SchemaVersion; seq: number; type: "CITY_UPGRADED"; playerId: PlayerId; vertexId: VertexId; cost: ResourceBundle }
  | { schemaVersion: SchemaVersion; seq: number; type: "SPECIAL_CARD_BOUGHT"; playerId: PlayerId; cost: ResourceBundle; cardIndex: number }
  | { schemaVersion: SchemaVersion; seq: number; type: "LONGEST_ROAD_UPDATED"; playerId?: PlayerId; length: number }
  | { schemaVersion: SchemaVersion; seq: number; type: "MARITIME_TRADED"; playerId: PlayerId; offered: Resource; requested: Resource; ratio: 2 | 3 | 4 }
  | { schemaVersion: SchemaVersion; seq: number; type: "TRADE_OFFERED"; trade: TradeOffer }
  | { schemaVersion: SchemaVersion; seq: number; type: "TRADE_CANCELLED"; tradeId: TradeId; playerId: PlayerId }
  | { schemaVersion: SchemaVersion; seq: number; type: "TRADE_RESPONSE_RECORDED"; tradeId: TradeId; fromPlayerId?: PlayerId; recipientIds?: PlayerId[]; playerId?: PlayerId; response?: Exclude<TradeResponseStatus, "PENDING"> }
  | { schemaVersion: SchemaVersion; seq: number; type: "TRADE_REJECTED"; tradeId: TradeId; playerId: PlayerId }
  | { schemaVersion: SchemaVersion; seq: number; type: "TRADE_ACCEPTED"; tradeId: TradeId; fromPlayerId: PlayerId; toPlayerId: PlayerId; offered: ResourceBundle; requested: ResourceBundle }
  | { schemaVersion: SchemaVersion; seq: number; type: "TRADE_EXPIRED"; tradeId: TradeId; playerId: PlayerId }
  | { schemaVersion: SchemaVersion; seq: number; type: "TRADE_CLOSED"; tradeId: TradeId; playerId?: PlayerId; reason: TradeClosedReason }
  | { schemaVersion: SchemaVersion; seq: number; type: "PLIGHT_STRUCK"; destroyed: Array<{ playerId: PlayerId; vertexId: VertexId; buildingType: "settlement" | "city" }> }
  | { schemaVersion: SchemaVersion; seq: number; type: "TURN_ENDED"; playerId: PlayerId; nextPlayerId: PlayerId }
  | { schemaVersion: SchemaVersion; seq: number; type: "GAME_OVER"; winnerId: PlayerId; reason: "VICTORY_POINTS" };

export interface ValidationError {
  code:
    | "UNKNOWN_PLAYER"
    | "NOT_ACTIVE_PLAYER"
    | "WRONG_PHASE"
    | "GAME_ALREADY_OVER"
    | "UNKNOWN_VERTEX"
    | "UNKNOWN_EDGE"
    | "EDGE_NOT_ADJACENT"
    | "POSITION_OCCUPIED"
    | "DISTANCE_RULE"
    | "ROAD_NOT_CONNECTED"
    | "INSUFFICIENT_RESOURCES"
    | "PIECE_LIMIT"
    | "UNKNOWN_TRADE"
    | "STALE_TRADE"
    | "TRADE_NOT_ALLOWED"
    | "INVALID_BOARD"
    | "INVARIANT_VIOLATION";
  message: string;
}

export type LegalAction =
  | { type: "PLACE_SETUP"; vertices: VertexId[] }
  | { type: "ROLL_DICE" }
  | { type: "BUILD_ROAD"; edges: EdgeId[] }
  | { type: "BUILD_SETTLEMENT"; vertices: VertexId[] }
  | { type: "UPGRADE_CITY"; vertices: VertexId[] }
  | { type: "BUY_SPECIAL_CARD"; cost: ResourceBundle }
  | { type: "MARITIME_TRADE"; trades: Array<{ offered: Resource; requested: Resource; ratio: 2 | 3 | 4 }> }
  | { type: "OFFER_TRADE" }
  | { type: "END_TURN" };
