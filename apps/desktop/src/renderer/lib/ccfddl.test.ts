import { describe, expect, it } from "vitest";
import {
  CCFDDL_ALLCONF_URL,
  computeCcfddlDaysLeft,
  computeCcfddlTimeLeftParts,
  fetchCcfddlDeadlines,
  filterCcfddlEntriesByConferenceName,
  filterFutureCcfddlDeadlines,
  formatCcfddlTimeLeft,
  parseCcfddlDeadlineInstant,
  parseCcfddlTimezoneOffsetMinutes,
  parseCcfddlYaml,
  resolveCcfddlCatLabel,
  searchCcfddlDeadlines,
} from "./ccfddl";

const SAMPLE_YAML = `
- title: SIGMOD
  description: ACM Conference on Management of Data
  sub: DB
  confs:
    - year: 2027
      id: sigmod27
      link: https://2027.sigmod.org/
      timeline:
        - deadline: '2026-07-02 17:00:00'
          comment: 'first round'
        - abstract_deadline: '2026-09-01 17:00:00'
          deadline: '2026-09-08 17:00:00'
          comment: 'second round'
      timezone: UTC-8
- title: AOEConf
  description: Anywhere on Earth Conference
  sub: AI
  confs:
    - year: 2027
      link: www.example.com
      timeline:
        - deadline: '2026-01-01 23:59:59'
      timezone: AoE
- title: TBDConf
  description: Missing deadline
  sub: SE
  confs:
    - year: 2027
      link: https://example.com
      timeline:
        - deadline: TBD
      timezone: UTC+0
`;

