export type CsvDelimiter = "," | ";" | "\t";

export interface CsvDocument {
  rows: string[][];
  delimiter: CsvDelimiter;
  lineEnding: "\n" | "\r\n";
  hasTrailingLineBreak: boolean;
}

function countUnquotedDelimiters(
  source: string,
  candidates: readonly CsvDelimiter[],
): Map<CsvDelimiter, number> {
  const counts = new Map(candidates.map((delimiter) => [delimiter, 0]));
  let quoted = false;
  let recordCount = 0;

  for (let index = 0; index < source.length && recordCount < 10; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      recordCount += 1;
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      continue;
    }
    if (!quoted && counts.has(char as CsvDelimiter)) {
      const delimiter = char as CsvDelimiter;
      counts.set(delimiter, (counts.get(delimiter) ?? 0) + 1);
    }
  }

  return counts;
}

export function detectCsvDelimiter(source: string): CsvDelimiter {
  const candidates = [",", ";", "\t"] as const;
  const counts = countUnquotedDelimiters(source, candidates);
  let best: CsvDelimiter = ",";
  for (const delimiter of candidates) {
    if ((counts.get(delimiter) ?? 0) > (counts.get(best) ?? 0)) {
      best = delimiter;
    }
  }
  return best;
}

export function parseCsv(source: string): CsvDocument {
  const delimiter = detectCsvDelimiter(source);
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingLineBreak = /(?:\r\n|\r|\n)$/.test(source);
  if (source.length === 0) {
    return { rows: [], delimiter, lineEnding, hasTrailingLineBreak: false };
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const pushRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      pushRow();
      if (char === "\r" && source[index + 1] === "\n") index += 1;
    } else {
      field += char;
    }
  }

  if (!hasTrailingLineBreak) {
    pushRow();
  }

  return { rows, delimiter, lineEnding, hasTrailingLineBreak };
}

function escapeCsvField(value: string, delimiter: CsvDelimiter): string {
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function serializeCsv(document: CsvDocument): string {
  const body = document.rows
    .map((row) =>
      row
        .map((field) => escapeCsvField(field, document.delimiter))
        .join(document.delimiter),
    )
    .join(document.lineEnding);
  if (!document.hasTrailingLineBreak || document.rows.length === 0) return body;
  return `${body}${document.lineEnding}`;
}

export function csvColumnLabel(index: number): string {
  let label = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}
