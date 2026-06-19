import { resolveRuntimeConfig } from "./network.js";

export interface AnalyticsPayload {
  mode: "local" | "network" | "replay";
  platform: "desktop" | "mobile";
  [key: string]: unknown;
}

export const platform = (): "desktop" | "mobile" =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches ? "mobile" : "desktop";

const analyticsEnv = (import.meta as ImportMeta & { env?: { DEV?: boolean; MODE?: string } }).env;
const shouldLogAnalytics = Boolean(analyticsEnv?.DEV || analyticsEnv?.MODE === "test");

const sendNetworkAnalytics = async (body: string): Promise<void> => {
  const config = await resolveRuntimeConfig();
  const url = `${config.apiBaseUrl}/analytics`;
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
  } else if (typeof fetch === "function") {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
  }
};

export const track = (eventName: string, payload: AnalyticsPayload): void => {
  const event = { eventName, payload, createdAt: new Date().toISOString() };
  if (shouldLogAnalytics) console.info("[analytics]", event);
  try {
    const existing = JSON.parse(window.localStorage.getItem("colonizt.analytics") ?? "[]") as unknown[];
    existing.push(event);
    window.localStorage.setItem("colonizt.analytics", JSON.stringify(existing.slice(-200)));
  } catch {
    // Analytics must never break gameplay.
  }
  try {
    const body = JSON.stringify({ eventName, payload });
    void sendNetworkAnalytics(body).catch(() => undefined);
  } catch {
    // Network analytics are best-effort only.
  }
};
