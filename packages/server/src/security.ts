import { createHash } from "node:crypto";

export const hashSessionToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
};

export const hashCommandPayload = (payload: unknown): string =>
  createHash("sha256").update(stableJson(payload)).digest("hex");
