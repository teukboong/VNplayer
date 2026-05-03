import type {
  LibraryDocVersion,
  LibraryDocOutlineItem,
  PlayerAction,
  SessionRecord,
  StoredTurn,
  VisibleTurnForm,
  WorldRecord
} from "./types.js";

type BuildVisibleTurnFormInput = {
  world: WorldRecord;
  session: SessionRecord;
  visibleHistory: StoredTurn[];
  latestPlayerAction: PlayerAction | null;
  activeLibraryDocs: LibraryDocVersion[];
  libraryOutline: LibraryDocOutlineItem[];
};

function narrativeLevelInstruction(level: 1 | 2 | 3): string {
  if (level === 1) {
    return [
      "전개 속도는 1, 느림입니다.",
      "진행 예산은 1 beat입니다: 플레이어 행동의 실행 완료, 바로 닿는 반응, 다음 압력만 다룹니다.",
      "선택된 행동은 전체 문단의 앞 30% 안에서 실제로 실행 완료해야 합니다. 이후 문단은 그 행동의 즉각적인 결과를 보여 주세요.",
      "위치, 위험, 자원, 관계, 정보, 출구 중 최소 1개 축이 가시적으로 달라져야 합니다.",
      "새 장소로 크게 건너뛰거나 새 사건을 두 개 이상 열지 말고, 가까운 결과에서 다음 선택 지점을 만드세요."
    ].join(" ");
  }
  if (level === 3) {
    return [
      "전개 속도는 3, 빠름입니다.",
      "진행 예산은 3 beat입니다: 실행, 반작용/복잡화, 새 위치나 대가가 드러나는 후과까지 반드시 이어 갑니다.",
      "선택된 행동은 전체 문단의 앞 25-30% 안에서 실제로 실행 완료해야 합니다. accepted 행동이면 턴 끝까지 같은 행동을 계속 시도 중인 상태로 남기지 마세요.",
      "둘째 beat부터는 그 행동이 만든 반작용이나 복잡화를 다루고, 셋째 beat에서는 새 위치, 새 압박, 새 표면, 새 대가 중 하나가 독자가 선택할 수 있는 상태로 드러나야 합니다.",
      "위치, 위험, 자원, 관계, 정보, 출구 중 최소 2개 축이 실제로 달라져야 합니다.",
      "한 물리 동작을 3문단 이상 연속 확대하지 마세요. 같은 순간을 더 오래 늘이는 대신 장면 좌표를 앞으로 옮기세요.",
      "다음 선택지는 방금 선택한 행동의 단순 반복이 아니라, 그 행동 때문에 생긴 새 문제나 열린 표면을 건드려야 합니다."
    ].join(" ");
  }
  return [
    "전개 속도는 2, 보통입니다.",
    "진행 예산은 2 beat입니다: 플레이어 행동의 직접 결과와 그 결과가 만든 반작용/여파까지 다룹니다.",
    "선택된 행동은 전체 문단의 앞 30% 안에서 실제로 실행 완료해야 합니다. 이후에는 결과가 만든 반작용과 다음 선택면으로 이동하세요.",
    "위치, 위험, 자원, 관계, 정보, 출구 중 최소 2개 축이 가시적으로 달라져야 합니다.",
    "빠름처럼 새 국면 전체를 열지는 않아도, 느림보다 한 박자 더 멀리 가서 다음 문제가 보이는 지점에서 멈추세요."
  ].join(" ");
}

function detailLevelInstruction(level: 1 | 2 | 3): string {
  if (level === 1) {
    return [
      "묘사 밀도는 1, 간결입니다.",
      "권장 출력량은 6-10문단입니다.",
      "문장은 선명하게 쓰되 감각과 은유는 핵심 변화에만 붙이고, 진행을 늦추는 장식 문단은 줄이세요."
    ].join(" ");
  }
  if (level === 3) {
    return [
      "묘사 밀도는 3, 풍부입니다.",
      "권장 출력량은 16-24문단입니다. 극단적인 예외가 아니면 28문단을 넘기지 마세요.",
      "풍부한 묘사는 전개 속도를 늦추는 권한이 아닙니다. 선택 행동 실행과 장면 좌표 변화는 전개 속도 지침을 우선합니다.",
      "감각, 공간, 물성, 신체 반응은 새 위치, 새 위험, 새 비용, 새 선택지와 연결될 때만 확장하세요."
    ].join(" ");
  }
  return [
    "묘사 밀도는 2, 표준입니다.",
    "권장 출력량은 10-16문단입니다.",
    "장면에 머물 시간은 주되, 같은 표면을 반복해 문단 수를 늘리지 마세요."
  ].join(" ");
}

