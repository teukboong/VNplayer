import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { buildVisibleTurnForm, normalizeCgStylePrompt, normalizeStoryTurn } from "../../../packages/core/src/index.js";
import type {
  CgAssetRecord,
  CgReferenceBoardKind,
  CgReferenceBoardRecord,
  DetailLevel,
  DisplayShape,
  LibraryDocKind,
  LibraryDocMetadata,
  LibraryDocOutlineItem,
  LibraryDocScope,
  LibraryDocStatus,
  LibraryDocVersion,
  NarrativeLevel,
  PlayerAction,
  ReaderState,
  SaveRecord,
  SessionRecord,
  StoredTurn,
  ToolError,
  VisibleTurnForm,
  WebgptDispatchRecord,
  WebgptDispatchStatus,
  WebgptJobLane,
  WebgptJobRecord,
  WebgptJobStatus,
  WorldNamingProposal,
  WorldRecord,
  WorldStartRequest,
  WorldSummary,
  WorldTitleSource,
  WorldTitleStatus
} from "../../../packages/core/src/index.js";

type UnknownRow = Record<string, unknown>;

export class RepositoryError extends Error {
  readonly code: string;
  readonly fieldErrors?: ToolError["fieldErrors"];

  constructor(code: string, message: string, fieldErrors?: ToolError["fieldErrors"]) {
    super(message);
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new RepositoryError("bad_row", `문자열 컬럼이 필요합니다: ${name}`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stableHashPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function boolFromDb(value: unknown): boolean {
  return value === 1 || value === true;
}

function narrativeLevelFromDb(value: unknown): NarrativeLevel {
  const level = Number(value);
  return level === 1 || level === 3 ? level : 2;
}

function detailLevelFromDb(value: unknown): DetailLevel {
  const level = Number(value);
  return level === 1 || level === 3 ? level : 2;
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== "string") {
    throw new RepositoryError("bad_row", `JSON 문자열이 필요합니다: ${label}`);
  }
  return JSON.parse(value) as T;
}

const libraryDocStatuses: LibraryDocStatus[] = ["active", "dormant", "resolved", "superseded"];
const libraryDocScopes: LibraryDocScope[] = ["world", "session", "arc", "scene"];
const ACTIVE_DOC_LIMIT = 12;
const ACTIVE_DOC_TOTAL_CHAR_BUDGET = 12_000;
const ACTIVE_DOC_PER_DOC_CHAR_BUDGET = 2_000;
const CG_VISIBLE_TEXT_CHAR_BUDGET = 1_800;
const CG_REFERENCE_BOARD_PROMPT_CHAR_BUDGET = 260;
const CG_REFERENCE_BOARD_LIMIT = 8;
const CG_AUTO_REFERENCE_BOARD_LIMIT = 4;
const CG_AUTO_REFERENCE_BOARD_KIND_LIMIT = 2;
const WORLD_TITLE_MAX_CHARS = 64;
const WORLD_SUBTITLE_MAX_CHARS = 120;
const CG_VISUAL_TAGS = new Set(["cg", "visual", "image", "image_anchor", "mood", "moodboard", "reference", "style", "look"]);

function normalizeLibraryDocMetadata(value: unknown): LibraryDocMetadata {
  const raw = typeof value === "string" && value.trim() ? parseJson<unknown>(value, "metadataJson") : value;
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const status = typeof record.status === "string" && libraryDocStatuses.includes(record.status as LibraryDocStatus)
    ? (record.status as LibraryDocStatus)
    : "active";
  const scope = typeof record.scope === "string" && libraryDocScopes.includes(record.scope as LibraryDocScope)
    ? (record.scope as LibraryDocScope)
    : "world";
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())).map((tag) => tag.trim())
    : [];
  const metadata: LibraryDocMetadata = { status, scope, tags };
  if (typeof record.supersedesDocVersionId === "string" && record.supersedesDocVersionId.trim()) {
    metadata.supersedesDocVersionId = record.supersedesDocVersionId.trim();
  } else if (record.supersedesDocVersionId === null) {
    metadata.supersedesDocVersionId = null;
  }
  return metadata;
}

function serializedDocCharLength(body: unknown): number {
  return JSON.stringify(body).length;
}

function withinActiveDocBudget(docs: LibraryDocVersion[]): LibraryDocVersion[] {
  const selected: LibraryDocVersion[] = [];
  let totalChars = 0;
  for (const doc of docs) {
    if (selected.length >= ACTIVE_DOC_LIMIT) {
      break;
    }
    const docChars = serializedDocCharLength(doc.body);
    if (docChars > ACTIVE_DOC_PER_DOC_CHAR_BUDGET) {
      continue;
    }
    if (totalChars + docChars > ACTIVE_DOC_TOTAL_CHAR_BUDGET) {
      continue;
    }
    selected.push(doc);
    totalChars += docChars;
  }
  return selected;
}

function normalizeWorldTitle(value: string | null | undefined, fallback = "이름 없는 세계"): string {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return (normalized || fallback).slice(0, WORLD_TITLE_MAX_CHARS);
}

function normalizeWorldSubtitle(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized ? normalized.slice(0, WORLD_SUBTITLE_MAX_CHARS) : null;
}

function initialTitleFromSeed(seedText: string): { title: string; source: WorldTitleSource } {
  const firstLine = seedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return {
    title: normalizeWorldTitle(firstLine, "이름 없는 세계"),
    source: firstLine ? "seed" : "fallback"
  };
}

function worldTitleStatus(value: unknown): WorldTitleStatus {
  return value === "named" || value === "locked" || value === "provisional" ? value : "provisional";
}

function worldTitleSource(value: unknown): WorldTitleSource {
  return value === "fallback" || value === "webgpt" || value === "user" || value === "seed" ? value : "seed";
}

function generateRandomSeed(): string {
  return `seed_${randomUUID().slice(0, 8)}`;
}

function mapWorld(row: UnknownRow): WorldRecord {
  const titleStatus = worldTitleStatus(row.titleStatus);
  return {
    id: requireString(row.id, "id"),
    title: requireString(row.title, "title"),
    titleStatus,
    titleSource: worldTitleSource(row.titleSource),
    titleLocked: boolFromDb(row.titleLocked) || titleStatus === "locked",
    subtitle: nullableString(row.subtitle),
    titleUpdatedAt: nullableString(row.titleUpdatedAt),
    seedText: requireString(row.seedText, "seedText"),
    randomSeedEnabled: boolFromDb(row.randomSeedEnabled),
    randomSeedValue: nullableString(row.randomSeedValue),
    cgStylePrompt: normalizeCgStylePrompt(nullableString(row.cgStylePrompt)),
    createdAt: requireString(row.createdAt, "createdAt"),
    updatedAt: requireString(row.updatedAt, "updatedAt")
  };
}

function mapSession(row: UnknownRow): SessionRecord {
  return {
    id: requireString(row.id, "id"),
    worldId: requireString(row.worldId, "worldId"),
    label: requireString(row.label, "label"),
    activeTurnId: nullableString(row.activeTurnId),
    webgptSessionUrl: nullableString(row.webgptSessionUrl),
    cgWebgptConversationId: nullableString(row.cgWebgptConversationId),
    autoCgEnabled: row.autoCgEnabled === undefined ? true : boolFromDb(row.autoCgEnabled),
    narrativeLevel: narrativeLevelFromDb(row.narrativeLevel),
    detailLevel: detailLevelFromDb(row.detailLevel),
    createdAt: requireString(row.createdAt, "createdAt"),
    updatedAt: requireString(row.updatedAt, "updatedAt")
  };
}

function mapAction(row: UnknownRow): PlayerAction {
  const kind = requireString(row.kind, "kind");
  if (kind !== "choice" && kind !== "freeform") {
    throw new RepositoryError("bad_row", `예상하지 못한 행동 종류입니다: ${kind}`);
  }
  return {
    id: requireString(row.id, "id"),
    worldId: requireString(row.worldId, "worldId"),
    sessionId: requireString(row.sessionId, "sessionId"),
    turnId: requireString(row.turnId, "turnId"),
    kind,
    label: nullableString(row.label),
    text: requireString(row.text, "text"),
    createdAt: requireString(row.createdAt, "createdAt")
  };
}

function mapTurn(row: UnknownRow): StoredTurn {
  return {
    id: requireString(row.id, "id"),
    worldId: requireString(row.worldId, "worldId"),
    sessionId: requireString(row.sessionId, "sessionId"),
    index: Number(row.turnIndex),
    playerActionId: nullableString(row.playerActionId),
    rawSubmissionId: requireString(row.rawSubmissionId, "rawSubmissionId"),
    displayShape: parseJson<DisplayShape>(row.displayShapeJson, "displayShapeJson"),
    createdAt: requireString(row.createdAt, "createdAt")
  };
}

function mapSave(row: UnknownRow): SaveRecord {
  return {
    id: requireString(row.id, "id"),
    worldId: requireString(row.worldId, "worldId"),
    sessionId: requireString(row.sessionId, "sessionId"),
    label: requireString(row.label, "label"),
    turnId: requireString(row.turnId, "turnId"),
    createdAt: requireString(row.createdAt, "createdAt")
  };
}

function mapCgAsset(row: UnknownRow): CgAssetRecord {
  const status = requireString(row.status, "status");
  if (status !== "waiting_reference" && status !== "requested" && status !== "attached" && status !== "failed") {
    throw new RepositoryError("bad_row", `예상하지 못한 CG 상태입니다: ${status}`);
  }
  return {
    id: requireString(row.id, "id"),
    worldId: requireString(row.worldId, "worldId"),
    sessionId: requireString(row.sessionId, "sessionId"),
    turnId: requireString(row.turnId, "turnId"),
    jobId: nullableString(row.jobId),
    status,
    prompt: requireString(row.prompt, "prompt"),
    negativePrompt: nullableString(row.negativePrompt),
    imageUrl: nullableString(row.imageUrl),
    altText: nullableString(row.altText),
    provider: nullableString(row.provider),
    generatedByLane: nullableString(row.generatedByLane) as WebgptJobLane | null,
    errorMessage: nullableString(row.errorMessage),
    createdAt: requireString(row.createdAt, "createdAt"),
    updatedAt: requireString(row.updatedAt, "updatedAt")
  };
}

function asCgReferenceBoardKind(value: string): CgReferenceBoardKind {
  if (value === "world_mood" || value === "character" || value === "location" || value === "object" || value === "negative") {
    return value;
  }
  throw new RepositoryError("bad_row", `예상하지 못한 CG 보드 종류입니다: ${value}`);
}

function mapCgReferenceBoard(row: UnknownRow): CgReferenceBoardRecord {
  const status = requireString(row.status, "status");
  if (status !== "active" && status !== "superseded") {
    throw new RepositoryError("bad_row", `예상하지 못한 CG 보드 상태입니다: ${status}`);
  }
  const createdBy = requireString(row.createdBy, "createdBy");
  if (createdBy !== "user" && createdBy !== "webgpt") {
    throw new RepositoryError("bad_row", `예상하지 못한 CG 보드 작성자입니다: ${createdBy}`);
  }
  return {
    id: requireString(row.id, "id"),
    worldId: requireString(row.worldId, "worldId"),
    sessionId: nullableString(row.sessionId),
    kind: asCgReferenceBoardKind(requireString(row.kind, "kind")),
    title: requireString(row.title, "title"),
    prompt: requireString(row.prompt, "prompt"),
    imageUrl: nullableString(row.imageUrl),
    pinned: boolFromDb(row.pinned),
    status,
    createdBy,
    createdAt: requireString(row.createdAt, "createdAt"),
    updatedAt: requireString(row.updatedAt, "updatedAt")
  };
}

function mapWebgptJob(row: UnknownRow): WebgptJobRecord {
  const status = requireString(row.status, "status");
  if (status !== "waiting_reference" && status !== "queued" && status !== "running" && status !== "succeeded" && status !== "failed") {
    throw new RepositoryError("bad_row", `예상하지 못한 WebGPT job 상태입니다: ${status}`);
  }
  const lane = requireString(row.lane, "lane");
  if (lane !== "main_text" && lane !== "cg_side") {
    throw new RepositoryError("bad_row", `예상하지 못한 WebGPT job lane입니다: ${lane}`);
  }
  const kind = requireString(row.kind, "kind");
  if (kind !== "text_turn" && kind !== "cg_asset" && kind !== "cg_reference_board") {
    throw new RepositoryError("bad_row", `예상하지 못한 WebGPT job 종류입니다: ${kind}`);
  }
  return {
    id: requireString(row.id, "id"),
    worldId: requireString(row.worldId, "worldId"),
    sessionId: requireString(row.sessionId, "sessionId"),
    kind,
    lane,
    status: status as WebgptJobStatus,
    priority: Number(row.priority),
    targetTurnId: nullableString(row.targetTurnId),
    conversationId: nullableString(row.conversationId),
    payload: parseJson<unknown>(row.payloadJson, "payloadJson"),
    result: typeof row.resultJson === "string" ? parseJson<unknown>(row.resultJson, "resultJson") : undefined,
    errorMessage: nullableString(row.errorMessage),
    createdAt: requireString(row.createdAt, "createdAt"),
    startedAt: nullableString(row.startedAt),
    finishedAt: nullableString(row.finishedAt)
  };
}

