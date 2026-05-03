import { connectorToolNames, type ConnectorToolName } from "../../../packages/connector/src/index.js";
import type { CgReferenceBoardKind, LibraryDocKind, LibraryDocScope, LibraryDocStatus, NarrativeLevel, ToolResult } from "../../../packages/core/src/index.js";
import type { ListLibraryOutlineOptions, Repository, UpsertLibraryDocInput } from "./repository.js";
import { RepositoryError } from "./repository.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new RepositoryError("invalid_tool_arguments", `${key} 값이 필요합니다.`, [{ path: key, message: `${key} 값이 필요합니다.` }]);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
}

function optionalPositiveInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function optionalNonNegativeInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalNarrativeLevel(args: Record<string, unknown>): NarrativeLevel | undefined {
  const value = args.narrativeLevel;
  if (value === undefined) {
    return undefined;
  }
  if (value === 1 || value === 2 || value === 3) {
    return value;
  }
  throw new RepositoryError("invalid_tool_arguments", "잘못된 서사 레벨입니다.", [
    { path: "narrativeLevel", message: "narrativeLevel은 1, 2, 3 중 하나여야 합니다." }
  ]);
}

function requiredBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") {
    throw new RepositoryError("invalid_tool_arguments", `${key} 값은 boolean이어야 합니다.`, [
      { path: key, message: `${key} 값은 boolean이어야 합니다.` }
    ]);
  }
  return value;
}

function asArgs(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RepositoryError("invalid_tool_arguments", "도구 인자는 객체여야 합니다.");
  }
  return value;
}

