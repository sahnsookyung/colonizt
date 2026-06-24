import { seededShuffle } from "./rng.js";
import { resources, type GameRules, type Resource, type ResourceBundle } from "./types.js";

export const classicResourceBankSize = 19;

export const emptyResources = (): ResourceBundle => ({
  timber: 0,
  brick: 0,
  grain: 0,
  fiber: 0,
  ore: 0,
});

export const classicResourceBank = (): ResourceBundle => ({
  timber: classicResourceBankSize,
  brick: classicResourceBankSize,
  grain: classicResourceBankSize,
  fiber: classicResourceBankSize,
  ore: classicResourceBankSize,
});

export const roadCost = (): ResourceBundle => ({
  ...emptyResources(),
  timber: 1,
  brick: 1,
});

export const settlementCost = (): ResourceBundle => ({
  ...emptyResources(),
  timber: 1,
  brick: 1,
  grain: 1,
  fiber: 1,
});

export const cityCost = (): ResourceBundle => ({
  ...emptyResources(),
  grain: 2,
  ore: 3,
});

export const defaultSpecialCardCost = (): ResourceBundle => ({
  ...emptyResources(),
  fiber: 1,
  grain: 1,
  ore: 1,
});

export const randomizedSpecialCardCost = (seed: string): ResourceBundle => {
  const selected = seededShuffle<Resource>(resources, `${seed}:special-card-cost`).slice(0, 3);
  return selected.reduce((bundle, resource) => {
    bundle[resource] += 1;
    return bundle;
  }, emptyResources());
};

export const specialCardCost = (rules?: Pick<GameRules, "specialCardCost">): ResourceBundle => ({
  ...defaultSpecialCardCost(),
  ...(rules?.specialCardCost ?? {}),
});

export const resourceBundle = (resource: keyof ResourceBundle, count: number): ResourceBundle => ({
  ...emptyResources(),
  [resource]: count,
});

export const addResources = (left: ResourceBundle, right: Partial<ResourceBundle>): ResourceBundle => {
  const next = { ...left };
  for (const resource of resources) {
    next[resource] += right[resource] ?? 0;
  }
  return next;
};

export const subtractResources = (left: ResourceBundle, right: ResourceBundle): ResourceBundle => {
  const next = { ...left };
  for (const resource of resources) {
    next[resource] -= right[resource];
  }
  return next;
};

export const normalizedResources = (bundle?: Partial<ResourceBundle>): ResourceBundle => ({
  ...emptyResources(),
  ...(bundle ?? {}),
});

export const hasResources = (left: ResourceBundle, right: ResourceBundle): boolean =>
  resources.every((resource) => left[resource] >= right[resource]);

export const resourceCount = (bundle: ResourceBundle): number =>
  resources.reduce((sum, resource) => sum + bundle[resource], 0);

export const isNonNegativeBundle = (bundle: ResourceBundle): boolean =>
  resources.every((resource) => Number.isInteger(bundle[resource]) && bundle[resource] >= 0);
