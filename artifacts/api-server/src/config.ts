export const TRANSLATION_MODEL =
  process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_CHAPTER_BYTES = 200 * 1024 * 1024;
export const MAX_CHAPTER_PAGES = 60;
export const RESULT_TTL_MS = 60 * 60 * 1000;

export const supportedLanguages = [
  { code: "ar", label: "Arabic", nativeLabel: "العربية", direction: "rtl" as const },
  { code: "en", label: "English", nativeLabel: "English", direction: "ltr" as const },
  { code: "ja", label: "Japanese", nativeLabel: "日本語", direction: "ltr" as const },
  { code: "ko", label: "Korean", nativeLabel: "한국어", direction: "ltr" as const },
  { code: "zh", label: "Chinese", nativeLabel: "中文", direction: "ltr" as const },
];

export function isSupportedLanguage(code: string): boolean {
  return supportedLanguages.some((language) => language.code === code);
}