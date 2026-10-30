"""Download pinned arXiv source fixtures; never vendor the papers into Git."""

import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile
import urllib.request


CASES = [
    {
        "name": "higher-topos",
        "title": "Higher Topos Theory",
        "author": "Jacob Lurie",
        "arxiv": "math/0608040v4",
        "sha256": "967e2c00fe624723dc7d572e286b47f5a05d58796c0a096d5e219bd4a13fab1a",
        "main": "highertopoi.tex",
        "edit": "chap0-appendix.tex",
        "engine": "pdflatex",
        "dependencies": [{
            "name": "multind.sty",
            "url": "https://ctan.math.illinois.edu/macros/latex209/contrib/misc/multind.sty",
            "sha256": "9d694fbc8778075b1ec640d2c7c45287f90c950ddd097b18d0fa79d8e68cbb2b",
        }],
    },
    {
        "name": "string-theory",
        "title": "Lectures on String Theory",
        "author": "David Tong",
        "arxiv": "0908.0333v3",
        "sha256": "8518d540a0f84e3efcce5329973c60de9de9201014aed489aacf52aad9faae96",
        "main": "arxiv.tex",
        "edit": "arxiv.tex",
        "engine": "xelatex",
        "dependencies": [],
    },
]


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: long-paper-fixture.py <temporary-directory>")
    root = Path(sys.argv[1])
    (root / "archives").mkdir(parents=True, exist_ok=True)
    for case in CASES:
        archive = root / "archives" / f"{case['name']}.tar.gz"
        url = f"https://arxiv.org/src/{case['arxiv']}"
        if not archive.exists():
            with urllib.request.urlopen(url, timeout=90) as response:
                data = response.read(32 * 1024 * 1024 + 1)
            if len(data) > 32 * 1024 * 1024:
                raise ValueError("Unexpectedly large source archive")
            if hashlib.sha256(data).hexdigest() != case["sha256"]:
                raise ValueError(f"Source checksum mismatch: {url}")
            archive.write_bytes(data)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != case["sha256"]:
            raise ValueError(f"Source checksum mismatch: {archive}")
        destination = root / "fixtures" / case["name"]
        destination.mkdir(parents=True)
        with tarfile.open(archive) as source:
            members = source.getmembers()
            if sum(m.size for m in members) > 64 * 1024 * 1024:
                raise ValueError("Unexpectedly large unpacked source")
            for member in members:
                name = PurePosixPath(member.name)
                if name.is_absolute() or ".." in name.parts or not (
                    member.isfile() or member.isdir()
                ):
                    raise ValueError(f"Unsupported archive entry: {member.name}")
            source.extractall(destination, filter="data")
        for dependency in case["dependencies"]:
            cached = root / "archives" / dependency["name"]
            if not cached.exists():
                with urllib.request.urlopen(dependency["url"], timeout=90) as response:
                    data = response.read(1024 * 1024 + 1)
                if hashlib.sha256(data).hexdigest() != dependency["sha256"]:
                    raise ValueError(f"Dependency checksum mismatch: {dependency['url']}")
                cached.write_bytes(data)
            data = cached.read_bytes()
            if hashlib.sha256(data).hexdigest() != dependency["sha256"]:
                raise ValueError(f"Dependency checksum mismatch: {cached}")
            (destination / dependency["name"]).write_bytes(data)
        files = sorted(p for p in destination.rglob("*") if p.is_file())
        manifest = {
            **case,
            "sourceUrl": url,
            "files": {
                str(p.relative_to(destination)): {
                    "bytes": p.stat().st_size,
                    "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
                }
                for p in files
            },
        }
        (destination / "fixture.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"Prepared {destination}: {len(files)} files")


if __name__ == "__main__":
    main()
