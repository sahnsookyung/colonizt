import { expect, test } from "@playwright/test";

test("local bot game first screen is playable on desktop", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Colonizt" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Bot Match/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Player Match/ })).toBeVisible();
  await page.getByRole("button", { name: /Bot Match/ }).click();
  await expect(page.getByLabel("Game board and actions")).toBeVisible();
  await page.getByRole("button", { name: "Ready" }).click();
  await page.getByRole("button", { name: "Roll dice" }).click();
  await expect(page.getByText(/Roll \d+/)).toBeVisible();
});

test("mobile viewport keeps primary controls visible", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile project only");
  await page.goto("/");
  await page.getByRole("button", { name: /Bot Match/ }).click();
  await expect(page.getByLabel("Game board and actions")).toBeVisible();
  await expect(page.getByRole("button", { name: "Roll dice" })).toBeVisible();
  await expect(page.getByRole("button", { name: "End Turn" })).toBeVisible();
  await expect(page.locator(".topbar")).toHaveCSS("display", "none");
  await expect(page.locator(".game-log-panel")).toHaveCSS("display", "none");

  const metrics = await page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right };
    };
    return {
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      scrollHeight: document.documentElement.scrollHeight,
      board: box(".board"),
      actions: box(".board-action-bar"),
      players: box(".players"),
    };
  });

  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.board.height).toBeGreaterThan(metrics.viewportHeight * 0.56);
  expect(metrics.board.right).toBeGreaterThan(metrics.viewportWidth * 0.9);
  expect(metrics.actions.height).toBeLessThanOrEqual(64);
  expect(metrics.actions.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.players.bottom).toBeLessThanOrEqual(72);
});
