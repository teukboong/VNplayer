import { z } from "zod";
import type {
  ActionAdjudication,
  ActionConstraintGate,
  CgDecision,
  CgRequest,
  DisplayabilityWarning,
  DisplayShape,
  LibraryDocKind,
  LibraryDocScope,
  LibraryDocStatus,
  StoryInterface,
  StoryLibraryUpdate,
  StoryTurn,
  WorldNamingProposal,
  ToolError
} from "./types.js";

const MAX_PAYLOAD_BYTES = 64_000;
const SOFT_MIN_SCENE_PARAGRAPHS = 8;
const SOFT_MIN_SCENE_CHARS = 900;
const unsafeDisplayPattern = /<\s*script|javascript:|on[a-z]+\s*=/i;
const libraryDocKinds: LibraryDocKind[] = [
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
];
const libraryDocStatuses: LibraryDocStatus[] = ["active", "dormant", "resolved", "superseded"];
const libraryDocScopes: LibraryDocScope[] = ["world", "session", "arc", "scene"];
const actionConstraintGates: ActionConstraintGate[] = ["body", "resource", "time", "social_permission", "knowledge", "world_law", "visibility"];
const MAX_WORLD_TITLE_LENGTH = 64;
const MAX_WORLD_SUBTITLE_LENGTH = 120;

export const StoryTurnSchema = z.object({
  scene: z.object({
    speaker: z.string().nullable(),
    paragraphs: z.array(z.string().min(1)).min(1),
    background: z.string().nullable(),
    mood: z.string().nullable()
  }),
  concreteDelta: z.string().nullable().optional(),
  interface: z
    .object({
      statusRows: z
        .array(
          z.object({
            label: z.string().min(1),
            value: z.string().min(1),
            icon: z.string().nullable().optional()
          })
        )
        .optional(),
      scanRows: z
        .array(
          z.object({
            target: z.string().min(1),
            className: z.string().nullable().optional(),
            distance: z.string().nullable().optional(),
            thought: z.string().nullable().optional(),
            links: z
              .array(
                z.object({
                  label: z.string().min(1),
                  href: z.string().min(1)
                })
              )
              .optional()
          })
        )
        .optional(),
      progress: z
        .object({
          eventName: z.string().nullable().optional(),
          phrase: z.string().nullable().optional()
        })
        .optional()
    })
    .optional(),
  choices: z.array(
    z.object({
      label: z.string().min(1),
      action: z.string().min(1),
      tag: z.string().nullable().optional(),
      intent: z.string().nullable().optional()
    })
  ),
  libraryUpdates: z.array(z.unknown()).optional(),
  cgRequest: z
    .object({
      shouldGenerate: z.boolean(),
      priority: z.enum(["low", "normal", "high"]).optional(),
      subject: z.string().min(1),
      visibleAnchors: z.array(z.string().min(1)),
      composition: z.string().nullable().optional(),
      mood: z.string().nullable().optional(),
      palette: z.array(z.string().min(1)).nullable().optional(),
      avoid: z.array(z.string().min(1)).optional(),
      rationale: z.string().nullable().optional()
    })
    .optional(),
  cgDecision: z
    .discriminatedUnion("decision", [
      z.object({
        decision: z.literal("generate"),
        reason: z.string().min(1),
        cgRequest: z.object({
          shouldGenerate: z.literal(true),
          priority: z.enum(["low", "normal", "high"]).optional(),
          subject: z.string().min(1),
          visibleAnchors: z.array(z.string().min(1)),
          composition: z.string().nullable().optional(),
          mood: z.string().nullable().optional(),
          palette: z.array(z.string().min(1)).nullable().optional(),
          avoid: z.array(z.string().min(1)).optional(),
          rationale: z.string().nullable().optional()
        })
      }),
      z.object({
        decision: z.literal("skip"),
        reason: z.string().min(1),
        nextLikelyTrigger: z.string().nullable().optional()
      })
    ])
    .optional(),
  actionAdjudication: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("accepted"),
        reason: z.string().min(1),
        cost: z.string().nullable().optional(),
        constraintTouched: z.array(z.enum(actionConstraintGates as [ActionConstraintGate, ...ActionConstraintGate[]])).optional()
      }),
      z.object({
        kind: z.literal("partial"),
        reason: z.string().min(1),
        achieved: z.string().min(1),
        blockedBy: z.string().min(1),
        cost: z.string().nullable().optional(),
        constraintTouched: z.array(z.enum(actionConstraintGates as [ActionConstraintGate, ...ActionConstraintGate[]])).optional()
      }),
      z.object({
        kind: z.literal("blocked"),
        reason: z.string().min(1),
        blockingGate: z.enum(actionConstraintGates as [ActionConstraintGate, ...ActionConstraintGate[]]),
        visibleConsequence: z.string().min(1)
      })
    ])
    .optional(),
  worldNaming: z
    .object({
      candidate: z.string().min(1).max(MAX_WORLD_TITLE_LENGTH),
      subtitle: z.string().max(MAX_WORLD_SUBTITLE_LENGTH).nullable().optional(),
      confidence: z.number().min(0).max(1).nullable().optional(),
      reason: z.string().max(240).nullable().optional()
    })
    .optional()
});

