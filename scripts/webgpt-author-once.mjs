#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function detachCdpBrowser(browser) {
  browser?._connection?.close?.("VNplayer CDP detach");
}

function latestTurns(form, count) {
  const history = form.readingPacket?.visibleHistory;
  return Array.isArray(history) ? history.slice(-count) : [];
}

function trimParagraph(paragraph, maxChars = 900) {
  if (typeof paragraph !== "string") {
    return "";
  }
  const value = paragraph.trim();
  return value.length > maxChars ? `${value.slice(0, maxChars).trimEnd()}...` : value;
}

function summarizeChoices(choices) {
  if (!Array.isArray(choices)) {
    return [];
  }
  return choices.slice(0, 6).map((choice) => ({
    label: nonEmptyString(choice?.label) ?? "",
    action: nonEmptyString(choice?.action) ?? "",
    tag: nonEmptyString(choice?.tag),
    intent: nonEmptyString(choice?.intent)
  }));
}

function slimHistoryTurnForAuthor(turn) {
  const paragraphs = Array.isArray(turn?.scene?.paragraphs) ? turn.scene.paragraphs : [];
  return {
    scene: {
      speaker: turn?.scene?.speaker ?? null,
      paragraphs: paragraphs.map((paragraph) => trimParagraph(paragraph)).filter(Boolean),
      background: nonEmptyString(turn?.scene?.background),
      mood: nonEmptyString(turn?.scene?.mood)
    },
    concreteDelta: nonEmptyString(turn?.concreteDelta),
    choices: summarizeChoices(turn?.choices)
  };
}

function compactLibraryOutline(form, maxItems = 18) {
  const outline = form.readingPacket?.libraryOutline;
  if (!Array.isArray(outline)) {
    return [];
  }
  const activeDocIds = new Set(
    Array.isArray(form.readingPacket?.activeLibraryDocs)
      ? form.readingPacket.activeLibraryDocs.map((doc) => doc.docId).filter(Boolean)
      : []
  );
  const usefulKinds = new Set([
    "world_note",
    "world_rule",
    "system_law",
    "style_guide",
    "character_card",
    "location_card",
    "open_thread",
    "consequence_note",
    "encounter_surface",
    "dialogue_stance",
    "continuity_note"
  ]);
  const scored = outline
    .filter((doc) => doc?.visibleToLlm !== false && doc?.status !== "superseded" && doc?.status !== "resolved")
    .map((doc, index) => {
      const lastTouched = Number.isFinite(Number(doc.lastTouchedTurnIndex)) ? Number(doc.lastTouchedTurnIndex) : -1;
      const lastUsed = Number.isFinite(Number(doc.lastUsedTurnIndex)) ? Number(doc.lastUsedTurnIndex) : -1;
      const recency = Math.max(lastTouched, lastUsed);
      const score =
        (doc.pinned ? 10000 : 0) +
        (activeDocIds.has(doc.docId) ? 7000 : 0) +
        (usefulKinds.has(doc.kind) ? 1500 : 0) +
        (doc.scope === "scene" ? 700 : doc.scope === "session" ? 500 : doc.scope === "arc" ? 300 : 100) +
        Math.max(recency, 0) * 20 -
        index;
      return { doc, score };
    })
    .sort((a, b) => b.score - a.score || String(b.doc.updatedAt).localeCompare(String(a.doc.updatedAt)));
  return scored.slice(0, maxItems).map(({ doc }) => ({
    docId: doc.docId,
    versionId: doc.versionId,
    kind: doc.kind,
    title: doc.title,
    status: doc.status,
    scope: doc.scope,
    tags: Array.isArray(doc.tags) ? doc.tags.slice(0, 8) : [],
    pinned: Boolean(doc.pinned),
    lastUsedTurnIndex: doc.lastUsedTurnIndex ?? null,
    lastTouchedTurnIndex: doc.lastTouchedTurnIndex ?? null,
    updatedAt: doc.updatedAt
  }));
}

function authorInstructionForForm(form) {
  const instruction = typeof form.instruction === "string" ? form.instruction : "";
  if (form.readingPacket?.worldTitleStatus === "provisional") {
    return instruction;
  }
  return instruction.replace(
    /readingPacket\.worldTitleStatus가 provisional이고 세계 이름이 아직 덜 잡혔다고 판단되면 첫 1-2턴 안에 StoryTurn\.worldNaming으로 제목 후보를 제안할 수 있습니다\..*?숨은 진실, 미공개 반전, 이후에만 드러날 고유명은 제목 후보에 포함하지 마세요\./,
    "세계 이름은 이미 확정 또는 비임시 상태입니다. StoryTurn.worldNaming을 작성하지 마세요."
  );
}

