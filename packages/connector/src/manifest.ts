export type ConnectorToolName =
  | "vn_create_world"
  | "vn_update_session_settings"
  | "vn_update_world_title"
  | "vn_update_world_cg_style_prompt"
  | "vn_list_worlds"
  | "vn_get_current_form"
  | "vn_get_reader_state"
  | "vn_submit_turn"
  | "vn_receive_visible_turn"
  | "vn_receive_visible_turn_v2"
  | "vn_record_player_action"
  | "vn_get_visible_history"
  | "vn_get_library_docs"
  | "vn_get_library_outline"
  | "vn_prepare_cg_asset"
  | "vn_list_cg_reference_boards"
  | "vn_upsert_cg_reference_board"
  | "vn_attach_cg_reference_board"
  | "vn_claim_next_cg_job"
  | "vn_retry_cg_job"
  | "vn_attach_cg_asset"
  | "vn_upsert_library_doc"
  | "vn_upsert_world_note"
  | "vn_upsert_world_rule"
  | "vn_upsert_system_law"
  | "vn_upsert_style_guide"
  | "vn_upsert_character_card"
  | "vn_upsert_location_card"
  | "vn_upsert_open_thread"
  | "vn_upsert_consequence_note"
  | "vn_upsert_encounter_surface"
  | "vn_upsert_dialogue_stance"
  | "vn_append_continuity_note"
  | "vn_set_library_doc_pinned"
  | "vn_get_save_list"
  | "vn_create_save"
  | "vn_load_save"
  | "vn_link_webgpt_session";

export const connectorToolNames: ConnectorToolName[] = [
  "vn_create_world",
  "vn_update_session_settings",
  "vn_update_world_title",
  "vn_update_world_cg_style_prompt",
  "vn_list_worlds",
  "vn_get_current_form",
  "vn_get_reader_state",
  "vn_submit_turn",
  "vn_receive_visible_turn",
  "vn_receive_visible_turn_v2",
  "vn_record_player_action",
  "vn_get_visible_history",
  "vn_get_library_docs",
  "vn_get_library_outline",
  "vn_prepare_cg_asset",
  "vn_list_cg_reference_boards",
  "vn_upsert_cg_reference_board",
  "vn_attach_cg_reference_board",
  "vn_claim_next_cg_job",
  "vn_retry_cg_job",
  "vn_attach_cg_asset",
  "vn_upsert_library_doc",
  "vn_upsert_world_note",
  "vn_upsert_world_rule",
  "vn_upsert_system_law",
  "vn_upsert_style_guide",
  "vn_upsert_character_card",
  "vn_upsert_location_card",
  "vn_upsert_open_thread",
  "vn_upsert_consequence_note",
  "vn_upsert_encounter_surface",
  "vn_upsert_dialogue_stance",
  "vn_append_continuity_note",
  "vn_set_library_doc_pinned",
  "vn_get_save_list",
  "vn_create_save",
  "vn_load_save",
  "vn_link_webgpt_session"
];

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  nullable?: boolean;
  minItems?: number;
};

export type ConnectorToolDefinition = {
  name: ConnectorToolName;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  storyBoundary: string;
};

const emptyObjectSchema: JsonSchema = {
  type: "object",
  additionalProperties: false
};

const worldSessionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    worldId: {
      type: "string",
      description: "VNplayer 세계 id."
    },
    sessionId: {
      type: "string",
      description: "VNplayer 세션 id."
    }
  },
  required: ["worldId", "sessionId"]
};

const libraryDocKindSchema: JsonSchema = {
  type: "string",
  enum: [
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
  ]
};

const storyTurnSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scene: {
      type: "object",
      additionalProperties: false,
      properties: {
        speaker: {
          type: "string",
          nullable: true
        },
        paragraphs: {
          type: "array",
          items: { type: "string" },
          description: "표시 가능한 문단 문자열 배열."
        },
        background: {
          type: "string",
          nullable: true
        },
        mood: {
          type: "string",
          nullable: true
        }
      },
      required: ["paragraphs"]
    },
    concreteDelta: {
      type: "string",
      nullable: true,
      description: "작성자가 직접 남긴 구체적 가시 변화. 백엔드가 대신 만들지 않는다."
    },
    choices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          action: { type: "string" },
          tag: { type: "string", nullable: true },
          intent: { type: "string", nullable: true }
        },
        required: ["label", "action"]
      }
    },
    interface: {
      type: "object",
      additionalProperties: false,
      properties: {
        statusRows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              value: { type: "string" },
              icon: { type: "string", nullable: true }
            },
            required: ["label", "value"]
          }
        },
        scanRows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              target: { type: "string" },
              className: { type: "string", nullable: true },
              distance: { type: "string", nullable: true },
              thought: { type: "string", nullable: true },
              links: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    label: { type: "string" },
                    href: { type: "string" }
                  },
                  required: ["label", "href"]
                }
              }
            },
            required: ["target"]
          }
        },
        progress: {
          type: "object",
          additionalProperties: false,
          properties: {
            eventName: { type: "string", nullable: true },
            phrase: { type: "string", nullable: true }
          }
        }
      }
    },
    libraryUpdates: {
      type: "array",
      minItems: 1,
      description: "이번 턴에서 LLM이 직접 남기는 작성 라이브러리 갱신. vn_receive_visible_turn에서는 최소 1개가 필요하다. 별도 upsert 도구를 쓰기 어렵다면 여기에 넣는다.",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          kind: libraryDocKindSchema,
          title: { type: "string" },
          body: { type: "object", additionalProperties: true },
          visibleToLlm: { type: "boolean" },
          visibleToPlayer: { type: "boolean" },
          status: {
            type: "string",
            enum: ["active", "dormant", "resolved", "superseded"]
          },
          scope: {
            type: "string",
            enum: ["world", "session", "arc", "scene"]
          },
          tags: {
            type: "array",
            items: { type: "string" }
          },
          updateReason: { type: "string", nullable: true }
        },
        required: ["kind", "title"]
      }
    },
    cgRequest: {
      type: "object",
      additionalProperties: false,
      description: "텍스트 lane이 직접 작성하는 선택적 WebGPT 이미지 생성 의뢰. visible turn에 이미 드러난 것만 다룬다.",
      properties: {
        shouldGenerate: { type: "boolean" },
        priority: {
          type: "string",
          enum: ["low", "normal", "high"]
        },
        subject: { type: "string" },
        visibleAnchors: {
          type: "array",
          items: { type: "string" }
        },
        composition: { type: "string", nullable: true },
        mood: { type: "string", nullable: true },
        palette: {
          type: "array",
          items: { type: "string" },
          nullable: true
        },
        avoid: {
          type: "array",
          items: { type: "string" }
        },
        rationale: { type: "string", nullable: true }
      },
      required: ["shouldGenerate", "subject", "visibleAnchors"]
    },
    cgDecision: {
      type: "object",
      additionalProperties: false,
      description: "텍스트 lane이 매 턴 직접 내리는 CG 생성/스킵 판정. 백엔드는 이 판정을 해석만 하고 서사적으로 판단하지 않는다.",
      properties: {
        decision: {
          type: "string",
          enum: ["generate", "skip"],
          description: "generate면 cgRequest를 함께 넣고, skip이면 reason과 선택적 nextLikelyTrigger만 쓴다."
        },
        reason: {
          type: "string",
          description: "왜 이번 턴을 이미지로 남기거나 건너뛰는지. visible text에 드러난 장면 표면만 근거로 쓴다."
        },
        cgRequest: {
          type: "object",
          additionalProperties: false,
          properties: {
            shouldGenerate: { type: "boolean" },
            priority: {
              type: "string",
              enum: ["low", "normal", "high"]
            },
            subject: { type: "string" },
            visibleAnchors: {
              type: "array",
              items: { type: "string" }
            },
            composition: { type: "string", nullable: true },
            mood: { type: "string", nullable: true },
            palette: {
              type: "array",
              items: { type: "string" },
              nullable: true
            },
            avoid: {
              type: "array",
              items: { type: "string" }
            },
            rationale: { type: "string", nullable: true }
          },
          required: ["shouldGenerate", "subject", "visibleAnchors"]
        },
        nextLikelyTrigger: {
          type: "string",
          nullable: true,
          description: "skip일 때 다음 생성 후보가 보이면 적는다. 다음 산문 계획이 아니라 시각적 조건만 쓴다."
        }
      },
      required: ["decision", "reason"]
    },
    actionAdjudication: {
      type: "object",
      additionalProperties: false,
      description: "최근 플레이어 행동, 특히 자유행동을 텍스트 lane이 장면 안에서 판정한 결과. 백엔드는 성공/실패를 만들지 않고 이 표시 계약만 저장한다.",
      properties: {
        kind: { type: "string", enum: ["accepted", "partial", "blocked"] },
        reason: {
          type: "string",
          description: "왜 행동이 그대로 성립했거나, 일부만 성립했거나, 성립하지 않았는지."
        },
        achieved: {
          type: "string",
          description: "partial일 때 장면 안에서 실제로 된 것."
        },
        blockedBy: {
          type: "string",
          description: "partial일 때 완전히 되지 못한 이유."
        },
        cost: {
          type: "string",
          nullable: true,
          description: "남은 비용, 피로, 시간, 관계 악화 같은 표면 후과."
        },
        constraintTouched: {
          type: "array",
          items: {
            type: "string",
            enum: ["body", "resource", "time", "social_permission", "knowledge", "world_law", "visibility"]
          }
        },
        blockingGate: {
          type: "string",
          enum: ["body", "resource", "time", "social_permission", "knowledge", "world_law", "visibility"],
          description: "blocked일 때 막은 gate."
        },
        visibleConsequence: {
          type: "string",
          description: "blocked가 장면에 남긴 가시 후과. 시스템 실패 문구가 아니라 이야기 안에서 보이는 결과여야 한다."
        }
      },
      required: ["kind", "reason"]
    },
    worldNaming: {
      type: "object",
      additionalProperties: false,
      description: "초반 턴에서만 쓰는 세계 이름 후보 메타데이터. 본문에 제목 짓기 설명을 쓰지 않는다.",
      properties: {
        candidate: {
          type: "string",
          description: "플레이어에게 보일 세계 이름 후보. 숨은 진실이나 미래 반전을 포함하지 않는다."
        },
        subtitle: {
          type: "string",
          nullable: true
        },
        confidence: {
          type: "number",
          description: "0-1 사이의 확신도."
        },
        reason: {
          type: "string",
          nullable: true
        }
      },
      required: ["candidate"]
    }
  },
  required: ["scene", "concreteDelta", "choices", "libraryUpdates"]
};

