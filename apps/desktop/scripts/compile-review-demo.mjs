// Local-only bridge for the browser demo. Runs the actual Catalex compiler
// against a temporary main.tex, never against the user's source workspace.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "catalex-compile-demo-"));
await Promise.all(
  ["project", "data", "cache", "resources"].map((name) =>
    mkdir(path.join(root, name)),
  ),
);
const service = spawn(
  process.env.CATALEX_SERVICE_PATH ??
    path.join(desktop, "backend/target/debug/catalex-desktop"),
  [],
  {
    env: {
      ...process.env,
      CATALEX_DATA_DIR: path.join(root, "data"),
      CATALEX_CACHE_DIR: path.join(root, "cache"),
      CATALEX_RESOURCE_DIR: path.join(root, "resources"),
    },
    stdio: ["pipe", "pipe", "inherit"],
  },
);
let id = 0;
const pending = new Map();
createInterface({ input: service.stdout }).on("line", (line) => {
  let result;
  try {
    result = JSON.parse(line);
  } catch {
    return;
  }
  if (pending.has(result.id)) {
    pending.get(result.id)(result);
    pending.delete(result.id);
  }
});
let busy = false;
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (
    origin &&
    origin !== "http://127.0.0.1:4173" &&
    origin !== "http://localhost:4173"
  ) {
    res.writeHead(403);
    res.end();
    return;
  }
  res.setHeader(
    "Access-Control-Allow-Origin",
    origin ?? "http://127.0.0.1:4173",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "POST" || req.url !== "/compile") {
    res.writeHead(404);
    res.end();
    return;
  }
  if (busy) {
    res.writeHead(409);
    res.end(JSON.stringify({ error: "Compiler busy; try again." }));
    return;
  }
  busy = true;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 100000) throw new Error("Demo file too large");
      chunks.push(chunk);
    }
    const { content } = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof content !== "string") throw new Error("Expected main.tex text");
    await writeFile(path.join(root, "project/main.tex"), content);
    const requestId = ++id;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Compiler timed out"));
      }, 60000);
      pending.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      service.stdin.write(
        JSON.stringify({
          id: requestId,
          windowId: "compile-demo",
          command: "compile_latex",
          args: {
            projectDir: path.join(root, "project"),
            mainFile: "main.tex",
            backend: "latexmk",
            engine: "pdflatex",
            installation: null,
            diagnostics: { __channel: requestId },
          },
        }) + "\n",
      );
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(error) }));
  } finally {
    busy = false;
  }
});
server.listen(4175, "127.0.0.1", () =>
  console.log(`Real compiler demo bridge: http://127.0.0.1:4175 (${root})`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close();
    service.kill();
    process.exit();
  });
