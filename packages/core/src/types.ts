export type Choice = {
  label: string;
  action: string;
  tag?: string | null;
  intent?: string | null;
};

export type StoryInterface = {
  statusRows?: Array<{
    label: string;
    value: string;
    icon?: string | null;
  }>;
  scanRows?: Array<{
    target: string;
    className?: string | null;
    distance?: string | null;
    thought?: string | null;
    links?: Array<{
      label: string;
      href: string;
    }>;
  }>;
  progress?: {
    eventName?: string | null;
    phrase?: string | null;
  };
};

export type StoryLibraryUpdate = {
  kind: LibraryDocKind;
  title: string;
  body: unknown;
  visibleToLlm?: boolean;
  visibleToPlayer?: boolean;
  status?: LibraryDocStatus;
  scope?: LibraryDocScope;
  tags?: string[];
  updateReason?: string | null;
};

export type CgRequest = {
  shouldGenerate: boolean;
  priority?: "low" | "normal" | "high";
  subject: string;
  visibleAnchors: string[];
  composition?: string | null;
  mood?: string | null;
  palette?: string[] | null;
  avoid?: string[];
  rationale?: string | null;
};

export type CgDecision =
  | {
      decision: "generate";
      reason: string;
      cgRequest: CgRequest;
    }
  | {
      decision: "skip";
      reason: string;
      nextLikelyTrigger?: string | null;
    };

export type ActionConstraintGate = "body" | "resource" | "time" | "social_permission" | "knowledge" | "world_law" | "visibility";

export type ActionAdjudication =
  | {
      kind: "accepted";
      reason: string;
      cost?: string | null;
      constraintTouched?: ActionConstraintGate[];
    }
  | {
      kind: "partial";
      reason: string;
      achieved: string;
      blockedBy: string;
      cost?: string | null;
      constraintTouched?: ActionConstraintGate[];
    }
  | {
      kind: "blocked";
      reason: string;
      blockingGate: ActionConstraintGate;
      visibleConsequence: string;
    };

export type WorldNamingProposal = {
  candidate: string;
  subtitle?: string | null;
  confidence?: number | null;
  reason?: string | null;
};

export type StoryTurn = {
  scene: {
    speaker: string | null;
    paragraphs: string[];
    background: string | null;
    mood: string | null;
  };
  concreteDelta?: string | null;
  interface?: StoryInterface;
  choices: Choice[];
  libraryUpdates?: StoryLibraryUpdate[];
  cgRequest?: CgRequest;
  cgDecision?: CgDecision;
  actionAdjudication?: ActionAdjudication;
  worldNaming?: WorldNamingProposal;
};

export type DisplayabilityWarning = {
  code: string;
  message: string;
  path?: string;
};

export type DisplayShape = {
  turn: StoryTurn;
  warnings: DisplayabilityWarning[];
};

export type WorldStartRequest = {
  seedText: string;
  randomSeedEnabled: boolean;
  randomSeedValue?: string | null;
  cgStylePrompt?: string | null;
  title?: string | null;
};

export type WorldTitleStatus = "provisional" | "named" | "locked";
export type WorldTitleSource = "seed" | "fallback" | "webgpt" | "user";
export type NarrativeLevel = 1 | 2 | 3;

