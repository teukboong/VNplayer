#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

function argValue(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function requireArg(name) {
  const value = argValue(name);
  if (!value?.trim()) {
    throw new Error(`${name} 값이 필요합니다.`);
  }
  return value.trim();
}

function cdpUrl() {
  return process.env.WEBGPT_MCP_CDP_URL || `http://127.0.0.1:${process.env.WEBGPT_MCP_CDP_PORT || "9228"}`;
}

function cdpPort() {
  return new URL(cdpUrl()).port || process.env.WEBGPT_MCP_CDP_PORT || "9228";
}

function webgptProfileDir() {
  return process.env.WEBGPT_MCP_PROFILE_DIR
    || process.env.WEBGPT_MCP_MANUAL_PROFILE_DIR
    || join(homedir(), ".vnplayer", "chatgpt-text-profile");
}

function chromePath() {
  const configured = process.env.WEBGPT_MCP_CHROME_PATH;
  if (configured?.trim()) {
    return configured.trim();
  }
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return "google-chrome";
}

function staleSingletonPid(profileDir) {
  try {
    const target = readlinkSync(join(profileDir, "SingletonLock"));
    const match = target.match(/-(\d+)$/);
    if (!match) {
      return null;
    }
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return null;
    }
    try {
      process.kill(pid, 0);
      return null;
    } catch {
      return pid;
    }
  } catch {
    return null;
  }
}

function cleanupStaleSingletons(profileDir) {
  const pid = staleSingletonPid(profileDir);
  if (!pid) {
    return;
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(join(profileDir, name), { force: true });
  }
}

async function waitForCdpReady(url, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/json/version`);
      if (response.ok) {
        return true;
      }
    } catch {
      // retry until the browser finishes binding the debug port
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function ensureCdpSeat() {
  const url = cdpUrl();
  if (await waitForCdpReady(url, 750)) {
    return;
  }
  if (process.env.WEBGPT_MCP_CDP_URL) {
    throw new Error(`WebGPT CDP URL에 연결할 수 없습니다: ${url}`);
  }

  const executable = chromePath();
  if (process.platform === "darwin" && !existsSync(executable)) {
    throw new Error(`Google Chrome 실행 파일을 찾지 못했습니다: ${executable}`);
  }

  const logDir = join(homedir(), ".vnplayer", "logs", "webgpt-seats");
  mkdirSync(logDir, { recursive: true });
  const profileDir = webgptProfileDir();
  cleanupStaleSingletons(profileDir);
  const port = cdpPort();
  const logPath = join(logDir, `wrapper-${port}.log`);
  const logFd = openSync(logPath, "a");
  const chromeArgs = [
    `--user-data-dir=${profileDir}`,
    "--profile-directory=Default",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://chatgpt.com/"
  ];
  const launchCommand = process.platform === "darwin" && !process.env.WEBGPT_MCP_CHROME_PATH
    ? "open"
    : executable;
  const launchArgs = launchCommand === "open"
    ? ["-na", "Google Chrome", "--args", ...chromeArgs]
    : chromeArgs;
  const child = spawn(
    launchCommand,
    launchArgs,
    {
      detached: true,
      stdio: ["ignore", logFd, logFd]
    }
  );
  child.unref();

  if (!(await waitForCdpReady(url, 15_000))) {
    throw new Error(`WebGPT CDP seat 기동 실패: ${url}. log=${logPath}`);
  }
}

function timeoutMs(params) {
  return Math.max(10_000, Number(params.timeout_secs || 600) * 1000);
}

function detachCdpBrowser(browser) {
  browser?._connection?.close?.("VNplayer CDP detach");
}

function conversationIdFromUrl(url) {
  try {
    return new URL(url).pathname.match(/\/c\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function dispatchMarker(prompt) {
  return prompt.match(/^VNPLAYER_DISPATCH_MARKER:\s*(\S+)/m)?.[1] ?? null;
}

async function visibleBodyText(page) {
  return page.locator("body").innerText({ timeout: 5000 });
}

function normalizeComposerText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compactComposerText(value) {
  return normalizeComposerText(value).replace(/\s+/g, "");
}

function cdpImageKey(src) {
  try {
    const url = new URL(src);
    return url.searchParams.get("id") || src;
  } catch {
    return src;
  }
}

async function composerText(locator) {
  return locator.evaluate((node) => (
    node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement
      ? node.value
      : node.textContent || ""
  ));
}

async function openConversation(browser, params) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const wantedId = typeof params.conversation_id === "string" ? params.conversation_id.trim() : "";
  if (wantedId) {
    const existing = pages.find((page) => page.url().includes(`/c/${wantedId}`));
    if (existing) {
      return existing;
    }
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = await context.newPage();
    await page.goto(`https://chatgpt.com/c/${wantedId}`, { waitUntil: "domcontentloaded" });
    return page;
  }

  const existing = await reusableChatgptPage(pages);
  if (existing && !params.new_conversation) {
    return existing;
  }
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
  return page;
}