describe("ccfddl helpers", () => {
  it("fetches the CORS-enabled CCFDDL host directly", async () => {
    const seenUrls: string[] = [];
    await fetchCcfddlDeadlines(async (url) => {
      seenUrls.push(url);
      return {
        ok: true,
        text: async () => SAMPLE_YAML,
      };
    });

    expect(CCFDDL_ALLCONF_URL).toBe(
      "https://ccfddl.com/conference/allconf.yml",
    );
    expect(seenUrls).toEqual([CCFDDL_ALLCONF_URL]);
  });

  it("parses UTC offsets and AoE", () => {
    expect(parseCcfddlTimezoneOffsetMinutes("UTC-8")).toBe(-480);
    expect(parseCcfddlTimezoneOffsetMinutes("UTC+10")).toBe(600);
    expect(parseCcfddlTimezoneOffsetMinutes("AoE")).toBe(-720);
  });

  it("parses deadline instants using the source timezone", () => {
    expect(parseCcfddlDeadlineInstant("2026-07-02 17:00:00", "UTC-8")).toBe(
      "2026-07-03T01:00:00.000Z",
    );
    expect(parseCcfddlDeadlineInstant("2026-01-01 23:59:59", "AoE")).toBe(
      "2026-01-02T11:59:59.000Z",
    );
  });

  it("parses deadlines, abstract deadlines, comments, links, and ignores TBD", () => {
    const entries = parseCcfddlYaml(SAMPLE_YAML);

    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.displayTitle)).toEqual([
      "SIGMOD 2027 (first round)",
      "SIGMOD 2027 (second round)",
      "SIGMOD 2027 (second round)",
      "AOEConf 2027",
    ]);
    expect(entries[1].deadlineIso).toBe("2026-09-02T01:00:00.000Z");
    expect(entries[3].url).toBe("https://www.example.com");
  });

  it("filters future entries, sorts them, and deduplicates display/deadline pairs", () => {
    const [first] = parseCcfddlYaml(SAMPLE_YAML);
    const duplicate = { ...first, id: "duplicate" };
    const future = filterFutureCcfddlDeadlines(
      [duplicate, ...parseCcfddlYaml(SAMPLE_YAML)],
      Date.UTC(2026, 0, 1),
    );

    expect(future[0].title).toBe("AOEConf 2027");
    expect(
      future.filter((entry) => entry.displayTitle.includes("first round")),
    ).toHaveLength(1);
  });

  it("searches by acronym, year, description, and comment", () => {
    const entries = parseCcfddlYaml(SAMPLE_YAML);

    expect(searchCcfddlDeadlines(entries, "sigmod second")).toHaveLength(2);
    expect(searchCcfddlDeadlines(entries, "earth ai")).toHaveLength(1);
  });

  it("filters conference picker entries by fuzzy conference name only", () => {
    const entries = [
      {
        id: "sigmod",
        title: "SIGMOD 2027",
        displayTitle: "SIGMOD 2027 (Round 2)",
        description: "ACM Conference on Management of Data",
        sub: "DB",
        year: "2027",
        deadline: "2026-07-02 17:00:00",
        deadlineIso: "2026-07-03T01:00:00.000Z",
        sourceTimezone: "UTC-8",
        comment: "",
        url: "https://2027.sigmod.org/",
      },
      {
        id: "icse",
        title: "ICSE 2027",
        displayTitle: "ICSE 2027",
        description: "Software engineering conference",
        sub: "SE",
        year: "2027",
        deadline: "2026-08-01 17:00:00",
        deadlineIso: "2026-08-01T17:00:00.000Z",
        sourceTimezone: "UTC+0",
        comment: "",
        url: "https://conf.example/icse",
      },
    ];

    expect(
      filterCcfddlEntriesByConferenceName(entries, "sgmd").map(
        (entry) => entry.title,
      ),
    ).toEqual(["SIGMOD 2027"]);
    expect(
      filterCcfddlEntriesByConferenceName(entries, "SIGMOD 2027").map(
        (entry) => entry.title,
      ),
    ).toEqual(["SIGMOD 2027"]);
    expect(
      filterCcfddlEntriesByConferenceName(entries, "SIGMOD 2027 (Round 2)").map(
        (entry) => entry.title,
      ),
    ).toEqual(["SIGMOD 2027"]);
    expect(
      filterCcfddlEntriesByConferenceName(entries, "sigmod round 2").map(
        (entry) => entry.title,
      ),
    ).toEqual(["SIGMOD 2027"]);
    expect(
      filterCcfddlEntriesByConferenceName(entries, "management"),
    ).toHaveLength(0);
  });

  it("ranks exact conference names first while preserving deadline order", () => {
    const base = parseCcfddlYaml(SAMPLE_YAML)[0];
    const entries = [
      ["rtas", "RTAS 2027", "RTAS 2027 (first round)", "2026-11-01"],
      ["refsq", "REFSQ 2027", "REFSQ 2027 (second round)", "2026-11-02"],
      ["rss-abstract", "RSS 2027", "RSS 2027 (abstract)", "2026-12-01"],
      ["rss-paper", "RSS 2027", "RSS 2027 (paper)", "2026-12-08"],
      ["rss-next", "RSS 2028", "RSS 2028", "2027-12-01"],
    ].map(([id, title, displayTitle, date]) => ({
      ...base,
      id,
      title,
      displayTitle,
      year: title.slice(-4),
      deadlineIso: `${date}T00:00:00.000Z`,
    }));
    const ids = (query: string) =>
      filterCcfddlEntriesByConferenceName(entries, query).map(({ id }) => id);

    expect(ids("RSS")).toEqual([
      "rss-abstract",
      "rss-paper",
      "rss-next",
      "rtas",
      "refsq",
    ]);
    for (const query of ["RSS 2027", "  rss   2027  ", "RSS-2027"]) {
      expect(ids(query)).toEqual([
        "rss-abstract",
        "rss-paper",
        "rtas",
        "refsq",
      ]);
    }
    expect(ids("rs 2027")).toEqual([
      "rtas",
      "refsq",
      "rss-abstract",
      "rss-paper",
    ]);
    expect(ids("rss paper")).toEqual(["rss-paper"]);
    expect(ids("  ")).toEqual(entries.map(({ id }) => id));
    expect(ids("unmatched")).toEqual([]);
    expect(entries[0].id).toBe("rtas");
  });

  it("computes days left and resolves cat labels", () => {
    const entry = parseCcfddlYaml(SAMPLE_YAML)[0];

    expect(
      computeCcfddlDaysLeft(entry.deadlineIso, Date.UTC(2026, 6, 1, 1)),
    ).toBe(2);
    const parts = computeCcfddlTimeLeftParts(
      entry.deadlineIso,
      Date.UTC(2026, 6, 1, 1, 2, 3),
    );
    expect(parts).toEqual({
      days: 1,
      hours: 23,
      minutes: 57,
      seconds: 57,
      isDue: false,
    });
    expect(formatCcfddlTimeLeft(parts, "dh")).toBe("1d 23h");
    expect(formatCcfddlTimeLeft(parts, "dhm")).toBe("1d 23h 57m");
    expect(formatCcfddlTimeLeft(parts, "dhms")).toBe("1d 23h 57m 57s");
    expect(
      resolveCcfddlCatLabel({
        mode: "ccfddl",
        selectedEntry: entry,
        countdownPrecision: "dhm",
        now: Date.UTC(2026, 6, 1, 1, 2, 3),
      }),
    ).toBe("1d 23h 57m\nSIGMOD 2027");
    expect(resolveCcfddlCatLabel({ mode: "ccfddl", selectedEntry: null })).toBe(
      "No deadlines\n| enjoy freedom |",
    );
    expect(
      resolveCcfddlCatLabel({
        mode: "ccfddl",
        selectedEntry: null,
        unavailable: true,
      }),
    ).toBe("CCFDDL unavailable");
    expect(
      resolveCcfddlCatLabel({ mode: "static", staticText: "Bibilabu" }),
    ).toBe("Bibilabu");
  });
});
