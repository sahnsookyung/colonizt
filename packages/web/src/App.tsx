import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyCommand,
  applyEvents,
  addResources,
  type BoardGraph,
  canBuildRoad,
  createFixedBoard,
  emptyResources,
  getLegalActions,
  hasResources,
  maritimeTradeRatio,
  replay,
  resourceCount,
  serializeForViewer,
  specialCardCost,
  resources,
  subtractResources,
  type EdgeId,
  type BotDifficulty,
  type GameConfig,
  type GameCommand,
  type GameEvent,
  type GameState,
  type PlayerId,
  type Resource,
  type ResourceBundle,
  type Terrain,
  type ViewerState,
  type VertexId,
} from "@colonizt/game-core";
import { createBotTradeId, createBotView, evaluateState, evaluateTrade, greedyBot, randomLegalBot } from "@colonizt/bots";
import { completeSetup, createDemoConfig, createDemoGame, playBotGame } from "@colonizt/demo-state";
import { platform, track } from "./analytics.js";
import { createNetworkClient, type MatchSummary } from "./network.js";
import { playSound, playSoundForEvent } from "./sounds.js";

const botById = {
  p2: randomLegalBot,
  p3: greedyBot,
  p4: randomLegalBot,
};

const botIds = new Set<PlayerId>(Object.keys(botById));
const maxTradeWantCount = 9;
const diceAnimationMs = 820;
const rollDeadlineMs = 60_000;
const actionDeadlineMs = 240_000;
const botActionDelays = {
  PLACE_SETUP: 450,
  ROLL_DICE: 900,
  BUILD_ROAD: 550,
  BUILD_SETTLEMENT: 550,
  UPGRADE_CITY: 550,
  OFFER_TRADE: 500,
  RESPOND_TRADE: 500,
  FINALIZE_TRADE: 500,
  END_TURN: 300,
  DEFAULT: 450,
} as const;

interface TradeDraft {
  offer: ResourceBundle;
  request: ResourceBundle;
}

interface MatchOptions {
  botDifficulty: BotDifficulty;
  rules: {
    diceDoubles: boolean;
    plight: boolean;
    plightTurn: number;
    mapRandomized: boolean;
    specialCardCostRandomized: boolean;
  };
}

const defaultMatchOptions: MatchOptions = {
  botDifficulty: "medium",
  rules: {
    diceDoubles: false,
    plight: false,
    plightTurn: 20,
    mapRandomized: true,
    specialCardCostRandomized: false,
  },
};

const normalizeTradeDraft = (
  draft: TradeDraft,
  playerResources: ResourceBundle,
  bankRatioByResource: Partial<Record<Resource, number>> = {},
): TradeDraft => {
  const offer = emptyResources();
  const request = emptyResources();
  for (const resource of resources) {
    offer[resource] = Math.max(0, Math.min(playerResources[resource], Math.floor(draft.offer[resource] ?? 0)));
    request[resource] = Math.max(0, Math.min(maxTradeWantCount, Math.floor(draft.request[resource] ?? 0)));
    if (offer[resource] > 0 && request[resource] > 0) request[resource] = 0;
    const ratio = bankRatioByResource[resource];
    if (ratio && offer[resource] > 0 && offer[resource] < ratio) offer[resource] = Math.min(offer[resource], playerResources[resource]);
  }
  return { offer, request };
};

const boardBounds = (state: GameState) => {
  const vertices = Object.values(state.board.vertices);
  const xs = vertices.map((vertex) => vertex.x);
  const ys = vertices.map((vertex) => vertex.y);
  const minX = Math.min(...xs) - 1.1;
  const maxX = Math.max(...xs) + 1.1;
  const minY = Math.min(...ys) - 1.1;
  const maxY = Math.max(...ys) + 3.0;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
};

const resourceLabels: Record<Resource, string> = {
  timber: "Timber",
  brick: "Brick",
  grain: "Grain",
  fiber: "Fiber",
  ore: "Ore",
};

const terrainLabels: Record<Terrain, string> = {
  ...resourceLabels,
  desert: "Desert",
};

const dicePips: Record<number, number[]> = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
};

const formatTimer = (seconds: number): string => {
  const clamped = Math.max(0, seconds);
  const minutes = Math.floor(clamped / 60);
  const remainder = clamped % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
};

const ResourceSvg = ({ resource }: { resource: Resource }) => {
  switch (resource) {
    case "timber":
      return (
        <>
          <path className="icon-fill timber-leaf" d="M51 9 19 61h18L23 85h56L65 61h17L51 9Z" />
          <path className="icon-stroke timber-trunk" d="M51 55v33" />
        </>
      );
    case "brick":
      return (
        <>
          <path className="icon-fill brick-clay" d="M14 27h32v18H14zM54 27h32v18H54zM34 52h32v18H34zM14 77h32v10H14zM54 77h32v10H54z" />
          <path className="icon-stroke" d="M14 45h72M14 70h72M46 27v18M54 77v10M34 52v18M66 52v18" />
        </>
      );
    case "grain":
      return (
        <>
          <path className="icon-stroke grain-stem" d="M50 88V18" />
          <path className="icon-fill grain-head" d="M50 18c-15 7-20 18-16 29 13-1 21-10 16-29ZM50 18c15 7 20 18 16 29-13-1-21-10-16-29ZM50 40c-16 5-23 16-20 28 14 1 23-8 20-28ZM50 40c16 5 23 16 20 28-14 1-23-8-20-28Z" />
        </>
      );
    case "fiber":
      return (
        <>
          <path className="icon-fill fiber-body" d="M26 56c0-17 12-30 28-30s28 13 28 30c0 15-11 26-28 26S26 71 26 56Z" />
          <circle className="icon-fill fiber-head" cx="25" cy="48" r="12" />
          <path className="icon-stroke fiber-leg" d="M42 77v13M67 77v13M18 48h-8M21 42l-7-7" />
        </>
      );
    case "ore":
      return (
        <>
          <path className="icon-fill ore-rock" d="M18 70 31 34l30-13 24 28-11 33H36L18 70Z" />
          <path className="icon-stroke ore-vein" d="M31 34 48 54 61 21M48 54 36 82M48 54l37-5" />
        </>
      );
  }
};

const TerrainSvg = ({ terrain }: { terrain: Terrain }) => {
  if (terrain !== "desert") return <ResourceSvg resource={terrain} />;
  return (
    <>
      <path className="icon-fill desert-sand" d="M16 72c14-18 29-17 43-8 10 7 19 7 29-1v22H16V72Z" />
      <path className="icon-stroke cactus" d="M48 84V24M48 43H33c-6 0-9-4-9-10v-7M48 57h17c6 0 9-4 9-10v-9" />
      <path className="icon-stroke desert-mark" d="M21 79h68" />
    </>
  );
};

const BoardIcon = ({ terrain, x, y, size = 0.44 }: { terrain: Terrain; x: number; y: number; size?: number }) => (
  <g className={`board-icon board-icon-${terrain}`} transform={`translate(${x - size / 2} ${y - size / 2}) scale(${size / 100})`}>
    <TerrainSvg terrain={terrain} />
  </g>
);

const ResourceIcon = ({ resource }: { resource: Resource }) => (
  <svg className={`resource-icon resource-icon-${resource}`} viewBox="0 0 100 100" aria-hidden="true">
    <ResourceSvg resource={resource} />
  </svg>
);

const ResourceCard = ({
  resource,
  count,
  compact = false,
  onClick,
  buttonLabel,
  selected = false,
}: {
  resource: Resource;
  count: number;
  compact?: boolean;
  onClick?: () => void;
  buttonLabel?: string;
  selected?: boolean;
}) => {
  const className = `resource-card resource-card-${resource} ${compact ? "compact" : ""} ${onClick ? "resource-card-button" : ""} ${selected ? "selected" : ""}`;
  const content = (
    <>
      <ResourceIcon resource={resource} />
      <span className="resource-count">{count}</span>
      <small className="resource-name">{resourceLabels[resource]}</small>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} aria-label={buttonLabel ?? `${resourceLabels[resource]}: ${count}`}>
        {content}
      </button>
    );
  }
  return (
    <div className={className} role="group" aria-label={`${resourceLabels[resource]}: ${count}`}>
      {content}
    </div>
  );
};

const TradeBundle = ({ bundle }: { bundle: Partial<ResourceBundle> }) => (
  <div className="trade-bundle">
    {resources.filter((resource) => (bundle[resource] ?? 0) > 0).map((resource) => (
      <ResourceCard key={resource} resource={resource} count={bundle[resource] ?? 0} compact />
    ))}
  </div>
);

const TradeResourceButton = ({
  resource,
  owned,
  selected,
  onIncrement,
  onDecrement,
  request = false,
}: {
  resource: Resource;
  owned: number;
  selected: number;
  onIncrement: () => void;
  onDecrement: () => void;
  request?: boolean;
}) => (
  <div className={`trade-card ${selected > 0 ? "selected" : ""}`}>
    <button
      type="button"
      className="trade-card-main"
      onClick={onIncrement}
      disabled={!request && selected >= owned}
      aria-label={`${request ? "Request" : "Offer"} ${resourceLabels[resource]}`}
    >
      <ResourceCard resource={resource} count={request ? selected : owned} compact />
      {selected > 0 ? <span className="trade-selected">x{selected}</span> : null}
    </button>
    <button type="button" className="trade-stepper" onClick={onDecrement} disabled={selected <= 0} aria-label={`Remove ${resourceLabels[resource]}`}>
      -
    </button>
  </div>
);

const DiceFace = ({ value }: { value: number | undefined }) => (
  <div className="die-face" aria-label={value ? `Die ${value}` : "Die not rolled"}>
    {Array.from({ length: 9 }, (_, index) => (
      <span key={index} className={value && dicePips[value]?.includes(index + 1) ? "pip visible" : "pip"} />
    ))}
  </div>
);

const DicePanel = ({
  roll,
  rolling,
  canRoll,
  onRoll,
  timerLabel,
  keyboardShortcutsEnabled,
}: {
  roll?: GameState["lastRoll"];
  rolling: boolean;
  canRoll: boolean;
  onRoll: () => void;
  timerLabel: string | undefined;
  keyboardShortcutsEnabled: boolean;
}) => (
  <button
    type="button"
    className={`dice-panel ${rolling ? "rolling" : ""}`}
    onClick={onRoll}
    disabled={!canRoll}
    aria-label="Roll dice"
    aria-keyshortcuts={keyboardShortcutsEnabled && canRoll ? "R" : undefined}
  >
    <div className="dice-pair">
      <DiceFace value={roll?.dice[0]} />
      <DiceFace value={roll?.dice[1]} />
    </div>
    <strong>{roll ? `Roll ${roll.sum}${roll.doublesMultiplier ? " x2" : ""}` : "Roll --"}</strong>
    {timerLabel ? <span>{timerLabel}</span> : null}
  </button>
);

const HouseSymbol = ({ city = false }: { city?: boolean }) => (
  <svg className={`piece-symbol house-symbol ${city ? "city-symbol" : ""}`} viewBox="0 0 100 100" aria-hidden="true">
    <path className="house-roof" d="M14 47 50 17l36 30-8 9-28-23-28 23-8-9Z" />
    <path className="house-body" d="M24 48h52v34H24z" />
    <path className="house-door" d="M43 60h14v22H43z" />
    {city ? <path className="house-tower" d="M62 36h22v46H62z" /> : null}
  </svg>
);

const RoadSymbol = () => (
  <svg className="piece-symbol road-symbol" viewBox="0 0 100 100" aria-hidden="true">
    <rect className="road-bed" x="12" y="38" width="76" height="24" rx="12" />
    <path className="road-shine" d="M24 45h52" />
  </svg>
);

