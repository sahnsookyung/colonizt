import {
  emptyResources,
  resources,
  type DevelopmentCard,
  type GameEvent,
  type Resource,
  type ResourceBundle,
} from "@colonizt/game-core";

export const developmentCardTypes: DevelopmentCard["type"][] = [
  "KNIGHT",
  "VICTORY_POINT",
  "MONOPOLY",
  "YEAR_OF_PLENTY",
  "ROAD_BUILDING",
];

export const summarizeResourceDraws = (events: readonly GameEvent[]): Array<{ resource: Resource; count: number }> => {
  const totals = emptyResources();
  const add = (bundle?: Partial<ResourceBundle>) => {
    if (!bundle) return;
    for (const resource of resources) totals[resource] += bundle[resource] ?? 0;
  };
  for (const event of events) {
    if (event.type === "RESOURCES_PRODUCED") Object.values(event.gains).forEach(add);
    if (event.type === "SETUP_PLACED") add(event.startingResources);
    if (event.type === "YEAR_OF_PLENTY_PLAYED") {
      for (const resource of event.resources) totals[resource] += 1;
    }
    if (event.type === "MONOPOLY_PLAYED") totals[event.resource] += Object.values(event.collected).reduce((sum, count) => sum + count, 0);
    if (event.type === "MARITIME_TRADED") totals[event.requested] += 1;
    if (event.type === "TRADE_ACCEPTED") {
      add(event.offered);
      add(event.requested);
    }
    if (event.type === "THIEF_MOVED" && event.stolenResource) totals[event.stolenResource] += 1;
  }
  return resources.map((resource) => ({ resource, count: totals[resource] }));
};

export const summarizeDevelopmentDraws = (events: readonly GameEvent[]): Array<{ type: DevelopmentCard["type"]; count: number }> => {
  const counts = Object.fromEntries(developmentCardTypes.map((type) => [type, 0])) as Record<DevelopmentCard["type"], number>;
  for (const event of events) {
    if (event.type === "SPECIAL_CARD_BOUGHT" && event.cardType && event.cardType in counts) counts[event.cardType] += 1;
  }
  return developmentCardTypes.map((type) => ({ type, count: counts[type] }));
};