const storyTurnV2Properties: Record<string, JsonSchema> = {
  ...(storyTurnSchema.properties ?? {})
};
delete storyTurnV2Properties.cgRequest;

const storyTurnV2Schema: JsonSchema = {
  ...storyTurnSchema,
  properties: storyTurnV2Properties,
  required: ["scene", "concreteDelta", "choices", "libraryUpdates", "cgDecision"]
};

export const connectorToolDefinitions: ConnectorToolDefinition[] = [
  {
    name: "vn_create_world",
    title: "세계 만들기",
    description: "이용자가 쓴 시드 텍스트와 선택적 랜덤 시드 메타데이터로 새 VNplayer 세계를 만든다.",
    storyBoundary: "저장소와 초기 커넥터 상태만 만든다. 시작 산문이나 선택지를 합성하면 안 된다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        seedText: {
          type: "string",
          description: "이용자가 직접 쓴 전제 자료."
        },
        randomSeedEnabled: {
          type: "boolean",
          description: "재현용 시드를 저장할지 여부."
        },
        randomSeedValue: {
          type: "string",
          nullable: true
        },
        title: {
          type: "string",
          nullable: true,
          description: "이용자가 직접 확정한 세계 이름. 비우면 시드에서 임시 이름을 잡고 초반 WebGPT 이름 제안을 받을 수 있다."
        },
        cgStylePrompt: {
          type: "string",
          nullable: true,
          description: "세계의 CG 그림체 프롬프트. 비우면 VNplayer 기본 이스터 에그 프롬프트를 쓴다."
        }
      },
      required: ["seedText", "randomSeedEnabled"]
    }
  },
  {
    name: "vn_update_world_title",
    title: "세계 이름 저장",
    description: "세계 이름과 선택적 부제를 저장한다. 사용자가 잠그면 WebGPT 초반 제목 후보가 더 이상 자동 반영되지 않는다.",
    storyBoundary: "제목 메타데이터만 저장한다. 산문, 선택지, canon, 숨은 진실, 세계 법칙을 만들거나 바꾸면 안 된다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: {
          type: "string"
        },
        sessionId: {
          type: "string",
          nullable: true
        },
        title: {
          type: "string"
        },
        subtitle: {
          type: "string",
          nullable: true
        },
        locked: {
          type: "boolean",
          description: "true면 사용자 확정 이름으로 잠근다. false면 이름은 저장하되 이후 수정 여지를 둔다."
        }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_update_session_settings",
    title: "세션 작성 설정 저장",
    description: "현재 세션의 자동 CG 생성 여부와 서사 레벨을 저장한다.",
    storyBoundary: "작성 설정만 저장한다. 산문, 선택지, canon, 세계 법칙을 만들거나 바꾸면 안 된다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" },
        autoCgEnabled: {
          type: "boolean",
          description: "true면 WebGPT 턴의 generate 판정이 자동으로 CG side queue를 만든다."
        },
        narrativeLevel: {
          type: "number",
          description: "1, 2, 3 중 하나. 높을수록 한 선택을 더 많은 장면 beat로 자연스럽게 진행한다."
        }
      },
      required: ["worldId", "sessionId"]
    }
  },
  {
    name: "vn_update_world_cg_style_prompt",
    title: "CG 그림체 설정",
    description: "세계 단위 CG 그림체 프롬프트를 저장한다. 이후 새 CG 의뢰부터 이 프롬프트만 스타일 레이어로 사용된다.",
    storyBoundary: "이미지 스타일만 저장한다. 산문, 선택지, canon, 세계 법칙을 만들거나 바꾸면 안 된다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: {
          type: "string"
        },
        sessionId: {
          type: "string",
          nullable: true
        },
        cgStylePrompt: {
          type: "string",
          nullable: true
        }
      },
      required: ["worldId"]
    }
  },
  {
    name: "vn_list_worlds",
    title: "세계 목록",
    description: "기존 세계 흐름에 필요한 로컬 세계와 복구 메타데이터를 나열한다.",
    storyBoundary: "복구 메타데이터만 반환한다. 원시 DB 행이나 숨은 서사 상태는 반환하지 않는다.",
    inputSchema: emptyObjectSchema
  },
  {
    name: "vn_get_current_form",
    title: "현재 양식 가져오기",
    description: "활성 세계/세션의 선별된 가시 턴 양식을 반환한다.",
    storyBoundary: "가시 히스토리와 집필 문서만 포함한다. 백엔드 서사 계획은 포함하지 않는다.",
    inputSchema: worldSessionSchema
  },
  {
    name: "vn_get_reader_state",
    title: "읽기 상태 가져오기",
    description: "복구와 UI 표시에 필요한 앱용 읽기 상태를 반환한다.",
    storyBoundary: "읽기 상태는 표시/복구 데이터일 뿐 서사 권위가 아니다.",
    inputSchema: worldSessionSchema
  },
  {
    name: "vn_submit_turn",
    title: "턴 제출",
    description: "LLM이 작성한 완성 StoryTurn을 표시 가능성 검증과 append-only 저장소에 제출한다.",
    storyBoundary: "무해한 형태 정규화 뒤 정확한 산문을 저장한다. 산문을 다시 쓰거나 품질을 판정하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" },
        source: {
          type: "string",
          enum: ["llm", "user_import"]
        },
        turn: storyTurnSchema
      },
      required: ["worldId", "sessionId", "turn"]
    }
  },
  {
    name: "vn_receive_visible_turn",
    title: "가시 턴 받기",
    description: "현재 독자 화면에 이어질 완성된 이야기 턴을 VNplayer에 전달한다.",
    storyBoundary: "전달받은 산문과 선택지를 표시 가능한 형태로만 정리한다. 장면 방향이나 결과를 백엔드가 대신 만들지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: {
          type: "string",
          description: "현재 VNplayer 세계 id."
        },
        sessionId: {
          type: "string",
          description: "현재 VNplayer 세션 id."
        },
        dispatchToken: {
          type: "string",
          description: "공개 WebGPT MCP 제출에 필요한 1회성 작업 토큰. 로컬/full 프로필에서는 사용하지 않는다."
        },
        turn: storyTurnSchema
      },
      required: ["worldId", "sessionId", "turn"]
    }
  },
  {
    name: "vn_receive_visible_turn_v2",
    title: "가시 턴 받기 v2",
    description: "현재 독자 화면에 이어질 완성된 이야기 턴과 필수 작성 라이브러리 갱신을 VNplayer에 전달한다.",
    storyBoundary: "전달받은 산문, 선택지, LLM 작성 라이브러리 갱신을 저장한다. 장면 방향이나 결과를 백엔드가 대신 만들지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: {
          type: "string",
          description: "현재 VNplayer 세계 id."
        },
        sessionId: {
          type: "string",
          description: "현재 VNplayer 세션 id."
        },
        dispatchToken: {
          type: "string",
          description: "공개 WebGPT MCP 제출에 필요한 1회성 작업 토큰. 로컬/full 프로필에서는 사용하지 않는다."
        },
        turn: storyTurnV2Schema
      },
      required: ["worldId", "sessionId", "turn"]
    }
  },
  {
    name: "vn_record_player_action",
    title: "이용자 행동 기록",
    description: "활성 턴에 대한 이용자의 선택지 또는 자유 조타 행동을 기록한다.",
    storyBoundary: "행동 텍스트만 기록한다. 그 행동의 성공 여부는 결정하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" },
        turnId: { type: "string" },
        kind: {
          type: "string",
          enum: ["choice", "freeform"]
        },
        label: {
          type: "string",
          nullable: true
        },
        text: { type: "string" }
      },
      required: ["worldId", "sessionId", "turnId", "kind", "text"]
    }
  },
  {
    name: "vn_get_visible_history",
    title: "가시 히스토리 가져오기",
    description: "세계/세션의 append-only 가시 턴을 반환한다.",
    storyBoundary: "확정된 가시 턴만 반환한다. 숨은 요약이나 추론된 방향은 반환하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...worldSessionSchema.properties,
        limit: { type: "number", description: "최근 N개 턴만 반환한다. 기본값은 20." }
      },
      required: ["worldId", "sessionId"]
    }
  },
  {
    name: "vn_get_library_docs",
    title: "라이브러리 문서 가져오기",
    description: "세계의 현재 집필 라이브러리 문서를 반환한다.",
    storyBoundary: "문서는 출처가 있는 이용자/LLM 작성 자료다. 백엔드는 진실성을 판정하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" },
        docIds: {
          type: "array",
          items: { type: "string" }
        },
        pinnedOnly: { type: "boolean" },
        limit: { type: "number", description: "최근 N개 문서 버전만 반환한다. 기본값은 20." }
      },
      required: ["worldId"]
    }
  },
  {
    name: "vn_get_library_outline",
    title: "라이브러리 목록 보기",
    description: "세계의 집필 문서 목록만 반환한다. 본문은 포함하지 않는다.",
    storyBoundary: "목록은 탐색용 색인이다. 어떤 문서가 서사적으로 중요하다고 판정하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" },
        kinds: {
          type: "array",
          items: libraryDocKindSchema
        },
        status: {
          type: "array",
          items: {
            type: "string",
            enum: ["active", "dormant", "resolved", "superseded"]
          }
        },
        scopes: {
          type: "array",
          items: {
            type: "string",
            enum: ["world", "session", "arc", "scene"]
          }
        },
        tags: {
          type: "array",
          items: { type: "string" }
        },
        pinnedOnly: { type: "boolean" },
        visibleToLlmOnly: { type: "boolean" },
        updatedAfterTurnIndex: { type: "number" },
        usedAfterTurnIndex: { type: "number" },
        limit: { type: "number", description: "최근 N개 문서 목록만 반환한다. 기본값은 50." }
      },
      required: ["worldId"]
    }
  },
  {
    name: "vn_set_library_doc_pinned",
    title: "라이브러리 문서 고정",
    description: "특정 라이브러리 문서를 다음 턴 문맥에 우선 포함하거나 고정을 해제한다.",
    storyBoundary: "고정은 검색/선택 정책일 뿐 문서의 진실성이나 서사 중요도를 판정하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string", nullable: true },
        docId: { type: "string" },
        pinned: { type: "boolean" },
        createdBy: {
          type: "string",
          enum: ["llm", "user"]
        }
      },
      required: ["worldId", "docId", "pinned"]
    }
  },
  {
    name: "vn_prepare_cg_asset",
    title: "CG 의뢰서 준비",
    description: "커밋된 visible turn만 읽어 WebGPT 이미지 생성용 CG 의뢰서를 만든다.",
    storyBoundary: "CG 의뢰서는 표시 자산 요청이다. 다음 산문, 선택지, canon, 숨은 상태에 영향을 주면 안 된다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" },
        turnId: {
          type: "string",
          description: "생략하면 현재 활성 턴을 사용한다."
        }
      },
      required: ["worldId", "sessionId"]
    }
  },
  {
    name: "vn_list_cg_reference_boards",
    title: "CG 참조 보드 목록",
    description: "세계의 CG 전용 무드/인물/장소/사물 참조 보드를 나열한다.",
    storyBoundary: "참조 보드는 이미지 일관성 자료다. 산문, 선택지, canon, 숨은 상태의 권위가 아니다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" },
        pinnedOnly: { type: "boolean" },
        activeOnly: { type: "boolean" },
        limit: { type: "number" }
      },
      required: ["worldId"]
    }
  },
  {
    name: "vn_upsert_cg_reference_board",
    title: "CG 참조 보드 저장",
    description: "세계의 CG 전용 무드/인물/장소/사물 참조 보드를 저장하거나 갱신한다.",
    storyBoundary: "보드는 룩을 안정화하는 자료다. 새 lore, 미래 장면, 숨은 진실, 인물 설정을 만들면 안 된다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string", nullable: true },
        id: { type: "string", nullable: true },
        kind: {
          type: "string",
          enum: ["world_mood", "character", "location", "object", "negative"]
        },
        title: { type: "string" },
        prompt: { type: "string" },
        imageUrl: { type: "string", nullable: true },
        pinned: { type: "boolean" },
        status: {
          type: "string",
          enum: ["active", "superseded"]
        },
        createdBy: {
          type: "string",
          enum: ["user", "webgpt"]
        }
      },
      required: ["worldId", "kind", "title", "prompt"]
    }
  },
  {
    name: "vn_attach_cg_reference_board",
    title: "CG 참조 보드 이미지 붙이기",
    description: "WebGPT가 만든 참조 보드 이미지 URL 또는 실패 정보를 기존 CG 참조 보드에 붙인다.",
    storyBoundary: "보드 이미지는 이미지 일관성 자료다. 서사 사실을 만들거나 다음 텍스트 턴 문맥으로 들어가면 안 된다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        boardId: { type: "string" },
        jobId: { type: "string", nullable: true },
        imageUrl: { type: "string", nullable: true },
        conversationId: { type: "string", nullable: true },
        errorMessage: { type: "string", nullable: true }
      },
      required: ["worldId", "boardId"]
    }
  },
  {
    name: "vn_claim_next_cg_job",
    title: "다음 CG job 가져오기",
    description: "로컬 CG side worker가 다음 queued cg_asset job을 running으로 claim한다.",
    storyBoundary: "큐 claim은 실행 제어일 뿐 서사 판단이 아니다. CG side lane은 텍스트를 쓰거나 canon을 만들 수 없다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" }
      }
    }
  },
  {
    name: "vn_retry_cg_job",
    title: "CG job 재시도",
    description: "실패한 CG side job을 다시 queued 상태로 돌린다.",
    storyBoundary: "재시도는 이미지 실행 제어다. 텍스트 턴, 선택지, canon을 바꾸면 안 된다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string", nullable: true },
        jobId: { type: "string" }
      },
      required: ["worldId", "jobId"]
    }
  },
  {
    name: "vn_attach_cg_asset",
    title: "CG 결과 붙이기",
    description: "WebGPT가 만든 이미지 결과 URL 또는 실패 정보를 기존 CG 의뢰서에 붙인다.",
    storyBoundary: "이미지 결과는 표시 첨부물이다. 서사 사실을 만들거나 다음 턴 문맥으로 들어가면 안 된다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" },
        assetId: { type: "string" },
        imageUrl: { type: "string", nullable: true },
        altText: { type: "string", nullable: true },
        provider: { type: "string", nullable: true },
        conversationId: { type: "string", nullable: true },
        errorMessage: { type: "string", nullable: true }
      },
      required: ["worldId", "sessionId", "assetId"]
    }
  },
  {
    name: "vn_upsert_library_doc",
    title: "라이브러리 문서 갱신",
    description: "이용자/LLM 작성 라이브러리 문서의 새 버전을 만든다.",
    storyBoundary: "버전이 있는 작성 자료만 다룬다. 백엔드는 충돌을 해결하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" },
        docId: { type: "string" },
        kind: libraryDocKindSchema,
        title: { type: "string" },
        body: {
          type: "object",
          additionalProperties: true
        },
        visibleToLlm: { type: "boolean" },
        visibleToPlayer: { type: "boolean" },
        createdBy: {
          type: "string",
          enum: ["llm", "user"]
        },
        sourceTurnId: { type: "string" },
        updateReason: { type: "string" },
        status: {
          type: "string",
          enum: ["active", "dormant", "resolved", "superseded"]
        },
        scope: {
          type: "string",
          enum: ["world", "session", "arc", "scene"]
        },
        tags: {
          type: "array",
          items: { type: "string" }
        },
        supersedesDocVersionId: { type: "string", nullable: true }
      },
      required: ["worldId", "kind", "title"]
    }
  },
  {
    name: "vn_upsert_world_note",
    title: "세계 메모 갱신",
    description: "새 world_note 라이브러리 문서 버전을 만든다.",
    storyBoundary: "세계 메모는 작성 자료이며 백엔드 세계 상태가 아니다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        docId: { type: "string" },
        title: { type: "string" },
        body: { type: "object", additionalProperties: true }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_upsert_world_rule",
    title: "세계 법칙 갱신",
    description: "새 world_rule 라이브러리 문서 버전을 만든다.",
    storyBoundary: "세계 법칙은 작성자가 기록한 자료다. 백엔드는 법칙의 참/거짓이나 충돌을 판정하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        docId: { type: "string" },
        title: { type: "string" },
        body: { type: "object", additionalProperties: true }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_upsert_system_law",
    title: "작동 법칙 갱신",
    description: "새 system_law 라이브러리 문서 버전을 만든다.",
    storyBoundary: "마법, 기술, 시간, 신체 같은 작동 법칙도 작성 자료일 뿐 백엔드 세계 모델이 아니다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        docId: { type: "string" },
        title: { type: "string" },
        body: { type: "object", additionalProperties: true }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_upsert_style_guide",
    title: "문체 가이드 갱신",
    description: "새 style_guide 라이브러리 문서 버전을 만든다.",
    storyBoundary: "문체 가이드는 LLM에 제공된다. 백엔드는 산문이 이를 따르는지 검증하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        docId: { type: "string" },
        title: { type: "string" },
        body: { type: "object", additionalProperties: true }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_upsert_character_card",
    title: "인물 카드 갱신",
    description: "새 character_card 라이브러리 문서 버전을 만든다.",
    storyBoundary: "인물 카드는 작성된 연속성 자료다. 백엔드는 일관성 점수를 매기지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        docId: { type: "string" },
        title: { type: "string" },
        body: { type: "object", additionalProperties: true }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_upsert_location_card",
    title: "장소 카드 갱신",
    description: "새 location_card 라이브러리 문서 버전을 만든다.",
    storyBoundary: "장소 카드는 작성된 공간 자료다. 백엔드는 장소 의미를 추론하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        docId: { type: "string" },
        title: { type: "string" },
        body: { type: "object", additionalProperties: true }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_upsert_open_thread",
    title: "열린 실마리 갱신",
    description: "새 open_thread 라이브러리 문서 버전을 만든다.",
    storyBoundary: "실마리는 작성된 미해결 자료다. 백엔드는 해결 방향을 계획하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        docId: { type: "string" },
        title: { type: "string" },
        body: { type: "object", additionalProperties: true }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_upsert_consequence_note",
    title: "후과 메모 갱신",
    description: "선택 뒤에 남은 가시 후과를 consequence_note 라이브러리 문서로 남긴다.",
    storyBoundary: "후과 메모는 작성된 연속성 자료다. 백엔드는 언제 돌아와야 할지 서사적으로 판정하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        docId: { type: "string" },
        title: { type: "string" },
        body: { type: "object", additionalProperties: true }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_upsert_encounter_surface",
    title: "장면 표면 갱신",
    description: "현재 장면에서 만질 수 있는 구체적 표면을 encounter_surface 라이브러리 문서로 남긴다.",
    storyBoundary: "장면 표면은 작성된 리콜 자료다. 백엔드는 퍼즐 풀이, 성공 판정, 선택지 계획을 하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        docId: { type: "string" },
        title: { type: "string" },
        body: { type: "object", additionalProperties: true }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_upsert_dialogue_stance",
    title: "대화 태도 갱신",
    description: "현재 대화의 자세, 조건, 미해결 질문을 dialogue_stance 라이브러리 문서로 남긴다.",
    storyBoundary: "대화 태도는 단기 사회 기억이다. 백엔드는 관계 점수나 숨은 동기를 만들지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        docId: { type: "string" },
        title: { type: "string" },
        body: { type: "object", additionalProperties: true }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_append_continuity_note",
    title: "연속성 메모 추가",
    description: "새 continuity_note 라이브러리 문서 버전을 만든다.",
    storyBoundary: "연속성 메모는 작성된 요약 자료다. 백엔드는 숨은 진실을 요약하지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        worldId: { type: "string" },
        docId: { type: "string" },
        title: { type: "string" },
        body: { type: "object", additionalProperties: true }
      },
      required: ["worldId", "title"]
    }
  },
  {
    name: "vn_get_save_list",
    title: "저장점 목록",
    description: "세계/세션의 저장점을 나열한다.",
    storyBoundary: "복구 메타데이터만 다룬다.",
    inputSchema: worldSessionSchema
  },
  {
    name: "vn_create_save",
    title: "저장점 만들기",
    description: "활성 턴을 가리키는 저장점을 만든다.",
    storyBoundary: "저장점은 확정된 텍스트를 가리킬 뿐 아카이브를 다시 쓰지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" },
        label: { type: "string" }
      },
      required: ["worldId", "sessionId"]
    }
  },
  {
    name: "vn_load_save",
    title: "저장점 불러오기",
    description: "저장점에서 세션 활성 턴을 복구한다.",
    storyBoundary: "가시 읽기 상태만 복구한다. 대체 서사 콘텐츠는 만들지 않는다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        saveId: { type: "string" }
      },
      required: ["saveId"]
    }
  },
  {
    name: "vn_link_webgpt_session",
    title: "WebGPT 세션 연결",
    description: "WebGPT 세션 URL을 세계/세션의 복구 메타데이터로 저장한다.",
    storyBoundary: "URL은 복구 메타데이터일 뿐 서사 콘텐츠가 아니다.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worldId: { type: "string" },
        sessionId: { type: "string" },
        url: { type: "string" }
      },
      required: ["worldId", "sessionId", "url"]
    }
  }
];