type NormalizeResult =
  | { ok: true; displayShape: DisplayShape }
  | { ok: false; error: ToolError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifySize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_PAYLOAD_BYTES + 1;
  }
}

function containsUnsafeDisplayPayload(value: unknown): boolean {
  if (typeof value === "string") {
    return unsafeDisplayPattern.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsUnsafeDisplayPayload);
  }
  if (isRecord(value)) {
    return Object.values(value).some(containsUnsafeDisplayPayload);
  }
  return false;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalTextProp(record: Record<string, unknown>, key: string): string | null | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? optionalText(record[key]) : undefined;
}

function clippedText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength).trim();
}

function fieldError(path: string, message: string): ToolError {
  return {
    ok: false,
    code: "displayability_failed",
    message,
    fieldErrors: [{ path, message }]
  };
}

function isToolError(value: StoryInterface | ToolError | undefined): value is ToolError {
  return Boolean(value && "ok" in value && value.ok === false);
}

function normalizeParagraphs(value: unknown, warnings: DisplayabilityWarning[]): string[] | ToolError {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return fieldError("scene.paragraphs", "표시할 수 있는 문단이 최소 하나는 필요합니다.");
    }
    warnings.push({
      code: "paragraph_string_wrapped",
      message: "단일 문단 문자열을 문단 배열로 정리했습니다.",
      path: "scene.paragraphs"
    });
    return [trimmed];
  }

  if (!Array.isArray(value)) {
    return fieldError("scene.paragraphs", "문단은 배열이거나 비어 있지 않은 단일 문자열이어야 합니다.");
  }

  const paragraphs = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return fieldError("scene.paragraphs", "표시할 수 있는 문단이 최소 하나는 필요합니다.");
  }

  if (paragraphs.length !== value.length) {
    warnings.push({
      code: "empty_or_non_string_paragraph_dropped",
      message: "빈 문단이나 문자열이 아닌 문단 항목은 표시하지 않았습니다.",
      path: "scene.paragraphs"
    });
  }

  if (paragraphs.length < SOFT_MIN_SCENE_PARAGRAPHS) {
    warnings.push({
      code: "short_scene_paragraphs",
      message: `서술 문단이 짧습니다. 다음 작성 요청에서는 보통 10-18문단의 장면 단위를 요구하는 편이 좋습니다. 현재 ${paragraphs.length}문단입니다.`,
      path: "scene.paragraphs"
    });
  }

  const sceneCharCount = paragraphs.join("\n\n").replace(/\s/g, "").length;
  if (sceneCharCount < SOFT_MIN_SCENE_CHARS) {
    warnings.push({
      code: "short_scene_text",
      message: `서술 밀도가 낮습니다. 다음 작성 요청에서는 감각, 공간 작동, 인물 반응, 선택 압력, 작은 후과가 모두 지나가도록 요구하는 편이 좋습니다. 현재 공백 제외 ${sceneCharCount}자입니다.`,
      path: "scene.paragraphs"
    });
  }

  return paragraphs;
}