async function reusableChatgptPage(pages) {
  const chatgptPages = pages.filter((page) => page.url().startsWith("https://chatgpt.com/"));
  for (const page of chatgptPages) {
    if (await isLikelyAuthenticatedChatgptPage(page)) {
      return page;
    }
  }
  return chatgptPages[0] ?? null;
}

async function isLikelyAuthenticatedChatgptPage(page) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => {});
    return await page.evaluate(() => {
      const visibleText = (node) => {
        if (!(node instanceof HTMLElement) || node.offsetParent === null) {
          return "";
        }
        return node.textContent?.trim() ?? "";
      };
      const actionTexts = Array.from(document.querySelectorAll("a,button"))
        .map(visibleText)
        .filter(Boolean);
      const hasLoggedOutAction = actionTexts.some((text) => (
        text === "로그인"
        || text === "Log in"
        || text === "Sign up"
        || text.includes("무료로 회원 가입")
      ));
      return !hasLoggedOutAction;
    });
  } catch {
    return false;
  }
}

async function findComposer(page) {
  const selectors = [
    "#prompt-textarea",
    "[data-testid='composer'] [contenteditable='true']",
    "form [contenteditable='true']",
    "textarea"
  ];
  const startedAt = Date.now();
  const timeout = 30_000;
  let lastBodyPreview = "";
  while (Date.now() - startedAt < timeout) {
    await page.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => {});
    for (const selector of selectors) {
      const locator = page.locator(selector).last();
      if (await locator.count().catch(() => 0)) {
        await locator.waitFor({ state: "visible", timeout: 1000 }).catch(() => null);
        if (await locator.isVisible().catch(() => false)) {
          return locator;
        }
      }
    }
    lastBodyPreview = await visibleBodyText(page)
      .then((text) => normalizeComposerText(text).slice(0, 500))
      .catch(() => "");
    await page.waitForTimeout(500);
  }
  throw new Error(`ChatGPT composer를 찾지 못했습니다. url=${page.url()} body=${lastBodyPreview}`);
}

async function composerHasAppChip(page, appName) {
  if (!appName?.trim()) {
    return true;
  }
  const chip = page.locator("button.__composer-pill").filter({ hasText: appName.trim() }).last();
  return Boolean((await chip.count().catch(() => 0)) && (await chip.isVisible().catch(() => false)));
}

async function clickComposerPlus(page) {
  const selectors = [
    "[data-testid='composer-plus-btn']",
    "button[aria-label*='파일 추가']",
    "button[aria-label*='Add']"
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).last();
    if (!(await button.count().catch(() => 0)) || !(await button.isVisible().catch(() => false))) {
      continue;
    }
    await button.click();
    return;
  }
  throw new Error("ChatGPT composer 앱/파일 추가 버튼을 찾지 못했습니다.");
}

