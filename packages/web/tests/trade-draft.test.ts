import { describe, expect, it } from "vitest";
import { emptyResources } from "@colonizt/game-core";
import { normalizeTradeDraft } from "../src/trade-draft.js";

describe("trade draft normalization", () => {
  it("clamps offers to owned resources and removes offer/request overlap", () => {
    const owned = { ...emptyResources(), timber: 2 };
    const draft = {
      offer: { ...emptyResources(), timber: 5 },
      request: { ...emptyResources(), timber: 3, ore: 15 },
    };
    const normalized = normalizeTradeDraft(draft, owned);
    expect(normalized.offer.timber).toBe(2);
    expect(normalized.request.timber).toBe(0);
    expect(normalized.request.ore).toBe(9);
  });
});