function extractConcreteDeltaFromParagraphs(paragraphs: string[]): { paragraphs: string[]; concreteDelta: string | null } {
  const markers = [
    "이번 턴에서 실제로 달라진 구체적 가시 변화:",
    "이번 턴의 구체 변화:",
    "concreteDelta:",
    "ConcreteDelta:"
  ];
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const paragraph = paragraphs[index];
    if (paragraph === undefined) {
      continue;
    }
    const marker = markers.find((candidate) => paragraph.includes(candidate));
    if (!marker) {
      continue;
    }
    const markerIndex = paragraph.indexOf(marker);
    const before = paragraph.slice(0, markerIndex).trim().replace(/^["“]|["”]$/g, "").trim();
    const delta = paragraph.slice(markerIndex + marker.length).trim().replace(/^["“]|["”]$/g, "").trim();
    const nextParagraphs = paragraphs.slice();
    if (before) {
      nextParagraphs[index] = before;
    } else {
      nextParagraphs.splice(index, 1);
    }
    return { paragraphs: nextParagraphs.length ? nextParagraphs : paragraphs, concreteDelta: delta || null };
  }
  return { paragraphs, concreteDelta: null };
}

function normalizeChoices(value: unknown, warnings: DisplayabilityWarning[]): StoryTurn["choices"] | ToolError {
  if (value === undefined || value === null) {
    warnings.push({
      code: "choices_missing",
      message: "제출된 선택지가 없습니다. 자유 행동으로 이어갈 수 있습니다.",
      path: "choices"
    });
    return [];
  }

  if (!Array.isArray(value)) {
    return fieldError("choices", "선택지가 있다면 배열이어야 합니다.");
  }

  const choices: StoryTurn["choices"] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) {
      return fieldError(`choices.${index}`, "각 선택지는 객체여야 합니다.");
    }
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const action = typeof item.action === "string" ? item.action.trim() : "";
    if (!label || !action) {
      return fieldError(`choices.${index}`, "각 선택지는 표시 가능한 label과 action이 필요합니다.");
    }
    const choice: StoryTurn["choices"][number] = { label, action };
    const tag = optionalTextProp(item, "tag");
    const intent = optionalTextProp(item, "intent");
    if (tag !== undefined) {
      choice.tag = tag;
    }
    if (intent !== undefined) {
      choice.intent = intent;
    }
    choices.push(choice);
  }

  if (choices.length === 0) {
    warnings.push({
      code: "choices_empty",
      message: "제출된 턴에 선택지가 없습니다. 자유 행동으로 이어갈 수 있습니다.",
      path: "choices"
    });
  }

  if (choices.length > 0 && choices.length < 4) {
    warnings.push({
      code: "choices_thin",
      message: "선택지가 적습니다. 다음 작성 요청에서는 4-6개의 구체적 장면 행동을 요구하는 편이 좋습니다.",
      path: "choices"
    });
  }

  return choices;
}

