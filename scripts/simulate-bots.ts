import { playBotGame } from "@colonizt/test-utils";
import { mapPresets, type BotDifficulty, type MapPreset, type PlayerId } from "@colonizt/game-core";

type BotProfile = "random" | "greedy" | "planner";

const games = Math.max(1, Number(process.env.BOT_GAMES ?? 100));
const maxCommands = Number(process.env.BOT_MAX_COMMANDS ?? 400);
const maxTurns = process.env.BOT_MAX_TURNS ? Number(process.env.BOT_MAX_TURNS) : undefined;
const assertResults = process.env.BOT_ASSERT === "true";
const mixedDifficulty = process.env.BOT_MIXED_DIFFICULTY === "true";
const profileMode = process.env.BOT_PROFILE_MODE === "greedy" ? "greedy" : "default";
const botDifficulty = process.env.BOT_DIFFICULTY === "easy" || process.env.BOT_DIFFICULTY === "medium" || process.env.BOT_DIFFICULTY === "hard"
  ? process.env.BOT_DIFFICULTY
  : undefined;
const legacyMapRandomized = process.env.BOT_RANDOM_MAP === "true";

const parseIntegerList = (value: string | undefined, fallback: number[]): number[] => {
  if (!value) return fallback;
  const parsed = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  return parsed.length > 0 ? parsed : fallback;
};

const parseMapPresets = (value: string | undefined): MapPreset[] => {
  if (!value) return [];
  const allowed = new Set<MapPreset>(mapPresets);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is MapPreset => allowed.has(item as MapPreset));
};

const playerIdsForCount = (count: number): PlayerId[] =>
  Array.from({ length: count }, (_, index) => `p${index + 1}` as PlayerId);

const playerCounts = parseIntegerList(process.env.BOT_PLAYER_COUNTS ?? process.env.BOT_PLAYER_COUNT, [4]);
const configuredPresets = parseMapPresets(process.env.BOT_MAP_PRESETS ?? process.env.BOT_BOARD_SCENARIOS ?? process.env.BOT_MAP_PRESET);
const scenarioMaps: Array<{ label: string; mapPreset?: MapPreset; mapRandomized: boolean }> = configuredPresets.length > 0
  ? configuredPresets.map((mapPreset) => ({ label: mapPreset, mapPreset, mapRandomized: true }))
  : [{ label: legacyMapRandomized ? "legacy-random-standard" : "legacy-fixed-standard", mapRandomized: legacyMapRandomized }];

const wins = new Map<string, number>();
const winsByDifficulty = new Map<BotDifficulty, number>();
const entriesByDifficulty = new Map<BotDifficulty, number>();
const scenarioResults: Array<{
  playerCount: number;
  map: string;
  games: number;
  wins: Record<string, number>;
  invalidCommands: number;
  unfinished: number;
  crashes: number;
  averageEvents: number;
}> = [];
let crashes = 0;
let invalidCommands = 0;
let totalEvents = 0;
let unfinished = 0;

const rotatedDifficulties = (playerIds: readonly PlayerId[], index: number): Record<PlayerId, BotDifficulty> => {
  const tiers: BotDifficulty[] = ["hard", "medium", "easy", "easy"];
  return Object.fromEntries(playerIds.map((playerId, offset) => [playerId, tiers[(index + offset) % tiers.length]!])) as Record<PlayerId, BotDifficulty>;
};

