/** One scan per source revision; subsequent offset/line conversions are indexed. */
export function createSourceLineIndex(content: string) {
  let cached: number[] | null = null;
  const getStarts = () => {
    if (cached) return cached;
    cached = [0];
    for (
      let at = content.indexOf("\n");
      at !== -1;
      at = content.indexOf("\n", at + 1)
    )
      cached.push(at + 1);
    return cached;
  };
  const length = (line: number) => {
    const starts = getStarts();
    return Math.max(
      0,
      (starts[line + 1] ?? content.length + 1) - starts[line] - 1,
    );
  };
  return {
    coordinate(position: number) {
      const starts = getStarts();
      const offset = Math.max(0, Math.min(content.length, position));
      let low = 0;
      let high = starts.length;
      while (low + 1 < high) {
        const mid = (low + high) >>> 1;
        if (starts[mid] <= offset) low = mid;
        else high = mid;
      }
      return (
        low +
        1 +
        Math.min(
          1 - (low + 2) * Number.EPSILON,
          (offset - starts[low]) / Math.max(1, length(low)),
        )
      );
    },
    offset(coordinate: number, column?: number) {
      const starts = getStarts();
      const line = Math.max(
        0,
        Math.min(starts.length - 1, Math.floor(coordinate) - 1),
      );
      const within =
        column ??
        Math.round((coordinate - Math.floor(coordinate)) * length(line));
      return starts[line] + Math.max(0, Math.min(length(line), within));
    },
    lineAndColumn(position: number) {
      const coordinate = this.coordinate(position);
      const line = Math.floor(coordinate);
      return {
        line,
        column:
          Math.max(0, Math.min(content.length, position)) -
          getStarts()[line - 1] +
          1,
      };
    },
  };
}
