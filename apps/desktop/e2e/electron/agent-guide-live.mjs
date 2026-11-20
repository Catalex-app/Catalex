import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

// Manual check, not part of any suite: it sends one short question to each
// installed provider through your own signed-in account, so it uses real
// inference. It reports whether the agent read the built-in app guide on its
// own and whether its answer names the right control.
//   node e2e/electron/agent-guide-live.mjs [claude] [codex] [pi]
// LIVE_CLAUDE_MODEL, LIVE_CODEX_MODEL and LIVE_PI_MODEL choose a model your
// account can use; Codex and Pi otherwise use their own default.
const root = fileURLToPath(new URL("../..", import.meta.url));
const providers = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["claude", "codex", "pi"];
const prompt =
  "The preview compiles the wrong document in this project. Where in this app do I change which file is compiled? Answer in two sentences and do not edit anything.";
const compileContext = {
  rootId: "main.tex",
  targetPath: "main.tex",
  rootFolder: "",
  mainFileChosen: false,
  backend: "tectonic",
  engine: "xelatex",
  autoEngine: true,
};
const results = [];
for (const provider of providers) {
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), `catalex-guide-live-${provider}-`),
  );
  const project = path.join(profile, "project");
  await fs.mkdir(path.join(project, "chapters"), { recursive: true });
  for (const file of ["main.tex", "chapters/second.tex"])
    await fs.writeFile(
      path.join(project, file),
      "\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}\n",
    );
  const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
  for (const key of ["ELECTRON_RUN_AS_NODE", "CATALEX_DEV_URL"])
    delete env[key];
  const app = await electron.launch({ args: [root], env, timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.catalex);
    const invoke = (command, args) =>
      page.evaluate(
        async ({ command, args }) => {
          const reply = await window.catalex.invoke(command, args);
          if ("error" in reply) throw new Error(JSON.stringify(reply.error));
          return reply.result;
        },
        { command, args },
      );
    await invoke("get_system_info");
    const tabId = `live-${provider}`;
    await page.evaluate(
      ({ provider, tabId }) => {
        window.live = { output: "", done: false, error: "" };
        // Other chats and model discovery share these channels.
        const mine = (event) => (event.tab_id ?? event.tabId) === tabId;
        // Providers report text and tool activity on different channels.
        for (const channel of ["output", "activity", "text", "final"])
          window.catalex.listen(`${provider}-${channel}`, (event) => {
            if (mine(event)) window.live.output += `${JSON.stringify(event)}\n`;
          });
        window.catalex.listen(`${provider}-error`, (event) => {
          if (mine(event)) window.live.error += `${JSON.stringify(event)}\n`;
        });
        window.catalex.listen(`${provider}-complete`, (event) => {
          if (!mine(event)) return;
          window.live.done = true;
          window.live.output += `${JSON.stringify(event)}\n`;
        });
      },
      { provider, tabId },
    );
    const workspace = await invoke("prepare_agent_workspace", {
      projectRoot: project,
      tabId,
      sharedSessionId: null,
      mode: "ask",
      dirtyBuffers: [],
    });
    const turn = {
      projectPath: workspace.candidateRoot,
      sourceProjectPath: project,
      runtimeSessionKey: tabId,
      prompt,
      tabId,
      compileContext,
    };
    await invoke(
      `execute_${provider}_code`,
      provider === "claude"
        ? {
            ...turn,
            model: process.env.LIVE_CLAUDE_MODEL ?? "sonnet",
            effortLevel: null,
          }
        : provider === "codex"
          ? {
              ...turn,
              model: process.env.LIVE_CODEX_MODEL ?? null,
              reasoningEffort: null,
              fastMode: null,
            }
          : {
              ...turn,
              model: process.env.LIVE_PI_MODEL ?? null,
              reasoningEffort: null,
            },
    );
    await page
      .waitForFunction(() => window.live.done, undefined, {
        timeout: 240_000,
      })
      .catch(() => {});
    const live = await page.evaluate(() => window.live);
    await fs.writeFile(
      path.join(os.tmpdir(), `catalex-guide-live-${provider}.log`),
      live.output,
    );
    results.push({
      provider,
      finished: live.done,
      // The skill's own files, not its name in a skill listing.
      readGuide: /catalex-guide[\\/]+(SKILL|limits|docs)/.test(live.output),
      readLimits: /catalex-guide[\\/]+limits\.md/.test(live.output),
      namesControl: /Compilation options|Main file/i.test(live.output),
      error: live.error.slice(-300),
    });
  } catch (error) {
    results.push({ provider, error: String(error).slice(0, 300) });
  } finally {
    await app.close().catch(() => {});
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
console.table(results);
