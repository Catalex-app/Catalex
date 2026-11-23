export const commentColors = {
  yellow: {
    tint: "var(--color-amber-300)",
    stroke: "var(--color-amber-500)",
    card: "#eab308",
    badge: "#ca8a04",
  },
  orange: {
    tint: "#ffad83",
    stroke: "#ed753f",
    card: "#ba4b27",
    badge: "#923518",
  },
  green: {
    tint: "#80d9b0",
    stroke: "#32aa7a",
    card: "#217b59",
    badge: "#185b41",
  },
  blue: {
    tint: "#90cdfb",
    stroke: "#459fe3",
    card: "#2d70aa",
    badge: "#21547e",
  },
  pink: {
    tint: "#f59bb8",
    stroke: "#e26b97",
    card: "#af3e70",
    badge: "#812a51",
  },
  gray: {
    tint: "#bfc2c5",
    stroke: "#8c9094",
    card: "#565a5e",
    badge: "#3f4347",
  },
} as const;

export type CommentColor = keyof typeof commentColors;
export type StoredCommentColor = Exclude<CommentColor, "yellow">;

export function normalizeCommentColor(value: unknown): CommentColor {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(commentColors, value)
    ? (value as CommentColor)
    : "yellow";
}

export function storedCommentColor(
  color: CommentColor,
): StoredCommentColor | undefined {
  return color === "yellow" ? undefined : color;
}

export function commentMarkPaint(color?: StoredCommentColor, agent = false) {
  const { tint, stroke } = agent
    ? { tint: "#7252b5", stroke: "#7252b5" }
    : commentColors[color ?? "yellow"];
  return {
    background: `color-mix(in oklab, ${tint} 25%, transparent)`,
    hover: `color-mix(in oklab, ${tint} 45%, transparent)`,
    border: `color-mix(in oklab, ${stroke} 70%, transparent)`,
    stroke,
  };
}
