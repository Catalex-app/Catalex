import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-latex-"));
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
const app = await electron.launch({ args: [process.cwd()], env });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.catalex));
  const response = await page.evaluate(() =>
    window.catalex.invoke("detect_texlive"),
  );
  const detected = response.result;
  expect(response.error).toBeUndefined();
  expect(detected.installations.length).toBeGreaterThan(0);
  const chosen = detected.installations.find((i) => i.available);
  expect(chosen).toBeTruthy();
  const project = path.join(profile, "paper");
  await fs.mkdir(project);
  await fs.writeFile(
    path.join(project, "main.tex"),
    "\\documentclass{article}\n\\begin{document}Installation check.\\end{document}",
  );
  const size = await page.evaluate(
    async ({ project, chosen }) => {
      const pdf = await window.catalex.invoke("compile_latex", {
        projectDir: project,
        mainFile: "main.tex",
        backend: "latexmk",
        engine: "pdflatex",
        installation: chosen.id,
        diagnostics: { __channel: 1001 },
      });
      if (pdf.error) throw new Error(JSON.stringify(pdf.error));
      return pdf.result.byteLength ?? pdf.result.length;
    },
    { project, chosen },
  );
  expect(size).toBeGreaterThan(100);
  console.log(
    JSON.stringify({
      installation: chosen.name,
      path: chosen.id,
      pdfBytes: size,
    }),
  );
} finally {
  await app.close();
}
