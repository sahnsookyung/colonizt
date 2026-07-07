import { expect, test } from "@playwright/test";

test("local bot game first screen is playable on desktop", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Colonizt" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Bot Match/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Player Match/ })).toBeVisible();
  await page.getByRole("button", { name: /Bot Match/ }).click();
  await expect(page.getByLabel("Game board and actions")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready" })).toHaveCount(0);
  await page.getByRole("button", { name: /Place setup settlement at corner/ }).first().click();
  await expect(page.getByText("Place setup road")).toBeVisible();
  await page.getByRole("button", { name: /Build road here/ }).first().click();
  await expect(page.getByLabel("Game board and actions")).toBeVisible();
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
    expect(card.width).toBeGreaterThan(40);
  }
  expect(metrics.hand.right).toBeLessThanOrEqual(metrics.actions.left - 8);
  expect(metrics.hand.height).toBeLessThanOrEqual(82);
  expect(metrics.actions.height).toBeLessThanOrEqual(78);
});

test("desktop game screen fits the viewport without page scrolling", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /Bot Match/ }).click();
  await expect(page.getByLabel("Game board and actions")).toBeVisible();

  const metrics = await page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, height: rect.height, left: rect.left, right: rect.right, top: rect.top, width: rect.width };
    };
    const playerCards = [...document.querySelectorAll<HTMLElement>(".players .player")].map((player) => {
      const rect = player.getBoundingClientRect();
      const stats = player.querySelector<HTMLElement>(".player-stats")?.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        top: rect.top,
        height: rect.height,
        statsBottom: stats?.bottom ?? 0,
        statsTop: stats?.top ?? 0,
        statsHeight: stats?.height ?? 0,
      };
    });
    return {
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body.scrollHeight,
      shell: box(".app-shell"),
      boardLayout: box(".board-layout"),
      boardStage: box(".board-stage"),
      sidePanel: box(".side-panel"),
      players: box(".players"),
      playerCards,
    };
  });

  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.bodyScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.shell.height).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.boardLayout.bottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.boardStage.bottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.sidePanel.bottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.playerCards).toHaveLength(4);
  expect(metrics.playerCards.at(-1)?.bottom ?? 0).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  for (const card of metrics.playerCards) {
    expect(card.statsHeight).toBeGreaterThan(18);
    expect(card.statsTop).toBeGreaterThanOrEqual(card.top);
    expect(card.statsBottom).toBeLessThanOrEqual(card.bottom);
  }
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

test("special card action keeps cost icons clear of the label", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await page.goto("/");
  await page.getByRole("button", { name: /Bot Match/ }).click();

  const metrics = await page.evaluate(() => {
    const special = document.querySelector<HTMLElement>(".board-action.special-action");
    const label = special?.querySelector<HTMLElement>(":scope > span:not(.action-cost-icons)");
    const costIcons = special?.querySelector<HTMLElement>(".action-cost-icons");
    if (!special || !label || !costIcons) throw new Error("Missing special action parts");
    const rect = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return { bottom: box.bottom, height: box.height, left: box.left, right: box.right, top: box.top, width: box.width };
    };
    return {
      button: rect(special),
      label: rect(label),
      costIcons: rect(costIcons),
    };
  });

  expect(metrics.label.bottom).toBeLessThanOrEqual(metrics.costIcons.top + 1);
  expect(metrics.costIcons.bottom).toBeLessThanOrEqual(metrics.button.bottom + 1);
  expect(metrics.label.height).toBeGreaterThan(8);
  expect(metrics.costIcons.height).toBeGreaterThan(10);
});

test("dynamic UI text stays contained without overlapping controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Bot Match/ }).click();
  await expect(page.getByLabel("Game board and actions")).toBeVisible();

  await page.evaluate(() => {
    const longText = "GeneratedTextWithoutNaturalBreaks".repeat(6);
    const setText = (selector: string, prefix: string) => {
      document.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
        element.textContent = `${prefix} ${index + 1} ${longText}`;
      });
    };
    setText(".player-heading strong", "Player");
    setText(".phase-card strong", "Panel");
    setText(".phase-card > span:not(.eyebrow)", "Status");
    setText(".board-action > span:not(.action-cost-icons)", "Action");
    setText(".game-log-panel li", "Event");
  });

  const issues = await page.evaluate(() => {
    type Rect = { bottom: number; height: number; left: number; right: number; top: number; width: number };
    const rectFor = (element: Element): Rect => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, height: rect.height, left: rect.left, right: rect.right, top: rect.top, width: rect.width };
    };
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const boundaryFor = (element: HTMLElement) =>
      element.closest<HTMLElement>(".board-action,.player-heading,.player-mobile-stats,.phase-card,.event-strip,.topbar,.lobby-seat")
      ?? element.parentElement;
    const problems: string[] = [];

    for (const selector of [
      ".player-heading strong",
      ".player-mobile-stats span",
      ".phase-card strong",
      ".phase-card > span:not(.eyebrow)",
      ".board-action span",
      ".panel-title strong",
      ".panel-title span",
    ]) {
      document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
        if (!isVisible(element)) return;
        const boundary = boundaryFor(element);
        if (!boundary || !isVisible(boundary)) return;
        const rect = rectFor(element);
        const bounds = rectFor(boundary);
        if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) {
          problems.push(`${selector} escapes ${boundary.className}`);
        }
      });
    }

    const overlaps = (left: Rect, right: Rect) =>
      Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1
      && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1;

    for (const selector of [".players", ".board-action-bar", ".game-log-panel ol", ".side-panel"]) {
      const container = document.querySelector<HTMLElement>(selector);
      if (!container || !isVisible(container)) continue;
      const boxes = [...container.children]
        .filter((child) => isVisible(child))
        .map((child) => ({ name: child.className || child.tagName, rect: rectFor(child) }));
      for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
          const left = boxes[leftIndex]!;
          const right = boxes[rightIndex]!;
          if (overlaps(left.rect, right.rect)) problems.push(`${selector} children overlap: ${left.name} / ${right.name}`);
        }
      }
    }

    return problems;
  });

  expect(issues).toEqual([]);
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