export function getConnectorToolDefinition(name: ConnectorToolName): ConnectorToolDefinition {
  const definition = connectorToolDefinitions.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error(`알 수 없는 커넥터 도구 정의: ${name}`);
  }
  return definition;
}

export function buildWebGptManifest(baseUrl: string, allowedToolNames: readonly ConnectorToolName[] = connectorToolNames) {
  const allowed = new Set<ConnectorToolName>(allowedToolNames);
  return {
    schemaVersion: "vnplayer.webgpt.connector.v1",
    name: "VNplayer WebGPT 커넥터",
    description:
      "VNplayer용 독립 커넥터. WebGPT는 원시 DB 접근 없이 선별된 가시 양식을 읽고 구조화된 이야기 턴을 제출한다.",
    baseUrl,
    openapiUrl: `${baseUrl}/api/webgpt/openapi.json`,
    genericCallUrl: `${baseUrl}/api/webgpt/call`,
    toolBaseUrl: `${baseUrl}/api/webgpt/tools`,
    waterline:
      "백엔드는 복구, 조회, 표시 형태 검증, 작성 자료 패키징까지 할 수 있다. 산문, 선택지, 결과, 장면 비트를 작성하면 안 된다.",
    tools: connectorToolDefinitions.filter((tool) => allowed.has(tool.name))
  };
}

