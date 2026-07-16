import { buildOperatorDiagnostic, type RoomHealthPayload } from "../packages/server/src/operator-diagnostics.js";

const baseUrl = (process.env.COLONIZT_ADMIN_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const adminToken = process.env.ADMIN_TOKEN?.trim();
const headers = adminToken ? { authorization: `Bearer ${adminToken}` } : undefined;

const request = async (path: string): Promise<Response> => {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response;
};

const [healthResponse, metricsResponse] = await Promise.all([
  request("/admin/rooms/health"),
  request("/metrics"),
]);
const health = await healthResponse.json() as RoomHealthPayload;
const metrics = await metricsResponse.text();
console.log(JSON.stringify(buildOperatorDiagnostic(health, metrics), null, 2));
