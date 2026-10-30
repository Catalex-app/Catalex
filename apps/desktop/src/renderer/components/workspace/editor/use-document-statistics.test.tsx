import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import {
  countMarkdownCharacters,
  countMarkdownWords,
  useDocumentStatistics,
} from "./use-document-statistics";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("coalesces document counts while typing and cancels stale scans", () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  let statistics = { wordCount: 0, characterCount: 0 };
  function Probe({ text }: { text: string }) {
    statistics = useDocumentStatistics(text);
    return null;
  }
  const render = (text: string) =>
    act(() => root.render(<Probe text={text} />));
  try {
    render("one");
    expect(statistics).toEqual({ wordCount: 1, characterCount: 3 });
    render("one two");
    act(() => vi.advanceTimersByTime(150));
    render("one two three");
    act(() => vi.advanceTimersByTime(150));
    expect(statistics.wordCount).toBe(1);
    act(() => vi.advanceTimersByTime(50));
    expect(statistics).toEqual({ wordCount: 3, characterCount: 13 });
    render("another file");
    act(() => vi.advanceTimersByTime(200));
    expect(statistics).toEqual({ wordCount: 2, characterCount: 12 });
    render("pending");
  } finally {
    act(() => root.unmount());
  }
  expect(vi.getTimerCount()).toBe(0);
});

test("preserves Unicode character and word counting", () => {
  expect(countMarkdownCharacters("中文 🧪 café")).toBe(10);
  expect(countMarkdownWords("Hello world! 中文 🧪")).toBe(3);
  expect(countMarkdownWords("one two three")).toBe(3);
  expect(countMarkdownWords("")).toBe(0);
});
