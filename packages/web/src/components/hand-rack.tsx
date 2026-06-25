import { resources, resourceCount, type DevelopmentCard, type DevelopmentCardType, type Resource, type ResourceBundle } from "@colonizt/game-core";
import { DevelopmentCardIcon, ResourceCard, resourceLabels } from "./game-ui.js";

export interface DevelopmentCardGroupView {
  type: DevelopmentCardType;
  cards: DevelopmentCard[];
  primary: DevelopmentCard;
  active: boolean;
  playable: boolean;
  label: string;
  tooltip: string;
  shortLabel: string;
}

export interface HandRackProps {
  resourceHand: ResourceBundle;
  tradeOffer: ResourceBundle;
  discardDraft: ResourceBundle;
  discardCount?: number;
  developmentCardGroups: DevelopmentCardGroupView[];
  onResourceTrade: (resource: Resource) => void;
  onDiscardResource: (resource: Resource) => void;
  onDevelopmentCard: (card: DevelopmentCard) => void;
}

export const HandRack = ({
  resourceHand,
  tradeOffer,
  discardDraft,
  discardCount,
  developmentCardGroups,
  onResourceTrade,
  onDiscardResource,
  onDevelopmentCard,
}: HandRackProps) => {
  const isDiscardSelection = discardCount !== undefined;
  const discardedCount = resourceCount(discardDraft);
  return (
    <div className="hand-rack" aria-label="Your resources">
      <div className="resource-hand" aria-label="Resource cards">
        {resources.map((resource) => {
          const discardSelected = discardDraft[resource] ?? 0;
          const owned = resourceHand[resource] ?? 0;
          const discardFull = isDiscardSelection && discardedCount >= discardCount;
          const canPickDiscard = isDiscardSelection && owned > discardSelected && !discardFull;
          return (
            <ResourceCard
              key={resource}
              resource={resource}
              count={owned}
              compact
              onClick={() => isDiscardSelection ? onDiscardResource(resource) : onResourceTrade(resource)}
              buttonLabel={isDiscardSelection ? `Select ${resourceLabels[resource]} to discard` : `Open trade with ${resourceLabels[resource]}`}
              selected={isDiscardSelection ? discardSelected > 0 : tradeOffer[resource] > 0}
              selectedCount={isDiscardSelection ? discardSelected : 0}
              disabled={isDiscardSelection ? !canPickDiscard : false}
            />
          );
        })}
      </div>
      {developmentCardGroups.length > 0 ? (
        <div className="dev-hand" aria-label="Your development cards in hand">
          {developmentCardGroups.map((group) => (
            <button
              key={group.type}
              type="button"
              className={`dev-hand-card ${group.active ? "selected" : ""} ${!group.playable ? "is-disabled" : ""} ${group.type === "VICTORY_POINT" ? "secret-vp-card" : ""}`}
              onClick={() => onDevelopmentCard(group.primary)}
              aria-disabled={!group.playable}
              aria-label={group.label}
              title={group.tooltip}
            >
              <DevelopmentCardIcon type={group.type} />
              {group.cards.length > 1 ? <span className="dev-card-count">x{group.cards.length}</span> : null}
              <small>{group.shortLabel}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
