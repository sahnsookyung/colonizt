import {
  applyCommand,
  assertInvariants,
  getLegalActions,
  type EdgeId,
  type GameCommand,
  type GameState,
  type PlayerId,
} from "@colonizt/game-core";
import { completeSetup, createDemoGame, withResources } from "@colonizt/test-utils";

interface TimedCommand {
  receivedAt: number;
  command: GameCommand;
}

let state = completeSetup(createDemoGame("rush-sim")).state;
for (const playerId of state.playerOrder) {
  state = withResources(state, playerId, { timber: 40, brick: 40, grain: 40, fiber: 40, ore: 40 });
}

const commands: TimedCommand[] = [];
for (let index = 0; index < 100; index += 1) {
  const playerId = state.playerOrder[index % state.playerOrder.length] as PlayerId;
  const roadAction = getLegalActions({ ...state, phase: { type: "ACTION_PHASE", activePlayerId: playerId } } as GameState, playerId)
    .find((action) => action.type === "BUILD_ROAD");
  const edgeId = roadAction?.type === "BUILD_ROAD" ? roadAction.edges[index % Math.max(roadAction.edges.length, 1)] : undefined;
  if (edgeId) {
    commands.push({
      receivedAt: (index * 17) % 53,
      command: { type: "BUILD_ROAD", playerId, edgeId: edgeId as EdgeId },
    });
  }
}

let accepted = 0;
let rejected = 0;
for (const item of commands.sort((left, right) => left.receivedAt - right.receivedAt)) {
  const command = item.command;
  if (!("playerId" in command)) continue;
  const commandState = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: command.playerId } } as GameState;
  const result = applyCommand(commandState, command);
  if (!result.ok) {
    rejected += 1;
    continue;
  }
  state = result.value.nextState;
  accepted += 1;
}

const invariant = assertInvariants(state);
if (!invariant.ok) throw new Error(invariant.error.message);
const ownedEdges = Object.keys(state.roads);
const duplicateOwnership = ownedEdges.length !== new Set(ownedEdges).size;
if (duplicateOwnership) throw new Error("Duplicate edge ownership detected");

console.log(JSON.stringify({
  submitted: commands.length,
  accepted,
  rejected,
  duplicateOwnership,
  finalRoads: ownedEdges.length,
  invariant: "ok",
}, null, 2));
