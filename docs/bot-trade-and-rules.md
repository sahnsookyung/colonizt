# Bot Trade and Optional Rules

This document records the current gameplay decisions for bot trading, keyboard shortcuts, and pre-game rule toggles.

## Bot Trades

- Human-originated offers are evaluated by eligible bots.
- Player-to-player offers enter a 15 second staged response window.
- Bot-originated offers are shown to the human in the on-map trade response overlay.
- Bot-originated offers can also receive bot responses, including bot-to-bot trades.
- Bots never accept their own offers.
- A trade is only accepted if the offerer still owns the offered resources and the accepter owns the requested resources.
- Responses do not finalize a trade. The offerer chooses one willing responder, or cancels.
- The offerer cannot roll, build, bank trade, draw special cards, create another offer, or manually end the turn while their staged offer is collecting responses.
- If every recipient rejects, the trade closes with `ALL_REJECTED`. If the 15 second response window expires, it closes with `RESPONSE_TIMEOUT`.

Bank and harbor trades remain immediate and never use the staged response flow.

## Trade Heuristics

Bots score trades by comparing the value of their current hand against the post-trade hand. The score includes:

- Immediate build readiness for roads, settlements, cities, and special cards.
- Shortfall reduction against road, settlement, city, and special-card costs.
- Access to resources the bot does not currently produce from its buildings.
- New resource diversity.
- Port access, production expected value, longest-road pressure, and hand-size risk.
- A penalty for helping a clear leader.

Each bot also has a deterministic per-turn trade temperament. The randomness is derived from the match seed, match id, turn, bot id, and trade direction, so repeating the same offer during the same turn does not reroll the bot's personality for that turn.

Bot responders emit `RESPOND_TRADE` with either `WANTS_ACCEPT` or `REJECTED`. Bot offerers wait for the response window, choose the willing responder with the highest utility score, tie-break by player order, or cancel if no acceptable responder exists.

## Difficulty

Bot difficulty is selected before match start.

- Easy: lower accept threshold, wider temperament swing, and more willingness to make offers.
- Medium: baseline accept threshold and offer cadence.
- Hard: higher accept threshold, smaller temperament swing, and stricter favorable-trade behavior.

Difficulty affects both whether a bot creates offers and whether it accepts offers. Hard bots are more likely to require trades that improve their own strategic score, especially when the offer helps a leading player.

## Keyboard Shortcuts

Desktop can use `R` to roll and `E` to end the current turn. Mobile hides these shortcut affordances and ignores keyboard shortcuts.

## Optional Rules

Optional rules are toggled before match start.

- Dice doubles: if the roller rolls doubles, normal resource production for that roll is multiplied by 2.
- Randomized balanced map: if enabled, the board keeps classic 19-hex terrain counts, spreads same-resource neighbors where possible, and avoids adjacent red 6/8 token placements.
- Random special card cost: if enabled, the match seed chooses three distinct resource types for buying special cards. The default non-random recipe is fiber, grain, and ore.
- Plight: on turn 20, one random building owned by each player is destroyed. Destroyed buildings stop producing resources because their settlement/city is removed from the board.

The engine supports a configurable `plightTurn` for tests and future variants, but the product UI currently exposes Plight as the fixed turn-20 rule.
