import { createPool, runMigrations } from "./index.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const pool = createPool({ connectionString });
await runMigrations(pool);
await pool.end();
console.log("Migrations applied");
