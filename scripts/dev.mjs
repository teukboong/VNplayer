import { spawn } from "node:child_process";

const children = [];

function run(name, command, args, env = {}, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env }
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (signal) {
      return;
    }
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      if (options.fatal === false) {
        if (options.restartOnFailure) {
          const delayMs = options.restartDelayMs ?? 5000;
          console.error(`${name} will restart in ${delayMs}ms`);
          setTimeout(() => run(name, command, args, env, options), delayMs);
        }
        return;
      }
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

async function waitForHealth(url, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

run("server-build", "npm", ["run", "build:server"]).on("exit", (code) => {
  if (code === 0) {
    const backendBaseUrl = process.env.VNPLAYER_LOCAL_BASE_URL ?? "http://127.0.0.1:4174";
    const backendHealthUrl = `${backendBaseUrl}/api/health`;

    run("server", "node", ["dist/server/apps/server/src/index.js"], {
      VNPLAYER_PORT: "4174"
    });
    run("vite", "npm", ["run", "dev:web"]);

    waitForHealth(backendHealthUrl).then((ready) => {
      if (!ready) {
        console.error("backend health did not become ready; sidecar workers were not started");
        return;
      }

      if (process.env.VNPLAYER_DEV_MCP_TUNNEL !== "0") {
        run(
          "mcp-tunnel",
          "npm",
          ["run", "frontdoor:tunnel"],
          {
            VNPLAYER_TUNNEL_TARGET_URL: backendBaseUrl
          },
          { fatal: false }
        );
      }

      if (process.env.VNPLAYER_DEV_CG_WORKER === "1") {
        run(
          "cg-worker",
          "node",
          ["scripts/webgpt-cg-worker.mjs", "--watch", "--continue-on-error"],
          {
            VNPLAYER_LOCAL_BASE_URL: backendBaseUrl,
            VNPLAYER_WEBGPT_CG_ALLOW_GLOBAL: process.env.VNPLAYER_WEBGPT_CG_ALLOW_GLOBAL ?? "1",
            VNPLAYER_WEBGPT_CG_ACTIVE_ONLY: process.env.VNPLAYER_WEBGPT_CG_ACTIVE_ONLY ?? "1",
            VNPLAYER_WEBGPT_CG_MAX_ERRORS: process.env.VNPLAYER_WEBGPT_CG_MAX_ERRORS ?? "25",
            VNPLAYER_WEBGPT_CG_IDLE_MS: process.env.VNPLAYER_WEBGPT_CG_IDLE_MS ?? "3000"
          },
          { fatal: false, restartOnFailure: true, restartDelayMs: 5000 }
        );
      }
    });
  }
});