function asLibraryDocKind(value: unknown): LibraryDocKind {
  const allowed: LibraryDocKind[] = [
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
  if (typeof value === "string" && allowed.includes(value as LibraryDocKind)) {
    return value as LibraryDocKind;
  }
  throw new RepositoryError("invalid_tool_arguments", "잘못된 라이브러리 문서 종류입니다.", [
    { path: "kind", message: "잘못된 라이브러리 문서 종류입니다." }
  ]);
}

function asCgReferenceBoardKind(value: unknown): CgReferenceBoardKind {
  const allowed: CgReferenceBoardKind[] = ["world_mood", "character", "location", "object", "negative"];
  if (typeof value === "string" && allowed.includes(value as CgReferenceBoardKind)) {
    return value as CgReferenceBoardKind;
  }
  throw new RepositoryError("invalid_tool_arguments", "잘못된 CG 참조 보드 종류입니다.", [
    { path: "kind", message: "kind는 world_mood, character, location, object, negative 중 하나여야 합니다." }
  ]);
}

function optionalCgReferenceBoardStatus(args: Record<string, unknown>): "active" | "superseded" | undefined {
  const value = optionalString(args, "status");
  if (!value) {
    return undefined;
  }
  if (value === "active" || value === "superseded") {
    return value;
  }
  throw new RepositoryError("invalid_tool_arguments", "잘못된 CG 참조 보드 상태입니다.", [
    { path: "status", message: "status는 active 또는 superseded여야 합니다." }
  ]);
}

function optionalCgReferenceBoardCreatedBy(args: Record<string, unknown>): "user" | "webgpt" | undefined {
  const value = optionalString(args, "createdBy");
  if (!value) {
    return undefined;
  }
  if (value === "user" || value === "webgpt") {
    return value;
  }
  throw new RepositoryError("invalid_tool_arguments", "잘못된 CG 참조 보드 작성자입니다.", [
    { path: "createdBy", message: "createdBy는 user 또는 webgpt여야 합니다." }
  ]);
}

function optionalLibraryDocKinds(args: Record<string, unknown>, key: string): LibraryDocKind[] | undefined {
  const values = optionalStringArray(args, key);
  return values?.map(asLibraryDocKind);
}

function optionalLibraryDocStatuses(args: Record<string, unknown>, key: string): LibraryDocStatus[] | undefined {
  const allowed: LibraryDocStatus[] = ["active", "dormant", "resolved", "superseded"];
  const values = optionalStringArray(args, key);
  if (!values) {
    return undefined;
  }
  for (const value of values) {
    if (!allowed.includes(value as LibraryDocStatus)) {
      throw new RepositoryError("invalid_tool_arguments", "잘못된 라이브러리 문서 상태입니다.", [
        { path: key, message: "status는 active, dormant, resolved, superseded 중 하나여야 합니다." }
      ]);
    }
  }
  return values as LibraryDocStatus[];
}

function optionalLibraryDocStatus(args: Record<string, unknown>, key: string): LibraryDocStatus | undefined {
  const value = optionalString(args, key);
  if (!value) {
    return undefined;
  }
  const allowed: LibraryDocStatus[] = ["active", "dormant", "resolved", "superseded"];
  if (!allowed.includes(value as LibraryDocStatus)) {
    throw new RepositoryError("invalid_tool_arguments", "잘못된 라이브러리 문서 상태입니다.", [
      { path: key, message: "status는 active, dormant, resolved, superseded 중 하나여야 합니다." }
    ]);
  }
  return value as LibraryDocStatus;
}

function optionalLibraryDocScopes(args: Record<string, unknown>, key: string): LibraryDocScope[] | undefined {
  const allowed: LibraryDocScope[] = ["world", "session", "arc", "scene"];
  const values = optionalStringArray(args, key);
  if (!values) {
    return undefined;
  }
  for (const value of values) {
    if (!allowed.includes(value as LibraryDocScope)) {
      throw new RepositoryError("invalid_tool_arguments", "잘못된 라이브러리 문서 범위입니다.", [
        { path: key, message: "scope는 world, session, arc, scene 중 하나여야 합니다." }
      ]);
    }
  }
  return values as LibraryDocScope[];
}

function optionalLibraryDocScope(args: Record<string, unknown>, key: string): LibraryDocScope | undefined {
  const value = optionalString(args, key);
  if (!value) {
    return undefined;
  }
  const allowed: LibraryDocScope[] = ["world", "session", "arc", "scene"];
  if (!allowed.includes(value as LibraryDocScope)) {
    throw new RepositoryError("invalid_tool_arguments", "잘못된 라이브러리 문서 범위입니다.", [
      { path: key, message: "scope는 world, session, arc, scene 중 하나여야 합니다." }
    ]);
  }
  return value as LibraryDocScope;
}

function toolError(error: unknown) {
  if (error instanceof RepositoryError) {
    const result = {
      ok: false as const,
      code: error.code,
      message: error.message
    };
    return error.fieldErrors ? { ...result, fieldErrors: error.fieldErrors } : result;
  }
  if (error instanceof Error) {
    return {
      ok: false as const,
      code: "unexpected_error",
      message: error.message
    };
  }
  return {
    ok: false as const,
    code: "unexpected_error",
    message: "알 수 없는 커넥터 오류입니다."
  };
}

function libraryInput(args: Record<string, unknown>, kind: LibraryDocKind): UpsertLibraryDocInput {
  const input: UpsertLibraryDocInput = {
    worldId: requiredString(args, "worldId"),
    kind,
    title: requiredString(args, "title"),
    body: args.body ?? {},
    visibleToLlm: typeof args.visibleToLlm === "boolean" ? args.visibleToLlm : true,
    visibleToPlayer: typeof args.visibleToPlayer === "boolean" ? args.visibleToPlayer : true,
    createdBy: optionalString(args, "createdBy") === "llm" ? "llm" : "user"
  };
  const sessionId = optionalString(args, "sessionId");
  const docId = optionalString(args, "docId");
  const sourceTurnId = optionalString(args, "sourceTurnId");
  const updateReason = optionalString(args, "updateReason");
  const status = optionalLibraryDocStatus(args, "status");
  const scope = optionalLibraryDocScope(args, "scope");
  const tags = optionalStringArray(args, "tags");
  const supersedesDocVersionId = optionalString(args, "supersedesDocVersionId");
  if (sessionId) {
    input.sessionId = sessionId;
  }
  if (docId) {
    input.docId = docId;
  }
  if (sourceTurnId) {
    input.sourceTurnId = sourceTurnId;
  }
  if (updateReason) {
    input.updateReason = updateReason;
  }
  if (status) {
    input.status = status;
  }
  if (scope) {
    input.scope = scope;
  }
  if (tags) {
    input.tags = tags;
  }
  if (supersedesDocVersionId) {
    input.supersedesDocVersionId = supersedesDocVersionId;
  } else if (args.supersedesDocVersionId === null) {
    input.supersedesDocVersionId = null;
  }
  return input;
}

function turnRecord(args: Record<string, unknown>): Record<string, unknown> {
  const turn = args.turn;
  if (!isRecord(turn)) {
    throw new RepositoryError("invalid_tool_arguments", "turn 객체가 필요합니다.", [{ path: "turn", message: "turn 객체가 필요합니다." }]);
  }
  return turn;
}

function hasInlineLibraryUpdateMarker(turn: Record<string, unknown>): boolean {
  const scene = turn.scene;
  if (!isRecord(scene)) {
    return false;
  }
  const paragraphs = scene.paragraphs;
  if (typeof paragraphs === "string") {
    return paragraphs.includes("LIBRARY_UPDATE_JSON:");
  }
  return Array.isArray(paragraphs) && paragraphs.some((paragraph) => typeof paragraph === "string" && paragraph.includes("LIBRARY_UPDATE_JSON:"));
}

function requireVisibleTurnV2Contract(toolName: ConnectorToolName, args: Record<string, unknown>): void {
  if (toolName === "vn_receive_visible_turn") {
    throw new RepositoryError(
      "legacy_receive_tool_retired",
      "vn_receive_visible_turn은 더 이상 작성 lane 제출에 쓰지 않습니다. 커넥터를 새로고침한 뒤 vn_receive_visible_turn_v2로 제출해야 합니다."
    );
  }
  if (toolName !== "vn_receive_visible_turn_v2") {
    return;
  }
  const turn = turnRecord(args);
  const updates = turn.libraryUpdates;
  if ((!Array.isArray(updates) || updates.length === 0) && !hasInlineLibraryUpdateMarker(turn)) {
    throw new RepositoryError(
      "library_update_required",
      "WebGPT 작성 턴에는 최소 1개의 libraryUpdates가 필요합니다. 안정적으로 남은 후과, 장면 표면, 대화 자세, 열린 실마리 중 하나를 기록해야 합니다.",
      [{ path: "turn.libraryUpdates", message: "최소 1개의 라이브러리 갱신이 필요합니다." }]
    );
  }
  const cgDecision = turn.cgDecision;
  const decision = isRecord(cgDecision) ? cgDecision.decision : undefined;
  if (decision !== "generate" && decision !== "skip") {
    throw new RepositoryError("cg_decision_required", "WebGPT 작성 턴에는 cgDecision.generate 또는 cgDecision.skip 판정이 필요합니다.", [
      { path: "turn.cgDecision", message: "decision은 generate 또는 skip이어야 합니다." }
    ]);
  }
}

type ConnectorToolEvents = {
  onTurnSubmitted?: (event: { worldId: string; sessionId: string; turnId: string }) => void;
  onCgChanged?: (event: { worldId: string; sessionId: string; reason: "reference_board" | "asset" }) => void;
};

export function createConnectorTools(repository: Repository, events: ConnectorToolEvents = {}) {
  function call(toolName: ConnectorToolName, rawArgs: unknown): ToolResult<Record<string, unknown>> {
    try {
      const args = asArgs(rawArgs);
      switch (toolName) {
        case "vn_create_world": {
          const result = repository.createWorld({
            seedText: requiredString(args, "seedText"),
            randomSeedEnabled: requiredBoolean(args, "randomSeedEnabled"),
            randomSeedValue: optionalString(args, "randomSeedValue") ?? null,
            title: optionalString(args, "title") ?? null,
            cgStylePrompt: optionalString(args, "cgStylePrompt") ?? null
          });
          return { ok: true, ...result };
        }
        case "vn_update_world_title": {
          const sessionId = optionalString(args, "sessionId");
          const locked = optionalBoolean(args, "locked");
          return {
            ok: true,
            world: repository.updateWorldTitle({
              worldId: requiredString(args, "worldId"),
              ...(sessionId ? { sessionId } : {}),
              title: requiredString(args, "title"),
              subtitle: optionalString(args, "subtitle") ?? null,
              locked: locked ?? true
            })
          };
        }
        case "vn_update_session_settings": {
          const autoCgEnabled = optionalBoolean(args, "autoCgEnabled");
          const narrativeLevel = optionalNarrativeLevel(args);
          return {
            ok: true,
            session: repository.updateSessionSettings({
              worldId: requiredString(args, "worldId"),
              sessionId: requiredString(args, "sessionId"),
              ...(autoCgEnabled === undefined ? {} : { autoCgEnabled }),
              ...(narrativeLevel === undefined ? {} : { narrativeLevel })
            })
          };
        }
        case "vn_update_world_cg_style_prompt": {
          const sessionId = optionalString(args, "sessionId");
          return {
            ok: true,
            world: repository.updateWorldCgStylePrompt({
              worldId: requiredString(args, "worldId"),
              ...(sessionId ? { sessionId } : {}),
              cgStylePrompt: optionalString(args, "cgStylePrompt") ?? null
            })
          };
        }
        case "vn_list_worlds":
          return { ok: true, worlds: repository.listWorlds() };
        case "vn_get_reader_state":
          return {
            ok: true,
            state: repository.getReaderState(requiredString(args, "worldId"), requiredString(args, "sessionId"))
          };
        case "vn_get_current_form":
          return {
            ok: true,
            form: repository.getForm(requiredString(args, "worldId"), requiredString(args, "sessionId"))
          };
        case "vn_submit_turn":
        case "vn_receive_visible_turn":
        case "vn_receive_visible_turn_v2":
          requireVisibleTurnV2Contract(toolName, args);
          const submitResult = repository.submitTurn({
            worldId: requiredString(args, "worldId"),
            sessionId: requiredString(args, "sessionId"),
            source: toolName === "vn_receive_visible_turn" || toolName === "vn_receive_visible_turn_v2"
              ? "llm"
              : (optionalString(args, "source") ?? "llm") === "user_import"
                ? "user_import"
                : "llm",
            turn: args.turn
          });
          events.onTurnSubmitted?.({
            worldId: requiredString(args, "worldId"),
            sessionId: requiredString(args, "sessionId"),
            turnId: submitResult.turnId
          });
          return {
            ok: true,
            ...submitResult
          };
        case "vn_record_player_action": {
          const kind = requiredString(args, "kind");
          if (kind !== "choice" && kind !== "freeform") {
            throw new RepositoryError("invalid_tool_arguments", "kind는 choice 또는 freeform이어야 합니다.", [
              { path: "kind", message: "kind는 choice 또는 freeform이어야 합니다." }
            ]);
          }
          return {
            ok: true,
            ...repository.recordPlayerAction({
              worldId: requiredString(args, "worldId"),
              sessionId: requiredString(args, "sessionId"),
              turnId: requiredString(args, "turnId"),
              kind,
              label: optionalString(args, "label") ?? null,
              text: requiredString(args, "text")
            })
          };
        }
        case "vn_get_visible_history": {
          const state = repository.getReaderState(requiredString(args, "worldId"), requiredString(args, "sessionId"));
          const limit = optionalPositiveInteger(args, "limit");
          return { ok: true, turns: limit ? state.visibleHistory.slice(-limit) : state.visibleHistory.slice(-20) };
        }
        case "vn_get_library_docs":
          const docOptions: { sessionId?: string; docIds?: string[]; pinnedOnly?: boolean; limit?: number } = {};
          const docSessionId = optionalString(args, "sessionId");
          const docIds = optionalStringArray(args, "docIds");
          const docLimit = optionalPositiveInteger(args, "limit");
          if (docSessionId) {
            docOptions.sessionId = docSessionId;
          }
          if (docIds) {
            docOptions.docIds = docIds;
          }
          if (typeof args.pinnedOnly === "boolean") {
            docOptions.pinnedOnly = args.pinnedOnly;
          }
          if (docLimit) {
            docOptions.limit = docLimit;
          }
          return {
            ok: true,
            docs: repository.listLibraryDocs(requiredString(args, "worldId"), docOptions)
          };
        case "vn_get_library_outline": {
          const outlineOptions: ListLibraryOutlineOptions = {};
          const outlineSessionId = optionalString(args, "sessionId");
          const outlineLimit = optionalPositiveInteger(args, "limit");
          if (outlineSessionId) {
            outlineOptions.sessionId = outlineSessionId;
          }
          const kinds = optionalLibraryDocKinds(args, "kinds");
          const status = optionalLibraryDocStatuses(args, "status");
          const scopes = optionalLibraryDocScopes(args, "scopes");
          const tags = optionalStringArray(args, "tags");
          const updatedAfterTurnIndex = optionalNonNegativeInteger(args, "updatedAfterTurnIndex");
          const usedAfterTurnIndex = optionalNonNegativeInteger(args, "usedAfterTurnIndex");
          if (kinds) {
            outlineOptions.kinds = kinds;
          }
          if (status) {
            outlineOptions.status = status;
          }
          if (scopes) {
            outlineOptions.scopes = scopes;
          }
          if (tags) {
            outlineOptions.tags = tags;
          }
          if (typeof args.pinnedOnly === "boolean") {
            outlineOptions.pinnedOnly = args.pinnedOnly;
          }
          if (typeof args.visibleToLlmOnly === "boolean") {
            outlineOptions.visibleToLlmOnly = args.visibleToLlmOnly;
          }
          if (updatedAfterTurnIndex !== undefined) {
            outlineOptions.updatedAfterTurnIndex = updatedAfterTurnIndex;
          }
          if (usedAfterTurnIndex !== undefined) {
            outlineOptions.usedAfterTurnIndex = usedAfterTurnIndex;
          }
          if (outlineLimit) {
            outlineOptions.limit = outlineLimit;
          }
          return {
            ok: true,
            docs: repository.listLibraryOutline(requiredString(args, "worldId"), outlineOptions)
          };
        }
        case "vn_prepare_cg_asset":
          const cgInput: { worldId: string; sessionId: string; turnId?: string } = {
            worldId: requiredString(args, "worldId"),
            sessionId: requiredString(args, "sessionId")
          };
          const cgTurnId = optionalString(args, "turnId");
          if (cgTurnId) {
            cgInput.turnId = cgTurnId;
          }
          return {
            ok: true,
            asset: repository.prepareCgAssetForTurn(cgInput)
          };
        case "vn_list_cg_reference_boards":
          const boardSessionId = optionalString(args, "sessionId");
          const pinnedOnly = optionalBoolean(args, "pinnedOnly");
          const activeOnly = optionalBoolean(args, "activeOnly");
          const boardLimit = optionalPositiveInteger(args, "limit");
          return {
            ok: true,
            boards: repository.listCgReferenceBoards(requiredString(args, "worldId"), {
              ...(boardSessionId ? { sessionId: boardSessionId } : {}),
              ...(pinnedOnly === undefined ? {} : { pinnedOnly }),
              ...(activeOnly === undefined ? {} : { activeOnly }),
              ...(boardLimit === undefined ? {} : { limit: boardLimit })
            })
          };
        case "vn_upsert_cg_reference_board": {
          const pinned = optionalBoolean(args, "pinned");
          const status = optionalCgReferenceBoardStatus(args);
          const createdBy = optionalCgReferenceBoardCreatedBy(args);
          return {
            ok: true,
            board: repository.upsertCgReferenceBoard({
              worldId: requiredString(args, "worldId"),
              sessionId: optionalString(args, "sessionId") ?? null,
              id: optionalString(args, "id") ?? null,
              kind: asCgReferenceBoardKind(args.kind),
              title: requiredString(args, "title"),
              prompt: requiredString(args, "prompt"),
              imageUrl: optionalString(args, "imageUrl") ?? null,
              ...(pinned === undefined ? {} : { pinned }),
              ...(status ? { status } : {}),
              ...(createdBy ? { createdBy } : {})
            })
          };
        }
        case "vn_attach_cg_reference_board": {
          const board = repository.attachCgReferenceBoardImage({
              worldId: requiredString(args, "worldId"),
              boardId: requiredString(args, "boardId"),
              jobId: optionalString(args, "jobId") ?? null,
              imageUrl: optionalString(args, "imageUrl") ?? null,
              errorMessage: optionalString(args, "errorMessage") ?? null,
              conversationId: optionalString(args, "conversationId") ?? null
          });
          if (board.sessionId) {
            events.onCgChanged?.({ worldId: board.worldId, sessionId: board.sessionId, reason: "reference_board" });
          }
          return {
            ok: true,
            board
          };
        }
        case "vn_claim_next_cg_job": {
          const worldId = optionalString(args, "worldId");
          const sessionId = optionalString(args, "sessionId");
          return {
            ok: true,
            job: repository.claimNextCgJob({
              ...(worldId ? { worldId } : {}),
              ...(sessionId ? { sessionId } : {})
            })
          };
        }
        case "vn_retry_cg_job": {
          const sessionId = optionalString(args, "sessionId");
          return {
            ok: true,
            job: repository.retryCgJob({
              worldId: requiredString(args, "worldId"),
              jobId: requiredString(args, "jobId"),
              ...(sessionId ? { sessionId } : {})
            })
          };
        }
        case "vn_attach_cg_asset": {
          const asset = repository.attachCgAsset({
              assetId: requiredString(args, "assetId"),
              worldId: requiredString(args, "worldId"),
              sessionId: requiredString(args, "sessionId"),
              imageUrl: optionalString(args, "imageUrl") ?? null,
              altText: optionalString(args, "altText") ?? null,
              provider: optionalString(args, "provider") ?? "webgpt",
              errorMessage: optionalString(args, "errorMessage") ?? null,
              conversationId: optionalString(args, "conversationId") ?? null
          });
          events.onCgChanged?.({ worldId: asset.worldId, sessionId: asset.sessionId, reason: "asset" });
          return {
            ok: true,
            asset
          };
        }
        case "vn_upsert_library_doc": {
          const input = libraryInput(args, asLibraryDocKind(args.kind));
          return { ok: true, ...repository.upsertLibraryDoc(input) };
        }
        case "vn_upsert_world_note":
        case "vn_upsert_world_rule":
        case "vn_upsert_system_law":
        case "vn_upsert_style_guide":
        case "vn_upsert_character_card":
        case "vn_upsert_location_card":
        case "vn_upsert_open_thread":
        case "vn_upsert_consequence_note":
        case "vn_upsert_encounter_surface":
        case "vn_upsert_dialogue_stance":
        case "vn_append_continuity_note": {
          const kindByTool: Record<typeof toolName, LibraryDocKind> = {
            vn_upsert_world_note: "world_note",
            vn_upsert_world_rule: "world_rule",
            vn_upsert_system_law: "system_law",
            vn_upsert_style_guide: "style_guide",
            vn_upsert_character_card: "character_card",
            vn_upsert_location_card: "location_card",
            vn_upsert_open_thread: "open_thread",
            vn_upsert_consequence_note: "consequence_note",
            vn_upsert_encounter_surface: "encounter_surface",
            vn_upsert_dialogue_stance: "dialogue_stance",
            vn_append_continuity_note: "continuity_note"
          };
          return {
            ok: true,
            ...repository.upsertLibraryDoc(libraryInput(args, kindByTool[toolName]))
          };
        }
        case "vn_set_library_doc_pinned":
          return repository.setLibraryDocPinned({
            worldId: requiredString(args, "worldId"),
            sessionId: optionalString(args, "sessionId") ?? null,
            docId: requiredString(args, "docId"),
            pinned: requiredBoolean(args, "pinned"),
            createdBy: optionalString(args, "createdBy") === "llm" ? "llm" : "user"
          });
        case "vn_get_save_list":
          return {
            ok: true,
            saves: repository.listSaves(requiredString(args, "worldId"), requiredString(args, "sessionId"))
          };
        case "vn_create_save":
          return {
            ok: true,
            ...repository.createSave({
              worldId: requiredString(args, "worldId"),
              sessionId: requiredString(args, "sessionId"),
              label: optionalString(args, "label") ?? "저장점"
            })
          };
        case "vn_load_save":
          return { ok: true, state: repository.loadSave(requiredString(args, "saveId")) };
        case "vn_link_webgpt_session":
          repository.linkWebgptSession({
            worldId: requiredString(args, "worldId"),
            sessionId: requiredString(args, "sessionId"),
            url: requiredString(args, "url")
          });
          return {
            ok: true
          };
        default:
          return {
            ok: false,
            code: "unknown_tool",
            message: `알 수 없는 커넥터 도구입니다: ${String(toolName)}`
          };
      }
    } catch (error) {
      return toolError(error);
    }
  }

  return {
    names: connectorToolNames,
    call
  };
}
