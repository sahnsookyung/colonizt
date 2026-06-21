import { replay } from "@colonizt/game-core";
import { createDemoConfig, playBotGame } from "@colonizt/test-utils";

const seeds = ["fixture-one", "fixture-two", "fixture-three"];

for (const seed of seeds) {
  const played = playBotGame(seed, 250);
  const replayed = replay({
    config: createDemoConfig(seed),
    board: played.state.board,
    events: played.events,
  });
  if (JSON.stringify(replayed) !== JSON.stringify(played.state)) {
    throw new Error(`Replay mismatch for ${seed}`);
  }
  console.log(`${seed}: replayed ${played.events.length} events, phase=${replayed.phase.type}`);
}
