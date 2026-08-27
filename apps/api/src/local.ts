import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import app from "./app";
import { serverConfig } from "./config";
import { closeDatabase } from "./db/client";

const config = serverConfig();
const local = new Hono();
local.use(
  "/auth-ui/*",
  serveStatic({
    root: new URL("../public", import.meta.url).pathname,
    rewriteRequestPath: (path) => path.replace(/^\/auth-ui/, "/auth-ui"),
  }),
);
local.route("/", app);

const server = serve({ fetch: local.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Cinesim API listening on http://${info.address}:${info.port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await closeDatabase();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
