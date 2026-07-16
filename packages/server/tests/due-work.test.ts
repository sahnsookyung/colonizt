import { describe, expect, it } from "vitest";
import { DueWorkIndex } from "../src/due-work.js";

describe("DueWorkIndex", () => {
  it("clears scheduled and stale heap entries before accepting new work", () => {
    const index = new DueWorkIndex();
    index.set("old-first", 10);
    index.set("old-second", 20);

    index.clear();
    expect(index.nextDueAt()).toBeUndefined();
    expect(index.claimDue(100)).toEqual([]);

    index.set("new", 30);
    expect(index.claimDue(30)).toEqual(["new"]);
  });
});