export type WorldRecord = {
  id: string;
  title: string;
  titleStatus: WorldTitleStatus;
  titleSource: WorldTitleSource;
  titleLocked: boolean;
  subtitle?: string | null;
  titleUpdatedAt?: string | null;
  seedText: string;
  randomSeedEnabled: boolean;
  randomSeedValue?: string | null;
  cgStylePrompt: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionRecord = {
  id: string;
  worldId: string;
  label: string;
  activeTurnId?: string | null;
  webgptSessionUrl?: string | null;
  cgWebgptConversationId?: string | null;
  autoCgEnabled: boolean;
  narrativeLevel: NarrativeLevel;
  createdAt: string;
  updatedAt: string;
};

export type PlayerAction = {
  id: string;
  worldId: string;
  sessionId: string;
  turnId: string;
  kind: "choice" | "freeform";
  label?: string | null;
  text: string;
  createdAt: string;
};

export type RawSubmission = {
  id: string;
  worldId: string;
  sessionId: string;
  source: "llm" | "user_import";
  payload: unknown;
  receivedAt: string;
};

export type StoredTurn = {
  id: string;
  worldId: string;
  sessionId: string;
  index: number;
  playerActionId?: string | null;
  rawSubmissionId: string;
  displayShape: DisplayShape;
  createdAt: string;
};

export type CgAssetStatus = "waiting_reference" | "requested" | "attached" | "failed";

export type CgAssetRecord = {
  id: string;
  worldId: string;
  sessionId: string;
  turnId: string;
  jobId?: string | null;
  status: CgAssetStatus;
  prompt: string;
  negativePrompt?: string | null;
  imageUrl?: string | null;
  altText?: string | null;
  provider?: string | null;
  generatedByLane?: WebgptJobLane | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CgReferenceBoardKind = "world_mood" | "character" | "location" | "object" | "negative";

export type CgReferenceBoardRecord = {
  id: string;
  worldId: string;
  sessionId?: string | null;
  kind: CgReferenceBoardKind;
  title: string;
  prompt: string;
  imageUrl?: string | null;
  pinned: boolean;
  status: "active" | "superseded";
  createdBy: "user" | "webgpt";
  createdAt: string;
  updatedAt: string;
};

export type WebgptJobKind = "text_turn" | "cg_asset" | "cg_reference_board";
export type WebgptJobLane = "main_text" | "cg_side";
export type WebgptJobStatus = "waiting_reference" | "queued" | "running" | "succeeded" | "failed";

export type WebgptJobRecord = {
  id: string;
  worldId: string;
  sessionId: string;
  kind: WebgptJobKind;
  lane: WebgptJobLane;
  status: WebgptJobStatus;
  priority: number;
  targetTurnId?: string | null;
  conversationId?: string | null;
  payload: unknown;
  result?: unknown;
  errorMessage?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type LibraryDocKind =
  | "world_note"
  | "world_rule"
  | "system_law"
  | "style_guide"
  | "character_card"
  | "faction_card"
  | "item_card"
  | "location_card"
  | "relationship_note"
  | "continuity_note"
  | "open_thread"
  | "consequence_note"
  | "encounter_surface"
  | "dialogue_stance"
  | "motif_note"
  | "editorial_note"
  | "retcon_note"
  | "reader_preference"
  | "writer_prompt"
  | "tool_use_policy";

export type LibraryDocStatus = "active" | "dormant" | "resolved" | "superseded";

export type LibraryDocScope = "world" | "session" | "arc" | "scene";

export type LibraryDocMetadata = {
  status: LibraryDocStatus;
  scope: LibraryDocScope;
  tags: string[];
  supersedesDocVersionId?: string | null;
};

export type LibraryDocVersion = {
  id: string;
  docId: string;
  worldId: string;
  kind: LibraryDocKind;
  title: string;
  body: unknown;
  visibleToLlm: boolean;
  visibleToPlayer: boolean;
  createdBy: "llm" | "user";
  createdAt: string;
  sourceTurnId?: string | null;
  updateReason?: string | null;
  metadata: LibraryDocMetadata;
  pinned?: boolean;
  lastUsedTurnId?: string | null;
  lastUsedTurnIndex?: number | null;
  lastTouchedTurnId?: string | null;
  lastTouchedTurnIndex?: number | null;
};

export type LibraryDocOutlineItem = {
  docId: string;
  versionId: string;
  worldId: string;
  kind: LibraryDocKind;
  title: string;
  status: LibraryDocStatus;
  scope: LibraryDocScope;
  tags: string[];
  visibleToLlm: boolean;
  visibleToPlayer: boolean;
  pinned: boolean;
  createdBy: "llm" | "user";
  lastUsedTurnId?: string | null;
  lastUsedTurnIndex?: number | null;
  lastTouchedTurnId?: string | null;
  lastTouchedTurnIndex?: number | null;
  updatedAt: string;
};

export type TurnDocLink = {
  turnId: string;
  docVersionId: string;
  reason: "pinned" | "llm_requested" | "recent_update" | "user_selected";
  createdAt: string;
};

export type VisibleReadingPacket = {
  worldId: string;
  sessionId: string;
  worldTitle: string;
  worldTitleStatus: WorldTitleStatus;
  worldTitleSource: WorldTitleSource;
  worldTitleLocked: boolean;
  worldSubtitle?: string | null;
  worldSeedText: string;
  randomSeedValue?: string | null;
  visibleHistory: StoryTurn[];
  latestPlayerAction: PlayerAction | null;
  activeLibraryDocs: LibraryDocVersion[];
  libraryOutline: LibraryDocOutlineItem[];
  webgptSessionUrl?: string | null;
  autoCgEnabled: boolean;
  narrativeLevel: NarrativeLevel;
};

export type VisibleTurnForm = {
  worldId: string;
  sessionId: string;
  readingPacket: VisibleReadingPacket;
  responseShape: "StoryTurn";
  instruction: string;
};

export type SaveRecord = {
  id: string;
  worldId: string;
  sessionId: string;
  label: string;
  turnId: string;
  createdAt: string;
};

export type WebgptDispatchStatus = "running" | "succeeded" | "failed";

export type WebgptDispatchRecord = {
  id: string;
  worldId: string;
  sessionId: string;
  status: WebgptDispatchStatus;
  conversationId?: string | null;
  payload: unknown;
  result?: unknown;
  errorMessage?: string | null;
  createdAt: string;
};

export type WorldSummary = {
  worldId: string;
  title: string;
  titleStatus: WorldTitleStatus;
  titleSource: WorldTitleSource;
  titleLocked: boolean;
  subtitle?: string | null;
  seedPreview: string;
  latestSessionId: string | null;
  latestTurnId: string | null;
  updatedAt: string;
  hasWebgptSessionUrl: boolean;
};

export type ReaderState = {
  world: WorldRecord;
  session: SessionRecord;
  currentTurn: StoredTurn | null;
  currentCgAsset: CgAssetRecord | null;
  backgroundCgAsset: CgAssetRecord | null;
  cgSessionUrl?: string | null;
  cgReferenceBoards: CgReferenceBoardRecord[];
  visibleHistory: StoredTurn[];
  latestPlayerAction: PlayerAction | null;
  activeLibraryDocs: LibraryDocVersion[];
  libraryOutline: LibraryDocOutlineItem[];
  saves: SaveRecord[];
  activeWebgptDispatch: WebgptDispatchRecord | null;
  latestWebgptDispatch: WebgptDispatchRecord | null;
  form: VisibleTurnForm;
};

export type ToolError = {
  ok: false;
  code: string;
  message: string;
  fieldErrors?: Array<{
    path: string;
    message: string;
  }>;
};

export type ToolSuccess<T> = {
  ok: true;
} & T;

export type ToolResult<T> = ToolSuccess<T> | ToolError;