async function clickVisibleNonMessageText(page, text, { exact = false } = {}) {
  const result = await page.evaluate(
    ({ targetText, exactMatch }) => {
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0;
      };
      const matches = (value) => {
        const normalized = String(value || "").replace(/\s+/g, " ").trim();
        return exactMatch ? normalized === targetText : normalized.includes(targetText);
      };
      const candidates = Array.from(document.querySelectorAll("button,[role='button'],[role='menuitem'],[role='option'],a,div,span"))
        .filter((node) => visible(node))
        .filter((node) => !node.closest("[data-message-author-role]"))
        .filter((node) => matches(node.innerText || node.textContent || ""))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const textValue = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
          const inComposerArea = rect.top > window.innerHeight * 0.45 ? 4 : 0;
          const awayFromSidebar = rect.left > 260 ? 2 : 0;
          const compactText = textValue.length <= targetText.length + 16 ? 2 : 0;
          const clickable = node.tagName === "BUTTON" || node.getAttribute("role") === "button" || node.getAttribute("role") === "menuitem" ? 2 : 0;
          return { node, score: inComposerArea + awayFromSidebar + compactText + clickable, top: rect.top, textValue };
        })
        .sort((left, right) => left.score - right.score || left.top - right.top);
      const selected = candidates.at(-1);
      selected?.node.click();
      return selected ? { ok: true, text: selected.textValue, score: selected.score } : { ok: false };
    },
    { targetText: text, exactMatch: exact }
  );
  if (!result.ok) {
    throw new Error(`ChatGPT 메뉴 항목을 찾지 못했습니다: ${text}`);
  }
  return result;
}

async function selectChatgptApp(page, appName) {
  const name = typeof appName === "string" ? appName.trim() : "";
  if (!name || await composerHasAppChip(page, name)) {
    return;
  }

  await findComposer(page);
  await clickComposerPlus(page);
  await page.waitForTimeout(250);

  if (!(await page.getByText(name, { exact: false }).last().isVisible().catch(() => false))) {
    await clickVisibleNonMessageText(page, "더 보기");
    await page.waitForTimeout(250);
  }
  await clickVisibleNonMessageText(page, name);

  await page.waitForFunction(
    ({ selectedName }) => Array.from(document.querySelectorAll("button.__composer-pill"))
      .some((node) => node instanceof HTMLElement && node.innerText.includes(selectedName)),
    { selectedName: name },
    { timeout: 5_000 }
  ).catch(async () => {
    if (!(await composerHasAppChip(page, name))) {
      throw new Error(`ChatGPT composer에 앱이 선택되지 않았습니다: ${name}`);
    }
  });
}

async function fillComposer(page, text) {
  const composer = await findComposer(page);
  await composer.fill(text, { timeout: 15_000 }).catch(async () => {
    await composer.evaluate((node, value) => {
      node.focus();
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        node.value = "";
        node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
        node.value = value;
        node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        return;
      }
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("delete", false);
      document.execCommand("insertText", false, value);
    }, text);
  });

  const marker = dispatchMarker(text);
  const expected = normalizeComposerText(marker || text.slice(0, Math.min(160, text.length)));
  const expectedCompact = compactComposerText(expected);
  await page.waitForFunction(
    ({ selector, expectedText, expectedCompactText }) => {
      const candidates = Array.from(document.querySelectorAll(selector));
      const node = candidates.find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null) ?? candidates.at(-1);
      if (!node) {
        return false;
      }
      const value = node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement
        ? node.value
        : node.textContent || "";
      const normalized = String(value || "").replace(/\s+/g, " ").trim();
      const compact = normalized.replace(/\s+/g, "");
      return normalized.includes(expectedText) || compact.includes(expectedCompactText);
    },
    { selector: "#prompt-textarea", expectedText: expected, expectedCompactText: expectedCompact },
    { timeout: 5_000 }
  ).catch(async () => {
    const actual = normalizeComposerText(await composerText(composer).catch(() => ""));
    if (!actual.includes(expected) && !compactComposerText(actual).includes(expectedCompact)) {
      throw new Error("ChatGPT composer에 프롬프트가 붙지 않았습니다.");
    }
  });

  const actual = normalizeComposerText(await composerText(composer));
  if (!actual.includes(expected) && !compactComposerText(actual).includes(expectedCompact)) {
    throw new Error("ChatGPT composer에 프롬프트가 붙지 않았습니다.");
  }
}

