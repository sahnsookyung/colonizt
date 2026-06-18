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
});
