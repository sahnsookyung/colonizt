import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  applyCommand,
  applyEvents,
  canBuildRoad,
  emptyResources,
  getLegalActions,
  hasResources,
  cityCost,
  maritimeTradeRatio,
  resourceCount,
  roadCost,
  serializeForViewer,
  settlementCost,
  specialCardCost,
  resources,
  type EdgeId,
  type BotDifficulty,
  type GameConfig,
  type GameCommand,
  type GameEvent,
  type GameState,
  type PlayerId,
  type Resource,
  type ResourceBundle,
  type ViewerState,
  type VertexId,
} from "@colonizt/game-core";
import { completeSetup, createDemoGame } from "@colonizt/demo-state";
import { platform, track } from "./analytics.js";
import {
  BoardHousePiece,
  BoardIcon,
  DicePanel,
  EndTurnSymbol,
  EventLine,
  HouseSymbol,
  ResourceCard,
  RoadSymbol,
  SpecialSymbol,
  TradeBundle,
  TradeResourceButton,
  TradeSymbol,
  formatCost,
  formatTimer,
  resourceLabels,
  terrainLabels,
} from "./components/game-ui.js";
import { useLocalAutomation } from "./hooks/useLocalAutomation.js";
import { useSyncedRef } from "./hooks/useSyncedRef.js";
import { createNetworkClient, type MatchSummary } from "./network.js";
import { createDemoReplayLog, replayAtIndex, type ReplayLogState } from "./replay-state.js";
import { clearResumeState, readResumeState, writeResumeState } from "./resume.js";
import { playSound, playSoundForEvent } from "./sounds.js";
import { normalizeTradeDraft, type TradeDraft } from "./trade-draft.js";

const diceAnimationMs = 820;
const rollDeadlineMs = 60_000;
const actionDeadlineMs = 240_000;

type BuildMode = "road" | "settlement" | "city";

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

const bundlesEqual = (left: ResourceBundle, right: ResourceBundle): boolean =>
  resources.every((resource) => left[resource] === right[resource]);

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
  code?: string;
  inviteUrl?: string;
  status: string;
  settings?: {
    botDifficulty?: BotDifficulty;
    rules?: GameConfig["rules"];
  };
  events?: GameEvent[];
  game?: ViewerState;
}

