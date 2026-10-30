"""Compare warm latexmk runs with/without -g; projects live only in OS temp."""

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / "output/playwright/long-paper/recompile"
EDITS = {
    "higher-topos": ("classical category theory is the main prerequisite", 735),
    "string-theory": ("beginning graduate students", 217),
}


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    # macOS GUI shells may not include the installed TeX distribution.
    env["PATH"] += os.pathsep + "/Library/TeX/texbin"
    for tool in ("latexmk", "pdfinfo", "pdftotext"):
        if not shutil.which(tool, path=env["PATH"]):
            raise SystemExit(f"Missing required tool: {tool}")
    report = {
        "platform": platform.platform(),
        "latexmk": subprocess.check_output(["latexmk", "-v"], env=env, text=True),
        "repetitions": 3,
        "runs": [],
    }
    hashes = {}

    def save():
        (OUTPUT / "results.json").write_text(json.dumps(report, indent=2) + "\n")

    def compile_one(case, directory, force, delete_outputs, stage, marker):
        stem = Path(case["main"]).stem
        if delete_outputs:
            for extension in ("pdf", "log"):
                (directory / f"{stem}.{extension}").unlink(missing_ok=True)
        command = ["latexmk", "-pdf" if case["engine"] == "pdflatex" else "-pdfxe"]
        if force:
            command.append("-g")
        command += ["-f", "-file-line-error", "-interaction=nonstopmode",
                    "-synctex=1", "-outdir=.", case["main"]]
        label = f"{case['name']}-{directory.name}-{stage}"
        start = time.perf_counter()
        result = subprocess.run(command, cwd=directory, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=180, text=True,
                                errors="replace")
        seconds = time.perf_counter() - start
        (OUTPUT / f"{label}.log").write_text(result.stdout)
        if result.returncode:
            raise RuntimeError(f"{label}: latexmk exited {result.returncode}; see saved log")
        pdf = directory / f"{stem}.pdf"
        info = subprocess.check_output(["pdfinfo", str(pdf)], env=env, text=True)
        pages = int(re.search(r"^Pages:\s+(\d+)", info, re.M)[1])
        content = subprocess.check_output(["pdftotext", str(pdf), "-"], env=env)
        assert marker.encode() in content, f"Missing current edit in {label}"
        assert pages == EDITS[case["name"]][1], f"Page count changed in {label}"
        digest = hashlib.sha256(content).hexdigest()
        key = (case["name"], marker)
        assert digest == hashes.setdefault(key, digest), f"PDF text differs in {label}"
        row = {
            "project": case["name"], "force": force, "deletePdfLog": delete_outputs,
            "stage": stage, "seconds": seconds, "pages": pages,
            "rules": re.findall(r"Run number \d+ of rule '([^']+)'", result.stdout),
            "pdfTextSha256": digest, "command": command, "log": f"{label}.log",
        }
        report["runs"].append(row)
        save()
        print(f"{label}: {seconds:.3f}s {row['rules']}", flush=True)

    with tempfile.TemporaryDirectory(prefix="catalex-recompile-") as temporary:
        temp = Path(temporary)
        report["temporaryDirectory"] = str(temp)
        subprocess.run([sys.executable, str(Path(__file__).with_name("long-paper-fixture.py")),
                        temporary], check=True)
        for fixture in sorted((temp / "fixtures").iterdir()):
            case = json.loads((fixture / "fixture.json").read_text())
            # Old arXiv source has Mac-style punctuation and one stray byte.
            # Fix only temporary copies so failed builds do not contaminate timings.
            if case["name"] == "higher-topos":
                fixes = {
                    "highertopoi.tex": {b"\xd0": b"--", b"\xd2": b"``", b"\xd3": b"''"},
                    "chap2sec1-leftfib.tex": {b"needed\x8c": b"needed"},
                }
                for filename, replacements in fixes.items():
                    path = fixture / filename
                    data = path.read_bytes()
                    for before, after in replacements.items():
                        assert before in data
                        data = data.replace(before, after)
                    path.write_bytes(data)
                report["temporarySourceFixes"] = {
                    "higher-topos": "Replace legacy D0/D2/D3 punctuation with TeX ASCII; "
                                    "remove stray 8C after 'needed' in chap2sec1-leftfib.tex."
                }
            original = (fixture / case["edit"]).read_text()
            needle = EDITS[case["name"]][0]
            assert original.count(needle) == 1
            conditions = []
            for delete_outputs in (False, True):
                for force in (False, True):
                    name = f"{'delete' if delete_outputs else 'retain'}-{'g' if force else 'no-g'}"
                    directory = temp / case["name"] / name
                    shutil.copytree(fixture, directory)
                    conditions.append((directory, force, delete_outputs))
                    (directory / case["edit"]).write_text(
                        original.replace(needle, "benchmark0000 " + needle))
                    # Warm each directory in place: moving a warmed latexmk DB can invalidate it.
                    compile_one(case, directory, False, False, "warmup", "benchmark0000")
            for repetition in range(1, 4):
                marker = f"benchmark{repetition:04d}"
                # Reverse order on alternating repetitions to reduce order bias.
                order = conditions if repetition % 2 else list(reversed(conditions))
                for directory, force, delete_outputs in order:
                    (directory / case["edit"]).write_text(
                        original.replace(needle, marker + " " + needle))
                    compile_one(case, directory, force, delete_outputs,
                                f"edit-{repetition}", marker)
                    compile_one(case, directory, force, delete_outputs,
                                f"unchanged-{repetition}", marker)
    report["temporaryDirectoryRemoved"] = not temp.exists()
    report["medians"] = []
    for project in EDITS:
        for delete_outputs in (False, True):
            for force in (False, True):
                for kind in ("edit", "unchanged"):
                    values = [r["seconds"] for r in report["runs"]
                              if r["project"] == project and r["force"] == force
                              and r["deletePdfLog"] == delete_outputs
                              and r["stage"].startswith(kind + "-")]
                    report["medians"].append({
                        "project": project, "deletePdfLog": delete_outputs,
                        "force": force, "kind": kind,
                        "seconds": statistics.median(values),
                        "min": min(values), "max": max(values),
                    })
    save()
    print(json.dumps(report["medians"], indent=2), flush=True)
    print(f"Results: {OUTPUT / 'results.json'}", flush=True)


if __name__ == "__main__":
    main()