function normalizeLibraryUpdates(value: unknown, warnings: DisplayabilityWarning[]): StoryLibraryUpdate[] | ToolError {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return fieldError("libraryUpdates", "libraryUpdates가 있다면 배열이어야 합니다.");
  }
  const updates: StoryLibraryUpdate[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) {
      warnings.push({ code: "invalid_library_update_dropped", message: "객체가 아닌 library update는 저장하지 않았습니다.", path: `libraryUpdates.${index}` });
      continue;
    }
    const kind = optionalText(item.kind);
    const title = optionalText(item.title);
    if (!kind || !libraryDocKinds.includes(kind as LibraryDocKind) || !title) {
      warnings.push({ code: "invalid_library_update_dropped", message: "kind/title이 불완전한 library update는 저장하지 않았습니다.", path: `libraryUpdates.${index}` });
      continue;
    }
    const update: StoryLibraryUpdate = {
      kind: kind as LibraryDocKind,
      title,
      body: item.body ?? {},
      visibleToLlm: typeof item.visibleToLlm === "boolean" ? item.visibleToLlm : true,
      visibleToPlayer: typeof item.visibleToPlayer === "boolean" ? item.visibleToPlayer : true
    };
    const status = optionalText(item.status);
    const scope = optionalText(item.scope);
    const tagsValue = item.tags;
    const updateReason = optionalTextProp(item, "updateReason");
    if (status && libraryDocStatuses.includes(status as LibraryDocStatus)) {
      update.status = status as LibraryDocStatus;
    }
    if (scope && libraryDocScopes.includes(scope as LibraryDocScope)) {
      update.scope = scope as LibraryDocScope;
    }
    if (Array.isArray(tagsValue)) {
      update.tags = tagsValue.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())).map((tag) => tag.trim());
    }
    if (updateReason !== undefined) {
      update.updateReason = updateReason;
    }
    updates.push(update);
  }
  return updates;
}

function normalizeCgRequest(value: unknown, warnings: DisplayabilityWarning[]): CgRequest | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push({
      code: "invalid_cg_request_dropped",
      message: "객체가 아닌 cgRequest는 사용하지 않았습니다.",
      path: "cgRequest"
    });
    return undefined;
  }
  if (value.shouldGenerate !== true) {
    return undefined;
  }
  const subject = optionalText(value.subject);
  const anchorsValue = value.visibleAnchors;
  const visibleAnchors = Array.isArray(anchorsValue)
    ? anchorsValue.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
  if (!subject || !visibleAnchors.length) {
    warnings.push({
      code: "invalid_cg_request_dropped",
      message: "subject와 visibleAnchors가 불완전한 cgRequest는 사용하지 않았습니다.",
      path: "cgRequest"
    });
    return undefined;
  }
  const priorityValue = optionalText(value.priority);
  const paletteValue = value.palette;
  const avoidValue = value.avoid;
  const request: CgRequest = {
    shouldGenerate: true,
    subject,
    visibleAnchors
  };
  if (priorityValue === "low" || priorityValue === "normal" || priorityValue === "high") {
    request.priority = priorityValue;
  }
  const composition = optionalTextProp(value, "composition");
  const mood = optionalTextProp(value, "mood");
  const rationale = optionalTextProp(value, "rationale");
  if (composition !== undefined) {
    request.composition = composition;
  }
  if (mood !== undefined) {
    request.mood = mood;
  }
  if (Array.isArray(paletteValue)) {
    request.palette = paletteValue.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  }
  if (Array.isArray(avoidValue)) {
    request.avoid = avoidValue.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  }
  if (rationale !== undefined) {
    request.rationale = rationale;
  }
  return request;
}

function normalizeCgDecision(value: unknown, warnings: DisplayabilityWarning[]): CgDecision | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push({
      code: "invalid_cg_decision_dropped",
      message: "객체가 아닌 cgDecision은 사용하지 않았습니다.",
      path: "cgDecision"
    });
    return undefined;
  }
  const decision = optionalText(value.decision);
  const reason = optionalText(value.reason);
  if (decision === "skip") {
    if (!reason) {
      warnings.push({
        code: "invalid_cg_decision_dropped",
        message: "skip cgDecision에는 reason이 필요합니다.",
        path: "cgDecision.reason"
      });
      return undefined;
    }
    const nextLikelyTrigger = optionalTextProp(value, "nextLikelyTrigger");
    return {
      decision: "skip",
      reason,
      ...(nextLikelyTrigger !== undefined ? { nextLikelyTrigger } : {})
    };
  }
  if (decision === "generate") {
    if (!reason) {
      warnings.push({
        code: "invalid_cg_decision_dropped",
        message: "generate cgDecision에는 reason이 필요합니다.",
        path: "cgDecision.reason"
      });
      return undefined;
    }
    const request = normalizeCgRequest(value.cgRequest, warnings);
    if (!request) {
      warnings.push({
        code: "invalid_cg_decision_dropped",
        message: "generate cgDecision에는 완전한 cgRequest가 필요합니다.",
        path: "cgDecision.cgRequest"
      });
      return undefined;
    }
    return {
      decision: "generate",
      reason,
      cgRequest: request
    };
  }
  warnings.push({
    code: "invalid_cg_decision_dropped",
    message: "cgDecision.decision은 generate 또는 skip이어야 합니다.",
    path: "cgDecision.decision"
  });
  return undefined;
}

