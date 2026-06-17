import type { GameEvent } from "@colonizt/game-core";

type SoundCue = "select" | "dice" | "complete" | "trade";

const soundSources: Record<SoundCue, string> = {
  select: "/sounds/ui-click.mp3",
  dice: "/sounds/dice-roll.mp3",
  complete: "/sounds/action-complete.mp3",
  trade: "/sounds/trade-bonus.mp3",
};

const volumes: Record<SoundCue, number> = {
  select: 0.28,
  dice: 0.36,
  complete: 0.34,
  trade: 0.32,
};

const audioByCue = new Map<SoundCue, HTMLAudioElement>();

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
    const maybePromise = audio.play();
    if (maybePromise && "catch" in maybePromise) {
      void maybePromise.catch(() => undefined);
    }
  } catch {
    // Browsers can block playback until a user gesture; gameplay must continue.
  }
};

export const playSoundForEvent = (event: GameEvent): void => {
  switch (event.type) {
    case "DICE_ROLLED":
    case "SEVEN_ROLLED":
      playSound("dice");
      break;
    case "SETUP_PLACED":
    case "ROAD_BUILT":
    case "SETTLEMENT_BUILT":
    case "CITY_UPGRADED":
    case "SPECIAL_CARD_BOUGHT":
    case "PLIGHT_STRUCK":
    case "GAME_OVER":
      playSound("complete");
      break;
    case "TRADE_OFFERED":
    case "TRADE_RESPONSE_RECORDED":
    case "MARITIME_TRADED":
    case "TRADE_ACCEPTED":
      playSound("trade");
      break;
    case "TURN_ENDED":
      playSound("select");
      break;
    default:
      break;
  }
};
