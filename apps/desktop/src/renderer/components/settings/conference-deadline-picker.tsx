import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import {
  fetchCcfddlDeadlines,
  filterCcfddlEntriesByConferenceName,
  highlightCcfddlMatch,
  isExactCcfddlConferenceMatch,
  type CCFDDLDeadlineEntry,
} from "@/lib/ccfddl";
import { useSettingsStore } from "@/stores/settings-store";
export function ConferenceDeadlinePicker({
  onChange,
}: {
  onChange?: () => void;
}) {
  const catSelectedCcfddlDeadline = useSettingsStore(
    (s) => s.catSelectedCcfddlDeadline,
  );
  const setCatSelectedCcfddlDeadline = useSettingsStore(
    (s) => s.setCatSelectedCcfddlDeadline,
  );
  const broadcastSettingsChanged = () => onChange?.();
  const [ccfddlEntries, setCcfddlEntries] = useState<CCFDDLDeadlineEntry[]>([]);
  const [ccfddlStatus, setCcfddlStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [ccfddlQuery, setCcfddlQuery] = useState(
    catSelectedCcfddlDeadline?.displayTitle ?? "",
  );
  const measureRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(256);
  useLayoutEffect(() => {
    const measured = measureRef.current?.getBoundingClientRect().width ?? 0;
    setWidth(
      ccfddlQuery
        ? Math.min(512, Math.max(120, Math.ceil(measured) + 52))
        : 256,
    );
  }, [ccfddlQuery]);
  const loadCcfddlEntries = async () => {
    if (ccfddlStatus === "loading" || ccfddlStatus === "ready") return;
    setCcfddlStatus("loading");
    try {
      setCcfddlEntries(await fetchCcfddlDeadlines());
      setCcfddlStatus("ready");
    } catch {
      setCcfddlStatus("error");
    }
  };
  const filteredCcfddlEntries = useMemo(() => {
    return filterCcfddlEntriesByConferenceName(ccfddlEntries, ccfddlQuery);
  }, [ccfddlEntries, ccfddlQuery]);
  const handleCcfddlSelection = (entry: CCFDDLDeadlineEntry) => {
    setCatSelectedCcfddlDeadline(entry);
    setCcfddlQuery(entry.displayTitle);
    broadcastSettingsChanged();
  };

  useEffect(() => {
    void loadCcfddlEntries();
  }, []);
  useEffect(() => {
    setCcfddlQuery(catSelectedCcfddlDeadline?.displayTitle ?? "");
  }, [catSelectedCcfddlDeadline?.displayTitle]);
  return (
    <div className="relative ml-auto max-w-full" style={{ width }}>
      <span
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute top-0 left-0 whitespace-pre font-normal text-sm"
      >
        {ccfddlQuery || "Type a conference name"}
      </span>
      <SearchablePicker
        label="Search CCFDDL conferences"
        placeholder="Type a conference name"
        align="right"
        query={ccfddlQuery}
        value={catSelectedCcfddlDeadline?.id}
        onQueryChange={(query) => {
          setCcfddlQuery(query);
          if (!query.trim()) {
            setCatSelectedCcfddlDeadline(null);
            broadcastSettingsChanged();
          }
        }}
        onOpen={() => void loadCcfddlEntries()}
        options={filteredCcfddlEntries.map((entry) => ({
          value: entry.id,
          label: entry.displayTitle,
          group: /[\p{L}\p{N}]/u.test(ccfddlQuery)
            ? isExactCcfddlConferenceMatch(entry, ccfddlQuery)
              ? "Exact matches"
              : "Fuzzy matches"
            : undefined,
          labelContent: highlightCcfddlMatch(
            entry.displayTitle,
            ccfddlQuery,
          ).map((part, index) =>
            part.matched ? (
              <mark
                key={index}
                className="rounded-sm bg-primary/15 text-inherit"
              >
                {part.text}
              </mark>
            ) : (
              part.text
            ),
          ),
          description: `${entry.deadline} ${entry.sourceTimezone}`,
        }))}
        onSelect={(id) => {
          const entry = ccfddlEntries.find((entry) => entry.id === id);
          if (entry) handleCcfddlSelection(entry);
        }}
        emptyText="No matching conferences"
        status={
          ccfddlStatus === "loading" ? (
            <div className="px-3 py-2 text-muted-foreground text-xs">
              Loading CCFDDL...
            </div>
          ) : ccfddlStatus === "error" ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
              <span className="text-muted-foreground">CCFDDL unavailable</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => void loadCcfddlEntries()}
              >
                Retry
              </Button>
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
