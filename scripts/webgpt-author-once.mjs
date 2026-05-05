#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  authorLibraryOutlineCount,
  authorPromptForm,
  authorVisibleHistoryCount,
  nonEmptyString
} from "./author-prompt.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const defaultWrapper = join(repoRoot, "scripts", "webgpt-local-wrapper.mjs");
const homeDir = process.env.HOME ?? "/tmp";
const defaultTextProfileDir = join(homeDir, ".vnplayer", "chatgpt-text-profile");
const defaultCgProfileDir = join(homeDir, ".vnplayer", "chatgpt-cg-profile");
const defaultTextCdpPort = "9228";
const defaultCgCdpPort = "9229";
const scriptStartedAt = new Date().toISOString();
const scriptStartedMs = performance.now();
let activeDispatchDir = null;
let activeDispatchId = null;
const latencyMarks = [];

function roundedMs(value) {
  return Math.round(value * 10) / 10;
}

function writeLatency() {
  if (!activeDispatchDir) {
    return;
  }
  writeFileSync(
    join(activeDispatchDir, "latency.json"),
    JSON.stringify(
      {
        dispatchId: activeDispatchId,
        scriptStartedAt,
        marks: latencyMarks
      },
      null,
      2
    )
  );
}

function markLatency(stage, extra = {}) {
  latencyMarks.push({
    stage,
    at: new Date().toISOString(),
    elapsedMs: roundedMs(performance.now() - scriptStartedMs),
    ...extra
  });
  writeLatency();
}

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

function hasFlag(name) {
  return process.argv.includes(name);
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
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
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
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
  }
  throw lastError;
}

async function tryPostJson(url, body) {
  try {
    return await postJson(url, body);
  } catch {
    return null;
  }
}

function conversationIdFromUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    const match = parsed.pathname.match(/\/c\/([^/]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function detachCdpBrowser(browser) {
  browser?._connection?.close?.("VNplayer CDP detach");
}

function conversationModeFromValue(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "new" || normalized === "rollover") {
    return "new";
  }
  return "resume";
}

function webgptVolumeContract(packet) {
  const detailLevel = Number(packet?.detailLevel);
  const narrativeLevel = Number(packet?.narrativeLevel);
  if (detailLevel >= 3) {
    return {
      paragraphRange: narrativeLevel >= 3 ? "20-28" : "18-24",
      minimumParagraphs: 18,
      minimumChars: narrativeLevel >= 3 ? 2200 : 1800,
      averageChars: "문단당 공백 제외 평균 90-130자",
      description: "풍부한 장면 단위"
    };
  }
  if (detailLevel <= 1) {
    return {
      paragraphRange: narrativeLevel >= 3 ? "7-10" : "6-10",
      minimumParagraphs: 6,
      minimumChars: 650,
      averageChars: "문단당 공백 제외 평균 65자 이상",
      description: "간결하지만 완결된 장면 단위"
    };
  }
  return {
    paragraphRange: narrativeLevel >= 3 ? "14-20" : "12-18",
    minimumParagraphs: 12,
    minimumChars: narrativeLevel >= 3 ? 1700 : 1400,
    averageChars: "문단당 공백 제외 평균 80-120자",
    description: "표준 장면 단위"
  };
}

function buildPrompt({ baseUrl, connectorAppName, conversationMode, previousConversationUrl, form, beforeTurnId, warmConversation, dispatchId, dispatchToken }) {
  const packet = form.readingPacket;
  const promptForm = authorPromptForm(form, { warmConversation });
  const volume = webgptVolumeContract(packet);
  const latestAction = packet.latestPlayerAction;
  const latestActionLine = latestAction
    ? `이번 플레이어 선택: [${latestAction.label}] ${latestAction.text}`
    : "이번 플레이어 선택: 없음";
  return [
    warmConversation ? "너는 이미 이어지고 있는 VNplayer WebGPT 작성 세션이다." : "너는 VNplayer의 WebGPT 작성 세션이다.",
    `VNPLAYER_DISPATCH_MARKER: ${dispatchId}`,
    "",
    "반드시 연결된 VNplayer MCP 커넥터 도구를 사용해라. 채팅 본문에 JSON을 출력하지 마라. HTTP URL을 직접 호출하지 말고 MCP 도구 목록에 보이는 도구만 호출해라.",
    connectorAppName
      ? `사용할 ChatGPT 앱 이름: ${connectorAppName}. 같은 MCP URL을 가진 다른 VNplayer 앱이 보여도 이 앱의 도구만 사용한다.`
      : null,
    conversationMode === "new"
      ? "이번 작업은 새 ChatGPT 대화로 넘어가는 rollover다. 이전 ChatGPT 대화 내용에 의존하지 말고 아래 로컬 스냅샷과 라이브러리 문서를 연속성의 권위로 삼아라."
      : "이번 작업은 저장된 ChatGPT 대화에 재부착하는 resume이다. 로컬 스냅샷이 최종 권위이며, 기존 대화 맥락은 보조 문맥으로만 쓴다.",
    previousConversationUrl && conversationMode === "new" ? `이전 ChatGPT 세션 URL: ${previousConversationUrl}` : null,
    `MCP endpoint: ${baseUrl}/mcp`,
    `worldId: ${packet.worldId}`,
    `sessionId: ${packet.sessionId}`,
    `dispatchToken: ${dispatchToken}`,
    beforeTurnId ? `currentTurnId: ${beforeTurnId}` : "currentTurnId: 없음. 첫 장면을 작성해야 함.",
    latestActionLine,
    packet.autoCgEnabled === false
      ? "자동 CG 생성: 꺼짐. cgDecision은 작성하지만 백엔드는 자동 CG queue를 만들지 않는다."
      : "자동 CG 생성: 켜짐. cgDecision.generate이면 백엔드가 CG side lane에 큐잉할 수 있다.",
    "선택지 언어 계약: choices의 label, action, tag, intent는 모두 독자에게 보이는 UI 문구다. 고유명사를 제외하고 한국어로 작성하고, advance/probe/enter/time_pass 같은 영어 메타 태그를 그대로 쓰지 마라.",
    `WebGPT 서술 분량 계약: scene.paragraphs는 ${volume.description}로 ${volume.paragraphRange}개를 목표로 쓴다. 극단적인 예외가 아니면 최소 ${volume.minimumParagraphs}문단, 공백 제외 ${volume.minimumChars}자 미만으로 제출하지 마라.`,
    `짧은 문단으로 문단 수만 채우지 마라. ${volume.averageChars}를 지키고, 대사 단독 문단이 연속될 때도 앞뒤에 행동, 공간, 압력 변화, 작은 후과를 붙여 장면 밀도를 유지해라.`,
    "제출 전에 scene.paragraphs 전체를 스스로 검산하라. 분량 계약보다 짧다고 판단되면 vn_receive_visible_turn_v2를 호출하지 말고 산문을 먼저 확장해라.",
    "도구 호출 JSON 안에서도 산문을 요약하지 마라. scene.paragraphs는 독자가 바로 읽는 본문이며, 선택지로 빨리 넘어가기 위한 synopsis가 아니다.",
    warmConversation
      ? "이전 ChatGPT 대화는 있을 수 있지만 아래 로컬 delta 스냅샷이 권위다. delta 스냅샷의 visibleHistory는 scene, concreteDelta, 선택지 요약만 남긴 축약본이므로, interface/cgDecision/worldNaming/libraryUpdates를 과거 턴에서 되풀이하지 않는다."
      : "이 대화가 새 작성 세션이면 아래 전체 가시 양식을 기준으로 시작한다.",
    "작성 지침은 아래 스냅샷의 instruction 필드가 단일 권위다. 같은 작성 지침을 이 프롬프트 상단에서 반복하지 않는다.",
    "",
    "실행 순서:",
    "1. 아래 '현재 로컬 양식 스냅샷'을 현재 양식으로 사용한다. 필요할 때만 vn_get_library_outline 또는 vn_get_library_docs로 작성 자료를 더 확인한다.",
    "2. 그 양식의 instruction과 readingPacket만 근거로 다음 StoryTurn을 작성한다.",
    "3. 방금 장면에서 안정적으로 드러난 세계 법칙, 작동 법칙, 인물, 장소, 열린 실마리, 후과, 조작 가능한 장면 표면, 대화 태도를 반드시 최소 1개 이상 라이브러리 갱신으로 남긴다. 권장 방식은 StoryTurn.libraryUpdates 배열에 consequence_note, encounter_surface, dialogue_stance, open_thread 중 1-3개를 직접 넣는 것이다. public author lane에서는 별도 upsert 도구를 쓰지 말고, 추측, 반전, 숨은 진실, 다음 전개 계획은 기록하지 않는다.",
    `4. 마지막에는 반드시 vn_receive_visible_turn_v2 도구를 한 번 호출해 { worldId, sessionId, dispatchToken, turn } 형태로 전달한다. dispatchToken은 위에 적힌 dispatchToken 값을 그대로 사용한다. VNPLAYER_DISPATCH_MARKER나 dispatch id를 dispatchToken으로 쓰면 안 된다. libraryUpdates나 cgDecision을 빼고 제출하면 안 된다.`,
    connectorAppName
      ? `5. 도구 호출 목록 패널에 표시되는 앱 이름이 ${connectorAppName}인지 확인한다. 같은 MCP URL을 가진 다른 VNplayer 앱의 도구는 사용하지 않는다.`
      : "5. 도구 목록에 vn_receive_visible_turn_v2가 보이면 반드시 그 도구를 호출한다.",
    connectorAppName
      ? "6. 진단용 sentinel 문구를 채팅 본문에 쓰지 마라. 실패 판정은 runner가 서버 커밋 여부로 한다."
      : "6. 진단용 sentinel 문구를 채팅 본문에 쓰지 마라. 실패 판정은 runner가 서버 커밋 여부로 한다.",
    connectorAppName
      ? "7. 채팅 본문으로 성공/완료를 먼저 말하지 마라. 성공은 VNplayer 도구 호출이 서버에 도달해 새 턴이 커밋된 뒤에만 성립한다. 할 일은 답변 텍스트 작성이 아니라 vn_receive_visible_turn_v2 호출이다."
      : "7. 채팅 본문으로 성공/완료를 먼저 말하지 마라. 성공은 VNplayer 도구 호출이 서버에 도달해 새 턴이 커밋된 뒤에만 성립한다. 할 일은 답변 텍스트 작성이 아니라 vn_receive_visible_turn_v2 호출이다.",
    connectorAppName
      ? "8. 도구 호출 뒤 출력이 비어 있거나 도구 응답 없음으로 보여도, 새 턴 커밋 여부는 서버가 판정한다. 채팅 본문으로 대체 JSON이나 sentinel을 쓰지 마라."
      : null,
    warmConversation ? "현재 로컬 delta 스냅샷:" : "현재 로컬 양식 스냅샷:",
    JSON.stringify(promptForm, null, 2)
  ].filter((line) => line !== null).join("\n");
}

function parseWebgptAnswer(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return { answer_markdown: stdout.trim() };
  }
}

