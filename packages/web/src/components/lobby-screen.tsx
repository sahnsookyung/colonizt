import type { BotDifficulty, MapPreset } from "@colonizt/game-core";
import {
  isLobbySeatConnected,
  isLobbySeatOccupied,
  lobbyReadiness,
  type PublicRoomPayload,
} from "@colonizt/protocol";
import { clampPlayerCount, mapPresetLabels, toPlayerCount, type MatchOptions } from "../match-options.js";

export interface LobbyPendingState {
  ready: boolean;
  settings: boolean;
  start: boolean;
  name: boolean;
}

export type LobbySettingsInput = {
  maxPlayers?: 2 | 3 | 4;
  minPlayers?: 2 | 3 | 4;
  botDifficulty?: BotDifficulty;
  rules?: Partial<MatchOptions["rules"]>;
};

type LobbyToggleRule = "diceDoubles" | "specialCardCostRandomized" | "plight";

interface LobbyScreenProps {
  networkRoom: PublicRoomPayload | null;
  roomCodeFallback?: string | undefined;
  canCopyInvite: boolean;
  humanPlayerId: string;
  matchOptions: MatchOptions;
  networkStatus: string;
  error: string | null;
  pendingCommandCount: number;
  reconnectRetryAt: number | null;
  nowMs: number;
  networkSocketOpen: boolean;
  lobbyPending: LobbyPendingState;
  playerDisplayName: string;
  onPlayerDisplayNameChange: (name: string) => void;
  onSaveDisplayName: () => void;
  onReturnToSetup: () => void;
  onCopyInvite: () => void;
  onRetryNow: () => void;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  onUpdateSettings: (settings: LobbySettingsInput) => void;
  onSetPlayerCount: (playerCount: 2 | 3 | 4) => void;
  onSetMapPreset: (mapPreset: MapPreset) => void;
  onSetBotDifficulty: (difficulty: BotDifficulty) => void;
  onSetRuleEnabled: (rule: LobbyToggleRule, enabled: boolean) => void;
  onAddBot: () => void;
  onRemoveBot: (seatIndex: number) => void;
}

