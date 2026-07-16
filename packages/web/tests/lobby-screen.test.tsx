// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicRoomPayload } from "@colonizt/protocol";
import { LobbyScreen } from "../src/components/lobby-screen.js";
import { defaultMatchOptions } from "../src/match-options.js";

afterEach(cleanup);

describe("LobbyScreen", () => {
  it("surfaces the blocking player and sends host readiness and rule edits", () => {
    const onReady = vi.fn();
    const onSetBotDifficulty = vi.fn();
    const onSetRuleEnabled = vi.fn();
    const onUpdateSettings = vi.fn();
    const room = {
      id: "room_lobby",
      code: "LOBBY1",
      status: "LOBBY",
      hostUserId: "host",
      settings: { mode: "CLASSIC", minPlayers: 2, maxPlayers: 3, botDifficulty: "medium", rules: {} },
      seats: [
        { seatIndex: 0, userId: "host", displayName: "Host", ready: true, connected: true },
        { seatIndex: 1, userId: "ready-guest", displayName: "Ready Guest", ready: true, connected: true },
        { seatIndex: 2, userId: "guest", displayName: "Guest", ready: false, connected: true },
      ],
      spectatorCount: 0,
      events: [],
    } as unknown as PublicRoomPayload;

    render(<LobbyScreen
      networkRoom={room}
      canCopyInvite
      humanPlayerId="host"
      matchOptions={defaultMatchOptions}
      networkStatus="Online LOBBY1"
      error={null}
      pendingCommandCount={0}
      reconnectRetryAt={null}
      nowMs={0}
      networkSocketOpen
      lobbyPending={{ ready: false, settings: false, start: false, name: false }}
      playerDisplayName="Host"
      onPlayerDisplayNameChange={vi.fn()}
      onSaveDisplayName={vi.fn()}
      onReturnToSetup={vi.fn()}
      onCopyInvite={vi.fn()}
      onRetryNow={vi.fn()}
      onReady={onReady}
      onStart={vi.fn()}
      onUpdateSettings={onUpdateSettings}
      onSetPlayerCount={vi.fn()}
      onSetMapPreset={vi.fn()}
      onSetBotDifficulty={onSetBotDifficulty}
      onSetRuleEnabled={onSetRuleEnabled}
      onAddBot={vi.fn()}
      onRemoveBot={vi.fn()}
    />);

    expect(screen.getByText("Waiting on Guest")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unready" }));
    fireEvent.click(screen.getByRole("button", { name: "hard" }));
    fireEvent.click(screen.getByLabelText("Dice doubles x2"));

    expect(onReady).toHaveBeenCalledWith(false);
    expect(onSetBotDifficulty).toHaveBeenCalledWith("hard");
    expect(onUpdateSettings).toHaveBeenCalledWith({ botDifficulty: "hard" });
    expect(onSetRuleEnabled).toHaveBeenCalledWith("diceDoubles", true);
    expect(onUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({ rules: expect.objectContaining({ diceDoubles: true }) }));
  });
});