function runWebgptResearch({ wrapper, env, dispatchDir, toolArgs, label }) {
  const primary = label === "primary";
  const argsPath = join(dispatchDir, primary ? "webgpt-arguments.json" : `webgpt-${label}-arguments.json`);
  const stdoutPath = join(dispatchDir, primary ? "stdout.txt" : `stdout-${label}.txt`);
  const stderrPath = join(dispatchDir, primary ? "stderr.txt" : `stderr-${label}.txt`);
  const answerPath = join(dispatchDir, primary ? "webgpt-answer.json" : `webgpt-${label}-answer.json`);
  writeFileSync(argsPath, JSON.stringify(toolArgs, null, 2));
  markLatency(`${label}_webgpt_arguments_written`);
  markLatency(`${label}_webgpt_mcp_call_start`);
  const result = spawnSync(
    wrapper,
    [
      "client-call",
      "--wrapper",
      wrapper,
      "--client-name",
      "vnplayer-webgpt-author",
      "--require-tool",
      "--tool",
      "webgpt_research",
      "--arguments-file",
      argsPath,
      "--output",
      "first-text"
    ],
    { cwd: repoRoot, env, encoding: "utf8", maxBuffer: 1024 * 1024 * 8 }
  );
  markLatency(`${label}_webgpt_mcp_call_done`, { exitStatus: result.status });
  writeFileSync(stdoutPath, result.stdout ?? "");
  writeFileSync(stderrPath, result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(`webgpt_research 실패: exit=${result.status}, stderr=${result.stderr}`);
  }
  const answer = parseWebgptAnswer(result.stdout ?? "");
  writeFileSync(answerPath, JSON.stringify(answer, null, 2));
  markLatency(`${label}_webgpt_answer_written`);
  return answer;
}

function shouldRolloverRetry(answer) {
  const text = nonEmptyString(answer?.answer_markdown) ?? "";
  return /CONNECTOR_TOOL_NOT_CALLED|tool[_ -]?not[_ -]?called|도구.*호출.*않|도구.*호출.*없|커넥터 도구 호출 없이|VNplayer MCP 도구.*접근|vn_receive_visible_turn_v2.*접근|도구.*노출된 환경|도구.*사용할 수 없습니다|tool.*unavailable|tool.*not available/i.test(text);
}