function mapDocVersion(row: UnknownRow): LibraryDocVersion {
  const metadata = normalizeLibraryDocMetadata(row.metadataJson);
  return {
    id: requireString(row.id, "id"),
    docId: requireString(row.docId, "docId"),
    worldId: requireString(row.worldId, "worldId"),
    kind: requireString(row.kind, "kind") as LibraryDocKind,
    title: requireString(row.title, "title"),
    body: parseJson<unknown>(row.bodyJson, "bodyJson"),
    visibleToLlm: boolFromDb(row.visibleToLlm),
    visibleToPlayer: boolFromDb(row.visibleToPlayer),
    createdBy: requireString(row.createdBy, "createdBy") as "llm" | "user",
    createdAt: requireString(row.createdAt, "createdAt"),
    sourceTurnId: nullableString(row.sourceTurnId),
    updateReason: nullableString(row.updateReason),
    metadata,
    pinned: boolFromDb(row.pinned),
    lastUsedTurnId: nullableString(row.lastUsedTurnId),
    lastUsedTurnIndex: row.lastUsedTurnIndex === null || row.lastUsedTurnIndex === undefined ? null : Number(row.lastUsedTurnIndex),
    lastTouchedTurnId: nullableString(row.lastTouchedTurnId),
    lastTouchedTurnIndex: row.lastTouchedTurnIndex === null || row.lastTouchedTurnIndex === undefined ? null : Number(row.lastTouchedTurnIndex)
  };
}

function outlineItemFromDoc(doc: LibraryDocVersion): LibraryDocOutlineItem {
  return {
    docId: doc.docId,
    versionId: doc.id,
    worldId: doc.worldId,
    kind: doc.kind,
    title: doc.title,
    status: doc.metadata.status,
    scope: doc.metadata.scope,
    tags: doc.metadata.tags,
    visibleToLlm: doc.visibleToLlm,
    visibleToPlayer: doc.visibleToPlayer,
    pinned: Boolean(doc.pinned),
    createdBy: doc.createdBy,
    lastUsedTurnId: doc.lastUsedTurnId ?? null,
    lastUsedTurnIndex: doc.lastUsedTurnIndex ?? null,
    lastTouchedTurnId: doc.lastTouchedTurnId ?? null,
    lastTouchedTurnIndex: doc.lastTouchedTurnIndex ?? null,
    updatedAt: doc.createdAt
  };
}

function mapWebgptDispatch(row: UnknownRow): WebgptDispatchRecord {
  const status = requireString(row.status, "status");
  if (status !== "running" && status !== "succeeded" && status !== "failed") {
    throw new RepositoryError("bad_row", `예상하지 못한 WebGPT 작업 상태입니다: ${status}`);
  }
  return {
    id: requireString(row.id, "id"),
    worldId: requireString(row.worldId, "worldId"),
    sessionId: requireString(row.sessionId, "sessionId"),
    status,
    conversationId: nullableString(row.conversationId),
    payload: parseJson<unknown>(row.payloadJson, "payloadJson"),
    result: typeof row.resultJson === "string" ? parseJson<unknown>(row.resultJson, "resultJson") : undefined,
    errorMessage: nullableString(row.errorMessage),
    createdAt: requireString(row.createdAt, "createdAt")
  };
}

export type CreateTurnInput = {
  worldId: string;
  sessionId: string;
  source: "llm" | "user_import";
  turn: unknown;
};

export type UpsertLibraryDocInput = {
  worldId: string;
  sessionId?: string | null;
  docId?: string;
  kind: LibraryDocKind;
  title: string;
  body: unknown;
  visibleToLlm: boolean;
  visibleToPlayer: boolean;
  createdBy: "llm" | "user";
  sourceTurnId?: string;
  updateReason?: string;
  status?: LibraryDocStatus;
  scope?: LibraryDocScope;
  tags?: string[];
  supersedesDocVersionId?: string | null;
};

export type ListLibraryDocsOptions = {
  sessionId?: string;
  docIds?: string[];
  pinnedOnly?: boolean;
  limit?: number;
};

export type ListLibraryOutlineOptions = {
  sessionId?: string;
  kinds?: LibraryDocKind[];
  status?: LibraryDocStatus[];
  scopes?: LibraryDocScope[];
  tags?: string[];
  pinnedOnly?: boolean;
  visibleToLlmOnly?: boolean;
  updatedAfterTurnIndex?: number;
  usedAfterTurnIndex?: number;
  limit?: number;
};

export type CreateWebgptDispatchInput = {
  id: string;
  worldId: string;
  sessionId: string;
  conversationId?: string | null;
  dispatchTokenHash?: string | null;
  payload: unknown;
};

export type FinishWebgptDispatchInput = {
  id: string;
  status: Extract<WebgptDispatchStatus, "succeeded" | "failed">;
  conversationId?: string | null;
  result?: unknown;
  errorMessage?: string | null;
};

export type PrepareCgAssetInput = {
  worldId: string;
  sessionId: string;
  turnId?: string;
};

export type AttachCgAssetInput = {
  assetId: string;
  worldId: string;
  sessionId: string;
  imageUrl?: string | null;
  altText?: string | null;
  provider?: string | null;
  errorMessage?: string | null;
  conversationId?: string | null;
};

export type ClaimNextCgJobInput = {
  worldId?: string;
  sessionId?: string;
};

export type RetryCgJobInput = {
  worldId: string;
  sessionId?: string | null;
  jobId: string;
};

export type UpdateWorldCgStylePromptInput = {
  worldId: string;
  sessionId?: string;
  cgStylePrompt?: string | null;
};

export type UpdateSessionSettingsInput = {
  worldId: string;
  sessionId: string;
  autoCgEnabled?: boolean;
  narrativeLevel?: NarrativeLevel;
  detailLevel?: DetailLevel;
};

export type UpdateWorldTitleInput = {
  worldId: string;
  sessionId?: string;
  title: string;
  subtitle?: string | null;
  locked?: boolean;
};

export type UpsertCgReferenceBoardInput = {
  worldId: string;
  sessionId?: string | null;
  id?: string | null;
  kind: CgReferenceBoardKind;
  title: string;
  prompt: string;
  imageUrl?: string | null;
  pinned?: boolean;
  status?: "active" | "superseded";
  createdBy?: "user" | "webgpt";
};

export type AttachCgReferenceBoardImageInput = {
  worldId: string;
  boardId: string;
  jobId?: string | null;
  imageUrl?: string | null;
  errorMessage?: string | null;
  conversationId?: string | null;
};

type CgReferenceBoardDraft = {
  kind: CgReferenceBoardKind;
  title: string;
  prompt: string;
};

type CgReferenceReadiness = {
  referenceBoards: CgReferenceBoardRecord[];
  ready: boolean;
  reason?: string;
};

type InitialLibraryDocSeed = {
  docId: string;
  kind: LibraryDocKind;
  title: string;
  body: unknown;
  scope: LibraryDocScope;
  tags: string[];
  visibleToPlayer: boolean;
};

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars).trimEnd()}\n[...]`;
}

function seedSectionLines(seedText: string, labels: string[]): string[] {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const heading = new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:${labelPattern})\\s*[:：]?\\s*$`, "i");
  const nextHeading = /^\s*(?:#{1,6}\s*)?[\p{L}\p{N} _-]{1,32}\s*[:：]\s*$/u;
  const lines = seedText.split(/\r?\n/);
  const collected: string[] = [];
  let active = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (heading.test(trimmed)) {
      active = true;
      continue;
    }
    if (active && trimmed && nextHeading.test(trimmed) && !/^[-*]\s+/.test(trimmed)) {
      break;
    }
    if (active && trimmed) {
      collected.push(trimmed.replace(/^[-*]\s+/, ""));
    }
  }
  return collected.slice(0, 12);
}

function seedInlineHintLines(seedText: string, patterns: RegExp[]): string[] {
  return seedText
    .split(/\r?\n|[,，;；]/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0 && patterns.some((pattern) => pattern.test(line)))
    .slice(0, 12);
}

function initialLibraryDocSeeds(input: {
  worldId: string;
  title: string;
  seedText: string;
  randomSeedEnabled: boolean;
  randomSeedValue: string | null;
  cgStylePrompt: string;
}): InitialLibraryDocSeed[] {
  const seedExcerpt = truncateText(input.seedText, 3_000);
  const base = `${input.worldId}:initial-library`;
  const docs: InitialLibraryDocSeed[] = [
    {
      docId: `doc_seed_${stableHashPart(`${base}:world_note`)}`,
      kind: "world_note",
      title: "세계관 시드",
      scope: "world",
      tags: ["seed", "world", "cg", "visual", "mood", "reference"],
      visibleToPlayer: true,
      body: {
        source: "world_start",
        title: input.title,
        seedText: seedExcerpt,
        randomSeed: input.randomSeedEnabled ? input.randomSeedValue : null,
        authority: "user_seed",
        use: "첫 턴부터 모든 산문, 선택지, 라이브러리 갱신, CG 참조보드의 기본 전제다."
      }
    },
    {
      docId: `doc_seed_${stableHashPart(`${base}:style_guide`)}`,
      kind: "style_guide",
      title: "초기 문체와 CG 기준",
      scope: "world",
      tags: ["style", "cg", "visual", "mood", "reference"],
      visibleToPlayer: false,
      body: {
        source: "world_start",
        narrativeContract: [
          "세계관 시드에 없는 새 진실, 인물, 상징, 미래 사건을 CG나 산문에서 만들지 않는다.",
          "보이는 장면과 이미 커밋된 라이브러리만 다음 턴의 근거로 쓴다.",
          "CG는 이미 작성된 visible turn의 표시 첨부물이며 canon authority가 아니다."
        ],
        cgStylePrompt: normalizeCgStylePrompt(input.cgStylePrompt),
        referenceBoardPolicy: "세계 시작과 함께 만들어지는 pinned CG 참조보드는 첫 장면 이전의 시각 기준을 고정하기 위한 것이다."
      }
    }
  ];

  const explicitCharacterNotes = seedSectionLines(input.seedText, ["characters", "character", "캐릭터", "인물", "등장인물"]);
  const characterNotes = explicitCharacterNotes.length
    ? explicitCharacterNotes
    : seedInlineHintLines(input.seedText, [/주인공/u, /캐릭터/u, /인물/u, /등장인물/u, /protagonist/i, /hero/i, /character/i]);
  if (characterNotes.length) {
    docs.push({
      docId: `doc_seed_${stableHashPart(`${base}:character_card`)}`,
      kind: "character_card",
      title: "시드 인물 카드",
      scope: "world",
      tags: ["seed", "character", "cg", "visual", "reference"],
      visibleToPlayer: true,
      body: {
        source: "world_start",
        notes: characterNotes,
        authority: "user_seed",
        use: "시드에 명시된 인물 외형, 거리감, 관계 단서만 안정화한다. 불명확한 이름이나 숨은 동기는 만들지 않는다."
      }
    });
  }

  const explicitLocationNotes = seedSectionLines(input.seedText, ["locations", "location", "setting", "places", "장소", "배경"]);
  const locationNotes = explicitLocationNotes.length
    ? explicitLocationNotes
    : seedInlineHintLines(input.seedText, [/장소/u, /배경/u, /도시/u, /마을/u, /왕국/u, /학교/u, /location/i, /setting/i, /place/i]);
  if (locationNotes.length) {
    docs.push({
      docId: `doc_seed_${stableHashPart(`${base}:location_card`)}`,
      kind: "location_card",
      title: "시드 장소 카드",
      scope: "world",
      tags: ["seed", "location", "cg", "visual", "reference"],
      visibleToPlayer: true,
      body: {
        source: "world_start",
        notes: locationNotes,
        authority: "user_seed",
        use: "시드에 명시된 장소와 표면만 안정화한다. 지도, 숨은 통로, 새 단서는 만들지 않는다."
      }
    });
  }

  return docs;
}