export function buildVisibleTurnForm(input: BuildVisibleTurnFormInput): VisibleTurnForm {
  return {
    worldId: input.world.id,
    sessionId: input.session.id,
    readingPacket: {
      worldId: input.world.id,
      sessionId: input.session.id,
      worldTitle: input.world.title,
      worldTitleStatus: input.world.titleStatus,
      worldTitleSource: input.world.titleSource,
      worldTitleLocked: input.world.titleLocked,
      worldSubtitle: input.world.subtitle ?? null,
      worldSeedText: input.world.seedText,
      randomSeedValue: input.world.randomSeedValue ?? null,
      visibleHistory: input.visibleHistory.map((turn) => turn.displayShape.turn),
      latestPlayerAction: input.latestPlayerAction,
      activeLibraryDocs: input.activeLibraryDocs,
      libraryOutline: input.libraryOutline,
      webgptSessionUrl: input.session.webgptSessionUrl ?? null,
      autoCgEnabled: input.session.autoCgEnabled,
      narrativeLevel: input.session.narrativeLevel,
      detailLevel: input.session.detailLevel
    },
    responseShape: "StoryTurn",
    instruction: [
      "가시 히스토리, 독자가 쓴 세계관 시드, 선택된 집필 라이브러리 문서, 최근 독자의 선택을 바탕으로 이야기를 바로 이어 써 주세요.",
      "libraryOutline은 이 세계에 존재하는 작성 자료 목록입니다. activeLibraryDocs에 없는 문서 본문이 꼭 필요할 때만 docId를 지정해 요청하세요.",
      "본문 산문은 존댓말 안내문처럼 쓰지 마세요. 장면은 성인 독자를 위한 문학 산문으로 쓰고, 문장 끝을 억지로 공손하게 만들지 마세요.",
      "대사는 본문 산문과 register를 분리해 설계하세요. 인물의 관계, 거리감, 사회적 위치, 현재 압박, 말의 목적에 맞는 자연스러운 한국어 구어체를 쓸 수 있습니다.",
      "대사에서는 말줄임, 생략, 되묻기, 끊김, 숨 고르기 같은 구어적 리듬을 허용하되, 모든 인물이 같은 반말이나 같은 농담투로 평평해지지 않게 하세요.",
      "대사의 구어체가 본문 전체를 채팅 말투나 UI 안내문 말투로 끌고 가면 안 됩니다. 대사 밖 서술은 장면 산문 register로 돌아와야 합니다.",
      "선택지 label/action처럼 플레이어에게 직접 건네는 UI 문구만 자연스러운 존댓말을 써도 됩니다. 선택지는 인물 대사가 아니라 독자의 구체적 행동을 안내하는 문구입니다.",
      "문체는 설명보다 암시, 과잉 수식보다 정확한 이미지와 장면의 진행이 앞서야 합니다. 특정 장르나 작가의 표면적 어조를 고정적으로 모사하지 마세요.",
      "동화, 라이트노벨식 친절함, 교훈적인 해설, 감탄사 많은 판타지 내레이션, '무언가 소중한 것을 깨닫습니다' 같은 요약 감정문을 피하세요.",
      narrativeLevelInstruction(input.session.narrativeLevel),
      detailLevelInstruction(input.session.detailLevel),
      "전개 속도와 묘사 밀도는 별개입니다. 묘사 밀도가 높아도 선택 행동 실행을 뒤로 미루거나 같은 순간을 오래 늘이면 안 됩니다.",
      "분량은 padding이 아니라 장면 진행을 담는 그릇입니다. 문단 수보다 행동 완료, 반작용, 후과, 다음 선택면이 우선입니다.",
      "턴 끝의 상태는 시작 상태와 달라야 합니다. 위치, 위험, 자원, 관계, 정보, 출구 중 적어도 전개 속도 지침이 요구한 축이 실제로 변해야 합니다.",
      "감각과 은유는 장면의 물리적 변화, 위협의 접근, 선택 가능한 표면을 더 선명하게 할 때만 확장하세요. 반복되는 감각어, 신체 부위, 물질, 동작에는 매번 새 위치, 새 거리, 새 위험, 새 비용, 새 선택지 중 하나가 있어야 합니다.",
      "내면 서술은 판단과 행동을 돕는 만큼만 쓰세요. 주인공이 상황을 오래 관조하기보다, 무엇을 알아차렸고 무엇을 선택할 수 있게 되었는지가 드러나야 합니다.",
      "긴장 장면에서는 외부 압력의 변화가 서술의 중심축이어야 합니다. 추적자, 소리, 거리, 빛, 지형, 출구, 자원 같은 요소가 실제로 움직이거나 달라져야 합니다.",
      "세밀한 동작을 묘사할 때는 과정 전체를 반복하지 말고, 동작이 만든 결과와 그 결과가 부른 반응을 우선하세요.",
      "핵심 변화 1-2곳에서는 물리적 인과와 감각의 방향을 선명하게 쓰세요. 어떤 움직임이 무엇을 누르고, 그 압력이 어떤 소리나 흔적을 만들었는지 독자가 위치를 잃지 않을 만큼만 보여 주세요.",
      "위험, 공포, 조급함 같은 추상 감정어는 가능하면 숨, 근육, 시선, 손의 움직임 같은 신체 반응이나 행동으로 치환하세요.",
      "좁음, 무거움, 차가움 같은 상태는 필요할 때 형용사만으로 처리하지 말고 피부, 뼈, 흙, 물, 금속이 서로 닿는 압력과 마찰로 보여 주세요. 같은 물성 설명을 반복해 문단을 늘리지 마세요.",
      "긴박한 문장에서는 부사보다 동사로 속도를 조절하세요. 긁다, 찌르다, 비틀다, 밀다, 짓누르다 같은 동작이 문장 리듬을 만들게 하세요.",
      "위쪽, 앞쪽, 뒤쪽, 안쪽 같은 공간 층위를 유지해 독자가 압박의 방향을 잃지 않게 하세요.",
      "장면을 너무 빨리 해결하거나 여러 사건을 한 번에 건너뛰지 마세요. 선택지 직전에는 독자가 다음 행동을 고를 수 있는 새 상태가 보여야 합니다.",
      "선택지는 원칙적으로 6개를 제공해 주세요. 1-4번은 현재 장면의 맥락 행동, 5번은 코덱스/기록/정보 진입, 6번은 시간 흐름이나 기다림 계열로 둡니다. 서사적으로 불가능하면 4-5개로 줄일 수 있지만 억지 filler를 채우지 마세요.",
      "각 선택지는 단순 버튼명이 아니라 무엇을 하려는지 알 수 있는 label과 action을 가져야 합니다. label/action에는 actor + object/surface + action이 보이게 쓰고, 가능하면 tag와 intent도 함께 표시해 주세요.",
      "StoryTurn에는 concreteDelta를 반드시 포함해 주세요. 이번 턴에서 실제로 달라진 구체적 가시 변화 한 문장이어야 하며, 백엔드가 대신 만들 수 없습니다.",
      "readingPacket.latestPlayerAction.kind가 freeform이면 그 입력은 명령이 아니라 시도입니다. 얼토당토않은 자유행동까지 그대로 성공시키지 말고, 몸/자원/시간/사회적 허락/지식/세계 법칙/가시성 gate를 통해 장면 안에서 성립 여부를 판단해 주세요.",
      "자유행동이 그대로 성립하면 StoryTurn.actionAdjudication.kind는 accepted, 일부만 성립하면 partial, 성립하지 않으면 blocked로 작성해 주세요. blocked도 시스템 거절문이 아니라 시도가 부딪힌 가시 후과를 본문 장면으로 보여줘야 합니다.",
      "자유행동 판정은 백엔드가 대신 하지 않습니다. actionAdjudication은 판정의 메타데이터이고, 실제 성공/부분 성공/차단의 감각은 scene.paragraphs와 concreteDelta 안에 같이 들어 있어야 합니다.",
      "readingPacket.worldTitleStatus가 provisional이고 세계 이름이 아직 덜 잡혔다고 판단되면 첫 1-2턴 안에 StoryTurn.worldNaming으로 제목 후보를 제안할 수 있습니다. 제목은 본문에 설명하지 말고 metadata로만 넣어 주세요. 숨은 진실, 미공개 반전, 이후에만 드러날 고유명은 제목 후보에 포함하지 마세요.",
      "StoryTurn.libraryUpdates는 필수입니다. 안정적으로 남은 후과는 consequence_note, 조작 가능한 장면 표면은 encounter_surface, 현재 대화 자세는 dialogue_stance, 미해결 질문은 open_thread로 최소 1개, 보통 1-3개를 직접 넣어 주세요. 이것들은 다음 턴 리콜 자료이지 백엔드 장면 계획이 아닙니다.",
      "매 턴 StoryTurn.cgDecision을 반드시 작성해 주세요. cgDecision.decision은 generate 또는 skip입니다. 이것은 이미지 생성 실행이 아니라 병렬 CG lane에 넘길지 고르는 텍스트 메타데이터입니다.",
      input.session.autoCgEnabled
        ? "현재 자동 CG 생성은 켜져 있습니다. generate 판정은 백엔드가 CG side lane에 자동 큐잉할 수 있으므로, 정말 시각적으로 각인될 장면일 때만 generate를 고르세요."
        : "현재 자동 CG 생성은 꺼져 있습니다. 그래도 cgDecision은 작성하되, generate 판정은 수동 CG 버튼이 눌릴 때 참고할 의뢰서일 뿐 자동 이미지 생성을 시작하지 않습니다.",
      "텍스트 lane에서는 어떤 경우에도 이미지를 직접 생성하지 마세요. 이미지 생성 도구를 호출하지 말고, 이미지 markdown, 이미지 URL, data URL, 첨부 이미지를 채팅 본문에 만들지 마세요. 텍스트 lane의 최종 행동은 vn_receive_visible_turn_v2 호출뿐입니다.",
      "CG generate 기준은 보수적으로 잡습니다. 직전 CG와 구도, 장소, 인물 배치, 핵심 물건의 위치가 분명히 달라지는 새 시각 국면이면 generate입니다. 새 조작 표면이 생겼더라도 같은 공간, 같은 거리감, 같은 표면의 반복이면 skip입니다.",
      "generate일 때는 cgDecision.cgRequest를 함께 작성해 주세요. cgRequest는 visible text에 이미 드러난 표면만 대상으로 하는 의뢰서 텍스트이며, 미래 장면, 숨은 진실, 새 단서, 새 인물, 읽을 수 있는 문자, 다음 선택의 의미를 만들면 안 됩니다. 실제 이미지는 병렬 CG lane에서만 생성되는 표시 첨부물이며 다음 산문 문맥이 아닙니다.",
      "skip일 때는 reason을 쓰고, 다음 생성 후보가 보이면 nextLikelyTrigger에 시각적 조건만 적어 주세요. 대화/추론 위주라 새 시각 표면이 없거나, 직전 CG와 거의 같은 구도이거나, CG가 암시를 망칠 때는 skip해도 됩니다.",
      "장면 아래에 독자가 몸을 둘 수 있는 interface.statusRows와 interface.scanRows를 선택적으로 제공할 수 있습니다. 이것들은 작성자가 쓴 표시물이지 백엔드 계산값이 아닙니다.",
      "백엔드 메타데이터를 서사 권위로 취급하지 마세요. 성공/실패, 장면 방향, 의미 판단은 백엔드가 아니라 이 작성 턴 안에서만 다뤄 주세요."
    ].join(" ")
  };
}
