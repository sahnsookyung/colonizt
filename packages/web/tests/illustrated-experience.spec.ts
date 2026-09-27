import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  completeSetup,
  createDemoGame,
  withResources,
} from "@colonizt/demo-state";
import { serializeForViewer, type GameState } from "@colonizt/game-core";

const record = async (page: Page, info: TestInfo, name: string) => {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
};
const fixture = async (page: Page, game: GameState) => {
  const snapshot = serializeForViewer(game, "p1");
  const room = {
    id: "room_visual",
    code: "VISUAL",
    status: "IN_GAME",
    game: snapshot,
    seats: [],
    events: [],
  };
  await page.route("**/config", (route) =>
    route.fulfill({
      json: {
        protocolVersion: 4,
        apiBaseUrl: "http://127.0.0.1:5173",
        wsBaseUrl: "ws://127.0.0.1:5173",
      },
    }),
  );
  await page.route("**/sessions", (route) =>
    route.fulfill({
      json: {
        token: "fixture",
        userId: "p1",
        displayName: "Explorer with a long island name",
      },
    }),
  );
  await page.route("**/rooms", (route) => route.fulfill({ json: room }));
  await page.route("**/ws-tickets", (route) =>
    route.fulfill({ json: { ticket: "fixture" } }),
  );
  await page.route("**/analytics", (route) => route.fulfill({ status: 204 }));
  const replay = completeSetup(createDemoGame("visual-review"));
  await page.route("**/matches/**/replay", (route) =>
    route.fulfill({
      json: {
        config: replay.state.config,
        board: replay.state.board,
        events: replay.events,
      },
    }),
  );
  await page.routeWebSocket(/\/ws\?/, (ws) =>
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "PING")
        ws.send(
          JSON.stringify({
            type: "PONG",
            nonce: message.nonce,
            serverTime: Date.now(),
          }),
        );
      if (message.type === "JOIN_ROOM" || message.type === "RESYNC")
        ws.send(JSON.stringify({ type: "ROOM_STATE", room }));
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /Player Match/ }).click();
  await expect(page.getByLabel("Game board and actions")).toBeVisible();
};
const accessible = async (page: Page) => {
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    audit.violations
      .filter((item) => item.impact === "serious" || item.impact === "critical")
      .map((item) => ({
        id: item.id,
        targets: item.nodes.map((node) => node.target),
      })),
  ).toEqual([]);
};

test("all map presets fit in both orientations with safe camera controls", async ({
  page,
}, info) => {
  for (const map of ["Standard", "Islands", "Continent"]) {
    await page.goto("/");
    await page.getByRole("button", { name: map, exact: true }).click();
    await record(page, info, `setup-${map}`);
    const started = performance.now();
    await page.getByRole("button", { name: /Bot Match/ }).click();
    await expect(page.locator(".terrain-layer image").first()).toBeVisible();
    info.annotations.push({
      type: "timing",
      description: `${map} click-to-visible: ${Math.round(performance.now() - started)}ms (development build, includes driver)`,
    });
    for (const orientation of ["portrait", "landscape"]) {
      const size = page.viewportSize()!;
      if (orientation === "landscape")
        await page.setViewportSize({
          width: Math.max(size.width, size.height),
          height: Math.min(size.width, size.height),
        });
      const controls = await page
        .locator(".board-camera-controls button")
        .evaluateAll((buttons) =>
          buttons.map((button) => {
            const box = button.getBoundingClientRect();
            return [box.width, box.height];
          }),
        );
      expect(
        controls.every(([width, height]) => width! >= 44 && height! >= 44),
      ).toBe(true);
      // ResizeObserver updates screen-sized typography after an orientation change.
      await expect.poll(async () => {
        const numberSizes = await page.locator(".token > text:first-of-type").evaluateAll((tokens) => tokens.map((token) => {
          const scale = (token as SVGGraphicsElement).getScreenCTM()!.a;
          return parseFloat(getComputedStyle(token).fontSize) * scale;
        }));
        return numberSizes.length ? Math.min(...numberSizes) : 0;
      }).toBeGreaterThanOrEqual(11.9);
      const clippedHand = await page.locator(".hand-rack .resource-card").evaluateAll((cards) => cards.some((card) => {
        const box = card.getBoundingClientRect();
        const hand = card.closest(".hand-rack")!.getBoundingClientRect();
        return box.right > hand.right + 1 || box.left < hand.left - 1 || [...card.children].some((child) => child.getBoundingClientRect().right > box.right + 1);
      }));
      expect(clippedHand).toBe(false);
      if (page.viewportSize()!.height <= 550) {
        const separated = await page.locator(".dice-panel").evaluate((dice) => dice.getBoundingClientRect().left >= document.querySelector(".board-viewport")!.getBoundingClientRect().right);
        expect(separated).toBe(true);
      }
      await record(page, info, `${map}-${orientation}`);
      await page.getByRole("button", { name: "Zoom in" }).click();
      await page.getByRole("button", { name: "Fit board" }).click();
      await expect(
        page.getByRole("button", { name: "Zoom out" }),
      ).toBeDisabled();
      if (orientation === "landscape") await page.setViewportSize(size);
    }
  }
});

