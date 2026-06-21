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

test("initial desert thief marker is centered without a dark tile seam", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await page.goto("/");
  await page.getByRole("button", { name: /Bot Match/ }).click();

  const thiefDesertHex = page.locator(".thief-hex .hex-desert");
  await expect(thiefDesertHex).toHaveCount(1);
  await expect(page.locator(".thief-hex .thief-marker")).toHaveCount(1);
  await expect(page.locator(".thief-hex .legal-thief-target")).toHaveCount(0);

  const stroke = await thiefDesertHex.evaluate((element) => {
    const styles = window.getComputedStyle(element);
    const channels = styles.stroke.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
    const [red = 255, green = 255, blue = 255] = channels;
    return {
      luminance: 0.2126 * red + 0.7152 * green + 0.0722 * blue,
      width: Number.parseFloat(styles.strokeWidth),
    };
  });

  expect(stroke.luminance).toBeGreaterThan(35);
  expect(stroke.width).toBeLessThanOrEqual(0.06);
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