function normalizeActionConstraintGates(value: unknown, warnings: DisplayabilityWarning[], path: string): ActionConstraintGate[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    warnings.push({
      code: "invalid_action_adjudication_gate_dropped",
      message: "constraintTouched는 배열이어야 합니다. 행동 판정의 gate 목록은 저장하지 않았습니다.",
      path
    });
    return undefined;
  }
  const gates = value.filter((item): item is ActionConstraintGate => typeof item === "string" && actionConstraintGates.includes(item as ActionConstraintGate));
  if (gates.length !== value.length) {
    warnings.push({
      code: "invalid_action_adjudication_gate_dropped",
      message: "알 수 없는 행동 판정 gate는 저장하지 않았습니다.",
      path
    });
  }
  return gates.length ? gates : undefined;
}

function normalizeActionAdjudication(value: unknown, warnings: DisplayabilityWarning[]): ActionAdjudication | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push({
      code: "invalid_action_adjudication_dropped",
      message: "객체가 아닌 actionAdjudication은 사용하지 않았습니다.",
      path: "actionAdjudication"
    });
    return undefined;
  }
  const kind = optionalText(value.kind);
  const reason = optionalText(value.reason);
  if (!reason) {
    warnings.push({
      code: "invalid_action_adjudication_dropped",
      message: "actionAdjudication에는 reason이 필요합니다.",
      path: "actionAdjudication.reason"
    });
    return undefined;
  }
  if (kind === "accepted") {
    const cost = optionalTextProp(value, "cost");
    const constraintTouched = normalizeActionConstraintGates(value.constraintTouched, warnings, "actionAdjudication.constraintTouched");
    return {
      kind,
      reason,
      ...(cost !== undefined ? { cost } : {}),
      ...(constraintTouched ? { constraintTouched } : {})
    };
  }
  if (kind === "partial") {
    const achieved = optionalText(value.achieved);
    const blockedBy = optionalText(value.blockedBy);
    if (!achieved || !blockedBy) {
      warnings.push({
        code: "invalid_action_adjudication_dropped",
        message: "partial actionAdjudication에는 achieved와 blockedBy가 필요합니다.",
        path: "actionAdjudication"
      });
      return undefined;
    }
    const cost = optionalTextProp(value, "cost");
    const constraintTouched = normalizeActionConstraintGates(value.constraintTouched, warnings, "actionAdjudication.constraintTouched");
    return {
      kind,
      reason,
      achieved,
      blockedBy,
      ...(cost !== undefined ? { cost } : {}),
      ...(constraintTouched ? { constraintTouched } : {})
    };
  }
  if (kind === "blocked") {
    const blockingGate = optionalText(value.blockingGate);
    const visibleConsequence = optionalText(value.visibleConsequence);
    if (!blockingGate || !actionConstraintGates.includes(blockingGate as ActionConstraintGate) || !visibleConsequence) {
      warnings.push({
        code: "invalid_action_adjudication_dropped",
        message: "blocked actionAdjudication에는 올바른 blockingGate와 visibleConsequence가 필요합니다.",
        path: "actionAdjudication"
      });
      return undefined;
    }
    return {
      kind,
      reason,
      blockingGate: blockingGate as ActionConstraintGate,
      visibleConsequence
    };
  }
  warnings.push({
    code: "invalid_action_adjudication_dropped",
    message: "actionAdjudication.kind는 accepted, partial, blocked 중 하나여야 합니다.",
    path: "actionAdjudication.kind"
  });
  return undefined;
}