test("mobile online lobby stays scrollable and starts from two ready players", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile project only");
  await page.setViewportSize({ width: 390, height: 640 });
  await page.addInitScript(() => {
    type TestSeat = { seatIndex: number; userId?: string; botId?: string; displayName?: string; ready: boolean; connected: boolean };
    type TestRoom = {
      id: string;
      code: string;
      inviteUrl: string;
      status: string;
      hostUserId: string;
      settings: {
        mode: string;
        botFill: boolean;
        ranked: boolean;
        minPlayers: number;
        maxPlayers: number;
        botDifficulty: string;
        rules: { mapPreset: string; mapRandomized: boolean };
      };
      seats: TestSeat[];
      spectatorCount: number;
      events: unknown[];
    };
    const testWindow = window as typeof window & {
      __lobbyRoom: TestRoom;
      __sentMessages: unknown[];
    };
    testWindow.__sentMessages = [];
    testWindow.__lobbyRoom = {
      id: "room_mobile",
      code: "MOB123",
      inviteUrl: "https://play.example/?room=MOB123",
      status: "LOBBY",
      hostUserId: "u_host",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4, botDifficulty: "medium", rules: { mapPreset: "standard", mapRandomized: true } },
      seats: [
        { seatIndex: 0, userId: "u_host", displayName: "Mobile Host", ready: true, connected: true },
        { seatIndex: 1, userId: "u_guest", displayName: "Guest", ready: true, connected: true },
        { seatIndex: 2, ready: false, connected: false },
        { seatIndex: 3, ready: false, connected: false },
      ],
      spectatorCount: 0,
      events: [],
    };

    class FakeWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = FakeWebSocket.OPEN;

      constructor(url: string) {
        super();
        this.url = url;
        setTimeout(() => this.dispatchEvent(new Event("open")), 0);
      }

      send(payload: string): void {
        const message = JSON.parse(payload) as { type: string; seatIndex?: number };
        testWindow.__sentMessages.push(message);
        if (message.type === "JOIN_ROOM") {
          setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: testWindow.__lobbyRoom }) })), 0);
        }
        if (message.type === "ADD_BOT") {
          const seats = testWindow.__lobbyRoom.seats.map((seat) => ({ ...seat }));
          const seat = seats.find((candidate) => !candidate.userId && !candidate.botId);
          if (seat) {
            seat.botId = `bot_${seat.seatIndex + 1}`;
            seat.displayName = `Bot ${seat.seatIndex + 1}`;
            seat.ready = true;
            seat.connected = true;
          }
          testWindow.__lobbyRoom = { ...testWindow.__lobbyRoom, seats };
          setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ROOM_STATE", room: testWindow.__lobbyRoom }) })), 0);
        }
      }

      close(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    }

    Object.assign(FakeWebSocket, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
    });
    window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });
  await page.route("**/config", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ apiBaseUrl: "http://127.0.0.1:8787", wsBaseUrl: "ws://127.0.0.1:8787" }),
    });
  });
  await page.route("**/sessions", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ token: "s_host", userId: "u_host", displayName: "Mobile Host" }) });
  });
  await page.route("**/rooms", async (route) => {
    const room = await page.evaluate(() => (window as typeof window & { __lobbyRoom: unknown }).__lobbyRoom);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(room) });
  });
  await page.route("**/ws-tickets", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ticket: "wst_mobile", expiresAt: "2026-06-22T00:00:00.000Z", ttlMs: 30_000 }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Player Match/ }).click();
  await expect(page.getByLabel("Online lobby")).toBeVisible();
  await expect(page.locator(".lobby-code-card strong")).toContainText("MOB123");

  const layout = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!shell) throw new Error("Missing app shell");
    const shellBox = shell.getBoundingClientRect();
    return {
      overflow: window.getComputedStyle(shell).overflow,
      shellHeight: shellBox.height,
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  });
  expect(layout.overflow).not.toBe("hidden");
  expect(layout.scrollHeight).toBeGreaterThan(layout.viewportHeight);

  await page.getByRole("group", { name: "Lobby bots" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("group", { name: "Lobby bots" })).toBeVisible();
  await page.getByRole("button", { name: "Add Bot" }).click();
  await expect(page.getByLabel("Lobby seats and rules")).toContainText("Bot 3");

  await page.getByRole("button", { name: "Go" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Go" })).toBeEnabled();
  await page.getByRole("button", { name: "Go" }).click();
  const sentMessages = await page.evaluate(() => (window as typeof window & { __sentMessages: Array<{ type: string; roomId?: string }> }).__sentMessages);
  expect(sentMessages).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "ADD_BOT", roomId: "MOB123" }),
    expect.objectContaining({ type: "START_ROOM", roomId: "MOB123" }),
  ]));
});
