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
import { GameBoard } from "./components/game-board.js";
import { SetupScreen } from "./components/setup-screen.js";
import { InviteShare } from "./components/invite-share.js";
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
import { firstStealTarget, roadBuildingCandidateEdgesFor } from "./board-interactions.js";
import { defaultMatchOptions, toPlayerCount, type MatchOptions } from "./match-options.js";
import { createNetworkClient } from "./network.js";
import { isTerminalOnlineError, networkErrorMessage } from "./network-errors.js";
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
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [playerDisplayName, setPlayerDisplayName] = useState("Player");
  const displayNameDraftRef = useRef<string | null>(null);
  const restoredCommandRef = useRef<GameCommand | undefined>(undefined);
  const commandErrorRef = useRef<string | null>(null);
  const [networkRoom, setNetworkRoom] = useState<PublicRoomPayload | null>(null);
  const [lobbyPending, setLobbyPending] = useState({ ready: false, settings: false, start: false, name: false });

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
    clientSeqRef,
    lastServerSeqRef,
    controller, connectionState, serverClockOffsetMs,
  } = useNetworkRoom();
  const networkSocketOpen = connectionState === "connected";
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
    ? (viewer.tradeResponseDeadlines?.[activeStagedTrade.id] !== undefined
      ? viewer.tradeResponseDeadlines[activeStagedTrade.id]! - serverClockOffsetMs
      : localTradeDeadlines[activeStagedTrade.id])
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
      setBuildMode(canBuildRoadAction ? "road" : canBuildSettlement ? "settlement" : "road");
    } else if (buildMode === "settlement" && !canBuildSettlement) {
      setBuildMode(canBuildRoadAction ? "road" : canUpgradeCity ? "city" : "road");
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
    if (command.type === "PLAY_MONOPOLY" || command.type === "PLAY_YEAR_OF_PLENTY" || command.type === "PLAY_ROAD_BUILDING" || command.type === "PLAY_KNIGHT" || command.type === "MOVE_THIEF") {
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
    if (networkRoomId) {
      if (!controller.send(command)) {
        setError(pendingCommandCount ? "Waiting for your previous action to be confirmed." : "Reconnecting to your table. Your action has not been sent.");
      } else {
        commandErrorRef.current = null;
        setError(null);
      }
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
    serverClockOffsetMs,
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
    ? `${turnDeadline.mode === "roll" ? "Roll" : turnDeadline.mode === "discard" ? "Discard" : turnDeadline.mode === "thief" ? "Robber" : turnDeadline.mode === "setup" ? "Setup" : "Action"} ${formatTimer(turnSecondsRemaining)}`
    : undefined;

  const cancelPendingSetupPlacement = () => {
    setPendingSetupVertex(null);
  };

  const handleBoardClick = () => {
    if (pendingSetupVertex) cancelPendingSetupPlacement();
    if (robberTargetHexId) setRobberTargetHexId(null);
  };

  const handleVertex = (vertexId: VertexId) => {
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
    if (activeRoadBuildingCardId && (legalRoads.has(edgeId) || roadBuildingSelectedEdges.includes(edgeId))) {
      selectRoadBuildingEdge(activeRoadBuildingCardId, edgeId);
    } else if (state.phase.type === "SETUP_PLACEMENT" && pendingSetupVertex && legalRoads.has(edgeId)) {
      playSound("select");
      commit({ type: "PLACE_SETUP", playerId: humanPlayerId, vertexId: pendingSetupVertex, edgeId });
      if (!networkRoomId) setPendingSetupVertex(null);
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
      ...(controller.pendingCommand ? { pendingCommand: controller.pendingCommand } : {}),
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
    displayNameDraftRef.current = null;
    restoredCommandRef.current = undefined;
    controller.stop();
    setNetworkSession(null);
    setNetworkRoomId(null);
    setNetworkRoomInfo(null);
    setNetworkRoom(null);
    setLobbyPending({ ready: false, settings: false, start: false, name: false });
    clientSeqRef.current = 1;
    lastServerSeqRef.current = 0;
    clearResumeState();
  };

  const resetPlayUi = () => {
    commandErrorRef.current = null;
    replayController.exit();
    setServerViewer(null);
    setEvents([]);
    setPendingSetupVertex(null);
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
    displayNameDraftRef.current = nextName;
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
    } catch (error_) {
      setError(networkErrorMessage(error_));
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
    if (appScreen !== "onlineGame") {
      setRoadBuildingDraft({ cardId: "", edgeIds: [] });
      setSpecialBoardMode(null);
    } else setRoadBuildingDraft({ cardId, edgeIds: selected });
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
    if (appScreen !== "onlineGame") setRobberTargetHexId(null);
    commit({ type: "MOVE_THIEF", playerId: humanPlayerId, hexId, ...(stealFromPlayerId ? { stealFromPlayerId } : {}) });
  };
  const playKnight = (cardId: string, hexId: HexId, stealFromPlayerId?: PlayerId) => {
    playSound("select");
    if (appScreen !== "onlineGame") setRobberTargetHexId(null);
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
    if (appScreen !== "onlineGame") setSpecialBoardMode(null);
  };
  const playYearOfPlenty = (cardId: string, picked: [Resource, Resource]) => {
    playSound("select");
    commit({ type: "PLAY_YEAR_OF_PLENTY", playerId: humanPlayerId, cardId, resources: picked });
    if (!networkRoomId) setSpecialBoardMode(null);
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
      tooltip: canBuildRoadAction || setupRoadActive ? `Road: build on a marked edge connected to your network. Cost: ${formatCost(roadCost())}.` : actionBuildReason("road") ?? `Road cost: ${formatCost(roadCost())}.`,
      selected: state.phase.type === "SETUP_PLACEMENT" ? setupRoadActive : state.phase.type === "ACTION_PHASE" && buildMode === "road" && canBuildRoadAction,
      disabled: state.phase.type === "SETUP_PLACEMENT" ? !setupRoadActive : state.phase.type !== "ACTION_PHASE" || !canBuildRoadAction,
      icon: <RoadSymbol />,
    },
    {
      mode: "settlement",
      label: "Settle",
      ariaLabel: "Build settlement",
      tooltip: canBuildSettlement || setupSettlementActive ? `Settlement: build a house on a marked corner at least two edges away from other houses. Cost: ${formatCost(settlementCost())}.` : actionBuildReason("settlement") ?? `Settlement cost: ${formatCost(settlementCost())}.`,
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
    if (!networkRoomId) setSelectedTradeResponder(null);
    track("trade_finalized", { mode: socketRef.current ? "network" : "local", platform: platform(), tradeId, toPlayerId });
  };
  const cancelTrade = (tradeId: string) => {
    playSound("select");
    commit({ type: "CANCEL_TRADE", playerId: humanPlayerId, tradeId });
    if (!networkRoomId) setSelectedTradeResponder(null);
    track("trade_cancelled", { mode: socketRef.current ? "network" : "local", platform: platform(), tradeId });
  };
  const copyInvite = () => setShareOpen(true);
  const inviteShare = networkRoomInfo && shareOpen ? <InviteShare code={networkRoomInfo.code ?? networkRoomInfo.id}
    url={networkRoomInfo.inviteUrl ?? `${window.location.origin}/?room=${encodeURIComponent(networkRoomInfo.code ?? networkRoomInfo.id)}`}
    onClose={() => setShareOpen(false)}/> : null;

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

  const confirmedOnlineCommand = (command: GameCommand) => {
    commandErrorRef.current = null;
    setError(null);
    if (command.type === "PLACE_SETUP") setPendingSetupVertex(null);
    if (command.type === "DISCARD_RESOURCES") setDiscardDraft(emptyResources());
    if (command.type === "PLAY_MONOPOLY" || command.type === "PLAY_YEAR_OF_PLENTY" || command.type === "PLAY_ROAD_BUILDING" || command.type === "PLAY_KNIGHT" || command.type === "MOVE_THIEF") {
      setSpecialBoardMode(null); setRoadBuildingDraft({ cardId: "", edgeIds: [] }); setRobberTargetHexId(null);
    }
    if (command.type === "MARITIME_TRADE" || command.type === "OFFER_TRADE") { clearTradeDraft(); setTradeOpen(false); }
    if (command.type === "FINALIZE_TRADE" || command.type === "CANCEL_TRADE") setSelectedTradeResponder(null);
  };

  const restoreCommandDraft = (command: GameCommand, authoritativeState: GameState) => {
    switch (command.type) {
      case "FINALIZE_TRADE": setSelectedTradeResponder(command.toPlayerId); break;
      case "OFFER_TRADE":
        setTradeDraft({ offer: command.offered, request: command.requested });
        setTradeOpen(true);
        break;
      case "MARITIME_TRADE":
        setTradeDraft({ offer: { ...emptyResources(), [command.offered]: maritimeTradeRatio(authoritativeState, command.playerId, command.offered) }, request: { ...emptyResources(), [command.requested]: 1 } });
        setTradeOpen(true);
        break;
      case "DISCARD_RESOURCES": setDiscardDraft(command.resources); break;
      case "PLACE_SETUP": setPendingSetupVertex(command.vertexId); break;
      case "PLAY_ROAD_BUILDING":
        setSpecialBoardMode({ type: "roadBuilding", cardId: command.cardId });
        setRoadBuildingDraft({ cardId: command.cardId, edgeIds: command.edgeIds });
        setBuildMode("road");
        break;
      case "PLAY_YEAR_OF_PLENTY":
        setSpecialBoardMode({ type: "yearOfPlenty", cardId: command.cardId });
        setYearOfPlentyDraft(command.resources);
        break;
      case "PLAY_MONOPOLY": setSpecialBoardMode({ type: "monopoly", cardId: command.cardId }); break;
      case "PLAY_KNIGHT":
        setSpecialBoardMode({ type: "knight", cardId: command.cardId });
        setRobberTargetHexId(command.hexId);
        break;
      case "MOVE_THIEF": setRobberTargetHexId(command.hexId); break;
    }
  };

  const connectOnlineSession = (session: { token: string; userId: PlayerId }, roomId: string, ready: boolean, generation = networkGenerationRef.current) => {
    if (!isNetworkGeneration(generation)) return;
    controller.start(session, roomId, ready, {
      onConfirmed: confirmedOnlineCommand,
      onEvents: (incomingEvents, snapshot, timer) => {
        if (!isNetworkGeneration(generation)) return;
        const canonicalRoomId = networkRoomInfoRef.current?.id ?? roomId;
        const tail = snapshot ? incomingEvents.filter((event) => event.seq > snapshot.eventSeq) : incomingEvents;
        if (snapshot) {
          const projectedState = projectViewerToGameState(snapshot, canonicalRoomId, currentConfigOptions());
          setLiveState(tail.length ? applyEvents(projectedState, tail) : projectedState);
          setServerViewer(tail.length ? applyEventsToViewerProjection(snapshot, tail, canonicalRoomId, snapshot.viewerId, currentConfigOptions()) : snapshot);
          setAppScreen("onlineGame");
          if (projectedState.phase.type === "GAME_OVER") void hydrateFinishedReplayEvents(canonicalRoomId, session, generation);
        } else if (tail.length) {
          setServerViewer((current) => current ? applyEventsToViewerProjection(current, tail, canonicalRoomId, current.viewerId, currentConfigOptions()) : null);
          setLiveState((current) => applyEvents(current, tail));
        }
        if (incomingEvents.length) {
          setEvents((current) => [...new Map([...current, ...incomingEvents].map((event) => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq));
          if (incomingEvents.some((event) => event.type === "GAME_OVER")) void hydrateFinishedReplayEvents(canonicalRoomId, session, generation);
        }
        if (timer) {
          setNetworkRoom((current) => current ? { ...current, timer } : current);
          setNetworkRoomInfo((current) => current ? { ...current, timer } : current);
        }
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
        if (ownPayloadSeat?.displayName && (displayNameDraftRef.current === null || ownPayloadSeat.displayName === displayNameDraftRef.current)) {
          setPlayerDisplayName(ownPayloadSeat.displayName);
          displayNameDraftRef.current = null;
        }
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
          if (restoredCommandRef.current) {
            restoreCommandDraft(restoredCommandRef.current, projectedState);
            restoredCommandRef.current = undefined;
          }
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

        setError(commandErrorRef.current);
      },
      onError: (incomingError) => {
        if (!isNetworkGeneration(generation)) return;
        setLobbyPending({ ready: false, settings: false, start: false, name: false });
        if (isTerminalOnlineError(incomingError)) {
          const message = networkErrorMessage(incomingError);
          resetNetworkSession(); setAppScreen("setup"); setNetworkStatus(message); setError(message);
          return;
        }
        const message = networkErrorMessage(incomingError);
        if (incomingError && typeof incomingError === "object" && "type" in incomingError && incomingError.type === "COMMAND_REJECTED") commandErrorRef.current = message;
        setError(message);
      },
    });
  };

  const retryOnlineNow = () => controller.retry();

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
    setJoinCode(roomRef);
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
    controller.stop(false);
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
    controller.pendingCommand = resumable.pendingCommand;
    restoredCommandRef.current = resumable.pendingCommand?.command;
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

  if (matchMenuOpen) return <SetupScreen matchOptions={matchOptions} error={error} joinCode={joinCode}
    startBotMatch={startBotMatch} startPlayerMatch={startPlayerMatch} joinOnlineRoom={joinOnlineRoom} setJoinCode={setJoinCode}
    setBotDifficulty={setBotDifficulty} setRuleEnabled={setRuleEnabled} setPlayerCount={setPlayerCount} setMapPreset={setMapPreset}/>;

  if (appScreen === "onlineLobby") {
    return (<>
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
        onPlayerDisplayNameChange={(name) => { displayNameDraftRef.current = name; setPlayerDisplayName(name); }}
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
      />{inviteShare}</>
    );
  }

  return (
    <main className="app-shell">
      {inviteShare}
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
                {(!networkSocketOpen && networkRoomId) ? <button type="button" onClick={retryOnlineNow}>Retry</button> : null}
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
            <PlayerStatsList
              players={displayPlayers}
              botPlayerIds={botPlayerIds}
              victoryPointText={victoryPointText}
              victoryPointAria={victoryPointAria}
              {...(activePlayer ? { activePlayerId: activePlayer } : {})}
            />
          <div className="board-stage">
            {networkRoomId && (!networkSocketOpen || pendingCommandCount > 0) ? <div className="connection-banner" role="status">
              <span>{pendingCommandCount ? "Confirming your action…" : networkStatus}</span>
              {!networkSocketOpen ? <button onClick={retryOnlineNow}>Retry</button> : null}
            </div> : null}
            {networkRoomInfo ? (
              <div className="room-hud-actions" aria-label="Room controls">
                <span>{networkRoomInfo.code ?? networkRoomInfo.id}</span>
                <button type="button" onClick={copyInvite}>Copy</button>
                {(!networkSocketOpen && networkRoomId) ? <button type="button" onClick={retryOnlineNow}>Retry</button> : null}
                <button type="button" onClick={returnToSetup}>Leave</button>
              </div>
            ) : null}
            <GameBoard state={state} humanPlayerId={humanPlayerId} legalRoads={legalRoads} legalSettlements={legalSettlements}
              legalCities={legalCities} legalThiefHexes={legalThiefHexes} pendingSetupVertex={pendingSetupVertex}
              roadBuildingSelectedEdges={roadBuildingSelectedEdges} disabled={Boolean(networkRoomId && (!networkSocketOpen || pendingCommandCount)) || isReplaying}
              onVertex={handleVertex} onEdge={handleEdge} onHex={handleHex} onCancel={handleBoardClick} visibleStealTargets={visibleStealTargets}/>


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
                <span>Card</span>
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
                  <span>Select cards below.</span>
                  <button type="button" onClick={clearDiscard} disabled={resourceCount(discardDraft) === 0}>Clear</button>
                </div>
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
                <button type="button" className="primary-wide" onClick={submitDiscard} disabled={!canSubmitDiscard}>Discard</button>
              </AccessibleDialog>
            ) : null}

            {discardAction?.type !== "DISCARD_RESOURCES" ? (<HandRack
              resourceHand={humanPlayer?.resources ?? emptyResources()}
              tradeOffer={tradeOffer}
              discardDraft={discardDraft}
              developmentCardGroups={groupedDevelopmentCards}
              onResourceTrade={openTradeFromResource}
              onDiscardResource={incrementDiscard}
              onDevelopmentCard={activateDevelopmentCard}
              {...(discardAction?.type === "DISCARD_RESOURCES" ? { discardCount: discardAction.count } : {})}
            />) : null}

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

          <details className="table-details">
            <summary>Table journal <span aria-hidden="true">↗</span></summary>
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


          </aside>
          </details>
        </div>
      </section>
    </main>
  );
};
