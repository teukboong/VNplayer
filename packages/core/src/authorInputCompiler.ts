import type {
  AuthorInputSnapshot,
  AuthorInputTrace,
  AuthorRuleStack,
  CadencePressure,
  CadenceTransitionHint,
  LibraryDocOutlineItem,
  LibraryDocVersion,
  PlayerAction,
  SessionRecord,
  StoryTurn,
  StoredTurn,
  TurnIntent,
  VisibleContextItem,
  VisibleContextPackage,
  WorldRecord
} from "./types.js";

type CompileAuthorInput = {
  world: WorldRecord;
  session: SessionRecord;
  visibleHistory: StoredTurn[];
  latestPlayerAction: PlayerAction | null;
  activeLibraryDocs: LibraryDocVersion[];
  libraryOutline: LibraryDocOutlineItem[];
  compiledAt?: string;
};

const HISTORY_LIMIT = 8;
const HISTORY_PARAGRAPH_CHAR_LIMIT = 900;
const OUTLINE_LIMIT = 24;
const SIGNIFICANT_TOKEN_MIN_LENGTH = 2;
const STOP_WORDS = new Set([
  "그리고",
  "그러나",
  "하지만",
  "있는",
  "없는",
  "것을",
  "것이",
  "한다",
  "했다",
  "된다",
  "되었다",
  "다시",
  "조금",
  "아직",
  "바로",
  "위해",
  "toward",
  "with",
  "from",
  "into",
  "that",
  "this",
  "the",
  "and"
]);

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clipText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars).trimEnd()}...` : normalized;
}

function projectTurnForAuthor(turn: StoredTurn): StoryTurn {
  const storyTurn = turn.displayShape.turn;
  return {
    scene: {
      speaker: storyTurn.scene.speaker ?? null,
      paragraphs: storyTurn.scene.paragraphs.map((paragraph) => clipText(paragraph, HISTORY_PARAGRAPH_CHAR_LIMIT)).filter(Boolean),
      background: textOrNull(storyTurn.scene.background),
      mood: textOrNull(storyTurn.scene.mood)
    },
    concreteDelta: textOrNull(storyTurn.concreteDelta),
    choices: storyTurn.choices.slice(0, 6).map((choice) => ({
      label: choice.label,
      action: choice.action,
      tag: choice.tag ?? null,
      intent: choice.intent ?? null
    }))
  };
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortKey(value: string | null | undefined): string {
  const normalized = normalizeKey(value);
  return normalized.length > 80 ? normalized.slice(0, 80).trim() : normalized;
}

function countTrailingSame<T>(items: T[], keyOf: (item: T) => string): number {
  if (!items.length) {
    return 0;
  }
  const target = keyOf(items[items.length - 1] as T);
  if (!target) {
    return 0;
  }
  let count = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (keyOf(items[index] as T) !== target) {
      break;
    }
    count += 1;
  }
  return count;
}

function significantTokens(text: string): string[] {
  return normalizeKey(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= SIGNIFICANT_TOKEN_MIN_LENGTH && !STOP_WORDS.has(token))
    .slice(0, 80);
}

function tokenOverlapScore(left: string, right: string): number {
  const leftTokens = new Set(significantTokens(left));
  if (!leftTokens.size) {
    return 0;
  }
  let overlap = 0;
  for (const token of significantTokens(right)) {
    if (leftTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

function surfaceText(turn: StoryTurn): string {
  return [
    turn.concreteDelta ?? "",
    turn.scene.background ?? "",
    turn.scene.mood ?? "",
    ...turn.choices.flatMap((choice) => [choice.label, choice.action, choice.intent ?? ""])
  ].join(" ");
}

function countSurfaceRepeats(turns: StoryTurn[]): number {
  if (turns.length < 2) {
    return 0;
  }
  const latest = surfaceText(turns[turns.length - 1] as StoryTurn);
  if (!latest.trim()) {
    return 0;
  }
  let repeats = 1;
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    const previous = surfaceText(turns[index] as StoryTurn);
    if (tokenOverlapScore(latest, previous) < 3) {
      break;
    }
    repeats += 1;
  }
  return repeats;
}

function openThreadFamily(title: string): string {
  return significantTokens(title).slice(0, 4).join(" ");
}

function duplicateOpenThreadFamilies(outline: LibraryDocOutlineItem[]): string[] {
  const counts = new Map<string, number>();
  for (const item of outline) {
    if (item.kind !== "open_thread" || item.status !== "active") {
      continue;
    }
    const family = openThreadFamily(item.title);
    if (!family) {
      continue;
    }
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([family]) => family)
    .slice(0, 6);
}

function transitionHintFor(input: {
  sameLocationCount: number;
  sameOpponentPressureCount: number;
  sameSurfaceRepeatCount: number;
  unresolvedOpenThreadCount: number;
  duplicateOpenThreadFamilies: string[];
}): CadenceTransitionHint | null {
  if (input.sameLocationCount >= 3 && input.sameOpponentPressureCount >= 2) {
    return "exit_or_boundary_cross";
  }
  if (input.sameLocationCount >= 3) {
    return "exit_or_boundary_cross";
  }
  if (input.sameSurfaceRepeatCount >= 3) {
    return "tool_or_surface_change";
  }
  if (input.duplicateOpenThreadFamilies.length || input.unresolvedOpenThreadCount >= 5) {
    return "new_information";
  }
  if (input.sameLocationCount >= 2 && input.sameSurfaceRepeatCount >= 2) {
    return "opponent_state_change";
  }
  return null;
}

export function analyzeCadencePressure(input: {
  visibleHistory: StoryTurn[];
  latestPlayerAction: PlayerAction | null;
  libraryOutline: LibraryDocOutlineItem[];
}): CadencePressure {
  const recent = input.visibleHistory.slice(-4);
  const sameLocationCount = countTrailingSame(recent, (turn) => shortKey(turn.scene.background));
  const sameOpponentPressureCount = countTrailingSame(recent, (turn) => shortKey(turn.scene.mood));
  const latestActionText = [input.latestPlayerAction?.label ?? "", input.latestPlayerAction?.text ?? ""].join(" ");
  const sameGoalCount = latestActionText.trim()
    ? recent.filter((turn) => tokenOverlapScore(latestActionText, surfaceText(turn)) >= 2).length
    : 0;
  const sameSurfaceRepeatCount = countSurfaceRepeats(recent);
  const unresolvedOpenThreadCount = input.libraryOutline.filter((item) => item.kind === "open_thread" && item.status === "active").length;
  const duplicateFamilies = duplicateOpenThreadFamilies(input.libraryOutline);
  const requiredTransitionHint = transitionHintFor({
    sameLocationCount,
    sameOpponentPressureCount,
    sameSurfaceRepeatCount,
    unresolvedOpenThreadCount,
    duplicateOpenThreadFamilies: duplicateFamilies
  });
  const reasons: string[] = [];
  if (sameLocationCount >= 2) {
    reasons.push(`same_location_${sameLocationCount}`);
  }
  if (sameOpponentPressureCount >= 2) {
    reasons.push(`same_opponent_pressure_${sameOpponentPressureCount}`);
  }
  if (sameGoalCount >= 2) {
    reasons.push(`same_goal_overlap_${sameGoalCount}`);
  }
  if (sameSurfaceRepeatCount >= 2) {
    reasons.push(`same_surface_repeat_${sameSurfaceRepeatCount}`);
  }
  if (unresolvedOpenThreadCount >= 4) {
    reasons.push(`many_open_threads_${unresolvedOpenThreadCount}`);
  }
  if (duplicateFamilies.length) {
    reasons.push("duplicate_open_thread_family");
  }
  const hasPressure = Boolean(requiredTransitionHint || reasons.length >= 2);
  const promptNote = hasPressure
    ? [
        "최근 가시 턴에서 같은 국면 반복 신호가 있습니다.",
        requiredTransitionHint ? `권장 전환 압력: ${requiredTransitionHint}.` : null,
        "이 신호는 서사 결정이 아니라 반복 교착을 줄이기 위한 작성 압력입니다."
      ].filter((line): line is string => Boolean(line)).join(" ")
    : null;
  return {
    hasPressure,
    sameLocationCount,
    sameOpponentPressureCount,
    sameGoalCount,
    sameSurfaceRepeatCount,
    unresolvedOpenThreadCount,
    duplicateOpenThreadFamilies: duplicateFamilies,
    requiredTransitionHint,
    reasons,
    promptNote
  };
}

function docReason(doc: LibraryDocVersion): string {
  if (doc.pinned) {
    return "pinned authored library doc";
  }
  if (doc.lastTouchedTurnIndex !== null && doc.lastTouchedTurnIndex !== undefined) {
    return `recent authored update at turn ${doc.lastTouchedTurnIndex}`;
  }
  if (doc.lastUsedTurnIndex !== null && doc.lastUsedTurnIndex !== undefined) {
    return `recently supplied at turn ${doc.lastUsedTurnIndex}`;
  }
  return "selected visible library doc";
}

function outlineReason(item: LibraryDocOutlineItem): string {
  if (item.pinned) {
    return "pinned outline item";
  }
  if (item.kind === "open_thread" || item.kind === "consequence_note" || item.kind === "encounter_surface") {
    return "recent continuity surface";
  }
  return "available authored library index";
}

function buildRuleStack(input: CompileAuthorInput): AuthorRuleStack {
  const l2 = [
    `world title status: ${input.world.titleStatus}`,
    input.world.titleLocked ? "world title is user-locked" : "world title is not user-locked",
    input.activeLibraryDocs.length ? `${input.activeLibraryDocs.length} authored library docs supplied` : "no authored library doc body supplied"
  ];
  return {
    l1: [
      "backend must not author prose, choices, outcomes, hidden truth, or scene meaning",
      "only visible committed turns and authored library docs may enter the author lane",
      "CG artifacts are display attachments, not canon"
    ],
    l2,
    l3: [
      `${input.visibleHistory.length} visible turns available before clipping`,
      `${input.libraryOutline.length} library outline items available before clipping`
    ],
    l4: [
      input.latestPlayerAction ? `current player action: ${input.latestPlayerAction.kind}` : "no current player action",
      `narrative level: ${input.session.narrativeLevel}`,
      `detail level: ${input.session.detailLevel}`,
      input.session.autoCgEnabled ? "auto CG enabled" : "auto CG disabled"
    ]
  };
}

function traceItems(input: {
  visibleHistory: StoredTurn[];
  activeLibraryDocs: LibraryDocVersion[];
  libraryOutline: LibraryDocOutlineItem[];
  cadencePressure: CadencePressure;
}): VisibleContextItem[] {
  const historyItems = input.visibleHistory.slice(-HISTORY_LIMIT).map((turn) => ({
    kind: "history" as const,
    id: turn.id,
    reason: `recent visible turn #${turn.index}`
  }));
  const docItems = input.activeLibraryDocs.map((doc) => ({
    kind: "library_doc" as const,
    id: doc.id,
    reason: docReason(doc)
  }));
  const outlineItems = input.libraryOutline.slice(0, OUTLINE_LIMIT).map((item) => ({
    kind: "library_outline" as const,
    id: item.versionId,
    reason: outlineReason(item)
  }));
  const cadenceItems = input.cadencePressure.hasPressure
    ? [
        {
          kind: "cadence_pressure" as const,
          id: "cadence_pressure",
          reason: input.cadencePressure.reasons.join(", ") || "required transition pressure"
        }
      ]
    : [];
  return [...historyItems, ...docItems, ...outlineItems, ...cadenceItems];
}

