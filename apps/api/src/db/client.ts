import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { serverConfig } from "../config";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: serverConfig().databaseUrl,
  max: serverConfig().environment === "development" ? 5 : 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle({ client: pool, schema });

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