function extractLibraryUpdatesFromParagraphs(
  paragraphs: string[],
  warnings: DisplayabilityWarning[]
): { paragraphs: string[]; libraryUpdates: StoryLibraryUpdate[] } | ToolError {
  const marker = "LIBRARY_UPDATE_JSON:";
  const nextParagraphs: string[] = [];
  const extractedUpdates: StoryLibraryUpdate[] = [];

  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index] ?? "";
    const markerIndex = paragraph.indexOf(marker);
    if (markerIndex < 0) {
      nextParagraphs.push(paragraph);
      continue;
    }

    const before = paragraph.slice(0, markerIndex).trim();
    const rawJson = paragraph.slice(markerIndex + marker.length).trim();
    if (before) {
      nextParagraphs.push(before);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return fieldError(`scene.paragraphs.${index}`, "LIBRARY_UPDATE_JSON 뒤에는 유효한 JSON 객체 또는 배열이 필요합니다.");
    }
    const normalized = normalizeLibraryUpdates(Array.isArray(parsed) ? parsed : [parsed], warnings);
    if (!Array.isArray(normalized)) {
      return normalized;
    }
    extractedUpdates.push(...normalized);
  }

  if (extractedUpdates.length) {
    warnings.push({
      code: "library_updates_extracted",
      message: "본문에 섞인 LLM 작성 라이브러리 갱신을 분리했습니다.",
      path: "scene.paragraphs"
    });
  }

  return {
    paragraphs: nextParagraphs.length ? nextParagraphs : paragraphs,
    libraryUpdates: extractedUpdates
  };
}

function normalizeWorldNaming(value: unknown, warnings: DisplayabilityWarning[]): WorldNamingProposal | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push({
      code: "invalid_world_naming_dropped",
      message: "worldNaming은 객체여야 합니다. 세계 이름 후보를 저장하지 않았습니다.",
      path: "worldNaming"
    });
    return undefined;
  }
  const candidate = optionalText(value.candidate);
  if (!candidate) {
    warnings.push({
      code: "invalid_world_naming_dropped",
      message: "worldNaming.candidate가 비어 있어 세계 이름 후보를 저장하지 않았습니다.",
      path: "worldNaming.candidate"
    });
    return undefined;
  }
  const naming: WorldNamingProposal = {
    candidate: clippedText(candidate, MAX_WORLD_TITLE_LENGTH)
  };
  const subtitle = optionalText(value.subtitle);
  if (subtitle) {
    naming.subtitle = clippedText(subtitle, MAX_WORLD_SUBTITLE_LENGTH);
  }
  if (typeof value.confidence === "number" && Number.isFinite(value.confidence)) {
    naming.confidence = Math.min(1, Math.max(0, value.confidence));
  }
  const reason = optionalText(value.reason);
  if (reason) {
    naming.reason = clippedText(reason, 240);
  }
  if (naming.candidate !== candidate.replace(/\s+/g, " ").trim()) {
    warnings.push({
      code: "world_naming_candidate_clipped",
      message: "세계 이름 후보가 너무 길어 표시 가능한 길이로 줄였습니다.",
      path: "worldNaming.candidate"
    });
  }
  return naming;
}

