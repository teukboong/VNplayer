import { useEffect, useMemo, useRef, useState } from "react";
import { defaultCgStylePrompt } from "../../../../packages/core/src/index.js";
import type { CgAssetRecord, CgReferenceBoardKind, DetailLevel, LibraryDocKind, NarrativeLevel, StoryInterface } from "../../../../packages/core/src/index.js";
import type { WebgptConversationMode } from "../api/client.js";
import { docLabelFor, saveLabelFor, useVNStore } from "../state/useVNStore.js";

const libraryKinds: LibraryDocKind[] = [
  "world_note",
  "world_rule",
  "system_law",
  "style_guide",
  "character_card",
  "faction_card",
  "item_card",
  "continuity_note",
  "location_card",
  "relationship_note",
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

const cgBoardKindLabels: Record<CgReferenceBoardKind, string> = {
  world_mood: "무드보드",
  character: "캐릭터 보드",
  location: "장소 보드",
  object: "사물 보드",
  negative: "금지 보드"
};

const cgBoardKinds = Object.keys(cgBoardKindLabels) as CgReferenceBoardKind[];
const narrativeLevels = [1, 2, 3] as const;
const narrativeLevelLabels: Record<NarrativeLevel, string> = {
  1: "느림",
  2: "보통",
  3: "빠름"
};
const detailLevels = [1, 2, 3] as const;
const detailLevelLabels: Record<DetailLevel, string> = {
  1: "간결",
  2: "표준",
  3: "풍부"
};

function parseSubmission(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(error instanceof Error ? `JSON을 읽지 못했습니다: ${error.message}` : "JSON을 읽지 못했습니다.");
  }
}

function parseDocBody(text: string): unknown {
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function sessionLabelFor(label: string): string {
  return label === "Main Session" ? "메인 세션" : label;
}

function dispatchStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "진행 중";
    case "succeeded":
      return "완료";
    case "failed":
      return "실패";
    default:
      return status;
  }
}

function formatTurnStamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function compactExcerpt(value: string | null | undefined, fallback: string): string {
  const text = (value || fallback).replace(/\s+/g, " ").trim();
  return text.length > 96 ? `${text.slice(0, 96)}...` : text;
}

function localConnectorOrigin(): { origin: string; publicHttps: boolean; label: string } {
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const isLocalHost = localHosts.has(window.location.hostname);
  if (isLocalHost && window.location.port === "4173") {
    return {
      origin: "http://127.0.0.1:4174",
      publicHttps: false,
      label: "로컬 백엔드"
    };
  }
  return {
    origin: window.location.origin,
    publicHttps: window.location.protocol === "https:" && !isLocalHost,
    label: window.location.protocol === "https:" && !isLocalHost ? "Tailscale HTTPS" : "로컬 미리보기"
  };
}

function connectorLabelFor(origin: string): string {
  try {
    const parsed = new URL(origin);
    if (parsed.hostname.includes("workers.dev")) {
      return "Cloudflare MCP";
    }
    if (parsed.protocol === "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      return "외부 HTTPS MCP";
    }
  } catch {
    return "커넥터";
  }
  return "로컬 백엔드";
}

function debugToolsEnabled(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("debug") === "1" || localStorage.getItem("vnplayer.debugTools") === "1";
}

export function App() {
  const {
    worlds,
    active,
    readerState,
    loading,
    error,
    notice,
    lastWarnings,
    restoreActive,
    refreshReader,
    createWorld,
    openWorld,
    backToEntry,
    submitTurn,
    recordAction,
    createSave,
    loadSave,
    linkWebgptSession,
    updateSessionSettings,
    requestWebgptTurn,
    prepareCgAsset,
    retryCgJob,
    updateWorldTitle,
    updateCgStylePrompt,
    upsertCgReferenceBoard,
    upsertLibraryDoc,
    setLibraryDocPinned
  } = useVNStore();

  useEffect(() => {
    void restoreActive();
  }, [restoreActive]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timeout = window.setTimeout(() => {
      if (useVNStore.getState().notice === notice) {
        useVNStore.setState({ notice: null });
      }
    }, 4200);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [notice]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const params = new URLSearchParams({ worldId: active.worldId, sessionId: active.sessionId });
    const events = new EventSource(`/api/events?${params.toString()}`);
    events.addEventListener("turn_submitted", () => {
      void refreshReader({ silent: true }).catch(() => undefined);
    });
    events.addEventListener("webgpt_dispatch_changed", () => {
      void refreshReader({ silent: true }).catch(() => undefined);
    });
    events.addEventListener("cg_lane_changed", () => {
      void refreshReader({ silent: true }).catch(() => undefined);
    });
    return () => {
      events.close();
    };
  }, [active, refreshReader]);

  return (
    <main className={`shell ${active ? "shell-reader" : "shell-entry"}`}>
      <header className="topbar">
        <div>
          <p className="eyebrow">VNplayer</p>
          <h1>{active ? "세계 접속 중" : "세계 접속"}</h1>
        </div>
        {active ? (
          <button className="ghost" type="button" onClick={backToEntry}>
            세계 목록
          </button>
        ) : null}
      </header>

      {error ? <div className="banner error">{error}</div> : null}
      {notice ? <div className="banner notice">{notice}</div> : null}

      {active && readerState ? (
        <ReaderScreen
          state={readerState}
          loading={loading}
          lastWarnings={lastWarnings}
          onRefreshReader={refreshReader}
          onSubmitTurn={submitTurn}
          onRecordAction={recordAction}
          onCreateSave={createSave}
          onLoadSave={loadSave}
          onLinkWebgptSession={linkWebgptSession}
          onUpdateSessionSettings={updateSessionSettings}
          onRequestWebgptTurn={requestWebgptTurn}
          onPrepareCgAsset={prepareCgAsset}
          onRetryCgJob={retryCgJob}
          onUpdateWorldTitle={updateWorldTitle}
          onUpdateCgStylePrompt={updateCgStylePrompt}
          onUpsertCgReferenceBoard={upsertCgReferenceBoard}
          onUpsertLibraryDoc={upsertLibraryDoc}
          onSetLibraryDocPinned={setLibraryDocPinned}
        />
      ) : (
        <EntryScreen worlds={worlds} loading={loading} onCreateWorld={createWorld} onOpenWorld={openWorld} />
      )}
    </main>
  );
}

