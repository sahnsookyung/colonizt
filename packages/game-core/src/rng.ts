const hashString = (input: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const mulberry32 = (seed: number): number => {
  let value = (seed + 0x6d2b79f5) >>> 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

export const randomFloatAt = (seed: string, index: number): number => mulberry32(hashString(`${seed}:${index}`));

export const randomIntAt = (seed: string, index: number, maxExclusive: number): number =>
  Math.floor(randomFloatAt(seed, index) * maxExclusive);

export const rollSeededDice = (seed: string, rngIndex: number): { dice: [number, number]; nextIndex: number } => {
  const first = randomIntAt(seed, rngIndex, 6) + 1;
  const second = randomIntAt(seed, rngIndex + 1, 6) + 1;
  return { dice: [first, second], nextIndex: rngIndex + 2 };
};

export const seededShuffle = <T>(items: readonly T[], seed: string): T[] => {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIntAt(seed, index, index + 1);
    const current = next[index] as T;
    next[index] = next[swapIndex] as T;
    next[swapIndex] = current;
  }
  return next;
};
