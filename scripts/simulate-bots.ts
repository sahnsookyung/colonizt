import { playBotGame } from "@colonizt/test-utils";
import type { BotDifficulty, PlayerId } from "@colonizt/game-core";

type BotProfile = "random" | "greedy" | "planner";

const games = Number(process.env.BOT_GAMES ?? 100);
const maxCommands = Number(process.env.BOT_MAX_COMMANDS ?? 400);
const maxTurns = process.env.BOT_MAX_TURNS ? Number(process.env.BOT_MAX_TURNS) : undefined;
const assertResults = process.env.BOT_ASSERT === "true";
const mixedDifficulty = process.env.BOT_MIXED_DIFFICULTY === "true";
const profileMode = process.env.BOT_PROFILE_MODE === "greedy" ? "greedy" : "default";
const botDifficulty = process.env.BOT_DIFFICULTY === "easy" || process.env.BOT_DIFFICULTY === "medium" || process.env.BOT_DIFFICULTY === "hard"
  ? process.env.BOT_DIFFICULTY
  : undefined;
const mapRandomized = process.env.BOT_RANDOM_MAP === "true";
const playerIds = ["p1", "p2", "p3", "p4"] as const satisfies readonly PlayerId[];
const greedyProfiles = { p1: "greedy", p2: "greedy", p3: "greedy", p4: "greedy" } as const satisfies Record<PlayerId, BotProfile>;
const wins = new Map<string, number>();
const winsByDifficulty = new Map<BotDifficulty, number>();
const entriesByDifficulty = new Map<BotDifficulty, number>();
let crashes = 0;
let invalidCommands = 0;
let totalEvents = 0;
let unfinished = 0;

const rotatedDifficulties = (index: number): Record<PlayerId, BotDifficulty> => {
  const tiers: BotDifficulty[] = ["hard", "medium", "easy", "easy"];
  return Object.fromEntries(playerIds.map((playerId, offset) => [playerId, tiers[(index + offset) % tiers.length]!])) as Record<PlayerId, BotDifficulty>;
};

for (let index = 0; index < games; index += 1) {
  try {
    const botDifficulties = mixedDifficulty ? rotatedDifficulties(index) : undefined;
    if (botDifficulties) {
      for (const difficulty of Object.values(botDifficulties)) {
        entriesByDifficulty.set(difficulty, (entriesByDifficulty.get(difficulty) ?? 0) + 1);
      }
    }
    const result = playBotGame(`tournament-${profileMode}-${index}`, maxCommands, {
      ...(botDifficulty ? { botDifficulty } : {}),
      ...(botDifficulties ? { botDifficulties } : {}),
      ...(profileMode === "greedy" ? { botProfiles: greedyProfiles } : {}),
      rules: {
        mapRandomized,
        ...(maxTurns ? { maxTurns, maxTurnAdjudication: "leader" as const } : {}),
      },
    });
    invalidCommands += result.invalidCommands;
    totalEvents += result.events.length;
    if (result.state.phase.type === "GAME_OVER") {
      wins.set(result.state.phase.winnerId, (wins.get(result.state.phase.winnerId) ?? 0) + 1);
      const winnerDifficulty = botDifficulties?.[result.state.phase.winnerId];
      if (winnerDifficulty) winsByDifficulty.set(winnerDifficulty, (winsByDifficulty.get(winnerDifficulty) ?? 0) + 1);
    } else {
      unfinished += 1;
    }
  } catch (error) {
    crashes += 1;
    console.error(error);
  }
}

const difficultyWinRates = Object.fromEntries(
  (["hard", "medium", "easy"] as const).map((difficulty) => {
    const winsForDifficulty = winsByDifficulty.get(difficulty) ?? 0;
    const entries = entriesByDifficulty.get(difficulty) ?? 0;
    return [difficulty, entries > 0 ? winsForDifficulty / entries : 0];
  }),
);

console.log(
  JSON.stringify(
    {
      games,
      maxCommands,
      maxTurns,
      botDifficulty,
      mixedDifficulty,
      profileMode,
      mapRandomized,
      wins: Object.fromEntries(wins.entries()),
      winsByDifficulty: Object.fromEntries(winsByDifficulty.entries()),
      difficultyWinRates,
      averageEvents: totalEvents / games,
      invalidCommands,
      unfinished,
      crashes,
    },
    null,
    2,
  ),
);

if (assertResults) {
  if (crashes > 0 || invalidCommands > 0 || unfinished > 0) process.exitCode = 1;
  if (mixedDifficulty) {
    const hard = difficultyWinRates.hard;
    const medium = difficultyWinRates.medium;
    const easy = difficultyWinRates.easy;
    if (!(hard > medium && medium > easy)) process.exitCode = 1;
  }
}
