import { useMemo, useState } from "react";
import { SearchPanel } from "@/components/workspace/editor/search-panel";

const SEARCH_HISTORY_LIMIT = 20;
const SAMPLE_TEXT = `\\section{Introduction}
Search should feel floating.
Another Search line.
search term appears again.
word words sword word.
`;

type Match = { from: number; to: number; text: string };
type HistoryField = "find" | "replace";
type HistoryDirection = "up" | "down";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyPreserveCase(matchText: string, replaceText: string): string {
  if (!replaceText) return replaceText;
  if (matchText.toUpperCase() === matchText && /[A-Z]/i.test(matchText)) {
    return replaceText.toUpperCase();
  }
  if (matchText.toLowerCase() === matchText && /[A-Z]/i.test(matchText)) {
    return replaceText.toLowerCase();
  }
  if (/^[A-Z][a-z0-9]+$/.test(matchText)) {
    return (
      replaceText.charAt(0).toUpperCase() + replaceText.slice(1).toLowerCase()
    );
  }
  return replaceText;
}

function pushHistoryEntry(entries: string[], nextValue: string): string[] {
  const trimmed = nextValue.trim();
  if (!trimmed) return entries;
  const deduped = [trimmed, ...entries.filter((entry) => entry !== trimmed)];
  return deduped.slice(0, SEARCH_HISTORY_LIMIT);
}

