import type { DisplayabilityWarning, StoryTurn } from "./types.js";

type AnalyzePostTurnQualityInput = {
  turn: StoryTurn;
  recentTurns?: StoryTurn[];
};

const UI_DIALOGUE_TERMS = [
  "선택지",
  "상태이상",
  "상태 이상",
  "규칙",
  "지형",
  "오른쪽",
  "왼쪽",
  "먼저",
  "해야",
  "길부터",
  "표식",
  "스캔",
  "정보",
  "turn",
  "status",
  "choice",
  "route"
];

const MACRO_DELTA_TERMS = [
  "나갔",
  "나온",
  "들어",
  "도착",
  "넘어",
  "벗어",
  "무너",
  "열렸",
  "닫혔",
  "잃",
  "얻",
  "부상",
  "베",
  "잡",
  "떨어",
  "드러",
  "밝혀",
  "막",
  "깨",
  "바뀌",
  "물러",
  "다가"
];

const ANCHOR_TERMS = [
  "관측감",
  "표식",
  "울림",
  "위쪽",
  "안쪽",
  "흐름",
  "압박",
  "냄새",
  "소리",
  "시선",
  "오른쪽",
  "왼쪽"
];

function textBlock(turn: StoryTurn): string {
  return [
    ...turn.scene.paragraphs,
    turn.concreteDelta ?? "",
    ...turn.choices.flatMap((choice) => [choice.label, choice.action, choice.intent ?? ""])
  ].join("\n");
}

function warning(code: string, message: string, path?: string): DisplayabilityWarning {
  return path ? { code, message, path } : { code, message };
}

function quotedSegments(text: string): string[] {
  const segments: string[] = [];
  const patterns = [/"([^"]{2,220})"/g, /“([^”]{2,220})”/g, /'([^']{2,220})'/g, /‘([^’]{2,220})’/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) {
        segments.push(match[1]);
      }
    }
  }
  return segments;
}

function detectDialogueAsUi(turn: StoryTurn): DisplayabilityWarning | null {
  const quoted = quotedSegments(turn.scene.paragraphs.join("\n"));
  for (const line of quoted) {
    const hits = UI_DIALOGUE_TERMS.filter((term) => line.toLowerCase().includes(term.toLowerCase()));
    if (hits.length >= 3) {
      return warning(
        "post_turn_dialogue_as_ui",
        "대사가 지형, 규칙, 상태, 선택면을 직접 안내하는 UI 문구처럼 보입니다.",
        "scene.paragraphs"
      );
    }
  }
  return null;
}

function detectMacroDeltaMissing(turn: StoryTurn): DisplayabilityWarning | null {
  const delta = turn.concreteDelta?.trim() ?? "";
  if (!delta) {
    return warning("post_turn_macro_delta_missing", "concreteDelta가 없어 장면 변화 추적이 약합니다.", "concreteDelta");
  }
  const hasMacroTerm = MACRO_DELTA_TERMS.some((term) => delta.includes(term));
  const weakDelta = /조금|약간|여전히|그대로|계속|다시/u.test(delta) && !hasMacroTerm;
  if (!hasMacroTerm || weakDelta) {
    return warning(
      "post_turn_macro_delta_missing",
      "concreteDelta가 자세나 압력 변화에 머물 수 있습니다. 장소, 상대 상태, 자원, 정보, 출구 중 하나가 실제로 달라졌는지 확인이 필요합니다.",
      "concreteDelta"
    );
  }
  return null;
}

function detectRepeatedAnchorTerms(turn: StoryTurn): DisplayabilityWarning | null {
  const text = textBlock(turn);
  const hotTerms = ANCHOR_TERMS.filter((term) => {
    const matches = text.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
    return (matches?.length ?? 0) >= 8;
  });
  if (!hotTerms.length) {
    return null;
  }
  return warning(
    "post_turn_repeated_anchor_terms",
    `반복 앵커가 과밀합니다: ${hotTerms.slice(0, 4).join(", ")}.`,
    "scene.paragraphs"
  );
}

function normalizeSurface(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 5)
    .join(" ");
}

function detectChoiceSurfaceFlat(turn: StoryTurn): DisplayabilityWarning | null {
  if (turn.choices.length < 4) {
    return null;
  }
  const surfaces = new Set(turn.choices.map((choice) => normalizeSurface(`${choice.label} ${choice.action}`)).filter(Boolean));
  if (surfaces.size <= 2) {
    return warning("post_turn_choice_surface_flat", "선택지들이 거의 같은 표면이나 행동 계열에 묶여 있습니다.", "choices");
  }
  return null;
}

function detectSameSurfaceLoop(input: AnalyzePostTurnQualityInput): DisplayabilityWarning | null {
  const recent = input.recentTurns?.slice(-2) ?? [];
  if (recent.length < 2) {
    return null;
  }
  const currentSurface = normalizeSurface([input.turn.concreteDelta ?? "", input.turn.scene.background ?? "", input.turn.scene.mood ?? ""].join(" "));
  if (!currentSurface) {
    return null;
  }
  const repeated = recent.filter((turn) => {
    const previousSurface = normalizeSurface([turn.concreteDelta ?? "", turn.scene.background ?? "", turn.scene.mood ?? ""].join(" "));
    return previousSurface && previousSurface === currentSurface;
  });
  if (repeated.length >= 2) {
    return warning("post_turn_same_surface_loop", "최근 턴과 같은 장면 표면이 반복되어 교착 루프가 생길 수 있습니다.", "scene");
  }
  return null;
}

function detectParagraphDensity(turn: StoryTurn): DisplayabilityWarning | null {
  const paragraphs = turn.scene.paragraphs;
  if (paragraphs.length < 10) {
    return null;
  }
  const lengths = paragraphs.map((paragraph) => paragraph.trim().length);
  const average = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  const veryShortCount = lengths.filter((length) => length < 55).length;
  if (average < 80 || veryShortCount >= Math.ceil(paragraphs.length * 0.4)) {
    return warning("post_turn_paragraph_density_outlier", "짧은 문단이 과밀해 장면 진행보다 절단 리듬이 앞설 수 있습니다. 문단 수뿐 아니라 문단당 장면 밀도도 늘려야 합니다.", "scene.paragraphs");
  }
  if (paragraphs.length > 28) {
    return warning("post_turn_paragraph_density_outlier", "문단 수가 매우 많습니다. 묘사가 아니라 상태 변화가 늘었는지 확인이 필요합니다.", "scene.paragraphs");
  }
  return null;
}

function uniqueWarnings(warnings: Array<DisplayabilityWarning | null>): DisplayabilityWarning[] {
  const seen = new Set<string>();
  const result: DisplayabilityWarning[] = [];
  for (const item of warnings) {
    if (!item) {
      continue;
    }
    const key = `${item.code}:${item.path ?? ""}:${item.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function analyzePostTurnQuality(input: AnalyzePostTurnQualityInput): DisplayabilityWarning[] {
  return uniqueWarnings([
    detectDialogueAsUi(input.turn),
    detectMacroDeltaMissing(input.turn),
    detectRepeatedAnchorTerms(input.turn),
    detectSameSurfaceLoop(input),
    detectChoiceSurfaceFlat(input.turn),
    detectParagraphDensity(input.turn)
  ]);
}