function normalizeInterface(value: unknown, warnings: DisplayabilityWarning[]): StoryTurn["interface"] | ToolError {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    return fieldError("interface", "interface가 있다면 객체여야 합니다.");
  }

  const result: StoryTurn["interface"] = {};

  if (value.statusRows !== undefined) {
    if (!Array.isArray(value.statusRows)) {
      return fieldError("interface.statusRows", "statusRows는 배열이어야 합니다.");
    }
    const statusRows = value.statusRows
      .filter(isRecord)
      .map((row) => {
        const normalizedRow: NonNullable<StoryInterface["statusRows"]>[number] = {
          label: optionalText(row.label) ?? "",
          value: optionalText(row.value) ?? ""
        };
        const icon = optionalTextProp(row, "icon");
        if (icon !== undefined) {
          normalizedRow.icon = icon;
        }
        return normalizedRow;
      })
      .filter((row) => row.label && row.value);
    if (statusRows.length !== value.statusRows.length) {
      warnings.push({
        code: "invalid_status_row_dropped",
        message: "표시할 수 없는 상태 행은 보여주지 않았습니다.",
        path: "interface.statusRows"
      });
    }
    if (statusRows.length) {
      result.statusRows = statusRows;
    }
  }

  if (value.scanRows !== undefined) {
    if (!Array.isArray(value.scanRows)) {
      return fieldError("interface.scanRows", "scanRows는 배열이어야 합니다.");
    }
    const scanRows = value.scanRows
      .filter(isRecord)
      .map((row) => {
        const linksValue = row.links;
        const links = Array.isArray(linksValue)
          ? linksValue
              .filter(isRecord)
              .map((link) => ({
                label: optionalText(link.label) ?? "",
                href: optionalText(link.href) ?? ""
              }))
              .filter((link) => link.label && link.href)
          : undefined;
        const normalizedRow: NonNullable<StoryInterface["scanRows"]>[number] = {
          target: optionalText(row.target) ?? "",
        };
        const className = optionalTextProp(row, "className");
        const distance = optionalTextProp(row, "distance");
        const thought = optionalTextProp(row, "thought");
        if (className !== undefined) {
          normalizedRow.className = className;
        }
        if (distance !== undefined) {
          normalizedRow.distance = distance;
        }
        if (thought !== undefined) {
          normalizedRow.thought = thought;
        }
        if (links?.length) {
          normalizedRow.links = links;
        }
        return normalizedRow;
      })
      .filter((row) => row.target);
    if (scanRows.length !== value.scanRows.length) {
      warnings.push({
        code: "invalid_scan_row_dropped",
        message: "표시할 수 없는 스캔 행은 보여주지 않았습니다.",
        path: "interface.scanRows"
      });
    }
    if (scanRows.length) {
      result.scanRows = scanRows;
    }
  }

  if (value.progress !== undefined) {
    if (!isRecord(value.progress)) {
      return fieldError("interface.progress", "progress는 객체여야 합니다.");
    }
    const progress: NonNullable<StoryInterface["progress"]> = {};
    const eventName = optionalTextProp(value.progress, "eventName");
    const phrase = optionalTextProp(value.progress, "phrase");
    if (eventName !== undefined) {
      progress.eventName = eventName;
    }
    if (phrase !== undefined) {
      progress.phrase = phrase;
    }
    if (progress.eventName || progress.phrase) {
      result.progress = progress;
    }
  }

  return Object.keys(result).length ? result : undefined;
}

