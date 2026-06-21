export const schemaVersion = 3;
export type SchemaVersion = 1 | 2 | 3;

export const resources = ["timber", "brick", "grain", "fiber", "ore"] as const;
export type Resource = (typeof resources)[number];
export type Terrain = Resource | "desert";
export type ResourceBundle = Record<Resource, number>;
export type BotDifficulty = "easy" | "medium" | "hard";
export type MapPreset = "standard" | "islands" | "continent";

export interface GameRules {
  diceDoubles?: boolean | undefined;
  plight?: boolean | undefined;
  plightTurn?: number | undefined;
  mapRandomized?: boolean | undefined;
  mapPreset?: MapPreset | undefined;
  specialCardCostRandomized?: boolean | undefined;
  specialCardCost?: ResourceBundle | undefined;
  maxTurns?: number | undefined;
  maxTurnAdjudication?: "leader" | undefined;
}

export type PlayerId = string;
export type HexId = string;
export type VertexId = string;
export type EdgeId = string;
export type TradeId = string;
export type DevelopmentCardId = string;
export type RoadBuildingSequence = [EdgeId] | [EdgeId, EdgeId];

export interface RoadBuildingPlan {
  requiredRoadCount: 0 | 1 | 2;
  firstEdges: EdgeId[];
  options: RoadBuildingSequence[];
}

export type DevelopmentCardType = "KNIGHT" | "ROAD_BUILDING" | "MONOPOLY" | "YEAR_OF_PLENTY" | "VICTORY_POINT";

export interface DevelopmentCard {
  id: DevelopmentCardId;
  type: DevelopmentCardType;
  ownerId: PlayerId;
  boughtTurn: number;
  playedTurn?: number;
  revealed?: boolean;
}

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
  /**
   * Public/card-count compatibility field. In schema v3 this mirrors the count
   * of unplayed owned development cards; in v1/v2 imports it may be legacy-only.
   */
  specialCards: number;
  developmentCards: DevelopmentCard[];
  score: number;
  longestRoadLength: number;
  hasLongestRoad: boolean;
  playedKnights: number;
  hasLargestArmy: boolean;
  playedDevelopmentCardTurn?: number;
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

export type ViewerPublicConfig = Pick<
  GameConfig,
  "victoryPoints" | "maxPlayers" | "turnSeconds" | "playerOrder" | "playerNames" | "playerColors" | "botDifficulty" | "rules"
>;

