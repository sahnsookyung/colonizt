import {
  devices,
  expect,
  test,
  webkit,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";
import { resources, type ViewerState } from "@colonizt/game-core";

test.describe("mixed-device multiplayer", () => {
  test.skip(
    !process.env.PUBLIC_WEB_URL && !process.env.LOCAL_MULTIPLAYER,
    "Requires a multiplayer server",
  );
  test("four devices converge through setup, lost ACK, refresh, turns, trade, and reconnect", async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const safari = await webkit.launch();
    const contexts = await Promise.all([
      browser.newContext({ ...devices["Desktop Chrome"], baseURL }),
      browser.newContext({ ...devices["Pixel 7"], baseURL }),
      safari.newContext({ ...devices["iPhone 13"], baseURL }),
      safari.newContext({ ...devices["iPad (gen 7)"], baseURL }),
    ]);
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    pages.forEach((page) => page.setDefaultTimeout(10_000));
    const observed = pages.map(() => ({
      snapshot: undefined as ViewerState | undefined,
      commands: [] as string[],
      dropped: false,
      connections: 0,
      route: undefined as WebSocketRoute | undefined,
    }));
    let dropNextAck = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    try {
      for (const [index, page] of pages.entries()) {
        await page.routeWebSocket(/\/ws\?/, (route) => {
          observed[index]!.route = route;
          observed[index]!.connections += 1;
          const server = route.connectToServer();
          route.onMessage((raw) => {
            const data = JSON.parse(String(raw));
            if (data.type === "COMMAND")
              observed[index]!.commands.push(String(raw));
            server.send(raw);
          });
          server.onMessage((raw) => {
            const data = JSON.parse(String(raw));
            const snapshot = data.snapshot ?? data.room?.game;
            if (snapshot) observed[index]!.snapshot = snapshot;
            if (data.type === "COMMAND_ACK" && dropNextAck) {
              dropNextAck = false;
              observed[index]!.dropped = true;
              return;
            }
            // A slow phone gets duplicate overlapping event packets. No private payloads are logged.
            if (index === 1 && data.type === "EVENTS") {
              const timer = setTimeout(() => {
                timers.delete(timer);
                route.send(raw);
                route.send(raw);
              }, 100);
              timers.add(timer);
            } else route.send(raw);
          });
        });
      }
      const host = pages[0]!;
      await host.goto("/");
      await host.getByRole("button", { name: /Player Match/ }).click();
      await expect(host.getByLabel("Online lobby")).toBeVisible();
      const code = (await host
        .locator(".lobby-code-card strong")
        .textContent())!.trim();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
      for (const page of pages.slice(1)) {
        await page.goto(`/?room=${code}`);
        await expect(page.getByLabel("Online lobby")).toBeVisible();
      }
      for (const [index, page] of pages.entries()) {
        await page
          .getByLabel("Your name")
          .fill(
            [
              "Desktop explorer",
              "Android friend",
              "iPhone voyager",
              "iPad islander",
            ][index]!,
          );
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator(".lobby-seat.you strong")).toContainText(["Desktop explorer", "Android friend", "iPhone voyager", "iPad islander"][index]!);
        await page.getByRole("button", { name: "Ready", exact: true }).click();
      }
      await expect(
        host.getByRole("button", { name: "Go", exact: true }),
      ).toBeEnabled();
      await host.getByRole("button", { name: "Go", exact: true }).click();
      for (const page of pages)
        await expect(page.getByLabel("Game board and actions")).toBeVisible();

      const activeSetup = async () => {
        let current: Page | undefined;
        await expect
          .poll(async () => {
            for (const page of pages)
              if (
                await page
                  .getByRole("button", {
                    name: /Place setup settlement at corner/,
                  })
                  .first()
                  .isVisible()
              ) {
                current = page;
                return true;
              }
            return false;
          })
          .toBe(true);
        return current!;
      };
      const place = async (page: Page) => {
        // Tap the physical target center, including on WebKit where overlapping SVG
        // transparent hit circles can obscure a locator's actionability check.
        for (const name of [/Place setup settlement at corner/, /Build road here/]) {
          const target = page.getByRole("button", { name }).first();
          await expect(target).toBeVisible();
          const box = await target.boundingBox();
          if (!box) throw new Error("Missing placement bounds");
          if (page === pages[0]) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          else await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
          const corner = (await target.getAttribute("aria-label"))?.match(/corner (\S+)/)?.[1];
          if (corner) await expect(page.locator(".placement-confirmation")).toHaveAttribute("data-selection", corner);
          await page.getByRole("button", { name: "Confirm placement" }).click();
        }
      };
      dropNextAck = true;
      const first = await activeSetup();
      await place(first);
      await expect
        .poll(() => observed.some((entry) => entry.dropped))
        .toBe(true);
      const lostIndex = pages.indexOf(first);
      const original = observed[lostIndex]!.commands[0];
      await first.reload();
      await expect(first.getByLabel("Game board and actions")).toBeVisible();
      await expect
        .poll(
          () =>
            observed[lostIndex]!.commands.filter((raw) => raw === original)
              .length,
        )
        .toBe(2);
      await expect(
        first.getByText("Confirming your action…", { exact: true }),
      ).toHaveCount(0);
      for (let count = 1; count < 8; count++) await place(await activeSetup());
      await expect
        .poll(() =>
          observed.every(
            (entry) => entry.snapshot?.phase.type === "WAITING_FOR_ROLL",
          ),
        )
        .toBe(true);
      const sequences = () => observed.map((entry) => entry.snapshot?.eventSeq);
      await expect.poll(() => new Set(sequences()).size).toBe(1);
      for (const entry of observed) {
        const snapshot = entry.snapshot!;
        for (const player of snapshot.players) {
          if (player.id === snapshot.viewerId)
            expect(player.resources).toBeDefined();
          else expect(player.resources).toBeUndefined();
        }
      }
      const turnPage = pages.find((_, i) => {
        const state = observed[i]!.snapshot!;
        return (
          "activePlayerId" in state.phase &&
          state.phase.activePlayerId === state.viewerId
        );
      })!;
      await turnPage
        .getByRole("button", { name: "Roll dice", exact: true })
        .click();
      await expect
        .poll(() => observed[0]!.snapshot?.phase.type)
        .not.toBe("WAITING_FOR_ROLL");
      const robber = turnPage.getByRole("button", {
        name: /Move robber to|Select robber destination/,
      });
      if (await robber.count()) {
        await robber.first().click();
        await turnPage
          .getByRole("button", { name: "Confirm placement" })
          .click();
        const victim = turnPage.getByRole("button", { name: /Steal from/ });
        if (await victim.count()) await victim.first().click();
      }
      await expect(
        turnPage.getByRole("button", { name: "Open trade", exact: true }),
      ).toBeEnabled();
      await turnPage
        .getByRole("button", { name: "Open trade", exact: true })
        .click();
      const own = observed[pages.indexOf(turnPage)]!.snapshot!;
      const ownHand = own.players.find((player) => player.id === own.viewerId)!.resources!;
      const terms = observed.flatMap((entry, index) => {
        if (pages[index] === turnPage) return [];
        const peer = entry.snapshot!;
        const hand = peer.players.find((player) => player.id === peer.viewerId)!.resources!;
        return resources.flatMap((give) => ownHand[give] > 0 ? resources.filter((take) => take !== give && hand[take] > 0).map((take) => ({ give, take, index })) : []);
      })[0];
      if (!terms) throw new Error("No exchangeable starting resources");
      const label = (resource: string) => resource[0]!.toUpperCase() + resource.slice(1);
      await turnPage.getByRole("button", { name: `Offer ${label(terms.give)}`, exact: true }).click();
      await turnPage.getByRole("button", { name: `Request ${label(terms.take)}`, exact: true }).click();
      await turnPage.getByRole("button", { name: "Offer", exact: true }).click();
      const recipient = pages[terms.index]!;
      await expect(recipient.getByLabel("Staged trade response overlay")).toBeVisible();
      await recipient.getByRole("button", { name: "Want to accept", exact: true }).click();
      await turnPage.getByRole("button", { name: /Wants to accept/ }).click();
      await turnPage.getByRole("button", { name: "Trade", exact: true }).click();
      await expect(turnPage.getByLabel("Staged trade response overlay")).toHaveCount(0);
      await expect(turnPage.getByText("Confirming your action…", { exact: true })).toHaveCount(0);
      await turnPage
        .getByRole("button", { name: "End Turn", exact: true })
        .click();
      await expect.poll(() => new Set(sequences()).size).toBe(1);

      const savedViewer = observed[1]!.snapshot!.viewerId;
      const beforeReconnect = observed[1]!.connections;
      await contexts[1]!.setOffline(true);
      await observed[1]!.route!.close({
        code: 4000,
        reason: "Test network interruption",
      });
      await expect(
        pages[1]!.getByLabel("Game board and actions"),
      ).toBeVisible();
      await contexts[1]!.setOffline(false);
      await expect.poll(() => observed[1]!.connections).toBeGreaterThan(beforeReconnect);
      await expect(pages[1]!.locator(".connection-banner")).toHaveCount(0);
      await expect
        .poll(() => observed[1]!.snapshot?.viewerId)
        .toBe(savedViewer);
      await pages[2]!.evaluate(() =>
        window.dispatchEvent(new Event("pagehide")),
      );
      await pages[2]!.evaluate(() =>
        window.dispatchEvent(new Event("pageshow")),
      );
      await expect.poll(() => new Set(sequences()).size).toBe(1);
      await expect.poll(async () => {
        const cursors = await Promise.all(pages.map((page) => page.evaluate(() => JSON.parse(localStorage.getItem("colonizt.resume")!).lastSeq as number)));
        return cursors.every((seq) => seq === Math.max(...sequences().map((seq) => seq ?? 0)));
      }).toBe(true);
      for (const [index, page] of pages.entries())
        await page.screenshot({
          path: `test-results/mixed-device-${index}.png`,
        });
    } finally {
      timers.forEach(clearTimeout);
      await Promise.allSettled(contexts.map((context) => context.close()));
      await safari.close();
    }
  });
});
