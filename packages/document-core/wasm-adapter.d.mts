export type RemovedAnchor = { from: number; to: number } & (
  | { text: string; sha256?: never; length?: never }
  | { text?: never; sha256: string; length: number }
);
export interface Anchor {
  id: string;
  from: number;
  to: number;
  resolved?: boolean;
  positionReset?: boolean;
  removedAnchor?: RemovedAnchor;
}
export interface Document {
  revision: number;
  text: string;
  anchors: Anchor[];
}
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}
export type Operation =
  | { type: "text"; edits: TextEdit[] }
  | { type: "putAnchor"; anchor: Anchor }
  | { type: "removeAnchor"; id: string }
  | { type: "resolve"; id: string; resolved: boolean };
export interface Update {
  expectedRevision: number;
  operations: Operation[];
}
export type Result<T> = { Ok: T } | { Err: string };
export interface View {
  handle: number;
  revision: number;
  anchors: Anchor[];
}
export interface Core {
  diff(before: string, after: string): Result<TextEdit[]>;
  (request: { document: Document; update: Update }): Result<Document>;
  session(command: { type: "open"; document: Document }): Result<View>;
  session(command: {
    type: "update" | "fork";
    handle: number;
    update: Update;
  }): Result<View>;
  session(command: { type: "read"; handle: number }): Result<Document>;
  session(command: { type: "close"; handle: number }): Result<null>;
}
export function createDocumentCore(bytes: BufferSource): Core;
