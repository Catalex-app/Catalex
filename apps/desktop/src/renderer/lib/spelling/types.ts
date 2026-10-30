export type SpellingLanguage = "en-US" | "en-GB";
export const SPELLING_LANGUAGES = [
  { value: "en-US" as const, label: "English (US)" },
  { value: "en-GB" as const, label: "English (UK)" },
];
export const normalizeSpellingLanguage = (value: unknown): SpellingLanguage =>
  value === "en-GB" ? "en-GB" : "en-US";
export function normalizeSpellingWords(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (word): word is string =>
              typeof word === "string" && word.length > 0 && word.length <= 100,
          ),
        ),
      ]
    : [];
}
export type SpellingRequest = {
  id: number;
  language: SpellingLanguage;
} & ({ type: "check"; words: string[] } | { type: "suggest"; word: string });
export type SpellingReply = { id: number } & (
  | { words: string[] }
  | { error: string }
);