test("trade and development sheets remain usable and accessible", async ({
  page,
}, info) => {
  let game = completeSetup(createDemoGame("visual-review")).state;
  game = withResources(game, "p1", {
    timber: 6,
    brick: 6,
    grain: 6,
    fiber: 6,
    ore: 6,
  });
  game.players.p1!.name = "An explorer with a remarkably long name";
  game.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
  game.players.p1!.developmentCards = [
    "KNIGHT",
    "MONOPOLY",
    "YEAR_OF_PLENTY",
  ].map((type) => ({
    id: type,
    type,
    ownerId: "p1",
    boughtTurn: game.turn - 1,
  })) as typeof game.players.p1.developmentCards;
  await fixture(page, game);
  await page.getByRole("button", { name: "Open trade", exact: true }).click();
  await page.getByRole("button", { name: "Offer Timber", exact: true }).click();
  await page
    .getByRole("button", { name: "Request Grain", exact: true })
    .click();
  await record(page, info, "trade");
  await accessible(page);
  await page.getByRole("button", { name: "Close trade" }).click();
  for (const card of ["Monopoly", "Year of Plenty"]) {
    await page
      .getByRole("button", { name: `${card}: Ready`, exact: true })
      .click();
    await record(page, info, card.replaceAll(" ", "-"));
    await accessible(page);
    await page.keyboard.press("Escape");
  }
  await page
    .getByRole("button", { name: "Knight: Ready", exact: true })
    .click();
  const robber = page
    .getByRole("button", { name: /Select robber destination on/ })
    .first();
  await robber.press("Enter");
  await page.getByRole("button", { name: "Confirm placement" }).click();
  await expect(page.getByLabel("Choose player to rob")).toBeVisible();
  await record(page, info, "robber");
  await accessible(page);
});

test("discard selection is reachable inside its dialog", async ({
  page,
}, info) => {
  const game = completeSetup(createDemoGame("visual-review")).state;
  game.players.p1!.resources.timber = 8;
  game.phase = {
    type: "DISCARDING",
    activePlayerId: "p1",
    rollerId: "p2",
    pending: { p1: 4 },
    submitted: {},
  };
  await fixture(page, game);
  for (let i = 0; i < 4; i++)
    await page
      .getByRole("button", { name: "Select Timber to discard" })
      .click();
  await expect(
    page.getByRole("button", { name: "Discard", exact: true }),
  ).toBeEnabled();
  const timberCard = page.getByRole("button", { name: "Select Timber to discard" });
  await expect(timberCard).toBeDisabled();
  await timberCard.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(timberCard).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(timberCard.locator(".resource-selected-count")).toHaveText("x4");
  await record(page, info, "discard");
  await accessible(page);
});

test("victory analysis and replay fit the illustrated table", async ({
  page,
}, info) => {
  const game = completeSetup(createDemoGame("visual-review")).state;
  game.phase = { type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" };
  await fixture(page, game);
  for (const tab of [
    "Overview",
    "Dice Stats",
    "Resource Cards",
    "Development Cards",
  ]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await record(page, info, `victory-${tab.replaceAll(" ", "-")}`);
    await accessible(page);
  }
  await page.getByRole("button", { name: "Open replay", exact: true }).click();
  await expect(page.getByLabel("Replay controls")).toBeVisible();
  await page.getByRole("button", { name: "Prev", exact: true }).click();
  await record(page, info, "replay");
});

test("keyboard preview is cancelable and reduced motion disables piece animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: /Bot Match/ }).click();
  const corner = page
    .getByRole("button", { name: /Place setup settlement at corner/ })
    .first();
  await corner.press("Enter");
  await expect(
    page.getByRole("button", { name: "Confirm placement" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Confirm placement" }),
  ).toHaveCount(0);
  await corner.press("Space");
  await page.getByRole("button", { name: "Confirm placement" }).click();
  await expect(page.locator(".building.pending")).toHaveCSS(
    "animation-name",
    "none",
  );
});