function authorPromptForm(form, { warmConversation }) {
  const history = warmConversation ? latestTurns(form, 2) : latestTurns(form, 8);
  return {
    ...form,
    instruction: authorInstructionForForm(form),
    readingPacket: {
      ...form.readingPacket,
      visibleHistory: history.map((turn) => slimHistoryTurnForAuthor(turn)),
      libraryOutline: compactLibraryOutline(form)
    }
  };
}

function authorVisibleHistoryCount(form, { warmConversation }) {
  return authorPromptForm(form, { warmConversation }).readingPacket.visibleHistory.length;
}

function authorLibraryOutlineCount(form) {
  return compactLibraryOutline(form).length;
}

function conversationModeFromValue(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "new" || normalized === "rollover") {
    return "new";
  }
  return "resume";
}

function narrativeLevelDispatchLine(level) {
  if (level === 1) {
    return "전개 속도: 1(느림). 상태 변화 주기는 1회다. 선택된 행동은 전체 문단의 앞 30% 안에서 실제로 실행 완료한다. 위치, 위험, 자원, 관계, 정보, 출구 중 최소 1개 축을 바꾸고, 직접 결과와 다음 압력에서 멈춘다.";
  }
  if (level === 3) {
    return "전개 속도: 3(빠름). 상태 변화 주기는 2-3회다. 선택된 행동은 전체 문단의 앞 25-30% 안에서 실제로 실행 완료한다. 둘째 beat에서 반작용/복잡화를 만들고, 셋째 beat에서 새 위치/새 압박/새 표면/새 대가 중 하나가 독자가 선택할 수 있는 상태로 착지한다. 위치, 위험, 자원, 관계, 정보, 출구 중 최소 2개 축을 바꾼다. accepted 행동이면 마지막까지 같은 행동을 계속 시도 중인 상태로 멈추지 말고, 그 행동이 만든 다음 문제로 넘어간다.";
  }
  return "전개 속도: 2(보통). 상태 변화 주기는 2회다. 선택된 행동은 전체 문단의 앞 30% 안에서 실제로 실행 완료한다. 플레이어 행동의 직접 결과와 그 결과가 만든 반작용/여파까지 처리하고, 위치, 위험, 자원, 관계, 정보, 출구 중 최소 2개 축을 바꾼다. 새 국면 전체를 해결하지는 않는다.";
}

function detailLevelDispatchLine(level) {
  if (level === 1) {
    return "묘사 밀도: 1(간결). 권장 출력량은 6-10문단이다. 감각과 은유는 핵심 변화에만 붙이고, 진행을 늦추는 장식 문단은 줄인다.";
  }
  if (level === 3) {
    return "묘사 밀도: 3(풍부). 권장 출력량은 16-24문단이며 극단적인 예외가 아니면 28문단을 넘기지 않는다. 풍부한 묘사는 전개 속도를 늦추는 권한이 아니다. 선택 행동 실행과 장면 좌표 변화는 전개 속도 지침을 우선한다.";
  }
  return "묘사 밀도: 2(표준). 권장 출력량은 10-16문단이다. 장면에 머물 시간은 주되 같은 표면을 반복해 문단 수를 늘리지 않는다.";
}

