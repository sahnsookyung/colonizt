import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const expectNoSeriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(serious, serious.map((violation) => `${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
};

test("setup screen has no serious automated accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Colonizt" })).toBeVisible();
  await expectNoSeriousViolations(page);
});

test("local board has no serious automated accessibility violations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Bot Match/ }).click();
  await expect(page.getByLabel("Game board and actions")).toBeVisible();
  await expectNoSeriousViolations(page);
});
