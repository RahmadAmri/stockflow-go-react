import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";

export function goExecutable() {
  if (process.env.GO_BINARY) return process.env.GO_BINARY;
  const executable = process.platform === "win32" ? "go.exe" : "go";
  const candidates = [
    process.env.GOROOT && join(process.env.GOROOT, "bin", executable),
    "/usr/local/go/bin/go",
    "/opt/homebrew/bin/go",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  // Some machines expose an npm wrapper as `go`. Resolve its native toolchain
  // so signals and compiler arguments go directly to Go.
  const result = spawnSync("go", ["env", "GOROOT"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status === 0) {
    const binary = join(
      result.stdout.trim(),
      "bin",
      process.platform === "win32" ? "go.exe" : "go",
    );
    if (existsSync(binary)) return binary;
  }
  return "go";
}

export async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function requireFreePort(port, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(
        new Error(
          `Port ${port} is already in use. Stop the existing StockFlow process before starting another copy.`,
        ),
      ),
    );
    probe.listen(port, host, () => probe.close(resolve));
  });
}