for (const playerCount of playerCounts) {
  const playerIds = playerIdsForCount(playerCount);
  const greedyProfiles = Object.fromEntries(playerIds.map((playerId) => [playerId, "greedy" as const])) as Record<PlayerId, BotProfile>;
  for (const scenarioMap of scenarioMaps) {
    const scenarioWins = new Map<string, number>();
    let scenarioCrashes = 0;
    let scenarioInvalidCommands = 0;
    let scenarioEvents = 0;
    let scenarioUnfinished = 0;
    for (let index = 0; index < games; index += 1) {
      try {
        const botDifficulties = mixedDifficulty ? rotatedDifficulties(playerIds, index) : undefined;
        if (botDifficulties) {
          for (const difficulty of Object.values(botDifficulties)) {
            entriesByDifficulty.set(difficulty, (entriesByDifficulty.get(difficulty) ?? 0) + 1);
          }
        }
        const result = playBotGame(`tournament-${profileMode}-${scenarioMap.label}-${playerCount}-${index}`, maxCommands, {
          playerIds,
          ...(botDifficulty ? { botDifficulty } : {}),
          ...(botDifficulties ? { botDifficulties } : {}),
          ...(profileMode === "greedy" ? { botProfiles: greedyProfiles } : {}),
          rules: {
            mapRandomized: scenarioMap.mapRandomized,
            ...(scenarioMap.mapPreset ? { mapPreset: scenarioMap.mapPreset } : {}),
            ...(maxTurns ? { maxTurns, maxTurnAdjudication: "leader" as const } : {}),
          },
        });
        invalidCommands += result.invalidCommands;
        scenarioInvalidCommands += result.invalidCommands;
        totalEvents += result.events.length;
        scenarioEvents += result.events.length;
        if (result.state.phase.type === "GAME_OVER") {
          wins.set(result.state.phase.winnerId, (wins.get(result.state.phase.winnerId) ?? 0) + 1);
          scenarioWins.set(result.state.phase.winnerId, (scenarioWins.get(result.state.phase.winnerId) ?? 0) + 1);
          const winnerDifficulty = botDifficulties?.[result.state.phase.winnerId];
          if (winnerDifficulty) winsByDifficulty.set(winnerDifficulty, (winsByDifficulty.get(winnerDifficulty) ?? 0) + 1);
        } else {
          unfinished += 1;
          scenarioUnfinished += 1;
        }
      } catch (error) {
        crashes += 1;
        scenarioCrashes += 1;
        console.error(error);
      }
    }
    scenarioResults.push({
      playerCount,
      map: scenarioMap.label,
      games,
      wins: Object.fromEntries(scenarioWins.entries()),
      invalidCommands: scenarioInvalidCommands,
      unfinished: scenarioUnfinished,
      crashes: scenarioCrashes,
      averageEvents: scenarioEvents / games,
    });
  }
}

const totalGames = games * playerCounts.length * scenarioMaps.length;
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
      totalGames,
      playerCounts,
      maps: scenarioMaps.map((scenario) => scenario.label),
      maxCommands,
      maxTurns,
      botDifficulty,
      mixedDifficulty,
      profileMode,
      mapRandomized: legacyMapRandomized,
      wins: Object.fromEntries(wins.entries()),
      winsByDifficulty: Object.fromEntries(winsByDifficulty.entries()),
      difficultyWinRates,
      averageEvents: totalEvents / totalGames,
      invalidCommands,
      unfinished,
      crashes,
      scenarios: scenarioResults,
    },
    null,
    2,
  ),
);

if (assertResults) {
  if (crashes > 0 || invalidCommands > 0 || unfinished > 0) process.exitCode = 1;
  if (mixedDifficulty) {
    const easy = difficultyWinRates.easy;
    const strongEntries = (entriesByDifficulty.get("hard") ?? 0) + (entriesByDifficulty.get("medium") ?? 0);
    const strongWins = (winsByDifficulty.get("hard") ?? 0) + (winsByDifficulty.get("medium") ?? 0);
    const strongRate = strongEntries > 0 ? strongWins / strongEntries : 0;
    if (
      (winsByDifficulty.get("hard") ?? 0) <= 0
      || (winsByDifficulty.get("medium") ?? 0) <= 0
      || (winsByDifficulty.get("easy") ?? 0) <= 0
      || !(strongRate > easy)
    ) process.exitCode = 1;
  }
}
