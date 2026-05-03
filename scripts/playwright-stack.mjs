import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const testDataDir = join(cwd, "tmp", "playwright-data");
const backendPort = process.env.VNPLAYER_TEST_PORT ?? "4274";
const webPort = process.env.VNPLAYER_TEST_WEB_PORT ?? "4273";
rmSync(testDataDir, { recursive: true, force: true });

const build = spawnSync("npm", ["run", "build:server"], {
  cwd,
  stdio: "inherit",
  env: process.env
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const children = [];

function run(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env }
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (!signal && code && code !== 0) {
      shutdown(code);
    }
  });
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("node", ["dist/server/apps/server/src/index.js"], {
  VNPLAYER_PORT: backendPort,
  VNPLAYER_DATA_DIR: testDataDir
});
run("npx", ["vite", "--host", "127.0.0.1", "--port", webPort], {
  VNPLAYER_WEB_PORT: webPort,
  VNPLAYER_PORT: backendPort
});
