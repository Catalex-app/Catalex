import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ChangeSet, Text } from "@codemirror/state";
import { createDocumentCore } from "./wasm-adapter.mjs";

const core = createDocumentCore(
  readFileSync(
    new URL(
      "./target/wasm32-unknown-unknown/release/catalex_document_core.wasm",
      import.meta.url,
    ),
  ),
);

function request(text, from, to, edits) {
  return {
    document: {
      revision: 7,
      text,
      anchors: [{ id: "a", from, to, resolved: false, positionReset: false }],
    },
    update: { expectedRevision: 7, operations: [{ type: "text", edits }] },
  };
}

test("native and WASM derive identical replacement operations", () => {
  const values = [
    "",
    "\r\n",
    "😀ab\r\ncd",
    "same\nsame\nend",
    "same\nother\nsame\nend\n",
  ];
  const cases = values.flatMap((before) =>
    values.map((after) => ({ before, after })),
  );
  let seed = 19;
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const tokens = ["a", "b", "same ", "😀", "\r\n", "\n", "界"];
  for (let index = 0; index < 200; index++) {
    const before = Array.from(
      { length: 80 },
      () => tokens[Math.floor(random() * tokens.length)],
    );
    const after = [...before];
    for (let edit = 0; edit < 4; edit++)
      after.splice(
        Math.floor(random() * after.length),
        Math.floor(random() * 5),
        tokens[Math.floor(random() * tokens.length)],
      );
    cases.push({ before: before.join(""), after: after.join("") });
  }
  const large = "repeated line 😀\n".repeat(20_000);
  cases.push({ before: large, after: `prefix\n${large}suffix` });
  cases.push({ before: "a".repeat(70_000), after: "b".repeat(70_000) });
  const binary = fileURLToPath(
    new URL(
      `./target/release/examples/wire${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
  const native = spawnSync(binary, ["--diff"], {
    input: `${cases.map(JSON.stringify).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  const results = native.stdout.trim().split("\n").map(JSON.parse);
  for (const [index, { before, after }] of cases.entries()) {
    const result = core.diff(before, after);
    assert.deepEqual(result, results[index]);
    assert.ok(result.Ok, JSON.stringify(result));
    const doc = core(request(before, 0, before.length, result.Ok));
    assert.equal(doc.Ok?.text, after, JSON.stringify(doc));
    assert.equal(
      ChangeSet.of(result.Ok, before.length, "\n")
        .apply(Text.of(before.split("\n")))
        .toString(),
      after,
    );
  }
});

test("native and WASM produce identical results across text boundaries", () => {
  const text = "a😀b\r\ncd";
  const boundaries = [0, 1, 3, 4, 5, 6, 7, 8];
  const cases = [];
  for (const from of boundaries)
    for (const to of boundaries) {
      if (to < from) continue;
      for (const at of boundaries) {
        cases.push(
          request(text, from, to, [{ from: at, to: at, insert: "✨\n" }]),
        );
      }
      cases.push(
        request(text, from, to, [{ from: 0, to: text.length, insert: "" }]),
      );
    }
  const binary = fileURLToPath(
    new URL(
      `./target/release/examples/wire${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
  const native = spawnSync(binary, [], {
    input: `${cases.map(JSON.stringify).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  const results = native.stdout.trim().split("\n").map(JSON.parse);
  for (const [index, value] of cases.entries()) {
    const result = core(value);
    assert.deepEqual(result, results[index]);
    assert.ok(result.Ok, JSON.stringify(result));
    const edits = value.update.operations[0].edits;
    if (edits[0].from === edits[0].to) {
      const changes = ChangeSet.of(edits, text.length, "\n");
      const a = value.document.anchors[0];
      const b = result.Ok.anchors[0];
      assert.equal(b.from, changes.mapPos(a.from, 1));
      assert.equal(b.to, a.from === a.to ? b.from : changes.mapPos(a.to, -1));
    }
  }
});

test("invalid/stale batches return errors and the core remains usable", () => {
  const stale = request("abc", 0, 2, [{ from: 0, to: 0, insert: "x" }]);
  stale.update.expectedRevision = 6;
  assert.match(core(stale).Err, /Stale/);
  assert.match(
    core(request("😀", 0, 2, [{ from: 1, to: 1, insert: "x" }])).Err,
    /Invalid/,
  );
  assert.equal(
    core(request("abc", 0, 2, [{ from: 0, to: 0, insert: "x" }])).Ok.text,
    "xabc",
  );
});

test("replacement and adjacent edit boundaries agree with editor coordinates", () => {
  const cases = [
    [
      { from: 1, to: 3, insert: "AB" },
      { from: 3, to: 3, insert: "X" },
    ],
    [
      { from: 1, to: 3, insert: "" },
      { from: 3, to: 5, insert: "XYZ" },
    ],
    [
      { from: 0, to: 1, insert: "NEW" },
      { from: 4, to: 5, insert: "" },
    ],
  ];
  for (const edits of cases) {
    const changes = ChangeSet.of(edits, 6, "\n");
    for (let position = 0; position <= 6; position++) {
      const result = core(request("abcdef", position, position, edits));
      assert.ok(result.Ok, result.Err);
      assert.equal(
        result.Ok.anchors[0].from,
        changes.mapPos(position, 1),
        JSON.stringify({ edits, position }),
      );
    }
  }
});

test("full deletion and reinsertion restore every retained anchor", () => {
  const value = request("before selected after", 7, 15, [
    { from: 0, to: 21, insert: "" },
  ]);
  const deleted = core(value).Ok;
  assert.ok(deleted);
  const restored = core({
    document: deleted,
    update: {
      expectedRevision: deleted.revision,
      operations: [
        {
          type: "text",
          edits: [{ from: 0, to: 0, insert: value.document.text }],
        },
      ],
    },
  }).Ok;
  assert.deepEqual(restored.anchors, value.document.anchors);
});

test("large deletion fingerprints agree natively and in WASM and survive reopening", () => {
  const text = `😀${"a".repeat(100_000)}😀`;
  const value = request(text, 12, 24, [
    { from: 0, to: text.length, insert: "" },
  ]);
  const deleted = core(value).Ok;
  assert.ok(deleted);
  assert.equal(deleted.anchors[0].removedAnchor.text, undefined);
  assert.equal(deleted.anchors[0].removedAnchor.length, text.length);
  const restoredRequest = {
    document: deleted,
    update: {
      expectedRevision: deleted.revision,
      operations: [{ type: "text", edits: [{ from: 0, to: 0, insert: text }] }],
    },
  };
  const restored = core(restoredRequest).Ok;
  assert.deepEqual(restored.anchors, value.document.anchors);
  const binary = fileURLToPath(
    new URL(
      `./target/release/examples/wire${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
  const native = spawnSync(binary, [], {
    input: `${JSON.stringify(value)}\n${JSON.stringify(restoredRequest)}\n`,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  assert.deepEqual(native.stdout.trim().split("\n").map(JSON.parse), [
    { Ok: deleted },
    { Ok: restored },
  ]);
});

test("report prototype wire cost with 100/500/1000 anchors", () => {
  for (const count of [100, 500, 1000]) {
    let document = {
      revision: 0,
      text: "A sentence with words for testing comment performance.\n".repeat(
        4000,
      ),
      anchors: Array.from({ length: count }, (_, i) => ({
        id: `c-${i}`,
        from: i * 100,
        to: i * 100 + 10,
        resolved: i % 2 === 0,
        positionReset: false,
      })),
    };
    const times = [];
    for (let i = 0; i < 120; i++) {
      const started = performance.now();
      const result = core({
        document,
        update: {
          expectedRevision: document.revision,
          operations: [
            { type: "text", edits: [{ from: 0, to: 0, insert: "x" }] },
          ],
        },
      });
      assert.ok(result.Ok, JSON.stringify(result.Err));
      document = result.Ok;
      if (i >= 20) times.push(performance.now() - started);
    }
    for (const [i, anchor] of document.anchors.entries()) {
      assert.equal(anchor.from, i * 100 + 120);
      assert.equal(anchor.to, i * 100 + 130);
    }
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        anchors: count,
        textBytes: document.text.length,
        medianMs: times[50],
        p95Ms: times[95],
        scope: "Node WASM round trip including JSON, not app typing latency",
      }),
    );
  }
});

test("session rejects stale updates and releases closed documents", () => {
  const document = request("before selected after", 7, 15, []).document;
  const opened = core.session({ type: "open", document }).Ok;
  assert.ok(opened);
  const update = {
    expectedRevision: 7,
    operations: [{ type: "text", edits: [{ from: 0, to: 0, insert: "x" }] }],
  };
  assert.equal(
    core.session({ type: "update", handle: opened.handle, update }).Ok.revision,
    8,
  );
  assert.match(
    core.session({ type: "update", handle: opened.handle, update }).Err,
    /Stale/,
  );
  const read = core.session({ type: "read", handle: opened.handle }).Ok;
  assert.equal(read.text, `x${document.text}`);
  assert.equal(read.anchors[0].from, 8);
  assert.equal(core.session({ type: "close", handle: opened.handle }).Ok, null);
  assert.match(
    core.session({ type: "read", handle: opened.handle }).Err,
    /closed/,
  );
});

test("report retained-document cost without full-text wire transfers", () => {
  for (const size of [220_000, 2_200_000]) {
    const document = {
      revision: 0,
      text: "a".repeat(size),
      anchors: Array.from({ length: 1000 }, (_, i) => ({
        id: `c-${i}`,
        from: i * 100,
        to: i * 100 + 10,
        resolved: i % 2 === 0,
        positionReset: false,
      })),
    };
    const opened = core.session({ type: "open", document }).Ok;
    assert.ok(opened);
    let current = opened;
    const times = [];
    try {
      for (let i = 0; i < 120; i++) {
        const start = performance.now();
        const result = core.session({
          type: "update",
          handle: opened.handle,
          update: {
            expectedRevision: current.revision,
            operations: [
              { type: "text", edits: [{ from: 0, to: 0, insert: "x" }] },
            ],
          },
        });
        assert.ok(result.Ok, result.Err);
        current = result.Ok;
        if (i >= 20) times.push(performance.now() - start);
      }
      assert.equal(current.anchors[999].from, 100_020);
      assert.equal(
        core.session({ type: "read", handle: opened.handle }).Ok.text,
        `${"x".repeat(120)}${document.text}`,
      );
      times.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          anchors: 1000,
          textBytes: size,
          medianMs: times[50],
          p95Ms: times[95],
          scope: "Node retained-document WASM, not app typing latency",
        }),
      );
    } finally {
      core.session({ type: "close", handle: opened.handle });
    }
  }
});