interface NetworkRoomInfo {
  id: string;
  code?: string;
  inviteUrl?: string;
}

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
  const [buildMode, setBuildMode] = useState<BuildMode>("road");
  const [matchOptions, setMatchOptions] = useState<MatchOptions>(defaultMatchOptions);
  const [pendingSetupVertex, setPendingSetupVertex] = useState<VertexId | null>(null);
  const [diceAnimating, setDiceAnimating] = useState(false);
  const [turnDeadline, setTurnDeadline] = useState<{ key: string; dueAt: number; durationMs: number; mode: "roll" | "action" } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [networkStatus, setNetworkStatus] = useState("Local game");
  const [networkSession, setNetworkSession] = useState<{ token: string; userId: PlayerId } | null>(null);
  const [networkRoomId, setNetworkRoomId] = useState<string | null>(null);
  const [networkRoomInfo, setNetworkRoomInfo] = useState<NetworkRoomInfo | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(true);
  const clientSeqRef = useRef(1);
  const lastServerSeqRef = useRef(0);
  const stateRef = useSyncedRef(state);
  const eventsRef = useSyncedRef(events);
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

  const applyLocalCommandRef = useSyncedRef(applyLocalCommand);
  const { clearAutomationTimers } = useLocalAutomation({
    enabled: !networkRoomId && replayIndex === null && !matchMenuOpen,
    state,
    events,
    activePlayer,
    humanPlayerId,
    localTradeDeadlines,
    setLocalTradeDeadlines,
    stateRef,
    eventsRef,
    applyLocalCommandRef,
    postRollAnimationMs: diceAnimationMs,
  });

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
    setNetworkRoomInfo(null);
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
  const chooseBuildMode = (mode: BuildMode) => {
    if (state.phase.type !== "ACTION_PHASE" && !(mode === "road" && pendingSetupVertex)) return;
    playSound("select");
    setBuildMode(mode);
    setTradeOpen(false);
    if (mode !== "road") setSelectedEdge(null);
    if (mode !== "settlement" && mode !== "city") setSelectedVertex(null);
  };
  const constructionActions: Array<{
    mode: BuildMode;
    label: string;
    ariaLabel: string;
    tooltip: string;
    selected: boolean;
    disabled: boolean;
    icon: ReactNode;
  }> = [
    {
      mode: "road",
      label: "Road",
      ariaLabel: "Build road",
      tooltip: `Road: build on a glowing edge connected to your network. Cost: ${formatCost(roadCost())}.`,
      selected: buildMode === "road" || setupRoadActive,
      disabled: state.phase.type === "SETUP_PLACEMENT" ? !setupRoadActive : state.phase.type !== "ACTION_PHASE" || !canBuildRoadAction,
      icon: <RoadSymbol />,
    },
    {
      mode: "settlement",
      label: "Settlement",
      ariaLabel: "Build settlement",
      tooltip: `Settlement: build a house on a glowing corner at least two edges away from other houses. Cost: ${formatCost(settlementCost())}.`,
      selected: buildMode === "settlement" || setupSettlementActive,
      disabled: state.phase.type === "SETUP_PLACEMENT" ? !setupSettlementActive : state.phase.type !== "ACTION_PHASE" || !canBuildSettlement,
      icon: <HouseSymbol />,
    },
    {
      mode: "city",
      label: "City",
      ariaLabel: "Upgrade city",
      tooltip: `City: upgrade one of your settlements for another point and double production. Cost: ${formatCost(cityCost())}.`,
      selected: buildMode === "city",
      disabled: state.phase.type !== "ACTION_PHASE" || !canUpgradeCity,
      icon: <HouseSymbol city />,
    },
  ];
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
  const copyInvite = () => {
    if (!networkRoomInfo) return;
    const inviteUrl = networkRoomInfo.inviteUrl ?? `${window.location.origin}/?room=${encodeURIComponent(networkRoomInfo.code ?? networkRoomInfo.id)}`;
    void navigator.clipboard?.writeText(inviteUrl).then(() => {
      setNetworkStatus(`Copied invite ${networkRoomInfo.code ?? networkRoomInfo.id}`);
    }).catch(() => {
      setNetworkStatus(inviteUrl);
    });
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
        setNetworkRoomId(publicRoom.id);
        setNetworkRoomInfo({
          id: publicRoom.id,
          ...(publicRoom.code ? { code: publicRoom.code } : {}),
          ...(publicRoom.inviteUrl ? { inviteUrl: publicRoom.inviteUrl } : {}),
        });
        writeResumeState({ token: session.token, userId: session.userId, roomId: publicRoom.id, clientSeq: clientSeqRef.current, lastSeq: lastServerSeqRef.current });
        setNetworkStatus(`Online ${publicRoom.code ?? publicRoom.id} · ${publicRoom.status}`);
      },
      onError: (incomingError) => {
        const code = typeof incomingError === "object" && incomingError && "code" in incomingError ? String((incomingError as { code?: unknown }).code) : "";
        if (code === "ROOM_EXPIRED" || code === "ROOM_ABANDONED" || code === "ROOM_CLOSED") {
          resetNetworkSession();
          setNetworkStatus("Room closed");
        }
        setError(JSON.stringify(incomingError));
      },
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
      setNetworkRoomInfo({ id: room.id, ...(room.code ? { code: room.code } : {}), ...(room.inviteUrl ? { inviteUrl: room.inviteUrl } : {}) });
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
      setNetworkRoomInfo({ id: roomId });
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
    const search = new URLSearchParams(window.location.search);
    const inviteRoomId = search.get("room") ?? search.get("roomId");
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
    setNetworkRoomInfo({ id: resumable.roomId });
    setNetworkStatus("Resuming online room...");
    connectOnlineSession({ token: resumable.token, userId: resumable.userId }, resumable.roomId, false);
    return cleanupOnlineSession;
  }, []);

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
    const key = `${state.config.matchId}:${state.turn}:${state.phase.type}:${activePlayer}`;
    const dueAt = Date.now() + durationMs;
    setNowMs(Date.now());
    setTurnDeadline((current) => current?.key === key ? current : { key, dueAt, durationMs, mode: phaseMode });

    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    const timeout = setTimeout(() => {
      if (networkRoomId) return;
      const current = stateRef.current;
      const currentActive = "activePlayerId" in current.phase ? current.phase.activePlayerId : undefined;
      const currentKey = current.phase.type !== "GAME_OVER" && currentActive
        ? `${current.config.matchId}:${current.turn}:${current.phase.type}:${currentActive}`
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
  }, [activePlayer, humanPlayerId, matchMenuOpen, networkRoomId, replayIndex, state.config.matchId, state.phase.type, state.turn]);

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
    const log = createDemoReplayLog();
    const replayed = replayAtIndex(log, log.events.length);
    setState(replayed);
    setServerViewer(null);
    setEvents(log.events);
    setReplayLog(log);
    setReplayIndex(log.events.length);
  };

  const stepReplay = (direction: -1 | 1) => {
    if (!replayLog) return;
    const nextIndex = Math.max(0, Math.min(events.length, (replayIndex ?? events.length) + direction));
    const replayed = replayAtIndex(replayLog, nextIndex);
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
      const replayed = replayAtIndex(log, log.events.length);
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
                <span className="match-cta">Start</span>
              </button>
              <button type="button" className="match-choice" onClick={startPlayerMatch}>
                <span className="match-art" aria-hidden="true">
                  <HouseSymbol city />
                  <RoadSymbol />
                </span>
                <strong>Player Match</strong>
                <span>4 player online room</span>
                <span className="match-cta">Host</span>
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
              {constructionActions.map((action) => (
                <button
                  key={action.mode}
                  type="button"
                  className={`board-action ${action.selected ? "selected" : ""}`}
                  onClick={() => chooseBuildMode(action.mode)}
                  disabled={action.disabled}
                  aria-label={action.ariaLabel}
                  title={action.tooltip}
                  data-tooltip={action.tooltip}
                >
                  {action.icon}
                  <span>{action.label}</span>
                </button>
              ))}
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
              {networkRoomInfo ? (
                <div className="room-share">
                  <span>Room Code</span>
                  <strong>{networkRoomInfo.code ?? networkRoomInfo.id}</strong>
                  <button type="button" onClick={copyInvite}>Copy Invite</button>
                </div>
              ) : null}
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
                    <div className="player-mobile-stats" aria-hidden="true">
                      <span>{player.score} VP</span>
                      <span>{player.resourceCount}C</span>
                      <span>{player.specialCards}S</span>
                      <span>R{player.longestRoadLength}</span>
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