export function EditorSearchHarness() {
  const [isSearchOpen, setIsSearchOpen] = useState(true);
  const [findText, setFindText] = useState("Search");
  const [replaceText, setReplaceText] = useState("Locate");
  const [documentText, setDocumentText] = useState(SAMPLE_TEXT);
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [preserveCase, setPreserveCase] = useState(false);
  const [findInSelection, setFindInSelection] = useState(false);
  const [selectionRange, setSelectionRange] = useState<{
    from: number;
    to: number;
  } | null>(null);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [findHistory, setFindHistory] = useState<string[]>([]);
  const [replaceHistory, setReplaceHistory] = useState<string[]>([]);
  const [findHistoryIndex, setFindHistoryIndex] = useState(-1);
  const [replaceHistoryIndex, setReplaceHistoryIndex] = useState(-1);
  const [findHistoryDraft, setFindHistoryDraft] = useState("");
  const [replaceHistoryDraft, setReplaceHistoryDraft] = useState("");

  const query = useMemo(() => {
    if (!findText) return { regex: null, valid: true };
    try {
      const source = useRegex ? findText : escapeRegExp(findText);
      const wrapped = wholeWord ? `\\b(?:${source})\\b` : source;
      const flags = caseSensitive ? "g" : "gi";
      return { regex: new RegExp(wrapped, flags), valid: true };
    } catch {
      return { regex: null, valid: false };
    }
  }, [findText, useRegex, wholeWord, caseSensitive]);

  const matches = useMemo(() => {
    if (!query.regex || !query.valid) return [] as Match[];
    const next: Match[] = [];
    let match: RegExpExecArray | null;
    while ((match = query.regex.exec(documentText))) {
      const from = match.index;
      const to = match.index + match[0].length;
      const inScope =
        !findInSelection ||
        !selectionRange ||
        (from >= selectionRange.from && to <= selectionRange.to);
      if (inScope) {
        next.push({ from, to, text: match[0] });
      }
      if (match[0].length === 0) {
        query.regex.lastIndex += 1;
      }
    }
    return next;
  }, [documentText, findInSelection, query, selectionRange]);

  const canReplace = matches.length > 0 && query.valid && findText.length > 0;

  const replaceAtIndex = (targetIndex: number) => {
    const target = matches[targetIndex];
    if (!target) return;
    const replacement =
      preserveCase && !useRegex
        ? applyPreserveCase(target.text, replaceText)
        : replaceText;
    setDocumentText(
      (prev) =>
        prev.slice(0, target.from) + replacement + prev.slice(target.to),
    );
  };

  const pushFindHistory = () =>
    setFindHistory((prev) => pushHistoryEntry(prev, findText));
  const pushReplaceHistory = () =>
    setReplaceHistory((prev) => pushHistoryEntry(prev, replaceText));

  const handleHistoryNavigate = (
    field: HistoryField,
    direction: HistoryDirection,
  ) => {
    const history = field === "find" ? findHistory : replaceHistory;
    if (history.length === 0) return;
    const index = field === "find" ? findHistoryIndex : replaceHistoryIndex;
    const currentValue = field === "find" ? findText : replaceText;
    if (direction === "up") {
      const nextIndex = index < 0 ? 0 : Math.min(index + 1, history.length - 1);
      if (index < 0) {
        if (field === "find") setFindHistoryDraft(currentValue);
        else setReplaceHistoryDraft(currentValue);
      }
      const nextValue = history[nextIndex] ?? currentValue;
      if (field === "find") {
        setFindHistoryIndex(nextIndex);
        setFindText(nextValue);
      } else {
        setReplaceHistoryIndex(nextIndex);
        setReplaceText(nextValue);
      }
      return;
    }
    if (index < 0) return;
    if (index === 0) {
      if (field === "find") {
        setFindHistoryIndex(-1);
        setFindText(findHistoryDraft);
      } else {
        setReplaceHistoryIndex(-1);
        setReplaceText(replaceHistoryDraft);
      }
      return;
    }
    const nextIndex = index - 1;
    const nextValue = history[nextIndex] ?? currentValue;
    if (field === "find") {
      setFindHistoryIndex(nextIndex);
      setFindText(nextValue);
    } else {
      setReplaceHistoryIndex(nextIndex);
      setReplaceText(nextValue);
    }
  };

  return (
    <div className="flex min-h-screen items-start justify-center bg-background p-8 text-foreground">
      <div className="w-[900px]">
        <h1 className="mb-3 font-semibold text-sm">Editor Search Harness</h1>
        <div
          data-testid="editor-search-harness-shell"
          className="relative h-[520px] overflow-hidden rounded-2xl border border-border/70 bg-card"
        >
          {isSearchOpen ? (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4">
              <SearchPanel
                findText={findText}
                replaceText={replaceText}
                isReplaceOpen={showReplace}
                isCaseSensitive={caseSensitive}
                isWholeWord={wholeWord}
                isRegex={useRegex}
                preserveCase={preserveCase}
                findInSelection={findInSelection}
                canEnableFindInSelection={!!selectionRange || findInSelection}
                isQueryValid={query.valid}
                canReplace={canReplace}
                onFindTextChange={(next) => {
                  setFindHistoryIndex(-1);
                  setFindText(next);
                  setCurrentMatch(next ? 1 : 0);
                }}
                onReplaceTextChange={(next) => {
                  setReplaceHistoryIndex(-1);
                  setReplaceText(next);
                }}
                onToggleReplace={() => setShowReplace((prev) => !prev)}
                onToggleCaseSensitive={() => setCaseSensitive((prev) => !prev)}
                onToggleWholeWord={() => setWholeWord((prev) => !prev)}
                onToggleRegex={() => setUseRegex((prev) => !prev)}
                onTogglePreserveCase={() => setPreserveCase((prev) => !prev)}
                onToggleFindInSelection={() => {
                  if (findInSelection) {
                    setFindInSelection(false);
                  } else if (selectionRange) {
                    setFindInSelection(true);
                  }
                }}
                onHistoryNavigate={handleHistoryNavigate}
                onClose={() => setIsSearchOpen(false)}
                onFindNext={() => {
                  pushFindHistory();
                  setCurrentMatch((prev) =>
                    matches.length === 0 ? 0 : (prev % matches.length) + 1,
                  );
                }}
                onFindPrevious={() => {
                  pushFindHistory();
                  setCurrentMatch((prev) =>
                    matches.length === 0
                      ? 0
                      : prev <= 1
                        ? matches.length
                        : prev - 1,
                  );
                }}
                onReplaceNext={() => {
                  if (!canReplace) return;
                  pushFindHistory();
                  pushReplaceHistory();
                  const nextIndex =
                    matches.length === 0
                      ? -1
                      : Math.max(0, (currentMatch || 1) - 1);
                  replaceAtIndex(nextIndex);
                }}
                onReplaceAll={() => {
                  if (!canReplace) return;
                  pushFindHistory();
                  pushReplaceHistory();
                  const allMatches = matches.slice().reverse();
                  setDocumentText((prev) => {
                    let nextDoc = prev;
                    for (const match of allMatches) {
                      const replacement =
                        preserveCase && !useRegex
                          ? applyPreserveCase(match.text, replaceText)
                          : replaceText;
                      nextDoc =
                        nextDoc.slice(0, match.from) +
                        replacement +
                        nextDoc.slice(match.to);
                    }
                    return nextDoc;
                  });
                }}
                matchCount={matches.length}
                currentMatch={
                  matches.length === 0 ? 0 : Math.max(1, currentMatch)
                }
              />
            </div>
          ) : null}

          <div className="absolute top-28 right-4 z-20 flex gap-2">
            <button
              data-testid="selection-toggle"
              type="button"
              className="rounded border border-border/80 bg-background px-2 py-1 text-xs"
              onClick={() =>
                setSelectionRange((prev) =>
                  prev
                    ? null
                    : {
                        from: documentText.indexOf("Another"),
                        to: documentText.indexOf("word words"),
                      },
                )
              }
            >
              {selectionRange ? "Clear selection" : "Set selection"}
            </button>
          </div>

          <pre
            data-testid="harness-document"
            className="absolute inset-0 overflow-auto p-5 font-mono text-muted-foreground text-sm leading-7"
          >
            {documentText}
          </pre>

          <div className="absolute right-4 bottom-4 rounded border border-border/80 bg-background/90 px-2 py-1 text-xs">
            <span data-testid="harness-match-count">{matches.length}</span>
            {" matches"}
          </div>
        </div>
      </div>
    </div>
  );
}
