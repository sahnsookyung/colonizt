import type { BotDifficulty, MapPreset } from "@colonizt/game-core";
import { HouseSymbol, RoadSymbol } from "./game-ui.js";
import {
  mapPresetLabels,
  onlineRoomCapacityText,
  type MatchOptions,
} from "../match-options.js";
interface Props {
  matchOptions: MatchOptions;
  error: string | null;
  joinCode: string;
  startBotMatch(): void;
  startPlayerMatch(): void;
  joinOnlineRoom(code: string): Promise<void>;
  setJoinCode(code: string): void;
  setBotDifficulty(difficulty: BotDifficulty): void;
  setRuleEnabled(
    rule: "diceDoubles" | "specialCardCostRandomized" | "plight",
    enabled: boolean,
  ): void;
  setPlayerCount(count: 2 | 3 | 4): void;
  setMapPreset(preset: MapPreset): void;
}
export const SetupScreen = ({
  matchOptions,
  error,
  joinCode,
  startBotMatch,
  startPlayerMatch,
  joinOnlineRoom,
  setJoinCode,
  setBotDifficulty,
  setRuleEnabled,
  setPlayerCount,
  setMapPreset,
}: Props) => (
  <main className="app-shell start-app">
    <section className="start-screen" aria-label="Match setup">
      <div className="island-intro" aria-hidden="true">
        <span className="eyebrow">THE ISLAND IS YOURS</span>
        <h2>
          Small island.
          <br />
          Grand plans.
        </h2>
        <p>
          Find your corner of the world.
          <br />
          Build something together.
        </p>
        <div className="intro-island">
          <span className="intro-island-stamp">A world worth sharing</span>
        </div>
        <span className="intro-footnote">
          A tabletop adventure for 2–4 friends
        </span>
      </div>
      <div className="start-panel">
        <div className="start-brand">
          <h1>Colonizt</h1>
          <span>A place to gather, trade & grow.</span>
        </div>
        <div className="match-menu" role="group" aria-label="Choose match type">
          <button
            type="button"
            className="match-choice"
            onClick={startBotMatch}
          >
            <span className="match-art" aria-hidden="true">
              <HouseSymbol />
              <RoadSymbol />
            </span>
            <strong>Bot Match</strong>
            <span>Local table</span>
            <span className="match-cta">Start</span>
          </button>
          <button
            type="button"
            className="match-choice"
            onClick={startPlayerMatch}
          >
            <span className="match-art" aria-hidden="true">
              <HouseSymbol city />
              <RoadSymbol />
            </span>
            <strong>Player Match</strong>
            <span>{onlineRoomCapacityText(matchOptions.playerCount)}</span>
            <span className="match-cta">Host</span>
          </button>
        </div>
        <form
          className="room-code-join"
          aria-label="Join by room code"
          onSubmit={(event) => {
            event.preventDefault();
            void joinOnlineRoom(joinCode);
          }}
        >
          <label htmlFor="room-code-input">Room code</label>
          <input
            id="room-code-input"
            value={joinCode}
            onChange={(event) =>
              setJoinCode(event.currentTarget.value.toUpperCase())
            }
            inputMode="text"
            autoComplete="off"
            maxLength={12}
            placeholder="ABC123"
          />
          <button type="submit" disabled={joinCode.trim().length === 0}>
            Join
          </button>
        </form>
        <div className="match-options" aria-label="Game options">
          <div className="option-row">
            <span>Bot difficulty</span>
            <div
              className="difficulty-options"
              role="group"
              aria-label="Bot difficulty"
            >
              {(["easy", "medium", "hard"] as const).map((difficulty) => (
                <button
                  key={difficulty}
                  type="button"
                  className={
                    matchOptions.botDifficulty === difficulty ? "selected" : ""
                  }
                  aria-pressed={matchOptions.botDifficulty === difficulty}
                  onClick={() => setBotDifficulty(difficulty)}
                >
                  {difficulty}
                </button>
              ))}
            </div>
          </div>
          <label className="rule-toggle">
            <input
              type="checkbox"
              checked={matchOptions.rules.diceDoubles}
              onChange={(event) =>
                setRuleEnabled("diceDoubles", event.currentTarget.checked)
              }
            />
            <span>Dice doubles x2</span>
          </label>
          <label className="rule-toggle">
            <input
              type="checkbox"
              checked={matchOptions.rules.specialCardCostRandomized}
              onChange={(event) =>
                setRuleEnabled(
                  "specialCardCostRandomized",
                  event.currentTarget.checked,
                )
              }
            />
            <span>Random special card cost</span>
          </label>
          <label className="rule-toggle">
            <input
              type="checkbox"
              checked={matchOptions.rules.plight}
              onChange={(event) =>
                setRuleEnabled("plight", event.currentTarget.checked)
              }
            />
            <span>Plight on turn 20</span>
          </label>
          <div className="option-row">
            <span>Players</span>
            <div
              className="difficulty-options"
              role="group"
              aria-label="Players"
            >
              {([2, 3, 4] as const).map((playerCount) => (
                <button
                  key={playerCount}
                  type="button"
                  className={
                    matchOptions.playerCount === playerCount ? "selected" : ""
                  }
                  aria-pressed={matchOptions.playerCount === playerCount}
                  onClick={() => setPlayerCount(playerCount)}
                >
                  {playerCount}
                </button>
              ))}
            </div>
          </div>
          <div className="option-row">
            <span>Map</span>
            <div className="difficulty-options" role="group" aria-label="Map">
              {(["standard", "islands", "continent"] as const).map(
                (mapPreset) => (
                  <button
                    key={mapPreset}
                    type="button"
                    className={
                      matchOptions.rules.mapPreset === mapPreset
                        ? "selected"
                        : ""
                    }
                    aria-pressed={matchOptions.rules.mapPreset === mapPreset}
                    onClick={() => setMapPreset(mapPreset)}
                  >
                    {mapPresetLabels[mapPreset]}
                  </button>
                ),
              )}
            </div>
          </div>
        </div>
        {error ? <p className="start-error">{error}</p> : null}
      </div>
    </section>
  </main>
);
