import type { GameEvent, PlayerId } from "@colonizt/game-core";

export type SoundCue =
  | "select"
  | "dice"
  | "buildRoad"
  | "buildSettlement"
  | "upgradeCity"
  | "trade"
  | "devCard"
  | "thief"
  | "discard"
  | "turnHandoff"
  | "gameOver";

export const soundSources: Record<SoundCue, string> = {
  select: "/sounds/ui-select.wav",
  dice: "/sounds/dice-roll.wav",
  buildRoad: "/sounds/build-road.wav",
  buildSettlement: "/sounds/build-settlement.wav",
  upgradeCity: "/sounds/upgrade-city.wav",
  trade: "/sounds/trade.wav",
  devCard: "/sounds/dev-card.wav",
  thief: "/sounds/thief.wav",
  discard: "/sounds/discard.wav",
  turnHandoff: "/sounds/turn-handoff.wav",
  gameOver: "/sounds/game-over.wav",
};

const volumes: Record<SoundCue, number> = {
  select: 0.16,
  dice: 0.28,
  buildRoad: 0.24,
  buildSettlement: 0.26,
  upgradeCity: 0.28,
  trade: 0.24,
  devCard: 0.25,
  thief: 0.23,
  discard: 0.2,
  turnHandoff: 0.22,
  gameOver: 0.3,
};

const audioByCue = new Map<SoundCue, HTMLAudioElement>();

const resourceCount = (resources: Record<string, number> | Partial<Record<string, number>> | undefined): number =>
  Object.values(resources ?? {}).reduce<number>((total, value) =>
    total + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);

const tradeTargetsPlayer = (event: GameEvent, humanPlayerId: PlayerId): boolean => {
  switch (event.type) {
    case "TRADE_OFFERED":
      return event.trade.fromPlayerId === humanPlayerId
        || event.trade.recipients === "ANY"
        || event.trade.recipients.includes(humanPlayerId);
    case "TRADE_RESPONSE_RECORDED":
      return event.fromPlayerId === humanPlayerId
        || event.playerId === humanPlayerId
        || Boolean(event.recipientIds?.includes(humanPlayerId));
    case "TRADE_ACCEPTED":
      return event.fromPlayerId === humanPlayerId || event.toPlayerId === humanPlayerId;
    case "TRADE_CANCELLED":
    case "TRADE_REJECTED":
    case "TRADE_EXPIRED":
    case "TRADE_CLOSED":
    case "MARITIME_TRADED":
      return event.playerId === humanPlayerId;
    default:
      return false;
  }
};

const eventHasPlayer = (event: GameEvent, humanPlayerId: PlayerId): boolean =>
  "playerId" in event && event.playerId === humanPlayerId;

export const selectSoundCueForEvents = (events: readonly GameEvent[], humanPlayerId?: PlayerId): SoundCue | null => {
  if (events.length === 0) return null;

  if (events.some((event) => event.type === "GAME_OVER")) return "gameOver";
  if (!humanPlayerId) return null;

  const affectsHuman = (event: GameEvent): boolean => {
    if (eventHasPlayer(event, humanPlayerId) || tradeTargetsPlayer(event, humanPlayerId)) return true;
    switch (event.type) {
      case "DISCARD_REQUIRED":
        return (event.pending[humanPlayerId] ?? 0) > 0;
      case "THIEF_MOVED":
        return event.stealFromPlayerId === humanPlayerId;
      case "RESOURCES_PRODUCED":
        return resourceCount(event.gains[humanPlayerId]) > 0;
      case "PLIGHT_STRUCK":
        return event.destroyed.some((destroyed) => destroyed.playerId === humanPlayerId);
      case "TURN_ENDED":
        return event.nextPlayerId === humanPlayerId || event.playerId === humanPlayerId;
      case "LARGEST_ARMY_UPDATED":
      case "LONGEST_ROAD_UPDATED":
        return event.playerId === humanPlayerId;
      default:
        return false;
    }
  };

  const relevant = events.filter(affectsHuman);
  if (relevant.length === 0) return null;

  if (relevant.some((event) => event.type === "THIEF_MOVED" || event.type === "PLIGHT_STRUCK")) return "thief";
  if (relevant.some((event) => event.type === "DISCARD_REQUIRED" || event.type === "RESOURCES_DISCARDED")) return "discard";
  if (relevant.some((event) => event.type === "CITY_UPGRADED")) return "upgradeCity";
  if (relevant.some((event) => event.type === "SETUP_PLACED" || event.type === "SETTLEMENT_BUILT")) return "buildSettlement";
  if (relevant.some((event) =>
    event.type === "SPECIAL_CARD_BOUGHT"
    || event.type === "DEVELOPMENT_CARD_PLAYED"
    || event.type === "ROAD_BUILDING_PLAYED"
    || event.type === "MONOPOLY_PLAYED"
    || event.type === "YEAR_OF_PLENTY_PLAYED"
    || event.type === "LARGEST_ARMY_UPDATED"
  )) return "devCard";
  if (relevant.some((event) => event.type === "ROAD_BUILT" || event.type === "LONGEST_ROAD_UPDATED")) return "buildRoad";
  if (relevant.some((event) =>
    event.type === "TRADE_OFFERED"
    || event.type === "TRADE_RESPONSE_RECORDED"
    || event.type === "TRADE_ACCEPTED"
    || event.type === "TRADE_CANCELLED"
    || event.type === "TRADE_REJECTED"
    || event.type === "TRADE_EXPIRED"
    || event.type === "TRADE_CLOSED"
    || event.type === "MARITIME_TRADED"
  )) return "trade";
  if (relevant.some((event) => event.type === "DICE_ROLLED" || event.type === "SEVEN_ROLLED" || event.type === "RESOURCES_PRODUCED")) return "dice";
  if (relevant.some((event) => event.type === "TURN_ENDED")) return "turnHandoff";

  return null;
};

export const playSound = (cue: SoundCue): void => {
  if (typeof Audio === "undefined") return;
  if (typeof navigator !== "undefined" && navigator.userAgent.includes("jsdom")) return;
  try {
    let audio = audioByCue.get(cue);
    if (!audio) {
      audio = new Audio(soundSources[cue]);
      audio.preload = "auto";
      audio.volume = volumes[cue];
      audioByCue.set(cue, audio);
    }
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
  } catch {
    // Browsers can block playback until a user gesture; gameplay must continue.
  }
};

export const playSoundForEvents = (events: readonly GameEvent[], humanPlayerId?: PlayerId): void => {
  const cue = selectSoundCueForEvents(events, humanPlayerId);
  if (cue) playSound(cue);
};

export const playSoundForEvent = (event: GameEvent, humanPlayerId?: PlayerId): void => {
  playSoundForEvents([event], humanPlayerId);
};
