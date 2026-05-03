#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const defaultWrapper = join(repoRoot, "scripts", "webgpt-local-wrapper.mjs");
const homeDir = process.env.HOME ?? "/tmp";
const defaultTextProfileDir = join(homeDir, ".vnplayer", "chatgpt-text-profile");
const defaultCgProfileDir = join(homeDir, ".vnplayer", "chatgpt-cg-profile");
const defaultTextCdpPort = "9228";
const defaultCgCdpPort = "9229";
const imageExtensions = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);

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

function resolveWebgptWrapper(value) {
  const rawWrapper = value?.trim() || defaultWrapper;
  const wrapper = rawWrapper.startsWith(".") ? resolve(repoRoot, rawWrapper) : rawWrapper;
  if (!wrapper) {
    throw new Error("VNPLAYER_WEBGPT_MCP_WRAPPER 또는 --webgpt-mcp-wrapper 값이 필요합니다. VNplayer는 외부 repo 경로를 기본값으로 참조하지 않습니다.");
  }
  const isLocalRepoPath = wrapper === repoRoot || wrapper.startsWith(`${repoRoot}/`);
  const wrapperGitRoot = isLocalRepoPath ? repoRoot : nearestGitRoot(wrapper);
  if (wrapperGitRoot && wrapperGitRoot !== repoRoot) {
    throw new Error(`VNplayer WebGPT wrapper는 다른 git repo에서 가져올 수 없습니다: ${wrapper}`);
  }
  return wrapper;
}

function nearestGitRoot(path) {
  let cursor = existsSync(path) ? path : dirname(path);
  while (cursor && cursor !== dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) {
      return cursor;
    }
    cursor = dirname(cursor);
  }
  return null;
}

function laneSeatConfig(lane) {
  const textProfile = resolve(process.env.VNPLAYER_WEBGPT_TEXT_PROFILE_DIR ?? defaultTextProfileDir);
  const cgProfile = resolve(process.env.VNPLAYER_WEBGPT_CG_PROFILE_DIR ?? defaultCgProfileDir);
  const textPort = process.env.VNPLAYER_WEBGPT_TEXT_CDP_PORT ?? defaultTextCdpPort;
  const cgPort = process.env.VNPLAYER_WEBGPT_CG_CDP_PORT ?? defaultCgCdpPort;
  const textUrl = process.env.VNPLAYER_WEBGPT_TEXT_CDP_URL ?? null;
  const cgUrl = process.env.VNPLAYER_WEBGPT_CG_CDP_URL ?? null;
  const textManualProfile = resolve(process.env.VNPLAYER_WEBGPT_TEXT_MANUAL_PROFILE_DIR ?? textProfile);
  const cgManualProfile = resolve(process.env.VNPLAYER_WEBGPT_CG_MANUAL_PROFILE_DIR ?? cgProfile);
  if (textProfile === cgProfile) {
    throw new Error(`WebGPT text/CG profile이 같습니다. 분리해야 합니다: ${textProfile}`);
  }
  if (textPort === cgPort) {
    throw new Error(`WebGPT text/CG CDP port가 같습니다. 분리해야 합니다: ${textPort}`);
  }
  if (textUrl && cgUrl && textUrl === cgUrl) {
    throw new Error(`WebGPT text/CG CDP URL이 같습니다. 분리해야 합니다: ${textUrl}`);
  }
  return lane === "text"
    ? { profileDir: textProfile, manualProfileDir: textManualProfile, cdpPort: textPort, cdpUrl: textUrl }
    : { profileDir: cgProfile, manualProfileDir: cgManualProfile, cdpPort: cgPort, cdpUrl: cgUrl };
}

