import { create } from "zustand";
import type {
  CgAssetRecord,
  CgReferenceBoardKind,
  CgReferenceBoardRecord,
  DisplayabilityWarning,
  LibraryDocKind,
  LibraryDocVersion,
  NarrativeLevel,
  ReaderState,
  SaveRecord,
  WebgptJobRecord,
  WorldRecord,
  WorldSummary
} from "../../../../packages/core/src/index.js";
import { callTool, recordActionAndStartWebgpt, startWebgptAuthor, startWebgptCgLane } from "../api/client.js";
import type { WebgptConversationMode } from "../api/client.js";

const ACTIVE_KEY = "vnplayer.activeSession";

type ActiveSession = {
  worldId: string;
  sessionId: string;
};

type StoreState = {
  worlds: WorldSummary[];
  active: ActiveSession | null;
  readerState: ReaderState | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  lastWarnings: DisplayabilityWarning[];
  loadWorlds: () => Promise<void>;
  restoreActive: () => Promise<void>;
  createWorld: (input: { seedText: string; randomSeedEnabled: boolean; randomSeedValue?: string | null; cgStylePrompt?: string | null; title?: string | null }) => Promise<void>;
  openWorld: (worldId: string, sessionId: string) => Promise<void>;
  backToEntry: () => void;
  refreshReader: (options?: { silent?: boolean }) => Promise<void>;
  submitTurn: (turn: unknown) => Promise<void>;
  recordAction: (input: { kind: "choice" | "freeform"; label?: string | null; text: string; conversationMode?: WebgptConversationMode }) => Promise<void>;
  createSave: (label: string) => Promise<void>;
  loadSave: (saveId: string) => Promise<void>;
  linkWebgptSession: (url: string) => Promise<void>;
  updateSessionSettings: (input: { autoCgEnabled?: boolean; narrativeLevel?: NarrativeLevel }) => Promise<void>;
  requestWebgptTurn: (options?: { conversationMode?: WebgptConversationMode }) => Promise<void>;
  prepareCgAsset: (options?: { conversationMode?: WebgptConversationMode }) => Promise<void>;
  retryCgJob: (options?: { conversationMode?: WebgptConversationMode }) => Promise<void>;
  updateWorldTitle: (input: { title: string; subtitle?: string | null; locked: boolean }) => Promise<void>;
  updateCgStylePrompt: (cgStylePrompt: string) => Promise<void>;
  upsertCgReferenceBoard: (input: {
    id?: string | null;
    kind: CgReferenceBoardKind;
    title: string;
    prompt: string;
    imageUrl?: string | null;
    pinned: boolean;
  }) => Promise<void>;
  upsertLibraryDoc: (input: {
    kind: LibraryDocKind;
    title: string;
    body: unknown;
    visibleToLlm: boolean;
    visibleToPlayer: boolean;
  }) => Promise<void>;
  setLibraryDocPinned: (docId: string, pinned: boolean) => Promise<void>;
};

function saveActive(active: ActiveSession | null): void {
  if (!active) {
    localStorage.removeItem(ACTIVE_KEY);
    return;
  }
  localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
}

