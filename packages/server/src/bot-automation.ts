import {
  activeCollectingTradeForPlayer,
  canBuildRoad,
  emptyResources,
  hasResources,
  type GameCommand,
  type PlayerId,
} from "@colonizt/game-core";
import {
  createBotTradeId,
  createBotView,
  evaluateTrade,
  greedyBot,
  hasEquivalentBotTradeOffer,
  plannerBot,
  randomLegalBot,
  resolveBotOfferCommand,
  tradeFullyAnswered,
  tradeShapeKey,
  type BotController,
} from "@colonizt/bots";
import type { Room } from "./room-manager.js";

export const botControllerFor = (botId: PlayerId): BotController => {
  let seatNumber = 0;
  let placeValue = 1;
  for (let index = botId.length - 1; index >= 0; index -= 1) {
    const digit = botId.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) break;
    seatNumber += digit * placeValue;
    placeValue *= 10;
  }
  if (seatNumber % 3 === 0) return plannerBot;
  if (seatNumber % 2 === 0) return greedyBot;
  return randomLegalBot;
};

export const botSeatIds = (room: Room): PlayerId[] =>
  room.seats.map((seat) => seat.botId).filter((botId): botId is PlayerId => Boolean(botId));

export const botTradeResponseCommand = (room: Room): GameCommand | undefined => {
  if (!room.game) return undefined;
  const botIds = new Set(botSeatIds(room));
  for (const trade of Object.values(room.game.trades)) {
    if (trade.status !== "COLLECTING_RESPONSES") continue;
    if (!hasResources(room.game.players[trade.fromPlayerId]?.resources ?? emptyResources(), trade.offered)) continue;
    const candidates = trade.recipients === "ANY"
      ? [...botIds].filter((botId) => botId !== trade.fromPlayerId)
      : trade.recipients.filter((recipient) => botIds.has(recipient));
    for (const botId of candidates) {
      if (trade.responses?.[botId]?.status !== "PENDING") continue;
      const bot = botControllerFor(botId);
      const view = createBotView(room.game, botId, bot.profile, room.game.config.botDifficulty ?? "medium");
      const response = evaluateTrade(view, trade, bot.profile, room.game.config.botDifficulty ?? "medium") === "ACCEPT"
        ? "WANTS_ACCEPT"
        : "REJECTED";
      return { type: "RESPOND_TRADE", playerId: botId, tradeId: trade.id, response };
    }
  }
  return undefined;
};

export const botOfferResolutionCommand = (room: Room, tradeId: string): GameCommand | undefined => {
  if (!room.game) return undefined;
  return resolveBotOfferCommand({
    state: room.game,
    tradeId,
    botIds: botSeatIds(room),
    profileForPlayer: (playerId) => botControllerFor(playerId).profile,
    difficulty: room.game.config.botDifficulty ?? "medium",
  })?.command;
};

export const readyBotOfferResolutionCommand = (room: Room): GameCommand | undefined => {
  if (!room.game) return undefined;
  const bots = new Set(botSeatIds(room));
  const trade = Object.values(room.game.trades)
    .filter((candidate) => candidate.status === "COLLECTING_RESPONSES")
    .filter((candidate) => bots.has(candidate.fromPlayerId))
    .filter((candidate) => tradeFullyAnswered(room.game!, candidate))
    .sort((left, right) => left.createdAtSeq - right.createdAtSeq || left.id.localeCompare(right.id))[0];
  return trade ? botOfferResolutionCommand(room, trade.id) : undefined;
};

export const dueTradeResponseCommand = (room: Room, now: number): GameCommand | undefined => {
  for (const [tradeId, deadline] of [...room.tradeResponseDeadlines.entries()].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))) {
    if (deadline > now) continue;
    const command = botOfferResolutionCommand(room, tradeId);
    if (command) return command;
    room.tradeResponseDeadlines.delete(tradeId);
  }
  return undefined;
};

export const chooseBotTurnCommand = (room: Room, active: PlayerId): GameCommand | undefined => {
  if (!room.game || activeCollectingTradeForPlayer(room.game, active)) return undefined;
  const bot = botControllerFor(active);
  const view = createBotView(room.game, active, bot.profile, room.game.config.botDifficulty ?? "medium");
  let command = bot.chooseCommand(view, (prefix: string) => createBotTradeId(room.game!, active, bot.profile) || prefix);
  if (command?.type === "OFFER_TRADE" && hasEquivalentBotTradeOffer(view, command)) {
    command = { type: "END_TURN", playerId: active };
  }
  if (command?.type === "PLACE_SETUP") {
    const setupCommand = command;
    const edgeId = room.game.board.adjacency.vertexToEdges[setupCommand.vertexId]?.find((candidate) => canBuildRoad(room.game!, setupCommand.playerId, candidate, setupCommand.vertexId));
    if (edgeId) command = { ...setupCommand, edgeId };
  }
  return command;
};

export { tradeShapeKey };
