import { describe, expect, it } from "vitest";
import {
  csvColumnLabel,
  detectCsvDelimiter,
  parseCsv,
  serializeCsv,
} from "./csv";

describe("CSV utilities", () => {
  it("parses quoted delimiters, escaped quotes, and embedded newlines", () => {
    const source =
      'name,notes\r\nAda,"uses, commas"\r\nGrace,"said ""hello""\nagain"\r\n';
    const document = parseCsv(source);

    expect(document).toEqual({
      rows: [
        ["name", "notes"],
        ["Ada", "uses, commas"],
        ["Grace", 'said "hello"\nagain'],
      ],
      delimiter: ",",
      lineEnding: "\r\n",
      hasTrailingLineBreak: true,
    });
    expect(serializeCsv(document)).toBe(source);
  });

  it("detects common semicolon and tab delimited CSV variants", () => {
    expect(detectCsvDelimiter("name;score\nAda;10")).toBe(";");
    expect(detectCsvDelimiter("name\tscore\nAda\t10")).toBe("\t");
    expect(detectCsvDelimiter("name,score\nAda,10")).toBe(",");
  });

  it("preserves files without a trailing line break", () => {
    const document = parseCsv("a,b\n1,2");
    expect(document.hasTrailingLineBreak).toBe(false);
    expect(serializeCsv(document)).toBe("a,b\n1,2");
  });

  it("treats an empty file as an empty grid", () => {
    expect(parseCsv("").rows).toEqual([]);
    expect(serializeCsv(parseCsv(""))).toBe("");
  });

  it("formats spreadsheet-style column labels", () => {
    expect(csvColumnLabel(0)).toBe("A");
    expect(csvColumnLabel(25)).toBe("Z");
    expect(csvColumnLabel(26)).toBe("AA");
  });
});
