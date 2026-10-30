export const CCFDDL_ALLCONF_URL = "https://ccfddl.com/conference/allconf.yml";

export interface CCFDDLDeadlineEntry {
  id: string;
  title: string;
  displayTitle: string;
  description: string;
  sub: string;
  year: string;
  deadline: string;
  deadlineIso: string;
  sourceTimezone: string;
  comment: string;
  url: string;
}

export type CCFDDLFetcher = (input: string) => Promise<{
  ok: boolean;
  text: () => Promise<string>;
}>;

export type CCFDDLCatDeadlineSelection = Pick<
  CCFDDLDeadlineEntry,
  "title" | "deadlineIso"
>;

export type CCFDDLCatCountdownPrecision = "dh" | "dhm" | "dhms";

export type CCFDDLCatLabelInput =
  | {
      mode: "static";
      staticText: string;
    }
  | {
      mode: "ccfddl";
      selectedEntry: CCFDDLCatDeadlineSelection | null | undefined;
      countdownPrecision?: CCFDDLCatCountdownPrecision;
      unavailable?: boolean;
      now?: number;
    };

interface ConferenceDraft {
  title: string;
  description: string;
  sub: string;
}

interface TimelineDeadlineDraft {
  kind: "abstract" | "deadline";
  deadline: string;
  comment: string;
}

