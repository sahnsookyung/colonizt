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
  randomizedDiscard,
  resources,
  type EdgeId,
  type BotDifficulty,
  type DevelopmentCard,
  type GameConfig,
  type GameCommand,
  type GameEvent,
  type GameState,
  type MapPreset,
  type PlayerId,
  type Resource,
  type ResourceBundle,
  type ViewerState,
  type VertexId,
  type HexId,
} from "@colonizt/game-core";
import { createDemoGame } from "@colonizt/demo-state";
import type { PublicRoomPayload } from "@colonizt/protocol";
import { platform, track } from "./analytics.js";
import {
  BoardHousePiece,
  BoardIcon,
  BotSymbol,
  DicePanel,
  EndTurnSymbol,
  EventLine,
  HouseSymbol,
  HumanSymbol,
  ResourceCard,
  ResourceIcon,
  RobberSymbol,
  RoadSymbol,
  SpecialSymbol,
  TradeSymbol,
  formatCost,
  formatTimer,
  resourceLabels,
  terrainLabels,
} from "./components/game-ui.js";
import { HandRack, type DevelopmentCardGroupView } from "./components/hand-rack.js";
import { LobbyScreen, type LobbySettingsInput } from "./components/lobby-screen.js";
import { PlayerStatsList } from "./components/player-stats-list.js";
import { MatchAnalysis, victoryPointAria, victoryPointText, type GameOverTab } from "./components/match-analysis.js";
import { SpecialCardOverlays } from "./components/special-card-overlays.js";
import { TradeOverlay } from "./components/trade-overlay.js";
import { AccessibleDialog } from "./components/accessible-dialog.js";
import { useLocalAutomation } from "./hooks/useLocalAutomation.js";
import { useNetworkRoom } from "./hooks/useNetworkRoom.js";
import { useReplayController } from "./hooks/useReplayController.js";
import { useSyncedRef } from "./hooks/useSyncedRef.js";
import { useTradeDraft } from "./hooks/useTradeDraft.js";
import { turnDeadlineKey, useTurnTimer } from "./hooks/useTurnTimer.js";
import { developmentCardTypes } from "./game-analysis.js";
import {
  activeRuleLabels,
  displayPlayersForViewer,
  selectMaritimeTradeDraft,
  selectYearOfPlentyDraft,
  visiblePlayerResourceCount as selectVisiblePlayerResourceCount,
  visibleStealTargets as selectVisibleStealTargets,
} from "./game-view-model.js";
import { boardBounds, firstStealTarget, roadBuildingCandidateEdgesFor } from "./board-interactions.js";
import { defaultMatchOptions, mapPresetLabels, onlineRoomCapacityText, toPlayerCount, type MatchOptions } from "./match-options.js";
import { createNetworkClient } from "./network.js";
import { networkErrorMessage } from "./network-errors.js";
import { canSubmitDiscardDraft, incrementDiscardDraft } from "./discard-policy.js";
import { buildUnavailableReason, selectActionHint, type BuildMode } from "./game-guidance.js";
import { clearResumeState, readResumeState, writeResumeState } from "./resume.js";
import { playSound, playSoundForEvents } from "./sounds.js";
import { normalizeTradeDraft, type TradeDraft } from "./trade-draft.js";
import { applyEventsToViewerProjection, projectViewerToGameState } from "./viewer-projection.js";

const diceAnimationMs = 820;
const rollDeadlineMs = 60_000;
const actionDeadlineMs = 240_000;

type AppScreen = "setup" | "localGame" | "onlineLobby" | "onlineGame";
type SpecialBoardMode =
  | { type: "roadBuilding"; cardId: string }
  | { type: "knight"; cardId: string }
  | { type: "monopoly"; cardId: string }
  | { type: "yearOfPlenty"; cardId: string };

const developmentCardLabels: Record<DevelopmentCard["type"], string> = {
  KNIGHT: "Knight",
  ROAD_BUILDING: "Road Building",
  MONOPOLY: "Monopoly",
  YEAR_OF_PLENTY: "Year of Plenty",
  VICTORY_POINT: "Victory Point",
};

const developmentCardShortLabels: Record<DevelopmentCard["type"], string> = {
  KNIGHT: "Knight",
  ROAD_BUILDING: "Roads",
  MONOPOLY: "Monopoly",
  YEAR_OF_PLENTY: "Plenty",
  VICTORY_POINT: "+1 VP",
};


const bundlesEqual = (left: ResourceBundle, right: ResourceBundle): boolean =>
  resources.every((resource) => left[resource] === right[resource]);

const bundleSummary = (bundle: Partial<ResourceBundle>): string =>
  resources
    .filter((resource) => (bundle[resource] ?? 0) > 0)
    .map((resource) => `${bundle[resource]} ${resourceLabels[resource]}`)
    .join(", ");

const issueCommand = (state: GameState, command: GameCommand): { state: GameState; events: GameEvent[]; error?: string } => {
  const result = applyCommand(state, command);
  if (!result.ok) return { state, events: [], error: result.error.message };
  return { state: result.value.nextState, events: result.value.events };
};

export { networkErrorMessage } from "./network-errors.js";

