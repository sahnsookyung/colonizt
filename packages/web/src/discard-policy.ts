import { hasResources, resourceCount, type Resource, type ResourceBundle } from "@colonizt/game-core";

export const canSubmitDiscardDraft = (
  holdings: ResourceBundle | undefined,
  draft: ResourceBundle,
  requiredCount: number | undefined,
): boolean => requiredCount !== undefined
  && resourceCount(draft) === requiredCount
  && Boolean(holdings && hasResources(holdings, draft));

export const incrementDiscardDraft = (
  holdings: ResourceBundle | undefined,
  draft: ResourceBundle,
  requiredCount: number | undefined,
  resource: Resource,
): ResourceBundle => {
  if (!holdings || requiredCount === undefined) return draft;
  if (holdings[resource] <= draft[resource] || resourceCount(draft) >= requiredCount) return draft;
  return { ...draft, [resource]: draft[resource] + 1 };
};