const TradeSymbol = () => (
  <svg className="action-symbol" viewBox="0 0 100 100" aria-hidden="true">
    <rect className="symbol-card card-a" x="14" y="18" width="34" height="48" rx="7" />
    <rect className="symbol-card card-b" x="52" y="34" width="34" height="48" rx="7" />
    <path className="symbol-stroke" d="M54 20h21l-7-7m7 7-7 7M46 80H25l7 7m-7-7 7-7" />
  </svg>
);

const SpecialSymbol = () => (
  <svg className="action-symbol" viewBox="0 0 100 100" aria-hidden="true">
    <rect className="symbol-card special-card" x="24" y="14" width="52" height="72" rx="9" />
    <path className="symbol-star" d="m50 27 7 14 16 2-12 11 3 16-14-8-14 8 3-16-12-11 16-2 7-14Z" />
  </svg>
);

const EndTurnSymbol = ({ waiting = false }: { waiting?: boolean }) => (
  <svg className={`action-symbol ${waiting ? "waiting-symbol" : ""}`} viewBox="0 0 100 100" aria-hidden="true">
    {waiting ? (
      <>
        <path className="symbol-stroke hourglass" d="M30 15h40M30 85h40M36 15c0 20 28 20 28 35S36 65 36 85M64 15c0 20-28 20-28 35s28 15 28 35" />
        <path className="symbol-fill sand-fill" d="M42 32h16l-8 10-8-10Zm8 26 12 18H38l12-18Z" />
      </>
    ) : (
      <path className="symbol-stroke end-arrow" d="M21 50h48M52 29l21 21-21 21" />
    )}
  </svg>
);

const BoardHousePiece = ({ city = false }: { city?: boolean }) => (
  <g className={`house-piece ${city ? "city" : ""}`}>
    <path className="house-roof" d="M-0.19 -0.03 0 -0.21 0.19 -0.03 0.14 0.03 0 -0.1 -0.14 0.03Z" />
    <path className="house-body" d="M-0.13 -0.02h0.26v0.2h-0.26Z" />
    <path className="house-door" d="M-0.035 0.07h0.07v0.11h-0.07Z" />
    {city ? (
      <>
        <path className="house-tower" d="M0.08 -0.11h0.13v0.29h-0.13Z" />
        <path className="house-roof" d="M0.055 -0.11 0.145 -0.21 0.235 -0.11Z" />
      </>
    ) : null}
  </g>
);

const bundleTotal = (bundle: Partial<Record<Resource, number>>): number =>
  resources.reduce((sum, resource) => sum + (bundle[resource] ?? 0), 0);

const bundlesEqual = (left: ResourceBundle, right: ResourceBundle): boolean =>
  resources.every((resource) => left[resource] === right[resource]);

const EventLine = ({ event }: { event: GameEvent }) => {
  const CostIcons = ({ bundle }: { bundle: Partial<ResourceBundle> }) => (
    <span className="event-icons">
      {resources.filter((resource) => (bundle[resource] ?? 0) > 0).map((resource) => (
        <span key={resource} className="event-resource">
          <ResourceIcon resource={resource} />
          <span>{bundle[resource]}</span>
        </span>
      ))}
    </span>
  );

  if (event.type === "RESOURCES_PRODUCED") {
    return (
      <li>
        <span className="event-seq">{event.seq}</span>
        <span>Produced{event.multiplier ? ` x${event.multiplier}` : ""}</span>
        <span className="event-icons">
          {Object.entries(event.gains).flatMap(([playerId, gains]) =>
            resources
              .filter((resource) => (gains[resource] ?? 0) > 0)
              .map((resource) => (
                <span key={`${playerId}-${resource}`} className="event-resource">
                  <ResourceIcon resource={resource} />
                  <span>{gains[resource]}</span>
                </span>
              )),
          )}
        </span>
      </li>
    );
  }
  if (event.type === "SETUP_PLACED" && bundleTotal(event.startingResources) > 0) {
    return (
      <li>
        <span className="event-seq">{event.seq}</span>
        <span>{event.playerId} setup</span>
        <span className="event-icons">
          {resources.filter((resource) => (event.startingResources[resource] ?? 0) > 0).map((resource) => (
            <span key={resource} className="event-resource">
              <ResourceIcon resource={resource} />
              <span>{event.startingResources[resource]}</span>
            </span>
          ))}
        </span>
      </li>
    );
  }
  if (event.type === "ROAD_BUILT") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} built road</span><CostIcons bundle={event.cost} /></li>;
  }
  if (event.type === "SETTLEMENT_BUILT") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} built settlement (+1 VP)</span><CostIcons bundle={event.cost} /></li>;
  }
  if (event.type === "CITY_UPGRADED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} upgraded city (+1 VP)</span><CostIcons bundle={event.cost} /></li>;
  }
  if (event.type === "SPECIAL_CARD_BOUGHT") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} drew special card #{event.cardIndex}</span><CostIcons bundle={event.cost} /></li>;
  }
  if (event.type === "LONGEST_ROAD_UPDATED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId ? `${event.playerId} claimed Longest Road (${event.length})` : "Longest Road unclaimed"}</span></li>;
  }
  if (event.type === "MARITIME_TRADED") {
    return (
      <li>
        <span className="event-seq">{event.seq}</span>
        <span>{event.playerId} bank {event.ratio}:1</span>
        <span className="event-resource">
          <ResourceIcon resource={event.offered} />
          <span>{event.ratio}</span>
        </span>
        <span className="event-arrow">to</span>
        <span className="event-resource">
          <ResourceIcon resource={event.requested} />
          <span>1</span>
        </span>
      </li>
    );
  }
  if (event.type === "DICE_ROLLED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} rolled {event.sum}{event.doublesMultiplier ? ` x${event.doublesMultiplier}` : ""}</span></li>;
  }
  if (event.type === "TRADE_OFFERED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.trade.fromPlayerId} offered trade</span><CostIcons bundle={event.trade.offered} /><span className="event-arrow">for</span><CostIcons bundle={event.trade.requested} /></li>;
  }
  if (event.type === "TRADE_ACCEPTED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.toPlayerId} accepted trade</span></li>;
  }
  if (event.type === "TRADE_RESPONSE_RECORDED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId ?? "A player"} {event.response === "WANTS_ACCEPT" ? "wants to accept" : event.response === "REJECTED" ? "rejected" : "answered"} trade</span></li>;
  }
  if (event.type === "TRADE_CLOSED") {
    return <li><span className="event-seq">{event.seq}</span><span>Trade closed ({event.reason.toLowerCase().replaceAll("_", " ")})</span></li>;
  }
  if (event.type === "PLIGHT_STRUCK") {
    return <li><span className="event-seq">{event.seq}</span><span>Plight destroyed {event.destroyed.length} building{event.destroyed.length === 1 ? "" : "s"}</span></li>;
  }
  if (event.type === "GAME_OVER") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.winnerId} won the game</span></li>;
  }
  return <li><span className="event-seq">{event.seq}</span><span>{event.type.replaceAll("_", " ").toLowerCase()}</span></li>;
};

const issueCommand = (state: GameState, command: GameCommand): { state: GameState; events: GameEvent[]; error?: string } => {
  const result = applyCommand(state, command);
  if (!result.ok) return { state, events: [], error: result.error.message };
  return { state: result.value.nextState, events: result.value.events };
};

const viewerToGameState = (viewer: ViewerState, seed: string, configOverrides: Partial<Pick<GameConfig, "botDifficulty" | "rules">> = {}): GameState => {
  const state: GameState = {
    schemaVersion: 2,
    config: {
      matchId: `client-${seed}`,
      seed,
      victoryPoints: 10,
      maxPlayers: viewer.playerOrder.length,
      turnSeconds: 45,
      playerOrder: viewer.playerOrder,
      playerNames: Object.fromEntries(viewer.players.map((player) => [player.id, player.name])),
      playerColors: Object.fromEntries(viewer.players.map((player) => [player.id, player.color])),
      botDifficulty: configOverrides.botDifficulty ?? defaultMatchOptions.botDifficulty,
      rules: {
        ...defaultMatchOptions.rules,
        ...configOverrides.rules,
      },
    },
    board: viewer.board,
    players: Object.fromEntries(viewer.players.map((player) => [
      player.id,
      {
        id: player.id,
        name: player.name,
        color: player.color,
        score: player.score,
        resources: player.resources ?? emptyResources(),
        specialCards: player.specialCards,
        longestRoadLength: player.longestRoadLength,
        hasLongestRoad: player.hasLongestRoad,
      },
    ])),
    playerOrder: viewer.playerOrder,
    phase: viewer.phase,
    turn: viewer.turn,
    roads: viewer.roads,
    settlements: viewer.settlements,
    buildings: viewer.buildings,
    trades: Object.fromEntries(viewer.trades.map((trade) => [trade.id, trade])),
    eventSeq: viewer.eventSeq,
    rng: { seed, index: 0, policy: "SEEDED_DETERMINISTIC" },
  };
  if (viewer.lastRoll) state.lastRoll = viewer.lastRoll;
  if (viewer.longestRoadOwner) state.longestRoadOwner = viewer.longestRoadOwner;
  return state;
};

const updateHiddenResourceCount = (count: number, event: GameEvent, playerId: PlayerId): number => {
  switch (event.type) {
    case "ROAD_BUILT":
      return event.playerId === playerId ? Math.max(0, count - resourceCount(event.cost)) : count;
    case "SETTLEMENT_BUILT":
      return event.playerId === playerId ? Math.max(0, count - resourceCount(event.cost)) : count;
    case "CITY_UPGRADED":
      return event.playerId === playerId ? Math.max(0, count - resourceCount(event.cost)) : count;
    case "SPECIAL_CARD_BOUGHT":
      return event.playerId === playerId ? Math.max(0, count - resourceCount(event.cost)) : count;
    case "MARITIME_TRADED":
      return event.playerId === playerId ? Math.max(0, count - event.ratio + 1) : count;
    case "RESOURCES_PRODUCED":
      return count + resourceCount({ ...emptyResources(), ...event.gains[playerId] });
    case "TRADE_ACCEPTED":
      if (event.fromPlayerId === playerId) return Math.max(0, count - resourceCount(event.offered) + resourceCount(event.requested));
      if (event.toPlayerId === playerId) return Math.max(0, count + resourceCount(event.offered) - resourceCount(event.requested));
      return count;
    default:
      return count;
  }
};

const applyEventsToViewer = (
  viewer: ViewerState,
  events: readonly GameEvent[],
  seed: string,
  viewerId: PlayerId | "spectator",
  configOverrides: Partial<Pick<GameConfig, "botDifficulty" | "rules">> = {},
): ViewerState => {
  const projected = serializeForViewer(applyEvents(viewerToGameState(viewer, seed, configOverrides), events), viewerId);
  return {
    ...projected,
    players: projected.players.map((player) => {
      if (player.resources) return player;
      const previous = viewer.players.find((candidate) => candidate.id === player.id);
      const resourceCount = events.reduce((count, event) => updateHiddenResourceCount(count, event, player.id), previous?.resourceCount ?? player.resourceCount);
      return { ...player, resourceCount };
    }),
  };
};

interface PublicRoomPayload {
  id: string;
  status: string;
  settings?: {
    botDifficulty?: BotDifficulty;
    rules?: GameConfig["rules"];
  };
  events?: GameEvent[];
  game?: ViewerState;
}

interface ReplayLogState {
  config: GameConfig;
  board: BoardGraph;
  events: GameEvent[];
}

interface NetworkResumeState {
  token: string;
  userId: PlayerId;
  roomId: string;
  clientSeq: number;
  lastSeq: number;
}

const resumeStorageKey = "colonizt.resume";

const readResumeState = (): NetworkResumeState | null => {
  try {
    const raw = localStorage.getItem(resumeStorageKey);
    return raw ? JSON.parse(raw) as NetworkResumeState : null;
  } catch {
    return null;
  }
};

const writeResumeState = (state: NetworkResumeState): void => {
  localStorage.setItem(resumeStorageKey, JSON.stringify(state));
};

