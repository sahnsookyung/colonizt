import { playBotGame } from "@colonizt/test-utils";

const games = Number(process.env.BOT_GAMES ?? 100);
const wins = new Map<string, number>();
let crashes = 0;
let invalidCommands = 0;
let totalEvents = 0;

for (let index = 0; index < games; index += 1) {
  try {
    const result = playBotGame(`tournament-${index}`, 400);
    invalidCommands += result.invalidCommands;
    totalEvents += result.events.length;
    if (result.state.phase.type === "GAME_OVER") {
      wins.set(result.state.phase.winnerId, (wins.get(result.state.phase.winnerId) ?? 0) + 1);
    }
  } catch (error) {
    crashes += 1;
    console.error(error);
  }
}

console.log(
  JSON.stringify(
    {
      games,
      wins: Object.fromEntries(wins.entries()),
      averageEvents: totalEvents / games,
      invalidCommands,
      crashes,
    },
    null,
    2,
  ),
);