export function normalizeStoryTurn(payload: unknown): NormalizeResult {
  if (stringifySize(payload) > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "payload_too_large",
        message: `제출된 턴이 ${MAX_PAYLOAD_BYTES}바이트를 초과했습니다.`
      }
    };
  }

  if (containsUnsafeDisplayPayload(payload)) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "unsafe_display_payload",
        message: "제출된 턴에 안전하지 않은 스크립트성 표시 콘텐츠가 들어 있습니다."
      }
    };
  }

  if (!isRecord(payload)) {
    return { ok: false, error: fieldError("turn", "제출된 턴은 객체여야 합니다.") };
  }

  const warnings: DisplayabilityWarning[] = [];
  const candidate = isRecord(payload.turn) ? payload.turn : payload;

  if (candidate !== payload) {
    warnings.push({
      code: "wrapped_turn_unwrapped",
      message: "최상위 turn 래퍼를 정리했습니다.",
      path: "turn"
    });
  }

  const scene = isRecord(candidate.scene) ? candidate.scene : null;
  if (!scene) {
    return { ok: false, error: fieldError("scene", "제출된 턴에는 scene 객체가 필요합니다.") };
  }

  const paragraphs = normalizeParagraphs(scene.paragraphs, warnings);
  if (!Array.isArray(paragraphs)) {
    return { ok: false, error: paragraphs };
  }

  const choices = normalizeChoices(candidate.choices, warnings);
  if (!Array.isArray(choices)) {
    return { ok: false, error: choices };
  }
  let libraryUpdates = normalizeLibraryUpdates(candidate.libraryUpdates, warnings);
  if (!Array.isArray(libraryUpdates)) {
    return { ok: false, error: libraryUpdates };
  }

  const storyInterfaceResult = normalizeInterface(candidate.interface, warnings);
  if (isToolError(storyInterfaceResult)) {
    return { ok: false, error: storyInterfaceResult };
  }
  const cgDecision = normalizeCgDecision(candidate.cgDecision, warnings);
  const legacyCgRequest = normalizeCgRequest(candidate.cgRequest, warnings);
  const cgRequest = cgDecision?.decision === "generate" ? cgDecision.cgRequest : legacyCgRequest;
  const actionAdjudication = normalizeActionAdjudication(candidate.actionAdjudication, warnings);
  const worldNaming = normalizeWorldNaming(candidate.worldNaming, warnings);

  let normalizedParagraphs = paragraphs;
  let concreteDelta = optionalText(candidate.concreteDelta);
  if (!concreteDelta) {
    const extracted = extractConcreteDeltaFromParagraphs(paragraphs);
    normalizedParagraphs = extracted.paragraphs;
    concreteDelta = extracted.concreteDelta;
    if (concreteDelta) {
      warnings.push({
        code: "concrete_delta_extracted",
        message: "본문에 섞인 concreteDelta를 작성자 텍스트에서 분리했습니다.",
        path: "concreteDelta"
      });
    }
  }
  const extractedLibraryUpdates = extractLibraryUpdatesFromParagraphs(normalizedParagraphs, warnings);
  if (!("libraryUpdates" in extractedLibraryUpdates)) {
    return { ok: false, error: extractedLibraryUpdates };
  }
  normalizedParagraphs = extractedLibraryUpdates.paragraphs;
  libraryUpdates = [...libraryUpdates, ...extractedLibraryUpdates.libraryUpdates];
  if (!concreteDelta) {
    warnings.push({
      code: "concrete_delta_missing",
      message: "이 턴에는 작성자가 명시한 concreteDelta가 없습니다. 백엔드는 대신 만들지 않습니다.",
      path: "concreteDelta"
    });
  }

  const turn: StoryTurn = {
    scene: {
      speaker: optionalText(scene.speaker),
      paragraphs: normalizedParagraphs,
      background: optionalText(scene.background),
      mood: optionalText(scene.mood)
    },
    choices
  };
  if (concreteDelta) {
    turn.concreteDelta = concreteDelta;
  }
  if (storyInterfaceResult !== undefined) {
    turn.interface = storyInterfaceResult;
  }
  if (libraryUpdates.length) {
    turn.libraryUpdates = libraryUpdates;
  }
  if (cgRequest) {
    turn.cgRequest = cgRequest;
  }
  if (cgDecision) {
    turn.cgDecision = cgDecision;
  } else {
    warnings.push({
      code: "cg_decision_missing",
      message: "이 턴에는 명시적인 cgDecision이 없습니다. 구형 cgRequest 호환만 적용했습니다.",
      path: "cgDecision"
    });
  }
  if (actionAdjudication) {
    turn.actionAdjudication = actionAdjudication;
  }
  if (worldNaming) {
    turn.worldNaming = worldNaming;
  }

  const parsed = StoryTurnSchema.safeParse(turn);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "displayability_failed",
        message: "제출된 턴을 표시 가능한 StoryTurn으로 정리할 수 없습니다.",
        fieldErrors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      }
    };
  }

  return {
    ok: true,
    displayShape: {
      turn,
      warnings
    }
  };
}
