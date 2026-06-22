import { resources, type GameEvent, type GameState, type Resource, type ResourceBundle, type Terrain } from "@colonizt/game-core";

export const resourceLabels: Record<Resource, string> = {
  timber: "Timber",
  brick: "Brick",
  grain: "Grain",
  fiber: "Fiber",
  ore: "Ore",
};

export const terrainLabels: Record<Terrain, string> = {
  ...resourceLabels,
  desert: "Desert",
};

export const formatCost = (cost: ResourceBundle): string => {
  const parts = resources
    .filter((resource) => cost[resource] > 0)
    .map((resource) => `${cost[resource]} ${resourceLabels[resource]}`);
  return parts.length > 0 ? parts.join(", ") : "no resources";
};

const dicePips: Record<number, number[]> = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
};

export const formatTimer = (seconds: number): string => {
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

export const BoardIcon = ({ terrain, x, y, size = 0.44 }: { terrain: Terrain; x: number; y: number; size?: number }) => (
  <g className={`board-icon board-icon-${terrain}`} transform={`translate(${x - size / 2} ${y - size / 2}) scale(${size / 100})`}>
    <TerrainSvg terrain={terrain} />
  </g>
);

export const ResourceIcon = ({ resource }: { resource: Resource }) => (
  <svg className={`resource-icon resource-icon-${resource}`} viewBox="0 0 100 100" aria-hidden="true">
    <ResourceSvg resource={resource} />
  </svg>
);

export const ResourceCard = ({
  resource,
  count,
  compact = false,
  onClick,
  buttonLabel,
  selected = false,
  selectedCount = 0,
  disabled = false,
}: {
  resource: Resource;
  count: number;
  compact?: boolean;
  onClick?: () => void;
  buttonLabel?: string;
  selected?: boolean;
  selectedCount?: number;
  disabled?: boolean;
}) => {
  const className = `resource-card resource-card-${resource} ${compact ? "compact" : ""} ${onClick ? "resource-card-button" : ""} ${selected ? "selected" : ""}`;
  const content = (
    <>
      <ResourceIcon resource={resource} />
      <span className="resource-count">{count}</span>
      <small className="resource-name">{resourceLabels[resource]}</small>
      {selectedCount > 0 ? <span className="resource-selected-count">x{selectedCount}</span> : null}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} disabled={disabled} aria-label={buttonLabel ?? `${resourceLabels[resource]}: ${count}`}>
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

export const TradeBundle = ({ bundle }: { bundle: Partial<ResourceBundle> }) => (
  <div className="trade-bundle">
    {resources.filter((resource) => (bundle[resource] ?? 0) > 0).map((resource) => (
      <ResourceCard key={resource} resource={resource} count={bundle[resource] ?? 0} compact />
    ))}
  </div>
);

export const TradeResourceButton = ({
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

export const DicePanel = ({
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

export const HouseSymbol = ({ city = false }: { city?: boolean }) => (
  <svg className={`piece-symbol house-symbol ${city ? "city-symbol" : ""}`} viewBox="0 0 100 100" aria-hidden="true">
    <path className="house-roof" d="M14 47 50 17l36 30-8 9-28-23-28 23-8-9Z" />
    <path className="house-body" d="M24 48h52v34H24z" />
    <path className="house-door" d="M43 60h14v22H43z" />
    {city ? <path className="house-tower" d="M62 36h22v46H62z" /> : null}
  </svg>
);

export const RoadSymbol = () => (
  <svg className="piece-symbol road-symbol" viewBox="0 0 100 100" aria-hidden="true">
    <rect className="road-bed" x="12" y="38" width="76" height="24" rx="12" />
    <path className="road-shine" d="M24 45h52" />
  </svg>
);

export const TradeSymbol = () => (
  <svg className="action-symbol" viewBox="0 0 100 100" aria-hidden="true">
    <rect className="symbol-card card-a" x="14" y="18" width="34" height="48" rx="7" />
    <rect className="symbol-card card-b" x="52" y="34" width="34" height="48" rx="7" />
    <path className="symbol-stroke" d="M54 20h21l-7-7m7 7-7 7M46 80H25l7 7m-7-7 7-7" />
  </svg>
);

export const SpecialSymbol = () => (
  <svg className="action-symbol" viewBox="0 0 100 100" aria-hidden="true">
    <rect className="symbol-card special-card" x="24" y="14" width="52" height="72" rx="9" />
    <path className="symbol-star" d="m50 27 7 14 16 2-12 11 3 16-14-8-14 8 3-16-12-11 16-2 7-14Z" />
  </svg>
);

export const EndTurnSymbol = ({ waiting = false }: { waiting?: boolean }) => (
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

export const BoardHousePiece = ({ city = false }: { city?: boolean }) => (
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


export const EventLine = ({ event }: { event: GameEvent }) => {
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
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} drew {event.cardType ? event.cardType.toLowerCase().replaceAll("_", " ") : `special card #${event.cardIndex}`}</span><CostIcons bundle={event.cost} /></li>;
  }
  if (event.type === "DISCARD_REQUIRED") {
    return <li><span className="event-seq">{event.seq}</span><span>Discard required after 7</span></li>;
  }
  if (event.type === "RESOURCES_DISCARDED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} {event.forced ? "auto-discarded" : "discarded"}</span><CostIcons bundle={event.resources} /></li>;
  }
  if (event.type === "THIEF_MOVED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} moved the robber{event.stealFromPlayerId ? ` and stole from ${event.stealFromPlayerId}` : ""}</span></li>;
  }
  if (event.type === "DEVELOPMENT_CARD_PLAYED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} played {event.cardType.toLowerCase().replaceAll("_", " ")}</span></li>;
  }
  if (event.type === "ROAD_BUILDING_PLAYED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} used Road Building</span></li>;
  }
  if (event.type === "MONOPOLY_PLAYED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} monopolized {event.resource}</span></li>;
  }
  if (event.type === "YEAR_OF_PLENTY_PLAYED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId} took Year of Plenty</span></li>;
  }
  if (event.type === "LARGEST_ARMY_UPDATED") {
    return <li><span className="event-seq">{event.seq}</span><span>{event.playerId ? `${event.playerId} claimed Largest Army (${event.knightCount})` : "Largest Army unclaimed"}</span></li>;
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
    return <li><span className="event-seq">{event.seq}</span><span>{event.winnerId} won{event.reason === "TURN_LIMIT" ? " by adjudication" : " the game"}</span></li>;
  }
  return <li><span className="event-seq">{event.seq}</span><span>{event.type.replaceAll("_", " ").toLowerCase()}</span></li>;
};
