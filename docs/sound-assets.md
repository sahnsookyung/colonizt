# Sound Assets

The web client stores short action cues in `packages/web/public/sounds`. All current files were downloaded from Pixabay sound-effect pages and are used under the Pixabay Content License. Pixabay lists these as free for use under that license; attribution is not required, but the source pages are kept here for traceability.

| Local file | Source | Usage |
| --- | --- | --- |
| `packages/web/public/sounds/ui-click.mp3` | [UI Button Click #5](https://pixabay.com/sound-effects/ui-button-click-5-327756/) by Audley_Fergine | Button taps, card selection, end-turn cue |
| `packages/web/public/sounds/dice-roll.mp3` | [Dice](https://pixabay.com/sound-effects/dice-142528/) by u_qpfzpydtro | Confirmed dice roll events |
| `packages/web/public/sounds/action-complete.mp3` | [Success/Finish UI sound effect](https://pixabay.com/sound-effects/technology-successfinish-ui-sound-effect-467873/) by Nomagician | Completed construction, special card, plight, and win events |
| `packages/web/public/sounds/trade-bonus.mp3` | [Game Bonus 02](https://pixabay.com/sound-effects/game-bonus-02-294436/) by Universfield | Trade offers, trade responses, bank trades, finalized trades |

The UI plays sounds from confirmed game events where possible so local, bot, and networked actions use the same feedback path. Immediate click sounds are only used for intentional controls such as choosing a build mode or selecting trade cards.