async function clickSend(page) {
  const selectors = [
    "[data-testid='send-button']",
    "button[aria-label*='Send']",
    "button[aria-label*='전송']",
    "button[aria-label*='보내기']",
    "form button[type='submit']",
    "button.composer-submit-button-color"
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).last();
    if (!(await button.count().catch(() => 0))) {
      continue;
    }
    if (!(await button.isVisible().catch(() => false))) {
      continue;
    }
    const disabled = await button.evaluate((node) => (
      node instanceof HTMLElement
      && (node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled"))
    )).catch(() => false);
    const label = await button.evaluate((node) => [
      node.getAttribute("aria-label") || "",
      node.getAttribute("data-testid") || "",
      node.textContent || ""
    ].join(" ")).catch(() => "");
    const isVoiceButton = /voice|받아쓰기/i.test(label);
    if (!disabled && !isVoiceButton) {
      await button.click();
      return;
    }
  }
  const composer = await findComposer(page);
  await composer.press("Enter");
}

function attachmentPaths(params) {
  const rawPaths = Array.isArray(params.reference_paths)
    ? params.reference_paths
    : Array.isArray(params.reference_image_paths)
      ? params.reference_image_paths
      : [];
  return rawPaths
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
}

async function attachReferenceImages(page, params) {
  const paths = attachmentPaths(params);
  if (!paths.length) {
    return [];
  }
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length) {
    throw new Error(`첨부할 참조 이미지 파일을 찾지 못했습니다: ${missing.join(", ")}`);
  }
  const input = page.locator('input[type="file"]').last();
  if (!(await input.count().catch(() => 0))) {
    throw new Error("ChatGPT 파일 첨부 input을 찾지 못했습니다.");
  }
  await input.setInputFiles(paths);
  const names = paths.map((path) => basename(path));
  await page
    .waitForFunction(
      ({ expectedNames }) => {
        const text = document.body?.innerText || "";
        return expectedNames.some((name) => text.includes(name))
          || document.querySelectorAll('[data-testid*="attachment"], [aria-label*="첨부"], [aria-label*="attachment" i]').length > 0;
      },
      { expectedNames: names },
      { timeout: 15_000 }
    )
    .catch(() => null);
  return paths;
}

async function collectChatgptImageKeys(page) {
  return page
    .evaluate(() => {
      const keyOf = (src) => {
        try {
          const url = new URL(src);
          return url.searchParams.get("id") || src;
        } catch {
          return src;
        }
      };
      return Array.from(document.images)
        .map((img) => img.currentSrc || img.src || "")
        .filter((src) => src.includes("/backend-api/estuary/content"))
        .map(keyOf);
    })
    .catch(() => []);
}

async function generatedImageSources(page) {
  await findComposer(page).catch(() => null);
  return page.evaluate(() => (
    Array.from(document.querySelectorAll("img"))
      .filter((node) => node instanceof HTMLImageElement)
      .filter((node) => {
        const alt = node.getAttribute("alt") || "";
        const hasImageGenFrame = Boolean(node.closest('[class*="imagegen-image"]'));
        const isAttachmentPreview = Boolean(node.closest('[data-testid*="attachment"], [aria-label*="첨부"], [aria-label*="attachment" i], [class*="attachment"]'));
        const isUploadedReference = Boolean(node.closest('[data-message-author-role="user"]'))
          || isAttachmentPreview
          || alt.includes("업로드한 이미지")
          || alt.toLowerCase().includes("uploaded image");
        return !isUploadedReference
          && (hasImageGenFrame
            || alt.includes("생성된 이미지")
            || alt.toLowerCase().includes("generated image"));
      })
      .map((node) => node.currentSrc || node.src)
      .filter((src) => src && src.includes("/backend-api/estuary/content"))
  )).catch(() => []);
}

