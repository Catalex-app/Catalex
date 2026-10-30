export type GitLineChangeKind = "add" | "delete" | "modify";

export interface GitLineChange {
  line: number;
  kind: GitLineChangeKind;
  removedText?: string;
}

interface DiffOp {
  type: "eq" | "del" | "add";
  oldIdx?: number;
  newIdx?: number;
  text: string;
}

export function computeLineDiffOps(
  oldLines: string[],
  newLines: string[],
): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      ops.push({ type: "eq", oldIdx: i, newIdx: j, text: oldLines[i] });
      i++;
      j++;
      continue;
    }

    let foundOld = -1;
    let foundNew = -1;
    const searchLimit = Math.min(
      50,
      Math.max(oldLines.length - i, newLines.length - j),
    );
    for (let look = 1; look <= searchLimit; look++) {
      if (
        i + look < oldLines.length &&
        j < newLines.length &&
        oldLines[i + look] === newLines[j]
      ) {
        foundOld = i + look;
        break;
      }
      if (
        j + look < newLines.length &&
        i < oldLines.length &&
        oldLines[i] === newLines[j + look]
      ) {
        foundNew = j + look;
        break;
      }
    }

    if (foundOld !== -1) {
      while (i < foundOld) {
        ops.push({ type: "del", oldIdx: i, text: oldLines[i] });
        i++;
      }
    } else if (foundNew !== -1) {
      while (j < foundNew) {
        ops.push({ type: "add", newIdx: j, text: newLines[j] });
        j++;
      }
    } else {
      if (i < oldLines.length) {
        ops.push({ type: "del", oldIdx: i, text: oldLines[i] });
        i++;
      }
      if (j < newLines.length) {
        ops.push({ type: "add", newIdx: j, text: newLines[j] });
        j++;
      }
    }
  }

  return ops;
}

export function computeGitLineChanges(
  headContent: string | null,
  currentContent: string,
): GitLineChange[] {
  const newLines = currentContent.split("\n");
  if (headContent === null) {
    if (newLines.length === 0) return [];
    return newLines.map((_, index) => ({ line: index + 1, kind: "add" }));
  }

  const oldLines = headContent.split("\n");
  const ops = computeLineDiffOps(oldLines, newLines);
  const changes = new Map<number, GitLineChangeKind>();
  const removedText = new Map<number, string>();
  const deletedAnchors = new Set<number>();

  for (let i = 0; i < ops.length; ) {
    if (ops[i].type === "eq") {
      i++;
      continue;
    }

    const deleted: DiffOp[] = [];
    const added: DiffOp[] = [];
    while (i < ops.length && ops[i].type === "del") {
      deleted.push(ops[i]);
      i++;
    }
    while (i < ops.length && ops[i].type === "add") {
      added.push(ops[i]);
      i++;
    }

    if (deleted.length > 0 && added.length > 0) {
      if (added[0].newIdx !== undefined)
        removedText.set(
          added[0].newIdx + 1,
          deleted.map((op) => op.text).join("\n"),
        );
      for (const op of added) {
        if (op.newIdx !== undefined) {
          changes.set(op.newIdx + 1, "modify");
        }
      }
      continue;
    }

    if (added.length > 0) {
      for (const op of added) {
        if (op.newIdx !== undefined) {
          changes.set(op.newIdx + 1, "add");
        }
      }
      continue;
    }

    if (deleted.length > 0) {
      const nextNewIdx = ops[i]?.newIdx;
      const anchorLine =
        nextNewIdx !== undefined
          ? nextNewIdx + 1
          : Math.max(1, newLines.length === 0 ? 1 : newLines.length);
      if (!changes.has(anchorLine) || changes.get(anchorLine) === "add") {
        changes.set(anchorLine, "delete");
      }
      deletedAnchors.add(anchorLine);
      removedText.set(
        anchorLine,
        [removedText.get(anchorLine), deleted.map((op) => op.text).join("\n")]
          .filter((text) => text !== undefined)
          .join("\n"),
      );
    }
  }

  return Array.from(changes.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([line, kind]) => ({
      line,
      kind: deletedAnchors.has(line) && kind === "add" ? "delete" : kind,
      ...(removedText.has(line) ? { removedText: removedText.get(line) } : {}),
    }));
}