export const LobbyScreen = ({
  networkRoom,
  roomCodeFallback,
  canCopyInvite,
  humanPlayerId,
  matchOptions,
  networkStatus,
  error,
  pendingCommandCount,
  reconnectRetryAt,
  nowMs,
  networkSocketOpen,
  lobbyPending,
  playerDisplayName,
  onPlayerDisplayNameChange,
  onSaveDisplayName,
  onReturnToSetup,
  onCopyInvite,
  onRetryNow,
  onReady,
  onStart,
  onUpdateSettings,
  onSetPlayerCount,
  onSetMapPreset,
  onSetBotDifficulty,
  onSetRuleEnabled,
  onAddBot,
  onRemoveBot,
}: LobbyScreenProps) => {
  const roomCode = networkRoom?.code ?? roomCodeFallback ?? "------";
  const lobbySeats = networkRoom?.seats ?? [];
  const ownSeat = lobbySeats.find((seat) => seat.userId === humanPlayerId);
  const isHost = networkRoom?.hostUserId === humanPlayerId;
  const inferredSeatCount = clampPlayerCount(lobbySeats.length);
  const configuredSeats = toPlayerCount(networkRoom?.settings?.maxPlayers, inferredSeatCount);
  const neededPlayers = Math.min(configuredSeats, toPlayerCount(networkRoom?.settings?.minPlayers, 2));
  const totalSeats = configuredSeats;
  const readiness = lobbyReadiness(lobbySeats, neededPlayers);
  const readyCount = readiness.readyCount;
  const occupiedCount = readiness.occupiedCount;
  const botSeats = lobbySeats.filter((seat) => seat.botId && seat.seatIndex < totalSeats);
  const lastBotSeat = botSeats.at(-1);
  const canAddBot = Boolean(isHost && networkSocketOpen && !lobbyPending.settings && occupiedCount < totalSeats);
  const canRemoveBot = Boolean(isHost && networkSocketOpen && !lobbyPending.settings && lastBotSeat);
  const connectedUnreadySeats = lobbySeats.filter((seat) => isLobbySeatOccupied(seat) && isLobbySeatConnected(seat) && !seat.ready);
  const startStatus = readiness.canStart
    ? `Ready to start ${readyCount} player${readyCount === 1 ? "" : "s"}`
    : readyCount < neededPlayers
      ? `Need ${neededPlayers - readyCount} more ready player${neededPlayers - readyCount === 1 ? "" : "s"}`
      : connectedUnreadySeats.length > 0
        ? `Waiting on ${connectedUnreadySeats.map((seat) => seat.displayName ?? seat.userId ?? seat.botId ?? `Seat ${seat.seatIndex + 1}`).join(", ")}`
        : "Waiting for players";
  const canGo = Boolean(isHost && networkSocketOpen && readiness.canStart);
  const lobbyMapPreset = networkRoom?.settings?.rules?.mapPreset ?? matchOptions.rules.mapPreset;
  const lobbyBotDifficulty = networkRoom?.settings?.botDifficulty ?? matchOptions.botDifficulty;
  const lobbyRulesState: MatchOptions["rules"] = {
    diceDoubles: networkRoom?.settings?.rules?.diceDoubles ?? matchOptions.rules.diceDoubles,
    plight: networkRoom?.settings?.rules?.plight ?? matchOptions.rules.plight,
    plightTurn: networkRoom?.settings?.rules?.plightTurn ?? matchOptions.rules.plightTurn,
    mapRandomized: networkRoom?.settings?.rules?.mapRandomized ?? matchOptions.rules.mapRandomized,
    mapPreset: lobbyMapPreset,
    specialCardCostRandomized: networkRoom?.settings?.rules?.specialCardCostRandomized ?? matchOptions.rules.specialCardCostRandomized,
  };
  const lobbyRules = [
    `Start ${neededPlayers}+`,
    `Open seats ${totalSeats}`,
    `Bots ${botSeats.length}`,
    `Map ${mapPresetLabels[lobbyMapPreset]}`,
    `Difficulty ${lobbyBotDifficulty}`,
    lobbyRulesState.diceDoubles ? "Doubles x2" : undefined,
    lobbyRulesState.plight ? `Plight turn ${lobbyRulesState.plightTurn ?? 20}` : undefined,
    lobbyRulesState.specialCardCostRandomized ? "Random special cost" : undefined,
  ].filter((rule): rule is string => Boolean(rule));

  return (
    <main className="app-shell lobby-app">
      <section className="online-lobby" aria-label="Online lobby">
        <header className="topbar">
          <div className="brand-block">
            <h1>Colonizt</h1>
            <p>
              Room {roomCode} · <span className="phase-code">{networkRoom?.status ?? "LOBBY"}</span>
            </p>
          </div>
          <div className="topbar-actions">
            <button type="button" onClick={onReturnToSetup}>New Match</button>
          </div>
        </header>
        <div className="lobby-layout">
          <div className="lobby-panel">
            <div className="lobby-code-card">
              <span>Room Code</span>
              <strong>{roomCode}</strong>
              <button type="button" onClick={onCopyInvite} disabled={!canCopyInvite}>Copy Invite</button>
            </div>
            <div className="lobby-status-card" aria-live="polite">
              <span>{networkStatus}</span>
              <strong>{readyCount}/{neededPlayers} ready · {occupiedCount}/{totalSeats} open seats</strong>
              <small>{startStatus}</small>
              {pendingCommandCount > 0 ? <small>{pendingCommandCount} pending</small> : null}
              {reconnectRetryAt ? <small>Retry {Math.max(0, Math.ceil((reconnectRetryAt - nowMs) / 1000))}s</small> : null}
              {error ? <em>{error}</em> : null}
            </div>
            <div className="lobby-name-card">
              <label htmlFor="lobby-display-name">Your name</label>
              <div>
                <input
                  id="lobby-display-name"
                  value={playerDisplayName}
                  onChange={(event) => onPlayerDisplayNameChange(event.currentTarget.value)}
                  maxLength={40}
                  autoComplete="nickname"
                />
                <button type="button" onClick={onSaveDisplayName} disabled={!networkSocketOpen || lobbyPending.name}>
                  {lobbyPending.name ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
            <div className="lobby-actions">
              <button type="button" onClick={() => onReady(!ownSeat?.ready)} disabled={!ownSeat || lobbyPending.ready || !networkSocketOpen}>
                {!networkSocketOpen ? "Connecting..." : lobbyPending.ready ? "Saving..." : ownSeat?.ready ? "Unready" : "Ready"}
              </button>
              {isHost ? (
                <button type="button" className="primary-lobby-action" onClick={onStart} disabled={!canGo || lobbyPending.start}>
                  {lobbyPending.start ? "Starting..." : "Go"}
                </button>
              ) : null}
              <button type="button" onClick={onRetryNow} disabled={!reconnectRetryAt}>Retry</button>
              <button type="button" onClick={onReturnToSetup}>Leave</button>
            </div>
          </div>
          <aside className="lobby-side" aria-label="Lobby seats and rules">
            <div className="phase-card">
              <div className="panel-title">
                <strong>Seats</strong>
                <span>{occupiedCount}/{totalSeats} open</span>
              </div>
              <div className="lobby-seats">
                {Array.from({ length: 4 }, (_, index) => lobbySeats[index] ?? { seatIndex: index, ready: false, connected: false }).map((seat) => {
                  const closed = seat.seatIndex >= totalSeats;
                  const occupant = seat.userId ?? seat.botId;
                  const isYou = seat.userId === humanPlayerId;
                  return (
                    <article key={seat.seatIndex} className={`lobby-seat ${seat.ready ? "ready" : ""} ${isYou ? "you" : ""} ${closed ? "closed" : ""}`}>
                      <span>Seat {seat.seatIndex + 1}</span>
                      <strong>{closed ? "Closed" : occupant ? isYou ? `${seat.displayName ?? "You"} (You)` : seat.displayName ?? (seat.botId ? `Bot ${seat.seatIndex + 1}` : occupant) : "Open"}</strong>
                      <small>{closed ? "Closed" : occupant ? seat.ready ? "Ready" : "Not ready" : "Waiting"}</small>
                    </article>
                  );
                })}
              </div>
            </div>
            <div className="phase-card">
              <div className="panel-title">
                <strong>Rules</strong>
                <span>{networkRoom?.settings?.mode ?? "CLASSIC"}</span>
              </div>
              <div className="lobby-rules">
                {lobbyRules.map((rule) => <span key={rule}>{rule}</span>)}
              </div>
              {isHost ? (
                <div className="lobby-settings" aria-label="Lobby game settings">
                  <div className="option-row">
                    <span>Start players</span>
                    <div className="difficulty-options" role="group" aria-label="Lobby start players">
                      {([2, 3, 4] as const).map((playerCount) => (
                        <button
                          key={playerCount}
                          type="button"
                          className={neededPlayers === playerCount ? "selected" : ""}
                          aria-pressed={neededPlayers === playerCount}
                          disabled={playerCount > totalSeats || neededPlayers === playerCount || lobbyPending.settings}
                          onClick={() => onUpdateSettings({ minPlayers: playerCount })}
                        >
                          {playerCount}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="option-row">
                    <span>Open seats</span>
                    <div className="difficulty-options" role="group" aria-label="Lobby open seats">
                      {([2, 3, 4] as const).map((playerCount) => (
                        <button
                          key={playerCount}
                          type="button"
                          className={totalSeats === playerCount ? "selected" : ""}
                          aria-pressed={totalSeats === playerCount}
                          disabled={totalSeats === playerCount || occupiedCount > playerCount || lobbyPending.settings}
                          onClick={() => {
                            onSetPlayerCount(playerCount);
                            onUpdateSettings({ minPlayers: Math.min(neededPlayers, playerCount) as 2 | 3 | 4, maxPlayers: playerCount });
                          }}
                        >
                          {playerCount}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="option-row">
                    <span>Bots</span>
                    <div className="lobby-bot-controls" role="group" aria-label="Lobby bots">
                      <strong>{botSeats.length}/{totalSeats}</strong>
                      <button type="button" onClick={onAddBot} disabled={!canAddBot}>Add Bot</button>
                      <button
                        type="button"
                        onClick={() => {
                          if (lastBotSeat) onRemoveBot(lastBotSeat.seatIndex);
                        }}
                        disabled={!canRemoveBot}
                      >
                        Remove Bot
                      </button>
                    </div>
                  </div>
                  <div className="option-row">
                    <span>Map</span>
                    <div className="difficulty-options" role="group" aria-label="Lobby map">
                      {(["standard", "islands", "continent"] as const).map((mapPreset) => (
                        <button
                          key={mapPreset}
                          type="button"
                          className={lobbyMapPreset === mapPreset ? "selected" : ""}
                          aria-pressed={lobbyMapPreset === mapPreset}
                          disabled={lobbyMapPreset === mapPreset || lobbyPending.settings}
                          onClick={() => {
                            onSetMapPreset(mapPreset);
                            onUpdateSettings({ rules: { ...lobbyRulesState, mapPreset, mapRandomized: true } });
                          }}
                        >
                          {mapPresetLabels[mapPreset]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="option-row">
                    <span>Difficulty</span>
                    <div className="difficulty-options" role="group" aria-label="Lobby bot difficulty">
                      {(["easy", "medium", "hard"] as const).map((difficulty) => (
                        <button
                          key={difficulty}
                          type="button"
                          className={lobbyBotDifficulty === difficulty ? "selected" : ""}
                          aria-pressed={lobbyBotDifficulty === difficulty}
                          disabled={lobbyBotDifficulty === difficulty || lobbyPending.settings}
                          onClick={() => {
                            onSetBotDifficulty(difficulty);
                            onUpdateSettings({ botDifficulty: difficulty });
                          }}
                        >
                          {difficulty}
                        </button>
                      ))}
                    </div>
                  </div>
                  {([
                    ["diceDoubles", "Dice doubles x2"],
                    ["specialCardCostRandomized", "Random special card cost"],
                    ["plight", "Plight on turn 20"],
                  ] as const).map(([rule, label]) => (
                    <label key={rule} className="rule-toggle">
                      <input
                        type="checkbox"
                        checked={Boolean(lobbyRulesState[rule])}
                        disabled={lobbyPending.settings}
                        onChange={(event) => {
                          onSetRuleEnabled(rule, event.currentTarget.checked);
                          onUpdateSettings({ rules: { ...lobbyRulesState, [rule]: event.currentTarget.checked } });
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
};