export function compileAuthorInput(input: CompileAuthorInput): AuthorInputSnapshot {
  const clippedHistory = input.visibleHistory.slice(-HISTORY_LIMIT);
  const projectedHistory = clippedHistory.map(projectTurnForAuthor);
  const clippedOutline = input.libraryOutline.slice(0, OUTLINE_LIMIT);
  const cadencePressure = analyzeCadencePressure({
    visibleHistory: projectedHistory,
    latestPlayerAction: input.latestPlayerAction,
    libraryOutline: clippedOutline
  });
  const contextItems = traceItems({
    visibleHistory: clippedHistory,
    activeLibraryDocs: input.activeLibraryDocs,
    libraryOutline: clippedOutline,
    cadencePressure
  });
  const ruleStack = buildRuleStack(input);
  const turnIntent: TurnIntent = {
    latestPlayerAction: input.latestPlayerAction,
    narrativeLevel: input.session.narrativeLevel,
    detailLevel: input.session.detailLevel,
    directObjective: input.latestPlayerAction ? input.latestPlayerAction.text : null
  };
  const visibleContextPackage: VisibleContextPackage = {
    visibleHistory: projectedHistory,
    activeLibraryDocs: input.activeLibraryDocs,
    libraryOutline: clippedOutline,
    cadencePressure,
    traceItems: contextItems
  };
  const trace: AuthorInputTrace = {
    compiledAt: input.compiledAt ?? new Date().toISOString(),
    historyTurnsIncluded: clippedHistory.length,
    historyTurnsOmitted: Math.max(0, input.visibleHistory.length - clippedHistory.length),
    activeLibraryDocsIncluded: input.activeLibraryDocs.length,
    libraryOutlineItemsIncluded: clippedOutline.length,
    contextItems,
    ruleStack
  };
  return {
    turnIntent,
    visibleContextPackage,
    ruleStack,
    trace
  };
}