function compileCgPrompt(turn: StoredTurn, world: WorldRecord, referenceBoards: CgReferenceBoardRecord[]): { prompt: string; negativePrompt: string } {
  const storyTurn = turn.displayShape.turn;
  const scene = storyTurn.scene;
  const request = storyTurn.cgRequest;
  const cgStylePrompt = normalizeCgStylePrompt(world.cgStylePrompt);
  const visibleText = truncateText(scene.paragraphs.join("\n\n"), CG_VISIBLE_TEXT_CHAR_BUDGET);
  const visibleLabels = [
    scene.speaker ? `speaker: ${scene.speaker}` : null,
    scene.background ? `background: ${scene.background}` : null,
    scene.mood ? `mood: ${scene.mood}` : null,
    storyTurn.concreteDelta ? `visible delta: ${storyTurn.concreteDelta}` : null,
    request ? `text lane subject: ${request.subject}` : null,
    request?.composition ? `composition: ${request.composition}` : null,
    request?.mood ? `cg mood: ${request.mood}` : null,
    request?.palette?.length ? `palette: ${request.palette.join(", ")}` : null
  ].filter((value): value is string => Boolean(value));
  const prompt = [
    "Generate one CG still for VNplayer from committed visible story text only.",
    "Use this as an illustration attached to the already-written turn, not as new story canon.",
    "Do not add new characters, symbols, clues, text, UI, captions, speech bubbles, maps, documents with readable writing, or future events unless they are visibly present below.",
    request
      ? "The text lane authored the following CG request. Treat it as visual selection, not canon expansion."
      : "No text-lane cgRequest was supplied; use the committed visible text as the only source.",
    "World CG style prompt:",
    cgStylePrompt,
    "",
    "The world CG style prompt is the whole style layer. If the user changed it, do not mix in any default/easter-egg style.",
    referenceBoards.length
      ? [
          "",
          "Pinned CG reference boards. Use these only for visual consistency; they are not story authority:",
          ...referenceBoards.map((board) =>
            [
              `- ${board.kind}: ${board.title}`,
              board.imageUrl ? `  prompt: ${truncateText(board.prompt, CG_REFERENCE_BOARD_PROMPT_CHAR_BUDGET).replace(/\n/g, " ")}` : null,
              board.imageUrl ? `  imageUrl: ${board.imageUrl}` : null
            ].filter((line): line is string => Boolean(line)).join("\n")
          )
        ].join("\n")
      : null,
    "",
    `Turn index: ${turn.index}`,
    visibleLabels.length ? `Visible labels:\n${visibleLabels.map((label) => `- ${label}`).join("\n")}` : "Visible labels: none",
    request
      ? [
          "",
          "CG request:",
          `subject: ${request.subject}`,
          `visibleAnchors: ${request.visibleAnchors.join("; ")}`,
          request.avoid?.length ? `avoid: ${request.avoid.join("; ")}` : null
        ].filter((line): line is string => Boolean(line)).join("\n")
      : null,
    "",
    "Committed visible text:",
    visibleText
  ].filter((line): line is string => line !== null).join("\n");
  return {
    prompt,
    negativePrompt: [
      "new canon",
      "future scene",
      "hidden truth",
      "readable text",
      "captions",
      "UI",
      "speech bubbles",
      "extra characters",
      "fanservice",
      "childlike style",
      ...(request?.avoid ?? [])
    ].join(", ")
  };
}

function cgPriorityValue(priority: unknown): number {
  if (priority === "high") {
    return 20;
  }
  if (priority === "low") {
    return 80;
  }
  return 50;
}

function cgVisibleExcerpt(turn: StoredTurn) {
  const storyTurn = turn.displayShape.turn;
  return {
    paragraphs: storyTurn.scene.paragraphs.slice(-4),
    speaker: storyTurn.scene.speaker,
    background: storyTurn.scene.background,
    mood: storyTurn.scene.mood,
    concreteDelta: storyTurn.concreteDelta ?? null
  };
}

function normalizeWebgptConversationId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    const match = parsed.pathname.match(/\/c\/([^/]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : trimmed;
  } catch {
    return trimmed;
  }
}

