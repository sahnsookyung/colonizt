# MVP Rules

Colonizt is an original resource-route board game built to demonstrate deterministic multiplayer architecture. It borrows broad genre ideas from resource-trading board games, but it does not implement exact protected-brand rules.

## Included

- Four player seats.
- One fixed demo board and one seeded balanced random board generator.
- Five resources: timber, brick, grain, fiber, and ore.
- Setup placement: each player places one settlement and one adjacent road, then receives one resource from each adjacent tile.
- Turn flow: roll dice, gain resources from adjacent settlements, optionally build/trade, then end turn.
- Build costs: roads cost timber and brick; settlements cost timber, brick, grain, and fiber; cities cost two grain and three ore.
- Special cards can be bought during the action phase. The default recipe is one fiber, one grain, and one ore.
- Settlements are worth one point and cities are worth two points.
- The current product victory threshold is ten points.
- Longest Road is worth two points once a player has at least five connected roads and no tie displaces the current holder.
- Trades support offer, cancel, accept, reject, and expiry.
- Bot trades support human accept/reject cards and bot-to-bot acceptance.
- Maritime trades use 4:1 by default, 3:1 with a generic port, and 2:1 with a matching resource port.
- Harbor bonuses belong to the two marked coastal corners connected to the ship badge. A settlement or city on either marked corner grants the port; the coastal edge itself does not.
- The board view owns the primary action buttons: trade, special card, road, settlement, city, and end/wait. Clicking the dice also rolls when rolling is legal.
- Turn clocks prevent stalled games: waiting-for-roll has a 60-second deadline, while setup, discard, thief movement, and post-roll action phases have four-minute deadlines with phase-appropriate automatic actions.
- Timers, reconnect, spectators, replay, and viewer-safe state are part of the product contract.

## Optional Rules

- Dice doubles: when enabled, doubles multiply normal production from that roll by 2 for the roller's dice result.
- Randomized balanced map: when enabled, match setup uses a seeded 19-hex board with the classic terrain counts of four timber, three brick, four grain, four fiber, three ore, and one desert.
- Random special card cost: when enabled, the match seed chooses three distinct resource types for the special-card recipe instead of the default fiber/grain/ore recipe.
- Plight: when enabled, turn 20 destroys one random building for every player that has one.

## Map Generation

The random board generator uses the base 19-hex island shape and seeded shuffles. It scores candidate terrain layouts to reduce adjacent identical resources, then scores number-token layouts to avoid adjacent red 6/8 tokens. The result stays deterministic for replay while preventing obviously clumped resource starts.

## Deferred

- Exact CATAN rules parity.
- Expansions, map editor, cosmetics, tournaments, and full ranked seasons.
- Deeper bot strategy beyond the current goal-driven build/trade heuristics.

## Thief and Discard

A roll of seven requires every player holding more than seven resources to discard half their hand, rounded down. Submitted resource bundles remain private to the submitting player. The roller must then move the thief to a different hex and, when one or more adjacent opponents hold resources, choose an eligible opponent to steal from. The stolen resource remains hidden from uninvolved viewers.
