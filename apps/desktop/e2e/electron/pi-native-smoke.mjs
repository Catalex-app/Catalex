import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Uses the selected installed Pi with a scripted provider. No paid inference.
const temp = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "catalex-pi-native-")),
);
const source = path.join(temp, "source project");
const draft = path.join(temp, "draft");
const config = path.join(temp, "config");
let child;
let timer;
try {
  for (const dir of [
    source,
    draft,
    config,
    path.join(source, ".pi/extensions"),
    path.join(draft, ".pi/extensions"),
    path.join(draft, ".pi/skills/project-fixture"),
    path.join(draft, ".agents/skills/shared-project-fixture"),
    path.join(config, "extensions"),
    path.join(config, "skills/user-fixture"),
  ])
    await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(source, "source.tex"), "original source");
  await fs.copyFile(
    fileURLToPath(new URL("fixtures/pi-native-provider.mjs", import.meta.url)),
    path.join(config, "extensions/fixture.js"),
  );
  await fs.writeFile(
    path.join(config, "settings.json"),
    JSON.stringify({
      defaultProvider: "catalex-native-fixture",
      defaultModel: "fixture",
      enabledModels: ["catalex-native-fixture/fixture"],
    }),
  );
  for (const project of [source, draft]) {
    await fs.writeFile(
      path.join(project, ".pi/settings.json"),
      JSON.stringify({
        defaultProvider: "ignored",
        defaultModel: "ignored",
        enabledModels: ["ignored/ignored"],
      }),
    );
    await fs.writeFile(
      path.join(project, ".pi/extensions/ignored.js"),
      'throw new Error("Project extension must not load");',
    );
  }
  for (const [folder, marker] of [
    [source, "SOURCE_ONLY_INSTRUCTIONS"],
    [draft, "DRAFT_INSTRUCTIONS"],
    [config, "USER_INSTRUCTIONS"],
  ])
    await fs.writeFile(path.join(folder, "AGENTS.md"), marker);
  for (const folder of [
    path.join(config, "skills/user-fixture"),
    path.join(draft, ".pi/skills/project-fixture"),
    path.join(draft, ".agents/skills/shared-project-fixture"),
  ])
    await fs.writeFile(
      path.join(folder, "SKILL.md"),
      `---\nname: ${path.basename(folder)}\ndescription: Fixture skill\n---\nFixture instructions.`,
    );
  child = spawn(
    process.env.CATALEX_TEST_PI || "pi",
    ["--mode", "rpc", "--no-approve", "--offline", "--no-session", "--no-mcp"],
    {
      cwd: draft,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: config,
        CATALEX_PI_FIXTURE_SOURCE: source,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const records = [];
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Pi native smoke timed out: ${stderr}\n${JSON.stringify(records).slice(-4000)}`,
          ),
        ),
      45000,
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      reject(new Error(`Pi exited ${code}: ${stderr}`)),
    );
    createInterface({ input: child.stdout }).on("line", async (line) => {
      try {
        const record = JSON.parse(line);
        records.push(record);
        if (record.id === "state") {
          assert.equal(
            record.data.model.provider,
            "catalex-native-fixture",
            stderr,
          );
          child.stdin.write(
            `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
          );
        }
        if (record.id === "commands") {
          const skills = record.data.commands
            .filter((command) => command.source === "skill")
            .map((command) => command.name);
          assert.ok(skills.includes("skill:user-fixture"));
          assert.ok(!skills.includes("skill:project-fixture"));
          assert.ok(!skills.includes("skill:shared-project-fixture"));
          child.stdin.write(
            `${JSON.stringify({ id: "prompt", type: "prompt", message: "Run scripted tool checks." })}\n`,
          );
        }
        if (record.type === "agent_settled") resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
  await done;
  assert.ok(!stderr.includes("Project extension must not load"), stderr);
  const results = records.filter(
    (record) => record.type === "tool_execution_end",
  );
  assert.equal(results.length, 4, JSON.stringify(records).slice(-4000));
  assert.deepEqual(
    results.map((record) => record.isError),
    [false, false, false, false],
  );
  assert.equal(
    await fs.readFile(path.join(draft, "new/paper.tex"), "utf8"),
    "edited",
  );
  assert.equal(
    await fs.readFile(path.join(draft, "shell.txt"), "utf8"),
    "shell",
  );
  assert.equal(
    await fs.readFile(path.join(source, "source.tex"), "utf8"),
    "original source",
  );
  console.log(
    "Installed Pi native smoke passed: selected user config, ignored project resources, draft/user AGENTS.md, native draft tools, and source reads.",
  );
} finally {
  clearTimeout(timer);
  child?.kill("SIGTERM");
  if (child && child.exitCode === null)
    await new Promise((resolve) => child.once("exit", resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
