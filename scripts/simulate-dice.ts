import { rollSeededDice } from "@colonizt/game-core";

const games = Number(process.env.DICE_GAMES ?? 10_000);
const rollsPerGame = Number(process.env.ROLLS_PER_GAME ?? 80);
const counts = new Map<number, number>();
let total = 0;

for (let game = 0; game < games; game += 1) {
  for (let roll = 0; roll < rollsPerGame; roll += 1) {
    const { dice } = rollSeededDice(`dice-${game}`, roll * 2);
    const sum = dice[0] + dice[1];
    counts.set(sum, (counts.get(sum) ?? 0) + 1);
    total += 1;
  }
}

const expectedWeights: Record<number, number> = {
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
  7: 6,
  8: 5,
  9: 4,
  10: 3,
  11: 2,
  12: 1,
};

let chiSquare = 0;
const distribution = Object.fromEntries(
  Object.entries(expectedWeights).map(([sumText, weight]) => {
    const sum = Number(sumText);
    const observed = counts.get(sum) ?? 0;
    const expected = (weight / 36) * total;
    chiSquare += (observed - expected) ** 2 / expected;
    return [sum, { observed, expected: Math.round(expected), observedPct: observed / total }];
  }),
);

console.log(JSON.stringify({ games, rollsPerGame, total, chiSquare, distribution }, null, 2));