async function extractGeneratedImages(page, maxImages = 4, excludeSrcs = []) {
  const boundedMaxImages = Math.max(1, Math.min(Number(maxImages) || 4, 12));
  return page.evaluate(async ({ maxImages: limit, excludeSrcs: rawExcludeSrcs }) => {
    const excluded = new Set(Array.isArray(rawExcludeSrcs) ? rawExcludeSrcs : []);
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      const style = window.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const contentMetrics = (context, width, height) => {
      const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 70_000)));
      const pixels = context.getImageData(0, 0, width, height).data;
      let sampled = 0;
      let nonWhite = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          sampled += 1;
          const offset = (y * width + x) * 4;
          const alpha = pixels[offset + 3] ?? 0;
          const red = pixels[offset] ?? 255;
          const green = pixels[offset + 1] ?? 255;
          const blue = pixels[offset + 2] ?? 255;
          if (alpha > 24 && !(red >= 246 && green >= 246 && blue >= 246)) {
            nonWhite += 1;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }
      const contentWidth = maxX >= minX ? maxX - minX + step : 0;
      const contentHeight = maxY >= minY ? maxY - minY + step : 0;
      return {
        sample_step: step,
        sampled,
        non_white_ratio: sampled ? nonWhite / sampled : 0,
        content_width_ratio: width ? Math.min(1, contentWidth / width) : 0,
        content_height_ratio: height ? Math.min(1, contentHeight / height) : 0
      };
    };
    const imageNodes = Array.from(document.querySelectorAll("img"))
      .filter((node) => node instanceof HTMLImageElement)
      .filter((node) => node.currentSrc || node.src)
      .filter((node) => {
        const src = node.currentSrc || node.src;
        const alt = node.getAttribute("alt") || "";
        const hasImageGenFrame = Boolean(node.closest('[class*="imagegen-image"]'));
        const isAttachmentPreview = Boolean(node.closest('[data-testid*="attachment"], [aria-label*="첨부"], [aria-label*="attachment" i], [class*="attachment"]'));
        const isUploadedReference = Boolean(node.closest('[data-message-author-role="user"]'))
          || isAttachmentPreview
          || alt.includes("업로드한 이미지")
          || alt.toLowerCase().includes("uploaded image");
        return !isUploadedReference
          && src.includes("/backend-api/estuary/content")
          && (hasImageGenFrame
            || alt.includes("생성된 이미지")
            || alt.toLowerCase().includes("generated image"));
      })
      .filter((node) => visible(node));

    const uniqueImages = [];
    const seen = new Set();
    for (const node of imageNodes) {
      const src = node.currentSrc || node.src;
      if (!src || seen.has(src) || excluded.has(src)) {
        continue;
      }
      seen.add(src);
      uniqueImages.push(node);
      if (uniqueImages.length >= limit) {
        break;
      }
    }

    const images = [];
    for (const node of uniqueImages) {
      node.scrollIntoView({ block: "center", inline: "center" });
      if (!node.complete || node.naturalWidth === 0 || node.naturalHeight === 0) {
        await node.decode().catch(() => {});
      }
      if (node.naturalWidth === 0 || node.naturalHeight === 0) {
        images.push({
          alt: node.getAttribute("alt") || "",
          src: node.currentSrc || node.src,
          natural_width: node.naturalWidth || 0,
          natural_height: node.naturalHeight || 0,
          mime_type: "",
          data_url: "",
          error: "image not decoded"
        });
        continue;
      }
      const canvas = document.createElement("canvas");
      canvas.width = node.naturalWidth;
      canvas.height = node.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(node, 0, 0);
      let metrics = null;
      try {
        metrics = contentMetrics(context, canvas.width, canvas.height);
      } catch (caught) {
        metrics = { error: caught instanceof Error ? caught.message : String(caught) };
      }
      let dataUrl = "";
      let error = "";
      try {
        dataUrl = canvas.toDataURL("image/png");
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      images.push({
        alt: node.getAttribute("alt") || "",
        src: node.currentSrc || node.src,
        natural_width: node.naturalWidth,
        natural_height: node.naturalHeight,
        mime_type: dataUrl.startsWith("data:image/png;base64,") ? "image/png" : "",
        data_url: dataUrl,
        content_metrics: metrics,
        error
      });
    }

    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return {
      conversation_id: match ? match[1] : "",
      page_url: location.href,
      images
    };
  }, { maxImages: boundedMaxImages, excludeSrcs }).catch(() => ({
    conversation_id: conversationIdFromUrl(page.url()) || "",
    page_url: page.url(),
    images: []
  }));
}

