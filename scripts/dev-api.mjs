import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { goExecutable, stopProcess } from "./processes.mjs";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../backend");
const directory = mkdtempSync(join(tmpdir(), "stockflow-api-"));
const go = goExecutable();
let compiler;
let server;
let currentBinary;
let timer;
let building = false;
let pending = false;
let stopping = false;
let generation = 0;

const watcher = watch(backend, { recursive: true }, (_event, filename) => {
  if (
    !filename ||
    !(/\.(go|sql)$/.test(filename) || /(^|[/\\])go\.(mod|sum)$/.test(filename))
  )
    return;
  clearTimeout(timer);
  timer = setTimeout(rebuild, 300);
});
watcher.on("error", (error) => {
  console.error(error.message);
  shutdown(1);
});

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  watcher.close();
  await stopProcess(compiler);
  await stopProcess(server);
  rmSync(directory, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

async function rebuild() {
  if (stopping) return;
  pending = true;
  if (building) return;
  building = true;
  while (pending && !stopping) {
    pending = false;
    const binary = join(
      directory,
      `api-${++generation}${process.platform === "win32" ? ".exe" : ""}`,
    );
    console.log("[api] Building Go API…");
    const succeeded = await new Promise((resolveBuild) => {
      compiler = spawn(go, ["build", "-o", binary, "./cmd/api"], {
        cwd: backend,
        stdio: "inherit",
      });
      compiler.once("error", (error) => {
        console.error(`[api] ${error.message}`);
        resolveBuild(false);
      });
      compiler.once("exit", (code) => resolveBuild(code === 0));
    });
    compiler = undefined;
    if (stopping) break;
    if (!succeeded) {
      console.error(
        "[api] Build failed. Fix the compiler errors; saving a Go file will retry.",
      );
      continue;
    }
    const oldServer = server;
    server = undefined;
    await stopProcess(oldServer);
    if (currentBinary) rmSync(currentBinary, { force: true });
    if (stopping) break;
    currentBinary = binary;
    const child = spawn(binary, [], { cwd: backend, stdio: "inherit" });
    server = child;
    child.once("error", (error) => {
      console.error(`[api] ${error.message}`);
      shutdown(1);
    });
    child.once("exit", (code) => {
      if (server === child && !stopping) {
        console.error(
          "[api] API stopped. Check the database connection and listening port above.",
        );
        shutdown(code || 1);
      }
    });
  }
  building = false;
}

console.log("[api] Watching Go and migration files. Ctrl+C stops the API.");
rebuild();
