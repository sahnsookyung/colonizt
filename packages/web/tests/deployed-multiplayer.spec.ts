import { expect, test } from "@playwright/test";

test.describe("deployed multiplayer smoke", () => {
  test.skip(!process.env.PUBLIC_WEB_URL, "PUBLIC_WEB_URL is required for deployed browser smoke");

  test("four browser clients join, ready, act, and reconnect through the public app", async ({ browser }) => {
    const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const pageA = pages[0]!;
    const peerPages = pages.slice(1);

    try {
      await pageA.goto("/");
      await pageA.getByRole("button", { name: /Player Match/ }).click();
      const statusA = pageA.locator(".phase-card .eyebrow");
      await expect(statusA).toContainText(/Online [A-Z0-9]{6}/);
      const roomStatus = await statusA.textContent();
      const roomCode = roomStatus?.match(/[A-Z0-9]{6}/)?.[0];
      expect(roomCode, `room code in status: ${roomStatus}`).toBeTruthy();

      for (const page of peerPages) {
        await page.goto(`/?room=${encodeURIComponent(roomCode!)}`);
        await expect(page.locator(".phase-card .eyebrow")).toContainText(roomCode!);
      }

      await pageA.getByRole("button", { name: "Ready" }).click();
      for (const page of peerPages) await page.getByRole("button", { name: "Ready" }).click();
      for (const page of pages) await expect(page.getByText(/SETUP PLACEMENT/)).toBeVisible();

      await pageA.getByRole("button", { name: /Place setup settlement at corner/ }).first().click();
      await pageA.getByRole("button", { name: /Build road on edge/ }).first().click();
      for (const page of pages) await expect(page.getByLabel("Gameplay log")).toContainText(/placed/i);

      await peerPages[0]!.reload();
      await expect(peerPages[0]!.getByLabel("Game board and actions")).toBeVisible();
      await expect(peerPages[0]!.locator(".phase-card .eyebrow")).toContainText(roomCode!);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
});
