import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const ruleBody = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m"));
  if (!match?.[1]) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
};

const expectRuleToContain = (selector: string, declarations: string[]) => {
  const body = ruleBody(selector);
  for (const declaration of declarations) {
    expect(body).toContain(declaration);
  }
};

describe("text containment CSS", () => {
  it("keeps dynamic game text inside compact controls", () => {
    expectRuleToContain(".board-action span", ["overflow: hidden", "overflow-wrap: anywhere", "white-space: normal"]);
    expectRuleToContain(".player-heading strong", ["overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"]);
    expectRuleToContain(".player-stats .stat-chip", ["overflow: hidden", "white-space: nowrap"]);
    expectRuleToContain(".player-mobile-stats span", ["overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"]);
  });

  it("keeps lobby and event text from spilling into neighboring UI", () => {
    expectRuleToContain(".lobby-actions", ["repeat(auto-fit"]);
    expectRuleToContain(".lobby-seat strong", ["overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"]);
    expectRuleToContain(".game-log-panel li", ["align-items: flex-start", "overflow-wrap: anywhere"]);
    expectRuleToContain(".trade-response-row span,\n.trade-response-row strong", ["overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"]);
  });
});
