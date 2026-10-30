import { useCallback, useMemo } from "react";
import { Columns3Icon, PlusIcon, Rows3Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  csvColumnLabel,
  parseCsv,
  serializeCsv,
  type CsvDocument,
} from "@/lib/csv";
import { useDocumentStore } from "@/stores/document-store";

function delimiterLabel(delimiter: CsvDocument["delimiter"]): string {
  if (delimiter === "\t") return "Tab separated";
  if (delimiter === ";") return "Semicolon separated";
  return "Comma separated";
}

export function CsvTable() {
  const activeFile = useDocumentStore((state) =>
    state.files.find((file) => file.id === state.activeFileId),
  );
  const updateFileContent = useDocumentStore(
    (state) => state.updateFileContent,
  );
  const isReadOnly = useDocumentStore(
    (state) => state.isAgentWorkspaceReadOnly,
  );
  const source = activeFile?.content ?? "";
  const csv = useMemo(() => parseCsv(source), [source]);
  const columnCount = Math.max(1, ...csv.rows.map((row) => row.length));
  const visibleRows = csv.rows.length > 0 ? csv.rows : [[""]];

  const commitRows = useCallback(
    (rows: string[][]) => {
      if (!activeFile || activeFile.type !== "csv" || isReadOnly) return;
      updateFileContent(
        activeFile.id,
        serializeCsv({
          ...csv,
          rows,
          hasTrailingLineBreak:
            rows.length > 0 ? csv.hasTrailingLineBreak : false,
        }),
      );
    },
    [activeFile, csv, isReadOnly, updateFileContent],
  );

  const updateCell = useCallback(
    (rowIndex: number, columnIndex: number, value: string) => {
      const rows = csv.rows.map((row) => [...row]);
      while (rows.length <= rowIndex) rows.push([]);
      while (rows[rowIndex].length <= columnIndex) rows[rowIndex].push("");
      rows[rowIndex][columnIndex] = value;
      commitRows(rows);
    },
    [commitRows, csv.rows],
  );

  const addRow = useCallback(() => {
    const rows = csv.rows.map((row) => [...row]);
    rows.push(Array.from({ length: columnCount }, () => ""));
    commitRows(rows);
  }, [columnCount, commitRows, csv.rows]);

  const addColumn = useCallback(() => {
    const rows = csv.rows.length > 0 ? csv.rows.map((row) => [...row]) : [[]];
    const nextColumnCount = columnCount + 1;
    for (const row of rows) {
      while (row.length < nextColumnCount) row.push("");
    }
    commitRows(rows);
  }, [columnCount, commitRows, csv.rows]);

  const pasteGrid = useCallback(
    (startRow: number, startColumn: number, text: string) => {
      const pasted = parseCsv(text);
      if (pasted.rows.length === 0) return;
      const rows = csv.rows.map((row) => [...row]);
      for (let rowOffset = 0; rowOffset < pasted.rows.length; rowOffset++) {
        const targetRow = startRow + rowOffset;
        while (rows.length <= targetRow) rows.push([]);
        for (
          let columnOffset = 0;
          columnOffset < pasted.rows[rowOffset].length;
          columnOffset++
        ) {
          const targetColumn = startColumn + columnOffset;
          while (rows[targetRow].length <= targetColumn) {
            rows[targetRow].push("");
          }
          rows[targetRow][targetColumn] = pasted.rows[rowOffset][columnOffset];
        }
      }
      commitRows(rows);
    },
    [commitRows, csv.rows],
  );

  if (!activeFile || activeFile.type !== "csv") return null;

  if (activeFile.content === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground text-sm">
        Open this large CSV in the raw editor before showing its table.
      </div>
    );
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={`${activeFile.name} table`}
      data-testid="csv-table"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-border/70 border-b px-3">
        <div className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          <span data-testid="csv-table-size">
            {csv.rows.length.toLocaleString()} rows · {columnCount} columns
          </span>
          <span className="mx-2 text-border">|</span>
          <span>{delimiterLabel(csv.delimiter)}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={addRow}
          disabled={isReadOnly}
          aria-label="Add CSV row"
        >
          <Rows3Icon className="size-3.5" />
          <PlusIcon className="-ml-1 size-3" />
          Row
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={addColumn}
          disabled={isReadOnly}
          aria-label="Add CSV column"
        >
          <Columns3Icon className="size-3.5" />
          <PlusIcon className="-ml-1 size-3" />
          Column
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto" data-testid="csv-grid">
        <table className="min-w-full table-fixed border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-20 bg-muted/95 backdrop-blur-sm">
            <tr>
              <th
                className="sticky left-0 z-30 h-8 w-12 min-w-12 border-border/70 border-r border-b bg-muted px-2 text-center font-medium text-muted-foreground text-xs"
                aria-label="Row number"
              />
              {Array.from({ length: columnCount }, (_, columnIndex) => (
                <th
                  key={columnIndex}
                  scope="col"
                  className="h-8 min-w-40 border-border/70 border-r border-b bg-muted px-3 text-left font-medium text-muted-foreground text-xs last:border-r-0"
                >
                  {csvColumnLabel(columnIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr key={rowIndex} className="group">
                <th
                  scope="row"
                  className="sticky left-0 z-10 h-9 w-12 min-w-12 border-border/70 border-r border-b bg-muted/95 px-2 text-center font-normal text-muted-foreground text-xs group-hover:bg-muted"
                >
                  {rowIndex + 1}
                </th>
                {Array.from({ length: columnCount }, (_, columnIndex) => (
                  <td
                    key={columnIndex}
                    className="h-9 min-w-40 border-border/70 border-r border-b bg-card p-0 last:border-r-0 group-hover:bg-muted/20"
                  >
                    <input
                      value={row[columnIndex] ?? ""}
                      onChange={(event) =>
                        updateCell(rowIndex, columnIndex, event.target.value)
                      }
                      onPaste={(event) => {
                        const text = event.clipboardData.getData("text/plain");
                        if (!/[\t\r\n]/.test(text)) return;
                        event.preventDefault();
                        pasteGrid(rowIndex, columnIndex, text);
                      }}
                      readOnly={isReadOnly}
                      className="h-full w-full min-w-40 bg-transparent px-3 py-1 outline-none read-only:cursor-default focus:bg-background focus:ring-2 focus:ring-primary/35 focus:ring-inset"
                      aria-label={`Row ${rowIndex + 1}, column ${csvColumnLabel(columnIndex)}`}
                      data-csv-cell={`${rowIndex}:${columnIndex}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
