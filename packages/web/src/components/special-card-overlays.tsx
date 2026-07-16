import { resources, type GameState, type Resource, type ViewerState } from "@colonizt/game-core";
import { DevelopmentCardIcon, ResourceCard, resourceLabels } from "./game-ui.js";
import { AccessibleDialog } from "./accessible-dialog.js";

interface SpecialCardOverlaysProps {
  state: GameState;
  viewer: ViewerState;
  monopolyCardId?: string;
  yearOfPlentyCardId?: string;
  yearOfPlentyFirstOptions: Resource[];
  yearOfPlentySecondOptions: Resource[];
  selectedYearOfPlenty: [Resource, Resource];
  canTakeYearOfPlenty: boolean;
  onClose(): void;
  onPlayMonopoly(cardId: string, resource: Resource): void;
  onSetYearOfPlenty(index: 0 | 1, resource: Resource): void;
  onPlayYearOfPlenty(cardId: string, selected: [Resource, Resource]): void;
}

export const SpecialCardOverlays = ({
  state,
  viewer,
  monopolyCardId,
  yearOfPlentyCardId,
  yearOfPlentyFirstOptions,
  yearOfPlentySecondOptions,
  selectedYearOfPlenty,
  canTakeYearOfPlenty,
  onClose,
  onPlayMonopoly,
  onSetYearOfPlenty,
  onPlayYearOfPlenty,
}: SpecialCardOverlaysProps) => (
  <>
    {monopolyCardId ? (
      <AccessibleDialog className="special-card-choice-overlay" label="Monopoly card choice" onClose={onClose}>
        <div className="special-choice-heading">
          <DevelopmentCardIcon type="MONOPOLY" />
          <div><strong>Monopoly</strong><span>Choose one resource to collect</span></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close Monopoly chooser">x</button>
        </div>
        <div className="special-resource-grid">
          {resources.map((resource) => (
            <ResourceCard
              key={resource}
              resource={resource}
              count={viewer.resourceBank?.[resource] ?? state.resourceBank?.[resource] ?? 0}
              onClick={() => onPlayMonopoly(monopolyCardId, resource)}
              buttonLabel={`Choose ${resourceLabels[resource]} for Monopoly`}
            />
          ))}
        </div>
      </AccessibleDialog>
    ) : null}
    {yearOfPlentyCardId ? (
      <AccessibleDialog className="special-card-choice-overlay" label="Year of Plenty card choice" onClose={onClose}>
        <div className="special-choice-heading">
          <DevelopmentCardIcon type="YEAR_OF_PLENTY" />
          <div><strong>Year of Plenty</strong><span>Choose two bank resources</span></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close Year of Plenty chooser">x</button>
        </div>
        <div className="year-choice-section">
          <strong>First</strong>
          <div className="special-resource-grid">
            {yearOfPlentyFirstOptions.map((resource) => (
              <ResourceCard
                key={resource}
                resource={resource}
                count={state.resourceBank?.[resource] ?? 0}
                selected={selectedYearOfPlenty[0] === resource}
                onClick={() => onSetYearOfPlenty(0, resource)}
                buttonLabel={`Choose ${resourceLabels[resource]} as first Year of Plenty resource`}
              />
            ))}
          </div>
        </div>
        <div className="year-choice-section">
          <strong>Second</strong>
          <div className="special-resource-grid">
            {yearOfPlentySecondOptions.map((resource) => (
              <ResourceCard
                key={resource}
                resource={resource}
                count={state.resourceBank?.[resource] ?? 0}
                selected={selectedYearOfPlenty[1] === resource}
                onClick={() => onSetYearOfPlenty(1, resource)}
                buttonLabel={`Choose ${resourceLabels[resource]} as second Year of Plenty resource`}
              />
            ))}
          </div>
        </div>
        <button type="button" className="primary-wide" onClick={() => onPlayYearOfPlenty(yearOfPlentyCardId, selectedYearOfPlenty)} disabled={!canTakeYearOfPlenty}>Take resources</button>
      </AccessibleDialog>
    ) : null}
  </>
);
