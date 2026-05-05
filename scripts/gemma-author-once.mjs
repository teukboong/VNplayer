#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { authorLibraryOutlineCount, authorPromptForm, authorVisibleHistoryCount, nonEmptyString } from "./author-prompt.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const scriptStartedAt = new Date().toISOString();
const scriptStartedMs = performance.now();
const defaultGemmaBaseUrl = "http://127.0.0.1:8080/v1";
const defaultGemmaModel = "gemma4-local";
const defaultGemmaMaxInputTokens = 32768;
const defaultGemmaMaxOutputTokens = 32768;
const libraryUpdateKinds = new Set([
  "world_note",
  "world_rule",
  "system_law",
  "style_guide",
  "character_card",
  "faction_card",
  "item_card",
  "location_card",
  "relationship_note",
  "continuity_note",
  "open_thread",
  "consequence_note",
  "encounter_surface",
  "dialogue_stance",
  "motif_note",
  "editorial_note",
  "retcon_note",
  "reader_preference",
  "writer_prompt",
  "tool_use_policy"
]);
const libraryUpdateKindLabels = {
  consequence_note: "후과",
  encounter_surface: "장면 표면",
  dialogue_stance: "대화 태도",
  open_thread: "열린 실마리",
  continuity_note: "연속성",
  world_note: "세계 메모",
  world_rule: "세계 법칙",
  character_card: "인물",
  location_card: "장소",
  motif_note: "모티프"
};
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
        provider: "gemma4_local",
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

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeBaseUrl(value) {
  return (value?.trim() || defaultGemmaBaseUrl).replace(/\/$/, "");
}

function maskedUrl(value) {
  try {
    const url = new URL(value);
    const host =
      url.hostname === "127.0.0.1" || url.hostname === "localhost"
        ? url.hostname
        : "configured-host";
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "configured-url";
  }
}