function buildPrompt({ baseUrl, connectorAppName, conversationMode, previousConversationUrl, form, beforeTurnId, warmConversation, dispatchId, dispatchToken }) {
  const packet = form.readingPacket;
  const promptForm = authorPromptForm(form, { warmConversation });
  const latestAction = packet.latestPlayerAction;
  const latestActionLine = latestAction
    ? `이번 플레이어 선택: [${latestAction.label}] ${latestAction.text}`
    : "이번 플레이어 선택: 없음";
  const narrativeLevel = Number(packet.narrativeLevel) === 1 || Number(packet.narrativeLevel) === 3 ? Number(packet.narrativeLevel) : 2;
  const detailLevel = Number(packet.detailLevel) === 1 || Number(packet.detailLevel) === 3 ? Number(packet.detailLevel) : 2;
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
    narrativeLevelDispatchLine(narrativeLevel),
    detailLevelDispatchLine(detailLevel),
    packet.autoCgEnabled === false
      ? "자동 CG 생성: 꺼짐. cgDecision은 작성하지만 백엔드는 자동 CG queue를 만들지 않는다."
      : "자동 CG 생성: 켜짐. cgDecision.generate이면 백엔드가 CG side lane에 큐잉할 수 있다.",
    warmConversation
      ? "이전 ChatGPT 대화는 있을 수 있지만 아래 로컬 delta 스냅샷이 권위다. delta 스냅샷의 visibleHistory는 scene, concreteDelta, 선택지 요약만 남긴 축약본이므로, interface/cgDecision/worldNaming/libraryUpdates를 과거 턴에서 되풀이하지 않는다."
      : "이 대화가 새 작성 세션이면 아래 전체 가시 양식을 기준으로 시작한다.",
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
    "",
    "작성 원칙:",
    "- 백엔드가 서사 방향을 정한다고 가정하지 않는다.",
    "- 본문 산문은 존댓말 안내문처럼 쓰지 않는다. 성인 독자를 위한 문학 산문으로 쓰고, 문장 끝을 억지로 공손하게 만들지 않는다.",
    "- 대사는 본문 산문과 register를 분리해 설계한다. 인물의 관계, 거리감, 사회적 위치, 현재 압박, 말의 목적에 맞는 자연스러운 한국어 구어체를 쓸 수 있다.",
    "- 대사에서는 말줄임, 생략, 되묻기, 끊김, 숨 고르기 같은 구어적 리듬을 허용하되, 모든 인물이 같은 반말이나 같은 농담투로 평평해지지 않게 한다.",
    "- 대사의 구어체가 본문 전체를 채팅 말투나 UI 안내문 말투로 끌고 가면 안 된다. 대사 밖 서술은 장면 산문 register로 돌아와야 한다.",
    "- 선택지 label/action처럼 플레이어에게 직접 건네는 UI 문구만 자연스러운 존댓말을 허용한다. 선택지는 인물 대사가 아니라 독자의 구체적 행동을 안내하는 문구다.",
    "- 설명보다 암시, 과잉 수식보다 정확한 이미지와 장면의 진행을 우선한다. 특정 장르나 작가의 표면적 어조를 고정적으로 모사하지 않는다.",
    "- 동화, 라이트노벨식 친절함, 교훈적인 해설, 감탄사 많은 판타지 내레이션을 피한다.",
    "- 전개 속도와 묘사 밀도는 별개다. 묘사 밀도가 높아도 선택 행동 실행을 뒤로 미루거나 같은 순간을 오래 늘이면 안 된다.",
    "- 전개 속도는 문장 길이나 문단 수가 아니라 상태 변화 주기로 조절한다. 빠른 전개는 장면을 요약하거나 인과를 건너뛰는 것이 아니라, 선택 행동의 실행, 장면의 반작용, 판세 변화, 작은 보상이나 대가, 다음 선택의 갈고리가 한 턴 안에서 분명히 지나가는 것을 뜻한다.",
    "- 핍진성은 유지한다. 행동이 성립하려면 몸, 시간, 거리, 시야, 도구, 사회적 허락, 세계 법칙 중 필요한 조건이 장면 안에서 충족되어야 한다. 조건이 부족하면 partial 또는 blocked로 처리하되, 막힌 이유와 후과를 장면 속 변화로 보여 준다.",
    "- 분량은 padding이 아니다. 문단 수보다 행동 완료, 반작용, 후과, 다음 선택면이 우선이다.",
    "- 선택된 행동은 반드시 전체 문단의 앞 25-30% 안에서 실제로 실행 완료한다. accepted 행동이면 마지막까지 같은 행동을 계속 시도 중인 상태로 남기지 않는다.",
    "- 한 물리 동작을 3문단 이상 연속 확대하지 않는다. 같은 순간을 더 오래 늘이는 대신 장면 좌표를 앞으로 옮긴다.",
    "- 위치, 위험, 자원, 관계, 정보, 출구 중 전개 속도 지침이 요구한 축이 실제로 변해야 한다.",
    "- 감각과 은유는 장면의 물리적 변화, 위협의 접근, 선택 가능한 표면을 더 선명하게 할 때만 확장한다. 반복되는 감각어, 신체 부위, 물질, 동작에는 매번 새 위치, 새 거리, 새 위험, 새 비용, 새 선택지 중 하나가 있어야 한다.",
    "- 내면 서술은 판단과 행동을 돕는 만큼만 쓴다. 주인공이 상황을 오래 관조하기보다, 무엇을 알아차렸고 무엇을 선택할 수 있게 되었는지가 드러나야 한다.",
    "- 긴장 장면에서는 외부 압력의 변화가 서술의 중심축이어야 한다. 추적자, 소리, 거리, 빛, 지형, 출구, 자원 같은 요소가 실제로 움직이거나 달라져야 한다.",
    "- 세밀한 동작을 묘사할 때는 과정 전체를 반복하지 말고, 동작이 만든 결과와 그 결과가 부른 반응을 우선한다.",
    "- 구체적 표면과 물리적 인과는 장면을 붙잡기 위한 장식이 아니라 상태를 바꾸는 원인으로 사용한다. 새 표면을 도입할 때는 위치, 상대 상태, 자원, 탈출 가능성, 정보, 관계 중 무엇이 달라졌는지 함께 드러낸다.",
    "- 같은 표면을 반복해서 조작하는 장면은 압축한다. 반복이 필요하면 각 반복이 장소 경계, 상대 상태, 도구 소유권, 부상/자원, 정보/관계 중 하나를 실제로 바꾸어야 한다.",
    "- 핵심 변화 1-2곳에서는 물리적 인과와 감각의 방향을 선명하게 쓴다. 어떤 움직임이 무엇을 누르고, 그 압력이 어떤 소리나 흔적을 만들었는지 독자가 위치를 잃지 않을 만큼만 보여 준다.",
    "- 윤문에서는 물리적 인과와 독자의 방향감을 우선한다. 인지 상태를 설명해야 할 때도 추상어에만 기대지 말고, 감각의 이동, 몸의 반응, 사물의 작동, 위협의 거리 변화와 함께 드러낸다.",
    "- 반복 지칭과 공간 정보는 장면을 안정시키는 데 필요한 만큼 사용하되, 리듬이 단조로워질 때는 행동 주어, 시선 이동, 소리의 방향, 압력의 변화로 변주한다.",
    "- 물건과 장치의 의미는 가능한 한 사용 중의 흔적과 반응으로 전달하고, 판단 유보 표현은 장면의 긴장에 맞게 압축한다.",
    "- 위험, 공포, 조급함 같은 추상 감정어는 가능하면 숨, 근육, 시선, 손의 움직임 같은 신체 반응이나 행동으로 치환한다.",
    "- 좁음, 무거움, 차가움 같은 상태는 필요할 때 형용사만으로 처리하지 말고 피부, 뼈, 흙, 물, 금속이 서로 닿는 압력과 마찰로 보여 준다. 같은 물성 설명을 반복해 문단을 늘리지 않는다.",
    "- 긴박한 문장에서는 부사보다 동사로 속도를 조절한다. 긁다, 찌르다, 비틀다, 밀다, 짓누르다 같은 동작이 문장 리듬을 만들게 한다.",
    "- 위쪽, 앞쪽, 뒤쪽, 안쪽 같은 공간 층위를 유지해 독자가 압박의 방향을 잃지 않게 한다.",
    "- 장면을 성급하게 건너뛰지 말되, 이미 선택된 행동의 직접 목표는 한 턴 안에서 처리한다. 핵심 갈등 전체를 해결하지 않더라도, 현재 행동이 만든 국면은 다음 문제로 넘어가야 한다.",
    "- 선택지 직전의 새 상태는 같은 교착의 미세 조정이 아니라 독자가 다른 종류의 결정을 할 수 있는 상태여야 한다. 이동, 손실, 상대의 상태 변화, 정보 공개, 관계 태도 변화, 새 공간 진입 중 하나가 드러나야 한다.",
    "- 같은 장소, 같은 핵심 상대, 같은 핵심 도구, 같은 목표가 2턴 이상 유지되면 다음 턴은 현재 교착을 끝내거나 다른 국면으로 전환한다. 전환은 탈출, 포획, 상대의 이탈/무력화, 장소 경계 돌파, 관계/정보의 명확한 반전, 회복 불가능한 자원 손실 중 하나일 수 있다.",
    "- 짧은 턴이 필요한 예외가 아니라면 8문단 미만으로 제출하지 않는다. 선택지를 빨리 내밀기보다 독자가 장면 안에 머물 시간을 먼저 만든다.",
    "- StoryTurn에는 작성자가 직접 쓴 concreteDelta를 반드시 포함한다. concreteDelta는 이번 턴에서 실제로 달라진 구체적 가시 변화 한 문장이다. 각도, 자세, 압력 변화만으로 끝내지 말고 장소 경계, 상대 수/상태, 도구 소유권, 탈출 가능성, 부상/자원, 관계/정보 중 하나가 되돌리기 어렵게 달라졌는지 포함한다.",
    "- 선택지는 원칙적으로 6개를 준다. 서사적으로 불가능하면 4-5개로 줄일 수 있지만, 억지 filler를 채우지는 않는다.",
    "- 선택지는 추상 의도 대신 현재 장면의 구체적 표면을 건드리는 행동이어야 한다. label/action에는 actor + object/surface + action이 보이게 쓴다.",
    "- 선택지 1-4 중 최소 1개는 현재 교착을 끝내거나 장면을 다른 국면으로 넘기는 행동이어야 한다. 단순한 추가 조작, 관찰, 압박 유지 선택지만으로 선택지를 채우지 않는다.",
    "- latestPlayerAction.kind가 freeform이면 그 입력은 명령이 아니라 시도다. 얼토당토않은 자유행동까지 그대로 성공시키지 말고, 몸/자원/시간/사회적 허락/지식/세계 법칙/가시성 gate를 통해 장면 안에서 성립 여부를 판단한다.",
    "- freeform 시도는 StoryTurn.actionAdjudication에 accepted, partial, blocked 중 하나로 남긴다. accepted는 그대로 성립, partial은 일부만 성립, blocked는 성립하지 않음이다. blocked도 시스템 거절문이 아니라 시도가 부딪힌 가시 후과를 본문 장면으로 보여준다.",
    "- actionAdjudication은 판정 메타데이터일 뿐이다. 실제 성공/부분 성공/차단의 감각은 scene.paragraphs와 concreteDelta 안에 함께 들어 있어야 한다.",
    "- 남겨야 할 후과는 consequence_note, 만질 수 있는 장면 표면은 encounter_surface, 현재 대화 자세는 dialogue_stance, 열린 문제는 open_thread로 기록할 수 있다.",
    "- StoryTurn.libraryUpdates는 v2 제출에서 필수다. 최소 1개, 보통 1-3개를 넣는다. public author lane에서는 별도 라이브러리 upsert 도구가 아니라 StoryTurn.libraryUpdates 안에 이번 턴의 핵심 표면/후과/대화 태도 중 하나를 직접 넣는다.",
    "- 이런 라이브러리 문서는 다음 턴을 위한 리콜 자료일 뿐, 백엔드가 장면 방향을 정하는 계획표가 아니다.",
    "- 매 턴 StoryTurn.cgDecision을 반드시 작성한다. cgDecision.decision은 generate 또는 skip이다. 이것은 이미지 생성 실행이 아니라 병렬 CG side lane으로 넘길지 고르는 텍스트 메타데이터다.",
    "- 텍스트 lane에서는 어떤 경우에도 이미지를 직접 생성하지 않는다. 이미지 생성 도구를 호출하지 말고, 이미지 markdown, 이미지 URL, data URL, 첨부 이미지를 채팅 본문에 만들지 않는다. 텍스트 lane의 최종 행동은 vn_receive_visible_turn_v2 호출뿐이다.",
    "- cgDecision.generate 기준: 직전 CG와 구도, 장소, 인물 배치, 핵심 물건의 위치가 분명히 달라지는 새 시각 국면이면 generate다. 새 조작 표면이 생겼더라도 같은 공간, 같은 거리감, 같은 표면의 반복이면 skip이다.",
    "- cgDecision.generate일 때는 cgDecision.cgRequest를 함께 작성한다. cgRequest는 텍스트 lane이 직접 고르는 의뢰서 텍스트이며, 병렬 CG side lane만 소비한다. visible text에 이미 드러난 subject와 visibleAnchors만 사용하고, 미래 장면, 숨은 진실, 새 단서, 새 인물, 읽을 수 있는 문자, 다음 선택의 의미를 만들지 않는다.",
    "- cgDecision.skip일 때는 reason을 쓰고, 다음 후보가 보이면 nextLikelyTrigger에 시각적 조건만 적는다. CG side lane에 넘길 가치가 있다고 판단하면 직접 이미지를 만들지 말고 cgDecision.decision을 generate로 쓰고 cgDecision.cgRequest 안에 의뢰서만 넣는다.",
    "- 특정 작가의 문장을 노골적으로 모사하지 않는다.",
    "",
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
