import type { SynctexSourceMap } from "../src/renderer/lib/latex-compiler";

// Browser-demo counterpart of backend/src/synctex_boxes.rs.
export function demoSourceMap(data: string, file: string): SynctexSourceMap {
  const map: SynctexSourceMap = { inputs: {}, boxes: [] };
  let magnification = 1000,
    unit = 1,
    xOffset = 0,
    yOffset = 0;
  let page = 0,
    lastV = 0,
    content = false;
  let stack: (number | null)[] = [];
  const forms: { page: number; stack: (number | null)[] }[] = [];
  for (const record of data.split(/\r?\n/).map((line) => line.trim())) {
    const input = /^Input:(\d+):(.+)$/.exec(record);
    if (input) {
      if (input[2].endsWith("/main.tex") || input[2] === "main.tex")
        map.inputs[Number(input[1])] = file;
      continue;
    }
    if (!content) {
      const value = Number(record.split(":")[1]);
      if (record.startsWith("Magnification:")) magnification = value;
      if (record.startsWith("Unit:")) unit = value;
      if (record.startsWith("X Offset:")) xOffset = value;
      if (record.startsWith("Y Offset:")) yOffset = value;
      if (record === "Content:") content = true;
      continue;
    }
    if (record.startsWith("Postamble:")) break;
    const kind = record[0];
    if (kind === "{") {
      page = Number(record.slice(1));
      stack = [];
      continue;
    }
    if (kind === "<") {
      forms.push({ page, stack });
      page = 0;
      stack = [];
      continue;
    }
    if (kind === ">") {
      const saved = forms.pop();
      if (saved) ({ page, stack } = saved);
      continue;
    }
    if (kind === "}") {
      page = 0;
      stack = [];
      continue;
    }
    if (kind === ")" || kind === "]") {
      stack.pop();
      continue;
    }
    if (!kind || !"[(hvxgk$".includes(kind)) continue;
    const [source, point, dimensions] = record.slice(1).split(":");
    const [tag, line] = source.split(",").map(Number);
    const [h, rawV] = (point ?? "").split(",");
    const v = rawV === "=" ? lastV : Number(rawV);
    if (Number.isFinite(v)) lastV = v;
    if (kind === "[") {
      stack.push(null);
      continue;
    }
    if (kind === "(") {
      const [w, height, depth] = (dimensions ?? "").split(",").map(Number);
      if (
        page > 0 &&
        [tag, line, Number(h), v, w, height, depth].every(Number.isFinite)
      ) {
        const factor = (((unit * magnification) / (1000 * 65536)) * 72) / 72.27;
        stack.push(map.boxes.length);
        map.boxes.push({
          page,
          x: (Number(h) + xOffset + Math.min(w, 0)) * factor,
          y: (v + yOffset - height) * factor,
          width: Math.abs(w) * factor,
          height: Math.max(0, height + depth) * factor,
          sources: [{ tag, line }],
        });
      } else stack.push(null);
    } else {
      const index = stack.at(-1);
      if (index != null && Number.isFinite(tag) && Number.isFinite(line)) {
        const sources = map.boxes[index].sources;
        if (!sources.some((s) => s.tag === tag && s.line === line))
          sources.push({ tag, line });
      }
    }
  }
  map.boxes = map.boxes.filter((box) => box.width > 0 && box.height > 0);
  return map;
}
