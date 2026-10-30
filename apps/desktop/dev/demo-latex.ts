import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Plugin } from "vite";

import { gunzipSync } from "node:zlib";
import { demoSourceMap } from "./demo-synctex";

const run = promisify(execFile);

/** Local browser demo only; not included in the packaged application. */
export function demoLatex(): Plugin {
  return {
    name: "demo-latex",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__demo/compile", async (req, res) => {
        const origin = req.headers.origin;
        if (
          req.method !== "POST" ||
          !origin ||
          origin !== `http://${req.headers.host}` ||
          !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin) ||
          !["comment-workspace", "onboarding-demo"].includes(
            String(req.headers["x-catalex-demo"] ?? ""),
          )
        ) {
          res.writeHead(403).end("Local demo requests only.");
          return;
        }
        let directory: string | undefined;
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 512 * 1024) throw new Error("Demo source is too large.");
            chunks.push(Buffer.from(chunk));
          }
          const { source, engine, file } = JSON.parse(
            Buffer.concat(chunks).toString(),
          );
          if (
            typeof source !== "string" ||
            typeof file !== "string" ||
            !["xelatex", "pdflatex", "lualatex"].includes(engine)
          ) {
            throw new Error("Invalid demo source or compiler.");
          }
          directory = await mkdtemp(path.join(tmpdir(), "catalex-demo-"));
          await writeFile(path.join(directory, "main.tex"), source);
          // Two passes update references; disable shell execution and unrestricted file access.
          for (let pass = 0; pass < 2; pass++) {
            await run(
              engine,
              [
                "-no-shell-escape",
                "-synctex=1",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "main.tex",
              ],
              {
                cwd: directory,
                timeout: 30_000,
                maxBuffer: 2 * 1024 * 1024,
                env: { ...process.env, openin_any: "p", openout_any: "p" },
              },
            );
          }
          const pdf = await readFile(path.join(directory, "main.pdf"));
          res
            .writeHead(200, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            })
            .end(
              JSON.stringify({
                pdf: pdf.toString("base64"),
                sourceMap: demoSourceMap(
                  gunzipSync(
                    await readFile(path.join(directory, "main.synctex.gz")),
                  ).toString(),
                  file,
                ),
              }),
            );
        } catch (error) {
          const failure = error as Error & { stdout?: string };
          res
            .writeHead(400, { "Content-Type": "text/plain" })
            .end(failure.stdout?.slice(-6000) || failure.message);
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      });
    },
  };
}
