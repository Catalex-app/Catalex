import { useEffect, useState } from "react";

interface IntlWordSegment {
  isWordLike?: boolean;
}

interface IntlWordSegmenter {
  segment: (text: string) => Iterable<IntlWordSegment>;
}

interface IntlWithSegmenter {
  Segmenter?: new (
    locales?: string | string[],
    options?: { granularity: "word" },
  ) => IntlWordSegmenter;
}

export function countMarkdownCharacters(text: string): number {
  return Array.from(text).length;
}

export function countMarkdownWords(text: string): number {
  const Segmenter = (Intl as unknown as IntlWithSegmenter).Segmenter;
  if (Segmenter) {
    return Array.from(
      new Segmenter(undefined, { granularity: "word" }).segment(text),
    ).filter((segment) => segment.isWordLike).length;
  }

  return text.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function countDocument(text: string) {
  return {
    wordCount: countMarkdownWords(text),
    characterCount: countMarkdownCharacters(text),
  };
}

export function useDocumentStatistics(text: string) {
  const [statistics, setStatistics] = useState(() => countDocument(text));
  useEffect(() => {
    // Keep full-document scans out of the typing update. Only counters wait;
    // document state, history, and persistence still update immediately.
    const timer = window.setTimeout(
      () => setStatistics(countDocument(text)),
      200,
    );
    return () => window.clearTimeout(timer);
  }, [text]);
  return statistics;
}