function EntryScreen(props: {
  worlds: ReturnType<typeof useVNStore.getState>["worlds"];
  loading: boolean;
  onCreateWorld: (input: { seedText: string; randomSeedEnabled: boolean; randomSeedValue?: string | null; cgStylePrompt?: string | null; title?: string | null }) => Promise<void>;
  onOpenWorld: (worldId: string, sessionId: string) => Promise<void>;
}) {
  const [seedText, setSeedText] = useState("");
  const [randomSeedEnabled, setRandomSeedEnabled] = useState(true);
  const [randomSeedValue, setRandomSeedValue] = useState("");
  const [cgStylePrompt, setCgStylePrompt] = useState(defaultCgStylePrompt);
  const [entryMode, setEntryMode] = useState<"new" | "existing">("new");
  const seedFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const worldListRef = useRef<HTMLDivElement | null>(null);

  const focusNewWorld = () => {
    setEntryMode("new");
    window.requestAnimationFrame(() => seedFieldRef.current?.focus());
  };

  const focusExistingWorlds = () => {
    setEntryMode("existing");
    window.requestAnimationFrame(() => {
      worldListRef.current?.scrollIntoView({ block: "nearest" });
      worldListRef.current?.querySelector<HTMLButtonElement>(".world-row:not(:disabled)")?.focus();
    });
  };

  return (
    <section className={`entry-grid entry-mode-${entryMode}`} aria-label="세계 진입">
      <form
        className="panel entry-form"
        onSubmit={(event) => {
          event.preventDefault();
          void props.onCreateWorld({
            seedText,
            randomSeedEnabled,
            randomSeedValue: randomSeedEnabled ? randomSeedValue.trim() || null : null,
            cgStylePrompt: cgStylePrompt.trim() || null
          });
        }}
      >
        <div className="section-title">
          <p className="entry-brand">VNplayer</p>
        </div>
        <div className="entry-choice-row" aria-label="세계 진입 방식">
          <button
            className={`entry-choice-card ${entryMode === "new" ? "is-active" : ""}`}
            type="button"
            aria-pressed={entryMode === "new"}
            onClick={focusNewWorld}
          >
            <strong>새 세계</strong>
            <span>새로운 세계를 만들고 이야기를 시작한다.</span>
          </button>
          <button
            className={`entry-choice-card ${entryMode === "existing" ? "is-active" : ""}`}
            type="button"
            aria-pressed={entryMode === "existing"}
            onClick={focusExistingWorlds}
          >
            <strong>기존 세계</strong>
            <span>저장된 세계를 불러와 이야기를 계속한다.</span>
          </button>
        </div>
        <div className={`entry-rollout new-world-rollout ${entryMode === "new" ? "is-expanded" : ""}`} aria-hidden={entryMode !== "new"}>
          <label className="field">
            <span>세계관 시드</span>
            <textarea
              ref={seedFieldRef}
              value={seedText}
              disabled={entryMode !== "new"}
              onChange={(event) => setSeedText(event.target.value)}
              placeholder="전제, 분위기, 시작 상황, 제약을 적는다"
              rows={10}
              required
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={randomSeedEnabled}
              disabled={entryMode !== "new"}
              onChange={(event) => setRandomSeedEnabled(event.target.checked)}
            />
            <span>랜덤 시드 사용</span>
          </label>
          <label className="field">
            <span>랜덤 시드 값</span>
            <input
              value={randomSeedValue}
              disabled={entryMode !== "new" || !randomSeedEnabled}
              onChange={(event) => setRandomSeedValue(event.target.value)}
              placeholder="비워두면 자동으로 정해짐"
            />
          </label>
          <details className="prompt-details">
            <summary>CG 그림체</summary>
            <label className="field">
              <span>기본 이미지 프롬프트</span>
              <textarea
                value={cgStylePrompt}
                disabled={entryMode !== "new"}
                onChange={(event) => setCgStylePrompt(event.target.value)}
                placeholder={defaultCgStylePrompt}
                rows={6}
              />
            </label>
            <button
              className="ghost small-button"
              type="button"
              disabled={entryMode !== "new"}
              onClick={() => setCgStylePrompt(defaultCgStylePrompt)}
            >
              기본값으로
            </button>
          </details>
          <button className="primary" type="submit" disabled={props.loading || entryMode !== "new"}>
            세계 열기
          </button>
        </div>
      </form>

      <section className={`panel existing-panel entry-rollout ${entryMode === "existing" ? "is-expanded" : ""}`} aria-label="기존 세계" aria-hidden={entryMode !== "existing"}>
        <div className="section-title">
          <p className="eyebrow">기존 세계</p>
          <h2>저장된 세계 이어가기</h2>
        </div>
        {props.worlds.length === 0 ? (
          <p className="muted">저장된 세계 없음</p>
        ) : (
          <div className="world-list" ref={worldListRef}>
            {props.worlds.map((world) => (
              <button
                className="world-row"
                type="button"
                key={world.worldId}
                disabled={entryMode !== "existing" || !world.latestSessionId || props.loading}
                onClick={() => world.latestSessionId && void props.onOpenWorld(world.worldId, world.latestSessionId)}
              >
                <strong>{world.title}</strong>
                <span>{world.seedPreview}</span>
                <small>
                  {new Date(world.updatedAt).toLocaleString()}
                  {world.hasWebgptSessionUrl ? " · WebGPT 복구 가능" : ""}
                </small>
              </button>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function ReaderScreen(props: {
  state: NonNullable<ReturnType<typeof useVNStore.getState>["readerState"]>;
  loading: boolean;
  lastWarnings: ReturnType<typeof useVNStore.getState>["lastWarnings"];
  onRefreshReader: () => Promise<void>;
  onSubmitTurn: (turn: unknown) => Promise<void>;
  onRecordAction: (input: { kind: "choice" | "freeform"; label?: string | null; text: string; conversationMode?: WebgptConversationMode }) => Promise<void>;
  onCreateSave: (label: string) => Promise<void>;
  onLoadSave: (saveId: string) => Promise<void>;
  onLinkWebgptSession: (url: string) => Promise<void>;
  onUpdateSessionSettings: (input: { autoCgEnabled?: boolean; narrativeLevel?: NarrativeLevel; detailLevel?: DetailLevel }) => Promise<void>;
  onRequestWebgptTurn: (options?: { conversationMode?: WebgptConversationMode }) => Promise<void>;
  onPrepareCgAsset: (options?: { conversationMode?: WebgptConversationMode }) => Promise<void>;
  onRetryCgJob: (options?: { conversationMode?: WebgptConversationMode }) => Promise<void>;
  onUpdateWorldTitle: (input: { title: string; subtitle?: string | null; locked: boolean }) => Promise<void>;
  onUpdateCgStylePrompt: (cgStylePrompt: string) => Promise<void>;
  onUpsertCgReferenceBoard: (input: {
    id?: string | null;
    kind: CgReferenceBoardKind;
    title: string;
    prompt: string;
    imageUrl?: string | null;
    pinned: boolean;
  }) => Promise<void>;
  onUpsertLibraryDoc: (input: {
    kind: LibraryDocKind;
    title: string;
    body: unknown;
    visibleToLlm: boolean;
    visibleToPlayer: boolean;
  }) => Promise<void>;
  onSetLibraryDocPinned: (docId: string, pinned: boolean) => Promise<void>;
}) {
  const [freeform, setFreeform] = useState("");
  const [turnJson, setTurnJson] = useState("");
  const [turnParseError, setTurnParseError] = useState<string | null>(null);
  const [saveLabel, setSaveLabel] = useState("책갈피");
  const [webgptUrl, setWebgptUrl] = useState(props.state.session.webgptSessionUrl ?? "");
  const [webgptConversationMode, setWebgptConversationMode] = useState<WebgptConversationMode>("resume");
  const [cgConversationMode, setCgConversationMode] = useState<WebgptConversationMode>("resume");
  const [worldTitle, setWorldTitle] = useState(props.state.world.title);
  const [worldSubtitle, setWorldSubtitle] = useState(props.state.world.subtitle ?? "");
  const [worldTitleLocked, setWorldTitleLocked] = useState(props.state.world.titleLocked);
  const [connectorStatus, setConnectorStatus] = useState("확인 중");
  const [docKind, setDocKind] = useState<LibraryDocKind>("world_note");
  const [docTitle, setDocTitle] = useState("");
  const [docBody, setDocBody] = useState("");
  const [cgStylePrompt, setCgStylePrompt] = useState(props.state.world.cgStylePrompt);
  const [cgBoardKind, setCgBoardKind] = useState<CgReferenceBoardKind>("world_mood");
  const [cgBoardTitle, setCgBoardTitle] = useState("");
  const [cgBoardPrompt, setCgBoardPrompt] = useState("");
  const [cgBoardImageUrl, setCgBoardImageUrl] = useState("");
  const [cgBoardPinned, setCgBoardPinned] = useState(true);
  const [sideOpen, setSideOpen] = useState(false);
  const [textPanelsOpen, setTextPanelsOpen] = useState(true);
  const [narrativeLogOpen, setNarrativeLogOpen] = useState(false);
  const [currentCgImageUsable, setCurrentCgImageUsable] = useState(true);
  const [backgroundCgImageUsable, setBackgroundCgImageUsable] = useState(true);
  const proseBlockRef = useRef<HTMLDivElement | null>(null);

  const current = props.state.currentTurn?.displayShape.turn;
  const currentTurnId = props.state.currentTurn?.id ?? null;
  const currentCgAsset = current ? props.state.currentCgAsset : null;
  const currentCgImageUrl = currentCgAsset?.imageUrl?.trim() ?? "";
  const backgroundCgAsset = current ? props.state.backgroundCgAsset ?? currentCgAsset : null;
  const backgroundCgImageUrl = backgroundCgAsset?.imageUrl?.trim() ?? "";
  const webgptRunning = props.state.activeWebgptDispatch?.status === "running";
  const showDebugTools = useMemo(debugToolsEnabled, []);
  const [connectorSurface, setConnectorSurface] = useState(localConnectorOrigin);

  useEffect(() => {
    setWebgptUrl(props.state.session.webgptSessionUrl ?? "");
  }, [props.state.session.webgptSessionUrl]);

  const consumeWebgptConversationMode = () => {
    const mode = webgptConversationMode;
    if (mode === "new") {
      setWebgptConversationMode("resume");
    }
    return mode;
  };

  const consumeCgConversationMode = () => {
    const mode = cgConversationMode;
    if (mode === "new") {
      setCgConversationMode("resume");
    }
    return mode;
  };

  useEffect(() => {
    setWorldTitle(props.state.world.title);
    setWorldSubtitle(props.state.world.subtitle ?? "");
    setWorldTitleLocked(props.state.world.titleLocked);
  }, [props.state.world.title, props.state.world.subtitle, props.state.world.titleLocked]);

  useEffect(() => {
    setCgStylePrompt(props.state.world.cgStylePrompt);
  }, [props.state.world.cgStylePrompt]);

  useEffect(() => {
    setCurrentCgImageUsable(true);
  }, [currentCgImageUrl]);

  useEffect(() => {
    setBackgroundCgImageUsable(true);
  }, [backgroundCgImageUrl]);

  useEffect(() => {
    proseBlockRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [currentTurnId]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/webgpt/manifest")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((manifest: { baseUrl?: string }) => {
        if (!cancelled) {
          if (manifest.baseUrl) {
            setConnectorSurface({
              origin: manifest.baseUrl,
              publicHttps: manifest.baseUrl.startsWith("https://"),
              label: connectorLabelFor(manifest.baseUrl)
            });
          }
          setConnectorStatus("준비되었습니다");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConnectorStatus("연결되지 않았습니다");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className={`reader-layout ${textPanelsOpen ? "" : "is-text-hidden"}`}>
      {current ? (
        <section
          className={`cg-lane ${backgroundCgImageUrl ? "has-cg" : "is-empty"} ${
            backgroundCgAsset?.turnId && backgroundCgAsset.turnId !== currentTurnId ? "is-carryover" : ""
          }`}
          aria-label="CG 레인"
        >
          {backgroundCgImageUrl ? (
            <img
              className={backgroundCgImageUsable ? undefined : "is-low-resolution"}
              src={backgroundCgImageUrl}
              alt={backgroundCgAsset?.altText ?? "장면 CG"}
              onLoad={(event) => {
                const image = event.currentTarget;
                setBackgroundCgImageUsable(image.naturalWidth >= 64 && image.naturalHeight >= 64);
              }}
              onError={() => setBackgroundCgImageUsable(false)}
            />
          ) : null}
        </section>
      ) : null}
      <button
        className="reader-panel-toggle"
        type="button"
        onClick={() => setTextPanelsOpen((open) => !open)}
        aria-pressed={!textPanelsOpen}
      >
        {textPanelsOpen ? "본문 숨기기" : "본문 열기"}
      </button>
      <article className={`reader-surface ${narrativeLogOpen ? "is-log-open" : ""}`} aria-label="읽기 화면">
        <div className="reader-heading">
          <div>
            <p className="eyebrow">세계</p>
            <h2>{props.state.world.title}</h2>
            {props.state.world.subtitle ? <p className="world-subtitle">{props.state.world.subtitle}</p> : null}
          </div>
          <div className="session-meta">
            <span>{sessionLabelFor(props.state.session.label)}</span>
            {props.state.session.webgptSessionUrl ? (
              <a href={props.state.session.webgptSessionUrl} target="_blank" rel="noreferrer">
                WebGPT 복구
              </a>
            ) : null}
            <button
              className="ghost small-button"
              type="button"
              disabled={props.loading}
              onClick={() => void props.onRefreshReader().catch(() => undefined)}
            >
              새로고침
            </button>
          </div>
          <div className="reader-options" aria-label="작성 설정">
            <label className="check-row compact-check">
              <input
                type="checkbox"
                checked={props.state.session.autoCgEnabled}
                disabled={props.loading || webgptRunning}
                onChange={(event) => void props.onUpdateSessionSettings({ autoCgEnabled: event.target.checked })}
              />
              <span>자동 CG</span>
            </label>
            <div className="narrative-level-control" aria-label="전개 속도">
              <span>전개</span>
              <div className="narrative-level-slider" data-level={props.state.session.narrativeLevel}>
                <span className="narrative-level-thumb" aria-hidden="true" />
                {narrativeLevels.map((level) => (
                  <button
                    key={level}
                    className={props.state.session.narrativeLevel === level ? "is-active" : undefined}
                    type="button"
                    aria-label={`전개 속도 ${level}: ${narrativeLevelLabels[level]}`}
                    aria-pressed={props.state.session.narrativeLevel === level}
                    disabled={props.loading || webgptRunning}
                    onClick={() => void props.onUpdateSessionSettings({ narrativeLevel: level })}
                  >
                    <span>{level}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="narrative-level-control" aria-label="묘사 밀도">
              <span>묘사</span>
              <div className="narrative-level-slider" data-level={props.state.session.detailLevel}>
                <span className="narrative-level-thumb" aria-hidden="true" />
                {detailLevels.map((level) => (
                  <button
                    key={level}
                    className={props.state.session.detailLevel === level ? "is-active" : undefined}
                    type="button"
                    aria-label={`묘사 밀도 ${level}: ${detailLevelLabels[level]}`}
                    aria-pressed={props.state.session.detailLevel === level}
                    disabled={props.loading || webgptRunning}
                    onClick={() => void props.onUpdateSessionSettings({ detailLevel: level })}
                  >
                    <span>{level}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className={`reader-content ${narrativeLogOpen ? "is-log-open" : ""}`}>
          <section className={`story-pane ${narrativeLogOpen ? "is-log-open" : ""}`} aria-label="본문">
            {current ? (
              <div className="prose-block" ref={proseBlockRef}>
                {current.scene.speaker ? <p className="speaker">{current.scene.speaker}</p> : null}
                {current.scene.paragraphs.map((paragraph, index) => (
                  <p key={`${currentTurnId ?? "turn"}-${index}`}>{paragraph}</p>
                ))}
                <div className="scene-tags">
                  {current.scene.background ? <span>{current.scene.background}</span> : null}
                  {current.scene.mood ? <span>{current.scene.mood}</span> : null}
                  {current.concreteDelta ? <span>{current.concreteDelta}</span> : null}
                </div>
                {currentCgImageUrl && currentCgImageUsable ? (
                  <figure className="inline-cg-frame">
                    <img
                      src={currentCgImageUrl}
                      alt={currentCgAsset?.altText ?? "현재 장면 CG"}
                      loading="lazy"
                      decoding="async"
                      onLoad={(event) => {
                        const image = event.currentTarget;
                        setCurrentCgImageUsable(image.naturalWidth >= 64 && image.naturalHeight >= 64);
                      }}
                      onError={() => setCurrentCgImageUsable(false)}
                    />
                  </figure>
                ) : null}
                <TurnCgControl
                  asset={currentCgAsset}
                  imageVisible={Boolean(currentCgImageUrl && currentCgImageUsable)}
                  loading={props.loading}
                  cgSessionUrl={props.state.cgSessionUrl ?? null}
                  conversationMode={cgConversationMode}
                  onConversationModeChange={setCgConversationMode}
                  onPrepare={() => props.onPrepareCgAsset({ conversationMode: consumeCgConversationMode() })}
                  onRetry={() => props.onRetryCgJob({ conversationMode: consumeCgConversationMode() })}
                />
              </div>
            ) : (
              <div className="empty-turn">
                <h3>아직 첫 장면이 도착하지 않았습니다</h3>
                <p>세계는 열렸고, 첫 문장이 내려앉을 자리는 비어 있다.</p>
              </div>
            )}

            {current?.interface ? <TurnInterface turnInterface={current.interface} /> : null}

            <NarrativeLog
              turns={props.state.visibleHistory}
              currentTurnId={currentTurnId}
              onOpenChange={setNarrativeLogOpen}
            />

            {props.state.latestPlayerAction ? (
              <div className="action-strip">
                최근 선택: <strong>{props.state.latestPlayerAction.text}</strong>
              </div>
            ) : null}
          </section>

          <section className="choice-pane" aria-label="선택과 행동">
            <div className="choice-pane-heading">
              <p className="eyebrow">선택</p>
              <h3>다음 움직임</h3>
            </div>

            <div className="choices" aria-label="선택지">
              {current?.choices.length ? (
                current.choices.map((choice) => (
                  <button
                    type="button"
                    key={`${choice.label}-${choice.action}`}
                    disabled={props.loading || webgptRunning}
                    onClick={() => void props.onRecordAction({ kind: "choice", label: choice.label, text: choice.action, conversationMode: consumeWebgptConversationMode() })}
                  >
                    <span>
                      {choice.tag ? <em>{choice.tag}</em> : null}
                      {choice.label}
                    </span>
                    {choice.intent ? <q>{choice.intent}</q> : null}
                    <small>{choice.action}</small>
                  </button>
                ))
              ) : (
                <p className="muted">아직 선택지가 없습니다. 자유 행동으로 다음 순간을 건넬 수 있습니다.</p>
              )}
            </div>

            <form
              className="freeform-row"
              onSubmit={(event) => {
                event.preventDefault();
                void props.onRecordAction({ kind: "freeform", text: freeform, conversationMode: consumeWebgptConversationMode() }).then(() => setFreeform(""));
              }}
            >
              <label className="field">
                <span>자유 행동</span>
                <input
                  value={freeform}
                  disabled={!props.state.currentTurn || props.loading || webgptRunning}
                  onChange={(event) => setFreeform(event.target.value)}
                  placeholder="다음 순간에 할 일을 적는다"
                />
              </label>
              <button className="secondary" type="submit" disabled={!freeform.trim() || props.loading || webgptRunning || !props.state.currentTurn}>
                전하기
              </button>
            </form>
          </section>
        </div>
      </article>

      <aside className={`tool-column ${sideOpen ? "is-open" : ""}`} aria-label="세션 도구">
        <button
          className="side-peek"
          type="button"
          onClick={() => setSideOpen((open) => !open)}
          aria-expanded={sideOpen}
          aria-label="도구 열기"
        >
          <span className="side-peek-mark" aria-hidden="true">
            □
          </span>
          <span className="side-peek-label">관리</span>
        </button>
        <section className="side-actions" aria-label="세션 관리">
          <button className="drawer-close" type="button" onClick={() => setSideOpen(false)} aria-label="닫기">
            ×
          </button>
          <div className="drawer-heading">
            <p className="eyebrow">관리</p>
            <h3>세션과 자료</h3>
          </div>
          <details className="prompt-details">
            <summary>세계 이름</summary>
            <form
              className="style-form title-form"
              onSubmit={(event) => {
                event.preventDefault();
                void props.onUpdateWorldTitle({
                  title: worldTitle,
                  subtitle: worldSubtitle.trim() || null,
                  locked: worldTitleLocked
                });
              }}
            >
              <label className="field">
                <span>이름</span>
                <input aria-label="세계 이름" value={worldTitle} onChange={(event) => setWorldTitle(event.target.value)} />
              </label>
              <label className="field">
                <span>부제</span>
                <input aria-label="세계 부제" value={worldSubtitle} onChange={(event) => setWorldSubtitle(event.target.value)} />
              </label>
              <label className="check-row compact-check">
                <input type="checkbox" checked={worldTitleLocked} onChange={(event) => setWorldTitleLocked(event.target.checked)} />
                <span>이 이름 고정</span>
              </label>
              <button className="secondary" type="submit" disabled={props.loading || !worldTitle.trim()}>
                저장
              </button>
            </form>
          </details>
          {!current ? (
            <button
              className="primary"
              type="button"
              disabled={props.loading || webgptRunning}
              onClick={() => void props.onRequestWebgptTurn({ conversationMode: consumeWebgptConversationMode() })}
            >
              {webgptRunning ? "WebGPT가 쓰는 중" : "첫 장면 부르기"}
            </button>
          ) : null}
          {props.state.latestWebgptDispatch ? (
            <p className={`dispatch-status quiet ${props.state.latestWebgptDispatch.status}`}>
              {dispatchStatusLabel(props.state.latestWebgptDispatch.status)}
              {props.state.latestWebgptDispatch.errorMessage ? <small>{props.state.latestWebgptDispatch.errorMessage}</small> : null}
            </p>
          ) : null}
          <details className="restore-details">
            <summary>책갈피와 연결</summary>
            {props.state.session.webgptSessionUrl ? (
              <a className="restore-link" href={props.state.session.webgptSessionUrl} target="_blank" rel="noreferrer">
                저장된 WebGPT 세션 열기
              </a>
            ) : null}
            <label className="check-row">
              <input
                type="checkbox"
                checked={webgptConversationMode === "new"}
                disabled={props.loading || webgptRunning}
                onChange={(event) => setWebgptConversationMode(event.target.checked ? "new" : "resume")}
              />
              <span>다음 작업에서 새 WebGPT 세션으로 갈아타기</span>
            </label>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void props.onCreateSave(saveLabel);
              }}
            >
              <input aria-label="책갈피 이름" value={saveLabel} onChange={(event) => setSaveLabel(event.target.value)} />
              <button className="secondary" type="submit" disabled={!props.state.currentTurn || props.loading}>
                저장
              </button>
            </form>
            <div className="save-list">
              {props.state.saves.length ? (
                props.state.saves.map((save) => (
                  <button type="button" key={save.id} onClick={() => void props.onLoadSave(save.id)}>
                    {saveLabelFor(save)}
                  </button>
                ))
              ) : (
                <p className="muted">책갈피 없음</p>
              )}
            </div>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void props.onLinkWebgptSession(webgptUrl);
              }}
            >
              <input
                aria-label="WebGPT 세션 URL"
                value={webgptUrl}
                onChange={(event) => setWebgptUrl(event.target.value)}
                placeholder="https://chatgpt.com/..."
              />
              <button className="secondary" type="submit" disabled={!webgptUrl.trim() || props.loading}>
                연결
              </button>
            </form>
          </details>
          <details className="record-details">
            <summary>세계의 기록</summary>
            {props.state.activeLibraryDocs.length ? (
              <div className="record-list">
                {props.state.activeLibraryDocs.map((doc) => (
                  <article key={doc.id} className="record-item">
                    <span>{libraryKindLabels[doc.kind]}</span>
                    <strong>{doc.title}</strong>
                    {typeof doc.body === "string" ? <p>{doc.body}</p> : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted">세계의 기록 없음</p>
            )}
          </details>
          <details className="prompt-details">
            <summary>CG 그림체</summary>
            <form
              className="style-form"
              onSubmit={(event) => {
                event.preventDefault();
                void props.onUpdateCgStylePrompt(cgStylePrompt);
              }}
            >
              <textarea
                aria-label="CG 그림체 프롬프트"
                value={cgStylePrompt}
                onChange={(event) => setCgStylePrompt(event.target.value)}
                rows={7}
              />
              <div className="inline-actions">
                <button className="secondary" type="submit" disabled={props.loading || !cgStylePrompt.trim()}>
                  저장
                </button>
                <button className="ghost small-button" type="button" disabled={props.loading} onClick={() => setCgStylePrompt(defaultCgStylePrompt)}>
                  기본값으로
                </button>
              </div>
            </form>
          </details>
          <details className="prompt-details">
            <summary>CG 참조 보드</summary>
            <form
              className="style-form"
              onSubmit={(event) => {
                event.preventDefault();
                void props
                  .onUpsertCgReferenceBoard({
                    kind: cgBoardKind,
                    title: cgBoardTitle,
                    prompt: cgBoardPrompt,
                    imageUrl: cgBoardImageUrl.trim() || null,
                    pinned: cgBoardPinned
                  })
                  .then(() => {
                    setCgBoardTitle("");
                    setCgBoardPrompt("");
                    setCgBoardImageUrl("");
                    setCgBoardPinned(true);
                  });
              }}
            >
              <select value={cgBoardKind} onChange={(event) => setCgBoardKind(event.target.value as CgReferenceBoardKind)}>
                {cgBoardKinds.map((kind) => (
                  <option value={kind} key={kind}>
                    {cgBoardKindLabels[kind]}
                  </option>
                ))}
              </select>
              <input value={cgBoardTitle} onChange={(event) => setCgBoardTitle(event.target.value)} placeholder="보드 이름" />
              <textarea
                aria-label="CG 참조 보드 프롬프트"
                value={cgBoardPrompt}
                onChange={(event) => setCgBoardPrompt(event.target.value)}
                placeholder="팔레트, 질감, 캐릭터 실루엣, 장소의 반복 앵커처럼 이미지 일관성에만 쓰일 내용을 적어주세요."
                rows={5}
              />
              <input value={cgBoardImageUrl} onChange={(event) => setCgBoardImageUrl(event.target.value)} placeholder="생성된 보드 이미지 URL (선택)" />
              <label className="check-row compact-check">
                <input type="checkbox" checked={cgBoardPinned} onChange={(event) => setCgBoardPinned(event.target.checked)} />
                <span>다음 CG 의뢰에 참조</span>
              </label>
              <button className="secondary" type="submit" disabled={props.loading || !cgBoardTitle.trim() || !cgBoardPrompt.trim()}>
                보드 저장
              </button>
            </form>
            <div className="record-list">
              {props.state.cgReferenceBoards.length ? (
                props.state.cgReferenceBoards.map((board) => (
                  <article key={board.id} className="record-item">
                    <span>
                      {cgBoardKindLabels[board.kind]}
                      {board.pinned ? " · 참조 중" : ""}
                    </span>
                    <strong>{board.title}</strong>
                    {board.imageUrl ? (
                      <a className="cg-reference-preview" href={board.imageUrl} target="_blank" rel="noreferrer">
                        <img src={board.imageUrl} alt={`${board.title} 참조 이미지`} loading="lazy" />
                      </a>
                    ) : null}
                    <p>{board.prompt}</p>
                    {board.imageUrl ? (
                      <a className="restore-link" href={board.imageUrl} target="_blank" rel="noreferrer">
                        이미지 열기
                      </a>
                    ) : null}
                  </article>
                ))
              ) : (
                <p className="muted">아직 CG 참조 보드가 없습니다.</p>
              )}
            </div>
          </details>
        </section>

        {showDebugTools ? (
          <div className="debug-tools" aria-label="디버그 도구 표면">
            <section className="panel compact" aria-label="WebGPT 커넥터">
              <div className="section-title">
                <p className="eyebrow">WebGPT 커넥터</p>
                <h3>{connectorStatus === "준비되었습니다" ? connectorSurface.label : connectorStatus}</h3>
              </div>
              {!connectorSurface.publicHttps ? (
                <p className="muted">로컬 URL은 점검용입니다. 외부 커넥터에는 HTTPS로 열린 MCP만 사용하세요.</p>
              ) : null}
              <div className="endpoint-list">
                <label>
                  MCP
                  <input readOnly value={`${connectorSurface.origin}/mcp`} />
                </label>
                <label>
                  현재 문맥
                  <input readOnly value={`${connectorSurface.origin}/api/webgpt/tools/vn_get_current_form`} />
                </label>
                <label>
                  매니페스트
                  <input readOnly value={`${connectorSurface.origin}/api/webgpt/manifest`} />
                </label>
                <label>
                  OpenAPI
                  <input readOnly value={`${connectorSurface.origin}/api/webgpt/openapi.json`} />
                </label>
              </div>
            </section>

            <section className="panel compact">
              <div className="section-title">
                <p className="eyebrow">가시 턴 양식</p>
                <h3>커넥터 문맥</h3>
              </div>
              <textarea className="codebox" readOnly value={formatJson(props.state.form)} rows={14} />
            </section>

            {current && props.state.currentCgAsset ? (
              <section className="panel compact">
                <div className="section-title">
                  <p className="eyebrow">CG</p>
                  <h3>의뢰서</h3>
                </div>
                <textarea className="codebox cg-prompt" readOnly rows={8} value={props.state.currentCgAsset.prompt} />
              </section>
            ) : null}

            <section className="panel compact">
              <div className="section-title">
                <p className="eyebrow">수신</p>
                <h3>LLM 턴 JSON</h3>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    const parsed = parseSubmission(turnJson);
                    setTurnParseError(null);
                    void props.onSubmitTurn(parsed).then(() => setTurnJson(""));
                  } catch (error) {
                    setTurnParseError(error instanceof Error ? error.message : "JSON을 읽지 못했습니다.");
                  }
                }}
              >
                <textarea
                  aria-label="LLM 턴 JSON"
                  className="codebox"
                  value={turnJson}
                  onChange={(event) => setTurnJson(event.target.value)}
                  placeholder='{"scene":{"paragraphs":["..."]},"choices":[{"label":"...","action":"..."}]}'
                  rows={10}
                />
                {turnParseError ? <p className="form-error">{turnParseError}</p> : null}
                <button className="primary" type="submit" disabled={!turnJson.trim() || props.loading}>
                  턴 받기
                </button>
              </form>
              <WarningList warnings={[...props.lastWarnings, ...(props.state.currentTurn?.displayShape.warnings ?? [])]} />
            </section>

            <section className="panel compact">
              <div className="section-title">
                <p className="eyebrow">라이브러리</p>
                <h3>집필 문맥</h3>
              </div>
              <form
                className="library-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void props
                    .onUpsertLibraryDoc({
                      kind: docKind,
                      title: docTitle,
                      body: parseDocBody(docBody),
                      visibleToLlm: true,
                      visibleToPlayer: true
                    })
                    .then(() => {
                      setDocTitle("");
                      setDocBody("");
                    });
                }}
              >
                <select value={docKind} onChange={(event) => setDocKind(event.target.value as LibraryDocKind)}>
                  {libraryKinds.map((kind) => (
                    <option value={kind} key={kind}>
                      {libraryKindLabels[kind]}
                    </option>
                  ))}
                </select>
                <input value={docTitle} onChange={(event) => setDocTitle(event.target.value)} placeholder="제목" />
                <textarea value={docBody} onChange={(event) => setDocBody(event.target.value)} rows={5} placeholder="JSON 또는 일반 텍스트" />
                <button className="secondary" type="submit" disabled={!docTitle.trim() || props.loading}>
                  문서 보관
                </button>
              </form>
              <div className="doc-list">
                {props.state.activeLibraryDocs.length ? (
                  props.state.activeLibraryDocs.map((doc) => (
                    <span key={doc.id}>
                      {docLabelFor(doc)}
                      <button
                        className="tiny-action"
                        type="button"
                        disabled={props.loading}
                        onClick={() => void props.onSetLibraryDocPinned(doc.docId, !doc.pinned)}
                      >
                        {doc.pinned ? "고정 해제" : "고정"}
                      </button>
                    </span>
                  ))
                ) : (
                  <p className="muted">활성화된 라이브러리 문서가 없습니다.</p>
                )}
              </div>
            </section>
          </div>
        ) : null}
      </aside>
    </section>
  );
}

function TurnCgControl(props: {
  asset: CgAssetRecord | null;
  imageVisible: boolean;
  loading: boolean;
  cgSessionUrl: string | null;
  conversationMode: WebgptConversationMode;
  onConversationModeChange: (mode: WebgptConversationMode) => void;
  onPrepare: () => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const asset = props.asset;
  const isVisibleAttached = props.imageVisible && asset?.status === "attached";
  const isFailed = asset?.status === "failed";
  const isWaitingReference = asset?.status === "waiting_reference";
  const isRequested = asset?.status === "requested";
  const isAttachedWithoutVisibleImage = asset?.status === "attached" && !props.imageVisible;
  const disabled = props.loading || isVisibleAttached || isWaitingReference || isRequested || isAttachedWithoutVisibleImage;
  const label = (() => {
    if (isVisibleAttached) {
      return "CG 붙음";
    }
    if (!asset) {
      return "이 장면 CG 만들기";
    }
    if (isFailed) {
      return "CG 다시 시도";
    }
    if (isWaitingReference) {
      return "참조 이미지 준비 중";
    }
    if (isRequested) {
      return "CG 준비 중";
    }
    return "CG 불러오는 중";
  })();
  const detail = (() => {
    if (isVisibleAttached) {
      return "현재 장면 CG가 이미지 레인에 붙어 있습니다.";
    }
    if (!asset) {
      return "지금 턴을 이미지 큐에 올립니다.";
    }
    if (isFailed) {
      return asset.errorMessage ?? "이미지 생성이 실패했습니다.";
    }
    if (isWaitingReference) {
      return asset.errorMessage ?? "참조 보드 이미지가 준비되면 자동으로 이어집니다.";
    }
    if (isRequested) {
      return "WebGPT 이미지 세션이 이 장면을 처리하고 있습니다.";
    }
    return "이미지 URL을 확인하고 있습니다.";
  })();

  return (
    <div className={`turn-cg-control ${asset ? `is-${asset.status}` : "is-available"}`}>
      <div className="turn-cg-action-row">
        <button
          className="secondary"
          type="button"
          disabled={disabled}
          onClick={() => {
            void (isFailed ? props.onRetry() : props.onPrepare());
          }}
        >
          {label}
        </button>
        {props.cgSessionUrl ? (
          <a className="restore-link" href={props.cgSessionUrl} target="_blank" rel="noreferrer">
            CG 세션 열기
          </a>
        ) : null}
      </div>
      <div className="turn-cg-detail">
        <p>{detail}</p>
        <label className="check-row compact-check">
          <input
            type="checkbox"
            checked={props.conversationMode === "new"}
            disabled={props.loading || isRequested || isWaitingReference}
            onChange={(event) => props.onConversationModeChange(event.target.checked ? "new" : "resume")}
          />
          <span>다음 CG만 새 이미지 세션</span>
        </label>
      </div>
    </div>
  );
}

function NarrativeLog(props: {
  turns: NonNullable<ReturnType<typeof useVNStore.getState>["readerState"]>["visibleHistory"];
  currentTurnId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <details className="narrative-log" onToggle={(event) => props.onOpenChange(event.currentTarget.open)}>
      <summary>
        <span>서술 로그</span>
        <small>{props.turns.length ? `${props.turns.length}턴` : "비어 있음"}</small>
      </summary>
      {props.turns.length ? (
        <ol className="narrative-log-list">
          {props.turns.map((turn) => {
            const story = turn.displayShape.turn;
            const isCurrent = turn.id === props.currentTurnId;
            const speaker = story.scene.speaker || "서술";
            const fallback = story.scene.paragraphs[0] ?? "빈 장면";
            const excerpt = compactExcerpt(story.concreteDelta || story.scene.background || story.scene.mood, fallback);
            return (
              <li key={turn.id} className={isCurrent ? "is-current" : undefined}>
                <details className="narrative-log-turn" open={isCurrent || undefined}>
                  <summary aria-current={isCurrent ? "step" : undefined}>
                    <span className="narrative-turn-index">#{turn.index + 1}</span>
                    <span className="narrative-turn-meta">
                      <strong>{isCurrent ? "현재 장면" : speaker}</strong>
                      <time dateTime={turn.createdAt}>{formatTurnStamp(turn.createdAt)}</time>
                    </span>
                    <span className="narrative-turn-excerpt">{excerpt}</span>
                  </summary>
                  <div className="narrative-log-body">
                    {story.scene.paragraphs.map((paragraph, index) => (
                      <p key={`${turn.id}-log-${index}`}>{paragraph}</p>
                    ))}
                    <div className="scene-tags">
                      {story.scene.background ? <span>{story.scene.background}</span> : null}
                      {story.scene.mood ? <span>{story.scene.mood}</span> : null}
                      {story.concreteDelta ? <span>{story.concreteDelta}</span> : null}
                    </div>
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted">아직 지나간 장면이 없습니다.</p>
      )}
    </details>
  );
}

function TurnInterface(props: { turnInterface: StoryInterface }) {
  const hasStatus = Boolean(props.turnInterface.statusRows?.length);
  const hasScan = Boolean(props.turnInterface.scanRows?.length);
  const hasProgress = Boolean(props.turnInterface.progress?.eventName || props.turnInterface.progress?.phrase);

  if (!hasStatus && !hasScan && !hasProgress) {
    return null;
  }

  return (
    <details className="turn-interface" aria-label="장면 상태">
      <summary>장면 상태</summary>
      {hasProgress ? (
        <div className="progress-line">
          {props.turnInterface.progress?.eventName ? <strong>{props.turnInterface.progress.eventName}</strong> : null}
          {props.turnInterface.progress?.phrase ? <span>{props.turnInterface.progress.phrase}</span> : null}
        </div>
      ) : null}
      {hasStatus ? (
        <div className="status-grid">
          {props.turnInterface.statusRows?.map((row) => (
            <div className="status-row" key={`${row.label}-${row.value}`}>
              <span>{row.icon ? `${row.icon} ${row.label}` : row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>
      ) : null}
      {hasScan ? (
        <div className="scan-list">
          {props.turnInterface.scanRows?.map((row) => (
            <div className="scan-row" key={`${row.target}-${row.distance ?? ""}`}>
              <strong>{row.target}</strong>
              <span>{[row.className, row.distance].filter(Boolean).join(" · ")}</span>
              {row.thought ? <p>{row.thought}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
    </details>
  );
}

function WarningList(props: { warnings: Array<{ code: string; message: string; path?: string }> }) {
  const unique = props.warnings.filter(
    (warning, index, all) => all.findIndex((item) => item.code === warning.code && item.message === warning.message) === index
  );
  if (!unique.length) {
    return null;
  }
  return (
    <div className="warnings" aria-label="경고">
      {unique.map((warning) => (
        <p key={`${warning.code}-${warning.path ?? ""}`}>
          <strong>{warning.code}</strong>: {warning.message}
        </p>
      ))}
    </div>
  );
}