function generatedImageRejectReason(image) {
  if (!image?.data_url || image.error) {
    return image?.error || "image data_url is missing";
  }
  const metrics = image.content_metrics;
  if (metrics && typeof metrics.non_white_ratio === "number") {
    const contentHeight = Number(metrics.content_height_ratio) || 0;
    const contentWidth = Number(metrics.content_width_ratio) || 0;
    const ink = Number(metrics.non_white_ratio) || 0;
    if (ink < 0.02 && (contentHeight < 0.18 || contentWidth < 0.18)) {
      return `generated image appears partial: ink=${ink.toFixed(4)}, bbox=${contentWidth.toFixed(3)}x${contentHeight.toFixed(3)}`;
    }
    if (contentHeight < 0.08) {
      return `generated image appears top-cropped: content_height=${contentHeight.toFixed(3)}`;
    }
  }
  return "";
}

function generatedImageSignature(image) {
  const metrics = image.content_metrics ?? {};
  const ink = typeof metrics.non_white_ratio === "number" ? metrics.non_white_ratio.toFixed(4) : "unknown";
  const width = typeof metrics.content_width_ratio === "number" ? metrics.content_width_ratio.toFixed(3) : "unknown";
  const height = typeof metrics.content_height_ratio === "number" ? metrics.content_height_ratio.toFixed(3) : "unknown";
  return `${image.src || ""}|${image.data_url?.length ?? 0}|${ink}|${width}|${height}`;
}

async function harvestGeneratedImage(page, excludedKeys) {
  const harvested = await page
    .evaluate(async ({ excludedKeys: excludedKeyList }) => {
      const excluded = new Set(excludedKeyList);
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
        .filter((img) => !excluded.has(img.key) && img.alt !== "업로드한 이미지")
        .filter((img) => !img.isUserUpload && !img.isAttachmentPreview && !img.alt.toLowerCase().includes("uploaded image"))
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
    }, { excludedKeys: excludedKeys.map(cdpImageKey) })
    .catch(() => null);
  return harvested;
}

async function messageCounts(page) {
  return page.evaluate(() => ({
    user: document.querySelectorAll('[data-message-author-role="user"]').length,
    assistant: document.querySelectorAll('[data-message-author-role="assistant"]').length
  }));
}

async function chatgptGenerationRunning(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
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
  }).catch(() => true);
}

async function lastAssistantText(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    const last = nodes.at(-1);
    return last?.textContent?.trim() || "";
  });
}

async function runWebgptResearch(params) {
  if (!params.prompt || typeof params.prompt !== "string") {
    throw new Error("webgpt_research.prompt 값이 필요합니다.");
  }

  const { chromium } = await import("playwright");
  await ensureCdpSeat();
  const browser = await chromium.connectOverCDP(cdpUrl());
  try {
    const page = await openConversation(browser, params);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await findComposer(page);
    await selectChatgptApp(page, params.connector_app_name);
    const initialImageKeys = params.harvest_generated_image ? await collectChatgptImageKeys(page) : [];
    const attachedReferenceImages = await attachReferenceImages(page, params);
    const before = await messageCounts(page);
    await fillComposer(page, params.prompt);
    await clickSend(page);

    const marker = dispatchMarker(params.prompt);
    await page.waitForFunction(
      ({ previousUserCount, markerText }) => {
        const userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
        const body = document.body?.innerText || "";
        return userCount > previousUserCount && (!markerText || body.includes(markerText));
      },
      { previousUserCount: before.user, markerText: marker },
      { timeout: Math.min(timeoutMs(params), 30_000) }
    ).catch(() => {
      throw new Error("ChatGPT에 새 유저 메시지가 생성되지 않았습니다.");
    });

    await page.waitForFunction(
      ({ previousAssistantCount }) => {
        const stopVisible = Array.from(document.querySelectorAll("[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='중지']"))
          .some((node) => node instanceof HTMLElement && node.offsetParent !== null);
        const assistants = document.querySelectorAll('[data-message-author-role="assistant"]');
        return assistants.length > previousAssistantCount && !stopVisible;
      },
      { previousAssistantCount: before.assistant },
      { timeout: timeoutMs(params) }
    ).catch(() => {});

    const body = await visibleBodyText(page);
    if (marker && !body.includes(marker)) {
      throw new Error(`ChatGPT 대화에 dispatch marker가 없습니다: ${marker}`);
    }

    const harvestedImage = params.harvest_generated_image ? await harvestGeneratedImage(page, initialImageKeys) : null;

    return {
      answer_markdown: await lastAssistantText(page),
      raw_conversation_id: conversationIdFromUrl(page.url()),
      attached_reference_images: attachedReferenceImages,
      generated_image_data_url: harvestedImage?.dataUrl ?? null,
      generated_image_key: harvestedImage?.key ?? null,
      generated_image_width: harvestedImage?.width ?? null,
      generated_image_height: harvestedImage?.height ?? null,
      health: "ready"
    };
  } finally {
    // This is an attach-only connection to the warm logged-in browser seat.
    // Closing it can tear down the CDP seat and break the next VNplayer turn.
    detachCdpBrowser(browser);
  }
}

