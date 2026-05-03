export const legacyRedrawCgStylePrompt = [
  "Redraw the attached image in the most clumsy, scribbly, and utterly pathetic way possible.",
  "Use a white background, and make it look like it was drawn in MS Paint with a mouse.",
  "It should be vaguely similar but also not really, kind of matching but also off in a confusing, awkward way,",
  "with that low-quality pixel-by-pixel feel that really emphasizes how ridiculously bad it is.",
  "Actually, you know what, whatever, just draw it however you want."
].join(" ");

export const previousDefaultCgStylePrompt = [
  "Create a new text-to-image scene illustration in the most clumsy, scribbly, and utterly pathetic way possible.",
  "Use a plain white background, as if it was drawn from scratch in MS Paint with a mouse.",
  "Keep it loosely connected to the requested scene, but let the resemblance feel awkward, off, and confusing in a funny way.",
  "Use a low-quality pixel-by-pixel feel that makes the image look ridiculously bad on purpose.",
  "Actually, you know what, whatever, just draw the scene however you want."
].join(" ");

export const defaultCgStylePrompt = [
  "요청한 이미지를 개발새발 세상에서 제일 하찮은 선으로 그려줘.",
  "배경은 흰색, 그림판에서 마우스로 그린것 같은 맞는듯 아닌듯 비슷한듯 아닌듯 아리까리하게 픽셀단위의 그림으로 하찮음을 제대로 뽐내줘.",
  "아 됐고 그냥 니맘대로 그려."
].join(" ");

export const misspelledKoreanDefaultCgStylePrompt = defaultCgStylePrompt.replace("개발새발", ["개", "박", "새", "발"].join(""));

export function normalizeCgStylePrompt(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed || defaultCgStylePrompt;
}