interface ConferenceYearDraft {
  year: string;
  link: string;
  timezone: string;
  timeline: TimelineDeadlineDraft[];
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getScalarAfterPrefix(line: string, prefix: string): string {
  return stripYamlScalar(line.slice(prefix.length));
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeUrl(value: string): string {
  const trimmed = stripYamlScalar(value);
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`;
  return "";
}

function makeEntryId(parts: string[]): string {
  return parts
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncateCatLabel(label: string): string {
  const chars = Array.from(label.trim()).filter((char) => char !== "\n");
  if (chars.length <= 28) return chars.join("") || "Bibilabu";
  return `${chars.slice(0, 27).join("")}...`;
}

export function parseCcfddlTimezoneOffsetMinutes(
  timezone: string,
): number | null {
  const normalized = timezone.trim();
  if (!normalized) return 0;
  if (normalized.toUpperCase() === "AOE") return -12 * 60;

  const match = normalized.match(/^UTC\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return null;

  const [, sign, hoursRaw, minutesRaw] = match;
  const hours = Number.parseInt(hoursRaw, 10);
  const minutes = minutesRaw ? Number.parseInt(minutesRaw, 10) : 0;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const offset = hours * 60 + minutes;
  return sign === "-" ? -offset : offset;
}

export function parseCcfddlDeadlineInstant(
  deadline: string,
  timezone: string,
): string | null {
  if (!deadline || deadline.trim().toUpperCase() === "TBD") return null;

  const match = deadline
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const offsetMinutes = parseCcfddlTimezoneOffsetMinutes(timezone);
  if (offsetMinutes === null) return null;

  const utcMs =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ) -
    offsetMinutes * 60_000;
  return new Date(utcMs).toISOString();
}

export function computeCcfddlDaysLeft(
  deadlineIso: string,
  now = Date.now(),
): number {
  const deadlineMs = new Date(deadlineIso).getTime();
  if (!Number.isFinite(deadlineMs)) return 0;
  const diffMs = deadlineMs - now;
  return Math.max(0, Math.ceil(diffMs / 86_400_000));
}

export interface CCFDDLTimeLeftParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  isDue: boolean;
}

export function computeCcfddlTimeLeftParts(
  deadlineIso: string,
  now = Date.now(),
): CCFDDLTimeLeftParts {
  const deadlineMs = new Date(deadlineIso).getTime();
  if (!Number.isFinite(deadlineMs)) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, isDue: true };
  }

  let remainingSeconds = Math.max(0, Math.floor((deadlineMs - now) / 1000));
  const days = Math.floor(remainingSeconds / 86_400);
  remainingSeconds -= days * 86_400;
  const hours = Math.floor(remainingSeconds / 3600);
  remainingSeconds -= hours * 3600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds - minutes * 60;

  return {
    days,
    hours,
    minutes,
    seconds,
    isDue: deadlineMs <= now,
  };
}

export function formatCcfddlTimeLeft(
  parts: CCFDDLTimeLeftParts,
  precision: CCFDDLCatCountdownPrecision = "dhms",
): string {
  if (parts.isDue) return "Due now";

  const units = [`${parts.days}d`, `${parts.hours}h`];
  if (precision === "dhm" || precision === "dhms") {
    units.push(`${parts.minutes}m`);
  }
  if (precision === "dhms") {
    units.push(`${parts.seconds}s`);
  }
  return units.join(" ");
}

export function parseCcfddlYaml(text: string): CCFDDLDeadlineEntry[] {
  const entries: CCFDDLDeadlineEntry[] = [];
  let conference: ConferenceDraft | null = null;
  let yearDraft: ConferenceYearDraft | null = null;
  let pendingTimeline: TimelineDeadlineDraft[] = [];
  let pendingComment = "";

  const flushPendingTimeline = () => {
    if (!yearDraft || pendingTimeline.length === 0) return;
    yearDraft.timeline.push(
      ...pendingTimeline.map((item) => ({
        ...item,
        comment: pendingComment,
      })),
    );
    pendingTimeline = [];
    pendingComment = "";
  };

  const flushTimeline = () => {
    flushPendingTimeline();
    if (!conference || !yearDraft || yearDraft.timeline.length === 0) return;

    for (const item of yearDraft.timeline) {
      const deadlineIso = parseCcfddlDeadlineInstant(
        item.deadline,
        yearDraft.timezone,
      );
      if (!deadlineIso) continue;

      const comment =
        item.kind === "abstract" && !item.comment ? "abstract" : item.comment;
      const displayTitle = `${conference.title} ${yearDraft.year}${
        comment ? ` (${comment})` : ""
      }`;
      entries.push({
        id: makeEntryId([
          conference.title,
          yearDraft.year,
          comment || item.kind,
          item.deadline,
          yearDraft.timezone,
        ]),
        title: `${conference.title} ${yearDraft.year}`,
        displayTitle,
        description: conference.description,
        sub: conference.sub,
        year: yearDraft.year,
        deadline: item.deadline,
        deadlineIso,
        sourceTimezone: yearDraft.timezone,
        comment,
        url: normalizeUrl(yearDraft.link),
      });
    }

    yearDraft.timeline = [];
  };

  const createYearDraft = (year: string): ConferenceYearDraft => {
    flushTimeline();
    return {
      year,
      link: "",
      timezone: "UTC+0",
      timeline: [],
    };
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- title:")) {
      flushTimeline();
      conference = {
        title: getScalarAfterPrefix(trimmed, "- title:"),
        description: "",
        sub: "",
      };
      yearDraft = null;
      continue;
    }

    if (!conference) continue;

    if (trimmed.startsWith("description:")) {
      conference.description = getScalarAfterPrefix(trimmed, "description:");
      continue;
    }

    if (trimmed.startsWith("sub:")) {
      conference.sub = getScalarAfterPrefix(trimmed, "sub:");
      continue;
    }

    if (trimmed.startsWith("- year:")) {
      yearDraft = createYearDraft(getScalarAfterPrefix(trimmed, "- year:"));
      continue;
    }

    if (trimmed.startsWith("year:")) {
      yearDraft = createYearDraft(getScalarAfterPrefix(trimmed, "year:"));
      continue;
    }

    const activeYear = yearDraft;
    if (!activeYear) continue;

    if (trimmed.startsWith("link:")) {
      activeYear.link = getScalarAfterPrefix(trimmed, "link:");
      continue;
    }

    if (trimmed.startsWith("timezone:")) {
      activeYear.timezone = getScalarAfterPrefix(trimmed, "timezone:");
      continue;
    }

    if (trimmed.startsWith("- abstract_deadline:")) {
      flushPendingTimeline();
      pendingTimeline.push({
        kind: "abstract",
        deadline: getScalarAfterPrefix(trimmed, "- abstract_deadline:"),
        comment: "",
      });
      continue;
    }

    if (trimmed.startsWith("abstract_deadline:")) {
      pendingTimeline.push({
        kind: "abstract",
        deadline: getScalarAfterPrefix(trimmed, "abstract_deadline:"),
        comment: "",
      });
      continue;
    }

    if (trimmed.startsWith("- deadline:")) {
      flushPendingTimeline();
      pendingTimeline.push({
        kind: "deadline",
        deadline: getScalarAfterPrefix(trimmed, "- deadline:"),
        comment: "",
      });
      continue;
    }

    if (trimmed.startsWith("deadline:")) {
      pendingTimeline.push({
        kind: "deadline",
        deadline: getScalarAfterPrefix(trimmed, "deadline:"),
        comment: "",
      });
      continue;
    }

    if (trimmed.startsWith("comment:")) {
      pendingComment = getScalarAfterPrefix(trimmed, "comment:");
    }
  }

  flushTimeline();
  return entries;
}

export function filterFutureCcfddlDeadlines(
  entries: CCFDDLDeadlineEntry[],
  now = Date.now(),
): CCFDDLDeadlineEntry[] {
  const seen = new Set<string>();
  return entries
    .filter((entry) => new Date(entry.deadlineIso).getTime() >= now)
    .sort(
      (left, right) =>
        new Date(left.deadlineIso).getTime() -
        new Date(right.deadlineIso).getTime(),
    )
    .filter((entry) => {
      const key = `${entry.displayTitle}__${entry.deadlineIso}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function searchCcfddlDeadlines(
  entries: CCFDDLDeadlineEntry[],
  query: string,
): CCFDDLDeadlineEntry[] {
  const terms = normalizeText(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return entries;

  return entries.filter((entry) => {
    const haystack = normalizeText(
      [
        entry.title,
        entry.displayTitle,
        entry.description,
        entry.sub,
        entry.year,
        entry.comment,
      ].join(" "),
    );
    return terms.every((term) => haystack.includes(term));
  });
}

export function getCcfddlConferenceName(entry: CCFDDLDeadlineEntry): string {
  return entry.title.replace(/\s+\d{4}$/, "");
}

function fuzzyIncludes(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;

  let haystackIndex = 0;
  for (const char of needle) {
    haystackIndex = haystack.indexOf(char, haystackIndex);
    if (haystackIndex === -1) return false;
    haystackIndex += 1;
  }
  return true;
}

function normalizeCcfddlPickerText(value: string): string {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function filterCcfddlEntriesByConferenceName(
  entries: CCFDDLDeadlineEntry[],
  query: string,
): CCFDDLDeadlineEntry[] {
  const terms = normalizeCcfddlPickerText(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return entries;

  return entries.filter((entry) => {
    const haystack = normalizeCcfddlPickerText(
      `${entry.displayTitle} ${getCcfddlConferenceName(entry)} ${entry.year}`,
    );
    return terms.every((term) => fuzzyIncludes(haystack, term));
  });
}

export async function fetchCcfddlDeadlines(
  fetcher: CCFDDLFetcher = fetch,
): Promise<CCFDDLDeadlineEntry[]> {
  const response = await fetcher(CCFDDL_ALLCONF_URL);
  if (!response.ok) throw new Error("Failed to load CCFDDL deadlines");
  return filterFutureCcfddlDeadlines(parseCcfddlYaml(await response.text()));
}

export function resolveCcfddlCatLabel(input: CCFDDLCatLabelInput): string {
  if (input.mode === "static") return truncateCatLabel(input.staticText);
  if (input.unavailable) return "CCFDDL unavailable";
  if (!input.selectedEntry) return "No deadlines\n| enjoy freedom |";

  const timeLeft = computeCcfddlTimeLeftParts(
    input.selectedEntry.deadlineIso,
    input.now,
  );
  return [
    formatCcfddlTimeLeft(timeLeft, input.countdownPrecision),
    input.selectedEntry.title,
  ].join("\n");
}