export function createRepository(db: DatabaseSync) {
  function getWorld(worldId: string): WorldRecord {
    const row = db
      .prepare(
        `SELECT id, title, title_status AS titleStatus, title_source AS titleSource,
                title_locked AS titleLocked, subtitle, title_updated_at AS titleUpdatedAt,
                seed_text AS seedText, random_seed_enabled AS randomSeedEnabled,
                random_seed_value AS randomSeedValue, cg_style_prompt AS cgStylePrompt,
                created_at AS createdAt, updated_at AS updatedAt
           FROM worlds WHERE id = ?`
      )
      .get(worldId) as UnknownRow | undefined;
    if (!row) {
      throw new RepositoryError("world_not_found", `세계를 찾을 수 없습니다: ${worldId}`);
    }
    return mapWorld(row);
  }

  function getSession(sessionId: string): SessionRecord {
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, label, webgpt_session_url AS webgptSessionUrl,
                cg_webgpt_conversation_id AS cgWebgptConversationId,
                auto_cg_enabled AS autoCgEnabled, narrative_level AS narrativeLevel,
                detail_level AS detailLevel,
                created_at AS createdAt, updated_at AS updatedAt, active_turn_id AS activeTurnId
           FROM sessions WHERE id = ?`
      )
      .get(sessionId) as UnknownRow | undefined;
    if (!row) {
      throw new RepositoryError("session_not_found", `세션을 찾을 수 없습니다: ${sessionId}`);
    }
    return mapSession(row);
  }

  function latestSessionIdForWorld(worldId: string): string {
    const row = db
      .prepare(`SELECT id FROM sessions WHERE world_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(worldId) as UnknownRow | undefined;
    if (!row) {
      throw new RepositoryError("session_not_found", `세계의 세션을 찾을 수 없습니다: ${worldId}`);
    }
    return requireString(row.id, "id");
  }

  function latestCgJobConversationId(worldId: string, sessionId: string): string | null {
    const row = db
      .prepare(
        `SELECT conversation_id AS conversationId
           FROM webgpt_jobs
          WHERE world_id = ?
            AND session_id = ?
            AND lane = 'cg_side'
            AND conversation_id IS NOT NULL
            AND conversation_id != ''
          ORDER BY COALESCE(finished_at, started_at, created_at) DESC
          LIMIT 1`
      )
      .get(worldId, sessionId) as UnknownRow | undefined;
    return normalizeWebgptConversationId(nullableString(row?.conversationId));
  }

  function pinCgConversationId(worldId: string, sessionId: string, conversationId: string | null | undefined, updatedAt = nowIso()): string | null {
    const normalized = normalizeWebgptConversationId(conversationId);
    if (!normalized) {
      return null;
    }
    const session = getSession(sessionId);
    if (session.worldId !== worldId) {
      throw new RepositoryError("session_world_mismatch", `세션 ${sessionId}은 세계 ${worldId}에 속하지 않습니다.`);
    }
    if (session.cgWebgptConversationId === normalized) {
      return normalized;
    }
    db.prepare(`UPDATE sessions SET cg_webgpt_conversation_id = ?, updated_at = ? WHERE id = ?`).run(
      normalized,
      updatedAt,
      sessionId
    );
    db.prepare(`UPDATE worlds SET updated_at = ? WHERE id = ?`).run(updatedAt, worldId);
    return normalized;
  }

  function cgConversationIdForSession(worldId: string, sessionId: string, options: { pinFallback?: boolean } = {}): string | null {
    const session = getSession(sessionId);
    if (session.worldId !== worldId) {
      throw new RepositoryError("session_world_mismatch", `세션 ${sessionId}은 세계 ${worldId}에 속하지 않습니다.`);
    }
    const pinned = normalizeWebgptConversationId(session.cgWebgptConversationId);
    if (pinned) {
      return pinned;
    }
    const latestJobConversationId = latestCgJobConversationId(worldId, sessionId);
    if (latestJobConversationId && options.pinFallback) {
      return pinCgConversationId(worldId, sessionId, latestJobConversationId);
    }
    return latestJobConversationId;
  }

  function latestCgSessionUrl(worldId: string, sessionId: string): string | null {
    const conversationId = cgConversationIdForSession(worldId, sessionId);
    return conversationId ? `https://chatgpt.com/c/${conversationId}` : null;
  }

  function getTurn(turnId: string): StoredTurn {
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, turn_index AS turnIndex,
                player_action_id AS playerActionId, raw_submission_id AS rawSubmissionId,
                display_shape_json AS displayShapeJson, created_at AS createdAt
           FROM turns WHERE id = ?`
      )
      .get(turnId) as UnknownRow | undefined;
    if (!row) {
      throw new RepositoryError("turn_not_found", `턴을 찾을 수 없습니다: ${turnId}`);
    }
    return mapTurn(row);
  }

  function getCurrentTurn(session: SessionRecord): StoredTurn | null {
    if (!session.activeTurnId) {
      return null;
    }
    return getTurn(session.activeTurnId);
  }

  function getCgAssetForTurn(turnId: string): CgAssetRecord | null {
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, turn_id AS turnId,
                job_id AS jobId, status, prompt, negative_prompt AS negativePrompt,
                image_url AS imageUrl, alt_text AS altText, provider,
                generated_by_lane AS generatedByLane, error_message AS errorMessage,
                created_at AS createdAt, updated_at AS updatedAt
           FROM cg_assets
          WHERE turn_id = ?
          LIMIT 1`
      )
      .get(turnId) as UnknownRow | undefined;
    return row ? mapCgAsset(row) : null;
  }

  function getBackgroundCgAsset(worldId: string, sessionId: string, currentTurn: StoredTurn | null): CgAssetRecord | null {
    if (!currentTurn) {
      return null;
    }
    const row = db
      .prepare(
        `SELECT a.id, a.world_id AS worldId, a.session_id AS sessionId, a.turn_id AS turnId,
                a.job_id AS jobId, a.status, a.prompt, a.negative_prompt AS negativePrompt,
                a.image_url AS imageUrl, a.alt_text AS altText, a.provider,
                a.generated_by_lane AS generatedByLane, a.error_message AS errorMessage,
                a.created_at AS createdAt, a.updated_at AS updatedAt
           FROM cg_assets a
           JOIN turns t ON t.id = a.turn_id
          WHERE a.world_id = ?
            AND a.session_id = ?
            AND a.status = 'attached'
            AND a.image_url IS NOT NULL
            AND a.image_url != ''
            AND t.turn_index <= ?
          ORDER BY t.turn_index DESC, a.updated_at DESC
          LIMIT 1`
      )
      .get(worldId, sessionId, currentTurn.index) as UnknownRow | undefined;
    return row ? mapCgAsset(row) : null;
  }

  function getWebgptJob(jobId: string): WebgptJobRecord {
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, kind, lane, status,
                priority, target_turn_id AS targetTurnId, conversation_id AS conversationId,
                payload_json AS payloadJson, result_json AS resultJson, error_message AS errorMessage,
                created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt
           FROM webgpt_jobs
          WHERE id = ?`
      )
      .get(jobId) as UnknownRow | undefined;
    if (!row) {
      throw new RepositoryError("webgpt_job_not_found", `WebGPT job을 찾을 수 없습니다: ${jobId}`);
    }
    return mapWebgptJob(row);
  }

  function listCgReferenceBoards(
    worldId: string,
    options: { sessionId?: string | null; pinnedOnly?: boolean; activeOnly?: boolean; limit?: number } = {}
  ): CgReferenceBoardRecord[] {
    getWorld(worldId);
    const filters = ["world_id = ?"];
    const params: Array<string | number> = [worldId];
    if (options.sessionId !== undefined) {
      if (options.sessionId) {
        const session = getSession(options.sessionId);
        if (session.worldId !== worldId) {
          throw new RepositoryError("session_world_mismatch", `세션 ${options.sessionId}은 세계 ${worldId}에 속하지 않습니다.`);
        }
        filters.push("(session_id IS NULL OR session_id = ?)");
        params.push(options.sessionId);
      } else {
        filters.push("session_id IS NULL");
      }
    }
    if (options.pinnedOnly) {
      filters.push("pinned = 1");
    }
    if (options.activeOnly !== false) {
      filters.push("status = 'active'");
    }
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const rows = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, kind, title, prompt, image_url AS imageUrl,
                pinned, status, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
           FROM cg_reference_boards
          WHERE ${filters.join(" AND ")}
          ORDER BY pinned DESC, updated_at DESC
          LIMIT ?`
      )
      .all(...params, limit) as UnknownRow[];
    return rows.map(mapCgReferenceBoard);
  }

  function getCgReferenceBoard(worldId: string, boardId: string): CgReferenceBoardRecord {
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, kind, title, prompt, image_url AS imageUrl,
                pinned, status, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
           FROM cg_reference_boards
          WHERE world_id = ? AND id = ?`
      )
      .get(worldId, boardId) as UnknownRow | undefined;
    if (!row) {
      throw new RepositoryError("cg_reference_board_not_found", `CG reference board를 찾을 수 없습니다: ${boardId}`);
    }
    return mapCgReferenceBoard(row);
  }

  function hasOpenCgReferenceBoardJob(worldId: string, boardId: string): boolean {
    const rows = db
      .prepare(
        `SELECT payload_json AS payloadJson
           FROM webgpt_jobs
          WHERE world_id = ?
            AND kind = 'cg_reference_board'
            AND lane = 'cg_side'
            AND status IN ('queued', 'running')`
      )
      .all(worldId) as UnknownRow[];
    return rows.some((row) => {
      const payload = parseJson<Record<string, unknown>>(row.payloadJson, "payloadJson");
      return payload.boardId === boardId;
    });
  }

  function enqueueCgReferenceBoardJob(board: CgReferenceBoardRecord, createdAt: string): WebgptJobRecord | null {
    if (board.imageUrl || board.status !== "active" || hasOpenCgReferenceBoardJob(board.worldId, board.id)) {
      return null;
    }
    const sessionId = board.sessionId ?? latestSessionIdForWorld(board.worldId);
    const jobId = `job_${randomUUID()}`;
    const prompt = [
      "Generate one CG reference board image for VNplayer.",
      "This is a visual consistency board, not a story scene and not canon.",
      "Do not add readable text, future events, hidden lore, new characters, or new symbols.",
      `Board kind: ${board.kind}`,
      `Board title: ${board.title}`,
      "",
      "Board prompt:",
      board.prompt
    ].join("\n");
    const payload = {
      boardId: board.id,
      worldId: board.worldId,
      sessionId,
      kind: board.kind,
      title: board.title,
      prompt,
      boardPrompt: board.prompt,
      styleContract: {
        purpose: "cg_reference_board",
        canonAuthority: false,
        textPromptInput: false
      }
    };
    db.prepare(
      `INSERT INTO webgpt_jobs
        (id, world_id, session_id, kind, lane, status, priority, target_turn_id,
         conversation_id, payload_json, result_json, error_message, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, NULL, NULL)`
    ).run(jobId, board.worldId, sessionId, "cg_reference_board", "cg_side", "queued", 40, JSON.stringify(payload), createdAt);
    return getWebgptJob(jobId);
  }

  function upsertCgReferenceBoard(input: UpsertCgReferenceBoardInput): CgReferenceBoardRecord {
    getWorld(input.worldId);
    const sessionId = input.sessionId?.trim() || null;
    if (sessionId) {
      const session = getSession(sessionId);
      if (session.worldId !== input.worldId) {
        throw new RepositoryError("session_world_mismatch", `세션 ${sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
      }
    }
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    if (!title) {
      throw new RepositoryError("invalid_cg_reference_board", "CG 보드 제목이 필요합니다.", [{ path: "title", message: "제목이 필요합니다." }]);
    }
    if (!prompt) {
      throw new RepositoryError("invalid_cg_reference_board", "CG 보드 프롬프트가 필요합니다.", [{ path: "prompt", message: "프롬프트가 필요합니다." }]);
    }
    const id = input.id?.trim() || `cgboard_${randomUUID()}`;
    const now = nowIso();
    db.prepare(
      `INSERT INTO cg_reference_boards
        (id, world_id, session_id, kind, title, prompt, image_url, pinned, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = COALESCE(excluded.session_id, cg_reference_boards.session_id),
         kind = excluded.kind,
         title = excluded.title,
         prompt = excluded.prompt,
         image_url = COALESCE(excluded.image_url, cg_reference_boards.image_url),
         pinned = excluded.pinned,
         status = excluded.status,
         updated_at = excluded.updated_at`
    ).run(
      id,
      input.worldId,
      sessionId,
      input.kind,
      title,
      prompt,
      input.imageUrl?.trim() || null,
      input.pinned === false ? 0 : 1,
      input.status ?? "active",
      input.createdBy ?? "user",
      now,
      now
    );
    const board = getCgReferenceBoard(input.worldId, id);
    enqueueCgReferenceBoardJob(board, now);
    if (board.imageUrl) {
      releaseWaitingCgAssetJobs(input.worldId, board.sessionId, now);
    }
    return board;
  }

  function attachCgReferenceBoardImage(input: AttachCgReferenceBoardImageInput): CgReferenceBoardRecord {
    const board = getCgReferenceBoard(input.worldId, input.boardId);
    const hasImage = Boolean(input.imageUrl?.trim());
    const updatedAt = nowIso();
    const conversationId = normalizeWebgptConversationId(input.conversationId);
    let jobSessionId: string | null = null;
    if (hasImage) {
      db.prepare(`UPDATE cg_reference_boards SET image_url = ?, updated_at = ? WHERE id = ? AND world_id = ?`).run(
        input.imageUrl?.trim() || null,
        updatedAt,
        input.boardId,
        input.worldId
      );
    }
    const jobId = input.jobId?.trim();
    if (jobId) {
      const job = getWebgptJob(jobId);
      if (job.worldId !== input.worldId || job.kind !== "cg_reference_board" || job.lane !== "cg_side") {
        throw new RepositoryError("invalid_cg_job", `CG reference board job이 아닙니다: ${jobId}`);
      }
      jobSessionId = job.sessionId;
      db.prepare(
        `UPDATE webgpt_jobs
            SET status = ?, conversation_id = COALESCE(?, conversation_id),
                result_json = ?, error_message = ?, finished_at = ?
          WHERE id = ? AND kind = 'cg_reference_board'`
      ).run(
        hasImage ? "succeeded" : "failed",
        conversationId,
        JSON.stringify({ boardId: board.id, imageUrl: input.imageUrl ?? null }),
        hasImage ? null : input.errorMessage?.trim() || "WebGPT CG reference board 이미지가 첨부되지 않았습니다.",
        updatedAt,
        jobId
      );
    }
    const sessionIdForPin = jobSessionId ?? board.sessionId ?? null;
    if (sessionIdForPin && conversationId) {
      pinCgConversationId(input.worldId, sessionIdForPin, conversationId, updatedAt);
    }
    if (hasImage) {
      releaseWaitingCgAssetJobs(input.worldId, board.sessionId, updatedAt);
    }
    return getCgReferenceBoard(input.worldId, input.boardId);
  }

  function cgReferenceReadiness(worldId: string, sessionId: string): CgReferenceReadiness {
    const referenceBoards = listCgReferenceBoards(worldId, { sessionId, pinnedOnly: true, limit: CG_REFERENCE_BOARD_LIMIT });
    // Reference boards are optional visual enhancers. Their text prompts are
    // useful immediately, and board images can arrive later without blocking
    // a turn CG that is already anchored in committed visible text.
    return { referenceBoards, ready: true };
  }

  function cgBoardKindForLibraryDoc(kind: LibraryDocKind, options: { visualTagged: boolean; cgRelevant: boolean }): CgReferenceBoardKind | null {
    switch (kind) {
      case "character_card":
      case "faction_card":
        return "character";
      case "location_card":
        return "location";
      case "item_card":
        return "object";
      case "encounter_surface":
      case "motif_note":
        return options.visualTagged || options.cgRelevant ? "object" : null;
      case "world_note":
      case "world_rule":
      case "system_law":
      case "style_guide":
        return options.visualTagged ? "world_mood" : null;
      default:
        return null;
    }
  }

  function hasCgVisualTag(tags: string[]): boolean {
    return tags.some((tag) => CG_VISUAL_TAGS.has(tag.trim().toLowerCase()));
  }

  function textIncludesAny(text: string, values: string[]): boolean {
    const normalizedText = text.toLowerCase();
    return values.some((value) => {
      const normalized = value.trim().toLowerCase();
      return normalized.length >= 3 && normalizedText.includes(normalized);
    });
  }

  function libraryDocLooksCgRelevant(doc: { title: string; body: unknown; cgRequest?: DisplayShape["turn"]["cgRequest"] | null }): boolean {
    const request = doc.cgRequest;
    if (!request?.shouldGenerate) {
      return false;
    }
    const anchors = [
      request.subject,
      request.composition,
      request.mood,
      ...(request.visibleAnchors ?? [])
    ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    if (!anchors.length) {
      return false;
    }
    return textIncludesAny(`${doc.title}\n${JSON.stringify(doc.body)}`, anchors);
  }

  function cgReferenceBoardLibraryId(input: { worldId: string; sessionId?: string | null; kind: CgReferenceBoardKind; title: string }): string {
    return `cgboard_lib_${stableHashPart(`${input.worldId}:${input.sessionId ?? "world"}:${input.kind}:${input.title}`)}`;
  }

  function compileCgReferenceBoardDraft(doc: {
    kind: LibraryDocKind;
    title: string;
    body: unknown;
    tags?: string[];
    updateReason?: string | null;
    cgRequest?: DisplayShape["turn"]["cgRequest"] | null;
  }): CgReferenceBoardDraft | null {
    const visualTagged = hasCgVisualTag(doc.tags ?? []);
    const cgRelevant = libraryDocLooksCgRelevant(doc);
    const kind = cgBoardKindForLibraryDoc(doc.kind, { visualTagged, cgRelevant });
    if (!kind) {
      return null;
    }
    const serializedBody = truncateText(JSON.stringify(doc.body, null, 2), 1_400);
    const tags = doc.tags?.length ? doc.tags.join(", ") : "none";
    const prompt = [
      "Create a visual consistency reference board from this committed VNplayer text library doc.",
      "Use only already-authored visible/canonical text in the doc below.",
      "Do not introduce new lore, hidden truth, future reveals, new characters, new symbols, readable text, UI, maps, or documents.",
      "This board stabilizes look only; it is not story authority.",
      "",
      `Library doc kind: ${doc.kind}`,
      `Library doc title: ${doc.title}`,
      `Library tags: ${tags}`,
      doc.updateReason ? `Update reason: ${doc.updateReason}` : null,
      "",
      "Library doc body:",
      serializedBody
    ].filter((line): line is string => typeof line === "string").join("\n");
    return {
      kind,
      title: `${doc.title} 참조`,
      prompt
    };
  }

  function upsertCgReferenceBoardFromLibraryDoc(input: {
    worldId: string;
    sessionId?: string | null;
    docId: string;
    kind: LibraryDocKind;
    title: string;
    body: unknown;
    tags: string[];
    updateReason?: string | null;
    cgRequest?: DisplayShape["turn"]["cgRequest"] | null;
  }): CgReferenceBoardRecord | null {
    const draft = compileCgReferenceBoardDraft(input);
    if (!draft) {
      return null;
    }
    const boardId = cgReferenceBoardLibraryId({
      worldId: input.worldId,
      sessionId: input.sessionId ?? null,
      kind: draft.kind,
      title: input.title
    });
    const existing = db
      .prepare(`SELECT id FROM cg_reference_boards WHERE id = ?`)
      .get(boardId) as UnknownRow | undefined;
    if (!existing) {
      const sessionFilter = input.sessionId ? "session_id = ?" : "session_id IS NULL";
      const sessionParams = input.sessionId ? [input.sessionId] : [];
      const total = Number((db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM cg_reference_boards
            WHERE world_id = ?
              AND ${sessionFilter}
              AND created_by = 'webgpt'
              AND status = 'active'`
        )
        .get(input.worldId, ...sessionParams) as UnknownRow).count ?? 0);
      const byKind = Number((db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM cg_reference_boards
            WHERE world_id = ?
              AND ${sessionFilter}
              AND kind = ?
              AND created_by = 'webgpt'
              AND status = 'active'`
        )
        .get(input.worldId, ...sessionParams, draft.kind) as UnknownRow).count ?? 0);
      if (total >= CG_AUTO_REFERENCE_BOARD_LIMIT || byKind >= CG_AUTO_REFERENCE_BOARD_KIND_LIMIT) {
        return null;
      }
    }
    return upsertCgReferenceBoard({
      worldId: input.worldId,
      sessionId: input.sessionId ?? null,
      id: boardId,
      kind: draft.kind,
      title: draft.title,
      prompt: draft.prompt,
      imageUrl: null,
      pinned: true,
      status: "active",
      createdBy: "webgpt"
    });
  }

  function cgJobPayload(
    turn: StoredTurn,
    assetId: string,
    world: WorldRecord,
    referenceBoards: CgReferenceBoardRecord[],
    prompt: string,
    negativePrompt: string
  ): Record<string, unknown> {
    const request = turn.displayShape.turn.cgRequest;
    return {
      assetId,
      worldId: turn.worldId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      turnIndex: turn.index,
      cgRequest: request ?? null,
      visibleExcerpt: cgVisibleExcerpt(turn),
      prompt,
      negativePrompt,
      cgStylePrompt: world.cgStylePrompt,
      referenceBoards: referenceBoards.map((board) => ({
        id: board.id,
        kind: board.kind,
        title: board.title,
        prompt: board.prompt,
        imageUrl: board.imageUrl ?? null
      })),
      styleContract: {
        purpose: "display_attachment",
        canonAuthority: false,
        textPromptInput: false
      }
    };
  }

  function enqueueCgJob(
    turn: StoredTurn,
    assetId: string,
    createdAt: string,
    world: WorldRecord,
    referenceBoards: CgReferenceBoardRecord[],
    prompt: string,
    negativePrompt: string,
    status: "waiting_reference" | "queued"
  ): WebgptJobRecord {
    const request = turn.displayShape.turn.cgRequest;
    const jobId = `job_${randomUUID()}`;
    const payload = cgJobPayload(turn, assetId, world, referenceBoards, prompt, negativePrompt);
    db.prepare(
      `INSERT INTO webgpt_jobs
        (id, world_id, session_id, kind, lane, status, priority, target_turn_id,
         conversation_id, payload_json, result_json, error_message, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, NULL)`
    ).run(
      jobId,
      turn.worldId,
      turn.sessionId,
      "cg_asset",
      "cg_side",
      status,
      cgPriorityValue(request?.priority),
      turn.id,
      JSON.stringify(payload),
      createdAt
    );
    return getWebgptJob(jobId);
  }

  function requeueStaleRunningCgJobs(): void {
    const staleMs = Math.max(60_000, Number(process.env.VNPLAYER_WEBGPT_CG_RUNNING_STALE_MS ?? "900000"));
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    db.prepare(
      `UPDATE webgpt_jobs
          SET status = 'queued',
              started_at = NULL,
              finished_at = NULL,
              error_message = COALESCE(error_message, 'stale running CG job requeued')
        WHERE lane = 'cg_side'
          AND status = 'running'
          AND started_at IS NOT NULL
          AND started_at < ?`
    ).run(cutoff);
  }

  function claimNextCgJob(input: ClaimNextCgJobInput = {}): WebgptJobRecord | null {
    requeueStaleRunningCgJobs();
    const filters: string[] = ["j.kind IN ('cg_asset', 'cg_reference_board')", "j.lane = 'cg_side'", "j.status = 'queued'"];
    const params: string[] = [];
    if (input.worldId) {
      filters.push("j.world_id = ?");
      params.push(input.worldId);
    }
    if (input.sessionId) {
      filters.push("j.session_id = ?");
      params.push(input.sessionId);
    }
    const orderBy = input.worldId || input.sessionId
      ? "CASE j.kind WHEN 'cg_asset' THEN 0 ELSE 1 END ASC, j.priority ASC, j.created_at ASC"
      : "COALESCE(s.updated_at, w.updated_at, j.created_at) DESC, CASE j.kind WHEN 'cg_asset' THEN 0 ELSE 1 END ASC, j.priority ASC, j.created_at ASC";
    const row = db
      .prepare(
        `SELECT j.id, j.world_id AS worldId, j.session_id AS sessionId, j.kind, j.lane, j.status,
                j.priority, j.target_turn_id AS targetTurnId, j.conversation_id AS conversationId,
                j.payload_json AS payloadJson, j.result_json AS resultJson, j.error_message AS errorMessage,
                j.created_at AS createdAt, j.started_at AS startedAt, j.finished_at AS finishedAt
           FROM webgpt_jobs j
           LEFT JOIN sessions s ON s.id = j.session_id
           LEFT JOIN worlds w ON w.id = j.world_id
          WHERE ${filters.join(" AND ")}
          ORDER BY ${orderBy}
          LIMIT 1`
      )
      .get(...params) as UnknownRow | undefined;
    if (!row) {
      return null;
    }
    const job = mapWebgptJob(row);
    const startedAt = nowIso();
    const conversationId =
      normalizeWebgptConversationId(job.conversationId) ?? cgConversationIdForSession(job.worldId, job.sessionId, { pinFallback: true });
    db.prepare(`UPDATE webgpt_jobs SET status = 'running', conversation_id = COALESCE(?, conversation_id), started_at = ? WHERE id = ? AND status = 'queued'`).run(
      conversationId,
      startedAt,
      job.id
    );
    return getWebgptJob(job.id);
  }

  function retryCgJob(input: RetryCgJobInput): WebgptJobRecord {
    const job = getWebgptJob(input.jobId);
    if (job.worldId !== input.worldId) {
      throw new RepositoryError("webgpt_job_world_mismatch", `CG job ${input.jobId}은 세계 ${input.worldId}에 속하지 않습니다.`);
    }
    if (input.sessionId && job.sessionId !== input.sessionId) {
      throw new RepositoryError("webgpt_job_session_mismatch", `CG job ${input.jobId}은 세션 ${input.sessionId}에 속하지 않습니다.`);
    }
    if (job.lane !== "cg_side" || (job.kind !== "cg_asset" && job.kind !== "cg_reference_board")) {
      throw new RepositoryError("invalid_cg_job", `CG side job이 아닙니다: ${input.jobId}`);
    }
    if (job.status !== "failed") {
      throw new RepositoryError("cg_job_not_failed", `실패한 CG job만 재시도할 수 있습니다: ${input.jobId}`);
    }
    const payload = typeof job.payload === "object" && job.payload !== null ? (job.payload as Record<string, unknown>) : {};
    const updatedAt = nowIso();
    if (job.kind === "cg_asset" && typeof payload.assetId === "string") {
      db.prepare(
        `UPDATE cg_assets
            SET status = 'requested', error_message = NULL, updated_at = ?
          WHERE id = ? AND world_id = ?`
      ).run(updatedAt, payload.assetId, input.worldId);
    }
    db.prepare(
      `UPDATE webgpt_jobs
          SET status = 'queued', result_json = NULL, error_message = NULL,
              started_at = NULL, finished_at = NULL
        WHERE id = ?`
    ).run(input.jobId);
    return getWebgptJob(input.jobId);
  }

  function releaseWaitingCgAssetJobs(worldId: string, sessionId: string | null | undefined, updatedAt: string): void {
    if (!sessionId) {
      return;
    }
    const readiness = cgReferenceReadiness(worldId, sessionId);
    if (!readiness.ready) {
      return;
    }
    const rows = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, turn_id AS turnId,
                job_id AS jobId, status, prompt, negative_prompt AS negativePrompt,
                image_url AS imageUrl, alt_text AS altText, provider,
                generated_by_lane AS generatedByLane, error_message AS errorMessage,
                created_at AS createdAt, updated_at AS updatedAt
           FROM cg_assets
          WHERE world_id = ?
            AND session_id = ?
            AND status = 'waiting_reference'`
      )
      .all(worldId, sessionId) as UnknownRow[];
    const world = getWorld(worldId);
    for (const row of rows) {
      const asset = mapCgAsset(row);
      if (!asset.jobId) {
        continue;
      }
      const turn = getTurn(asset.turnId);
      const { prompt, negativePrompt } = compileCgPrompt(turn, world, readiness.referenceBoards);
      const payload = cgJobPayload(turn, asset.id, world, readiness.referenceBoards, prompt, negativePrompt);
      db.prepare(
        `UPDATE webgpt_jobs
            SET status = 'queued', payload_json = ?, error_message = NULL,
                started_at = NULL, finished_at = NULL
          WHERE id = ?
            AND status = 'waiting_reference'`
      ).run(JSON.stringify(payload), asset.jobId);
      db.prepare(
        `UPDATE cg_assets
            SET status = 'requested', prompt = ?, negative_prompt = ?,
                error_message = NULL, updated_at = ?
          WHERE id = ?
            AND status = 'waiting_reference'`
      ).run(prompt, negativePrompt, updatedAt, asset.id);
    }
  }

  function prepareCgAssetForTurn(input: PrepareCgAssetInput): CgAssetRecord {
    const session = getSession(input.sessionId);
    if (session.worldId !== input.worldId) {
      throw new RepositoryError("session_world_mismatch", `세션 ${input.sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
    }
    const turn = input.turnId ? getTurn(input.turnId) : getCurrentTurn(session);
    if (!turn) {
      throw new RepositoryError("no_active_turn", "CG를 준비할 커밋된 턴이 없습니다.");
    }
    if (turn.worldId !== input.worldId || turn.sessionId !== input.sessionId) {
      throw new RepositoryError("turn_session_mismatch", "CG 요청 턴이 현재 세계/세션에 속하지 않습니다.");
    }
    const existing = getCgAssetForTurn(turn.id);
    if (existing) {
      if (existing.status === "waiting_reference" && existing.jobId) {
        const world = getWorld(input.worldId);
        const readiness = cgReferenceReadiness(world.id, input.sessionId);
        const { prompt, negativePrompt } = compileCgPrompt(turn, world, readiness.referenceBoards);
        const payload = cgJobPayload(turn, existing.id, world, readiness.referenceBoards, prompt, negativePrompt);
        const updatedAt = nowIso();
        db.prepare(
          `UPDATE webgpt_jobs
              SET status = 'queued', payload_json = ?, error_message = NULL,
                  started_at = NULL, finished_at = NULL
            WHERE id = ?
              AND status = 'waiting_reference'`
        ).run(JSON.stringify(payload), existing.jobId);
        db.prepare(
          `UPDATE cg_assets
              SET status = 'requested', prompt = ?, negative_prompt = ?,
                  error_message = NULL, updated_at = ?
            WHERE id = ?
              AND status = 'waiting_reference'`
        ).run(prompt, negativePrompt, updatedAt, existing.id);
        return getCgAssetForTurn(turn.id) ?? existing;
      }
      return existing;
    }
    const world = getWorld(input.worldId);
    const readiness = cgReferenceReadiness(world.id, input.sessionId);
    const { prompt, negativePrompt } = compileCgPrompt(turn, world, readiness.referenceBoards);
    const createdAt = nowIso();
    const id = `cg_${randomUUID()}`;
    const jobStatus = readiness.ready ? "queued" : "waiting_reference";
    const assetStatus = readiness.ready ? "requested" : "waiting_reference";
    const errorMessage = readiness.ready ? null : readiness.reason ?? "CG 참조보드 준비 대기 중입니다.";
    const job = enqueueCgJob(turn, id, createdAt, world, readiness.referenceBoards, prompt, negativePrompt, jobStatus);
    db.prepare(
      `INSERT INTO cg_assets
        (id, world_id, session_id, turn_id, job_id, status, prompt, negative_prompt,
         image_url, alt_text, provider, generated_by_lane, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`
    ).run(id, input.worldId, input.sessionId, turn.id, job.id, assetStatus, prompt, negativePrompt, "webgpt", "cg_side", errorMessage, createdAt, createdAt);
    return getCgAssetForTurn(turn.id) ?? {
      id,
      worldId: input.worldId,
      sessionId: input.sessionId,
      turnId: turn.id,
      jobId: job.id,
      status: assetStatus,
      prompt,
      negativePrompt,
      provider: "webgpt",
      generatedByLane: "cg_side",
      errorMessage,
      createdAt,
      updatedAt: createdAt
    };
  }

  function attachCgAsset(input: AttachCgAssetInput): CgAssetRecord {
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, turn_id AS turnId,
                job_id AS jobId, status, prompt, negative_prompt AS negativePrompt,
                image_url AS imageUrl, alt_text AS altText, provider,
                generated_by_lane AS generatedByLane, error_message AS errorMessage,
                created_at AS createdAt, updated_at AS updatedAt
           FROM cg_assets
          WHERE id = ?`
      )
      .get(input.assetId) as UnknownRow | undefined;
    if (!row) {
      throw new RepositoryError("cg_asset_not_found", `CG 요청을 찾을 수 없습니다: ${input.assetId}`);
    }
    const asset = mapCgAsset(row);
    if (asset.worldId !== input.worldId || asset.sessionId !== input.sessionId) {
      throw new RepositoryError("cg_asset_session_mismatch", "CG 요청이 현재 세계/세션에 속하지 않습니다.");
    }
    const hasImage = Boolean(input.imageUrl?.trim());
    const updatedAt = nowIso();
    const conversationId = normalizeWebgptConversationId(input.conversationId);
    db.prepare(
      `UPDATE cg_assets
          SET status = ?, image_url = ?, alt_text = ?, provider = ?, error_message = ?, updated_at = ?
        WHERE id = ?`
    ).run(
      hasImage ? "attached" : "failed",
      input.imageUrl?.trim() || null,
      input.altText?.trim() || null,
      input.provider?.trim() || asset.provider || "webgpt",
      hasImage ? null : input.errorMessage?.trim() || "WebGPT CG 결과 이미지가 첨부되지 않았습니다.",
      updatedAt,
      input.assetId
    );
    if (asset.jobId) {
      db.prepare(
        `UPDATE webgpt_jobs
            SET status = ?, conversation_id = COALESCE(?, conversation_id),
                result_json = ?, error_message = ?, finished_at = ?
          WHERE id = ? AND status != 'succeeded'`
      ).run(
        hasImage ? "succeeded" : "failed",
        conversationId,
        JSON.stringify({ assetId: asset.id, imageUrl: input.imageUrl ?? null, altText: input.altText ?? null }),
        hasImage ? null : input.errorMessage?.trim() || "WebGPT CG 결과 이미지가 첨부되지 않았습니다.",
        updatedAt,
        asset.jobId
      );
    }
    if (conversationId) {
      pinCgConversationId(input.worldId, input.sessionId, conversationId, updatedAt);
    }
    const updated = getCgAssetForTurn(asset.turnId);
    if (!updated) {
      throw new RepositoryError("cg_asset_not_found", `CG 요청을 찾을 수 없습니다: ${input.assetId}`);
    }
    return updated;
  }

  function listVisibleTurns(session: SessionRecord): StoredTurn[] {
    const currentTurn = getCurrentTurn(session);
    const rows = currentTurn
      ? db
          .prepare(
            `SELECT id, world_id AS worldId, session_id AS sessionId, turn_index AS turnIndex,
                    player_action_id AS playerActionId, raw_submission_id AS rawSubmissionId,
                    display_shape_json AS displayShapeJson, created_at AS createdAt
               FROM turns
              WHERE session_id = ? AND turn_index <= ?
              ORDER BY turn_index ASC`
          )
          .all(session.id, currentTurn.index)
      : db
          .prepare(
            `SELECT id, world_id AS worldId, session_id AS sessionId, turn_index AS turnIndex,
                    player_action_id AS playerActionId, raw_submission_id AS rawSubmissionId,
                    display_shape_json AS displayShapeJson, created_at AS createdAt
               FROM turns
              WHERE session_id = ?
              ORDER BY turn_index ASC`
          )
          .all(session.id);
    return (rows as UnknownRow[]).map(mapTurn);
  }

  function getLatestPlayerAction(session: SessionRecord): PlayerAction | null {
    if (!session.activeTurnId) {
      return null;
    }
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, turn_id AS turnId,
                kind, label, text, created_at AS createdAt
           FROM player_actions
          WHERE session_id = ? AND turn_id = ?
          ORDER BY created_at DESC
          LIMIT 1`
      )
      .get(session.id, session.activeTurnId) as UnknownRow | undefined;
    return row ? mapAction(row) : null;
  }

  function listLibraryDocs(worldId: string, options: ListLibraryDocsOptions = {}): LibraryDocVersion[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
    const docIds = options.docIds?.filter(Boolean);
    const docFilter = docIds?.length ? `AND v.doc_id IN (${docIds.map(() => "?").join(", ")})` : "";
    const sessionId = options.sessionId ?? "";
    const pinnedOnlyFilter = options.pinnedOnly ? "AND (p_session.doc_id IS NOT NULL OR p_world.doc_id IS NOT NULL)" : "";
    const rows = db
      .prepare(
        `SELECT v.id, v.doc_id AS docId, v.world_id AS worldId, v.kind, v.title,
                v.body_json AS bodyJson, v.visible_to_llm AS visibleToLlm,
                v.visible_to_player AS visibleToPlayer, v.created_by AS createdBy,
                v.created_at AS createdAt, v.source_turn_id AS sourceTurnId,
                v.update_reason AS updateReason, v.metadata_json AS metadataJson,
                CASE WHEN p_session.doc_id IS NULL AND p_world.doc_id IS NULL THEN 0 ELSE 1 END AS pinned,
                COALESCE(u_session.last_used_turn_id, u_world.last_used_turn_id) AS lastUsedTurnId,
                COALESCE(u_session.last_used_turn_index, u_world.last_used_turn_index) AS lastUsedTurnIndex,
                COALESCE(u_session.last_touched_turn_id, u_world.last_touched_turn_id) AS lastTouchedTurnId,
                COALESCE(u_session.last_touched_turn_index, u_world.last_touched_turn_index) AS lastTouchedTurnIndex
           FROM library_doc_versions v
           JOIN (
             SELECT doc_id, MAX(created_at) AS latest_created_at
               FROM library_doc_versions
              WHERE world_id = ?
              GROUP BY doc_id
           ) latest ON latest.doc_id = v.doc_id AND latest.latest_created_at = v.created_at
           LEFT JOIN library_doc_pins p_session
             ON p_session.world_id = v.world_id
            AND p_session.doc_id = v.doc_id
            AND p_session.session_id = ?
           LEFT JOIN library_doc_pins p_world
             ON p_world.world_id = v.world_id
            AND p_world.doc_id = v.doc_id
            AND p_world.session_id IS NULL
           LEFT JOIN library_doc_usage u_session
             ON u_session.world_id = v.world_id
            AND u_session.doc_id = v.doc_id
            AND u_session.session_id = ?
           LEFT JOIN library_doc_usage u_world
             ON u_world.world_id = v.world_id
            AND u_world.doc_id = v.doc_id
            AND u_world.session_id IS NULL
          WHERE v.world_id = ?
            ${docFilter}
            ${pinnedOnlyFilter}
          ORDER BY pinned DESC, COALESCE(u_session.last_used_turn_index, u_world.last_used_turn_index, -1) DESC, v.created_at DESC
          LIMIT ?`
      )
      .all(worldId, sessionId, sessionId, worldId, ...(docIds ?? []), limit) as UnknownRow[];
    return rows.map(mapDocVersion);
  }

  function listLibraryOutline(worldId: string, options: ListLibraryOutlineOptions = {}): LibraryDocOutlineItem[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const queryOptions: ListLibraryDocsOptions = {
      limit: 100
    };
    if (options.sessionId) {
      queryOptions.sessionId = options.sessionId;
    }
    if (options.pinnedOnly) {
      queryOptions.pinnedOnly = true;
    }
    return listLibraryDocs(worldId, queryOptions)
      .filter((doc) => {
        if (options.visibleToLlmOnly && !doc.visibleToLlm) {
          return false;
        }
        if (options.kinds?.length && !options.kinds.includes(doc.kind)) {
          return false;
        }
        if (options.status?.length && !options.status.includes(doc.metadata.status)) {
          return false;
        }
        if (options.scopes?.length && !options.scopes.includes(doc.metadata.scope)) {
          return false;
        }
        if (options.tags?.length && !options.tags.some((tag) => doc.metadata.tags.includes(tag))) {
          return false;
        }
        if (
          options.usedAfterTurnIndex !== undefined &&
          (doc.lastUsedTurnIndex === null || doc.lastUsedTurnIndex === undefined || doc.lastUsedTurnIndex <= options.usedAfterTurnIndex)
        ) {
          return false;
        }
        if (
          options.updatedAfterTurnIndex !== undefined &&
          (doc.lastTouchedTurnIndex === null ||
            doc.lastTouchedTurnIndex === undefined ||
            doc.lastTouchedTurnIndex <= options.updatedAfterTurnIndex)
        ) {
          return false;
        }
        return true;
      })
      .slice(0, limit)
      .map(outlineItemFromDoc);
  }

  function activeLibraryDocsForTurn(worldId: string, sessionId?: string): LibraryDocVersion[] {
    const pinnedOptions: { sessionId?: string; pinnedOnly: boolean } = { pinnedOnly: true };
    const recentOptions: { sessionId?: string } = {};
    if (sessionId) {
      pinnedOptions.sessionId = sessionId;
      recentOptions.sessionId = sessionId;
    }
    const pinnedDocs = withinActiveDocBudget(listLibraryDocs(worldId, pinnedOptions).filter((doc) => doc.visibleToLlm));
    if (pinnedDocs.length) {
      return pinnedDocs;
    }
    return withinActiveDocBudget(
      listLibraryDocs(worldId, { ...recentOptions, limit: ACTIVE_DOC_LIMIT * 2 }).filter(
        (doc) => doc.visibleToLlm && doc.metadata.status === "active"
      )
    );
  }

  function linkLibraryDocsToTurn(turn: StoredTurn, docs: LibraryDocVersion[], createdAt: string): void {
    for (const doc of docs) {
      db.prepare(
        `INSERT OR IGNORE INTO turn_doc_links (turn_id, doc_version_id, reason, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(turn.id, doc.id, doc.pinned ? "pinned" : "recent_update", createdAt);
      db.prepare(
        `INSERT INTO library_doc_usage
          (world_id, session_id, doc_id, last_used_turn_id, last_used_turn_index,
           last_touched_turn_id, last_touched_turn_index, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(world_id, session_id, doc_id) DO UPDATE SET
           last_used_turn_id = excluded.last_used_turn_id,
           last_used_turn_index = excluded.last_used_turn_index,
           updated_at = excluded.updated_at`
      ).run(doc.worldId, turn.sessionId, doc.docId, turn.id, turn.index, doc.lastTouchedTurnId ?? null, doc.lastTouchedTurnIndex ?? null, createdAt);
    }
  }

  function insertTurnLibraryUpdates(turn: StoredTurn, createdAt: string): void {
    for (const update of turn.displayShape.turn.libraryUpdates ?? []) {
      const docId = `doc_${randomUUID()}`;
      const versionId = `docver_${randomUUID()}`;
      const metadata = normalizeLibraryDocMetadata({
        status: update.status ?? "active",
        scope: update.scope ?? "scene",
        tags: update.tags ?? []
      });
      db.prepare(`INSERT INTO library_docs (id, world_id, kind, title, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        docId,
        turn.worldId,
        update.kind,
        update.title,
        createdAt
      );
      db.prepare(
        `INSERT INTO library_doc_versions
          (id, doc_id, world_id, kind, title, body_json, visible_to_llm, visible_to_player,
           created_by, created_at, source_turn_id, update_reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        versionId,
        docId,
        turn.worldId,
        update.kind,
        update.title,
        JSON.stringify(update.body),
        update.visibleToLlm === false ? 0 : 1,
        update.visibleToPlayer === false ? 0 : 1,
        "llm",
        createdAt,
        turn.id,
        update.updateReason ?? "turn_library_update",
        JSON.stringify(metadata)
      );
      db.prepare(
        `INSERT INTO library_doc_usage
          (world_id, session_id, doc_id, last_used_turn_id, last_used_turn_index,
           last_touched_turn_id, last_touched_turn_index, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(world_id, session_id, doc_id) DO UPDATE SET
           last_touched_turn_id = excluded.last_touched_turn_id,
           last_touched_turn_index = excluded.last_touched_turn_index,
           updated_at = excluded.updated_at`
      ).run(turn.worldId, turn.sessionId, docId, turn.id, turn.index, createdAt);
      upsertCgReferenceBoardFromLibraryDoc({
        worldId: turn.worldId,
        sessionId: turn.sessionId,
        docId,
        kind: update.kind,
        title: update.title,
        body: update.body,
        tags: metadata.tags,
        updateReason: update.updateReason ?? "turn_library_update",
        cgRequest: turn.displayShape.turn.cgRequest ?? null
      });
    }
  }

  function listSaves(worldId: string, sessionId: string): SaveRecord[] {
    const rows = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, label, turn_id AS turnId, created_at AS createdAt
           FROM saves
          WHERE world_id = ? AND session_id = ?
          ORDER BY created_at DESC`
      )
      .all(worldId, sessionId) as UnknownRow[];
    return rows.map(mapSave);
  }

  function latestWebgptDispatch(worldId: string, sessionId: string): WebgptDispatchRecord | null {
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, status,
                conversation_id AS conversationId, payload_json AS payloadJson,
                result_json AS resultJson, error_message AS errorMessage,
                created_at AS createdAt
           FROM webgpt_dispatches
          WHERE world_id = ? AND session_id = ?
          ORDER BY created_at DESC
          LIMIT 1`
      )
      .get(worldId, sessionId) as UnknownRow | undefined;
    return row ? mapWebgptDispatch(row) : null;
  }

  function activeWebgptDispatch(worldId: string, sessionId: string): WebgptDispatchRecord | null {
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, status,
                conversation_id AS conversationId, payload_json AS payloadJson,
                result_json AS resultJson, error_message AS errorMessage,
                created_at AS createdAt
           FROM webgpt_dispatches
          WHERE world_id = ? AND session_id = ? AND status = 'running'
          ORDER BY created_at DESC
          LIMIT 1`
      )
      .get(worldId, sessionId) as UnknownRow | undefined;
    return row ? mapWebgptDispatch(row) : null;
  }

  function getForm(worldId: string, sessionId: string): VisibleTurnForm {
    const state = getReaderState(worldId, sessionId);
    return state.form;
  }

  function updateSessionSettings(input: UpdateSessionSettingsInput): SessionRecord {
    const session = getSession(input.sessionId);
    if (session.worldId !== input.worldId) {
      throw new RepositoryError("session_world_mismatch", `세션 ${input.sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
    }
    const autoCgEnabled = input.autoCgEnabled ?? session.autoCgEnabled;
    const narrativeLevel = input.narrativeLevel ?? session.narrativeLevel;
    const detailLevel = input.detailLevel ?? session.detailLevel;
    const updatedAt = nowIso();
    db.prepare(
      `UPDATE sessions
          SET auto_cg_enabled = ?, narrative_level = ?, detail_level = ?, updated_at = ?
        WHERE id = ?`
    ).run(autoCgEnabled ? 1 : 0, narrativeLevel, detailLevel, updatedAt, input.sessionId);
    db.prepare(`UPDATE worlds SET updated_at = ? WHERE id = ?`).run(updatedAt, input.worldId);
    return getSession(input.sessionId);
  }

  function updateWorldCgStylePrompt(input: UpdateWorldCgStylePromptInput): WorldRecord {
    const world = getWorld(input.worldId);
    if (input.sessionId) {
      const session = getSession(input.sessionId);
      if (session.worldId !== world.id) {
        throw new RepositoryError("session_world_mismatch", `세션 ${input.sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
      }
    }
    const cgStylePrompt = normalizeCgStylePrompt(input.cgStylePrompt);
    const updatedAt = nowIso();
    db.prepare(`UPDATE worlds SET cg_style_prompt = ?, updated_at = ? WHERE id = ?`).run(cgStylePrompt, updatedAt, input.worldId);
    return getWorld(input.worldId);
  }

  function updateWorldTitle(input: UpdateWorldTitleInput): WorldRecord {
    const world = getWorld(input.worldId);
    if (input.sessionId) {
      const session = getSession(input.sessionId);
      if (session.worldId !== world.id) {
        throw new RepositoryError("session_world_mismatch", `세션 ${input.sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
      }
    }
    const title = normalizeWorldTitle(input.title, "");
    if (!title) {
      throw new RepositoryError("invalid_world_title", "세계 이름이 필요합니다.", [{ path: "title", message: "세계 이름이 필요합니다." }]);
    }
    const locked = input.locked ?? true;
    const updatedAt = nowIso();
    db.prepare(
      `UPDATE worlds
          SET title = ?, subtitle = ?, title_status = ?, title_source = 'user',
              title_locked = ?, title_updated_at = ?, updated_at = ?
        WHERE id = ?`
    ).run(
      title,
      normalizeWorldSubtitle(input.subtitle),
      locked ? "locked" : "named",
      locked ? 1 : 0,
      updatedAt,
      updatedAt,
      input.worldId
    );
    return getWorld(input.worldId);
  }

  function recordWorldNamingProposal(input: {
    worldId: string;
    sessionId: string;
    turnId: string;
    turnIndex: number;
    proposal: WorldNamingProposal;
    createdAt: string;
  }): void {
    const candidate = normalizeWorldTitle(input.proposal.candidate, "");
    if (!candidate) {
      return;
    }
    const world = getWorld(input.worldId);
    const subtitle = normalizeWorldSubtitle(input.proposal.subtitle);
    let status = "proposed";
    if (world.titleLocked) {
      status = "ignored_locked";
    } else if (world.titleStatus !== "provisional") {
      status = "ignored_named";
    } else if (input.turnIndex > 2) {
      status = "proposed_late";
    } else {
      status = "applied";
      db.prepare(
        `UPDATE worlds
            SET title = ?, subtitle = ?, title_status = 'named', title_source = 'webgpt',
                title_locked = 0, title_updated_at = ?, updated_at = ?
          WHERE id = ?`
      ).run(candidate, subtitle, input.createdAt, input.createdAt, input.worldId);
    }
    db.prepare(
      `INSERT INTO world_title_proposals
        (id, world_id, session_id, turn_id, candidate, subtitle, reason, confidence, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `title_${randomUUID()}`,
      input.worldId,
      input.sessionId,
      input.turnId,
      candidate,
      subtitle,
      input.proposal.reason?.trim() || null,
      input.proposal.confidence ?? null,
      status,
      input.createdAt
    );
  }

  function insertInitialLibraryDocs(input: {
    worldId: string;
    title: string;
    seedText: string;
    randomSeedEnabled: boolean;
    randomSeedValue: string | null;
    cgStylePrompt: string;
    createdAt: string;
  }): void {
    for (const doc of initialLibraryDocSeeds(input)) {
      const versionId = `docver_${randomUUID()}`;
      const metadata = normalizeLibraryDocMetadata({
        status: "active",
        scope: doc.scope,
        tags: doc.tags
      });
      db.prepare(`INSERT INTO library_docs (id, world_id, kind, title, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        doc.docId,
        input.worldId,
        doc.kind,
        doc.title,
        input.createdAt
      );
      db.prepare(
        `INSERT INTO library_doc_versions
          (id, doc_id, world_id, kind, title, body_json, visible_to_llm, visible_to_player,
           created_by, created_at, source_turn_id, update_reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      ).run(
        versionId,
        doc.docId,
        input.worldId,
        doc.kind,
        doc.title,
        JSON.stringify(doc.body),
        1,
        doc.visibleToPlayer ? 1 : 0,
        "user",
        input.createdAt,
        "world_start_seed",
        JSON.stringify(metadata)
      );
      db.prepare(
        `INSERT INTO library_doc_usage
          (world_id, session_id, doc_id, last_used_turn_id, last_used_turn_index,
           last_touched_turn_id, last_touched_turn_index, updated_at)
         VALUES (?, NULL, ?, NULL, NULL, NULL, NULL, ?)`
      ).run(input.worldId, doc.docId, input.createdAt);
      db.prepare(
        `INSERT INTO library_doc_pins
          (world_id, session_id, doc_id, created_by, created_at)
         VALUES (?, NULL, ?, ?, ?)`
      ).run(input.worldId, doc.docId, "user", input.createdAt);
      upsertCgReferenceBoardFromLibraryDoc({
        worldId: input.worldId,
        sessionId: null,
        docId: doc.docId,
        kind: doc.kind,
        title: doc.title,
        body: doc.body,
        tags: metadata.tags,
        updateReason: "world_start_seed"
      });
    }
  }

  function getReaderState(worldId: string, sessionId: string): ReaderState {
    let world = getWorld(worldId);
    let session = getSession(sessionId);
    if (session.worldId !== world.id) {
      throw new RepositoryError("session_world_mismatch", `세션 ${sessionId}은 세계 ${worldId}에 속하지 않습니다.`);
    }
    const accessedAt = nowIso();
    db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(accessedAt, sessionId);
    db.prepare(`UPDATE worlds SET updated_at = ? WHERE id = ?`).run(accessedAt, worldId);
    world = { ...world, updatedAt: accessedAt };
    session = { ...session, updatedAt: accessedAt };
    const visibleHistory = listVisibleTurns(session);
    const currentTurn = getCurrentTurn(session);
    const currentCgAsset = currentTurn ? getCgAssetForTurn(currentTurn.id) : null;
    const backgroundCgAsset = getBackgroundCgAsset(worldId, sessionId, currentTurn);
    const activeLibraryDocs = activeLibraryDocsForTurn(worldId, sessionId);
    const libraryOutline = listLibraryOutline(worldId, { sessionId });
    const latestPlayerAction = getLatestPlayerAction(session);
    const saves = listSaves(worldId, sessionId);
    const activeDispatch = activeWebgptDispatch(worldId, sessionId);
    const cgReferenceBoards = listCgReferenceBoards(worldId, { sessionId, activeOnly: true, limit: 50 });
    return {
      world,
      session,
      currentTurn,
      currentCgAsset,
      backgroundCgAsset,
      cgSessionUrl: latestCgSessionUrl(worldId, sessionId),
      cgReferenceBoards,
      visibleHistory,
      latestPlayerAction,
      activeLibraryDocs,
      libraryOutline,
      saves,
      activeWebgptDispatch: activeDispatch,
      latestWebgptDispatch: activeDispatch ?? latestWebgptDispatch(worldId, sessionId),
      form: buildVisibleTurnForm({
        world,
        session,
        visibleHistory,
        latestPlayerAction,
        activeLibraryDocs,
        libraryOutline
      })
    };
  }

  function createWorld(input: WorldStartRequest): { worldId: string; sessionId: string } {
    const seedText = input.seedText.trim();
    if (!seedText) {
      throw new RepositoryError("invalid_world_seed", "세계관 시드 텍스트가 필요합니다.", [
        { path: "seedText", message: "세계관 시드 텍스트가 필요합니다." }
      ]);
    }

    const id = `world_${randomUUID()}`;
    const sessionId = `session_${randomUUID()}`;
    const createdAt = nowIso();
    const randomSeedValue = input.randomSeedEnabled ? input.randomSeedValue?.trim() || generateRandomSeed() : null;
    const cgStylePrompt = normalizeCgStylePrompt(input.cgStylePrompt);
    const explicitTitle = normalizeWorldTitle(input.title, "");
    const seedTitle = initialTitleFromSeed(seedText);
    const worldTitle = explicitTitle || seedTitle.title;
    const titleStatus: WorldTitleStatus = explicitTitle ? "locked" : "provisional";
    const titleSource: WorldTitleSource = explicitTitle ? "user" : seedTitle.source;
    const titleLocked = explicitTitle ? 1 : 0;
    const titleUpdatedAt = explicitTitle ? createdAt : null;

    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO worlds
          (id, title, title_status, title_source, title_locked, subtitle, title_updated_at,
           seed_text, random_seed_enabled, random_seed_value, cg_style_prompt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        worldTitle,
        titleStatus,
        titleSource,
        titleLocked,
        titleUpdatedAt,
        seedText,
        input.randomSeedEnabled ? 1 : 0,
        randomSeedValue,
        cgStylePrompt,
        createdAt,
        createdAt
      );
      db.prepare(
        `INSERT INTO sessions
          (id, world_id, label, webgpt_session_url, cg_webgpt_conversation_id, auto_cg_enabled, narrative_level, detail_level, created_at, updated_at, active_turn_id)
         VALUES (?, ?, ?, NULL, NULL, 1, 2, 2, ?, ?, NULL)`
      ).run(sessionId, id, "메인 세션", createdAt, createdAt);
      insertInitialLibraryDocs({
        worldId: id,
        title: worldTitle,
        seedText,
        randomSeedEnabled: input.randomSeedEnabled,
        randomSeedValue,
        cgStylePrompt,
        createdAt
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return { worldId: id, sessionId };
  }

  function listWorlds(): WorldSummary[] {
    const rows = db
      .prepare(
        `SELECT w.id AS worldId, w.title, w.title_status AS titleStatus,
                w.title_source AS titleSource, w.title_locked AS titleLocked,
                w.subtitle, w.seed_text AS seedText, w.updated_at AS updatedAt,
                s.id AS latestSessionId, s.active_turn_id AS latestTurnId,
                s.webgpt_session_url AS webgptSessionUrl
           FROM worlds w
           LEFT JOIN sessions s ON s.id = (
             SELECT id FROM sessions WHERE world_id = w.id ORDER BY updated_at DESC LIMIT 1
           )
          ORDER BY w.updated_at DESC`
      )
      .all() as UnknownRow[];

    return rows.map((row) => {
      const seedText = requireString(row.seedText, "seedText");
      return {
        worldId: requireString(row.worldId, "worldId"),
        title: requireString(row.title, "title"),
        titleStatus: worldTitleStatus(row.titleStatus),
        titleSource: worldTitleSource(row.titleSource),
        titleLocked: boolFromDb(row.titleLocked) || row.titleStatus === "locked",
        subtitle: nullableString(row.subtitle),
        seedPreview: seedText.replace(/\s+/g, " ").slice(0, 120),
        latestSessionId: nullableString(row.latestSessionId),
        latestTurnId: nullableString(row.latestTurnId),
        updatedAt: requireString(row.updatedAt, "updatedAt"),
        hasWebgptSessionUrl: Boolean(nullableString(row.webgptSessionUrl))
      };
    });
  }

  function recordPlayerAction(input: {
    worldId: string;
    sessionId: string;
    turnId: string;
    kind: "choice" | "freeform";
    label?: string | null;
    text: string;
  }): { playerActionId: string } {
    const text = input.text.trim();
    if (!text) {
      throw new RepositoryError("empty_player_action", "선택 또는 자유 행동 텍스트가 필요합니다.", [
        { path: "text", message: "선택 또는 자유 행동 텍스트가 필요합니다." }
      ]);
    }
    const session = getSession(input.sessionId);
    if (session.worldId !== input.worldId) {
      throw new RepositoryError("session_world_mismatch", `세션 ${input.sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
    }
    const currentTurn = getCurrentTurn(session);
    if (!currentTurn || currentTurn.id !== input.turnId) {
      throw new RepositoryError("turn_not_current", "선택은 현재 열린 턴에만 기록할 수 있습니다.");
    }

    const playerActionId = `action_${randomUUID()}`;
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO player_actions
        (id, world_id, session_id, turn_id, kind, label, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      playerActionId,
      input.worldId,
      input.sessionId,
      input.turnId,
      input.kind,
      input.label?.trim() || null,
      text,
      createdAt
    );
    return { playerActionId };
  }

  function submitTurn(input: CreateTurnInput): { turnId: string; warnings: DisplayShape["warnings"] } {
    const session = getSession(input.sessionId);
    if (session.worldId !== input.worldId) {
      throw new RepositoryError("session_world_mismatch", `세션 ${input.sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
    }

    const normalized = normalizeStoryTurn(input.turn);
    const rawSubmissionId = `raw_${randomUUID()}`;
    const turnId = `turn_${randomUUID()}`;
    const receivedAt = nowIso();
    const latestPlayerAction = getLatestPlayerAction(session);
    const suppliedLibraryDocs = activeLibraryDocsForTurn(input.worldId, input.sessionId);

    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO raw_submissions
          (id, world_id, session_id, source, payload_json, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(rawSubmissionId, input.worldId, input.sessionId, input.source, JSON.stringify(input.turn), receivedAt);

      if (!normalized.ok) {
        db.exec("COMMIT");
        throw new RepositoryError(normalized.error.code, normalized.error.message, normalized.error.fieldErrors);
      }
      if (latestPlayerAction?.kind === "freeform" && !normalized.displayShape.turn.actionAdjudication) {
        db.exec("COMMIT");
        throw new RepositoryError("action_adjudication_required", "자유행동 턴에는 WebGPT가 actionAdjudication으로 성립 여부를 판정해야 합니다.", [
          {
            path: "turn.actionAdjudication",
            message: "freeform player action requires accepted, partial, or blocked actionAdjudication."
          }
        ]);
      }

      const latestIndexRow = db
        .prepare(`SELECT COALESCE(MAX(turn_index), -1) + 1 AS nextIndex FROM turns WHERE session_id = ?`)
        .get(input.sessionId) as UnknownRow;
      const nextIndex = Number(latestIndexRow.nextIndex);
      const displayShapeJson = JSON.stringify(normalized.displayShape);

      db.prepare(
        `INSERT INTO turns
          (id, world_id, session_id, turn_index, player_action_id, raw_submission_id, display_shape_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        turnId,
        input.worldId,
        input.sessionId,
        nextIndex,
        latestPlayerAction?.id ?? null,
        rawSubmissionId,
        displayShapeJson,
        receivedAt
      );

      for (const warning of normalized.displayShape.warnings) {
        db.prepare(
          `INSERT INTO displayability_warnings
            (id, turn_id, raw_submission_id, code, message, path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `warning_${randomUUID()}`,
          turnId,
          rawSubmissionId,
          warning.code,
          warning.message,
          warning.path ?? null,
          receivedAt
        );
      }

      linkLibraryDocsToTurn(
        {
          id: turnId,
          worldId: input.worldId,
          sessionId: input.sessionId,
          index: nextIndex,
          playerActionId: latestPlayerAction?.id ?? null,
          rawSubmissionId,
          displayShape: normalized.displayShape,
          createdAt: receivedAt
        },
        suppliedLibraryDocs,
        receivedAt
      );
      insertTurnLibraryUpdates(
        {
          id: turnId,
          worldId: input.worldId,
          sessionId: input.sessionId,
          index: nextIndex,
          playerActionId: latestPlayerAction?.id ?? null,
          rawSubmissionId,
          displayShape: normalized.displayShape,
          createdAt: receivedAt
        },
        receivedAt
      );
      if (normalized.displayShape.turn.worldNaming) {
        recordWorldNamingProposal({
          worldId: input.worldId,
          sessionId: input.sessionId,
          turnId,
          turnIndex: nextIndex,
          proposal: normalized.displayShape.turn.worldNaming,
          createdAt: receivedAt
        });
      }
      if (session.autoCgEnabled && normalized.displayShape.turn.cgRequest?.shouldGenerate) {
        prepareCgAssetForTurn({
          worldId: input.worldId,
          sessionId: input.sessionId,
          turnId
        });
      }

      db.prepare(`UPDATE sessions SET active_turn_id = ?, updated_at = ? WHERE id = ?`).run(turnId, receivedAt, input.sessionId);
      db.prepare(`UPDATE worlds SET updated_at = ? WHERE id = ?`).run(receivedAt, input.worldId);
      db.exec("COMMIT");
      return { turnId, warnings: normalized.displayShape.warnings };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // A validation error commits the raw submission before throwing.
      }
      throw error;
    }
  }

  function createSave(input: { worldId: string; sessionId: string; label: string }): { saveId: string } {
    const session = getSession(input.sessionId);
    if (session.worldId !== input.worldId) {
      throw new RepositoryError("session_world_mismatch", `세션 ${input.sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
    }
    if (!session.activeTurnId) {
      throw new RepositoryError("no_active_turn", "첫 턴이 도착하기 전에는 책갈피를 만들 수 없습니다.");
    }
    const label = input.label.trim() || `저장점 ${new Date().toLocaleString()}`;
    const saveId = `save_${randomUUID()}`;
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO saves (id, world_id, session_id, label, turn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(saveId, input.worldId, input.sessionId, label, session.activeTurnId, createdAt);
    return { saveId };
  }

  function loadSave(saveId: string): ReaderState {
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, label, turn_id AS turnId, created_at AS createdAt
           FROM saves WHERE id = ?`
      )
      .get(saveId) as UnknownRow | undefined;
    if (!row) {
      throw new RepositoryError("save_not_found", `책갈피를 찾을 수 없습니다: ${saveId}`);
    }
    const save = mapSave(row);
    const updatedAt = nowIso();
    db.prepare(`UPDATE sessions SET active_turn_id = ?, updated_at = ? WHERE id = ?`).run(
      save.turnId,
      updatedAt,
      save.sessionId
    );
    db.prepare(`UPDATE worlds SET updated_at = ? WHERE id = ?`).run(updatedAt, save.worldId);
    return getReaderState(save.worldId, save.sessionId);
  }

  function linkWebgptSession(input: { worldId: string; sessionId: string; url: string }): { ok: true } {
    const parsed = new URL(input.url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new RepositoryError("unsupported_webgpt_url", "WebGPT 세션 URL은 http 또는 https만 지원합니다.", [
        { path: "url", message: "URL은 http 또는 https를 사용해야 합니다." }
      ]);
    }
    const session = getSession(input.sessionId);
    if (session.worldId !== input.worldId) {
      throw new RepositoryError("session_world_mismatch", `세션 ${input.sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
    }
    const updatedAt = nowIso();
    db.prepare(`UPDATE sessions SET webgpt_session_url = ?, updated_at = ? WHERE id = ?`).run(
      parsed.toString(),
      updatedAt,
      input.sessionId
    );
    db.prepare(`UPDATE worlds SET updated_at = ? WHERE id = ?`).run(updatedAt, input.worldId);
    return { ok: true };
  }

  function upsertLibraryDoc(input: UpsertLibraryDocInput): { docId: string; versionId: string } {
    getWorld(input.worldId);
    const sessionId = input.sessionId?.trim() || null;
    if (sessionId) {
      const session = getSession(sessionId);
      if (session.worldId !== input.worldId) {
        throw new RepositoryError("session_world_mismatch", `세션 ${sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
      }
    }
    const title = input.title.trim();
    if (!title) {
      throw new RepositoryError("library_doc_title_required", "라이브러리 문서 제목이 필요합니다.", [
        { path: "title", message: "라이브러리 문서 제목이 필요합니다." }
      ]);
    }
    const createdAt = nowIso();
    const docId = input.docId ?? `doc_${randomUUID()}`;
    const versionId = `docver_${randomUUID()}`;
    const metadata = normalizeLibraryDocMetadata({
      status: input.status ?? "active",
      scope: input.scope ?? "world",
      tags: input.tags ?? [],
      supersedesDocVersionId: input.supersedesDocVersionId ?? undefined
    });
    db.exec("BEGIN");
    try {
      if (!input.docId) {
        db.prepare(`INSERT INTO library_docs (id, world_id, kind, title, created_at) VALUES (?, ?, ?, ?, ?)`).run(
          docId,
          input.worldId,
          input.kind,
          title,
          createdAt
        );
      }
      db.prepare(
        `INSERT INTO library_doc_versions
          (id, doc_id, world_id, kind, title, body_json, visible_to_llm, visible_to_player,
           created_by, created_at, source_turn_id, update_reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        versionId,
        docId,
        input.worldId,
        input.kind,
        title,
        JSON.stringify(input.body),
        input.visibleToLlm ? 1 : 0,
        input.visibleToPlayer ? 1 : 0,
        input.createdBy,
        createdAt,
        input.sourceTurnId ?? null,
        input.updateReason ?? null,
        JSON.stringify(metadata)
      );
      const touchedTurn = input.sourceTurnId
        ? (db
            .prepare(`SELECT turn_index AS turnIndex FROM turns WHERE id = ?`)
            .get(input.sourceTurnId) as UnknownRow | undefined)
        : undefined;
      db.prepare(
        `INSERT INTO library_doc_usage
          (world_id, session_id, doc_id, last_used_turn_id, last_used_turn_index,
           last_touched_turn_id, last_touched_turn_index, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(world_id, session_id, doc_id) DO UPDATE SET
           last_touched_turn_id = excluded.last_touched_turn_id,
           last_touched_turn_index = excluded.last_touched_turn_index,
           updated_at = excluded.updated_at`
      ).run(input.worldId, sessionId, docId, input.sourceTurnId ?? null, touchedTurn ? Number(touchedTurn.turnIndex) : null, createdAt);
      upsertCgReferenceBoardFromLibraryDoc({
        worldId: input.worldId,
        sessionId,
        docId,
        kind: input.kind,
        title,
        body: input.body,
        tags: metadata.tags,
        updateReason: input.updateReason ?? null
      });
      db.prepare(`UPDATE worlds SET updated_at = ? WHERE id = ?`).run(createdAt, input.worldId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { docId, versionId };
  }

  function setLibraryDocPinned(input: {
    worldId: string;
    sessionId?: string | null;
    docId: string;
    pinned: boolean;
    createdBy: "llm" | "user";
  }): { ok: true } {
    getWorld(input.worldId);
    const doc = db
      .prepare(`SELECT id, world_id AS worldId FROM library_docs WHERE id = ?`)
      .get(input.docId) as UnknownRow | undefined;
    if (!doc) {
      throw new RepositoryError("library_doc_not_found", `라이브러리 문서를 찾을 수 없습니다: ${input.docId}`);
    }
    if (requireString(doc.worldId, "worldId") !== input.worldId) {
      throw new RepositoryError("library_doc_world_mismatch", "라이브러리 문서가 이 세계에 속하지 않습니다.");
    }
    const sessionId = input.sessionId ?? null;
    if (sessionId) {
      const session = getSession(sessionId);
      if (session.worldId !== input.worldId) {
        throw new RepositoryError("session_world_mismatch", `세션 ${sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
      }
    }
    if (!input.pinned) {
      db.prepare(`DELETE FROM library_doc_pins WHERE world_id = ? AND session_id IS ? AND doc_id = ?`).run(
        input.worldId,
        sessionId,
        input.docId
      );
      return { ok: true };
    }
    db.prepare(
      `INSERT OR REPLACE INTO library_doc_pins
        (world_id, session_id, doc_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(input.worldId, sessionId, input.docId, input.createdBy, nowIso());
    return { ok: true };
  }

  function countLibraryVersionsCreatedSince(input: { worldId: string; since: string }): number {
    getWorld(input.worldId);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM library_doc_versions
          WHERE world_id = ? AND created_at >= ?`
      )
      .get(input.worldId, input.since) as UnknownRow;
    return Number(row.count ?? 0);
  }

  function createWebgptDispatch(input: CreateWebgptDispatchInput): WebgptDispatchRecord {
    const session = getSession(input.sessionId);
    if (session.worldId !== input.worldId) {
      throw new RepositoryError("session_world_mismatch", `세션 ${input.sessionId}은 세계 ${input.worldId}에 속하지 않습니다.`);
    }
    const existing = activeWebgptDispatch(input.worldId, input.sessionId);
    if (existing) {
      throw new RepositoryError("webgpt_dispatch_running", "이미 이 세션의 WebGPT 작성 작업이 진행 중입니다.");
    }
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO webgpt_dispatches
        (id, world_id, session_id, status, conversation_id, dispatch_token_hash, payload_json, result_json, error_message, created_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, NULL, NULL, ?)`
    ).run(
      input.id,
      input.worldId,
      input.sessionId,
      input.conversationId ?? null,
      input.dispatchTokenHash ?? null,
      JSON.stringify(input.payload),
      createdAt
    );
    const dispatch = latestWebgptDispatch(input.worldId, input.sessionId);
    if (!dispatch) {
      throw new RepositoryError("webgpt_dispatch_not_found", `WebGPT 작업을 찾을 수 없습니다: ${input.id}`);
    }
    return dispatch;
  }

  function verifyWebgptDispatchToken(input: { worldId: string; sessionId: string; dispatchTokenHash: string }): WebgptDispatchRecord {
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId, status,
                conversation_id AS conversationId, payload_json AS payloadJson,
                result_json AS resultJson, error_message AS errorMessage,
                created_at AS createdAt
           FROM webgpt_dispatches
          WHERE world_id = ?
            AND session_id = ?
            AND status = 'running'
            AND dispatch_token_hash = ?
          ORDER BY created_at DESC
          LIMIT 1`
      )
      .get(input.worldId, input.sessionId, input.dispatchTokenHash) as UnknownRow | undefined;
    if (!row) {
      throw new RepositoryError("invalid_dispatch_token", "유효한 WebGPT 작업 토큰이 없습니다.");
    }
    return mapWebgptDispatch(row);
  }

  function finishWebgptDispatch(input: FinishWebgptDispatchInput): WebgptDispatchRecord {
    const row = db
      .prepare(
        `SELECT id, world_id AS worldId, session_id AS sessionId
           FROM webgpt_dispatches
          WHERE id = ?`
      )
      .get(input.id) as UnknownRow | undefined;
    if (!row) {
      throw new RepositoryError("webgpt_dispatch_not_found", `WebGPT 작업을 찾을 수 없습니다: ${input.id}`);
    }
    db.prepare(
      `UPDATE webgpt_dispatches
          SET status = ?, conversation_id = COALESCE(?, conversation_id),
              result_json = ?, error_message = ?
        WHERE id = ?`
    ).run(
      input.status,
      input.conversationId ?? null,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.errorMessage ?? null,
      input.id
    );
    const dispatch = latestWebgptDispatch(requireString(row.worldId, "worldId"), requireString(row.sessionId, "sessionId"));
    if (!dispatch) {
      throw new RepositoryError("webgpt_dispatch_not_found", `WebGPT 작업을 찾을 수 없습니다: ${input.id}`);
    }
    return dispatch;
  }

  return {
    createWorld,
    updateSessionSettings,
    updateWorldCgStylePrompt,
    updateWorldTitle,
    listWorlds,
    getReaderState,
    getForm,
    listLibraryDocs,
    listLibraryOutline,
    prepareCgAssetForTurn,
    listCgReferenceBoards,
    upsertCgReferenceBoard,
    attachCgReferenceBoardImage,
    claimNextCgJob,
    retryCgJob,
    attachCgAsset,
    setLibraryDocPinned,
    recordPlayerAction,
    submitTurn,
    createSave,
    loadSave,
    listSaves,
    linkWebgptSession,
    upsertLibraryDoc,
    countLibraryVersionsCreatedSince,
    createWebgptDispatch,
    finishWebgptDispatch,
    verifyWebgptDispatchToken,
    activeWebgptDispatch,
    latestWebgptDispatch
  };
}

export type Repository = ReturnType<typeof createRepository>;
