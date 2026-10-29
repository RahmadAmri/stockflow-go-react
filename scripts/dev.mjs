import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFreePort, stopProcess } from "./processes.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vite = resolve(root, "frontend/node_modules/vite/bin/vite.js");
const apiURL = new URL(process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8080");
const webPort = Number(process.env.WEB_PORT ?? "5173");
const children = [];
let stopping = false;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all(children.map(stopProcess));
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function start(args, cwd, env = process.env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
  children.push(child);
  child.once("error", (error) => {
    console.error(error.message);
    shutdown(1);
  });
  child.once("exit", (code) => {
    if (!stopping) shutdown(code || 1);
  });
}

try {
  if (!existsSync(vite))
    throw new Error(
      "Install frontend dependencies first: npm --prefix frontend ci",
    );
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535)
    throw new Error("WEB_PORT must be a valid port number");
  if (!["127.0.0.1", "localhost"].includes(apiURL.hostname))
    throw new Error(
      "The local dev runner requires a localhost API_PROXY_TARGET",
    );
  await requireFreePort(Number(apiURL.port || 80));
  await requireFreePort(webPort);
  start([resolve(root, "scripts/dev-api.mjs")], root, {
    ...process.env,
    HTTP_ADDR: process.env.HTTP_ADDR ?? `127.0.0.1:${apiURL.port || 80}`,
  });
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/api/health", apiURL), {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait until the compiler and database startup finish. */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  if (!ready)
    throw new Error(
      "API did not become ready. Check PostgreSQL and DATABASE_URL.",
    );
  start(
    [vite, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
    resolve(root, "frontend"),
    {
      ...process.env,
      API_PROXY_TARGET: apiURL.origin,
    },
  );
  console.log(
    "[dev] API is ready. Go changes rebuild automatically; Ctrl+C stops both services.",
  );
} catch (error) {
  console.error(`[dev] ${error.message}`);
  await shutdown(1);
}
