export const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const nonNegativeInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

export const configuredSecret = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const sqlStatePattern = /^[0-9A-Z]{5}$/u;

export const isDatabaseError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; routine?: unknown; severity?: unknown };
  return typeof candidate.code === "string"
    && sqlStatePattern.test(candidate.code)
    && (typeof candidate.routine === "string" || typeof candidate.severity === "string");
};

interface ExternalRequest {
  headers: Record<string, unknown>;
  protocol?: string;
  hostname?: string;
}

export const externalBaseUrl = (request: ExternalRequest, configured?: string): string => {
  if (configured) return configured.replace(/\/$/, "");
  const protoHeader = request.headers["x-forwarded-proto"];
  const hostHeader = request.headers["x-forwarded-host"] ?? request.headers.host;
  const proto = typeof protoHeader === "string" ? protoHeader.split(",")[0]!.trim() : request.protocol ?? "http";
  const host = typeof hostHeader === "string" ? hostHeader.split(",")[0]!.trim() : request.hostname ?? "127.0.0.1";
  return `${proto}://${host}`.replace(/\/$/, "");
};