export function buildWebGptOpenApi(baseUrl: string, allowedToolNames: readonly ConnectorToolName[] = connectorToolNames) {
  const allowed = new Set<ConnectorToolName>(allowedToolNames);
  const allowedTools = connectorToolDefinitions.filter((tool) => allowed.has(tool.name));
  const paths: Record<string, unknown> = {
    "/api/webgpt/call": {
      post: {
        operationId: "vnplayer_call_tool",
        summary: "이름으로 VNplayer 커넥터 도구 호출",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  toolName: {
                    type: "string",
                    enum: allowedToolNames
                  },
                  args: {
                    type: "object",
                    additionalProperties: true
                  }
                },
                required: ["toolName", "args"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "도구 결과"
          }
        }
      }
    }
  };

  for (const tool of allowedTools) {
    paths[`/api/webgpt/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.title,
        description: `${tool.description}\n\n경계: ${tool.storyBoundary}`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: tool.inputSchema
            }
          }
        },
        responses: {
          "200": {
            description: "도구 결과"
          }
        }
      }
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "VNplayer WebGPT 커넥터",
      version: "0.1.0",
      description:
        "VNplayer용 구조화 WebGPT 커넥터. 서사 경계를 보존하는 선별된 가시 양식과 쓰기 도구만 노출한다."
    },
    servers: [{ url: baseUrl }],
    paths
  };
}
