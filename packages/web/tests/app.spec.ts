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

test("initial desert robber marker is centered without a dark tile seam", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await page.goto("/");
  await page.getByRole("button", { name: /Bot Match/ }).click();

  const thiefDesertHex = page.locator(".thief-hex .hex-desert");
  await expect(thiefDesertHex).toHaveCount(1);
  await expect(page.locator(".thief-hex .thief-marker")).toHaveCount(1);
  await expect(page.getByRole("img", { name: "Robber" })).toBeVisible();
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

test("medium desktop HUD keeps every resource visible and compact", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await page.setViewportSize({ width: 800, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: /Bot Match/ }).click();

  const metrics = await page.evaluate(() => {
    const rectFor = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const cards = [...document.querySelectorAll<HTMLElement>(".hand-rack .resource-card")].map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        label: card.querySelector(".resource-name")?.textContent ?? "",
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    });
    return {
      viewportWidth: window.innerWidth,
      hand: rectFor(".hand-rack"),
      actions: rectFor(".board-action-bar"),
      cards,
    };
  });

  expect(metrics.cards.map((card) => card.label)).toEqual(["Timber", "Brick", "Grain", "Fiber", "Ore"]);
  for (const card of metrics.cards) {
    expect(card.left).toBeGreaterThanOrEqual(0);
    expect(card.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(card.width).toBeGreaterThan(48);
  }
  expect(metrics.hand.right).toBeLessThanOrEqual(metrics.actions.left - 8);
  expect(metrics.hand.height).toBeLessThanOrEqual(82);
  expect(metrics.actions.height).toBeLessThanOrEqual(78);
});

test("action controls use solid contained colors", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await page.goto("/");
  await page.getByRole("button", { name: /Bot Match/ }).click();

  const styles = await page.evaluate(() => {
    const alphaOf = (color: string) => {
      const channels = color.match(/[\d.]+/g)?.map(Number) ?? [];
      return channels.length >= 4 ? channels[3] ?? 1 : 1;
    };
    const actionBar = document.querySelector<HTMLElement>(".board-action-bar");
    if (!actionBar) throw new Error("Missing action bar");
    const barStyle = window.getComputedStyle(actionBar);
    return {
      bar: {
        backgroundImage: barStyle.backgroundImage,
        backdropFilter: barStyle.backdropFilter,
        alpha: alphaOf(barStyle.backgroundColor),
      },
      buttons: [...document.querySelectorAll<HTMLElement>(".board-action")].map((button) => {
        const style = window.getComputedStyle(button);
        return {
          label: button.textContent?.trim() ?? "",
          backgroundImage: style.backgroundImage,
          alpha: alphaOf(style.backgroundColor),
        };
      }),
    };
  });

  expect(styles.bar.backgroundImage).toBe("none");
  expect(styles.bar.backdropFilter === "none" || styles.bar.backdropFilter === "").toBe(true);
  expect(styles.bar.alpha).toBe(1);
  expect(styles.buttons.length).toBeGreaterThanOrEqual(6);
  for (const button of styles.buttons) {
    expect(button.backgroundImage).toBe("none");
    expect(button.alpha).toBe(1);
  }
});

test("board tile drags do not create native SVG selection artifacts", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /Bot Match/ }).click();

  const board = await page.locator(".board").boundingBox();
  if (!board) throw new Error("Missing board bounds");
  await page.mouse.move(board.x + board.width * 0.45, board.y + board.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(board.x + board.width * 0.66, board.y + board.height * 0.62, { steps: 12 });
  await page.mouse.up();

  const selectionState = await page.evaluate(() => {
    const selection = window.getSelection();
    const boardElement = document.querySelector<SVGSVGElement>(".board");
    if (!boardElement) throw new Error("Missing board");
    const boardStyle = window.getComputedStyle(boardElement);
    return {
      selectedText: selection?.toString() ?? "",
      rangeCount: selection?.rangeCount ?? 0,
      activeTag: document.activeElement?.tagName,
      activeRole: document.activeElement?.getAttribute("role"),
      boardUserSelect: boardStyle.userSelect,
      boardWebkitUserSelect: boardStyle.webkitUserSelect,
      inactiveTabIndexes: document.querySelectorAll('.board [tabindex="-1"]').length,
    };
  });

  expect(selectionState.selectedText).toBe("");
  expect(selectionState.rangeCount).toBe(0);
  expect(selectionState.activeTag).toBe("BODY");
  expect(selectionState.activeRole).toBeNull();
  expect(selectionState.boardUserSelect).toBe("none");
  expect(selectionState.boardWebkitUserSelect).toBe("none");
  expect(selectionState.inactiveTabIndexes).toBe(0);
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