async function runWebgptGenerateImage(params) {
  if (!params.prompt || typeof params.prompt !== "string") {
    throw new Error("webgpt_generate_image.prompt 값이 필요합니다.");
  }

  const { chromium } = await import("playwright");
  await ensureCdpSeat();
  const browser = await chromium.connectOverCDP(cdpUrl());
  try {
    const page = await openConversation(browser, params);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await findComposer(page);
    await selectChatgptApp(page, params.connector_app_name);
    const beforeSources = await generatedImageSources(page);
    const attachedReferenceImages = await attachReferenceImages(page, params);
    const before = await messageCounts(page);
    await fillComposer(page, params.prompt);
    await clickSend(page);
    await page.waitForFunction(
      ({ previousUserCount }) => document.querySelectorAll('[data-message-author-role="user"]').length > previousUserCount,
      { previousUserCount: before.user },
      { timeout: Math.min(timeoutMs(params), 30_000) }
    ).catch(() => {
      throw new Error("ChatGPT에 새 이미지 생성 요청이 생성되지 않았습니다.");
    });

    const deadline = Date.now() + timeoutMs(params);
    let latest = null;
    let lastRejectReason = "";
    let stableReadySignature = "";
    let stableReadyPolls = 0;
    const maxImages = params.max_images || 1;
    while (Date.now() < deadline) {
      latest = await extractGeneratedImages(page, maxImages, beforeSources);
      const readyImage = latest.images.find((image) => {
        const reason = generatedImageRejectReason(image);
        if (reason) {
          lastRejectReason = reason;
          return false;
        }
        return true;
      });
      if (readyImage) {
        const running = await chatgptGenerationRunning(page);
        const signature = generatedImageSignature(readyImage);
        stableReadyPolls = signature === stableReadySignature ? stableReadyPolls + 1 : 1;
        stableReadySignature = signature;
        if (!running || stableReadyPolls >= 2) {
          return {
            ...latest,
            raw_conversation_id: latest.conversation_id || conversationIdFromUrl(page.url()) || "",
            attached_reference_images: attachedReferenceImages,
            health: "ready"
          };
        }
        lastRejectReason = "generated image is visible but ChatGPT still reports generation running";
      } else if (!latest.images.length) {
        lastRejectReason = "no generated image candidate yet";
      }
      await page.waitForTimeout(2_000);
    }
    throw new Error(`generated image timeout after ${Math.max(10, Number(params.timeout_secs) || 600)}s${lastRejectReason ? `; last=${lastRejectReason}` : ""}`);
  } finally {
    // This is an attach-only connection to the warm logged-in browser seat.
    // Closing it can tear down the CDP seat and break the next VNplayer turn.
    detachCdpBrowser(browser);
  }
}

function writeStdout(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const command = process.argv[2];
  const tool = argValue("--tool");
  const argumentsFile = requireArg("--arguments-file");
  if (command !== "client-call" || !["webgpt_research", "webgpt_generate_image"].includes(tool)) {
    throw new Error("webgpt-local-wrapper는 client-call --tool webgpt_research|webgpt_generate_image만 지원합니다.");
  }
  const params = JSON.parse(readFileSync(argumentsFile, "utf8"));
  const answer = tool === "webgpt_generate_image"
    ? await runWebgptGenerateImage(params)
    : await runWebgptResearch(params);
  await writeStdout(JSON.stringify(answer, null, 2));
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
