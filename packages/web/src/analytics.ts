export interface AnalyticsPayload {
  mode: "local" | "network" | "replay";
  platform: "desktop" | "mobile";
  [key: string]: unknown;
}

export const platform = (): "desktop" | "mobile" =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches ? "mobile" : "desktop";

const analyticsBaseUrl = (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL ?? "http://127.0.0.1:8787";

export const track = (eventName: string, payload: AnalyticsPayload): void => {
  const event = { eventName, payload, createdAt: new Date().toISOString() };
  console.info("[analytics]", event);
  try {
    const existing = JSON.parse(window.localStorage.getItem("colonizt.analytics") ?? "[]") as unknown[];
    existing.push(event);
    window.localStorage.setItem("colonizt.analytics", JSON.stringify(existing.slice(-200)));
  } catch {
    // Analytics must never break gameplay.
  }
  try {
    const body = JSON.stringify({ eventName, payload });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(`${analyticsBaseUrl}/analytics`, new Blob([body], { type: "application/json" }));
    } else if (typeof fetch === "function") {
      void fetch(`${analyticsBaseUrl}/analytics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => undefined);
    }
  } catch {
    // Network analytics are best-effort only.
  }
};