export type Phase =
  | { type: "SETUP_PLACEMENT"; activePlayerId: PlayerId; setupIndex: number }
  | { type: "WAITING_FOR_ROLL"; activePlayerId: PlayerId }
  | { type: "ACTION_PHASE"; activePlayerId: PlayerId }
  | { type: "DISCARDING"; activePlayerId: PlayerId; rollerId: PlayerId; pending: Record<PlayerId, number>; submitted: Record<PlayerId, Partial<ResourceBundle>> }
  | { type: "MOVING_THIEF"; activePlayerId: PlayerId; rollerId: PlayerId; reason: "ROLL_7" | "KNIGHT"; cardId?: DevelopmentCardId; returnPhase?: "WAITING_FOR_ROLL" | "ACTION_PHASE" }
  | { type: "GAME_OVER"; winnerId: PlayerId; reason?: "VICTORY_POINTS" | "TURN_LIMIT" };

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
  largestArmyOwner?: PlayerId;
  playedKnightCounts: Record<PlayerId, number>;
  trades: Record<TradeId, TradeOffer>;
  developmentDeck: DevelopmentCardType[];
  developmentDeckCursor: number;
  thiefHexId?: HexId;
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
  | { type: "DISCARD_RESOURCES"; playerId: PlayerId; resources: ResourceBundle }
  | { type: "MOVE_THIEF"; playerId: PlayerId; hexId: HexId; stealFromPlayerId?: PlayerId }
  | { type: "BUILD_ROAD"; playerId: PlayerId; edgeId: EdgeId }
  | { type: "BUILD_SETTLEMENT"; playerId: PlayerId; vertexId: VertexId }
  | { type: "UPGRADE_CITY"; playerId: PlayerId; vertexId: VertexId }
  | { type: "BUY_SPECIAL_CARD"; playerId: PlayerId }
  | { type: "PLAY_KNIGHT"; playerId: PlayerId; cardId: DevelopmentCardId; hexId: HexId; stealFromPlayerId?: PlayerId }
  | { type: "PLAY_ROAD_BUILDING"; playerId: PlayerId; cardId: DevelopmentCardId; edgeIds: RoadBuildingSequence }
  | { type: "PLAY_MONOPOLY"; playerId: PlayerId; cardId: DevelopmentCardId; resource: Resource }
  | { type: "PLAY_YEAR_OF_PLENTY"; playerId: PlayerId; cardId: DevelopmentCardId; resources: [Resource, Resource] }
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
  | { schemaVersion: SchemaVersion; seq: number; type: "DISCARD_REQUIRED"; rollerId: PlayerId; pending: Record<PlayerId, number> }
  | { schemaVersion: SchemaVersion; seq: number; type: "RESOURCES_DISCARDED"; playerId: PlayerId; resources: ResourceBundle; forced?: boolean }
  | { schemaVersion: SchemaVersion; seq: number; type: "THIEF_MOVED"; playerId: PlayerId; fromHexId?: HexId; toHexId: HexId; reason: "ROLL_7" | "KNIGHT"; cardId?: DevelopmentCardId; stealFromPlayerId?: PlayerId; stolenResource?: Resource }
  | { schemaVersion: SchemaVersion; seq: number; type: "RESOURCES_PRODUCED"; gains: Record<PlayerId, Partial<ResourceBundle>>; multiplier?: number }
  | { schemaVersion: SchemaVersion; seq: number; type: "ROAD_BUILT"; playerId: PlayerId; edgeId: EdgeId; cost: ResourceBundle }
  | { schemaVersion: SchemaVersion; seq: number; type: "SETTLEMENT_BUILT"; playerId: PlayerId; vertexId: VertexId; cost: ResourceBundle }
  | { schemaVersion: SchemaVersion; seq: number; type: "CITY_UPGRADED"; playerId: PlayerId; vertexId: VertexId; cost: ResourceBundle }
  | { schemaVersion: SchemaVersion; seq: number; type: "SPECIAL_CARD_BOUGHT"; playerId: PlayerId; cost: ResourceBundle; cardIndex: number; cardId?: DevelopmentCardId; cardType?: DevelopmentCardType; deckIndex?: number }
  | { schemaVersion: SchemaVersion; seq: number; type: "DEVELOPMENT_CARD_PLAYED"; playerId: PlayerId; cardId: DevelopmentCardId; cardType: Exclude<DevelopmentCardType, "VICTORY_POINT"> }
  | { schemaVersion: SchemaVersion; seq: number; type: "ROAD_BUILDING_PLAYED"; playerId: PlayerId; cardId: DevelopmentCardId; edgeIds: EdgeId[] }
  | { schemaVersion: SchemaVersion; seq: number; type: "MONOPOLY_PLAYED"; playerId: PlayerId; cardId: DevelopmentCardId; resource: Resource; collected: Record<PlayerId, number> }
  | { schemaVersion: SchemaVersion; seq: number; type: "YEAR_OF_PLENTY_PLAYED"; playerId: PlayerId; cardId: DevelopmentCardId; resources: [Resource, Resource] }
  | { schemaVersion: SchemaVersion; seq: number; type: "LARGEST_ARMY_UPDATED"; playerId?: PlayerId; knightCount: number }
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
  | { schemaVersion: SchemaVersion; seq: number; type: "GAME_OVER"; winnerId: PlayerId; reason: "VICTORY_POINTS" | "TURN_LIMIT" };

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
    | "UNKNOWN_CARD"
    | "CARD_NOT_PLAYABLE"
    | "DECK_EMPTY"
    | "INVALID_DISCARD"
    | "INVALID_THIEF_MOVE"
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
  | { type: "DISCARD_RESOURCES"; count: number }
  | { type: "MOVE_THIEF"; hexes: HexId[] }
  | { type: "BUILD_ROAD"; edges: EdgeId[] }
  | { type: "BUILD_SETTLEMENT"; vertices: VertexId[] }
  | { type: "UPGRADE_CITY"; vertices: VertexId[] }
  | { type: "BUY_SPECIAL_CARD"; cost: ResourceBundle }
  | { type: "PLAY_KNIGHT"; cardIds: DevelopmentCardId[]; hexes: HexId[] }
  | { type: "PLAY_ROAD_BUILDING"; cardIds: DevelopmentCardId[]; edges: EdgeId[]; requiredRoadCount: 1 | 2; options: RoadBuildingSequence[] }
  | { type: "PLAY_MONOPOLY"; cardIds: DevelopmentCardId[]; resources: Resource[] }
  | { type: "PLAY_YEAR_OF_PLENTY"; cardIds: DevelopmentCardId[]; resources: Resource[] }
  | { type: "MARITIME_TRADE"; trades: Array<{ offered: Resource; requested: Resource; ratio: 2 | 3 | 4 }> }
  | { type: "OFFER_TRADE" }
  | { type: "END_TURN" };
