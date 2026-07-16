import {
  cityCost,
  hasResources,
  roadCost,
  settlementCost,
  type GameState,
  type PlayerId,
} from "@colonizt/game-core";
import { formatCost } from "./components/game-ui.js";

export type BuildMode = "road" | "settlement" | "city";

export const buildUnavailableReason = ({
  state,
  mode,
  humanPlayerId,
  isHumanActive,
  activeName,
}: {
  state: GameState;
  mode: BuildMode;
  humanPlayerId: PlayerId;
  isHumanActive: boolean;
  activeName?: string;
}): string => {
  if (state.phase.type === "GAME_OVER") return "The game is over.";
  if (state.phase.type !== "ACTION_PHASE") return "Available during your action phase.";
  if (!isHumanActive) return `${activeName ?? "Another player"} is taking a turn.`;
  const humanPlayer = state.players[humanPlayerId];
  if (!humanPlayer) return "Player hand is unavailable.";
  if (mode === "road") {
    if (!hasResources(humanPlayer.resources, roadCost())) return `Need ${formatCost(roadCost())}.`;
    return "No legal road edges. Build from your road network.";
  }
  if (mode === "settlement") {
    if (!hasResources(humanPlayer.resources, settlementCost())) return `Need ${formatCost(settlementCost())}.`;
    return "No legal settlement corners. Keep distance from other houses and connect to your road.";
  }
  if (!hasResources(humanPlayer.resources, cityCost())) return `Need ${formatCost(cityCost())}.`;
  if (!Object.values(state.buildings).some((building) => building.owner === humanPlayerId && building.type === "settlement")) {
    return "No settlements available to upgrade.";
  }
  return "No legal city upgrades are currently available.";
};

export interface ActionHintInput {
  state: GameState;
  humanPlayerId: PlayerId;
  isHumanActive: boolean;
  activeName?: string;
  discardCount?: number;
  activeKnight: boolean;
  activeRoadBuilding: boolean;
  roadsRemaining: number;
  activeMonopoly: boolean;
  activeYearOfPlenty: boolean;
  stagedTradeRole?: "offerer" | "recipient";
  pendingSetup: boolean;
  canBuild: boolean;
}

export const selectActionHint = (input: ActionHintInput): { title: string; detail: string } => {
  const { state } = input;
  if (state.phase.type === "GAME_OVER") {
    return { title: "Game over", detail: `${state.players[state.phase.winnerId]?.name ?? state.phase.winnerId} reached the victory target.` };
  }
  if (state.phase.type === "DISCARDING") return { title: "Discard", detail: `Choose ${input.discardCount ?? 0} resources.` };
  if (state.phase.type === "MOVING_THIEF") return { title: "Move robber", detail: "Choose a destination and steal target if available." };
  if (!input.isHumanActive) return { title: "Waiting", detail: `${input.activeName ?? "Opponent"} is taking a turn.` };
  if (input.activeKnight) return { title: "Play Knight", detail: "Choose a robber destination, then choose who to steal from if available." };
  if (input.activeRoadBuilding) {
    return { title: "Road Building", detail: `Choose ${input.roadsRemaining} free road${input.roadsRemaining === 1 ? "" : "s"} on glowing edges.` };
  }
  if (input.activeMonopoly) return { title: "Monopoly", detail: "Choose one resource type to collect from every opponent." };
  if (input.activeYearOfPlenty) return { title: "Year of Plenty", detail: "Choose two resources from the bank." };
  if (input.stagedTradeRole === "offerer") return { title: "Choose trade partner", detail: "Pick a player who wants to accept, or cancel the offer." };
  if (input.stagedTradeRole === "recipient") return { title: "Answer trade", detail: "Mark whether you want to accept before the offer expires." };
  if (state.phase.type === "SETUP_PLACEMENT" && input.pendingSetup) {
    return { title: "Place setup road", detail: "Pick a glowing brown edge attached to the new settlement." };
  }
  if (state.phase.type === "SETUP_PLACEMENT") return { title: "Place setup settlement", detail: "Pick a glowing corner, then choose its road edge." };
  if (state.phase.type === "WAITING_FOR_ROLL") return { title: "Roll dice", detail: "Roll for matching numbered tiles." };
  if (input.canBuild) return { title: "Build or trade", detail: "Choose a build mode, use glowing spots, trade, or end." };
  return { title: "Trade or end", detail: "Trade if eligible, or end the turn." };
};