function noCommitErrorMessage(answer) {
  const text = nonEmptyString(answer?.answer_markdown);
  if (text && /성공|success|submitted|완료/i.test(text)) {
    return "WebGPT가 성공이라고 답했지만 VNplayer에 새 턴이 커밋되지 않았습니다. 커넥터 도구 호출 없이 채팅 본문만 반환된 상태입니다.";
  }
  return text ? `WebGPT가 새 턴을 커밋하지 않았습니다: ${text}` : "WebGPT가 새 턴을 커밋하지 않았습니다.";
}

function cdpUrlFromEnv(env) {
  return env.WEBGPT_MCP_CDP_URL || `http://127.0.0.1:${env.WEBGPT_MCP_CDP_PORT}`;
}

function actionNeedles(form) {
  const latestAction = form.readingPacket?.latestPlayerAction;
  if (!latestAction) {
    return [];
  }
  return [latestAction.label, latestAction.text].filter((value) => typeof value === "string" && value.trim());
}

async function verifyPromptLanded({ cdpUrl, conversationId, dispatchId, form, dispatchDir, proofFilename = "delivery-proof.json" }) {
  const { chromium } = await import("playwright");
  let browser = null;
  const proof = {
    cdpUrl,
    conversationId,
    dispatchId,
    checkedAt: new Date().toISOString(),
    foundConversation: false,
    markerFound: false,
    actionNeedles: [],
    actionNeedlesFound: []
  };
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url().includes(`/c/${conversationId}`));
    proof.foundConversation = Boolean(page);
    if (!page) {
      throw new Error(`WebGPT 입력 전달 확인 실패: ChatGPT 대화 탭을 찾지 못했습니다. conversationId=${conversationId}`);
    }
    const body = await page.locator("body").innerText({ timeout: 5000 });
    proof.markerFound = body.includes(dispatchId);
    proof.actionNeedles = actionNeedles(form);
    proof.actionNeedlesFound = proof.actionNeedles.filter((needle) => body.includes(needle));
    proof.tail = body.slice(-1000);
    if (!proof.markerFound) {
      throw new Error(`WebGPT 입력 전달 실패: ChatGPT 대화에 dispatch marker가 없습니다. dispatchId=${dispatchId}`);
    }
    if (proof.actionNeedles.length && proof.actionNeedlesFound.length === 0) {
      throw new Error("WebGPT 입력 전달 실패: ChatGPT 대화에 이번 선택지 문구가 없습니다.");
    }
    return proof;
  } catch (error) {
    proof.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    writeFileSync(join(dispatchDir, proofFilename), JSON.stringify(proof, null, 2));
    // Attach-only CDP check. Do not close the warm WebGPT seat.
    detachCdpBrowser(browser);
  }
}

