import { describe, expect, it } from "vitest";
import { emptyResources } from "@colonizt/game-core";
import { canSubmitDiscardDraft, incrementDiscardDraft } from "../src/discard-policy.js";

describe("discard policy", () => {
  it("increments only within both the player's holdings and required total", () => {
    const holdings = { ...emptyResources(), timber: 1, grain: 3 };
    const empty = emptyResources();
    const oneTimber = incrementDiscardDraft(holdings, empty, 2, "timber");

    expect(oneTimber).toEqual({ ...emptyResources(), timber: 1 });
    expect(incrementDiscardDraft(holdings, oneTimber, 2, "timber")).toBe(oneTimber);

    const complete = incrementDiscardDraft(holdings, oneTimber, 2, "grain");
    expect(complete).toEqual({ ...emptyResources(), timber: 1, grain: 1 });
    expect(incrementDiscardDraft(holdings, complete, 2, "grain")).toBe(complete);
  });

  it("submits only an exact draft the player owns", () => {
    const holdings = { ...emptyResources(), ore: 2 };
    expect(canSubmitDiscardDraft(holdings, { ...emptyResources(), ore: 2 }, 2)).toBe(true);
    expect(canSubmitDiscardDraft(holdings, { ...emptyResources(), ore: 1 }, 2)).toBe(false);
    expect(canSubmitDiscardDraft(holdings, { ...emptyResources(), ore: 3 }, 3)).toBe(false);
    expect(canSubmitDiscardDraft(undefined, emptyResources(), 0)).toBe(false);
    expect(incrementDiscardDraft(undefined, emptyResources(), 1, "ore")).toEqual(emptyResources());
    expect(incrementDiscardDraft(holdings, emptyResources(), undefined, "ore")).toEqual(emptyResources());
  });
});