export const App = () => {
  const [liveState, setLiveState] = useState<GameState>(() => createDemoGame("web-local"));
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [serverViewer, setServerViewer] = useState<ViewerState | null>(null);
  const [appScreen, setAppScreen] = useState<AppScreen>("setup");
  const [selectedEdge, setSelectedEdge] = useState<EdgeId | null>(null);
  const [selectedVertex, setSelectedVertex] = useState<VertexId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [playerDisplayName, setPlayerDisplayName] = useState("Player");
  const [networkRoom, setNetworkRoom] = useState<PublicRoomPayload | null>(null);
  const [lobbyPending, setLobbyPending] = useState({ ready: false, settings: false, start: false, name: false });
  const [networkSocketOpen, setNetworkSocketOpen] = useState(false);
  const [showMatchDetails, setShowMatchDetails] = useState(false);
  const { tradeOffer, setTradeOffer, tradeRequest, setTradeRequest, tradeOpen, setTradeOpen, setTradeDraft, clearTradeDraft } = useTradeDraft();
  const [selectedTradeResponder, setSelectedTradeResponder] = useState<PlayerId | null>(null);
  const [localTradeDeadlines, setLocalTradeDeadlines] = useState<Record<string, number>>({});
  const [buildMode, setBuildMode] = useState<BuildMode>("road");
  const [discardDraft, setDiscardDraft] = useState<ResourceBundle>(() => emptyResources());
  const [roadBuildingDraft, setRoadBuildingDraft] = useState<{ cardId: string; edgeIds: EdgeId[] }>(() => ({ cardId: "", edgeIds: [] }));
  const [specialBoardMode, setSpecialBoardMode] = useState<SpecialBoardMode | null>(null);
  const [robberTargetHexId, setRobberTargetHexId] = useState<HexId | null>(null);
  const [yearOfPlentyDraft, setYearOfPlentyDraft] = useState<[Resource, Resource]>(["grain", "ore"]);
  const [gameOverTab, setGameOverTab] = useState<GameOverTab>("overview");
  const [matchOptions, setMatchOptions] = useState<MatchOptions>(defaultMatchOptions);
  const [pendingSetupVertex, setPendingSetupVertex] = useState<VertexId | null>(null);
  const [diceAnimating, setDiceAnimating] = useState(false);
  const {
    networkStatus,
    setNetworkStatus,
    networkSession,
    setNetworkSession,
    networkRoomId,
    setNetworkRoomId,
    networkRoomInfo,
    setNetworkRoomInfo,
    reconnectRetryAt,
    pendingCommandCount,
    socketRef,
    shouldReconnectRef,
    clientSeqRef,
    lastServerSeqRef,
    resetReconnectState,
    scheduleReconnect,
    retryReconnectNow,
    markCommandPending,
    clearPendingCommands,
  } = useNetworkRoom();
  const replayController = useReplayController();
  const matchMenuOpen = appScreen === "setup";
  const isPlayableScreen = appScreen === "localGame" || appScreen === "onlineGame";
  const { log: replayLog, index: replayIndex, isReplaying, state: replayState } = replayController;
  const state = replayState ?? liveState;
  const visibleEvents = isReplaying ? replayController.visibleEvents : events;
  const stateRef = useSyncedRef(liveState);
  const eventsRef = useSyncedRef(events);
  const networkRoomInfoRef = useSyncedRef(networkRoomInfo);
  const initialOnlineConnectRef = useRef(false);
  const networkGenerationRef = useRef(0);
  const hydratedFinishedReplayRef = useRef<string | null>(null);
  const soundCursorRef = useRef<{ matchId: string; seq: number; initialized: boolean }>({ matchId: liveState.config.matchId, seq: 0, initialized: false });

  const humanPlayerId = networkSession?.userId ?? "p1";
  const liveViewer = serverViewer ?? serializeForViewer(liveState, humanPlayerId);
  const viewer = replayState ? serializeForViewer(replayState, humanPlayerId) : liveViewer;
  const botPlayerIds = useMemo(() => {
    const ids = new Set<PlayerId>();
    for (const seat of networkRoom?.seats ?? []) {
      if (seat.botId) ids.add(seat.botId);
    }
    if (appScreen === "localGame") {
      for (const playerId of state.config.playerOrder) {
        if (playerId !== humanPlayerId) ids.add(playerId);
      }
    }
    return ids;
  }, [appScreen, humanPlayerId, networkRoom?.seats, state.config.playerOrder]);
  const legal = getLegalActions(state, humanPlayerId);
  const setupVertices = new Set(legal.find((action) => action.type === "PLACE_SETUP")?.vertices ?? []);
  const setupRoadEdges = pendingSetupVertex && state.phase.type === "SETUP_PLACEMENT"
    ? (state.board.adjacency.vertexToEdges[pendingSetupVertex] ?? []).filter((edgeId) => canBuildRoad(state, humanPlayerId, edgeId, pendingSetupVertex))
    : [];
  const actionRoadEdges = legal.find((action) => action.type === "BUILD_ROAD")?.edges ?? [];
  const bounds = useMemo(() => boardBounds(state), [state.board]);
  const activePlayer = "activePlayerId" in state.phase ? state.phase.activePlayerId : undefined;
  const activeName = activePlayer ? state.players[activePlayer]?.name ?? activePlayer : undefined;
  const humanPlayer = state.players[humanPlayerId];
  const maritimeAction = legal.find((action) => action.type === "MARITIME_TRADE");
  const maritimeTrades = maritimeAction?.type === "MARITIME_TRADE" ? maritimeAction.trades : [];
  const { previewMaritimeRatio, bankOfferResource, bankRequestResource, selectedMaritimeTrade } = selectMaritimeTradeDraft(
    state,
    humanPlayerId,
    tradeOffer,
    tradeRequest,
    maritimeTrades,
  );
  const latestRollEvent = [...visibleEvents].reverse().find((event) => event.type === "DICE_ROLLED");
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
  const specialCostLabel = bundleSummary(specialCost) || "free";
  const canBuySpecialCard = legal.some((action) => action.type === "BUY_SPECIAL_CARD");
  const discardAction = legal.find((action) => action.type === "DISCARD_RESOURCES");
  const moveThiefAction = legal.find((action) => action.type === "MOVE_THIEF");
  const playKnightAction = legal.find((action) => action.type === "PLAY_KNIGHT");
  const playRoadBuildingAction = legal.find((action) => action.type === "PLAY_ROAD_BUILDING");
  const playMonopolyAction = legal.find((action) => action.type === "PLAY_MONOPOLY");
  const playYearOfPlentyAction = legal.find((action) => action.type === "PLAY_YEAR_OF_PLENTY");
  const settlementVerticesAvailable = legal.find((action) => action.type === "BUILD_SETTLEMENT")?.vertices ?? [];
  const cityVerticesAvailable = legal.find((action) => action.type === "UPGRADE_CITY")?.vertices ?? [];
  const yearOfPlentyResources = playYearOfPlentyAction?.type === "PLAY_YEAR_OF_PLENTY" ? playYearOfPlentyAction.resources : [];
  const {
    firstOptions: yearOfPlentyFirstOptions,
    secondOptions: yearOfPlentySecondOptions,
    selected: selectedYearOfPlentyDraft,
    canTake: canTakeYearOfPlenty,
  } = selectYearOfPlentyDraft(state, yearOfPlentyResources, yearOfPlentyDraft);
  const roadBuildingOptions = playRoadBuildingAction?.type === "PLAY_ROAD_BUILDING" ? playRoadBuildingAction.options : [];
  const roadBuildingRequiredCount = playRoadBuildingAction?.type === "PLAY_ROAD_BUILDING" ? playRoadBuildingAction.requiredRoadCount : 0;
  const activeRoadBuildingCardId = specialBoardMode?.type === "roadBuilding"
    && playRoadBuildingAction?.type === "PLAY_ROAD_BUILDING"
    && playRoadBuildingAction.cardIds.includes(specialBoardMode.cardId)
    ? specialBoardMode.cardId
    : undefined;
  const roadBuildingSelectedEdges = activeRoadBuildingCardId && roadBuildingDraft.cardId === activeRoadBuildingCardId ? roadBuildingDraft.edgeIds : [];
  const roadBuildingCandidateEdges = activeRoadBuildingCardId
    ? roadBuildingCandidateEdgesFor(roadBuildingOptions, roadBuildingSelectedEdges, roadBuildingRequiredCount)
    : [];
  const activeKnightCardId = specialBoardMode?.type === "knight"
    && playKnightAction?.type === "PLAY_KNIGHT"
    && playKnightAction.cardIds.includes(specialBoardMode.cardId)
    ? specialBoardMode.cardId
    : undefined;
  const activeMonopolyCardId = specialBoardMode?.type === "monopoly"
    && playMonopolyAction?.type === "PLAY_MONOPOLY"
    && playMonopolyAction.cardIds.includes(specialBoardMode.cardId)
    ? specialBoardMode.cardId
    : undefined;
  const activeYearOfPlentyCardId = specialBoardMode?.type === "yearOfPlenty"
    && playYearOfPlentyAction?.type === "PLAY_YEAR_OF_PLENTY"
    && playYearOfPlentyAction.cardIds.includes(specialBoardMode.cardId)
    ? specialBoardMode.cardId
    : undefined;
  const visiblePlayerResourceCount = (playerId: PlayerId): number =>
    selectVisiblePlayerResourceCount(state, viewer, playerId);
  const visibleStealTargets = (hexId: HexId): PlayerId[] =>
    selectVisibleStealTargets(state, viewer, humanPlayerId, hexId);
  const legalThiefHexes = new Set([
    ...(moveThiefAction?.type === "MOVE_THIEF" ? moveThiefAction.hexes : []),
    ...(activeKnightCardId && playKnightAction?.type === "PLAY_KNIGHT" ? playKnightAction.hexes : []),
  ]);
  const selectedRobberHex = robberTargetHexId && legalThiefHexes.has(robberTargetHexId) ? state.board.hexes[robberTargetHexId] : undefined;
  const selectedRobberTargets = selectedRobberHex ? visibleStealTargets(selectedRobberHex.id) : [];
  const legalRoads = new Set(state.phase.type === "SETUP_PLACEMENT" ? setupRoadEdges : activeRoadBuildingCardId ? roadBuildingCandidateEdges : buildMode === "road" ? actionRoadEdges : []);
  const legalSettlements = new Set([
    ...(state.phase.type === "SETUP_PLACEMENT" && !pendingSetupVertex ? [...setupVertices] : []),
    ...(state.phase.type === "ACTION_PHASE" && buildMode === "settlement" ? settlementVerticesAvailable : []),
  ]);
  const legalCities = new Set(state.phase.type === "ACTION_PHASE" && buildMode === "city" ? cityVerticesAvailable : []);
  const ownDevelopmentCards = humanPlayer?.developmentCards ?? [];
  const canSubmitDiscard = canSubmitDiscardDraft(
    humanPlayer?.resources,
    discardDraft,
    discardAction?.type === "DISCARD_RESOURCES" ? discardAction.count : undefined,
  );
  const hasTradeOverlap = resources.some((resource) => tradeOffer[resource] > 0 && tradeRequest[resource] > 0);
  const canSubmitOfferTrade = canOfferTrade && resourceCount(tradeOffer) > 0 && resourceCount(tradeRequest) > 0 && !hasTradeOverlap && Boolean(humanPlayer && hasResources(humanPlayer.resources, tradeOffer));
  const keyboardShortcutsEnabled = platform() === "desktop";
  const activeRules = activeRuleLabels(state);
  const displayPlayers = useMemo(
    () => displayPlayersForViewer(state, viewer, humanPlayerId),
    [humanPlayerId, state, viewer],
  );
  const stagedTrades = Object.values(state.trades)
    .filter((trade) => trade.status === "COLLECTING_RESPONSES")
    .filter((trade) => trade.fromPlayerId === humanPlayerId || trade.recipients === "ANY" || trade.recipients.includes(humanPlayerId));
  const activeStagedTrade = stagedTrades[0];
  const stagedTradeDeadline = activeStagedTrade
    ? (viewer.tradeResponseDeadlines?.[activeStagedTrade.id] ?? localTradeDeadlines[activeStagedTrade.id])
    : undefined;
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
    && (appScreen === "onlineGame" || hasResources(state.players[selectedTradeResponder]?.resources ?? emptyResources(), activeStagedTrade.requested))
    && hasResources(state.players[activeStagedTrade.fromPlayerId]?.resources ?? emptyResources(), activeStagedTrade.offered),
  );
  const showTradePanel = (tradeOpen && discardAction?.type !== "DISCARD_RESOURCES") || Boolean(activeStagedTrade);
  const canUpgradeCity = cityVerticesAvailable.length > 0;
  const canBuildSettlement = settlementVerticesAvailable.length > 0;
  const canBuildRoadAction = actionRoadEdges.length > 0;
  const actionBuildReason = (mode: BuildMode): string => buildUnavailableReason({
    state,
    mode,
    humanPlayerId,
    isHumanActive,
    ...(activeName ? { activeName } : {}),
  });
  const isWaitingForHumanTurn = state.phase.type !== "GAME_OVER" && !isHumanActive;
  const endTurnButtonLabel = isWaitingForHumanTurn ? "Waiting" : "End Turn";
  const setupSettlementActive = state.phase.type === "SETUP_PLACEMENT" && isHumanActive && !pendingSetupVertex;
  const setupRoadActive = state.phase.type === "SETUP_PLACEMENT" && isHumanActive && Boolean(pendingSetupVertex);
  const actionHint = selectActionHint({
    state,
    humanPlayerId,
    isHumanActive,
    ...(activeName ? { activeName } : {}),
    ...(discardAction?.type === "DISCARD_RESOURCES" ? { discardCount: discardAction.count } : {}),
    activeKnight: Boolean(activeKnightCardId),
    activeRoadBuilding: Boolean(activeRoadBuildingCardId),
    roadsRemaining: roadBuildingRequiredCount - roadBuildingSelectedEdges.length,
    activeMonopoly: Boolean(activeMonopolyCardId),
    activeYearOfPlenty: Boolean(activeYearOfPlentyCardId),
    ...(activeStagedTrade ? { stagedTradeRole: activeStagedTrade.fromPlayerId === humanPlayerId ? "offerer" as const : "recipient" as const } : {}),
    pendingSetup: Boolean(pendingSetupVertex),
    canBuild: canUpgradeCity || canBuildSettlement || canBuildRoadAction,
  });

  const bankRatiosForState = (targetState: GameState, playerId: PlayerId): Partial<Record<Resource, number>> =>
    Object.fromEntries(resources.map((resource) => [resource, maritimeTradeRatio(targetState, playerId, resource)])) as Partial<Record<Resource, number>>;

  const normalizeDraftForState = (targetState: GameState, offer = tradeOffer, request = tradeRequest): TradeDraft => {
    const player = targetState.players[humanPlayerId];
    return normalizeTradeDraft({ offer, request }, player?.resources ?? emptyResources(), bankRatiosForState(targetState, humanPlayerId));
  };

  useEffect(() => {
    if (state.phase.type !== "ACTION_PHASE") return;
    if (buildMode === "city" && !canUpgradeCity) {
      setSelectedVertex(null);
      setBuildMode(canBuildRoadAction ? "road" : canBuildSettlement ? "settlement" : "road");
    } else if (buildMode === "settlement" && !canBuildSettlement) {
      setSelectedVertex(null);
      setBuildMode(canBuildRoadAction ? "road" : canUpgradeCity ? "city" : "road");
    } else if (buildMode === "road" && !canBuildRoadAction) {
      setSelectedEdge(null);
    }
  }, [buildMode, canBuildRoadAction, canBuildSettlement, canUpgradeCity, state.phase.type]);

  const setBotDifficulty = (botDifficulty: BotDifficulty) => {
    setMatchOptions((current) => ({ ...current, botDifficulty }));
  };

  const setPlayerCount = (playerCount: 2 | 3 | 4) => {
    setMatchOptions((current) => ({ ...current, playerCount }));
  };

  const setRuleEnabled = (rule: "diceDoubles" | "plight" | "specialCardCostRandomized", enabled: boolean) => {
    setMatchOptions((current) => ({
      ...current,
      rules: {
        ...current.rules,
        [rule]: enabled,
      },
    }));
  };

  const setMapPreset = (mapPreset: MapPreset) => {
    setMatchOptions((current) => ({
      ...current,
      rules: {
        ...current.rules,
        mapPreset,
        mapRandomized: true,
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
      setLiveState(result.state);
    setServerViewer(null);
    const nextEvents = [...eventsRef.current, ...result.events];
    eventsRef.current = nextEvents;
    setEvents(nextEvents);
    setError(null);
    if (command.type === "DISCARD_RESOURCES") setDiscardDraft(emptyResources());
    if (command.type === "PLAY_ROAD_BUILDING" || command.type === "PLAY_KNIGHT" || command.type === "MOVE_THIEF") {
      setSpecialBoardMode(null);
      setRoadBuildingDraft({ cardId: "", edgeIds: [] });
      setRobberTargetHexId(null);
    }
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
    enabled: appScreen === "localGame" && !networkRoomId && !isReplaying,
    state: liveState,
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
    if (isReplaying) {
      setError("Exit replay before taking game actions");
      return;
    }
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN && networkRoomId) {
      createNetworkClient().sendCommand(socketRef.current, networkRoomId, clientSeqRef.current, command);
      markCommandPending();
      clientSeqRef.current += 1;
      if (networkSession) writeNetworkResume(networkSession, networkRoomId, networkRoomInfo?.code);
      if (command.type === "DISCARD_RESOURCES") setDiscardDraft(emptyResources());
      if (command.type === "PLAY_ROAD_BUILDING" || command.type === "PLAY_KNIGHT" || command.type === "MOVE_THIEF") {
        setSpecialBoardMode(null);
        setRoadBuildingDraft({ cardId: "", edgeIds: [] });
        setRobberTargetHexId(null);
      }
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

  const { nowMs, turnDeadline } = useTurnTimer({
    state: liveState,
    activePlayer,
    paused: !isPlayableScreen || isReplaying,
    networkRoomId,
    serverTimer: networkRoom?.timer ?? networkRoomInfo?.timer ?? null,
    rollDeadlineMs,
    actionDeadlineMs,
    onLocalTimeout: (key) => {
      const current = stateRef.current;
      const currentActive = "activePlayerId" in current.phase ? current.phase.activePlayerId : undefined;
      const currentKey = current.phase.type !== "GAME_OVER" && currentActive
        ? turnDeadlineKey(current, currentActive)
        : null;
      if (currentKey !== key || !currentActive) return;
      if (current.phase.type === "DISCARDING") {
        const count = current.phase.pending[currentActive] ?? 0;
        if (count > 0) commit({ type: "DISCARD_RESOURCES", playerId: currentActive, resources: randomizedDiscard(current, currentActive, count), forced: true });
        return;
      }
      if (currentActive !== humanPlayerId) return;
      if (current.phase.type === "MOVING_THIEF") {
        const hexId = getLegalActions(current, humanPlayerId).find((action) => action.type === "MOVE_THIEF")?.hexes[0] as HexId | undefined;
        if (hexId) {
          const stealFromPlayerId = firstStealTarget(current, humanPlayerId, hexId);
          commit({ type: "MOVE_THIEF", playerId: humanPlayerId, hexId, ...(stealFromPlayerId ? { stealFromPlayerId } : {}) });
        }
      } else if (current.phase.type === "WAITING_FOR_ROLL") {
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
    },
  });
  const stagedTradeSeconds = stagedTradeDeadline ? Math.max(0, Math.ceil((stagedTradeDeadline - nowMs) / 1000)) : undefined;
  const turnSecondsRemaining = turnDeadline ? Math.max(0, Math.ceil((turnDeadline.dueAt - nowMs) / 1000)) : undefined;
  const turnTimerLabel = turnDeadline && turnSecondsRemaining !== undefined
    ? `${turnDeadline.mode === "roll" ? "Roll" : turnDeadline.mode === "discard" ? "Discard" : turnDeadline.mode === "thief" ? "Robber" : "Action"} ${formatTimer(turnSecondsRemaining)}`
    : undefined;

  const cancelPendingSetupPlacement = () => {
    setPendingSetupVertex(null);
    setSelectedVertex(null);
    setSelectedEdge(null);
  };

  const handleBoardClick = () => {
    if (pendingSetupVertex) cancelPendingSetupPlacement();
    if (robberTargetHexId) setRobberTargetHexId(null);
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
    if (activeRoadBuildingCardId && (legalRoads.has(edgeId) || roadBuildingSelectedEdges.includes(edgeId))) {
      selectRoadBuildingEdge(activeRoadBuildingCardId, edgeId);
    } else if (state.phase.type === "SETUP_PLACEMENT" && pendingSetupVertex && legalRoads.has(edgeId)) {
      playSound("select");
      commit({ type: "PLACE_SETUP", playerId: humanPlayerId, vertexId: pendingSetupVertex, edgeId });
      setPendingSetupVertex(null);
    } else if (state.phase.type === "ACTION_PHASE" && buildMode === "road" && legalRoads.has(edgeId)) {
      playSound("select");
      commit({ type: "BUILD_ROAD", playerId: humanPlayerId, edgeId });
    }
  };

  const clearInviteUrl = () => {
    const url = new URL(window.location.href);
    const hadRoomParam = url.searchParams.has("room") || url.searchParams.has("roomId");
    url.searchParams.delete("room");
    url.searchParams.delete("roomId");
    if (hadRoomParam) window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const isNetworkGeneration = (generation: number): boolean => networkGenerationRef.current === generation;

  const writeNetworkResume = (
    session: { token: string; userId: PlayerId },
    roomId: string,
    roomCode?: string,
  ) => {
    writeResumeState({
      token: session.token,
      userId: session.userId,
      roomId,
      ...(roomCode ? { roomCode } : {}),
      clientSeq: clientSeqRef.current,
      lastSeq: lastServerSeqRef.current,
    });
  };

  const requestRoomLeave = () => {
    const roomRef = activeRoomRef();
    if (roomRef && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "LEAVE_ROOM", roomId: roomRef }));
    }
  };

  const resetNetworkSession = () => {
    networkGenerationRef.current += 1;
    shouldReconnectRef.current = false;
    resetReconnectState();
    clearPendingCommands();
    socketRef.current?.close();
    socketRef.current = null;
    setNetworkSession(null);
    setNetworkRoomId(null);
    setNetworkRoomInfo(null);
    setNetworkRoom(null);
    setLobbyPending({ ready: false, settings: false, start: false, name: false });
    setNetworkSocketOpen(false);
    clientSeqRef.current = 1;
    lastServerSeqRef.current = 0;
    clearResumeState();
  };

  const resetPlayUi = () => {
    replayController.exit();
    setServerViewer(null);
    setEvents([]);
    setPendingSetupVertex(null);
    setSelectedEdge(null);
    setSelectedVertex(null);
    setBuildMode("road");
    setTradeOffer(emptyResources());
    setTradeRequest(emptyResources());
    setTradeOpen(false);
    setSelectedTradeResponder(null);
    setLocalTradeDeadlines({});
    setDiscardDraft(emptyResources());
    setRoadBuildingDraft({ cardId: "", edgeIds: [] });
    setSpecialBoardMode(null);
    setRobberTargetHexId(null);
    setYearOfPlentyDraft(["grain", "ore"]);
    hydratedFinishedReplayRef.current = null;
    setError(null);
  };

  const returnToSetup = () => {
    clearAutomationTimers();
    requestRoomLeave();
    resetNetworkSession();
    clearInviteUrl();
    resetPlayUi();
    setNetworkStatus("Local game");
    setAppScreen("setup");
  };

  const startBotMatch = () => {
    resetNetworkSession();
    clearInviteUrl();
    clearAutomationTimers();
    const next = createDemoGame(`web-bot-${Date.now()}`, matchOptions);
    next.config.playerNames.p1 = "Player";
    next.players.p1!.name = "Player";
    setLiveState(next);
    resetPlayUi();
    setNetworkStatus("Bot match");
    setAppScreen("localGame");
    track("room_creation_completed", { mode: "local", platform: platform(), taps: 1 });
  };

  const currentConfigOptions = (): Partial<Pick<GameConfig, "botDifficulty" | "rules">> => ({
    botDifficulty: stateRef.current.config.botDifficulty ?? matchOptions.botDifficulty,
    rules: {
      ...matchOptions.rules,
      ...stateRef.current.config.rules,
    },
  });

  const activeRoomRef = (): string | undefined => networkRoom?.code ?? networkRoomInfo?.code ?? networkRoomId ?? undefined;

  const sendLobbySettings = (settings: LobbySettingsInput) => {
    const roomRef = activeRoomRef();
    if (!roomRef || socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("Online room is not connected yet");
      return;
    }
    setLobbyPending((current) => ({ ...current, settings: true }));
    socketRef.current.send(JSON.stringify({ type: "UPDATE_ROOM_SETTINGS", roomId: roomRef, settings }));
  };

  const sendLobbyReady = (ready: boolean) => {
    const roomRef = activeRoomRef();
    if (!roomRef || socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("Online room is not connected yet");
      return;
    }
    setLobbyPending((current) => ({ ...current, ready: true }));
    socketRef.current.send(JSON.stringify({ type: "READY", roomId: roomRef, ready }));
    setNetworkStatus(`${ready ? "Ready" : "Not ready"} in ${roomRef}`);
  };

  const sendLobbyStart = () => {
    const roomRef = activeRoomRef();
    if (!roomRef || socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("Online room is not connected yet");
      return;
    }
    setLobbyPending((current) => ({ ...current, start: true }));
    socketRef.current.send(JSON.stringify({ type: "START_ROOM", roomId: roomRef }));
    setNetworkStatus(`Starting ${roomRef}`);
  };

  const sendLobbyAddBot = () => {
    const roomRef = activeRoomRef();
    if (!roomRef || socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("Online room is not connected yet");
      return;
    }
    setLobbyPending((current) => ({ ...current, settings: true }));
    socketRef.current.send(JSON.stringify({ type: "ADD_BOT", roomId: roomRef }));
    setNetworkStatus(`Adding bot to ${roomRef}`);
  };

  const sendLobbyRemoveBot = (seatIndex: number) => {
    const roomRef = activeRoomRef();
    if (!roomRef || socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("Online room is not connected yet");
      return;
    }
    setLobbyPending((current) => ({ ...current, settings: true }));
    socketRef.current.send(JSON.stringify({ type: "REMOVE_BOT", roomId: roomRef, seatIndex }));
    setNetworkStatus(`Removing bot from ${roomRef}`);
  };

  const saveLobbyDisplayName = () => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("Online room is not connected yet");
      return;
    }
    const nextName = playerDisplayName.trim().slice(0, 40);
    if (!nextName) {
      setError("Name cannot be empty");
      return;
    }
    setPlayerDisplayName(nextName);
    setLobbyPending((current) => ({ ...current, name: true }));
    socketRef.current.send(JSON.stringify({ type: "UPDATE_DISPLAY_NAME", displayName: nextName }));
    setNetworkStatus("Name saved");
  };

  const startReplay = async () => {
    if (liveState.phase.type !== "GAME_OVER") return;
    try {
      const log = networkRoomId && networkSession
        ? await createNetworkClient().loadReplay(networkRoomInfo?.id ?? networkRoomId, networkSession.token)
        : { config: liveState.config, board: liveState.board, events };
      replayController.start(log);
      setNetworkStatus("Replay");
    } catch (input) {
      setError(networkErrorMessage(input));
    }
  };

  const exitReplay = () => {
    if (!replayLog) return;
    replayController.exit();
    setNetworkStatus(networkRoomId ? "Online game" : "Bot match");
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
  const startRoadBuilding = (cardId: string) => {
    playSound("select");
    setSpecialBoardMode({ type: "roadBuilding", cardId });
    setRoadBuildingDraft({ cardId, edgeIds: [] });
    setRobberTargetHexId(null);
    setBuildMode("road");
    setTradeOpen(false);
    setSelectedEdge(null);
  };
  const playRoadBuildingWithEdges = (cardId: string, selected: EdgeId[]) => {
    if (selected.length !== roadBuildingRequiredCount || !selected[0]) return;
    const legalSequence = roadBuildingOptions.some((option) =>
      option.length === selected.length && option.every((edgeId, index) => edgeId === selected[index]),
    );
    if (!legalSequence) return;
    const edgeIds = selected[1] ? [selected[0], selected[1]] as [EdgeId, EdgeId] : [selected[0]] as [EdgeId];
    playSound("select");
    commit({ type: "PLAY_ROAD_BUILDING", playerId: humanPlayerId, cardId, edgeIds });
    setRoadBuildingDraft({ cardId: "", edgeIds: [] });
    setSpecialBoardMode(null);
  };
  const selectRoadBuildingEdge = (cardId: string, edgeId: EdgeId) => {
    playSound("select");
    const activeEdges = roadBuildingDraft.cardId === cardId ? roadBuildingDraft.edgeIds : [];
    if (activeEdges.includes(edgeId)) {
      setRoadBuildingDraft({ cardId, edgeIds: activeEdges.filter((candidate) => candidate !== edgeId) });
      return;
    }
    if (!roadBuildingCandidateEdgesFor(roadBuildingOptions, activeEdges, roadBuildingRequiredCount).includes(edgeId)) return;
    const nextEdges = [...activeEdges, edgeId];
    if (nextEdges.length >= roadBuildingRequiredCount) {
      playRoadBuildingWithEdges(cardId, nextEdges);
      return;
    }
    setRoadBuildingDraft({ cardId, edgeIds: nextEdges });
  };
  const cancelSpecialCardMode = () => {
    playSound("select");
    setSpecialBoardMode(null);
    setRoadBuildingDraft({ cardId: "", edgeIds: [] });
    setRobberTargetHexId(null);
  };
  const incrementDiscard = (resource: Resource) => {
    setDiscardDraft((current) => {
      const next = incrementDiscardDraft(
        humanPlayer?.resources,
        current,
        discardAction?.type === "DISCARD_RESOURCES" ? discardAction.count : undefined,
        resource,
      );
      if (next !== current) playSound("select");
      return next;
    });
  };
  const submitDiscard = () => {
    if (!canSubmitDiscard) return;
    playSound("select");
    commit({ type: "DISCARD_RESOURCES", playerId: humanPlayerId, resources: discardDraft });
  };
  const clearDiscard = () => {
    playSound("select");
    setDiscardDraft(emptyResources());
  };
  const moveThief = (hexId: HexId, stealFromPlayerId?: PlayerId) => {
    playSound("select");
    setRobberTargetHexId(null);
    commit({ type: "MOVE_THIEF", playerId: humanPlayerId, hexId, ...(stealFromPlayerId ? { stealFromPlayerId } : {}) });
  };
  const playKnight = (cardId: string, hexId: HexId, stealFromPlayerId?: PlayerId) => {
    playSound("select");
    setRobberTargetHexId(null);
    commit({ type: "PLAY_KNIGHT", playerId: humanPlayerId, cardId, hexId, ...(stealFromPlayerId ? { stealFromPlayerId } : {}) });
  };
  const startKnightTargeting = (cardId: string) => {
    playSound("select");
    setSpecialBoardMode({ type: "knight", cardId });
    setRobberTargetHexId(null);
    setTradeOpen(false);
  };
  const startMonopolyChoice = (cardId: string) => {
    playSound("select");
    setSpecialBoardMode({ type: "monopoly", cardId });
    setRobberTargetHexId(null);
    setRoadBuildingDraft({ cardId: "", edgeIds: [] });
    setTradeOpen(false);
  };
  const startYearOfPlentyChoice = (cardId: string) => {
    playSound("select");
    setSpecialBoardMode({ type: "yearOfPlenty", cardId });
    setRobberTargetHexId(null);
    setRoadBuildingDraft({ cardId: "", edgeIds: [] });
    setTradeOpen(false);
  };
  const playMonopoly = (cardId: string, resource: Resource) => {
    playSound("select");
    commit({ type: "PLAY_MONOPOLY", playerId: humanPlayerId, cardId, resource });
    setSpecialBoardMode(null);
  };
  const playYearOfPlenty = (cardId: string, picked: [Resource, Resource]) => {
    playSound("select");
    commit({ type: "PLAY_YEAR_OF_PLENTY", playerId: humanPlayerId, cardId, resources: picked });
    setSpecialBoardMode(null);
  };
  const setYearOfPlentyResource = (index: 0 | 1, resource: Resource) => {
    setYearOfPlentyDraft((current) => index === 0 ? [resource, current[1]] : [current[0], resource]);
  };
  const handleHex = (hexId: HexId) => {
    if (!legalThiefHexes.has(hexId)) return;
    const targets = visibleStealTargets(hexId);
    if (targets.length > 0) {
      playSound("select");
      setRobberTargetHexId(hexId);
      return;
    }
    selectRobberTarget(hexId);
  };
  const selectRobberTarget = (hexId: HexId, stealFromPlayerId?: PlayerId) => {
    if (moveThiefAction?.type === "MOVE_THIEF" && moveThiefAction.hexes.includes(hexId)) {
      moveThief(hexId, stealFromPlayerId);
      return;
    }
    if (activeKnightCardId && playKnightAction?.type === "PLAY_KNIGHT" && playKnightAction.hexes.includes(hexId)) {
      playKnight(activeKnightCardId, hexId, stealFromPlayerId);
    }
  };
  const openTradePanel = () => {
    if (!canOfferTrade && !activeStagedTrade) return;
    playSound("select");
    setTradeOpen((current) => !current);
    track("trade_panel_opened", { mode: socketRef.current ? "network" : "local", platform: platform(), source: "action_button" });
  };
  const chooseBuildMode = (mode: BuildMode) => {
    if (state.phase.type !== "ACTION_PHASE" && !(mode === "road" && pendingSetupVertex)) return;
    playSound("select");
    setSpecialBoardMode(null);
    setRoadBuildingDraft({ cardId: "", edgeIds: [] });
    setRobberTargetHexId(null);
    setBuildMode(mode);
    setTradeOpen(false);
    if (mode !== "road") setSelectedEdge(null);
    if (mode !== "settlement" && mode !== "city") setSelectedVertex(null);
  };
  const isDevelopmentCardPlayable = (card: DevelopmentCard): boolean => {
    if (card.type === "VICTORY_POINT") return false;
    if (card.playedTurn || card.boughtTurn === state.turn || state.phase.type === "DISCARDING" || state.phase.type === "MOVING_THIEF") return false;
    if (card.type === "KNIGHT") return playKnightAction?.type === "PLAY_KNIGHT" && playKnightAction.cardIds.includes(card.id);
    if (card.type === "ROAD_BUILDING") return playRoadBuildingAction?.type === "PLAY_ROAD_BUILDING" && playRoadBuildingAction.cardIds.includes(card.id);
    if (card.type === "MONOPOLY") return playMonopolyAction?.type === "PLAY_MONOPOLY" && playMonopolyAction.cardIds.includes(card.id);
    return playYearOfPlentyAction?.type === "PLAY_YEAR_OF_PLENTY" && playYearOfPlentyAction.cardIds.includes(card.id);
  };
  const developmentCardStatus = (card: DevelopmentCard): string => {
    if (card.type === "VICTORY_POINT") return "Secret +1 VP";
    if (card.playedTurn) return "Played";
    if (card.boughtTurn === state.turn) return "New";
    return isDevelopmentCardPlayable(card) ? "Ready" : "Waiting";
  };
  const activeDevelopmentCardStatus = (card: DevelopmentCard): string => {
    if (activeKnightCardId === card.id) return "Choosing target";
    if (activeRoadBuildingCardId === card.id) return `${roadBuildingSelectedEdges.length}/${roadBuildingRequiredCount} roads`;
    if (activeMonopolyCardId === card.id) return "Choosing resource";
    if (activeYearOfPlentyCardId === card.id) return "Choosing resources";
    return developmentCardStatus(card);
  };
  const activateDevelopmentCard = (card: DevelopmentCard) => {
    if (isDevelopmentCardActive(card)) {
      cancelSpecialCardMode();
      return;
    }
    if (!isDevelopmentCardPlayable(card)) return;
    if (card.type === "KNIGHT") startKnightTargeting(card.id);
    else if (card.type === "ROAD_BUILDING") startRoadBuilding(card.id);
    else if (card.type === "MONOPOLY") startMonopolyChoice(card.id);
    else if (card.type === "YEAR_OF_PLENTY") startYearOfPlentyChoice(card.id);
  };
  const isDevelopmentCardActive = (card: DevelopmentCard): boolean =>
    activeKnightCardId === card.id
    || activeRoadBuildingCardId === card.id
    || activeMonopolyCardId === card.id
    || activeYearOfPlentyCardId === card.id;
  const groupedDevelopmentCards: DevelopmentCardGroupView[] = developmentCardTypes.flatMap((type) => {
    const cards = ownDevelopmentCards.filter((card) => card.type === type && !card.playedTurn);
    if (cards.length === 0) return [];
    const activeCard = cards.find(isDevelopmentCardActive);
    const playableCard = cards.find(isDevelopmentCardPlayable);
    const primary = activeCard ?? playableCard ?? cards[0]!;
    const active = isDevelopmentCardActive(primary);
    const status = activeDevelopmentCardStatus(primary);
    const labelPrefix = cards.length > 1 ? `${developmentCardLabels[type]} x${cards.length}` : developmentCardLabels[type];
    return [{
      type,
      cards,
      primary,
      active,
      playable: Boolean(playableCard),
      status,
      label: `${labelPrefix}: ${status}`,
      tooltip: `${labelPrefix}: ${developmentCardStatus(primary)}`,
      shortLabel: developmentCardShortLabels[type],
    }];
  });
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
      tooltip: canBuildRoadAction || setupRoadActive ? `Road: build on a glowing edge connected to your network. Cost: ${formatCost(roadCost())}.` : actionBuildReason("road") ?? `Road cost: ${formatCost(roadCost())}.`,
      selected: state.phase.type === "SETUP_PLACEMENT" ? setupRoadActive : state.phase.type === "ACTION_PHASE" && buildMode === "road" && canBuildRoadAction,
      disabled: state.phase.type === "SETUP_PLACEMENT" ? !setupRoadActive : state.phase.type !== "ACTION_PHASE" || !canBuildRoadAction,
      icon: <RoadSymbol />,
    },
    {
      mode: "settlement",
      label: "Settlement",
      ariaLabel: "Build settlement",
      tooltip: canBuildSettlement || setupSettlementActive ? `Settlement: build a house on a glowing corner at least two edges away from other houses. Cost: ${formatCost(settlementCost())}.` : actionBuildReason("settlement") ?? `Settlement cost: ${formatCost(settlementCost())}.`,
      selected: state.phase.type === "SETUP_PLACEMENT" ? setupSettlementActive : state.phase.type === "ACTION_PHASE" && buildMode === "settlement" && canBuildSettlement,
      disabled: state.phase.type === "SETUP_PLACEMENT" ? !setupSettlementActive : state.phase.type !== "ACTION_PHASE" || !canBuildSettlement,
      icon: <HouseSymbol />,
    },
    {
      mode: "city",
      label: "City",
      ariaLabel: "Upgrade city",
      tooltip: canUpgradeCity ? `City: upgrade one of your settlements for another point and double production. Cost: ${formatCost(cityCost())}.` : actionBuildReason("city") ?? `City cost: ${formatCost(cityCost())}.`,
      selected: state.phase.type === "ACTION_PHASE" && buildMode === "city" && canUpgradeCity,
      disabled: state.phase.type !== "ACTION_PHASE" || !canUpgradeCity,
      icon: <HouseSymbol city />,
    },
  ];
  const openTradeFromResource = (resource: Resource) => {
    if (!canOfferTrade) return;
    setTradeOpen(true);
    playSound("select");
    const owned = humanPlayer?.resources[resource] ?? 0;
    if (owned <= tradeOffer[resource]) return;
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

  const hydrateFinishedReplayEvents = async (
    roomRef: string | undefined,
    session: { token: string },
    generation: number,
  ): Promise<void> => {
    if (!roomRef || hydratedFinishedReplayRef.current === roomRef) return;
    hydratedFinishedReplayRef.current = roomRef;
    try {
      const log = await createNetworkClient().loadReplay(roomRef, session.token);
      if (!isNetworkGeneration(generation)) return;
      setEvents(log.events);
      replayController.replaceIfActive(log);
    } catch {
      if (hydratedFinishedReplayRef.current === roomRef) hydratedFinishedReplayRef.current = null;
    }
  };

  const connectOnlineSession = (session: { token: string; userId: PlayerId }, roomId: string, ready: boolean, generation = networkGenerationRef.current) => {
    if (!isNetworkGeneration(generation)) return;
    setNetworkSocketOpen(false);
    shouldReconnectRef.current = true;
    const client = createNetworkClient();
    void client.connect(session.token, {
      onOpen: (openSocket) => {
        if (!isNetworkGeneration(generation)) {
          openSocket.close();
          return;
        }
        resetReconnectState();
        socketRef.current = openSocket;
        setNetworkSocketOpen(true);
        openSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId }));
        if (ready) openSocket.send(JSON.stringify({ type: "READY", roomId, ready: true }));
      },
      onEvents: (incomingEvents, snapshot) => {
        if (!isNetworkGeneration(generation)) return;
        clearPendingCommands();
        const roomInfo = networkRoomInfoRef.current;
        const canonicalRoomId = roomInfo?.id ?? roomId;
        if (incomingEvents.length > 0) {
          const expectedSeq = lastServerSeqRef.current + 1;
          if (incomingEvents[0]!.seq !== expectedSeq && socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ type: "RESYNC", roomId, lastSeq: lastServerSeqRef.current }));
            return;
          }
          lastServerSeqRef.current = Math.max(lastServerSeqRef.current, ...incomingEvents.map((event) => event.seq));
          setEvents((current) => [...current, ...incomingEvents]);
          if (!snapshot) {
            setServerViewer((current) => current ? applyEventsToViewerProjection(current, incomingEvents, canonicalRoomId, current.viewerId, currentConfigOptions()) : null);
            setLiveState((current) => applyEvents(current, incomingEvents));
          }
          if (incomingEvents.some((event) => event.type === "GAME_OVER")) {
            void hydrateFinishedReplayEvents(canonicalRoomId, session, generation);
          }
        }
        if (snapshot) {
          const projectedState = projectViewerToGameState(snapshot, canonicalRoomId, currentConfigOptions());
          setLiveState(projectedState);
          setServerViewer(snapshot);
          lastServerSeqRef.current = Math.max(lastServerSeqRef.current, snapshot.eventSeq);
          if (incomingEvents.length === 0) setEvents([]);
          setAppScreen("onlineGame");
          if (projectedState.phase.type === "GAME_OVER") void hydrateFinishedReplayEvents(canonicalRoomId, session, generation);
        }
        writeNetworkResume(session, canonicalRoomId, roomInfo?.code ?? (roomId.startsWith("room_") ? undefined : roomId));
        setNetworkStatus(`Online ${roomInfo?.code ?? roomId}`);
      },
      onRoom: (incomingRoom) => {
        if (!isNetworkGeneration(generation)) return;
        const publicRoom = incomingRoom as PublicRoomPayload;
        setLobbyPending({ ready: false, settings: false, start: false, name: false });
        setNetworkRoom(publicRoom);
        if (publicRoom.settings) {
          setMatchOptions((current) => ({
            ...current,
            playerCount: toPlayerCount(publicRoom.settings?.maxPlayers, current.playerCount),
            botDifficulty: publicRoom.settings?.botDifficulty ?? current.botDifficulty,
            rules: {
              diceDoubles: publicRoom.settings?.rules?.diceDoubles ?? current.rules.diceDoubles,
              plight: publicRoom.settings?.rules?.plight ?? current.rules.plight,
              plightTurn: publicRoom.settings?.rules?.plightTurn ?? current.rules.plightTurn,
              mapRandomized: publicRoom.settings?.rules?.mapRandomized ?? current.rules.mapRandomized,
              mapPreset: publicRoom.settings?.rules?.mapPreset ?? current.rules.mapPreset,
              specialCardCostRandomized: publicRoom.settings?.rules?.specialCardCostRandomized ?? current.rules.specialCardCostRandomized,
            },
          }));
        }
        const ownPayloadSeat = publicRoom.seats?.find((seat) => seat.userId === session.userId);
        if (ownPayloadSeat?.displayName) setPlayerDisplayName(ownPayloadSeat.displayName);
        setEvents(publicRoom.events ?? []);
        const roomConfigOptions: Partial<Pick<GameConfig, "botDifficulty" | "rules">> = {
          botDifficulty: publicRoom.settings?.botDifficulty ?? currentConfigOptions().botDifficulty,
          rules: {
            ...currentConfigOptions().rules,
            ...publicRoom.settings?.rules,
          },
        };
        if (publicRoom.game) {
          const projectedState = projectViewerToGameState(publicRoom.game, publicRoom.id, roomConfigOptions);
          setLiveState(projectedState);
          setServerViewer(publicRoom.game);
          lastServerSeqRef.current = Math.max(lastServerSeqRef.current, publicRoom.game.eventSeq, ...(publicRoom.events ?? []).map((event) => event.seq));
          setAppScreen("onlineGame");
          if (projectedState.phase.type === "GAME_OVER") void hydrateFinishedReplayEvents(publicRoom.id, session, generation);
        } else {
          setServerViewer(null);
          lastServerSeqRef.current = 0;
          setAppScreen("onlineLobby");
        }
        setNetworkRoomId(publicRoom.id);
        setNetworkRoomInfo({
          id: publicRoom.id,
          ...(publicRoom.code ? { code: publicRoom.code } : {}),
          ...(publicRoom.inviteUrl ? { inviteUrl: publicRoom.inviteUrl } : {}),
          ...(publicRoom.timer ? { timer: publicRoom.timer } : {}),
        });
        writeNetworkResume(session, publicRoom.id, publicRoom.code);
        setNetworkStatus(`Online ${publicRoom.code ?? publicRoom.id} · ${publicRoom.status}`);
      },
      onError: (incomingError) => {
        if (!isNetworkGeneration(generation)) return;
        clearPendingCommands();
        setLobbyPending({ ready: false, settings: false, start: false, name: false });
        const code = typeof incomingError === "object" && incomingError && "code" in incomingError ? String((incomingError as { code?: unknown }).code) : "";
        if (code === "ROOM_EXPIRED" || code === "ROOM_ABANDONED" || code === "ROOM_CLOSED") {
          resetNetworkSession();
          setNetworkStatus("Room closed");
        }
        setError(networkErrorMessage(incomingError));
      },
      onAck: () => {
        if (isNetworkGeneration(generation)) clearPendingCommands();
      },
      onClose: () => {
        if (!isNetworkGeneration(generation)) return;
        setNetworkSocketOpen(false);
        if (!shouldReconnectRef.current) return;
        setNetworkStatus("Online connection closed");
        scheduleReconnect(() => connectOnlineSession(session, roomId, false, generation));
      },
    }).then((socket) => {
      if (!isNetworkGeneration(generation)) {
        socket.close();
        return;
      }
      socketRef.current = socket;
    }).catch((connectError) => {
      if (!isNetworkGeneration(generation)) return;
      setNetworkStatus("Online unavailable");
      setError(networkErrorMessage(connectError));
      if (shouldReconnectRef.current) {
        scheduleReconnect(() => connectOnlineSession(session, roomId, false, generation));
      }
    });
  };

  const retryOnlineNow = () => {
    if (!networkSession || !networkRoomId) return;
    retryReconnectNow(() => connectOnlineSession(networkSession, networkRoomId, false));
  };

  const startOnlineRoom = async () => {
    clearAutomationTimers();
    resetNetworkSession();
    const generation = networkGenerationRef.current;
    clearInviteUrl();
    resetPlayUi();
    try {
      setNetworkStatus("Creating online room...");
      const client = createNetworkClient();
      const session = await client.createSession(playerDisplayName.trim() || "Player");
      if (!isNetworkGeneration(generation)) return;
      const { playerCount, ...roomOptions } = matchOptions;
      const room = await client.createRoom(session.token, { ...roomOptions, mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: playerCount });
      if (!isNetworkGeneration(generation)) return;
      setNetworkSession({ token: session.token, userId: session.userId });
      setNetworkRoom(room);
      setNetworkRoomId(room.id);
      setNetworkRoomInfo({ id: room.id, ...(room.code ? { code: room.code } : {}), ...(room.inviteUrl ? { inviteUrl: room.inviteUrl } : {}) });
      setAppScreen(room.game ? "onlineGame" : "onlineLobby");
      clientSeqRef.current = 1;
      lastServerSeqRef.current = 0;
      writeNetworkResume({ token: session.token, userId: session.userId }, room.id, room.code);
      connectOnlineSession({ token: session.token, userId: session.userId }, room.code ?? room.id, false, generation);
      track("room_creation_completed", { mode: "network", platform: platform(), taps: 1 });
    } catch (onlineError) {
      if (!isNetworkGeneration(generation)) return;
      setNetworkStatus("Online unavailable");
      setError(networkErrorMessage(onlineError));
    }
  };

  const startPlayerMatch = () => {
    void startOnlineRoom();
  };

  const joinOnlineRoom = async (roomId: string) => {
    const roomRef = roomId.trim().toUpperCase();
    if (!roomRef) return;
    clearAutomationTimers();
    resetNetworkSession();
    const generation = networkGenerationRef.current;
    resetPlayUi();
    try {
      const client = createNetworkClient();
      setNetworkStatus("Looking up room...");
      const lookup = await client.getRoom(roomRef);
      if (!isNetworkGeneration(generation)) return;
      if (!lookup.ok) {
        resetNetworkSession();
        setAppScreen("setup");
        setNetworkStatus(networkErrorMessage(lookup));
        setError(networkErrorMessage(lookup));
        return;
      }
      setNetworkStatus("Joining online room...");
      const session = await client.createSession(playerDisplayName.trim() || "Player");
      if (!isNetworkGeneration(generation)) return;
      setNetworkSession({ token: session.token, userId: session.userId });
      setNetworkRoom(lookup.room);
      setNetworkRoomId(lookup.room.id);
      setNetworkRoomInfo({ id: lookup.room.id, ...(lookup.room.code ? { code: lookup.room.code } : {}), ...(lookup.room.inviteUrl ? { inviteUrl: lookup.room.inviteUrl } : {}) });
      setAppScreen(lookup.room.game ? "onlineGame" : "onlineLobby");
      clientSeqRef.current = 1;
      lastServerSeqRef.current = 0;
      writeNetworkResume({ token: session.token, userId: session.userId }, lookup.room.id, lookup.room.code);
      connectOnlineSession({ token: session.token, userId: session.userId }, lookup.room.code ?? lookup.room.id, false, generation);
      track("room_join_started", { mode: "network", platform: platform(), roomId: lookup.room.id });
    } catch (joinError) {
      if (!isNetworkGeneration(generation)) return;
      setNetworkStatus("Online unavailable");
      setError(networkErrorMessage(joinError));
    }
  };

  const cleanupOnlineSession = () => {
    networkGenerationRef.current += 1;
    shouldReconnectRef.current = false;
    resetReconnectState();
    socketRef.current?.close();
    setNetworkSocketOpen(false);
  };

  useEffect(() => {
    if (initialOnlineConnectRef.current) return undefined;
    initialOnlineConnectRef.current = true;
    const search = new URLSearchParams(window.location.search);
    const inviteRoomId = search.get("room") ?? search.get("roomId");
    const inviteRoomRef = inviteRoomId?.trim().toUpperCase();
    const saved = readResumeState();
    const resumable = saved && (!inviteRoomRef || saved.roomId === inviteRoomId || saved.roomCode?.toUpperCase() === inviteRoomRef) ? saved : undefined;
    if (!resumable) {
      if (inviteRoomId) {
        void joinOnlineRoom(inviteRoomId);
        return () => {
          initialOnlineConnectRef.current = false;
          cleanupOnlineSession();
        };
      }
      return undefined;
    }
    const generation = networkGenerationRef.current;
    setAppScreen("onlineLobby");
    clientSeqRef.current = resumable.clientSeq;
    lastServerSeqRef.current = resumable.lastSeq;
    setNetworkSession({ token: resumable.token, userId: resumable.userId });
    setNetworkRoomId(resumable.roomId);
    setNetworkRoomInfo({ id: resumable.roomId, ...(resumable.roomCode ? { code: resumable.roomCode } : {}) });
    setNetworkStatus("Resuming online room...");
    connectOnlineSession({ token: resumable.token, userId: resumable.userId }, resumable.roomCode ?? resumable.roomId, false, generation);
    return () => {
      initialOnlineConnectRef.current = false;
      cleanupOnlineSession();
    };
  }, []);

  useEffect(() => {
    const matchId = liveState.config.matchId;
    const maxSeq = events.reduce((current, event) => Math.max(current, event.seq), 0);
    const cursor = soundCursorRef.current;

    if (!isPlayableScreen) {
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
    playSoundForEvents(freshEvents, humanPlayerId);
    soundCursorRef.current = { matchId, seq: maxSeq, initialized: true };
  }, [events, humanPlayerId, isPlayableScreen, liveState.config.matchId]);

  useEffect(() => {
    const normalized = normalizeDraftForState(liveState);
    if (!bundlesEqual(normalized.offer, tradeOffer) || !bundlesEqual(normalized.request, tradeRequest)) {
      setTradeDraft(normalized);
    }
  }, [liveState.eventSeq, humanPlayerId]);

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
    if (state.phase.type !== "GAME_OVER" && gameOverTab !== "overview") setGameOverTab("overview");
  }, [gameOverTab, state.phase.type]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!keyboardShortcutsEnabled) return;
      if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (!isPlayableScreen || isReplaying || state.phase.type === "GAME_OVER" || !isHumanActive) return;
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
  }, [canEndTurn, canRoll, isHumanActive, isPlayableScreen, isReplaying, keyboardShortcutsEnabled, pendingSetupVertex, state.phase.type]);

  useEffect(() => {
    if (state.phase.type !== "SETUP_PLACEMENT" || activePlayer !== humanPlayerId) {
      setPendingSetupVertex(null);
    }
  }, [activePlayer, humanPlayerId, state.phase.type]);

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
                <span>{onlineRoomCapacityText(matchOptions.playerCount)}</span>
                <span className="match-cta">Host</span>
              </button>
            </div>
            <form
              className="room-code-join"
              aria-label="Join by room code"
              onSubmit={(event) => {
                event.preventDefault();
                void joinOnlineRoom(joinCode);
              }}
            >
              <label htmlFor="room-code-input">Room code</label>
              <input
                id="room-code-input"
                value={joinCode}
                onChange={(event) => setJoinCode(event.currentTarget.value.toUpperCase())}
                inputMode="text"
                autoComplete="off"
                maxLength={12}
                placeholder="ABC123"
              />
              <button type="submit" disabled={joinCode.trim().length === 0}>Join</button>
            </form>
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
              <div className="option-row">
                <span>Players</span>
                <div className="difficulty-options" role="group" aria-label="Players">
                  {([2, 3, 4] as const).map((playerCount) => (
                    <button
                      key={playerCount}
                      type="button"
                      className={matchOptions.playerCount === playerCount ? "selected" : ""}
                      aria-pressed={matchOptions.playerCount === playerCount}
                      onClick={() => setPlayerCount(playerCount)}
                    >
                      {playerCount}
                    </button>
                  ))}
                </div>
              </div>
              <div className="option-row">
                <span>Map</span>
                <div className="difficulty-options" role="group" aria-label="Map">
                  {(["standard", "islands", "continent"] as const).map((mapPreset) => (
                    <button
                      key={mapPreset}
                      type="button"
                      className={matchOptions.rules.mapPreset === mapPreset ? "selected" : ""}
                      aria-pressed={matchOptions.rules.mapPreset === mapPreset}
                      onClick={() => setMapPreset(mapPreset)}
                    >
                      {mapPresetLabels[mapPreset]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {error ? <p className="start-error">{error}</p> : null}
          </div>
        </section>
      </main>
    );
  }

  if (appScreen === "onlineLobby") {
    return (
      <LobbyScreen
        networkRoom={networkRoom}
        roomCodeFallback={networkRoomInfo?.code ?? networkRoomInfo?.id}
        canCopyInvite={Boolean(networkRoomInfo)}
        humanPlayerId={humanPlayerId}
        matchOptions={matchOptions}
        networkStatus={networkStatus}
        error={error}
        pendingCommandCount={pendingCommandCount}
        reconnectRetryAt={reconnectRetryAt}
        nowMs={nowMs}
        networkSocketOpen={networkSocketOpen}
        lobbyPending={lobbyPending}
        playerDisplayName={playerDisplayName}
        onPlayerDisplayNameChange={setPlayerDisplayName}
        onSaveDisplayName={saveLobbyDisplayName}
        onReturnToSetup={returnToSetup}
        onCopyInvite={copyInvite}
        onRetryNow={retryOnlineNow}
        onReady={sendLobbyReady}
        onStart={sendLobbyStart}
        onUpdateSettings={sendLobbySettings}
        onSetPlayerCount={setPlayerCount}
        onSetMapPreset={setMapPreset}
        onSetBotDifficulty={setBotDifficulty}
        onSetRuleEnabled={setRuleEnabled}
        onAddBot={sendLobbyAddBot}
        onRemoveBot={sendLobbyRemoveBot}
      />
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
            {networkRoomInfo ? (
              <div className="room-topbar-actions" aria-label="Room controls">
                <span>{networkRoomInfo.code ?? networkRoomInfo.id}</span>
                <button type="button" onClick={copyInvite}>Copy Invite</button>
                {reconnectRetryAt ? <button type="button" onClick={retryOnlineNow}>Retry</button> : null}
                <button type="button" onClick={returnToSetup}>Leave</button>
              </div>
            ) : null}
            {isReplaying && replayLog ? (
              <div className="replay-controls" aria-label="Replay controls">
                <button type="button" onClick={() => replayController.step(-1)} disabled={replayIndex === 0}>Prev</button>
                <span>{replayIndex ?? 0}/{replayLog.events.length}</span>
                <button type="button" onClick={() => replayController.step(1)} disabled={replayIndex === replayLog.events.length}>Next</button>
                <button type="button" onClick={exitReplay}>Live</button>
              </div>
            ) : state.phase.type === "GAME_OVER" ? (
              <button type="button" onClick={() => void startReplay()}>Replay</button>
            ) : null}
            <button type="button" onClick={returnToSetup}>New Match</button>
          </div>
        </header>

        <div className="board-layout">
          <div className="board-stage">
            {networkRoomInfo ? (
              <div className="room-hud-actions" aria-label="Room controls">
                <span>{networkRoomInfo.code ?? networkRoomInfo.id}</span>
                <button type="button" onClick={copyInvite}>Copy</button>
                {reconnectRetryAt ? <button type="button" onClick={retryOnlineNow}>Retry</button> : null}
                <button type="button" onClick={returnToSetup}>Leave</button>
              </div>
            ) : null}
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
                const thiefHere = state.thiefHexId === hex.id;
                const legalThiefDestination = legalThiefHexes.has(hex.id);
                const stealTargets = legalThiefDestination ? visibleStealTargets(hex.id) : [];
                const canSelectThiefDestination = legalThiefDestination && !thiefHere;
                const robberSelected = robberTargetHexId === hex.id;
                return (
                  <g
                    key={hex.id}
                    className={`${thiefHere ? "thief-hex" : ""} ${legalThiefDestination ? "legal-thief-hex" : ""} ${robberSelected ? "selected-thief-hex" : ""} ${stealTargets.length > 0 ? "has-steal-targets" : ""}`}
                    filter="url(#softShadow)"
                    role={canSelectThiefDestination ? "button" : undefined}
                    tabIndex={canSelectThiefDestination ? 0 : undefined}
                    aria-label={canSelectThiefDestination ? stealTargets.length > 0 ? `Select robber destination on ${terrainLabels[hex.resource]} hex with steal targets` : `Move robber to ${terrainLabels[hex.resource]} hex without stealing` : undefined}
                    onClick={(event) => {
                      if (!canSelectThiefDestination) return;
                      event.stopPropagation();
                      handleHex(hex.id);
                    }}
                    onKeyDown={(event) => {
                      if (!canSelectThiefDestination || (event.key !== "Enter" && event.key !== " ")) return;
                      event.preventDefault();
                      event.stopPropagation();
                      handleHex(hex.id);
                    }}
                  >
                    <polygon className="hex-bed" points={points} />
                    <polygon className={`hex hex-${hex.resource}`} points={points}>
                      <title>{terrainLabels[hex.resource]}</title>
                    </polygon>
                    <polygon className={`hex-texture texture-${hex.resource}`} points={points} />
                    <polygon className="hex-inner-shine" points={points} />
                    <BoardIcon terrain={hex.resource} x={center.x} y={center.y - (hex.token ? 0.14 : 0)} size={0.48} />
                    {legalThiefDestination ? (
                      <g className="legal-thief-target" transform={`translate(${center.x} ${center.y - 0.02})`} aria-hidden="true">
                        <circle r="0.25" />
                        <circle r="0.12" />
                        <path d="M-0.32 0h0.14M0.18 0h0.14M0 -0.32v0.14M0 0.18v0.14" />
                      </g>
                    ) : null}
                    {stealTargets.length > 0 ? (
                      <g className="robber-victim-count-badge" transform={`translate(${center.x} ${center.y - 0.54})`} aria-hidden="true">
                        <circle r="0.18" />
                        <text y="0.055">{stealTargets.length}</text>
                      </g>
                    ) : null}
                    {hex.token ? (
                      <g className={`token token-${hex.token}`} transform={`translate(${center.x} ${center.y + 0.36})`}>
                        <circle r="0.2" />
                        <text y="0.07">{hex.token}</text>
                      </g>
                    ) : (
                      <text className="dead-tile-label" x={center.x} y={center.y + 0.36}>No yield</text>
                    )}
                    {thiefHere ? (
                      <g className="thief-marker" transform={`translate(${center.x} ${center.y - 0.02})`} role="img" aria-label="Robber">
                        <circle className="robber-badge" r="0.28" />
                        <path className="robber-shoulders" d="M-0.23 0.27c0.04-0.16 0.13-0.24 0.23-0.24s0.19 0.08 0.23 0.24z" />
                        <circle className="robber-hood" r="0.2" />
                        <path className="robber-face-opening" d="M-0.12 -0.05c0.02-0.07 0.07-0.11 0.12-0.11s0.1 0.04 0.12 0.11c-0.02 0.08-0.07 0.12-0.12 0.12s-0.1-0.04-0.12-0.12z" />
                        <circle className="robber-eye" cx="-0.055" cy="-0.05" r="0.018" />
                        <circle className="robber-eye" cx="0.055" cy="-0.05" r="0.018" />
                        <path className="robber-mouth" d="M-0.05 0.09c0.03 0.02 0.07 0.02 0.1 0" />
                        <path className="robber-scarf" d="M-0.15 0.15h0.3" />
                      </g>
                    ) : null}
                    {canSelectThiefDestination ? <polygon className="thief-tile-hit-target" points={points} aria-hidden="true" /> : null}
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
                const roadBuildingPreview = activeRoadBuildingCardId && roadBuildingSelectedEdges.includes(edge.id);
                const displayedOwner = owner ?? (roadBuildingPreview ? humanPlayerId : undefined);
                const isLegalRoad = legalRoads.has(edge.id);
                const isSelectableRoad = isLegalRoad || Boolean(roadBuildingPreview);
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
                    {displayedOwner ? (
                      <g
                        className={`road-piece ${selectedEdge === edge.id ? "selected" : ""} ${roadBuildingPreview ? "preview" : ""}`}
                        style={{ color: state.players[displayedOwner]?.color ?? "#172033" }}
                        transform={`translate(${edgeMidX} ${edgeMidY}) rotate(${edgeAngle})`}
                        aria-hidden="true"
                      >
                        <rect x={-edgeLength * 0.38} y="-0.08" width={edgeLength * 0.76} height="0.16" rx="0.07" />
                        <path d={`M${-edgeLength * 0.26} -0.02 H${edgeLength * 0.26}`} />
                      </g>
                    ) : null}
                    {isSelectableRoad && !owner ? (
                      <g
                        className="edge-build-control"
                        role="button"
                        aria-label="Build road here"
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
                const settlementOwner = state.settlements[vertex.id];
                const building = state.buildings[vertex.id] ?? (settlementOwner ? { owner: settlementOwner, type: "settlement" as const } : undefined);
                const owner = building?.owner ?? settlementOwner;
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
                    tabIndex={isLegalVertex ? 0 : undefined}
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
              <button type="button" className={`board-action trade-action ${showTradePanel ? "selected" : ""}`} onClick={openTradePanel} disabled={!canOfferTrade && !activeStagedTrade} aria-label="Open trade">
                <TradeSymbol />
                <span>Trade</span>
              </button>
              <button
                type="button"
                className="board-action special-action"
                onClick={buySpecialCard}
                disabled={!canBuySpecialCard}
                aria-label={`Draw special card. Cost: ${specialCostLabel}`}
                title={`Special card cost: ${specialCostLabel}`}
                data-tooltip={`Special card cost: ${specialCostLabel}`}
              >
                <SpecialSymbol />
                <span>Special Card</span>
                <small>{resourceCount(specialCost)}</small>
                <span className="action-cost-icons" aria-hidden="true">
                  {resources.filter((resource) => specialCost[resource] > 0).map((resource) => (
                    <span key={resource}>
                      <ResourceIcon resource={resource} />
                      <b>{specialCost[resource]}</b>
                    </span>
                  ))}
                </span>
              </button>
              {constructionActions.map((action) => (
                <button
                  key={action.mode}
                  type="button"
                  className={`board-action ${action.mode}-action ${action.selected ? "selected" : ""}`}
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

            {discardAction?.type === "DISCARD_RESOURCES" ? (
              <AccessibleDialog className="phase-card discard-board-panel modal-control-card" label="Discard resources">
                <div className="panel-title">
                  <strong>Discard</strong>
                  <span>{resourceCount(discardDraft)}/{discardAction.count}{turnDeadline?.mode === "discard" && turnSecondsRemaining !== undefined ? ` · ${formatTimer(turnSecondsRemaining)}` : ""}</span>
                </div>
                <div className="discard-summary">
                  <span>Select cards from your hand.</span>
                  <button type="button" onClick={clearDiscard} disabled={resourceCount(discardDraft) === 0}>Clear</button>
                </div>
                <button type="button" className="primary-wide" onClick={submitDiscard} disabled={!canSubmitDiscard}>Discard</button>
              </AccessibleDialog>
            ) : null}

            <HandRack
              resourceHand={humanPlayer?.resources ?? emptyResources()}
              tradeOffer={tradeOffer}
              discardDraft={discardDraft}
              developmentCardGroups={groupedDevelopmentCards}
              onResourceTrade={openTradeFromResource}
              onDiscardResource={incrementDiscard}
              onDevelopmentCard={activateDevelopmentCard}
              {...(discardAction?.type === "DISCARD_RESOURCES" ? { discardCount: discardAction.count } : {})}
            />

            {selectedRobberHex ? (
              <AccessibleDialog className="robber-choice-overlay" label="Choose player to rob" onClose={() => setRobberTargetHexId(null)}>
                <div className="robber-choice-heading">
                  <div className="robber-large-symbol" aria-hidden="true">
                    <RobberSymbol />
                  </div>
                  <div>
                    <strong>Robber</strong>
                    <span>{terrainLabels[selectedRobberHex.resource]}</span>
                  </div>
                  <button type="button" className="icon-button" onClick={() => setRobberTargetHexId(null)} aria-label="Close robber chooser">x</button>
                </div>
                <div className="robber-victim-list">
                  {selectedRobberTargets.map((playerId) => {
                    const player = state.players[playerId];
                    const isBot = networkRoom?.seats?.some((seat) => seat.botId === playerId) ?? (appScreen === "localGame" && playerId !== humanPlayerId);
                    return (
                      <button
                        key={playerId}
                        type="button"
                        className="robber-victim-choice"
                        onClick={() => selectRobberTarget(selectedRobberHex.id, playerId)}
                        aria-label={`Steal from ${player?.name ?? playerId}`}
                      >
                        <span className="player-kind" style={{ color: player?.color ?? "#172033" }}>
                          {isBot ? <BotSymbol /> : <HumanSymbol />}
                        </span>
                        <strong>{player?.name ?? playerId}</strong>
                        <small>{visiblePlayerResourceCount(playerId)} cards</small>
                      </button>
                    );
                  })}
                </div>
              </AccessibleDialog>
            ) : null}

            <SpecialCardOverlays
              state={state}
              viewer={viewer}
              {...(activeMonopolyCardId ? { monopolyCardId: activeMonopolyCardId } : {})}
              {...(activeYearOfPlentyCardId ? { yearOfPlentyCardId: activeYearOfPlentyCardId } : {})}
              yearOfPlentyFirstOptions={yearOfPlentyFirstOptions}
              yearOfPlentySecondOptions={yearOfPlentySecondOptions}
              selectedYearOfPlenty={selectedYearOfPlentyDraft}
              canTakeYearOfPlenty={canTakeYearOfPlenty}
              onClose={() => setSpecialBoardMode(null)}
              onPlayMonopoly={playMonopoly}
              onSetYearOfPlenty={setYearOfPlentyResource}
              onPlayYearOfPlenty={playYearOfPlenty}
            />

            <TradeOverlay
              visible={showTradePanel}
              state={state}
              humanPlayerId={humanPlayerId}
              online={appScreen === "onlineGame"}
              {...(activeStagedTrade ? { activeTrade: activeStagedTrade } : {})}
              recipientIds={stagedRecipientIds}
              selectedResponder={selectedTradeResponder}
              selectedResponderCanFinalize={selectedResponderCanFinalize}
              {...(stagedTradeSeconds !== undefined ? { stagedTradeSeconds } : {})}
              {...(selectedMaritimeTrade ? { selectedMaritimeTrade } : {})}
              {...(bankOfferResource ? { bankOfferResource } : {})}
              previewMaritimeRatio={previewMaritimeRatio}
              tradeOffer={tradeOffer}
              tradeRequest={tradeRequest}
              canSubmitOfferTrade={canSubmitOfferTrade}
              onClose={() => setTradeOpen(false)}
              onSelectResponder={setSelectedTradeResponder}
              onCancel={cancelTrade}
              onFinalize={finalizeTrade}
              onRespond={respondToTrade}
              onIncrement={incrementTradeBundle}
              onDecrement={decrementTradeBundle}
              onClear={clearTrade}
              onBank={bankTrade}
              onOffer={offerTrade}
            />

            <MatchAnalysis
              state={state}
              players={displayPlayers}
              events={visibleEvents}
              botPlayerIds={botPlayerIds}
              tab={gameOverTab}
              onTabChange={setGameOverTab}
              onReplay={() => void startReplay()}
              onNewMatch={returnToSetup}
            />
          </div>

          <aside className="side-panel" aria-label="Match information and players">
            <div className="phase-card bank-panel" aria-label="Bank holdings">
              <div className="panel-title">
                <strong>Bank</strong>
                <span>{viewer.developmentDeckRemaining} dev</span>
              </div>
              <div className="bank-resource-row">
                {resources.map((resource) => (
                  <ResourceCard key={resource} resource={resource} count={viewer.resourceBank?.[resource] ?? 0} compact />
                ))}
              </div>
            </div>

            <div className="game-log-panel" aria-label="Gameplay log">
              <div className="panel-title">
                <strong>Gameplay Log</strong>
                <span>{visibleEvents.length} events</span>
              </div>
              <ol>
                {visibleEvents.slice(-18).map((event) => <EventLine key={event.seq} event={event} />)}
              </ol>
            </div>

            <div className={`phase-card match-status-card ${showMatchDetails ? "expanded" : ""}`}>
              <div className="match-status-summary">
                <div>
                  <span className="eyebrow">{networkStatus}</span>
                  <strong>{activeName ? `Active: ${activeName}` : "Game over"}</strong>
                  <span>{turnTimerLabel ? `${turnTimerLabel} remaining` : state.lastRoll ? `${state.lastRoll.dice[0]} + ${state.lastRoll.dice[1]} = ${state.lastRoll.sum}` : "No roll yet"}</span>
                </div>
                <button type="button" onClick={() => setShowMatchDetails((shown) => !shown)} aria-expanded={showMatchDetails} aria-controls="match-details">
                  {showMatchDetails ? "Hide" : "Details"}
                </button>
              </div>
              {networkRoomInfo ? (
                <div className="room-share">
                  <span>Room Code</span>
                  <strong>{networkRoomInfo.code ?? networkRoomInfo.id}</strong>
                  {pendingCommandCount > 0 ? <small>{pendingCommandCount} pending</small> : null}
                  {reconnectRetryAt ? <small>Retry {Math.max(0, Math.ceil((reconnectRetryAt - nowMs) / 1000))}s</small> : null}
                </div>
              ) : null}
              <div id="match-details" className="match-details" hidden={!showMatchDetails}>
                <span>{state.lastRoll ? `${state.lastRoll.dice[0]} + ${state.lastRoll.dice[1]} = ${state.lastRoll.sum}` : "Dice have not rolled yet"}</span>
                <span>Target {state.config.victoryPoints} VP · Longest Road {state.longestRoadOwner ? state.players[state.longestRoadOwner]?.name : "unclaimed"}</span>
                <span>Largest Army {state.largestArmyOwner ? state.players[state.largestArmyOwner]?.name : "unclaimed"} · Robber {state.thiefHexId ? terrainLabels[state.board.hexes[state.thiefHexId]?.resource ?? "desert"] : "unset"}</span>
                <span>Difficulty {state.config.botDifficulty ?? "medium"}{activeRules.length > 0 ? ` · ${activeRules.join(" · ")}` : ""}</span>
              </div>
            </div>

            <PlayerStatsList
              players={displayPlayers}
              botPlayerIds={botPlayerIds}
              victoryPointText={victoryPointText}
              victoryPointAria={victoryPointAria}
              {...(activePlayer ? { activePlayerId: activePlayer } : {})}
            />
          </aside>
        </div>
      </section>
    </main>
  );
};
