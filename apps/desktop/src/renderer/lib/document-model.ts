import {
  createDocumentCore,
  type Anchor,
  type Core,
  type Operation,
  type Result,
  type View,
} from "../../../../../packages/document-core/wasm-adapter.mjs";
import { documentCoreWasm } from "./document-core.generated";

export type { Anchor as DocumentAnchor, Operation as DocumentOperation };

let core: Core | undefined;
function engine() {
  return (core ??= createDocumentCore(
    Uint8Array.from(atob(documentCoreWasm), (character) =>
      character.charCodeAt(0),
    ),
  ));
}
function unwrap<T>(result: Result<T>): T {
  if ("Err" in result) throw new Error(result.Err);
  return result.Ok;
}

export function documentReplacementEdits(before: string, after: string) {
  return before === after ? [] : unwrap(engine().diff(before, after));
}

/** One local document timeline. A disposed instance cannot submit old updates
 * to a reopened document, even if both documents have the same revision. */
export class DocumentModel {
  private view: View;
  private closed = false;

  private constructor(view: View) {
    this.view = view;
  }

  static open(text: string, anchors: Anchor[], revision = 0) {
    return new DocumentModel(
      unwrap(
        engine().session({
          type: "open",
          document: { text, anchors, revision },
        }),
      ),
    );
  }

  get revision() {
    return this.view.revision;
  }
  get anchors(): readonly Anchor[] {
    return this.view.anchors;
  }

  apply(operations: Operation[], expectedRevision = this.revision) {
    this.assertOpen();
    const next = unwrap(
      engine().session({
        type: "update",
        handle: this.view.handle,
        update: { expectedRevision, operations },
      }),
    );
    this.view = next;
    return this.anchors;
  }

  snapshot() {
    this.assertOpen();
    return unwrap(engine().session({ type: "read", handle: this.view.handle }));
  }

  fork(operations: Operation[], expectedRevision = this.revision) {
    this.assertOpen();
    return new DocumentModel(
      unwrap(
        engine().session({
          type: "fork",
          handle: this.view.handle,
          update: { expectedRevision, operations },
        }),
      ),
    );
  }

  dispose() {
    if (this.closed) return;
    unwrap(engine().session({ type: "close", handle: this.view.handle }));
    this.closed = true;
  }

  private assertOpen() {
    if (this.closed) throw new Error("Document timeline is closed");
  }
}
