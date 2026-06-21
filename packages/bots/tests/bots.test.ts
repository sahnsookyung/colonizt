import { describe, expect, it } from "vitest";
import { completeSetup, createDemoGame, playBotGame, withResources } from "@colonizt/demo-state";
import { applyCommand, cityCost, emptyResources, specialCardCost, type BotDifficulty, type DevelopmentCardType, type MapPreset, type PlayerId } from "@colonizt/game-core";
import { botStateFingerprint, chooseBotCommand, createBotView, evaluateState, evaluateTrade, greedyBot, hasEquivalentBotTradeOffer, roadOpensSettlementAccess, scoreBotCandidates, scoreTradeResponder } from "../src/index.js";

const tournamentPlayerIds = ["p1", "p2", "p3", "p4"] as const satisfies readonly PlayerId[];
const alternateMapPresets = ["islands", "continent"] as const satisfies readonly MapPreset[];

const rotatedDifficulties = (index: number): Record<PlayerId, BotDifficulty> => {
  const tiers: BotDifficulty[] = ["hard", "medium", "easy", "easy"];
  return Object.fromEntries(tournamentPlayerIds.map((playerId, offset) => [playerId, tiers[(index + offset) % tiers.length]!])) as Record<PlayerId, BotDifficulty>;
};

describe("bot policies", () => {
  it("fingerprints branch-relevant state beyond event sequence and phase", () => {
    let state = completeSetup(createDemoGame("fingerprint")).state;
    state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p1" } };
    const baseline = botStateFingerprint(state, "p1");
    const changed = withResources(state, "p1", { ore: 2 });
    changed.eventSeq = state.eventSeq;
    changed.turn = state.turn;
    changed.phase = state.phase;

    expect(botStateFingerprint(changed, "p1")).not.toBe(baseline);
  });

  it("does not change decisions when opponent hidden hands change", () => {
    let state = completeSetup(createDemoGame("hidden-info")).state;
    const rolled = applyCommand(state, { type: "ROLL_DICE", playerId: "p1" });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error("Expected dice roll to enter action phase");
    state = rolled.value.nextState;
    state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p2" } };
    const baseline = chooseBotCommand(createBotView(state, "p2", greedyBot.profile), greedyBot.profile, () => "trade-a");
    const changed = withResources(state, "p1", { timber: 99, brick: 99, grain: 99, fiber: 99, ore: 99 });
    const afterHiddenChange = chooseBotCommand(createBotView(changed, "p2", greedyBot.profile), greedyBot.profile, () => "trade-a");
    expect(afterHiddenChange).toEqual(baseline);
  });

  it("does not change special-card buy scoring when hidden deck order changes", () => {
    let state = completeSetup(createDemoGame("hidden-deck-order", { botDifficulty: "hard" })).state;
    const rolled = applyCommand(state, { type: "ROLL_DICE", playerId: "p1" });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error("Expected dice roll to enter action phase");
    state = withResources({ ...rolled.value.nextState, phase: { type: "ACTION_PHASE", activePlayerId: "p1" } }, "p1", specialCardCost(rolled.value.nextState.config.rules));
    state.players.p1!.resources.timber = 0;
    state.players.p1!.resources.brick = 0;

    const nextDecks: DevelopmentCardType[][] = [
      ["VICTORY_POINT", "KNIGHT", "ROAD_BUILDING", "MONOPOLY", "YEAR_OF_PLENTY"],
      ["KNIGHT", "YEAR_OF_PLENTY", "MONOPOLY", "ROAD_BUILDING", "VICTORY_POINT"],
    ];
    const buyScores = nextDecks.map((deck) => {
      const candidateState = structuredClone(state);
      candidateState.developmentDeck = deck;
      candidateState.developmentDeckCursor = 0;
      const candidates = scoreBotCandidates(createBotView(candidateState, "p1", greedyBot.profile, "hard"), greedyBot.profile, () => "hidden-deck-trade");
      return candidates.find((candidate) => candidate.command.type === "BUY_SPECIAL_CARD")?.score;
    });

    expect(buyScores[0]).toBeDefined();
    expect(buyScores[1]).toBe(buyScores[0]);
  });

  it("ranks an immediate winning city first for hard bots", () => {
    let state = completeSetup(createDemoGame("winning-city", { botDifficulty: "hard" })).state;
    const rolled = applyCommand(state, { type: "ROLL_DICE", playerId: "p1" });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error("Expected dice roll to enter action phase");
    state = withResources({ ...rolled.value.nextState, phase: { type: "ACTION_PHASE", activePlayerId: "p1" } }, "p1", cityCost());
    state.players.p1!.score = state.config.victoryPoints - 1;

    const candidates = scoreBotCandidates(createBotView(state, "p1", greedyBot.profile, "hard"), greedyBot.profile, () => "winning-city-trade");
    expect(candidates[0]?.command.type).toBe("UPGRADE_CITY");
  });

  it("only treats roads as settlement-access progress when they open a new legal site", () => {
    let state = completeSetup(createDemoGame("road-access-progress", { botDifficulty: "hard" })).state;
    state = withResources({ ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p1" } }, "p1", { timber: 10, brick: 10, grain: 10, fiber: 10, ore: 10 });

    expect(roadOpensSettlementAccess(state, "p1", "e23")).toBe(false);

    state.roads.e23 = "p1";
    expect(roadOpensSettlementAccess(state, "p1", "e20")).toBe(true);
  });

  it("keeps true VP monotonic in the utility proxy", () => {
    let state = completeSetup(createDemoGame("vp-monotonic")).state;
    state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p1" } };
    const baseline = evaluateState(createBotView(state, "p1", greedyBot.profile, "hard"));
    state.players.p1!.score += 1;

    expect(evaluateState(createBotView(state, "p1", greedyBot.profile, "hard"))).toBeGreaterThan(baseline);
  });

  it("produces normalized softmax probabilities and sharper hard choices", () => {
    let state = completeSetup(createDemoGame("softmax-shape")).state;
    state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p1" } };
    state = withResources(state, "p1", { timber: 4, brick: 4, grain: 4, fiber: 4, ore: 4 });

    const easy = scoreBotCandidates(createBotView(state, "p1", greedyBot.profile, "easy"), greedyBot.profile, () => "softmax-shape-trade");
    const hard = scoreBotCandidates(createBotView(state, "p1", greedyBot.profile, "hard"), greedyBot.profile, () => "softmax-shape-trade");
    const probabilitySum = (candidates: ReturnType<typeof scoreBotCandidates>) =>
      candidates.reduce((sum, candidate) => sum + candidate.probability, 0);

    expect(probabilitySum(easy)).toBeCloseTo(1, 8);
    expect(probabilitySum(hard)).toBeCloseTo(1, 8);
    expect(hard[0]?.probability ?? 0).toBeGreaterThan(easy[0]?.probability ?? 1);
  });

  it("keeps trade temperament stable for equivalent offers during the same turn", () => {
    let state = completeSetup(createDemoGame("stable-trade-temperament", { botDifficulty: "hard" })).state;
    state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p1" } };
    state = withResources(state, "p1", { timber: 1 });
    state = withResources(state, "p2", { ore: 1 });
    const offered = { ...emptyResources(), timber: 1 };
    const requested = { ...emptyResources(), ore: 1 };
    const result = applyCommand(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "stable", offered, requested, recipients: "ANY" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected trade offer to open");

    const view = createBotView(result.value.nextState, "p2", greedyBot.profile, "hard");
    const trade = result.value.nextState.trades.stable!;
    const baseline = evaluateTrade(view, trade, greedyBot.profile, "hard");
    expect(evaluateTrade(view, trade, greedyBot.profile, "hard")).toBe(baseline);
    expect(evaluateTrade(view, { ...trade, id: "stable-copy" }, greedyBot.profile, "hard")).toBe(baseline);
  });

  it("shares trade responder scoring for server and local automation", () => {
    let state = completeSetup(createDemoGame("shared-trade-score", { botDifficulty: "hard" })).state;
    state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p1" } };
    state = withResources(state, "p1", { timber: 1 });
    state = withResources(state, "p2", { ore: 1 });
    const result = applyCommand(state, {
      type: "OFFER_TRADE",
      playerId: "p1",
      tradeId: "shared-score",
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected trade offer to open");

    const trade = result.value.nextState.trades["shared-score"]!;
    const score = scoreTradeResponder(result.value.nextState, trade, "p2", greedyBot.profile, "hard");
    expect(Number.isFinite(score)).toBe(true);
    expect(scoreTradeResponder(result.value.nextState, trade, "p2", greedyBot.profile, "hard")).toBe(score);
  });

  it("only chooses commands accepted by the engine preview path", () => {
    for (let index = 0; index < 40; index += 1) {
      let state = completeSetup(createDemoGame(`legal-preview-${index}`, { botDifficulty: "medium" })).state;
      state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p2" } };
      state = withResources(state, "p2", { timber: 2, brick: 2, grain: 2, fiber: 2, ore: 2 });
      const command = chooseBotCommand(createBotView(state, "p2", greedyBot.profile), greedyBot.profile, () => `preview-trade-${index}`);
      expect(command).toBeDefined();
      if (!command) throw new Error("Expected bot to generate a legal preview command");
      expect(applyCommand(state, command).ok).toBe(true);
    }
  }, 20_000);

  it("uses engine-provided Road Building sequences", () => {
    let state = completeSetup(createDemoGame("road-building-bot-sequences", { botDifficulty: "hard" })).state;
    const rolled = applyCommand(state, { type: "ROLL_DICE", playerId: "p1" });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error("Expected dice roll to enter action phase");
    state = rolled.value.nextState;
    state.players.p1!.resources = emptyResources();
    state.players.p1!.developmentCards = [{ id: "road-card", type: "ROAD_BUILDING", ownerId: "p1", boughtTurn: state.turn - 1 }];
    state.players.p1!.specialCards = 1;
    const roadBuildingAction = createBotView(state, "p1", greedyBot.profile, "hard").legalActions.find((action) => action.type === "PLAY_ROAD_BUILDING");
    expect(roadBuildingAction?.type).toBe("PLAY_ROAD_BUILDING");
    if (roadBuildingAction?.type !== "PLAY_ROAD_BUILDING") throw new Error("Expected Road Building to be legal");

    const command = chooseBotCommand(createBotView(state, "p1", greedyBot.profile, "hard"), greedyBot.profile, () => "road-building-trade");
    expect(command?.type).toBe("PLAY_ROAD_BUILDING");
    if (command?.type !== "PLAY_ROAD_BUILDING") throw new Error("Expected bot to play Road Building");
    expect(command.edgeIds).toHaveLength(roadBuildingAction.requiredRoadCount);
    expect(roadBuildingAction.options.some((option) =>
      option.length === command.edgeIds.length && option.every((edgeId, index) => edgeId === command.edgeIds[index]),
    )).toBe(true);
    expect(applyCommand(state, command).ok).toBe(true);
  });

  it("generates legal Road Building sequences on alternate maps", () => {
    for (const mapPreset of alternateMapPresets) {
      let state = completeSetup(createDemoGame(`road-building-${mapPreset}`, { botDifficulty: "hard", rules: { mapPreset, mapRandomized: true } })).state;
      state = {
        ...state,
        phase: { type: "ACTION_PHASE", activePlayerId: "p1" },
      };
      state.players.p1!.resources = emptyResources();
      state.players.p1!.developmentCards = [{ id: `road-card-${mapPreset}`, type: "ROAD_BUILDING", ownerId: "p1", boughtTurn: state.turn - 1 }];
      state.players.p1!.specialCards = 1;

      const candidate = scoreBotCandidates(createBotView(state, "p1", greedyBot.profile, "hard"), greedyBot.profile, () => `road-building-${mapPreset}`)
        .find((item) => item.command.type === "PLAY_ROAD_BUILDING");
      expect(candidate?.command.type).toBe("PLAY_ROAD_BUILDING");
      if (candidate?.command.type !== "PLAY_ROAD_BUILDING") throw new Error(`Expected Road Building candidate on ${mapPreset}`);
      expect(applyCommand(state, candidate.command).ok).toBe(true);
    }
  });

  it("generates legal maritime trades on alternate maps", () => {
    for (const mapPreset of alternateMapPresets) {
      let state = completeSetup(createDemoGame(`maritime-${mapPreset}`, { botDifficulty: "hard", rules: { mapPreset, mapRandomized: true } })).state;
      state = {
        ...state,
        phase: { type: "ACTION_PHASE", activePlayerId: "p1" },
      };
      state.players.p1!.resources = { ...emptyResources(), timber: 4 };

      const candidate = scoreBotCandidates(createBotView(state, "p1", greedyBot.profile, "hard"), greedyBot.profile, () => `maritime-${mapPreset}`)
        .find((item) => item.command.type === "MARITIME_TRADE");
      expect(candidate?.command.type).toBe("MARITIME_TRADE");
      if (candidate?.command.type !== "MARITIME_TRADE") throw new Error(`Expected maritime trade candidate on ${mapPreset}`);
      expect(applyCommand(state, candidate.command).ok).toBe(true);
    }
  });

  it("chooses legal modal commands for discard and thief phases", () => {
    let state = completeSetup(createDemoGame("bot-modal", { botDifficulty: "hard" })).state;
    state = withResources(state, "p2", { timber: 8 });
    state.phase = { type: "DISCARDING", activePlayerId: "p2", rollerId: "p1", pending: { p2: 4 }, submitted: {} };
    const discard = chooseBotCommand(createBotView(state, "p2", greedyBot.profile, "hard"), greedyBot.profile);
    expect(discard?.type).toBe("DISCARD_RESOURCES");
    expect(discard && applyCommand(state, discard).ok).toBe(true);

    state.phase = { type: "MOVING_THIEF", activePlayerId: "p1", rollerId: "p1", reason: "ROLL_7" };
    const move = chooseBotCommand(createBotView(state, "p1", greedyBot.profile, "hard"), greedyBot.profile);
    expect(move?.type).toBe("MOVE_THIEF");
    expect(move && applyCommand(state, move).ok).toBe(true);
  });

  it("chooses legal thief moves on alternate maps", () => {
    for (const mapPreset of alternateMapPresets) {
      let state = completeSetup(createDemoGame(`bot-thief-${mapPreset}`, { botDifficulty: "hard", rules: { mapPreset, mapRandomized: true } })).state;
      state = withResources(state, "p2", { timber: 1 });
      state.phase = { type: "MOVING_THIEF", activePlayerId: "p1", rollerId: "p1", reason: "ROLL_7" };

      const move = chooseBotCommand(createBotView(state, "p1", greedyBot.profile, "hard"), greedyBot.profile);
      expect(move?.type).toBe("MOVE_THIEF");
      expect(move && applyCommand(state, move).ok).toBe(true);
    }
  });

  it("resolves staged trades on alternate maps", () => {
    for (const mapPreset of alternateMapPresets) {
      let state = completeSetup(createDemoGame(`staged-trade-${mapPreset}`, { botDifficulty: "hard", rules: { mapPreset, mapRandomized: true } })).state;
      state = {
        ...state,
        phase: { type: "ACTION_PHASE", activePlayerId: "p1" },
      };
      state = withResources(state, "p1", { timber: 1 });
      state = withResources(state, "p2", { ore: 1 });
      const offered = applyCommand(state, {
        type: "OFFER_TRADE",
        playerId: "p1",
        tradeId: `staged-${mapPreset}`,
        offered: { ...emptyResources(), timber: 1 },
        requested: { ...emptyResources(), ore: 1 },
        recipients: ["p2"],
      });
      expect(offered.ok).toBe(true);
      if (!offered.ok) throw new Error(`Expected staged trade offer on ${mapPreset}`);

      const trade = offered.value.nextState.trades[`staged-${mapPreset}`]!;
      expect(Number.isFinite(scoreTradeResponder(offered.value.nextState, trade, "p2", greedyBot.profile, "hard"))).toBe(true);
      const responded = applyCommand(offered.value.nextState, { type: "RESPOND_TRADE", playerId: "p2", tradeId: trade.id, response: "WANTS_ACCEPT" });
      expect(responded.ok).toBe(true);
      if (!responded.ok) throw new Error(`Expected staged trade response on ${mapPreset}`);
      const finalized = applyCommand(responded.value.nextState, { type: "FINALIZE_TRADE", playerId: "p1", tradeId: trade.id, toPlayerId: "p2" });
      expect(finalized.ok).toBe(true);
    }
  });

  it("uses deterministic softmax choices for the same state and salt", () => {
    let state = completeSetup(createDemoGame("softmax-stable", { botDifficulty: "hard" })).state;
    state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p2" } };
    state = withResources(state, "p2", { timber: 4, brick: 4, grain: 4, fiber: 4, ore: 4 });
    const first = chooseBotCommand(createBotView(state, "p2", greedyBot.profile, "hard"), greedyBot.profile, () => "softmax-trade");
    const second = chooseBotCommand(createBotView(state, "p2", greedyBot.profile, "hard"), greedyBot.profile, () => "softmax-trade");
    expect(second).toEqual(first);
  });

  it("concludes representative all-bot simulations under test-only turn adjudication", () => {
    for (let index = 0; index < 16; index += 1) {
      const played = playBotGame(`adjudicated-${index}`, 700, {
        botDifficulty: "medium",
        rules: { maxTurns: 50, maxTurnAdjudication: "leader", mapRandomized: true },
      });
      expect(played.invalidCommands).toBe(0);
      expect(played.state.phase.type).toBe("GAME_OVER");
    }
  }, 60_000);

  it("supports configurable bot counts across map presets", () => {
    const scenarios: Array<{ playerCount: number; mapPreset: MapPreset }> = [
      { playerCount: 2, mapPreset: "standard" },
      { playerCount: 3, mapPreset: "islands" },
      { playerCount: 4, mapPreset: "continent" },
      { playerCount: 6, mapPreset: "islands" },
      { playerCount: 8, mapPreset: "continent" },
    ];
    for (const { playerCount, mapPreset } of scenarios) {
      const playerIds = Array.from({ length: playerCount }, (_, index) => `p${index + 1}` as PlayerId);
      const played = playBotGame(`preset-count-${mapPreset}-${playerCount}`, 900, {
        playerIds,
        botDifficulty: "medium",
        botProfiles: Object.fromEntries(playerIds.map((playerId) => [playerId, "greedy" as const])),
        rules: { mapPreset, mapRandomized: true, maxTurns: 55, maxTurnAdjudication: "leader" },
      });
      expect(played.invalidCommands).toBe(0);
      expect(played.state.phase.type).toBe("GAME_OVER");
    }
  }, 60_000);

  it("runs mixed-difficulty tournament samples with stronger bots winning more often", () => {
    const wins = new Map<BotDifficulty, number>();
    const entries = new Map<BotDifficulty, number>();
    for (let index = 0; index < 24; index += 1) {
      const botDifficulties = rotatedDifficulties(index);
      for (const difficulty of Object.values(botDifficulties)) entries.set(difficulty, (entries.get(difficulty) ?? 0) + 1);
      const played = playBotGame(`difficulty-tournament-${index}`, 900, {
        botDifficulties,
        botProfiles: { p1: "greedy", p2: "greedy", p3: "greedy", p4: "greedy" },
        rules: { maxTurns: 55, maxTurnAdjudication: "leader", mapRandomized: true },
      });
      expect(played.invalidCommands).toBe(0);
      expect(played.state.phase.type).toBe("GAME_OVER");
      if (played.state.phase.type === "GAME_OVER") {
        const difficulty = botDifficulties[played.state.phase.winnerId];
        wins.set(difficulty, (wins.get(difficulty) ?? 0) + 1);
      }
    }

    const rate = (difficulty: BotDifficulty) => (wins.get(difficulty) ?? 0) / (entries.get(difficulty) ?? 1);
    expect(entries.get("hard")).toBeGreaterThan(0);
    expect(entries.get("medium")).toBeGreaterThan(0);
    expect(entries.get("easy")).toBeGreaterThan(0);
    expect(rate("hard")).toBeGreaterThan(rate("medium"));
    expect(rate("medium")).toBeGreaterThan(rate("easy"));
  }, 120_000);

  it("does not repeat an equivalent bot trade after it has been cancelled", () => {
    const candidate = Array.from({ length: 80 }, (_, index) => {
      let state = completeSetup(createDemoGame(`duplicate-bot-offer-${index}`, { botDifficulty: "medium" })).state;
      state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p2" } };
      state = withResources(state, "p2", { timber: 3, brick: 0, grain: 0, fiber: 0, ore: 0 });
      const command = chooseBotCommand(createBotView(state, "p2", greedyBot.profile), greedyBot.profile, () => `trade-${index}`);
      return command?.type === "OFFER_TRADE" ? { state, command } : undefined;
    }).find((item): item is NonNullable<typeof item> => Boolean(item));

    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Expected at least one generated bot trade offer");

    const offered = applyCommand(candidate.state, candidate.command);
    expect(offered.ok).toBe(true);
    if (!offered.ok) throw new Error("Expected generated bot trade offer to be accepted");
    const cancelled = applyCommand(offered.value.nextState, { type: "CANCEL_TRADE", playerId: "p2", tradeId: candidate.command.tradeId });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error("Expected generated bot trade offer to be cancelable");

    const nextView = createBotView(cancelled.value.nextState, "p2", greedyBot.profile);
    const next = chooseBotCommand(nextView, greedyBot.profile, () => "duplicate");
    expect(next?.type === "OFFER_TRADE" && hasEquivalentBotTradeOffer(nextView, next)).toBe(false);
  });
});