function webgptSeatEnv(lane) {
  const seat = laneSeatConfig(lane);
  const env = {
    ...process.env,
    WEBGPT_MCP_PROFILE_DIR: seat.profileDir,
    WEBGPT_MCP_MANUAL_PROFILE_DIR: seat.manualProfileDir,
    WEBGPT_MCP_CDP_PORT: seat.cdpPort
  };
  if (seat.cdpUrl) {
    env.WEBGPT_MCP_CDP_URL = seat.cdpUrl;
  } else {
    delete env.WEBGPT_MCP_CDP_URL;
  }
  return env;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(`${url} 실패: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function pushUnique(values, value) {
  if (value && !values.includes(value)) {
    values.push(value);
  }
}

function stringsFromUnknown(value, depth = 0) {
  if (depth > 8) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringsFromUnknown(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => stringsFromUnknown(item, depth + 1));
  }
  return [];
}

function imageSourcesFromAnswer(answer) {
  const text = [answer.answer_markdown, answer.text, answer.output, typeof answer === "string" ? answer : ""]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  const sources = [];
  const markdownDataImage = text.match(/!\[[^\]]*]\((data:image\/[^)\s]+)\)/);
  if (markdownDataImage?.[1]) {
    pushUnique(sources, markdownDataImage[1]);
  }
  const markdownImage = text.match(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/);
  if (markdownImage?.[1]) {
    pushUnique(sources, markdownImage[1]);
  }
  const dataUrl = text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
  if (dataUrl?.[0]) {
    pushUnique(sources, dataUrl[0]);
  }
  const url = text.match(/https?:\/\/\S+\.(?:png|jpg|jpeg|webp)(?:\?\S*)?/i);
  if (url?.[0]) {
    pushUnique(sources, url[0]);
  }
  for (const raw of stringsFromUnknown(answer)) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const directUrl = trimmed.match(/^https?:\/\/\S+\.(?:png|jpg|jpeg|webp|gif)(?:\?\S*)?$/i);
    const directData = trimmed.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/);
    const fileUrl = trimmed.startsWith("file://") ? new URL(trimmed).pathname : null;
    const localPath = fileUrl ?? trimmed;
    const ext = extname(localPath).toLowerCase();
    if (directData?.[0]) {
      pushUnique(sources, directData[0]);
    } else if (directUrl?.[0]) {
      pushUnique(sources, directUrl[0]);
    } else if (imageExtensions.has(ext) && existsSync(localPath)) {
      pushUnique(sources, localPath);
    }
  }
  return sources;
}

function localImageSourceToDataUrl(source) {
  const ext = extname(source).toLowerCase();
  const mimeType = imageExtensions.get(ext);
  if (!mimeType) {
    throw new Error(`지원하지 않는 로컬 이미지 확장자입니다: ${source}`);
  }
  const bytes = readFileSync(source);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function findImageFiles(root, depth = 0) {
  if (depth > 4 || !existsSync(root)) {
    return [];
  }
  const entries = readdirSync(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findImageFiles(path, depth + 1));
    } else if (entry.isFile() && imageExtensions.has(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }
  return files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

async function importImageSource(localBaseUrl, source) {
  if (!source) {
    return { imageUrl: null, imported: null };
  }
  const body = source.startsWith("data:image/")
    ? { dataUrl: source }
    : imageExtensions.has(extname(source).toLowerCase()) && existsSync(source)
      ? { dataUrl: localImageSourceToDataUrl(source) }
      : { imageUrl: source };
  const imported = await postJson(`${localBaseUrl}/api/cg-assets/import`, body);
  return {
    imageUrl: imported.assetUrl,
    imported: {
      originalSource: source.startsWith("data:image/") ? "data-url" : source,
      assetUrl: imported.assetUrl,
      sha256: imported.sha256,
      bytes: imported.bytes,
      mimeType: imported.mimeType
    }
  };
}

function cgAssetPathFromUrl(localBaseUrl, imageUrl) {
  if (typeof imageUrl !== "string" || !imageUrl.trim()) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return null;
  }
  let localOrigin = null;
  try {
    localOrigin = new URL(localBaseUrl).origin;
  } catch {
    localOrigin = null;
  }
  const isLocal =
    parsed.origin === localOrigin ||
    ((parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.pathname.startsWith("/api/cg-assets/"));
  if (!isLocal || !parsed.pathname.startsWith("/api/cg-assets/")) {
    return null;
  }
  const filename = decodeURIComponent(parsed.pathname.slice("/api/cg-assets/".length));
  if (!/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(filename)) {
    return null;
  }
  const path = join(repoRoot, "data", "cg-assets", filename);
  return existsSync(path) ? path : null;
}

function referenceImagePathsForJob(job, localBaseUrl) {
  if (job.kind !== "cg_asset") {
    return [];
  }
  const boards = Array.isArray(job.payload?.referenceBoards) ? job.payload.referenceBoards : [];
  const paths = [];
  for (const board of boards) {
    const imageUrl = board && typeof board === "object" && "imageUrl" in board ? board.imageUrl : null;
    const path = cgAssetPathFromUrl(localBaseUrl, imageUrl);
    if (path) {
      pushUnique(paths, path);
    }
  }
  return paths;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detachCdpBrowser(browser) {
  browser?._connection?.close?.("VNplayer CDP detach");
}

function cdpImageKey(src) {
  try {
    const url = new URL(src);
    return url.searchParams.get("id") || src;
  } catch {
    return src;
  }
}

async function connectCdpBrowser(cdpUrl) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return null;
  }
  return await chromium.connectOverCDP(cdpUrl);
}

async function collectCdpImageKeysFromBrowser(browser) {
  if (!browser) {
    return [];
  }
  const pages = browser.contexts().flatMap((context) => context.pages());
  const keys = new Set();
  for (const page of pages) {
    if (!page.url().startsWith("https://chatgpt.com/")) {
      continue;
    }
    const sources = await page.evaluate(() => Array.from(document.images).map((img) => img.currentSrc || img.src || "")).catch(() => []);
    for (const src of sources) {
      if (src.includes("/backend-api/estuary/content")) {
        keys.add(cdpImageKey(src));
      }
    }
  }
  return [...keys];
}

async function collectCdpImageKeys(cdpUrl) {
  let browser;
  try {
    browser = await connectCdpBrowser(cdpUrl);
    return await collectCdpImageKeysFromBrowser(browser);
  } finally {
    detachCdpBrowser(browser);
  }
}

async function chatgptPageForJob(pages, jobId) {
  for (const page of pages) {
    if (!page.url().startsWith("https://chatgpt.com/c/")) {
      continue;
    }
    const hasJob = await page.evaluate((needle) => document.body?.innerText?.includes(needle) ?? false, jobId).catch(() => false);
    if (hasJob) {
      return page;
    }
  }
  return pages.find((candidate) => candidate.url().startsWith("https://chatgpt.com/c/")) ?? pages[0];
}

async function chatgptGenerationRunning(page) {
  return await page
    .evaluate(() => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
      };
      return Array.from(document.querySelectorAll('button, [role="button"]')).some((element) => {
        if (!visible(element)) {
          return false;
        }
        const label = [
          element.getAttribute("aria-label") || "",
          element.getAttribute("data-testid") || "",
          element.textContent || ""
        ].join(" ");
        return /\bstop\b/i.test(label) || /^(생성|응답|답변|작업)?\s*중지$/.test(label.trim());
      });
    })
    .catch(() => true);
}

async function harvestGeneratedImageFromCdp(localBaseUrl, cdpUrl, { excludedImageKeys = [], jobId } = {}) {
  const browser = await connectCdpBrowser(cdpUrl);
  try {
    return await harvestGeneratedImageFromBrowser(localBaseUrl, browser, { excludedImageKeys, jobId });
  } finally {
    // Attach-only CDP harvest. Closing here can kill the CG browser seat mid-queue.
    detachCdpBrowser(browser);
  }
}

async function harvestGeneratedImageFromBrowser(localBaseUrl, browser, { excludedImageKeys = [], jobId } = {}) {
  if (!browser) {
    return null;
  }
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = jobId ? await chatgptPageForJob(pages, jobId) : pages.find((candidate) => candidate.url().startsWith("https://chatgpt.com/c/")) ?? pages[0];
  if (!page) {
    return null;
  }
  if (await chatgptGenerationRunning(page)) {
    return null;
  }
  const harvested = await page.evaluate(async ({ excludedKeys }) => {
    const excluded = new Set(excludedKeys);
    const keyOf = (src) => {
      try {
        const url = new URL(src);
        return url.searchParams.get("id") || src;
      } catch {
        return src;
      }
    };
    const candidates = Array.from(document.images)
      .map((img, index) => ({
        src: img.currentSrc || img.src || "",
        key: keyOf(img.currentSrc || img.src || ""),
        alt: img.alt || "",
        isAttachmentPreview: Boolean(img.closest('[data-testid*="attachment"], [aria-label*="첨부"], [aria-label*="attachment" i], [class*="attachment"]')),
        isUserUpload: Boolean(img.closest('[data-message-author-role="user"]')),
        hasImageGenFrame: Boolean(img.closest('[class*="imagegen-image"]')),
        inAssistantMessage: Boolean(img.closest('[data-message-author-role="assistant"]')),
        width: img.naturalWidth,
        height: img.naturalHeight,
        index
      }))
      .filter((img) => img.src.includes("/backend-api/estuary/content") && img.width >= 512 && img.height >= 512)
      .filter((img) => !excluded.has(img.key))
      .filter((img) => !img.isUserUpload && !img.isAttachmentPreview && img.alt !== "업로드한 이미지" && !img.alt.toLowerCase().includes("uploaded image"))
      .filter((img) => img.hasImageGenFrame || img.inAssistantMessage || img.alt.includes("생성된 이미지") || img.alt.toLowerCase().includes("generated image"))
      .sort((left, right) => right.index - left.index || right.width * right.height - left.width * left.height);
    const selected = candidates[0];
    if (!selected) {
      return null;
    }
    const response = await fetch(selected.src, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`browser image fetch failed: ${response.status}`);
    }
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
    return { ...selected, dataUrl };
  }, { excludedKeys: excludedImageKeys });
  if (!harvested?.dataUrl) {
    return null;
  }
  const imported = await postJson(`${localBaseUrl}/api/cg-assets/import`, { dataUrl: harvested.dataUrl });
  return {
    imageUrl: imported.assetUrl,
    imported: {
      originalSource: harvested.src,
      assetUrl: imported.assetUrl,
      sha256: imported.sha256,
      bytes: imported.bytes,
      mimeType: imported.mimeType,
      harvestedFromCdp: true,
      width: harvested.width,
      height: harvested.height
    }
  };
}

async function runWebgptWithCdpHarvest({ wrapper, args, env, dispatchDir, localBaseUrl, cdpUrl, timeoutSecs, jobId }) {
  const harvestEnabled = process.env.VNPLAYER_WEBGPT_CG_HARVEST_CDP !== "0";
  let harvestBrowser = null;
  if (harvestEnabled) {
    harvestBrowser = await connectCdpBrowser(cdpUrl).catch((error) => {
      writeFileSync(join(dispatchDir, "cdp-connect-error.txt"), error instanceof Error ? error.message : String(error));
      return null;
    });
  }
  const baselineImageKeys = await collectCdpImageKeysFromBrowser(harvestBrowser).catch(() => []);
  writeFileSync(join(dispatchDir, "cdp-baseline-image-keys.json"), JSON.stringify(baselineImageKeys, null, 2));
  const child = spawn(wrapper, args, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let done = false;
  let harvested = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitPromise = new Promise((resolve) => {
    child.on("exit", (status, signal) => {
      done = true;
      resolve({ status: status ?? (signal ? 1 : 0), signal });
    });
  });
  const startedAt = Date.now();
  const harvestAfterMs = Math.max(5_000, Number(process.env.VNPLAYER_WEBGPT_CG_HARVEST_AFTER_MS ?? "20000"));
  const pollMs = Math.max(1_000, Number(process.env.VNPLAYER_WEBGPT_CG_HARVEST_POLL_MS ?? "5000"));
  const deadlineMs = Math.max(30_000, (timeoutSecs + 30) * 1000);
  while (!done && Date.now() - startedAt < deadlineMs) {
    await sleep(pollMs);
    if (!harvestBrowser || Date.now() - startedAt < harvestAfterMs || harvested) {
      continue;
    }
    try {
      harvested = await harvestGeneratedImageFromBrowser(localBaseUrl, harvestBrowser, {
        excludedImageKeys: baselineImageKeys,
        jobId
      });
      if (harvested?.imageUrl) {
        writeFileSync(join(dispatchDir, "cdp-harvest.json"), JSON.stringify(harvested, null, 2));
        child.kill("SIGTERM");
        break;
      }
    } catch (error) {
      writeFileSync(join(dispatchDir, "cdp-harvest-error.txt"), error instanceof Error ? error.message : String(error));
    }
  }
  if (!done && Date.now() - startedAt >= deadlineMs) {
    child.kill("SIGTERM");
  }
  const exit = await exitPromise;
  detachCdpBrowser(harvestBrowser);
  if (harvested?.imageUrl) {
    return {
      status: 0,
      stdout: JSON.stringify({ answer_markdown: `![generated CG](${harvested.imageUrl})`, cdpHarvest: harvested }),
      stderr,
      harvested
    };
  }
  return { status: exit.status, stdout, stderr, harvested: null };
}

async function runWebgptTool({ wrapper, args, env, timeoutSecs }) {
  const child = spawn(wrapper, args, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, Math.max(30_000, (timeoutSecs + 30) * 1000));
  const exit = await new Promise((resolve) => {
    child.on("exit", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status: status ?? (signal ? 1 : 0), signal });
    });
  });
  if (timedOut) {
    stderr = `${stderr}${stderr.endsWith("\n") || !stderr ? "" : "\n"}webgpt_generate_image timed out after ${timeoutSecs}s`;
  }
  return { status: exit.status, stdout, stderr };
}

function truncateText(value, maxChars) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 12)).trimEnd()}\n[...]`;
}

function listText(value, maxItems = 8) {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, maxItems)
    .join("; ");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function compactCgPrompt(job, payload) {
  const request = objectValue(payload.cgRequest);
  const excerpt = objectValue(payload.visibleExcerpt);
  const referenceBoards = Array.isArray(payload.referenceBoards) ? payload.referenceBoards : [];
  const visibleParagraphs = Array.isArray(excerpt.paragraphs)
    ? excerpt.paragraphs.filter((item) => typeof item === "string").join("\n")
    : "";
  const referenceLines = referenceBoards
    .slice(0, 6)
    .map((board) => objectValue(board))
    .map((board) => {
      const title = typeof board.title === "string" ? board.title : "";
      const kind = typeof board.kind === "string" ? board.kind : "reference";
      const hasImage = typeof board.imageUrl === "string" && board.imageUrl.trim();
      return title ? `- ${kind}: ${title}${hasImage ? " (reference image attached)" : ""}` : "";
    })
    .filter(Boolean);

  return [
    "너는 VNplayer의 병렬 CG side lane이다.",
    "이미지 한 장만 생성한다. 선택지, 산문, 설명, canon, 새 단서, 미래 사건, 읽을 수 있는 문자, UI, 말풍선은 만들지 않는다.",
    "이미지는 이미 커밋된 visible turn의 표시 첨부물이며 story authority가 아니다.",
    "",
    `jobId: ${job.id}`,
    `assetId: ${payload.assetId}`,
    `turnId: ${payload.turnId}`,
    "",
    "World CG style prompt:",
    truncateText(payload.cgStylePrompt, 700),
    "",
    "Scene request:",
    typeof request.subject === "string" ? `subject: ${request.subject}` : null,
    typeof request.composition === "string" ? `composition: ${request.composition}` : null,
    typeof request.mood === "string" ? `mood: ${request.mood}` : null,
    listText(request.palette) ? `palette: ${listText(request.palette, 8)}` : null,
    listText(request.visibleAnchors, 10) ? `visible anchors: ${listText(request.visibleAnchors, 10)}` : null,
    listText(request.avoid, 10) ? `avoid: ${listText(request.avoid, 10)}` : null,
    "",
    "Visible excerpt:",
    typeof excerpt.background === "string" ? `background: ${excerpt.background}` : null,
    typeof excerpt.mood === "string" ? `turn mood: ${excerpt.mood}` : null,
    typeof excerpt.concreteDelta === "string" ? `visible delta: ${excerpt.concreteDelta}` : null,
    visibleParagraphs ? truncateText(visibleParagraphs, 900) : null,
    referenceLines.length ? ["", "Pinned reference boards:", ...referenceLines].join("\n") : null,
    "",
    "Negative prompt:",
    truncateText(payload.negativePrompt, 500),
    "",
    "Final answer format: return only the generated image or a direct image URL."
  ].filter((line) => line !== null && line !== "").join("\n");
}

function buildPrompt(job) {
  const payload = job.payload;
  if (job.kind === "cg_reference_board") {
    return [
      "너는 VNplayer의 병렬 CG reference board lane이다.",
      "텍스트를 쓰지 않는다. 선택지를 만들지 않는다. canon을 만들지 않는다.",
      "아래 board prompt만 바탕으로 이미지 일관성 참조 보드 한 장을 생성한다.",
      "보드 이미지는 무드, 팔레트, 질감, 실루엣, 장소/사물의 반복 앵커를 안정화하기 위한 자료일 뿐이다.",
      "새 lore, 미래 사건, 숨은 진실, 읽을 수 있는 문자, 새 인물, 새 상징은 넣지 않는다.",
      "이미지를 생성한 뒤, 최종 답변에는 이미지 markdown 또는 직접 접근 가능한 이미지 URL만 짧게 남긴다.",
      "",
      `jobId: ${job.id}`,
      `boardId: ${payload.boardId}`,
      `boardKind: ${payload.kind}`,
      `boardTitle: ${payload.title}`,
      "",
      "Image prompt:",
      truncateText(payload.prompt, 2_000),
      "",
      "Final answer format: return only the generated image or a direct image URL."
    ].join("\n");
  }
  return compactCgPrompt(job, payload);
}

async function main() {
  const localBaseUrl = argValue("--local-base-url", process.env.VNPLAYER_LOCAL_BASE_URL ?? "http://127.0.0.1:4174").replace(/\/$/, "");
  const wrapper = resolveWebgptWrapper(argValue("--webgpt-mcp-wrapper", process.env.VNPLAYER_WEBGPT_MCP_WRAPPER));
  const timeoutSecs = Number(argValue("--timeout-secs", process.env.VNPLAYER_WEBGPT_CG_TIMEOUT_SECS ?? "600"));
  const artifactDir = resolve(argValue("--artifact-dir", process.env.VNPLAYER_WEBGPT_CG_ARTIFACT_DIR ?? join(repoRoot, "data", "webgpt-cg-jobs")));
  const conversationMode = conversationModeFromValue(
    argValue("--conversation-mode", hasFlag("--new-conversation") ? "new" : process.env.VNPLAYER_WEBGPT_CG_CONVERSATION_MODE ?? "resume")
  );
  const forceNewConversation = conversationMode === "new";
  const cgSeat = laneSeatConfig("cg");
  const cgSeatEnv = webgptSeatEnv("cg");
  const cdpUrl = cgSeat.cdpUrl ?? `http://127.0.0.1:${cgSeat.cdpPort}`;
  const claimArgs = {};
  const worldId = argValue("--world-id");
  const sessionId = argValue("--session-id");
  if ((!worldId || !sessionId) && process.env.VNPLAYER_WEBGPT_CG_ALLOW_GLOBAL !== "1") {
    throw new Error("CG lane은 기본적으로 world-id와 session-id가 필요합니다. 전역 큐 소비는 VNPLAYER_WEBGPT_CG_ALLOW_GLOBAL=1일 때만 허용됩니다.");
  }
  if (worldId) {
    claimArgs.worldId = worldId;
  }
  if (sessionId) {
    claimArgs.sessionId = sessionId;
  }

  const claim = await postJson(`${localBaseUrl}/api/webgpt/tools/vn_claim_next_cg_job`, claimArgs);
  if (!claim.job) {
    console.log(JSON.stringify({ ok: true, claimed: false, message: "queued CG job이 없습니다." }, null, 2));
    return;
  }

  const job = claim.job;
  const dispatchDir = join(artifactDir, `${job.id}_${randomUUID().slice(0, 8)}`);
  mkdirSync(dispatchDir, { recursive: true });
  const prompt = buildPrompt(job);
  const existingConversationId = !forceNewConversation && typeof job.conversationId === "string" && job.conversationId.trim() ? job.conversationId.trim() : "";
  const referenceImagePaths = referenceImagePathsForJob(job, localBaseUrl);
  const toolArgs = {
    prompt,
    max_images: 1,
    timeout_secs: timeoutSecs,
    auto_recover: true,
    recovery_attempts: 1,
    ...(referenceImagePaths.length ? { reference_paths: referenceImagePaths } : {}),
    ...(existingConversationId ? { conversation_id: existingConversationId } : { new_conversation: true })
  };
  writeFileSync(join(dispatchDir, "prompt.txt"), prompt);
  writeFileSync(join(dispatchDir, "reference-image-paths.json"), JSON.stringify(referenceImagePaths, null, 2));
  writeFileSync(join(dispatchDir, "webgpt-arguments.json"), JSON.stringify(toolArgs, null, 2));

  const result = await runWebgptTool({
    wrapper,
    args: [
      "client-call",
      "--wrapper",
      wrapper,
      "--client-name",
      "vnplayer-webgpt-cg",
      "--require-tool",
      "--tool",
      "webgpt_generate_image",
      "--arguments-file",
      join(dispatchDir, "webgpt-arguments.json"),
      "--output",
      "first-text"
    ],
    env: cgSeatEnv,
    timeoutSecs
  });

  writeFileSync(join(dispatchDir, "stdout.txt"), result.stdout ?? "");
  writeFileSync(join(dispatchDir, "stderr.txt"), result.stderr ?? "");
  if (result.status !== 0) {
    if (job.kind === "cg_reference_board") {
      await postJson(`${localBaseUrl}/api/webgpt/tools/vn_attach_cg_reference_board`, {
        worldId: job.worldId,
        boardId: job.payload.boardId,
        jobId: job.id,
        errorMessage: `webgpt_generate_image 실패: exit=${result.status}`
      });
    } else {
      await postJson(`${localBaseUrl}/api/webgpt/tools/vn_attach_cg_asset`, {
        worldId: job.worldId,
        sessionId: job.sessionId,
        assetId: job.payload.assetId,
        provider: "webgpt",
        errorMessage: `webgpt_generate_image 실패: exit=${result.status}`
      });
    }
    throw new Error(`webgpt_generate_image 실패: exit=${result.status}, stderr=${result.stderr}`);
  }

  let answer = {};
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    answer = { answer_markdown: result.stdout.trim() };
  }
  const rawConversationId = typeof answer.raw_conversation_id === "string" && answer.raw_conversation_id.trim()
    ? answer.raw_conversation_id.trim()
    : typeof answer.conversation_id === "string" && answer.conversation_id.trim()
      ? answer.conversation_id.trim()
      : existingConversationId;
  writeFileSync(join(dispatchDir, "webgpt-answer.json"), JSON.stringify(answer, null, 2));
  const imageSources = [...imageSourcesFromAnswer(answer), ...findImageFiles(dispatchDir)];
  writeFileSync(join(dispatchDir, "image-sources.json"), JSON.stringify(imageSources, null, 2));
  let importedImage = { imageUrl: null, imported: null };
  let importError = null;
  for (const imageSource of imageSources) {
    try {
      importedImage = await importImageSource(localBaseUrl, imageSource);
      importError = null;
      break;
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
      writeFileSync(join(dispatchDir, "image-import-error.txt"), importError);
    }
  }
  const imageUrl = importedImage.imageUrl;
  if (job.kind === "cg_reference_board") {
    const attach = await postJson(`${localBaseUrl}/api/webgpt/tools/vn_attach_cg_reference_board`, {
      worldId: job.worldId,
      boardId: job.payload.boardId,
      jobId: job.id,
      imageUrl,
      conversationId: rawConversationId || null,
      errorMessage: imageUrl
        ? null
        : importError
          ? `WebGPT 이미지 수입 실패: ${importError}`
          : "WebGPT 응답에서 가져와 저장할 수 있는 참조 보드 이미지를 찾지 못했습니다."
    });
    console.log(
      JSON.stringify(
        {
          ok: Boolean(imageUrl),
          claimed: true,
          kind: job.kind,
          jobId: job.id,
          boardId: job.payload.boardId,
          imageUrl,
          imported: importedImage.imported,
          dispatchDir,
          board: attach.board
        },
        null,
        2
      )
    );
    if (!imageUrl) {
      process.exitCode = 3;
    }
    return;
  }
  const attach = await postJson(`${localBaseUrl}/api/webgpt/tools/vn_attach_cg_asset`, {
    worldId: job.worldId,
    sessionId: job.sessionId,
    assetId: job.payload.assetId,
    imageUrl,
    altText: job.payload.cgRequest?.subject ?? "VNplayer CG",
    provider: "webgpt",
    conversationId: rawConversationId || null,
    errorMessage: imageUrl
      ? null
      : importError
        ? `WebGPT 이미지 수입 실패: ${importError}`
        : "WebGPT 응답에서 가져와 저장할 수 있는 이미지를 찾지 못했습니다."
  });

  console.log(
    JSON.stringify(
      {
        ok: Boolean(imageUrl),
        claimed: true,
        kind: job.kind,
        jobId: job.id,
        assetId: job.payload.assetId,
        imageUrl,
        imported: importedImage.imported,
        dispatchDir,
        asset: attach.asset
      },
      null,
      2
    )
  );
  if (!imageUrl) {
    process.exitCode = 3;
  }
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
