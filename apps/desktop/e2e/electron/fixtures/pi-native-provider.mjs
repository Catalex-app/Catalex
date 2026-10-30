// Loaded by the real Pi from the selected user config. Scripted local responses exercise
// native tool execution without a network request or model credentials.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";

export default function fixture(pi) {
  let step = 0;
  const source = process.env.CATALEX_PI_FIXTURE_SOURCE;
  assert.ok(source);
  assert.notEqual(process.cwd(), source);
  pi.on("session_start", (_event, ctx) => {
    assert.equal(ctx.cwd, process.cwd());
    assert.deepEqual(
      ctx.scopedModels.map(({ model }) => model.id),
      ["fixture"],
    );
  });
  const calls = [
    ["write", { path: "new/paper.tex", content: "draft" }],
    ["edit", { path: "new/paper.tex", oldText: "draft", newText: "edited" }],
    ["read", { path: `${source}/source.tex` }],
    ["bash", { command: "cat new/paper.tex && printf shell > shell.txt" }],
  ];
  pi.registerProvider("catalex-native-fixture", {
    api: "catalex-fixture",
    baseUrl: "http://unused.invalid",
    apiKey: "fixture",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 1000,
      },
    ],
    streamSimple(_model, context) {
      if (step === 0) {
        const prompt = JSON.stringify(context);
        assert.match(prompt, /DRAFT_INSTRUCTIONS/);
        assert.match(prompt, /USER_INSTRUCTIONS/);
        assert.doesNotMatch(prompt, /SOURCE_ONLY_INSTRUCTIONS/);
      }
      const stream = createAssistantMessageEventStream();
      const call = calls[step++];
      const message = {
        role: "assistant",
        api: "catalex-fixture",
        provider: "catalex-native-fixture",
        model: "fixture",
        content: call
          ? [
              {
                type: "toolCall",
                id: `call-${step}`,
                name: call[0],
                arguments: call[1],
              },
            ]
          : [{ type: "text", text: "Native tool checks complete." }],
        stopReason: call ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