async function main() {
  markLatency("script_start");
  const worldId = requireArg("--world-id");
  const sessionId = requireArg("--session-id");
  const baseUrl = argValue("--base-url", process.env.VNPLAYER_BASE_URL ?? "http://127.0.0.1:4174").replace(/\/$/, "");
  const localBaseUrl = argValue("--local-base-url", process.env.VNPLAYER_LOCAL_BASE_URL ?? "http://127.0.0.1:4174").replace(/\/$/, "");
  const wrapper = resolveWebgptWrapper(argValue("--webgpt-mcp-wrapper", process.env.VNPLAYER_WEBGPT_MCP_WRAPPER));
  const timeoutSecs = Number(argValue("--timeout-secs", process.env.VNPLAYER_WEBGPT_TIMEOUT_SECS ?? "600"));
  const conversationMode = conversationModeFromValue(argValue("--conversation-mode", hasFlag("--new-conversation") ? "new" : "resume"));
  const forceNewConversation = conversationMode === "new";
  const connectorAppName = nonEmptyString(argValue("--connector-app-name", process.env.VNPLAYER_WEBGPT_CONNECTOR_APP_NAME));
  const artifactDir = resolve(argValue("--artifact-dir", process.env.VNPLAYER_WEBGPT_ARTIFACT_DIR ?? join(repoRoot, "data", "webgpt-dispatches")));
  const dispatchId = argValue("--dispatch-id") ?? `dispatch_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const dispatchToken = argValue("--dispatch-token") ?? "";
  if (!dispatchToken) {
    throw new Error("--dispatch-token 값이 필요합니다.");
  }
  const textSeatEnv = webgptSeatEnv("text");
  const dispatchDir = join(artifactDir, dispatchId);
  activeDispatchDir = dispatchDir;
  activeDispatchId = dispatchId;
  mkdirSync(dispatchDir, { recursive: true });
  markLatency("dispatch_dir_ready");

  markLatency("reader_state_request_start");
  const beforeState = await postJson(`${localBaseUrl}/api/webgpt/tools/vn_get_reader_state`, { worldId, sessionId });
  markLatency("reader_state_request_done");
  const beforeTurnId = beforeState.state.currentTurn?.id ?? null;
  const currentForm = beforeState.state.form;
  const previousConversationUrl = nonEmptyString(beforeState.state.session.webgptSessionUrl);
  const existingConversationId = forceNewConversation ? null : conversationIdFromUrl(previousConversationUrl);
  const warmConversation = Boolean(existingConversationId);
  const prompt = buildPrompt({
    baseUrl,
    connectorAppName,
    conversationMode,
    previousConversationUrl,
    form: currentForm,
    beforeTurnId,
    warmConversation,
    dispatchId,
    dispatchToken
  });
  writeFileSync(join(dispatchDir, "prompt.txt"), prompt);
  markLatency("prompt_written", { promptChars: prompt.length });
  writeFileSync(
    join(dispatchDir, "prompt-mode.json"),
    JSON.stringify(
      {
        mode: warmConversation ? "warm-delta" : "cold-full",
        conversationMode,
        beforeTurnId,
        visibleHistoryCount: currentForm.readingPacket.visibleHistory.length,
        sentVisibleHistoryCount: authorVisibleHistoryCount(currentForm, { warmConversation }),
        libraryOutlineCount: currentForm.readingPacket.libraryOutline.length,
        sentLibraryOutlineCount: authorLibraryOutlineCount(currentForm),
        narrativeLevel: currentForm.readingPacket.narrativeLevel ?? 2,
        detailLevel: currentForm.readingPacket.detailLevel ?? 2,
        autoCgEnabled: currentForm.readingPacket.autoCgEnabled !== false,
        conversationId: existingConversationId,
        previousConversationUrl
      },
      null,
      2
    )
  );

  const routingArgs = existingConversationId
    ? { conversation_id: existingConversationId }
    : { new_conversation: true };
  const toolArgs = {
    prompt,
    timeout_secs: timeoutSecs,
    auto_recover: true,
    recovery_attempts: 1,
    ...(connectorAppName ? { connector_app_name: connectorAppName } : {}),
    ...routingArgs
  };
  let webgptAnswer = runWebgptResearch({ wrapper, env: textSeatEnv, dispatchDir, toolArgs, label: "primary" });

  let linkError = null;
  let rawConversationId = nonEmptyString(webgptAnswer.raw_conversation_id);
  const proofConversationId = rawConversationId ?? existingConversationId;
  if (proofConversationId) {
    markLatency("delivery_proof_start");
    await verifyPromptLanded({
      cdpUrl: cdpUrlFromEnv(textSeatEnv),
      conversationId: proofConversationId,
      dispatchId,
      form: currentForm,
      dispatchDir
    });
    markLatency("delivery_proof_done");
  }
  if (rawConversationId) {
    try {
      await postJson(`${localBaseUrl}/api/webgpt/tools/vn_link_webgpt_session`, {
        worldId,
        sessionId,
        url: `https://chatgpt.com/c/${rawConversationId}`
      });
    } catch (error) {
      linkError = error instanceof Error ? error.message : String(error);
    }
  }

  let afterState = await postJson(`${localBaseUrl}/api/webgpt/tools/vn_get_reader_state`, { worldId, sessionId });
  let afterTurnId = afterState.state.currentTurn?.id ?? null;
  let committed = Boolean(afterTurnId && afterTurnId !== beforeTurnId);
  let rolloverRetry = null;
  if (!committed && conversationMode === "resume" && shouldRolloverRetry(webgptAnswer)) {
    markLatency("rollover_retry_prepare");
    const rolloverPrompt = buildPrompt({
      baseUrl,
      connectorAppName,
      conversationMode: "new",
      previousConversationUrl: previousConversationUrl ?? (rawConversationId ? `https://chatgpt.com/c/${rawConversationId}` : null),
      form: currentForm,
      beforeTurnId,
      warmConversation: false,
      dispatchId,
      dispatchToken
    });
    writeFileSync(join(dispatchDir, "prompt-rollover-retry.txt"), rolloverPrompt);
    writeFileSync(
      join(dispatchDir, "prompt-mode-rollover-retry.json"),
      JSON.stringify(
        {
          mode: "cold-full",
          conversationMode: "new",
          retryReason: "resume_no_tool_call",
          beforeTurnId,
          visibleHistoryCount: currentForm.readingPacket.visibleHistory.length,
          sentVisibleHistoryCount: authorVisibleHistoryCount(currentForm, { warmConversation: false }),
          libraryOutlineCount: currentForm.readingPacket.libraryOutline.length,
          sentLibraryOutlineCount: authorLibraryOutlineCount(currentForm),
          narrativeLevel: currentForm.readingPacket.narrativeLevel ?? 2,
          detailLevel: currentForm.readingPacket.detailLevel ?? 2,
          autoCgEnabled: currentForm.readingPacket.autoCgEnabled !== false,
          conversationId: null,
          previousConversationUrl: previousConversationUrl ?? (rawConversationId ? `https://chatgpt.com/c/${rawConversationId}` : null)
        },
        null,
        2
      )
    );
    markLatency("rollover_retry_prompt_written", { promptChars: rolloverPrompt.length });
    const rolloverAnswer = runWebgptResearch({
      wrapper,
      env: textSeatEnv,
      dispatchDir,
      toolArgs: {
        prompt: rolloverPrompt,
        timeout_secs: timeoutSecs,
        auto_recover: true,
        recovery_attempts: 1,
        ...(connectorAppName ? { connector_app_name: connectorAppName } : {}),
        new_conversation: true
      },
      label: "rollover-retry"
    });
    const rolloverConversationId = nonEmptyString(rolloverAnswer.raw_conversation_id);
    let rolloverLinkError = null;
    if (rolloverConversationId) {
      markLatency("rollover_retry_delivery_proof_start");
      await verifyPromptLanded({
        cdpUrl: cdpUrlFromEnv(textSeatEnv),
        conversationId: rolloverConversationId,
        dispatchId,
        form: currentForm,
        dispatchDir,
        proofFilename: "delivery-proof-rollover-retry.json"
      });
      markLatency("rollover_retry_delivery_proof_done");
      try {
        await postJson(`${localBaseUrl}/api/webgpt/tools/vn_link_webgpt_session`, {
          worldId,
          sessionId,
          url: `https://chatgpt.com/c/${rolloverConversationId}`
        });
      } catch (error) {
        rolloverLinkError = error instanceof Error ? error.message : String(error);
      }
    }
    afterState = await postJson(`${localBaseUrl}/api/webgpt/tools/vn_get_reader_state`, { worldId, sessionId });
    afterTurnId = afterState.state.currentTurn?.id ?? null;
    committed = Boolean(afterTurnId && afterTurnId !== beforeTurnId);
    rolloverRetry = {
      attempted: true,
      reason: "resume_no_tool_call",
      conversationId: rolloverConversationId ?? null,
      linkError: rolloverLinkError,
      answer: rolloverAnswer
    };
    webgptAnswer = rolloverAnswer;
    rawConversationId = rolloverConversationId ?? rawConversationId;
    if (rolloverLinkError) {
      linkError = rolloverLinkError;
    }
  }
  const summary = {
    ok: committed,
    dispatchId,
    dispatchDir,
    worldId,
    sessionId,
    beforeTurnId,
    afterTurnId,
    conversationId: rawConversationId ?? existingConversationId ?? null,
    linkError,
    rolloverRetry,
    answer: webgptAnswer,
    latency: latencyMarks
  };
  writeFileSync(join(dispatchDir, "summary.json"), JSON.stringify(summary, null, 2));
  markLatency("summary_written");
  await tryPostJson(`${localBaseUrl}/api/webgpt/dispatches/${encodeURIComponent(dispatchId)}`, {
    status: committed ? "succeeded" : "failed",
    conversationId: summary.conversationId,
    result: summary,
    errorMessage: committed ? null : noCommitErrorMessage(webgptAnswer)
  });
  markLatency("dispatch_finish_posted");
  console.log(JSON.stringify(summary, null, 2));
  if (!committed) {
    process.exitCode = 3;
  }
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (error) => {
  const dispatchId = argValue("--dispatch-id");
  const localBaseUrl = argValue("--local-base-url", process.env.VNPLAYER_LOCAL_BASE_URL ?? "http://127.0.0.1:4174").replace(/\/$/, "");
  if (dispatchId) {
    await tryPostJson(`${localBaseUrl}/api/webgpt/dispatches/${encodeURIComponent(dispatchId)}`, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
  console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