function maskedModel(value) {
  return value === defaultGemmaModel ? value : "configured-model";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function postJson(url, body, headers = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
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

async function tryFinishDispatch(localBaseUrl, dispatchId, body) {
  try {
    return await postJson(`${localBaseUrl}/api/webgpt/dispatches/${encodeURIComponent(dispatchId)}`, body);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function firstObjectCandidate(text) {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function parseModelTurn(content) {
  const text = nonEmptyString(content);
  if (!text) {
    throw new Error("Gemma 응답 본문이 비어 있습니다.");
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [text, fenced, firstObjectCandidate(text)].filter((value) => typeof value === "string" && value.trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("StoryTurn JSON은 객체여야 합니다.");
      }
      return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("Gemma 응답에서 StoryTurn JSON 객체를 읽지 못했습니다.");
}

function textFromGemmaLibraryValue(value) {
  if (typeof value === "string") {
    return optionalText(value);
  }
  if (!isRecord(value)) {
    return null;
  }
  return optionalText(value.text) ?? optionalText(value.content) ?? optionalText(value.summary) ?? optionalText(value.visibleSignal) ?? optionalText(value.surface);
}

function libraryTitle(kind, text, index) {
  const label = libraryUpdateKindLabels[kind] ?? kind;
  const normalized = optionalText(text)?.replace(/\s+/g, " ");
  if (!normalized) {
    return `${label} ${index + 1}`;
  }
  return normalized.length > 44 ? `${label}: ${normalized.slice(0, 44)}...` : `${label}: ${normalized}`;
}

function normalizeGemmaLibraryUpdate(item, index) {
  if (!isRecord(item)) {
    return null;
  }
  const explicitKind = optionalText(item.kind) ?? optionalText(item.type);
  if (explicitKind && libraryUpdateKinds.has(explicitKind)) {
    const text = textFromGemmaLibraryValue(item.body) ?? optionalText(item.content) ?? optionalText(item.text) ?? optionalText(item.summary) ?? optionalText(item.title);
    return {
      ...item,
      kind: explicitKind,
      title: optionalText(item.title) ?? libraryTitle(explicitKind, text, index),
      body: item.body ?? { text: text ?? optionalText(item.title) ?? `${explicitKind} update` },
      status: optionalText(item.status) ?? "active",
      scope: optionalText(item.scope) ?? "scene",
      tags: Array.isArray(item.tags) ? item.tags : [explicitKind],
      updateReason: optionalText(item.updateReason) ?? "Gemma 작성 턴에서 추출한 안정적 장면 갱신."
    };
  }
  for (const [key, value] of Object.entries(item)) {
    if (!libraryUpdateKinds.has(key)) {
      continue;
    }
    const text = textFromGemmaLibraryValue(value);
    return {
      kind: key,
      title: libraryTitle(key, text, index),
      body: isRecord(value) ? value : { text: text ?? String(value) },
      status: "active",
      scope: "scene",
      tags: [key],
      updateReason: "Gemma 단축형 library update를 StoryTurn.libraryUpdates 계약 형태로 정규화했습니다."
    };
  }
  return null;
}

function normalizeGemmaLibraryUpdates(value) {
  const updates = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return updates.map((item, index) => normalizeGemmaLibraryUpdate(item, index)).filter((item) => item !== null);
}

function normalizeGemmaChoiceItem(item) {
  if (typeof item === "string") {
    const text = optionalText(item);
    return text ? [{ label: text, action: text }] : [];
  }
  if (Array.isArray(item)) {
    return item.flatMap((nested) => normalizeGemmaChoiceItem(nested));
  }
  if (!isRecord(item)) {
    return [];
  }
  if (Array.isArray(item.choices)) {
    return normalizeGemmaChoices(item.choices);
  }
  if (Array.isArray(item.options)) {
    return normalizeGemmaChoices(item.options);
  }
  const label = optionalText(item.label) ?? optionalText(item.title) ?? optionalText(item.text) ?? optionalText(item.action) ?? optionalText(item.intent);
  const action = optionalText(item.action) ?? optionalText(item.text) ?? optionalText(item.description) ?? label;
  if (!label || !action) {
    return [];
  }
  const choice = { ...item, label, action };
  const tag = optionalText(item.tag);
  const intent = optionalText(item.intent);
  if (tag) {
    choice.tag = tag;
  }
  if (intent) {
    choice.intent = intent;
  }
  return [choice];
}

function normalizeGemmaChoices(value) {
  const rawChoices = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const choices = rawChoices.flatMap((item) => normalizeGemmaChoiceItem(item));
  const seen = new Set();
  return choices
    .filter((choice) => {
      const key = `${choice.label}\n${choice.action}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function normalizeGemmaStoryTurn(parsed) {
  const candidate = isRecord(parsed?.turn) ? parsed.turn : parsed;
  if (!isRecord(candidate)) {
    return parsed;
  }
  const scene = isRecord(candidate.scene) ? candidate.scene : null;
  const turn = {
    ...candidate,
    scene: scene
      ? {
          speaker: scene.speaker ?? null,
          paragraphs: scene.paragraphs,
          background: scene.background ?? null,
          mood: scene.mood ?? null
        }
      : candidate.scene
  };
  if (scene) {
    for (const field of ["concreteDelta", "interface", "choices", "libraryUpdates", "cgRequest", "cgDecision", "actionAdjudication", "worldNaming"]) {
      if (turn[field] === undefined && scene[field] !== undefined) {
        turn[field] = scene[field];
      }
    }
  }
  const choices = normalizeGemmaChoices(turn.choices);
  if (choices.length) {
    turn.choices = choices;
  }
  const libraryUpdates = normalizeGemmaLibraryUpdates(turn.libraryUpdates);
  if (libraryUpdates.length) {
    turn.libraryUpdates = libraryUpdates;
  } else {
    const delta = optionalText(turn.concreteDelta);
    if (delta) {
      turn.libraryUpdates = [
        {
          kind: "consequence_note",
          title: libraryTitle("consequence_note", delta, 0),
          body: { text: delta },
          status: "active",
          scope: "scene",
          tags: ["consequence_note"],
          updateReason: "Gemma가 쓴 concreteDelta를 최소 라이브러리 갱신으로 보존했습니다."
        }
      ];
    }
  }
  return turn;
}

function currentTurnId(state) {
  return typeof state?.currentTurn?.id === "string" ? state.currentTurn.id : null;
}

function latestActionLine(form) {
  const action = form.readingPacket?.latestPlayerAction;
  if (!action) {
    return "이번 플레이어 선택: 없음";
  }
  const label = nonEmptyString(action.label) ?? "선택";
  const text = nonEmptyString(action.text) ?? "";
  return `이번 플레이어 선택: [${label}] ${text}`;
}

function narrativeVolumeContract(packet) {
  const detailLevel = Number(packet?.detailLevel);
  const narrativeLevel = Number(packet?.narrativeLevel);
  if (detailLevel >= 3) {
    return {
      paragraphRange: "16-24",
      minimumParagraphs: 16,
      description: "풍부한 장면 산문"
    };
  }
  if (detailLevel <= 1) {
    return {
      paragraphRange: narrativeLevel >= 3 ? "5-8" : "4-7",
      minimumParagraphs: narrativeLevel >= 3 ? 5 : 4,
      description: "압축된 장면 산문"
    };
  }
  return {
    paragraphRange: narrativeLevel >= 3 ? "10-16" : "8-14",
    minimumParagraphs: narrativeLevel >= 3 ? 10 : 8,
    description: "보통 밀도의 장면 산문"
  };
}

function estimateChatInputTokens(messages) {
  const charCount = messages.reduce((total, message) => total + Array.from(String(message.content ?? "")).length, 0);
  // Conservative enough for mixed Korean/English prompts without adding a tokenizer dependency.
  return Math.ceil(charCount / 2);
}

function buildGemmaMessages({ form, beforeTurnId, dispatchId, promptOptions = {} }) {
  const packet = form.readingPacket;
  const promptForm = authorPromptForm(form, { warmConversation: false, promptDietMode: "stateful-lossless", historyCount: 12, ...promptOptions });
  const volume = narrativeVolumeContract(packet);
  const system = [
    "너는 VNplayer의 로컬 Gemma4 작성 좌석이다.",
    "VNplayer 백엔드는 저장, 검증, 검색, 커밋만 맡고 너는 다음 StoryTurn JSON만 작성한다.",
    "이 API 호출은 상태 없는 단발 호출이다. 이전 API 대화나 숨은 기억이 있다고 가정하지 마라.",
    "연속성의 권위는 user 메시지의 현재 로컬 양식 스냅샷뿐이다.",
    "출력은 markdown, 설명, 코드펜스 없이 StoryTurn JSON 객체 하나여야 한다.",
    `장면 산문은 ${volume.description}으로 쓴다. scene.paragraphs 분량 계약을 짧게 요약하거나 생략하지 마라.`
  ].join("\n");
  const user = [
    "provider: gemma4_local",
    "promptMode: gemma-stateless-current",
    `VNPLAYER_DISPATCH_MARKER: ${dispatchId}`,
    `worldId: ${packet.worldId}`,
    `sessionId: ${packet.sessionId}`,
    beforeTurnId ? `currentTurnId: ${beforeTurnId}` : "currentTurnId: 없음. 첫 장면을 작성해야 함.",
    latestActionLine(form),
    packet.autoCgEnabled === false
      ? "자동 CG 생성: 꺼짐. cgDecision은 작성하지만 백엔드는 자동 CG queue를 만들지 않는다."
      : "자동 CG 생성: 켜짐. cgDecision.generate이면 백엔드가 CG side lane에 큐잉할 수 있다.",
    "",
    "작성 계약:",
    "1. 현재 로컬 양식 스냅샷의 instruction과 readingPacket만 근거로 다음 StoryTurn을 작성한다.",
    "2. 새 턴에서 안정적으로 드러난 후과, 장면 표면, 대화 태도, 열린 실마리, 인물, 장소, 세계 법칙 중 최소 1개를 최상위 StoryTurn.libraryUpdates 배열에 남긴다.",
    "3. 숨은 진실, 미공개 반전, 이후 전개 계획은 libraryUpdates에 쓰지 않는다.",
    "4. cgDecision은 반드시 decision: generate 또는 skip 형태로 작성한다.",
    "5. choices는 중첩 없는 flat array이며 각 원소는 반드시 { label, action, tag?, intent? } 객체다. 문자열 선택지나 choices 안의 배열은 쓰지 않는다.",
    "6. choices의 label, action, tag, intent는 모두 독자에게 보이는 UI 문구다. 고유명사를 제외하고 한국어로 작성하고, advance/probe/enter/time_pass 같은 영어 메타 태그를 그대로 쓰지 않는다.",
    "7. 자유 행동 결과를 쓰는 턴이면 actionAdjudication으로 성립 여부를 판정한다.",
    "8. JSON 외 텍스트는 쓰지 않는다. dispatchToken이나 HTTP 호출은 필요 없다. VNplayer worker가 네 JSON을 검증 도구로 커밋한다.",
    "9. scene 안에는 speaker, paragraphs, background, mood만 넣는다. choices, concreteDelta, interface, cgDecision, libraryUpdates, actionAdjudication, worldNaming은 모두 scene 밖 최상위 StoryTurn 필드다.",
    "10. libraryUpdates 항목은 { kind, title, body, status, scope, tags, updateReason } 형태다. kind는 consequence_note, encounter_surface, dialogue_stance, open_thread 중 하나를 우선 사용한다.",
    "",
    "Gemma 서술 분량 계약:",
    `- scene.paragraphs는 ${volume.paragraphRange}개를 목표로 하고, 극단적인 예외가 아니면 최소 ${volume.minimumParagraphs}개 미만으로 줄이지 않는다.`,
    "- 대사 한 줄이나 효과음 한 줄만으로 문단 수를 채우지 말고, 행동 실행, 물리적 반작용, 상태 변화, 다음 선택면을 각각 장면 산문으로 펼친다.",
    "- JSON 형식 때문에 산문을 요약하지 마라. instruction 안의 권장 출력량과 이 분량 계약이 충돌하면 이 앞쪽 계약을 우선한다.",
    "- 전개 속도는 문단 수를 줄이라는 뜻이 아니다. 선택 행동은 앞 30% 안에서 실행하고, 남은 문단은 결과와 반작용과 새 선택면을 보여준다.",
    "",
    "현재 로컬 양식 스냅샷(stateful-lossless compact JSON):",
    "promptDiet.mode가 stateful-lossless-v1이면 오래된 턴 산문 원문은 DB에 보존되어 있고, 이 스냅샷에는 concreteDelta, stableLibraryUpdates, 선택지, 표면 상태, cold refs가 들어 있다.",
    JSON.stringify(promptForm)
  ].join("\n");
  return {
    promptForm,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };
}

function buildBudgetedGemmaMessages({ form, beforeTurnId, dispatchId, maxInputTokens }) {
  const budgets = [
    { historyCount: 12, fullHistoryCount: 2, libraryOutlineCount: 20 },
    { historyCount: 10, fullHistoryCount: 2, libraryOutlineCount: 18 },
    { historyCount: 8, fullHistoryCount: 2, libraryOutlineCount: 16 },
    { historyCount: 6, fullHistoryCount: 2, libraryOutlineCount: 12 },
    { historyCount: 4, fullHistoryCount: 1, libraryOutlineCount: 8 },
    { historyCount: 2, fullHistoryCount: 1, libraryOutlineCount: 6 }
  ];
  let smallest;
  for (const promptOptions of budgets) {
    const built = buildGemmaMessages({ form, beforeTurnId, dispatchId, promptOptions });
    const estimatedInputTokens = estimateChatInputTokens(built.messages);
    const result = { ...built, promptOptions, estimatedInputTokens, maxInputTokens };
    smallest = result;
    if (estimatedInputTokens <= maxInputTokens) {
      return result;
    }
  }
  throw new Error(
    `Gemma 입력 프롬프트가 최대 입력 토큰 예산을 초과했습니다. estimated=${smallest.estimatedInputTokens}, limit=${maxInputTokens}`
  );
}

async function main() {
  const worldId = requireArg("--world-id");
  const sessionId = requireArg("--session-id");
  const localBaseUrl = normalizeBaseUrl(requireArg("--local-base-url"));
  const dispatchId = requireArg("--dispatch-id");
  const dispatchToken = requireArg("--dispatch-token");
  const artifactDir = resolve(argValue("--artifact-dir", process.env.VNPLAYER_GEMMA_ARTIFACT_DIR ?? join(repoRoot, "data", "gemma-dispatches")));
  const gemmaBaseUrl = normalizeBaseUrl(argValue("--gemma-base-url", process.env.VNPLAYER_GEMMA_BASE_URL ?? defaultGemmaBaseUrl));
  const model = argValue("--model", process.env.VNPLAYER_GEMMA_MODEL ?? defaultGemmaModel)?.trim() || defaultGemmaModel;
  const apiKey = process.env.VNPLAYER_GEMMA_API_KEY?.trim();
  const temperature = Number(process.env.VNPLAYER_GEMMA_TEMPERATURE ?? "0.9");
  const maxInputTokens = parsePositiveInt(process.env.VNPLAYER_GEMMA_MAX_INPUT_TOKENS, defaultGemmaMaxInputTokens);
  const maxTokens = parsePositiveInt(process.env.VNPLAYER_GEMMA_MAX_OUTPUT_TOKENS, defaultGemmaMaxOutputTokens);

  const dispatchDir = join(artifactDir, dispatchId);
  mkdirSync(dispatchDir, { recursive: true });
  activeDispatchDir = dispatchDir;
  activeDispatchId = dispatchId;
  markLatency("script_started");

  const stateResult = await postJson(`${localBaseUrl}/api/webgpt/tools/vn_get_reader_state`, { worldId, sessionId });
  const state = stateResult.state;
  const form = state?.form;
  if (!form) {
    throw new Error("reader state에서 작성 form을 찾지 못했습니다.");
  }
  const beforeTurnId = currentTurnId(state);
  markLatency("reader_state_loaded", { beforeTurnId });

  const { promptForm, messages, promptOptions, estimatedInputTokens } = buildBudgetedGemmaMessages({
    form,
    beforeTurnId,
    dispatchId,
    maxInputTokens
  });
  writeFileSync(join(dispatchDir, "prompt.json"), JSON.stringify(promptForm, null, 2));
  writeFileSync(join(dispatchDir, "messages.json"), JSON.stringify(messages, null, 2));
  writeFileSync(join(dispatchDir, "prompt.txt"), messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n---\n\n"));
  markLatency("prompt_written", {
    visibleHistoryCount: authorVisibleHistoryCount(form, { warmConversation: false, ...promptOptions }),
    libraryOutlineCount: authorLibraryOutlineCount(form, promptOptions),
    estimatedInputTokens,
    maxInputTokens
  });

  const gemmaRequest = {
    model,
    messages,
    temperature: Number.isFinite(temperature) ? temperature : 0.9,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    stream: false
  };
  writeFileSync(
    join(dispatchDir, "gemma-request.json"),
    JSON.stringify(
      {
        ...gemmaRequest,
        messages: messages.map((message) => ({ ...message, contentLength: message.content.length, content: message.content }))
      },
      null,
      2
    )
  );

  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  markLatency("gemma_call_start", { gemmaBaseUrl: maskedUrl(gemmaBaseUrl), model: maskedModel(model) });
  const gemmaResponse = await postJson(`${gemmaBaseUrl}/chat/completions`, gemmaRequest, headers);
  markLatency("gemma_call_done");
  writeFileSync(join(dispatchDir, "gemma-response.json"), JSON.stringify(gemmaResponse, null, 2));

  const content = gemmaResponse?.choices?.[0]?.message?.content;
  const reasoningOnly = gemmaResponse?.choices?.[0]?.message?.reasoning_content;
  if (!content && reasoningOnly) {
    throw new Error("Gemma가 reasoning_content만 반환하고 StoryTurn JSON content를 비웠습니다.");
  }
  writeFileSync(join(dispatchDir, "gemma-output.txt"), content ?? "");
  const rawTurn = parseModelTurn(content);
  const turn = normalizeGemmaStoryTurn(rawTurn);
  writeFileSync(join(dispatchDir, "parsed-turn.json"), JSON.stringify(rawTurn, null, 2));
  writeFileSync(join(dispatchDir, "normalized-turn.json"), JSON.stringify(turn, null, 2));
  markLatency("turn_parsed");

  const receiveResult = await postJson(`${localBaseUrl}/api/webgpt/tools/vn_receive_visible_turn_v2`, {
    worldId,
    sessionId,
    dispatchToken,
    turn
  });
  writeFileSync(join(dispatchDir, "receive-result.json"), JSON.stringify(receiveResult, null, 2));
  markLatency("turn_submitted", { turnId: receiveResult.turnId ?? null });

  const afterStateResult = await postJson(`${localBaseUrl}/api/webgpt/tools/vn_get_reader_state`, { worldId, sessionId });
  const afterTurnId = currentTurnId(afterStateResult.state);
  const committed = Boolean(afterTurnId && afterTurnId !== beforeTurnId);
  const summary = {
    provider: "gemma4_local",
    dispatchId,
    worldId,
    sessionId,
    beforeTurnId,
    afterTurnId,
    committed,
    receiveTurnId: receiveResult.turnId ?? null,
    model: maskedModel(model),
    gemmaBaseUrl: maskedUrl(gemmaBaseUrl),
    estimatedInputTokens,
    maxInputTokens,
    maxOutputTokens: maxTokens,
    promptMode: "gemma-stateless-current",
    completedAt: new Date().toISOString()
  };
  writeFileSync(join(dispatchDir, "summary.json"), JSON.stringify(summary, null, 2));
  if (!committed) {
    throw new Error("Gemma 턴 제출 후 새 턴 커밋이 확인되지 않았습니다.");
  }

  await tryFinishDispatch(localBaseUrl, dispatchId, {
    status: "succeeded",
    conversationId: null,
    result: summary,
    errorMessage: null
  });
  markLatency("dispatch_finished", { status: "succeeded", afterTurnId });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (activeDispatchDir) {
    writeFileSync(
      join(activeDispatchDir, "summary.json"),
      JSON.stringify(
        {
          provider: "gemma4_local",
          dispatchId: activeDispatchId,
          committed: false,
          errorMessage: message,
          completedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
    markLatency("script_failed", { errorMessage: message });
  }
  const localBaseUrl = argValue("--local-base-url")?.trim();
  const dispatchId = argValue("--dispatch-id")?.trim();
  if (localBaseUrl && dispatchId) {
    await tryFinishDispatch(normalizeBaseUrl(localBaseUrl), dispatchId, {
      status: "failed",
      conversationId: null,
      result: { provider: "gemma4_local", promptMode: "gemma-stateless-current" },
      errorMessage: message
    });
  }
  console.error(message);
  process.exit(1);
});