const clearResumeState = (): void => {
  try {
    if (typeof localStorage.removeItem === "function") localStorage.removeItem(resumeStorageKey);
    else localStorage.setItem(resumeStorageKey, "");
  } catch {
    // Resume state is opportunistic; match startup should not depend on storage availability.
  }
};

export const App = () => {
  const [state, setState] = useState<GameState>(() => createDemoGame("web-local"));
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [serverViewer, setServerViewer] = useState<ViewerState | null>(null);
  const [replayLog, setReplayLog] = useState<ReplayLogState | null>(null);
  const [matchMenuOpen, setMatchMenuOpen] = useState(true);
  const [selectedEdge, setSelectedEdge] = useState<EdgeId | null>(null);
  const [selectedVertex, setSelectedVertex] = useState<VertexId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [historyMatches, setHistoryMatches] = useState<MatchSummary[]>([]);
  const [historyStatus, setHistoryStatus] = useState("History idle");
  const [tradeOffer, setTradeOffer] = useState<ResourceBundle>(() => emptyResources());
  const [tradeRequest, setTradeRequest] = useState<ResourceBundle>(() => emptyResources());
  const [tradeOpen, setTradeOpen] = useState(false);
  const [selectedTradeResponder, setSelectedTradeResponder] = useState<PlayerId | null>(null);
  const [localTradeDeadlines, setLocalTradeDeadlines] = useState<Record<string, number>>({});
  const [buildMode, setBuildMode] = useState<"road" | "settlement" | "city">("road");
  const [matchOptions, setMatchOptions] = useState<MatchOptions>(defaultMatchOptions);
  const [pendingSetupVertex, setPendingSetupVertex] = useState<VertexId | null>(null);
  const [diceAnimating, setDiceAnimating] = useState(false);
  const [turnDeadline, setTurnDeadline] = useState<{ key: string; dueAt: number; durationMs: number; mode: "roll" | "action" } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [networkStatus, setNetworkStatus] = useState("Local game");
  const [networkSession, setNetworkSession] = useState<{ token: string; userId: PlayerId } | null>(null);
  const [networkRoomId, setNetworkRoomId] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(true);
  const clientSeqRef = useRef(1);
  const lastServerSeqRef = useRef(0);
  const stateRef = useRef(state);
  const eventsRef = useRef(events);
  const botTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tradeResponseTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastBotRollSeqRef = useRef<number | null>(null);
  const soundCursorRef = useRef<{ matchId: string; seq: number; initialized: boolean }>({ matchId: state.config.matchId, seq: 0, initialized: false });

  const humanPlayerId = networkSession?.userId ?? "p1";
  const viewer = serverViewer ?? serializeForViewer(state, humanPlayerId);
  const legal = getLegalActions(state, humanPlayerId);
  const setupVertices = new Set(legal.find((action) => action.type === "PLACE_SETUP")?.vertices ?? []);
  const setupRoadEdges = pendingSetupVertex && state.phase.type === "SETUP_PLACEMENT"
    ? (state.board.adjacency.vertexToEdges[pendingSetupVertex] ?? []).filter((edgeId) => canBuildRoad(state, humanPlayerId, edgeId, pendingSetupVertex))
    : [];
  const actionRoadEdges = legal.find((action) => action.type === "BUILD_ROAD")?.edges ?? [];
  const legalRoads = new Set(state.phase.type === "SETUP_PLACEMENT" ? setupRoadEdges : buildMode === "road" ? actionRoadEdges : []);
  const legalSettlements = new Set([
    ...(state.phase.type === "SETUP_PLACEMENT" && !pendingSetupVertex ? [...setupVertices] : []),
    ...(state.phase.type === "ACTION_PHASE" && buildMode === "settlement" ? legal.find((action) => action.type === "BUILD_SETTLEMENT")?.vertices ?? [] : []),
  ]);
  const legalCities = new Set(state.phase.type === "ACTION_PHASE" && buildMode === "city" ? legal.find((action) => action.type === "UPGRADE_CITY")?.vertices ?? [] : []);
  const bounds = useMemo(() => boardBounds(state), [state.board]);
  const activePlayer = "activePlayerId" in state.phase ? state.phase.activePlayerId : undefined;
  const activeName = activePlayer ? state.players[activePlayer]?.name ?? activePlayer : undefined;
  const humanPlayer = state.players[humanPlayerId];
  const maritimeAction = legal.find((action) => action.type === "MARITIME_TRADE");
  const maritimeTrades = maritimeAction?.type === "MARITIME_TRADE" ? maritimeAction.trades : [];
  const selectedOfferResources = resources.filter((resource) => tradeOffer[resource] > 0);
  const selectedRequestResources = resources.filter((resource) => tradeRequest[resource] > 0);
  const singleOfferResource = selectedOfferResources.length === 1 ? selectedOfferResources[0] : undefined;
  const previewMaritimeRatio = humanPlayer && singleOfferResource ? maritimeTradeRatio(state, humanPlayerId, singleOfferResource) : 4;
  const bankOfferResource = singleOfferResource && tradeOffer[singleOfferResource] === previewMaritimeRatio ? singleOfferResource : undefined;
  const bankRequestResource = selectedRequestResources.length === 1 && tradeRequest[selectedRequestResources[0]!] === 1 ? selectedRequestResources[0] : undefined;
  const selectedMaritimeTrade = bankOfferResource && bankRequestResource
    ? maritimeTrades.find((trade) => trade.offered === bankOfferResource && trade.requested === bankRequestResource)
    : undefined;
  const latestRollEvent = [...events].reverse().find((event) => event.type === "DICE_ROLLED");
  const latestRollKey = latestRollEvent?.type === "DICE_ROLLED"
    ? `${latestRollEvent.seq}:${latestRollEvent.dice.join("-")}`
    : state.lastRoll
      ? `snapshot:${state.lastRoll.dice.join("-")}`
      : "none";
  const isHumanActive = activePlayer === humanPlayerId;
  const canRoll = legal.some((action) => action.type === "ROLL_DICE");
  const canEndTurn = legal.some((action) => action.type === "END_TURN");
  const canOfferTrade = legal.some((action) => action.type === "OFFER_TRADE");
  const specialCost = specialCardCost(state.config.rules);
  const canBuySpecialCard = legal.some((action) => action.type === "BUY_SPECIAL_CARD");
  const hasTradeOverlap = resources.some((resource) => tradeOffer[resource] > 0 && tradeRequest[resource] > 0);
  const canSubmitOfferTrade = canOfferTrade && resourceCount(tradeOffer) > 0 && resourceCount(tradeRequest) > 0 && !hasTradeOverlap && Boolean(humanPlayer && hasResources(humanPlayer.resources, tradeOffer));
  const keyboardShortcutsEnabled = platform() === "desktop";
  const activeRules = [
    state.config.rules?.mapRandomized ? "Random map" : "Fixed map",
    state.config.rules?.diceDoubles ? "Doubles x2" : undefined,
    state.config.rules?.plight ? `Plight turn ${state.config.rules.plightTurn ?? 20}` : undefined,
    state.config.rules?.specialCardCostRandomized ? "Random special cost" : undefined,
  ].filter((rule): rule is string => Boolean(rule));
  const stagedTrades = Object.values(state.trades)
    .filter((trade) => trade.status === "COLLECTING_RESPONSES")
    .filter((trade) => trade.fromPlayerId === humanPlayerId || trade.recipients === "ANY" || trade.recipients.includes(humanPlayerId));
  const activeStagedTrade = stagedTrades[0];
  const stagedTradeDeadline = activeStagedTrade
    ? (viewer.tradeResponseDeadlines?.[activeStagedTrade.id] ?? localTradeDeadlines[activeStagedTrade.id])
    : undefined;
  const stagedTradeSeconds = stagedTradeDeadline ? Math.max(0, Math.ceil((stagedTradeDeadline - nowMs) / 1000)) : undefined;
  const stagedRecipientIds = activeStagedTrade
    ? state.playerOrder.filter((playerId) =>
      playerId !== activeStagedTrade.fromPlayerId
      && (activeStagedTrade.recipients === "ANY" || activeStagedTrade.recipients.includes(playerId)),
    )
    : [];
  const selectedResponderCanFinalize = Boolean(
    activeStagedTrade
    && selectedTradeResponder
    && activeStagedTrade.responses?.[selectedTradeResponder]?.status === "WANTS_ACCEPT"
    && hasResources(state.players[selectedTradeResponder]?.resources ?? emptyResources(), activeStagedTrade.requested)
    && hasResources(state.players[activeStagedTrade.fromPlayerId]?.resources ?? emptyResources(), activeStagedTrade.offered),
  );
  const showTradePanel = tradeOpen || Boolean(activeStagedTrade);
  const canUpgradeCity = legalCities.size > 0;
  const canBuildSettlement = (legal.find((action) => action.type === "BUILD_SETTLEMENT")?.vertices.length ?? 0) > 0;
  const canBuildRoadAction = actionRoadEdges.length > 0;
  const turnSecondsRemaining = turnDeadline ? Math.max(0, Math.ceil((turnDeadline.dueAt - nowMs) / 1000)) : undefined;
  const turnTimerLabel = turnDeadline && turnSecondsRemaining !== undefined
    ? `${turnDeadline.mode === "roll" ? "Roll" : "Action"} ${formatTimer(turnSecondsRemaining)}`
    : undefined;
  const isWaitingForHumanTurn = state.phase.type !== "GAME_OVER" && !isHumanActive;
  const endTurnButtonLabel = isWaitingForHumanTurn ? "Waiting" : "End Turn";
  const setupSettlementActive = state.phase.type === "SETUP_PLACEMENT" && isHumanActive && !pendingSetupVertex;
  const setupRoadActive = state.phase.type === "SETUP_PLACEMENT" && isHumanActive && Boolean(pendingSetupVertex);
  const actionHint = (() => {
    if (state.phase.type === "GAME_OVER") return { title: "Game over", detail: `${state.players[state.phase.winnerId]?.name ?? state.phase.winnerId} reached the victory target.` };
    if (!isHumanActive) return { title: "Waiting", detail: `${activeName ?? "Opponent"} is taking a turn.` };
    if (activeStagedTrade?.fromPlayerId === humanPlayerId) return { title: "Choose trade partner", detail: "Pick a player who wants to accept, or cancel the offer." };
    if (activeStagedTrade) return { title: "Answer trade", detail: "Mark whether you want to accept before the offer expires." };
    if (state.phase.type === "SETUP_PLACEMENT" && pendingSetupVertex) return { title: "Place setup road", detail: "Pick a glowing brown edge attached to the new settlement." };
    if (state.phase.type === "SETUP_PLACEMENT") return { title: "Place setup settlement", detail: "Pick a glowing corner, then choose its road edge." };
    if (state.phase.type === "WAITING_FOR_ROLL") return { title: "Roll dice", detail: "Roll for matching numbered tiles." };
    if (canUpgradeCity || canBuildSettlement || canBuildRoadAction) return { title: "Build or trade", detail: "Choose a build mode, use glowing spots, trade, or end." };
    return { title: "Trade or end", detail: "Trade if eligible, or end the turn." };
  })();

  const bankRatiosForState = (targetState: GameState, playerId: PlayerId): Partial<Record<Resource, number>> =>
    Object.fromEntries(resources.map((resource) => [resource, maritimeTradeRatio(targetState, playerId, resource)])) as Partial<Record<Resource, number>>;

  const normalizeDraftForState = (targetState: GameState, offer = tradeOffer, request = tradeRequest): TradeDraft => {
    const player = targetState.players[humanPlayerId];
    return normalizeTradeDraft({ offer, request }, player?.resources ?? emptyResources(), bankRatiosForState(targetState, humanPlayerId));
  };

  const setTradeDraft = (draft: TradeDraft) => {
    setTradeOffer(draft.offer);
    setTradeRequest(draft.request);
  };

  const clearTradeDraft = () => setTradeDraft({ offer: emptyResources(), request: emptyResources() });

  const setBotDifficulty = (botDifficulty: BotDifficulty) => {
    setMatchOptions((current) => ({ ...current, botDifficulty }));
  };

  const setRuleEnabled = (rule: Exclude<keyof MatchOptions["rules"], "plightTurn">, enabled: boolean) => {
    setMatchOptions((current) => ({
      ...current,
      rules: {
        ...current.rules,
        [rule]: enabled,
      },
    }));
  };

  const clearAutomationTimers = () => {
    if (botTimerRef.current) clearTimeout(botTimerRef.current);
    botTimerRef.current = null;
    for (const timer of tradeResponseTimersRef.current.values()) clearTimeout(timer);
    tradeResponseTimersRef.current.clear();
  };

  const applyLocalCommand = (command: GameCommand): { state: GameState; events: GameEvent[]; error?: string } => {
    const result = issueCommand(stateRef.current, command);
    if (result.error) {
      setError(result.error);
      return result;
    }
    stateRef.current = result.state;
    setState(result.state);
    setServerViewer(null);
    const nextEvents = [...eventsRef.current, ...result.events];
    eventsRef.current = nextEvents;
    setEvents(nextEvents);
    setReplayLog(null);
    setError(null);
    setReplayIndex(null);
    if (command.type === "MARITIME_TRADE" || command.type === "OFFER_TRADE") {
      clearTradeDraft();
      setTradeOpen(false);
    } else {
      setTradeDraft(normalizeDraftForState(result.state));
    }
    return result;
  };

  const commit = (command: GameCommand) => {
    const started = performance.now();
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN && networkRoomId) {
      createNetworkClient().sendCommand(socketRef.current, networkRoomId, clientSeqRef.current, command);
      clientSeqRef.current += 1;
      if (networkSession) writeResumeState({ token: networkSession.token, userId: networkSession.userId, roomId: networkRoomId, clientSeq: clientSeqRef.current, lastSeq: lastServerSeqRef.current });
      if (command.type === "MARITIME_TRADE" || command.type === "OFFER_TRADE") {
        clearTradeDraft();
        setTradeOpen(false);
      }
      track("network_command_sent", { mode: "network", platform: platform(), command: command.type, latencyMs: performance.now() - started });
      return;
    }
    const result = applyLocalCommand(command);
    if (result.error) return;
    track("command_applied", { mode: "local", platform: platform(), command: command.type, latencyMs: performance.now() - started });
  };

  const cancelPendingSetupPlacement = () => {
    setPendingSetupVertex(null);
    setSelectedVertex(null);
    setSelectedEdge(null);
  };

  const handleBoardClick = () => {
    if (pendingSetupVertex) cancelPendingSetupPlacement();
  };

  const handleVertex = (vertexId: VertexId) => {
    setSelectedVertex(vertexId);
    setSelectedEdge(null);
    const started = performance.now();
    if (state.phase.type === "SETUP_PLACEMENT" && activePlayer === humanPlayerId) {
      if (pendingSetupVertex) {
        cancelPendingSetupPlacement();
        playSound("select");
        return;
      }
      if (setupVertices.has(vertexId)) {
        playSound("select");
        setPendingSetupVertex(vertexId);
        setSelectedEdge(null);
        setBuildMode("road");
      }
    } else if (state.phase.type === "ACTION_PHASE" && buildMode === "settlement" && legalSettlements.has(vertexId)) {
      playSound("select");
      commit({ type: "BUILD_SETTLEMENT", playerId: humanPlayerId, vertexId });
    } else if (state.phase.type === "ACTION_PHASE" && buildMode === "city" && legalCities.has(vertexId)) {
      playSound("select");
      commit({ type: "UPGRADE_CITY", playerId: humanPlayerId, vertexId });
    }
    track("board_vertex_tap", { mode: "local", platform: platform(), feedbackMs: performance.now() - started });
  };

  const handleEdge = (edgeId: EdgeId) => {
    setSelectedEdge(edgeId);
    if (state.phase.type === "SETUP_PLACEMENT" && pendingSetupVertex && legalRoads.has(edgeId)) {
      playSound("select");
      commit({ type: "PLACE_SETUP", playerId: humanPlayerId, vertexId: pendingSetupVertex, edgeId });
      setPendingSetupVertex(null);
    } else if (state.phase.type === "ACTION_PHASE" && buildMode === "road" && legalRoads.has(edgeId)) {
      playSound("select");
      commit({ type: "BUILD_ROAD", playerId: humanPlayerId, edgeId });
    }
  };

  const resetNetworkSession = () => {
    shouldReconnectRef.current = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    socketRef.current?.close();
    socketRef.current = null;
    setNetworkSession(null);
    setNetworkRoomId(null);
    clientSeqRef.current = 1;
    lastServerSeqRef.current = 0;
    clearResumeState();
  };

  const startBotMatch = () => {
    resetNetworkSession();
    clearAutomationTimers();
    const next = createDemoGame(`web-bot-${Date.now()}`, matchOptions);
    setState(next);
    setServerViewer(null);
    setEvents([]);
    setReplayLog(null);
    setReplayIndex(null);
    setPendingSetupVertex(null);
    setSelectedEdge(null);
    setSelectedVertex(null);
    setBuildMode("road");
    setTradeOffer(emptyResources());
    setTradeRequest(emptyResources());
    setTradeOpen(false);
    setNetworkStatus("Bot match");
    setError(null);
    setMatchMenuOpen(false);
    track("room_creation_completed", { mode: "local", platform: platform(), taps: 1 });
  };

  const currentConfigOptions = (): Partial<Pick<GameConfig, "botDifficulty" | "rules">> => ({
    botDifficulty: stateRef.current.config.botDifficulty ?? matchOptions.botDifficulty,
    rules: {
      ...matchOptions.rules,
      ...stateRef.current.config.rules,
    },
  });

  const startReadyGame = () => {
    if (networkRoomId && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "READY", roomId: networkRoomId, ready: true }));
      setNetworkStatus(`Ready in ${networkRoomId}`);
      return;
    }
    clearAutomationTimers();
    const completed = completeSetup(createDemoGame(`web-ready-${Date.now()}`, matchOptions));
    setState(completed.state);
    setServerViewer(null);
    setEvents(completed.events);
    setReplayLog(null);
    setReplayIndex(null);
    setTradeOffer(emptyResources());
    setTradeRequest(emptyResources());
    setTradeOpen(false);
    setMatchMenuOpen(false);
    track("room_creation_completed", { mode: "local", platform: platform(), taps: 1 });
  };

  const roll = () => {
    playSound("select");
    commit({ type: "ROLL_DICE", playerId: humanPlayerId });
  };
  const endTurn = () => {
    playSound("select");
    commit({ type: "END_TURN", playerId: humanPlayerId });
  };
  const buySpecialCard = () => {
    playSound("select");
    commit({ type: "BUY_SPECIAL_CARD", playerId: humanPlayerId });
  };
  const openTradePanel = () => {
    if (!canOfferTrade && !activeStagedTrade) return;
    playSound("select");
    setTradeOpen(true);
    track("trade_panel_opened", { mode: socketRef.current ? "network" : "local", platform: platform(), source: "action_button" });
  };
  const chooseBuildMode = (mode: "road" | "settlement" | "city") => {
    if (state.phase.type !== "ACTION_PHASE" && !(mode === "road" && pendingSetupVertex)) return;
    playSound("select");
    setBuildMode(mode);
    setTradeOpen(false);
    if (mode !== "road") setSelectedEdge(null);
    if (mode !== "settlement" && mode !== "city") setSelectedVertex(null);
  };
  const openTradeFromResource = (resource: Resource) => {
    setTradeOpen(true);
    playSound("select");
    const owned = humanPlayer?.resources[resource] ?? 0;
    if (!canOfferTrade || owned <= tradeOffer[resource]) return;
    const nextOffer = { ...tradeOffer, [resource]: tradeOffer[resource] + 1 };
    const nextRequest = { ...tradeRequest, [resource]: 0 };
    setTradeDraft(normalizeDraftForState(state, nextOffer, nextRequest));
  };
  const incrementTradeBundle = (kind: "offer" | "request", resource: Resource) => {
    const current = { offer: tradeOffer, request: tradeRequest };
    const next = {
      offer: { ...current.offer },
      request: { ...current.request },
    };
    if (kind === "offer") {
      next.offer[resource] += 1;
      next.request[resource] = 0;
    } else {
      next.request[resource] += 1;
      next.offer[resource] = 0;
    }
    playSound("select");
    setTradeDraft(normalizeDraftForState(state, next.offer, next.request));
  };
  const decrementTradeBundle = (kind: "offer" | "request", resource: Resource) => {
    const next = {
      offer: { ...tradeOffer },
      request: { ...tradeRequest },
    };
    if (kind === "offer") next.offer[resource] = Math.max(0, next.offer[resource] - 1);
    else next.request[resource] = Math.max(0, next.request[resource] - 1);
    playSound("select");
    setTradeDraft(normalizeDraftForState(state, next.offer, next.request));
  };
  const clearTrade = () => {
    playSound("select");
    clearTradeDraft();
  };
  const offerTrade = () => {
    playSound("select");
    commit({
      type: "OFFER_TRADE",
      playerId: humanPlayerId,
      tradeId: `web-trade-${Date.now()}`,
      offered: tradeOffer,
      requested: tradeRequest,
      recipients: "ANY",
      ttlEvents: 10,
    });
    track("trade_panel_opened", { mode: "local", platform: platform(), offered: resourceCount(tradeOffer), requested: resourceCount(tradeRequest) });
  };
  const bankTrade = () => {
    if (!bankOfferResource || !bankRequestResource) return;
    playSound("select");
    commit({ type: "MARITIME_TRADE", playerId: humanPlayerId, offered: bankOfferResource, requested: bankRequestResource });
    track("maritime_trade_submitted", { mode: socketRef.current ? "network" : "local", platform: platform(), offered: bankOfferResource, requested: bankRequestResource, ratio: selectedMaritimeTrade?.ratio ?? previewMaritimeRatio });
  };
  const respondToTrade = (tradeId: string, response: "WANTS_ACCEPT" | "REJECTED") => {
    playSound("select");
    commit({ type: "RESPOND_TRADE", playerId: humanPlayerId, tradeId, response });
    track(response === "WANTS_ACCEPT" ? "trade_wants_accept" : "trade_rejected", { mode: socketRef.current ? "network" : "local", platform: platform(), tradeId });
  };
  const finalizeTrade = (tradeId: string, toPlayerId: PlayerId) => {
    playSound("select");
    commit({ type: "FINALIZE_TRADE", playerId: humanPlayerId, tradeId, toPlayerId });
    setSelectedTradeResponder(null);
    track("trade_finalized", { mode: socketRef.current ? "network" : "local", platform: platform(), tradeId, toPlayerId });
  };
  const cancelTrade = (tradeId: string) => {
    playSound("select");
    commit({ type: "CANCEL_TRADE", playerId: humanPlayerId, tradeId });
    setSelectedTradeResponder(null);
    track("trade_cancelled", { mode: socketRef.current ? "network" : "local", platform: platform(), tradeId });
  };

  const connectOnlineSession = (session: { token: string; userId: PlayerId }, roomId: string, ready: boolean) => {
    shouldReconnectRef.current = true;
    const client = createNetworkClient();
    void client.connect(session.token, {
      onOpen: (openSocket) => {
        socketRef.current = openSocket;
        openSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId }));
        if (ready) openSocket.send(JSON.stringify({ type: "READY", roomId, ready: true }));
        openSocket.send(JSON.stringify({ type: "RESYNC", roomId, lastSeq: lastServerSeqRef.current }));
      },
      onEvents: (incomingEvents, snapshot) => {
        setReplayLog(null);
        if (incomingEvents.length > 0) {
          const expectedSeq = lastServerSeqRef.current + 1;
          if (incomingEvents[0]!.seq !== expectedSeq && socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ type: "RESYNC", roomId, lastSeq: lastServerSeqRef.current }));
            return;
          }
          lastServerSeqRef.current = Math.max(lastServerSeqRef.current, ...incomingEvents.map((event) => event.seq));
          setEvents((current) => [...current, ...incomingEvents]);
          if (!snapshot) {
            setServerViewer((current) => current ? applyEventsToViewer(current, incomingEvents, roomId, current.viewerId, currentConfigOptions()) : null);
            setState((current) => applyEvents(current, incomingEvents));
          }
        }
        if (snapshot) {
          setState(viewerToGameState(snapshot, roomId, currentConfigOptions()));
          setServerViewer(snapshot);
          lastServerSeqRef.current = Math.max(lastServerSeqRef.current, snapshot.eventSeq);
          if (incomingEvents.length === 0) setEvents([]);
        }
        writeResumeState({ token: session.token, userId: session.userId, roomId, clientSeq: clientSeqRef.current, lastSeq: lastServerSeqRef.current });
        setNetworkStatus(`Online ${roomId}`);
      },
      onRoom: (incomingRoom) => {
        const publicRoom = incomingRoom as PublicRoomPayload;
        setReplayLog(null);
        setReplayIndex(null);
        setEvents(publicRoom.events ?? []);
        const roomConfigOptions: Partial<Pick<GameConfig, "botDifficulty" | "rules">> = {
          botDifficulty: publicRoom.settings?.botDifficulty ?? currentConfigOptions().botDifficulty,
          rules: {
            ...currentConfigOptions().rules,
            ...publicRoom.settings?.rules,
          },
        };
        if (publicRoom.game) {
          setState(viewerToGameState(publicRoom.game, publicRoom.id, roomConfigOptions));
          setServerViewer(publicRoom.game);
          lastServerSeqRef.current = Math.max(lastServerSeqRef.current, publicRoom.game.eventSeq, ...(publicRoom.events ?? []).map((event) => event.seq));
        }
        writeResumeState({ token: session.token, userId: session.userId, roomId: publicRoom.id, clientSeq: clientSeqRef.current, lastSeq: lastServerSeqRef.current });
        setNetworkStatus(`Online ${publicRoom.id} · ${publicRoom.status}`);
      },
      onError: (incomingError) => setError(JSON.stringify(incomingError)),
      onClose: () => {
        setNetworkStatus("Online connection closed");
        if (!shouldReconnectRef.current) return;
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          setNetworkStatus("Reconnecting...");
          connectOnlineSession(session, roomId, false);
        }, 750);
      },
    }).then((socket) => {
      socketRef.current = socket;
    }).catch((connectError) => {
      setNetworkStatus("Online unavailable");
      setError(connectError instanceof Error ? connectError.message : "Online connection failed");
    });
  };

  const startOnlineRoom = async () => {
    try {
      setMatchMenuOpen(false);
      setNetworkStatus("Creating online room...");
      const client = createNetworkClient();
      const session = await client.createSession("Browser Host");
      const room = await client.createRoom(session.token, { ...matchOptions, mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });
      setState((current) => {
        const next = {
          ...current,
          config: {
            ...current.config,
            botDifficulty: matchOptions.botDifficulty,
            rules: { ...matchOptions.rules },
          },
        };
        stateRef.current = next;
        return next;
      });
      setNetworkSession({ token: session.token, userId: session.userId });
      setNetworkRoomId(room.id);
      clientSeqRef.current = 1;
      lastServerSeqRef.current = 0;
      writeResumeState({ token: session.token, userId: session.userId, roomId: room.id, clientSeq: clientSeqRef.current, lastSeq: lastServerSeqRef.current });
      connectOnlineSession({ token: session.token, userId: session.userId }, room.id, false);
      track("room_creation_completed", { mode: "network", platform: platform(), taps: 1 });
    } catch (onlineError) {
      setNetworkStatus("Online unavailable");
      setError(onlineError instanceof Error ? onlineError.message : "Online room failed");
    }
  };

  const startPlayerMatch = () => {
    void startOnlineRoom();
  };

  const joinOnlineRoom = async (roomId: string) => {
    try {
      setMatchMenuOpen(false);
      setNetworkStatus("Joining online room...");
      const client = createNetworkClient();
      const session = await client.createSession("Browser Player");
      setNetworkSession({ token: session.token, userId: session.userId });
      setNetworkRoomId(roomId);
      clientSeqRef.current = 1;
      lastServerSeqRef.current = 0;
      writeResumeState({ token: session.token, userId: session.userId, roomId, clientSeq: clientSeqRef.current, lastSeq: lastServerSeqRef.current });
      connectOnlineSession({ token: session.token, userId: session.userId }, roomId, false);
      track("room_join_started", { mode: "network", platform: platform(), roomId });
    } catch (joinError) {
      setNetworkStatus("Online unavailable");
      setError(joinError instanceof Error ? joinError.message : "Online join failed");
    }
  };

  const cleanupOnlineSession = () => {
    shouldReconnectRef.current = false;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    socketRef.current?.close();
  };

  useEffect(() => {
    const inviteRoomId = new URLSearchParams(window.location.search).get("roomId");
    const saved = readResumeState();
    const resumable = saved && (!inviteRoomId || saved.roomId === inviteRoomId) ? saved : undefined;
    if (!resumable) {
      if (inviteRoomId) {
        void joinOnlineRoom(inviteRoomId);
        return cleanupOnlineSession;
      }
      return undefined;
    }
    setMatchMenuOpen(false);
    clientSeqRef.current = resumable.clientSeq;
    lastServerSeqRef.current = resumable.lastSeq;
    setNetworkSession({ token: resumable.token, userId: resumable.userId });
    setNetworkRoomId(resumable.roomId);
    setNetworkStatus("Resuming online room...");
    connectOnlineSession({ token: resumable.token, userId: resumable.userId }, resumable.roomId, false);
    return cleanupOnlineSession;
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    const matchId = state.config.matchId;
    const maxSeq = events.reduce((current, event) => Math.max(current, event.seq), 0);
    const cursor = soundCursorRef.current;

    if (matchMenuOpen || replayIndex !== null) {
      soundCursorRef.current = { matchId, seq: maxSeq, initialized: true };
      return;
    }

    if (!cursor.initialized || cursor.matchId !== matchId) {
      soundCursorRef.current = { matchId, seq: maxSeq, initialized: true };
      return;
    }

    const freshEvents = events
      .filter((event) => event.seq > cursor.seq)
      .sort((left, right) => left.seq - right.seq);
    for (const event of freshEvents) playSoundForEvent(event);
    soundCursorRef.current = { matchId, seq: maxSeq, initialized: true };
  }, [events, matchMenuOpen, replayIndex, state.config.matchId]);

  useEffect(() => {
    const normalized = normalizeDraftForState(state);
    if (!bundlesEqual(normalized.offer, tradeOffer) || !bundlesEqual(normalized.request, tradeRequest)) {
      setTradeDraft(normalized);
    }
  }, [state.eventSeq, humanPlayerId]);

  useEffect(() => {
    if (latestRollKey === "none") return undefined;
    setDiceAnimating(true);
    const timer = setTimeout(() => setDiceAnimating(false), diceAnimationMs);
    return () => clearTimeout(timer);
  }, [latestRollKey]);

  useEffect(() => {
    if (!selectedTradeResponder || selectedResponderCanFinalize) return;
    setSelectedTradeResponder(null);
  }, [selectedResponderCanFinalize, selectedTradeResponder]);

  useEffect(() => {
    const phaseMode = state.phase.type === "WAITING_FOR_ROLL"
      ? "roll"
      : state.phase.type === "ACTION_PHASE"
        ? "action"
        : null;
    if (!phaseMode || !activePlayer || matchMenuOpen || replayIndex !== null || state.phase.type === "GAME_OVER") {
      setTurnDeadline(null);
      return undefined;
    }

    const durationMs = phaseMode === "roll" ? rollDeadlineMs : actionDeadlineMs;
    const key = `${state.config.matchId}:${state.eventSeq}:${state.phase.type}:${activePlayer}`;
    const dueAt = Date.now() + durationMs;
    setNowMs(Date.now());
    setTurnDeadline({ key, dueAt, durationMs, mode: phaseMode });

    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    const timeout = setTimeout(() => {
      if (networkRoomId) return;
      const current = stateRef.current;
      const currentActive = "activePlayerId" in current.phase ? current.phase.activePlayerId : undefined;
      const currentKey = current.phase.type !== "GAME_OVER" && currentActive
        ? `${current.config.matchId}:${current.eventSeq}:${current.phase.type}:${currentActive}`
        : null;
      if (currentKey !== key || currentActive !== humanPlayerId) return;
      if (current.phase.type === "WAITING_FOR_ROLL") {
        commit({ type: "ROLL_DICE", playerId: humanPlayerId });
      } else if (current.phase.type === "ACTION_PHASE") {
        const modalTrade = Object.values(current.trades).find((trade) => trade.status === "COLLECTING_RESPONSES" && trade.fromPlayerId === humanPlayerId);
        if (modalTrade) {
          const closed = applyLocalCommand({ type: "EXPIRE_TRADE", playerId: humanPlayerId, tradeId: modalTrade.id, reason: "RESPONSE_TIMEOUT" });
          if (!closed.error) applyLocalCommand({ type: "END_TURN", playerId: humanPlayerId });
        } else {
          commit({ type: "END_TURN", playerId: humanPlayerId });
        }
      }
    }, durationMs);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [activePlayer, humanPlayerId, matchMenuOpen, networkRoomId, replayIndex, state.config.matchId, state.eventSeq, state.phase.type]);

  const botAutomationKey = !networkRoomId && replayIndex === null && !matchMenuOpen && state.phase.type !== "GAME_OVER" && activePlayer && botIds.has(activePlayer)
    ? `${state.config.matchId}:${state.eventSeq}:${state.phase.type}:${activePlayer}`
    : null;

  useEffect(() => {
    if (!botAutomationKey || !activePlayer || !botIds.has(activePlayer)) return undefined;
    const latestBotRoll = [...eventsRef.current].reverse().find((event) => event.type === "DICE_ROLLED" && event.playerId === activePlayer);
    const isPostRollAction = state.phase.type === "ACTION_PHASE" && latestBotRoll?.type === "DICE_ROLLED" && lastBotRollSeqRef.current !== latestBotRoll.seq;
    const activeCollectingTrade = Object.values(state.trades).find((trade) =>
      trade.status === "COLLECTING_RESPONSES"
      && trade.fromPlayerId === activePlayer,
    );
    const activeTradeIncludesHuman = activeCollectingTrade
      ? activeCollectingTrade.recipients === "ANY" || activeCollectingTrade.recipients.includes(humanPlayerId)
      : false;
    const baseDelay = state.phase.type === "WAITING_FOR_ROLL"
      ? botActionDelays.ROLL_DICE
      : state.phase.type === "SETUP_PLACEMENT"
        ? botActionDelays.PLACE_SETUP
        : botActionDelays.DEFAULT;
    const tradePauseDelay = activeCollectingTrade ? (activeTradeIncludesHuman ? 3200 : 1450) : undefined;
    const delay = tradePauseDelay ?? (isPostRollAction ? Math.max(botActionDelays.BUILD_ROAD, diceAnimationMs + 120) : baseDelay);
    if (isPostRollAction && latestBotRoll?.type === "DICE_ROLLED") lastBotRollSeqRef.current = latestBotRoll.seq;
    botTimerRef.current = setTimeout(() => {
      const current = stateRef.current;
      const currentActive = "activePlayerId" in current.phase ? current.phase.activePlayerId : undefined;
      const currentKey = current.phase.type !== "GAME_OVER" && currentActive && botIds.has(currentActive)
        ? `${current.config.matchId}:${current.eventSeq}:${current.phase.type}:${currentActive}`
        : null;
      if (currentKey !== botAutomationKey || !currentActive) return;
      if (Object.values(current.trades).some((trade) => trade.status === "COLLECTING_RESPONSES" && trade.fromPlayerId === currentActive)) return;
      const controller = botById[currentActive as keyof typeof botById] ?? randomLegalBot;
      const view = createBotView(current, currentActive, controller.profile);
      const command = controller.chooseCommand(view, (prefix: string) => createBotTradeId(current, currentActive, controller.profile) || prefix);
      if (!command) return;
      const result = applyLocalCommand(command);
      if (result.error && current.phase.type === "ACTION_PHASE") {
        applyLocalCommand({ type: "END_TURN", playerId: currentActive });
      }
    }, delay);
    return () => {
      if (botTimerRef.current) clearTimeout(botTimerRef.current);
      botTimerRef.current = null;
    };
  }, [botAutomationKey, activePlayer, state.phase.type]);

  useEffect(() => {
    if (networkRoomId || replayIndex !== null || matchMenuOpen) return;
    const collecting = Object.values(state.trades).filter((trade) => trade.status === "COLLECTING_RESPONSES");
    setLocalTradeDeadlines((current) => {
      const next: Record<string, number> = {};
      for (const trade of collecting) next[trade.id] = current[trade.id] ?? Date.now() + 15_000;
      return next;
    });
    collecting.forEach((trade) => {
      const recipients = trade.recipients === "ANY" ? [...botIds].filter((botId) => botId !== trade.fromPlayerId) : trade.recipients.filter((botId) => botIds.has(botId));
      recipients.forEach((botId, index) => {
        if (trade.responses?.[botId]?.status !== "PENDING") return;
        const key = `response:${trade.id}:${botId}:${trade.createdAtSeq}`;
        if (tradeResponseTimersRef.current.has(key)) return;
        const timer = setTimeout(() => {
          tradeResponseTimersRef.current.delete(key);
          const current = stateRef.current;
          const currentTrade = current.trades[trade.id];
          if (!currentTrade || currentTrade.status !== "COLLECTING_RESPONSES") return;
          if (currentTrade.recipients !== "ANY" && !currentTrade.recipients.includes(botId)) return;
          const controller = botById[botId as keyof typeof botById] ?? greedyBot;
          const view = createBotView(current, botId, controller.profile);
          const response = evaluateTrade(view, currentTrade, controller.profile) === "ACCEPT" ? "WANTS_ACCEPT" : "REJECTED";
          applyLocalCommand({ type: "RESPOND_TRADE", playerId: botId, tradeId: currentTrade.id, response });
        }, 650 + index * 450);
        tradeResponseTimersRef.current.set(key, timer);
      });

      const deadlineKey = `deadline:${trade.id}:${trade.createdAtSeq}`;
      if (tradeResponseTimersRef.current.has(deadlineKey)) return;
      const timer = setTimeout(() => {
        tradeResponseTimersRef.current.delete(deadlineKey);
        const current = stateRef.current;
        const currentTrade = current.trades[trade.id];
        if (!currentTrade || currentTrade.status !== "COLLECTING_RESPONSES") return;
        if (!botIds.has(currentTrade.fromPlayerId)) {
          applyLocalCommand({ type: "EXPIRE_TRADE", playerId: currentTrade.fromPlayerId, tradeId: currentTrade.id, reason: "RESPONSE_TIMEOUT" });
          return;
        }
        const controller = botById[currentTrade.fromPlayerId as keyof typeof botById] ?? greedyBot;
        const view = createBotView(current, currentTrade.fromPlayerId, controller.profile);
        const candidates = current.playerOrder
          .filter((playerId) => playerId !== currentTrade.fromPlayerId)
          .filter((playerId) => currentTrade.recipients === "ANY" || currentTrade.recipients.includes(playerId))
          .filter((playerId) => currentTrade.responses?.[playerId]?.status === "WANTS_ACCEPT")
          .filter((playerId) =>
            hasResources(current.players[currentTrade.fromPlayerId]?.resources ?? emptyResources(), currentTrade.offered)
            && hasResources(current.players[playerId]?.resources ?? emptyResources(), currentTrade.requested),
          )
          .map((playerId) => ({
            playerId,
            score: evaluateState(view, addResources(subtractResources(view.ownResources, currentTrade.offered), currentTrade.requested)) - (current.players[playerId]?.score ?? 0) * 0.03,
          }))
          .sort((left, right) => right.score - left.score || current.playerOrder.indexOf(left.playerId) - current.playerOrder.indexOf(right.playerId));
        const selected = candidates[0]?.playerId;
        applyLocalCommand(selected
          ? { type: "FINALIZE_TRADE", playerId: currentTrade.fromPlayerId, tradeId: currentTrade.id, toPlayerId: selected }
          : { type: "CANCEL_TRADE", playerId: currentTrade.fromPlayerId, tradeId: currentTrade.id });
      }, Math.max(0, (localTradeDeadlines[trade.id] ?? Date.now() + 15_000) - Date.now()));
      tradeResponseTimersRef.current.set(deadlineKey, timer);
    });
  }, [events, humanPlayerId, matchMenuOpen, networkRoomId, replayIndex, state.trades]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!keyboardShortcutsEnabled) return;
      if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (matchMenuOpen || replayIndex !== null || state.phase.type === "GAME_OVER" || !isHumanActive) return;
      if (event.key === "Escape" && pendingSetupVertex) {
        event.preventDefault();
        cancelPendingSetupPlacement();
        return;
      }
      if (event.key.toLowerCase() === "r" && canRoll) {
        event.preventDefault();
        roll();
      }
      if (event.key.toLowerCase() === "e" && canEndTurn) {
        event.preventDefault();
        endTurn();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canEndTurn, canRoll, isHumanActive, keyboardShortcutsEnabled, matchMenuOpen, pendingSetupVertex, replayIndex, state.phase.type]);

  useEffect(() => {
    if (state.phase.type !== "SETUP_PLACEMENT" || activePlayer !== humanPlayerId) {
      setPendingSetupVertex(null);
    }
  }, [activePlayer, humanPlayerId, state.phase.type]);

  const loadReplay = () => {
    clearAutomationTimers();
    const played = playBotGame("web-replay", 220);
    const log = { config: createDemoConfig("web-replay"), board: createFixedBoard(), events: played.events };
    const replayed = replay(log);
    setState(replayed);
    setServerViewer(null);
    setEvents(played.events);
    setReplayLog(log);
    setReplayIndex(played.events.length);
  };

  const stepReplay = (direction: -1 | 1) => {
    if (!replayLog) return;
    const nextIndex = Math.max(0, Math.min(events.length, (replayIndex ?? events.length) + direction));
    const replayed = replay({ ...replayLog, events: replayLog.events.slice(0, nextIndex) });
    setState(replayed);
    setServerViewer(null);
    setReplayIndex(nextIndex);
    track("replay_step", { mode: "replay", platform: platform(), index: nextIndex });
  };

  const loadHistory = async () => {
    try {
      setHistoryStatus("Loading history...");
      const matches = await createNetworkClient().listMatches();
      setHistoryMatches(matches);
      setHistoryStatus(matches.length > 0 ? `${matches.length} matches` : "No persisted matches yet");
      track("match_history_loaded", { mode: "network", platform: platform(), count: matches.length });
    } catch (historyError) {
      setHistoryStatus("History unavailable");
      setError(historyError instanceof Error ? historyError.message : "History unavailable");
    }
  };

  const loadPersistedReplay = async (matchId: string) => {
    try {
      setHistoryStatus(`Loading ${matchId}...`);
      const log = await createNetworkClient().loadReplay(matchId, networkSession?.token);
      const replayed = replay(log);
      setState(replayed);
      setServerViewer(null);
      setEvents(log.events);
      setReplayLog(log);
      setReplayIndex(log.events.length);
      setHistoryStatus(`Loaded ${matchId}`);
      setError(null);
      track("persisted_replay_loaded", { mode: "network", platform: platform(), matchId, events: log.events.length });
    } catch (replayError) {
      setHistoryStatus("Replay unavailable");
      setError(replayError instanceof Error ? replayError.message : "Replay unavailable");
    }
  };

  if (matchMenuOpen) {
    return (
      <main className="app-shell start-app">
        <section className="start-screen" aria-label="Match setup">
          <div className="start-panel">
            <div className="start-brand">
              <h1>Colonizt</h1>
              <span>Match setup</span>
            </div>
            <div className="match-menu" role="group" aria-label="Choose match type">
              <button type="button" className="match-choice" onClick={startBotMatch}>
                <span className="match-art" aria-hidden="true">
                  <HouseSymbol />
                  <RoadSymbol />
                </span>
                <strong>Bot Match</strong>
                <span>Local table</span>
              </button>
              <button type="button" className="match-choice" onClick={startPlayerMatch}>
                <span className="match-art" aria-hidden="true">
                  <HouseSymbol city />
                  <RoadSymbol />
                </span>
                <strong>Player Match</strong>
                <span>4 player online room</span>
              </button>
            </div>
            <div className="match-options" aria-label="Game options">
              <div className="option-row">
                <span>Bot difficulty</span>
                <div className="difficulty-options" role="group" aria-label="Bot difficulty">
                  {(["easy", "medium", "hard"] as const).map((difficulty) => (
                    <button
                      key={difficulty}
                      type="button"
                      className={matchOptions.botDifficulty === difficulty ? "selected" : ""}
                      aria-pressed={matchOptions.botDifficulty === difficulty}
                      onClick={() => setBotDifficulty(difficulty)}
                    >
                      {difficulty}
                    </button>
                  ))}
                </div>
              </div>
              <label className="rule-toggle">
                <input
                  type="checkbox"
                  checked={matchOptions.rules.diceDoubles}
                  onChange={(event) => setRuleEnabled("diceDoubles", event.currentTarget.checked)}
                />
                <span>Dice doubles x2</span>
              </label>
              <label className="rule-toggle">
                <input
                  type="checkbox"
                  checked={matchOptions.rules.mapRandomized}
                  onChange={(event) => setRuleEnabled("mapRandomized", event.currentTarget.checked)}
                />
                <span>Randomized balanced map</span>
              </label>
              <label className="rule-toggle">
                <input
                  type="checkbox"
                  checked={matchOptions.rules.specialCardCostRandomized}
                  onChange={(event) => setRuleEnabled("specialCardCostRandomized", event.currentTarget.checked)}
                />
                <span>Random special card cost</span>
              </label>
              <label className="rule-toggle">
                <input
                  type="checkbox"
                  checked={matchOptions.rules.plight}
                  onChange={(event) => setRuleEnabled("plight", event.currentTarget.checked)}
                />
                <span>Plight on turn 20</span>
              </label>
            </div>
            {error ? <p className="start-error">{error}</p> : null}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="game-surface" aria-label="Game board and actions">
        <header className="topbar">
          <div className="brand-block">
            <h1>Colonizt</h1>
            <p>
              Turn {state.turn + 1} · <span className="phase-code">{state.phase.type.replaceAll("_", " ")}</span>
            </p>
          </div>
          <div className="topbar-actions">
            <button type="button" onClick={() => setMatchMenuOpen(true)}>New Match</button>
            <button type="button" onClick={startReadyGame}>Ready</button>
            <button type="button" onClick={loadReplay}>Replay</button>
            <button type="button" onClick={loadHistory}>History</button>
          </div>
        </header>

        <div className="board-layout">
          <div className="board-stage">
            <svg className="board" viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`} role="group" aria-label="Resource board" onClick={handleBoardClick}>
              <defs>
                <radialGradient id="oceanGlow" cx="50%" cy="44%" r="72%">
                  <stop offset="0%" stopColor="#59b6ca" />
                  <stop offset="58%" stopColor="#267fa1" />
                  <stop offset="100%" stopColor="#154f77" />
                </radialGradient>
                <linearGradient id="terrainTimber" x1="0" x2="1" y1="0" y2="1">
                  <stop offset="0%" stopColor="#73be5a" />
                  <stop offset="58%" stopColor="#3d984e" />
                  <stop offset="100%" stopColor="#26743a" />
                </linearGradient>
                <linearGradient id="terrainBrick" x1="0" x2="1" y1="0" y2="1">
                  <stop offset="0%" stopColor="#dc815f" />
                  <stop offset="62%" stopColor="#c95f49" />
                  <stop offset="100%" stopColor="#a84336" />
                </linearGradient>
                <linearGradient id="terrainGrain" x1="0" x2="1" y1="0" y2="1">
                  <stop offset="0%" stopColor="#f4d96c" />
                  <stop offset="60%" stopColor="#e8bd40" />
                  <stop offset="100%" stopColor="#c69223" />
                </linearGradient>
                <linearGradient id="terrainFiber" x1="0" x2="1" y1="0" y2="1">
                  <stop offset="0%" stopColor="#bddf6a" />
                  <stop offset="60%" stopColor="#88bd45" />
                  <stop offset="100%" stopColor="#679c38" />
                </linearGradient>
                <linearGradient id="terrainOre" x1="0" x2="1" y1="0" y2="1">
                  <stop offset="0%" stopColor="#d6e1dc" />
                  <stop offset="58%" stopColor="#a7bbb7" />
                  <stop offset="100%" stopColor="#7e9694" />
                </linearGradient>
                <linearGradient id="terrainDesert" x1="0" x2="1" y1="0" y2="1">
                  <stop offset="0%" stopColor="#ead899" />
                  <stop offset="62%" stopColor="#d3bc79" />
                  <stop offset="100%" stopColor="#b99c5e" />
                </linearGradient>
                <pattern id="textureTimber" width="0.32" height="0.32" patternUnits="userSpaceOnUse" patternTransform="rotate(28)">
                  <path d="M0 0.08h0.32M0 0.24h0.32" stroke="#1e6b37" strokeWidth="0.018" />
                </pattern>
                <pattern id="textureBrick" width="0.46" height="0.22" patternUnits="userSpaceOnUse">
                  <path d="M0 0.02h0.46M0 0.12h0.46M0.12 0.02v0.1M0.34 0.12v0.1" stroke="#8e372f" strokeWidth="0.018" />
                </pattern>
                <pattern id="textureGrain" width="0.26" height="0.38" patternUnits="userSpaceOnUse">
                  <path d="M0.13 0.04v0.3M0.13 0.15c-0.08 0.02-0.1 0.08-0.06 0.14M0.13 0.12c0.08 0.02 0.1 0.08 0.06 0.14" stroke="#9d731f" strokeWidth="0.018" fill="none" strokeLinecap="round" />
                </pattern>
                <pattern id="textureFiber" width="0.34" height="0.3" patternUnits="userSpaceOnUse">
                  <circle cx="0.08" cy="0.08" r="0.025" fill="#f6f1e4" />
                  <circle cx="0.24" cy="0.18" r="0.022" fill="#e9e1cf" />
                </pattern>
                <pattern id="textureOre" width="0.34" height="0.34" patternUnits="userSpaceOnUse">
                  <path d="M0.02 0.22 0.12 0.1 0.26 0.14 0.31 0.27 0.18 0.31Z" fill="#eef4f1" opacity="0.72" />
                  <path d="M0.12 0.1 0.19 0.21 0.31 0.27" stroke="#647476" strokeWidth="0.014" fill="none" />
                </pattern>
                <pattern id="textureDesert" width="0.42" height="0.22" patternUnits="userSpaceOnUse">
                  <path d="M0 0.16c0.1-0.08 0.19-0.08 0.31 0 0.04 0.03 0.07 0.03 0.11 0" stroke="#9a7c48" strokeWidth="0.014" fill="none" strokeLinecap="round" />
                </pattern>
                <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%">
                  <feDropShadow dx="0" dy="0.06" stdDeviation="0.05" floodColor="#0f2f3e" floodOpacity="0.32" />
                </filter>
              </defs>
              <rect className="ocean" x={bounds.minX} y={bounds.minY} width={bounds.width} height={bounds.height} />
              {Object.values(state.board.edges).filter((edge) => edge.adjacentHexes.length === 1).map((edge) => {
                const a = state.board.vertices[edge.vertices[0]]!;
                const b = state.board.vertices[edge.vertices[1]]!;
                return (
                  <g key={`shore-${edge.id}`} className="shore">
                    <line className="shore-shelf" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                    <line className="shore-foam" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                    <line className="shore-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                  </g>
                );
              })}
              {Object.values(state.board.hexes).map((hex) => {
                const points = state.board.adjacency.hexToVertices[hex.id]!.map((vertexId) => {
                  const vertex = state.board.vertices[vertexId]!;
                  return `${vertex.x},${vertex.y}`;
                }).join(" ");
                const center = state.board.adjacency.hexToVertices[hex.id]!.reduce((acc, vertexId) => {
                  const vertex = state.board.vertices[vertexId]!;
                  return { x: acc.x + vertex.x / 6, y: acc.y + vertex.y / 6 };
                }, { x: 0, y: 0 });
                return (
                  <g key={hex.id} filter="url(#softShadow)">
                    <polygon className="hex-bed" points={points} />
                    <polygon className={`hex hex-${hex.resource}`} points={points}>
                      <title>{terrainLabels[hex.resource]}</title>
                    </polygon>
                    <polygon className={`hex-texture texture-${hex.resource}`} points={points} />
                    <polygon className="hex-inner-shine" points={points} />
                    <BoardIcon terrain={hex.resource} x={center.x} y={center.y - (hex.token ? 0.14 : 0)} size={0.48} />
                    {hex.token ? (
                      <g className={`token token-${hex.token}`} transform={`translate(${center.x} ${center.y + 0.36})`}>
                        <circle r="0.2" />
                        <text y="0.07">{hex.token}</text>
                      </g>
                    ) : (
                      <text className="dead-tile-label" x={center.x} y={center.y + 0.36}>No yield</text>
                    )}
                  </g>
                );
              })}
              {Object.values(state.board.ports ?? {}).map((port) => {
                const a = state.board.vertices[port.vertexIds[0]]!;
                const b = state.board.vertices[port.vertexIds[1]]!;
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                const length = Math.hypot(mid.x, mid.y) || 1;
                const out = { x: mid.x / length, y: mid.y / length };
                const dock = { x: mid.x + out.x * 0.42, y: mid.y + out.y * 0.42 };
                const badge = { x: mid.x + out.x * 0.78, y: mid.y + out.y * 0.78 };
                const pierA = { x: a.x + out.x * 0.08, y: a.y + out.y * 0.08 };
                const pierB = { x: b.x + out.x * 0.08, y: b.y + out.y * 0.08 };
                const label = `${port.resource ? terrainLabels[port.resource] : "Generic"} ${port.ratio}:1 harbor. Build a settlement or city on either marked corner for this trade bonus.`;
                const owned = port.vertexIds.some((vertexId) => state.settlements[vertexId] === humanPlayerId);
                return (
                  <g key={port.id} className={`port ${owned ? "owned" : ""}`} role="img" aria-label={label}>
                    <circle className="port-vertex-marker" cx={a.x} cy={a.y} r="0.13" />
                    <circle className="port-vertex-marker" cx={b.x} cy={b.y} r="0.13" />
                    <path className="port-pier" d={`M ${pierA.x} ${pierA.y} L ${dock.x} ${dock.y} L ${pierB.x} ${pierB.y}`} />
                    <line className="port-badge-tether" x1={dock.x} y1={dock.y} x2={badge.x} y2={badge.y} />
                    <g className="port-badge" transform={`translate(${badge.x} ${badge.y})`}>
                      <circle r="0.24" />
                      {port.resource ? <BoardIcon terrain={port.resource} x={-0.03} y={-0.05} size={0.22} /> : <text className="port-anchor" y="-0.01">?</text>}
                      <text className="port-ratio" y="0.18">{port.ratio}:1</text>
                    </g>
                  </g>
                );
              })}
              {Object.values(state.board.edges).map((edge) => {
                const a = state.board.vertices[edge.vertices[0]]!;
                const b = state.board.vertices[edge.vertices[1]]!;
                const owner = state.roads[edge.id];
                const isLegalRoad = legalRoads.has(edge.id);
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const edgeLength = Math.hypot(dx, dy);
                const edgeAngle = Math.atan2(dy, dx) * (180 / Math.PI);
                const edgeMidX = (a.x + b.x) / 2;
                const edgeMidY = (a.y + b.y) / 2;
                return (
                  <g key={edge.id} className="edge-target">
                    <line
                      className={`edge ${selectedEdge === edge.id ? "selected" : ""}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      aria-hidden="true"
                    />
                    {owner ? (
                      <g
                        className={`road-piece ${selectedEdge === edge.id ? "selected" : ""}`}
                        style={{ color: state.players[owner]?.color ?? "#172033" }}
                        transform={`translate(${edgeMidX} ${edgeMidY}) rotate(${edgeAngle})`}
                        aria-hidden="true"
                      >
                        <rect x={-edgeLength * 0.38} y="-0.08" width={edgeLength * 0.76} height="0.16" rx="0.07" />
                        <path d={`M${-edgeLength * 0.26} -0.02 H${edgeLength * 0.26}`} />
                      </g>
                    ) : null}
                    {isLegalRoad && !owner ? (
                      <g
                        className="edge-build-control"
                        role="button"
                        aria-label={`Build road on edge ${edge.id}`}
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleEdge(edge.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          event.stopPropagation();
                          handleEdge(edge.id);
                        }}
                      >
                        <rect
                          className={`edge-build-target ${selectedEdge === edge.id ? "selected" : ""}`}
                          x={-edgeLength * 0.42}
                          y="-0.075"
                          width={edgeLength * 0.84}
                          height="0.15"
                          rx="0.07"
                          transform={`translate(${edgeMidX} ${edgeMidY}) rotate(${edgeAngle})`}
                          aria-hidden="true"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleEdge(edge.id);
                          }}
                        />
                      </g>
                    ) : null}
                  </g>
                );
              })}
              {Object.values(state.board.vertices).map((vertex) => {
                const building = state.buildings[vertex.id];
                const owner = building?.owner;
                const isLegalSettlement = legalSettlements.has(vertex.id);
                const isLegalCity = legalCities.has(vertex.id);
                const isLegalVertex = isLegalSettlement || isLegalCity;
                const isPendingSetup = state.phase.type === "SETUP_PLACEMENT" && pendingSetupVertex === vertex.id && !building;
                const visibleOwner = building?.owner ?? (isPendingSetup ? humanPlayerId : undefined);
                const visibleType = building?.type ?? "settlement";
                return (
                  <g
                    key={vertex.id}
                    className={`vertex-target ${isLegalVertex ? "legal-target" : ""}`}
                    role={isLegalVertex ? "button" : undefined}
                    aria-label={isLegalVertex ? `${isLegalCity ? "Upgrade city" : state.phase.type === "SETUP_PLACEMENT" ? "Place setup settlement" : "Build settlement"} at corner ${vertex.id}` : undefined}
                    tabIndex={isLegalVertex ? 0 : -1}
                    onClick={(event) => {
                      if (!isLegalVertex) return;
                      event.stopPropagation();
                      handleVertex(vertex.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      handleVertex(vertex.id);
                    }}
                  >
                    <rect
                      className="vertex-hit"
                      x={vertex.x - 0.22}
                      y={vertex.y - 0.22}
                      width={0.44}
                      height={0.44}
                      rx={0.1}
                      aria-hidden="true"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleVertex(vertex.id);
                      }}
                    />
                    {building || isPendingSetup ? (
                      <g
                        className={`building house-building ${visibleType === "city" ? "city" : ""} ${isLegalCity ? "legal" : ""} ${isPendingSetup ? "pending" : ""} ${selectedVertex === vertex.id ? "selected" : ""}`}
                        style={{ color: state.players[visibleOwner!]?.color ?? "#172033" }}
                        transform={`translate(${vertex.x} ${vertex.y})`}
                        role={isPendingSetup ? "img" : undefined}
                        aria-label={isPendingSetup ? `Pending setup settlement at corner ${vertex.id}` : undefined}
                      >
                        <BoardHousePiece city={visibleType === "city"} />
                      </g>
                    ) : (
                      <circle
                        className={`vertex ${owner ? "owned" : ""} ${isLegalSettlement || isLegalCity ? "legal" : ""} ${selectedVertex === vertex.id ? "selected" : ""}`}
                        style={owner ? { fill: state.players[owner]?.color ?? "#172033" } : undefined}
                        cx={vertex.x}
                        cy={vertex.y}
                        r={owner ? 0.13 : 0.08}
                      />
                    )}
                  </g>
                );
              })}
            </svg>

            <DicePanel
              roll={state.lastRoll}
              rolling={diceAnimating}
              canRoll={canRoll}
              onRoll={roll}
              timerLabel={state.phase.type === "WAITING_FOR_ROLL" ? turnTimerLabel : undefined}
              keyboardShortcutsEnabled={keyboardShortcutsEnabled}
            />

            <div className="action-dock" aria-live="polite">
              <span>{actionHint.title}</span>
              <strong>{actionHint.detail}</strong>
              {error ? <em>{error}</em> : null}
            </div>

            <div className="board-action-bar" aria-label="Turn actions">
              <button type="button" className={`board-action ${showTradePanel ? "selected" : ""}`} onClick={openTradePanel} disabled={!canOfferTrade && !activeStagedTrade} aria-label="Open trade">
                <TradeSymbol />
                <span>Trade</span>
              </button>
              <button type="button" className="board-action" onClick={buySpecialCard} disabled={!canBuySpecialCard} aria-label="Draw special card">
                <SpecialSymbol />
                <span>Special Card</span>
                <small>{resourceCount(specialCost)}</small>
              </button>
              <button
                type="button"
                className={`board-action ${buildMode === "road" || setupRoadActive ? "selected" : ""}`}
                onClick={() => chooseBuildMode("road")}
                disabled={state.phase.type === "SETUP_PLACEMENT" ? !setupRoadActive : state.phase.type !== "ACTION_PHASE" || !canBuildRoadAction}
                aria-label="Build road"
              >
                <RoadSymbol />
                <span>Road</span>
              </button>
              <button
                type="button"
                className={`board-action ${buildMode === "settlement" || setupSettlementActive ? "selected" : ""}`}
                onClick={() => chooseBuildMode("settlement")}
                disabled={state.phase.type === "SETUP_PLACEMENT" ? !setupSettlementActive : state.phase.type !== "ACTION_PHASE" || !canBuildSettlement}
                aria-label="Build settlement"
              >
                <HouseSymbol />
                <span>Settlement</span>
              </button>
              <button
                type="button"
                className={`board-action ${buildMode === "city" ? "selected" : ""}`}
                onClick={() => chooseBuildMode("city")}
                disabled={state.phase.type !== "ACTION_PHASE" || !canUpgradeCity}
                aria-label="Upgrade city"
              >
                <HouseSymbol city />
                <span>City</span>
              </button>
              <button
                type="button"
                className="board-action end-action"
                onClick={endTurn}
                disabled={!canEndTurn}
                aria-label={endTurnButtonLabel}
                aria-keyshortcuts={keyboardShortcutsEnabled && canEndTurn ? "E" : undefined}
              >
                <EndTurnSymbol waiting={isWaitingForHumanTurn} />
                <span>{endTurnButtonLabel}</span>
                {state.phase.type === "ACTION_PHASE" && turnTimerLabel ? <small>{formatTimer(turnSecondsRemaining ?? 0)}</small> : null}
              </button>
            </div>

            <div className="hand-rack" aria-label="Your resources">
              {resources.map((resource) => (
                <ResourceCard
                  key={resource}
                  resource={resource}
                  count={humanPlayer?.resources[resource] ?? 0}
                  onClick={() => openTradeFromResource(resource)}
                  buttonLabel={`Open trade with ${resourceLabels[resource]}`}
                  selected={tradeOffer[resource] > 0}
                />
              ))}
            </div>

            {showTradePanel ? (
              <div className="trade-panel trade-overlay" aria-label="Trade interface">
                <div className="panel-title">
                  <strong>{activeStagedTrade ? "Trade Responses" : "Trade"}</strong>
                  <span>
                    {activeStagedTrade
                      ? stagedTradeSeconds !== undefined ? `${formatTimer(stagedTradeSeconds)} left` : "waiting"
                      : selectedMaritimeTrade ? `${selectedMaritimeTrade.ratio}:1 bank ready` : bankOfferResource ? `${previewMaritimeRatio}:1 bank` : "select cards"}
                  </span>
                  <button type="button" className="icon-button" onClick={() => setTradeOpen(false)} aria-label="Close trade">x</button>
                </div>
                {activeStagedTrade ? (
                  <div className="staged-trade" role="dialog" aria-modal={activeStagedTrade.fromPlayerId === humanPlayerId} aria-label="Staged trade response overlay">
                    <div className="incoming-trade-bundles">
                      <TradeBundle bundle={activeStagedTrade.offered} />
                      <span>for</span>
                      <TradeBundle bundle={activeStagedTrade.requested} />
                    </div>
                    {activeStagedTrade.fromPlayerId === humanPlayerId ? (
                      <>
                        <div className="trade-response-list" aria-live="polite">
                          {stagedRecipientIds.map((playerId) => {
                            const response = activeStagedTrade.responses?.[playerId]?.status ?? "PENDING";
                            const canAfford = hasResources(state.players[playerId]?.resources ?? emptyResources(), activeStagedTrade.requested);
                            const canChoose = response === "WANTS_ACCEPT" && canAfford;
                            return (
                              <button
                                key={playerId}
                                type="button"
                                className={`trade-response-row ${selectedTradeResponder === playerId ? "selected" : ""}`}
                                onClick={() => setSelectedTradeResponder(playerId)}
                                disabled={!canChoose}
                              >
                                <span style={{ color: state.players[playerId]?.color }}>{state.players[playerId]?.name ?? playerId}</span>
                                <strong>{!canAfford ? "Cannot afford" : response === "WANTS_ACCEPT" ? "Wants to accept" : response === "REJECTED" ? "Rejected" : "Pending"}</strong>
                              </button>
                            );
                          })}
                        </div>
                        <div className="trade-actions">
                          <button type="button" onClick={() => cancelTrade(activeStagedTrade.id)}>Cancel</button>
                          <button
                            type="button"
                            onClick={() => selectedTradeResponder && finalizeTrade(activeStagedTrade.id, selectedTradeResponder)}
                            disabled={!selectedResponderCanFinalize}
                          >
                            Trade
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="incoming-trade">
                        <div>
                          <strong>{state.players[activeStagedTrade.fromPlayerId]?.name ?? activeStagedTrade.fromPlayerId} offers</strong>
                          <span>{activeStagedTrade.responses?.[humanPlayerId]?.status === "WANTS_ACCEPT" ? "Waiting for the offerer." : activeStagedTrade.responses?.[humanPlayerId]?.status === "REJECTED" ? "You rejected this offer." : "Choose your response."}</span>
                        </div>
                        <div className="incoming-trade-actions">
                          <button
                            type="button"
                            onClick={() => respondToTrade(activeStagedTrade.id, "WANTS_ACCEPT")}
                            disabled={!humanPlayer || !hasResources(humanPlayer.resources, activeStagedTrade.requested)}
                          >
                            Want to accept
                          </button>
                          <button type="button" onClick={() => respondToTrade(activeStagedTrade.id, "REJECTED")}>Reject</button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="trade-picker">
                      <span>Give</span>
                      <div className="trade-card-grid">
                        {resources.map((resource) => (
                          <TradeResourceButton
                            key={resource}
                            resource={resource}
                            owned={humanPlayer?.resources[resource] ?? 0}
                            selected={tradeOffer[resource]}
                            onIncrement={() => incrementTradeBundle("offer", resource)}
                            onDecrement={() => decrementTradeBundle("offer", resource)}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="trade-picker">
                      <span>Want</span>
                      <div className="trade-card-grid">
                        {resources.map((resource) => (
                          <TradeResourceButton
                            key={resource}
                            resource={resource}
                            owned={0}
                            selected={tradeRequest[resource]}
                            request
                            onIncrement={() => incrementTradeBundle("request", resource)}
                            onDecrement={() => decrementTradeBundle("request", resource)}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="trade-actions">
                      <button type="button" onClick={clearTrade} disabled={resourceCount(tradeOffer) + resourceCount(tradeRequest) === 0}>Clear</button>
                      <button type="button" onClick={bankTrade} disabled={!selectedMaritimeTrade}>Bank</button>
                      <button type="button" onClick={offerTrade} disabled={!canSubmitOfferTrade}>Offer</button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>

          <aside className="side-panel" aria-label="Players and controls">
            <div className="game-log-panel" aria-label="Gameplay log">
              <div className="panel-title">
                <strong>Gameplay Log</strong>
                <span>{events.length} events</span>
              </div>
              <ol>
                {events.slice(-18).map((event) => <EventLine key={event.seq} event={event} />)}
              </ol>
            </div>

            <div className="phase-card">
              <span className="eyebrow">{networkStatus}</span>
              <strong>{activeName ? `Active: ${activeName}` : "Game over"}</strong>
              <span>{state.lastRoll ? `${state.lastRoll.dice[0]} + ${state.lastRoll.dice[1]} = ${state.lastRoll.sum}` : "Dice have not rolled yet"}</span>
              {turnTimerLabel ? <span>{turnTimerLabel} remaining</span> : null}
              <span>Target {state.config.victoryPoints} VP · Longest Road {state.longestRoadOwner ? state.players[state.longestRoadOwner]?.name : "unclaimed"}</span>
              <span>Difficulty {state.config.botDifficulty ?? "medium"}{activeRules.length > 0 ? ` · ${activeRules.join(" · ")}` : ""}</span>
            </div>

            <div className="players">
              {viewer.players.map((player) => (
                <article key={player.id} className={`player ${player.id === activePlayer ? "active" : ""}`} style={{ borderColor: player.color }}>
                  <div className="player-heading">
                    <strong>{player.name}</strong>
                    <div className="player-stats" aria-label={`${player.score} victory points, ${player.resourceCount} cards, ${player.specialCards} special cards, longest road length ${player.longestRoadLength}`}>
                      <span>{player.score} VP</span>
                      <span>{player.resourceCount} cards</span>
                      <span>{player.specialCards} special</span>
                      <span>road {player.longestRoadLength}</span>
                    </div>
                  </div>
                  {player.hasLongestRoad ? <span className="badge">Longest Road</span> : null}
                  {player.resources ? (
                    <div className="mini-resources">
                      {resources.map((resource) => <ResourceCard key={resource} resource={resource} count={player.resources?.[resource] ?? 0} compact />)}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </aside>
        </div>
      </section>

      <section className="event-strip" aria-label="Replay and event log">
        <div className="replay-controls">
          <button type="button" onClick={() => stepReplay(-1)} disabled={replayIndex === null || replayIndex <= 0}>Back</button>
          <span>{replayIndex === null ? "Live" : `Replay ${replayIndex}/${events.length}`}</span>
          <button type="button" onClick={() => stepReplay(1)} disabled={replayIndex === null || replayIndex >= events.length}>Next</button>
        </div>
        <ol>
          {events.slice(-8).map((event) => <EventLine key={event.seq} event={event} />)}
        </ol>
        <div className="history-panel" aria-label="Match history">
          <span>{historyStatus}</span>
          {historyMatches.slice(0, 4).map((match) => (
            <button key={match.id} type="button" onClick={() => void loadPersistedReplay(match.id)}>
              {match.mode} · {match.eventCount} events
            </button>
          ))}
        </div>
      </section>
    </main>
  );
};