function readActive(): ActiveSession | null {
  const raw = localStorage.getItem(ACTIVE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ActiveSession>;
    if (typeof parsed.worldId === "string" && typeof parsed.sessionId === "string") {
      return { worldId: parsed.worldId, sessionId: parsed.sessionId };
    }
  } catch {
    localStorage.removeItem(ACTIVE_KEY);
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "알 수 없는 오류";
}

function cgAssetNotice(asset: CgAssetRecord): string {
  switch (asset.status) {
    case "attached":
      return "이미 이 장면의 CG가 붙어 있습니다.";
    case "failed":
      return "이 장면 CG 요청이 실패했습니다. 다시 시도할 수 있습니다.";
    case "waiting_reference":
      return "참조 이미지가 준비되면 이 장면 CG를 이어서 만듭니다.";
    case "requested":
      return "이 장면 CG를 요청했습니다. 완성되면 자동으로 붙습니다.";
  }
}

const libraryKindLabels: Record<LibraryDocKind, string> = {
  world_note: "세계 메모",
  world_rule: "세계 법칙",
  system_law: "작동 법칙",
  style_guide: "문체 가이드",
  character_card: "인물 카드",
  faction_card: "세력 카드",
  item_card: "사물 카드",
  continuity_note: "연속성 메모",
  location_card: "장소 카드",
  relationship_note: "관계 메모",
  open_thread: "열린 실마리",
  consequence_note: "후과 메모",
  encounter_surface: "장면 표면",
  dialogue_stance: "대화 태도",
  motif_note: "모티프 메모",
  editorial_note: "편집 메모",
  retcon_note: "정정 메모",
  reader_preference: "독자 취향",
  writer_prompt: "집필 프롬프트",
  tool_use_policy: "도구 사용 정책"
};

export const useVNStore = create<StoreState>((set, get) => ({
  worlds: [],
  active: null,
  readerState: null,
  loading: false,
  error: null,
  notice: null,
  lastWarnings: [],

  async loadWorlds() {
    set({ loading: true, error: null, notice: null });
    try {
      const result = await callTool<{ worlds: WorldSummary[] }>("vn_list_worlds");
      set({ worlds: result.worlds, loading: false });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async restoreActive() {
    const active = readActive();
    if (!active) {
      await get().loadWorlds();
      return;
    }
    try {
      await get().openWorld(active.worldId, active.sessionId);
    } catch {
      saveActive(null);
      await get().loadWorlds();
    }
  },

  async createWorld(input) {
    set({ loading: true, error: null, notice: null, lastWarnings: [] });
    try {
      const result = await callTool<{ worldId: string; sessionId: string }>("vn_create_world", input);
      await get().openWorld(result.worldId, result.sessionId);
      await startWebgptAuthor(result.worldId, result.sessionId);
      await get().refreshReader({ silent: true });
      set({ loading: false, notice: "세계가 열렸습니다. WebGPT가 첫 장면을 쓰고 있습니다." });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async openWorld(worldId, sessionId) {
    set({ loading: true, error: null, notice: null, lastWarnings: [] });
    const result = await callTool<{ state: ReaderState }>("vn_get_reader_state", { worldId, sessionId });
    const active = { worldId, sessionId };
    saveActive(active);
    set({
      active,
      readerState: result.state,
      loading: false,
      error: null
    });
    await get().loadWorlds();
  },

  backToEntry() {
    saveActive(null);
    set({ active: null, readerState: null, notice: null, lastWarnings: [] });
    void get().loadWorlds();
  },

  async refreshReader(options = {}) {
    const active = get().active;
    if (!active) {
      return;
    }
    set(options.silent ? { error: null, notice: null } : { loading: true, error: null, notice: null });
    try {
      const result = await callTool<{ state: ReaderState }>("vn_get_reader_state", active);
      set(options.silent ? { readerState: result.state } : { readerState: result.state, loading: false });
    } catch (error) {
      set(options.silent ? { error: errorMessage(error) } : { error: errorMessage(error), loading: false });
      throw error;
    }
  },

  async submitTurn(turn) {
    const active = get().active;
    if (!active) {
      return;
    }
    set({ loading: true, error: null, notice: null, lastWarnings: [] });
    try {
      const result = await callTool<{ turnId: string; warnings: DisplayabilityWarning[] }>("vn_submit_turn", {
        ...active,
        source: "llm",
        turn
      });
      await get().refreshReader();
      set({
        loading: false,
        notice: `장면을 받았습니다: ${result.turnId}`,
        lastWarnings: result.warnings
      });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async recordAction(input) {
    const state = get().readerState;
    if (!state?.currentTurn) {
      set({ error: "선택을 건넬 활성 턴이 없습니다." });
      return;
    }
    const active = {
      worldId: state.world.id,
      sessionId: state.session.id
    };
    set({ loading: true, error: null, notice: null });
    try {
      await recordActionAndStartWebgpt({
        ...active,
        turnId: state.currentTurn.id,
        ...input
      });
      await get().refreshReader({ silent: true });
      set({
        loading: false,
        notice: input.kind === "choice" ? "선택을 보냈습니다. WebGPT가 다음 장면을 쓰고 있습니다." : "행동을 보냈습니다. WebGPT가 다음 장면을 쓰고 있습니다."
      });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async createSave(label) {
    const active = get().active;
    if (!active) {
      return;
    }
    set({ loading: true, error: null, notice: null });
    try {
      await callTool<{ saveId: string }>("vn_create_save", { ...active, label });
      await get().refreshReader();
      set({ loading: false, notice: "책갈피를 꽂았습니다." });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async loadSave(saveId) {
    set({ loading: true, error: null, notice: null, lastWarnings: [] });
    try {
      const result = await callTool<{ state: ReaderState }>("vn_load_save", { saveId });
      const active = { worldId: result.state.world.id, sessionId: result.state.session.id };
      saveActive(active);
      set({
        active,
        readerState: result.state,
        loading: false,
        notice: "책갈피에서 다시 열었습니다."
      });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async linkWebgptSession(url) {
    const active = get().active;
    if (!active) {
      return;
    }
    set({ loading: true, error: null, notice: null });
    try {
      await callTool<{ ok: true }>("vn_link_webgpt_session", { ...active, url });
      await get().refreshReader();
      set({ loading: false, notice: "WebGPT 세션 URL을 복구 정보로 보관했습니다." });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async updateSessionSettings(input) {
    const active = get().active;
    if (!active) {
      return;
    }
    const previousReaderState = get().readerState;
    if (previousReaderState) {
      set({
        error: null,
        readerState: {
          ...previousReaderState,
          session: {
            ...previousReaderState.session,
            ...(input.autoCgEnabled === undefined ? {} : { autoCgEnabled: input.autoCgEnabled }),
            ...(input.narrativeLevel === undefined ? {} : { narrativeLevel: input.narrativeLevel })
          }
        }
      });
    } else {
      set({ error: null });
    }
    try {
      const result = await callTool<{ session: ReaderState["session"] }>("vn_update_session_settings", { ...active, ...input });
      const currentReaderState = get().readerState;
      set({
        error: null,
        readerState: currentReaderState
          ? {
              ...currentReaderState,
              session: result.session
            }
          : currentReaderState
      });
    } catch (error) {
      set({ error: errorMessage(error), readerState: previousReaderState });
    }
  },

  async requestWebgptTurn(options = {}) {
    const active = get().active;
    if (!active) {
      return;
    }
    set({ loading: true, error: null, notice: null });
    try {
      const result = await startWebgptAuthor(active.worldId, active.sessionId, options);
      await get().refreshReader({ silent: true });
      set({
        loading: false,
        notice: result.dispatchId
          ? `WebGPT 작업을 시작했습니다: ${result.dispatchId}`
          : "WebGPT에 다음 장면을 맡겼습니다. 도착하면 화면이 자동으로 바뀝니다."
      });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async prepareCgAsset(options = {}) {
    const state = get().readerState;
    if (!state?.currentTurn) {
      set({ error: "CG를 준비할 활성 턴이 없습니다." });
      return;
    }
    const active = {
      worldId: state.world.id,
      sessionId: state.session.id
    };
    set({ loading: true, error: null, notice: null });
    try {
      const result = await callTool<{ asset: CgAssetRecord }>("vn_prepare_cg_asset", {
        ...active,
        turnId: state.currentTurn.id
      });
      if (result.asset.status === "requested" || result.asset.status === "waiting_reference") {
        await startWebgptCgLane(active.worldId, active.sessionId, 2, options.conversationMode ? { conversationMode: options.conversationMode } : {});
      }
      await get().refreshReader({ silent: true });
      set({ loading: false, notice: cgAssetNotice(result.asset) });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async retryCgJob(options = {}) {
    const state = get().readerState;
    const asset = state?.currentCgAsset;
    if (!state?.currentTurn || !asset) {
      set({ error: "재시도할 CG 요청이 없습니다." });
      return;
    }
    if (asset.status !== "failed" || !asset.jobId) {
      set({ error: "실패한 CG job만 다시 시도할 수 있습니다." });
      return;
    }
    set({ loading: true, error: null, notice: null });
    try {
      await callTool<{ job: WebgptJobRecord }>("vn_retry_cg_job", {
        worldId: state.world.id,
        sessionId: state.session.id,
        jobId: asset.jobId
      });
      await startWebgptCgLane(state.world.id, state.session.id, 1, options.conversationMode ? { conversationMode: options.conversationMode } : {});
      await get().refreshReader({ silent: true });
      set({ loading: false, notice: "실패한 CG를 다시 큐에 올렸습니다. 완성되면 자동으로 붙습니다." });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async updateWorldTitle(input) {
    const active = get().active;
    if (!active) {
      return;
    }
    set({ loading: true, error: null, notice: null });
    try {
      await callTool<{ world: WorldRecord }>("vn_update_world_title", {
        ...active,
        title: input.title,
        subtitle: input.subtitle ?? null,
        locked: input.locked
      });
      await get().refreshReader({ silent: true });
      await get().loadWorlds();
      set({ loading: false, notice: input.locked ? "세계 이름을 고정했습니다." : "세계 이름을 저장했습니다." });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async updateCgStylePrompt(cgStylePrompt) {
    const active = get().active;
    if (!active) {
      return;
    }
    set({ loading: true, error: null, notice: null });
    try {
      await callTool<{ world: WorldRecord }>("vn_update_world_cg_style_prompt", {
        ...active,
        cgStylePrompt
      });
      await get().refreshReader({ silent: true });
      set({ loading: false, notice: "CG 그림체를 저장했습니다. 다음 이미지 의뢰부터 이 설정을 사용합니다." });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async upsertCgReferenceBoard(input) {
    const active = get().active;
    if (!active) {
      return;
    }
    set({ loading: true, error: null, notice: null });
    try {
      await callTool<{ board: CgReferenceBoardRecord }>("vn_upsert_cg_reference_board", {
        worldId: active.worldId,
        sessionId: active.sessionId,
        createdBy: "user",
        status: "active",
        ...input
      });
      await get().refreshReader({ silent: true });
      set({ loading: false, notice: "CG 참조 보드를 저장했습니다. 다음 이미지 의뢰부터 반영됩니다." });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async upsertLibraryDoc(input) {
    const active = get().active;
    if (!active) {
      return;
    }
    set({ loading: true, error: null, notice: null });
    try {
      await callTool<{ docId: string; versionId: string }>("vn_upsert_library_doc", {
        worldId: active.worldId,
        sessionId: active.sessionId,
        createdBy: "user",
        ...input
      });
      await get().refreshReader();
      set({ loading: false, notice: "라이브러리 문서를 보관했습니다." });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  },

  async setLibraryDocPinned(docId, pinned) {
    const active = get().active;
    if (!active) {
      return;
    }
    set({ loading: true, error: null, notice: null });
    try {
      await callTool<{ ok: true }>("vn_set_library_doc_pinned", {
        ...active,
        docId,
        pinned,
        createdBy: "user"
      });
      await get().refreshReader();
      set({ loading: false, notice: pinned ? "문서를 다음 장면 문맥에 고정했습니다." : "문서 고정을 풀었습니다." });
    } catch (error) {
      set({ error: errorMessage(error), loading: false });
    }
  }
}));

export function saveLabelFor(save: SaveRecord): string {
  return `${save.label} (${new Date(save.createdAt).toLocaleString()})`;
}

export function docLabelFor(doc: LibraryDocVersion): string {
  return `${doc.title} · ${libraryKindLabels[doc.kind]}`;
}
