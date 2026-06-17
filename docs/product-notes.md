# Product Notes

The first version optimizes for a polished vertical slice over full rules parity. The demo should prove that a player can create a room, start a bot-filled game, play legal actions, trade, reconnect, and replay the match.

## Metrics

- Time to first game.
- Room creation completion rate.
- Game completion rate.
- Disconnect/reconnect rate.
- Average turn time.
- Trade offer accept rate.
- Command rejection rate.
- Mobile misclick rate.
- Frontend FPS and input latency.

## Randomness Trust

Dice rolls are server-side events with an RNG policy recorded in the event log. Test and replay paths use seeded deterministic RNG. The player-facing explanation should be simple: short games can have streaks, but the replay log records every roll and the simulation report checks aggregate distribution.

Run `npm run simulate:dice` to produce the distribution and goodness-of-fit report.

## Ranked Simulation

Public ranked queue is deferred until replay, reconnect, trade, and mobile gates are green. The current admin/local simulation is executable with `npm run simulate:ranked`; it reports ticket count, cancellations, matched users, average wait, rating spread, abandonment, and duplicate-match safety.

## Rush Simulation

Rush is represented as a deterministic concurrency spike rather than a shipped public mode. Run `npm run simulate:rush` to submit 100 same-window commands through server-style ordering and prove first-valid-wins behavior with no duplicate edge ownership.
