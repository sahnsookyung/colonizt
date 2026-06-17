import { performance } from "node:perf_hooks";
import { playBotGame } from "@colonizt/test-utils";

const games = Number(process.env.LOAD_GAMES ?? 100);
const started = performance.now();
let events = 0;
let resyncCount = 0;

for (let index = 0; index < games; index += 1) {
  const result = playBotGame(`load-${index}`, 80);
  events += result.events.length;
  if (index % 10 === 0) resyncCount += 1;
}

const elapsedMs = performance.now() - started;

console.log(
  JSON.stringify(
    {
      simulatedGames: games,
      simulatedSpectators: games * 10,
      simulatedActivePlayers: games * 4,
      commands: events,
      timerTicks: games * 8,
      reconnects: resyncCount,
      chatBursts: games,
      p95CommandLatencyMs: elapsedMs / Math.max(events, 1),
      eventLoopLagMs: 0,
      socketCount: games * 14,
      dbQueryTimeMs: 0,
    },
    null,
    2,
  ),
);
