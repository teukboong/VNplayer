#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

function argValue(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function conversationModeFromValue(value) {
  return value === "new" ? "new" : "resume";
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function passthroughArgs() {
  const allowed = new Set(["--local-base-url", "--webgpt-mcp-wrapper", "--timeout-secs", "--artifact-dir", "--world-id", "--session-id"]);
  const args = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const item = process.argv[index];
    if (!allowed.has(item)) {
      if (item?.startsWith("--") && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
        index += 1;
      }
      continue;
    }
    args.push(item);
    if (process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
      args.push(process.argv[index + 1]);
      index += 1;
    }
  }
  return args;
}

function hasScopedArgs(args) {
  return args.includes("--world-id") || args.includes("--session-id");
}

function isSmokeWorldSummary(world) {
  const title = typeof world?.title === "string" ? world.title : "";
  const seedPreview = typeof world?.seedPreview === "string" ? world.seedPreview : "";
  return /^Rain Archive \d+$/.test(title) && seedPreview.includes("A literary mystery about memory, weather, and quiet choices.");
}

async function activeScopeArgs(localBaseUrl) {
  const response = await fetch(`${localBaseUrl}/api/webgpt/tools/vn_list_worlds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  if (!response.ok) {
    throw new Error(`active world lookup failed: ${response.status}`);
  }
  const body = await response.json();
  const world = Array.isArray(body.worlds)
    ? body.worlds.find((item) => !isSmokeWorldSummary(item) && typeof item?.worldId === "string" && typeof item?.latestSessionId === "string")
    : null;
  if (!world) {
    return [];
  }
  return ["--world-id", world.worldId, "--session-id", world.latestSessionId];
}

function parseLastJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("\n{");
    if (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function main() {
  const idleMs = Math.max(250, Number(argValue("--idle-ms", process.env.VNPLAYER_WEBGPT_CG_IDLE_MS ?? "3000")));
  const watch = hasFlag("--watch") || process.env.VNPLAYER_WEBGPT_CG_WATCH === "1";
  const verbose = hasFlag("--verbose") || process.env.VNPLAYER_WEBGPT_CG_VERBOSE === "1";
  const maxJobsRaw = argValue("--max-jobs", process.env.VNPLAYER_WEBGPT_CG_MAX_JOBS);
  const maxJobs = maxJobsRaw === undefined && watch ? Number.POSITIVE_INFINITY : Math.max(1, Number(maxJobsRaw ?? "20"));
  const continueOnError = hasFlag("--continue-on-error") || process.env.VNPLAYER_WEBGPT_CG_CONTINUE_ON_ERROR === "1";
  const maxErrors = Math.max(1, Number(argValue("--max-errors", process.env.VNPLAYER_WEBGPT_CG_MAX_ERRORS ?? "5")));
  const conversationMode = conversationModeFromValue(argValue("--conversation-mode", process.env.VNPLAYER_WEBGPT_CG_CONVERSATION_MODE ?? "resume"));
  const childArgs = passthroughArgs();
  const localBaseUrl = argValue("--local-base-url", process.env.VNPLAYER_LOCAL_BASE_URL ?? "http://127.0.0.1:4174").replace(/\/$/, "");
  const activeOnly = process.env.VNPLAYER_WEBGPT_CG_ACTIVE_ONLY !== "0" && !hasScopedArgs(childArgs);
  let processed = 0;
  let emptyPolls = 0;
  let errors = 0;

  while (processed < maxJobs) {
    let scopedArgs = childArgs;
    if (activeOnly) {
      try {
        const scopeArgs = await activeScopeArgs(localBaseUrl);
        if (!scopeArgs.length) {
          emptyPolls += 1;
          if (watch && (emptyPolls === 1 || verbose)) {
            console.log(JSON.stringify({ ok: true, watch, idle: true, activeOnly, reason: "active world/session이 없습니다.", emptyPolls, processed, errors }, null, 2));
          }
          if (!watch) {
            break;
          }
          await sleep(idleMs);
          continue;
        }
        scopedArgs = [...childArgs, ...scopeArgs];
      } catch (error) {
        errors += 1;
        if (verbose || !continueOnError) {
          console.error(error instanceof Error ? error.stack || error.message : String(error));
        }
        if (!continueOnError || errors >= maxErrors) {
          process.exitCode = 1;
          return;
        }
        await sleep(idleMs);
        continue;
      }
    }
    const oneShotArgs = conversationMode === "new" && processed === 0
      ? [...scopedArgs, "--conversation-mode", "new"]
      : scopedArgs;
    const result = spawnSync(process.execPath, ["scripts/webgpt-cg-once.mjs", ...oneShotArgs], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 12
    });
    const parsed = parseLastJson(result.stdout ?? "");
    if (result.stdout && (verbose || parsed?.claimed || result.status !== 0)) {
      process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    }
    if (result.stderr && (verbose || result.status !== 0)) {
      process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
    }
    if (result.status !== 0) {
      errors += 1;
      if (!continueOnError || errors >= maxErrors) {
        process.exitCode = result.status ?? 1;
        return;
      }
      await sleep(idleMs);
      continue;
    }
    if (!parsed?.claimed) {
      emptyPolls += 1;
      if (watch && (emptyPolls === 1 || verbose)) {
        console.log(JSON.stringify({ ok: true, watch, idle: true, emptyPolls, processed, errors }, null, 2));
      }
      if (!watch) {
        break;
      }
      await sleep(idleMs);
      continue;
    }
    emptyPolls = 0;
    processed += 1;
  }

  console.log(JSON.stringify({ ok: true, processed, watch, maxJobs: Number.isFinite(maxJobs) ? maxJobs : "unbounded", emptyPolls, errors }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
