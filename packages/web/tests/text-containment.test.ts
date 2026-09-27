import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = ["foundation", "screens", "table", "dialogs"].map((name) => readFileSync(new URL(`../src/styles/${name}.css`, import.meta.url), "utf8")).join("\n").replace(/\s+/g, " ");

const ruleBody = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m"));
  if (!match?.[1]) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
};

const expectRuleToContain = (selector: string, declarations: string[]) => {
  const body = ruleBody(selector);
  for (const declaration of declarations) {
    expect(body.replace(/\s+/g, "")).toContain(declaration.replace(/\s+/g, ""));
  }
};

describe("text containment CSS", () => {
  it("keeps button labels from splitting words apart", () => {
    expectRuleToContain("button, select", ["hyphens: none", "overflow-wrap: normal", "word-break: normal"]);
    expectRuleToContain(".lobby-settings .difficulty-options button", [
      "font-size: 13px",
      "hyphens: none",
      "overflow-wrap: normal",
      "word-break: normal",
    ]);
    expectRuleToContain(".lobby-settings .option-row > span", ["overflow-wrap: normal", "word-break: normal"]);
  });

  it("keeps dynamic game text inside compact controls", () => {
    expectRuleToContain(".board-action span", ["overflow: hidden", "overflow-wrap: normal", "word-break: normal"]);
    expectRuleToContain(".board-action", ["min-height:70px", "flex-direction:column"]);
    expectRuleToContain(".player-heading strong", ["overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"]);
    expectRuleToContain(".player-stats .stat-chip", ["overflow: hidden", "white-space: nowrap"]);

  });

  it("keeps lobby and event text from spilling into neighboring UI", () => {
    expectRuleToContain(".lobby-actions", ["grid-template-columns:1fr 1fr"]);
    expectRuleToContain(".lobby-seat strong", ["overflow-wrap:anywhere"]);
    expectRuleToContain(".game-log-panel li", ["align-items: flex-start", "overflow-wrap: anywhere"]);
    expectRuleToContain(".trade-response-row span, .trade-response-row strong", ["overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"]);
  });
});
