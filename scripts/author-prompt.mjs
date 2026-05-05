export function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function latestTurns(form, count) {
  const history = form.readingPacket?.visibleHistory;
  if (!Array.isArray(history) || count <= 0) {
    return [];
  }
  return history.slice(-count);
}

function trimParagraph(paragraph, maxChars = 900) {
  if (typeof paragraph !== "string") {
    return "";
  }
  const value = paragraph.trim();
  return value.length > maxChars ? `${value.slice(0, maxChars).trimEnd()}...` : value;
}

function compactText(value, maxChars = 320) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return null;
  }
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}...` : text;
}

function compactJsonValue(value, maxChars = 900) {
  if (value === undefined || value === null) {
    return value;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= maxChars) {
    return value;
  }
  return {
    digest: `${text.slice(0, maxChars).trimEnd()}...`,
    originalCharCount: text.length,
    sourceRetainedInDb: true
  };
}

function summarizeChoices(choices, { maxItems = 6, labelMaxChars = 160, actionMaxChars = 240, intentMaxChars = 180 } = {}) {
  if (!Array.isArray(choices)) {
    return [];
  }
  return choices.slice(0, maxItems).map((choice) => ({
    label: compactText(choice?.label, labelMaxChars) ?? "",
    action: compactText(choice?.action, actionMaxChars) ?? "",
    tag: nonEmptyString(choice?.tag),
    intent: compactText(choice?.intent, intentMaxChars)
  }));
}

function summarizeLibraryUpdates(updates, maxItems = 4) {
  if (!Array.isArray(updates)) {
    return [];
  }
  return updates.slice(0, maxItems).map((update) => ({
    kind: nonEmptyString(update?.kind),
    title: nonEmptyString(update?.title),
    status: nonEmptyString(update?.status),
    scope: nonEmptyString(update?.scope),
    tags: Array.isArray(update?.tags) ? update.tags.slice(0, 6) : [],
    updateReason: compactText(update?.updateReason, 180),
    bodyDigest: compactJsonValue(update?.body, 360)
  }));
}

function summarizeInterface(storyInterface) {
  if (!storyInterface || typeof storyInterface !== "object" || Array.isArray(storyInterface)) {
    return undefined;
  }
  const statusRows = Array.isArray(storyInterface.statusRows) ? storyInterface.statusRows.slice(0, 6) : undefined;
  const scanRows = Array.isArray(storyInterface.scanRows) ? storyInterface.scanRows.slice(0, 6) : undefined;
  const progress = storyInterface.progress && typeof storyInterface.progress === "object" ? storyInterface.progress : undefined;
  const summary = {};
  if (statusRows?.length) {
    summary.statusRows = statusRows;
  }
  if (scanRows?.length) {
    summary.scanRows = scanRows;
  }
  if (progress) {
    summary.progress = progress;
  }
  return Object.keys(summary).length ? summary : undefined;
}

function summarizeAuthorInputTrace(trace) {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    return trace;
  }
  const contextItemCounts = {};
  if (Array.isArray(trace.contextItems)) {
    for (const item of trace.contextItems) {
      const kind = nonEmptyString(item?.kind) ?? "unknown";
      contextItemCounts[kind] = (contextItemCounts[kind] ?? 0) + 1;
    }
  }
  return {
    compiledAt: trace.compiledAt,
    historyTurnsIncluded: trace.historyTurnsIncluded,
    historyTurnsOmitted: trace.historyTurnsOmitted,
    activeLibraryDocsIncluded: trace.activeLibraryDocsIncluded,
    libraryOutlineItemsIncluded: trace.libraryOutlineItemsIncluded,
    contextItemCounts,
    contextItemsRetainedInDb: true
  };
}

export function slimHistoryTurnForAuthor(turn, { paragraphMaxChars = 900 } = {}) {
  const paragraphs = Array.isArray(turn?.scene?.paragraphs) ? turn.scene.paragraphs : [];
  return {
    turnId: nonEmptyString(turn?.id) ?? nonEmptyString(turn?.turnId),
    turnIndex: Number.isFinite(Number(turn?.turnIndex)) ? Number(turn.turnIndex) : null,
    scene: {
      speaker: turn?.scene?.speaker ?? null,
      paragraphs: paragraphs.map((paragraph) => trimParagraph(paragraph, paragraphMaxChars)).filter(Boolean),
      background: nonEmptyString(turn?.scene?.background),
      mood: nonEmptyString(turn?.scene?.mood)
    },
    concreteDelta: nonEmptyString(turn?.concreteDelta),
    libraryUpdates: summarizeLibraryUpdates(turn?.libraryUpdates),
    interface: summarizeInterface(turn?.interface),
    choices: summarizeChoices(turn?.choices)
  };
}

export function stateHistoryTurnForAuthor(turn) {
  const paragraphs = Array.isArray(turn?.scene?.paragraphs) ? turn.scene.paragraphs : [];
  const anchors = [paragraphs[0], paragraphs.at(-1)].map((paragraph) => trimParagraph(paragraph, 160)).filter(Boolean);
  return {
    turnId: nonEmptyString(turn?.id) ?? nonEmptyString(turn?.turnId),
    turnIndex: Number.isFinite(Number(turn?.turnIndex)) ? Number(turn.turnIndex) : null,
    sceneState: {
      speaker: turn?.scene?.speaker ?? null,
      background: nonEmptyString(turn?.scene?.background),
      mood: nonEmptyString(turn?.scene?.mood),
      paragraphCount: paragraphs.length,
      anchors
    },
    concreteDelta: nonEmptyString(turn?.concreteDelta),
    stableLibraryUpdates: summarizeLibraryUpdates(turn?.libraryUpdates),
    interfaceState: summarizeInterface(turn?.interface),
    choices: summarizeChoices(turn?.choices, { maxItems: 4, labelMaxChars: 110, actionMaxChars: 130, intentMaxChars: 90 })
  };
}

function visibleHistoryForAuthor(
  form,
  {
    warmConversation = false,
    historyCount = null,
    promptDietMode = "legacy-slim",
    fullHistoryCount = null,
    recentParagraphMaxChars = null
  } = {}
) {
  const history = latestTurns(form, historyCount ?? (warmConversation ? 2 : 8));
  if (promptDietMode !== "stateful-lossless") {
    return history.map((turn) => slimHistoryTurnForAuthor(turn));
  }
  const fullCount = Math.max(0, fullHistoryCount ?? (warmConversation ? 1 : 2));
  const fullStart = Math.max(0, history.length - fullCount);
  return history.map((turn, index) =>
    index >= fullStart
      ? slimHistoryTurnForAuthor(turn, { paragraphMaxChars: recentParagraphMaxChars ?? 700 })
      : stateHistoryTurnForAuthor(turn)
  );
}

function compactActiveLibraryDocs(form, { maxFullDocs = 5, maxBodyChars = 1800 } = {}) {
  const docs = form.readingPacket?.activeLibraryDocs;
  if (!Array.isArray(docs)) {
    return [];
  }
  return docs.filter((doc) => doc?.visibleToLlm !== false).map((doc, index) => ({
    ...doc,
    body: index < maxFullDocs ? compactJsonValue(doc.body, maxBodyChars) : compactJsonValue(doc.body, 420),
    bodyDiet: {
      mode: index < maxFullDocs ? "full-or-digest" : "digest",
      sourceRetainedInDb: true
    }
  }));
}

export function compactLibraryOutline(form, maxItems = 18, { promptDietMode = "legacy-slim" } = {}) {
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
  return scored.slice(0, maxItems).map(({ doc }) => {
    const base = {
      docId: doc.docId,
      versionId: doc.versionId,
      kind: doc.kind,
      title: doc.title,
      status: doc.status,
      scope: doc.scope,
      tags: Array.isArray(doc.tags) ? doc.tags.slice(0, promptDietMode === "stateful-lossless" ? 5 : 8) : [],
      pinned: Boolean(doc.pinned),
      lastUsedTurnIndex: doc.lastUsedTurnIndex ?? null,
      lastTouchedTurnIndex: doc.lastTouchedTurnIndex ?? null
    };
    if (promptDietMode !== "stateful-lossless") {
      base.updatedAt = doc.updatedAt;
    }
    return base;
  });
}

export function authorInstructionForForm(form) {
  const instruction = typeof form.instruction === "string" ? form.instruction : "";
  if (form.readingPacket?.worldTitleStatus === "provisional") {
    return instruction;
  }
  return instruction.replace(
    /readingPacket\.worldTitleStatus가 provisional이고 세계 이름이 아직 덜 잡혔다고 판단되면 첫 1-2턴 안에 StoryTurn\.worldNaming으로 제목 후보를 제안할 수 있습니다\..*?숨은 진실, 미공개 반전, 이후에만 드러날 고유명은 제목 후보에 포함하지 마세요\./,
    "세계 이름은 이미 확정 또는 비임시 상태입니다. StoryTurn.worldNaming을 작성하지 마세요."
  );
}

export function authorPromptForm(
  form,
  {
    warmConversation = false,
    historyCount = null,
    libraryOutlineCount = null,
    promptDietMode = "legacy-slim",
    fullHistoryCount = null,
    recentParagraphMaxChars = null,
    activeLibraryDocFullCount = 5,
    activeLibraryDocBodyChars = 1800
  } = {}
) {
  const originalHistory = Array.isArray(form.readingPacket?.visibleHistory) ? form.readingPacket.visibleHistory : [];
  const visibleHistory = visibleHistoryForAuthor(form, {
    warmConversation,
    historyCount,
    promptDietMode,
    fullHistoryCount,
    recentParagraphMaxChars
  });
  const libraryOutline = compactLibraryOutline(form, libraryOutlineCount ?? 18, { promptDietMode });
  const activeLibraryDocs =
    promptDietMode === "stateful-lossless"
      ? compactActiveLibraryDocs(form, { maxFullDocs: activeLibraryDocFullCount, maxBodyChars: activeLibraryDocBodyChars })
      : form.readingPacket?.activeLibraryDocs;
  return {
    worldId: form.worldId,
    sessionId: form.sessionId,
    responseShape: form.responseShape,
    instruction: authorInstructionForForm(form),
    readingPacket: {
      ...form.readingPacket,
      activeLibraryDocs,
      authorInputTrace:
        promptDietMode === "stateful-lossless" ? summarizeAuthorInputTrace(form.readingPacket?.authorInputTrace) : form.readingPacket?.authorInputTrace,
      visibleHistory,
      libraryOutline,
      promptDiet:
        promptDietMode === "stateful-lossless"
          ? {
              mode: "stateful-lossless-v1",
              contract:
                "원문 턴과 라이브러리 전문은 VNplayer DB에 보존되어 있고, 이 프롬프트에는 다음 턴 결정에 필요한 상태 투영과 cold refs만 포함한다.",
              visibleHistory: {
                sourceTurnsAvailable: originalHistory.length,
                turnsIncluded: visibleHistory.length,
                fullRecentTurns: Math.min(fullHistoryCount ?? (warmConversation ? 1 : 2), visibleHistory.length),
                stateSummaryTurns: Math.max(0, visibleHistory.length - Math.min(fullHistoryCount ?? (warmConversation ? 1 : 2), visibleHistory.length)),
                omittedOlderTurns: Math.max(0, originalHistory.length - visibleHistory.length)
              },
              library: {
                activeDocsIncluded: Array.isArray(activeLibraryDocs) ? activeLibraryDocs.length : 0,
                outlineItemsIncluded: libraryOutline.length,
                sourceRetainedInDb: true
              }
            }
          : undefined
    }
  };
}

export function authorVisibleHistoryCount(form, options = {}) {
  return authorPromptForm(form, options).readingPacket.visibleHistory.length;
}

export function authorLibraryOutlineCount(form, { libraryOutlineCount = null } = {}) {
  return compactLibraryOutline(form, libraryOutlineCount ?? 18).length;
}
