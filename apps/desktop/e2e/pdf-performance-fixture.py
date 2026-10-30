"""Generate opt-in PDF stress fixtures; requires Pillow and numpy.

Each page embeds four unique JPEG figures. Stream PDF objects to disk so fixture
generation does not need to retain every decoded image in memory.
"""

import argparse
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

CASES = [("100p-2k", 100, 2048), ("300p-2k", 300, 2048), ("100p-4k", 100, 4096)]


def figure(size, seed):
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:256, 0:256]
    field = np.sin(x / 17 + seed) * np.cos(y / 23 - seed / 3)
    base = np.stack([128 + 90 * field, 120 + 85 * np.sin(field * 3), 140 - 90 * field], axis=2)
    image = Image.fromarray(base.astype(np.uint8)).resize((size, size), Image.Resampling.BICUBIC)
    # Fine grain prevents these from compressing like flat-color placeholder images.
    pixels = np.asarray(image).astype(np.int16)
    pixels += rng.integers(-12, 13, pixels.shape, dtype=np.int16)
    image = Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(image)
    margin = size // 12
    draw.rectangle((margin, margin, size - margin, size - margin), outline="white", width=max(2, size // 512))
    for curve in range(5):
        points = [(int(t), int(size / 2 + size / 3 * np.sin(t / size * 15 + seed + curve / 3)))
                  for t in np.linspace(margin, size - margin, 500)]
        draw.line(points, fill=(255, 255 - curve * 30, 20 + curve * 40), width=max(2, size // 800))
    draw.text((margin + 15, margin + 15), f"Figure {seed}: {size} x {size}", fill="white", font_size=size // 48)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=85, subsampling=2)
    return buffer.getvalue()


def create(directory, name, pages, size):
    project = directory / name
    project.mkdir(parents=True, exist_ok=True)
    target = project / "figures.pdf"
    if target.exists() and (project / "fixture.json").exists():
        return json.loads((project / "fixture.json").read_text())
    offsets = [0]
    with target.open("wb") as out:
        out.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")

        def obj(number, content):
            while len(offsets) <= number:
                offsets.append(0)
            offsets[number] = out.tell()
            out.write(f"{number} 0 obj\n".encode() + content + b"\nendobj\n")

        def stream(number, header, content):
            obj(number, f"<< {header} /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")

        obj(1, b"<< /Type /Catalog /Pages 2 0 R >>")
        obj(2, f"<< /Type /Pages /Count {pages} /Kids [{' '.join(f'{4 + p * 6} 0 R' for p in range(pages))}] >>".encode())
        obj(3, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        for p in range(pages):
            page_id = 4 + p * 6
            resources = " ".join(f"/Im{i} {page_id + 2 + i} 0 R" for i in range(4))
            obj(page_id, f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << {resources} >> >> /Contents {page_id + 1} 0 R >>".encode())
            content = f"BT /F1 18 Tf 36 755 Td (Stress document: page {p + 1} of {pages}) Tj /F1 10 Tf 0 -18 Td (Four unique {size} x {size} JPEG figures per page) Tj ET\n"
            for i, (x, y) in enumerate([(36, 440), (312, 440), (36, 130), (312, 130)]):
                content += f"q 264 0 0 264 {x} {y} cm /Im{i} Do Q\nBT /F1 9 Tf {x} {y - 16} Td (Figure {p * 4 + i + 1}: synthetic high-resolution data) Tj ET\n"
                stream(page_id + 2 + i, f"/Type /XObject /Subtype /Image /Width {size} /Height {size} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", figure(size, p * 4 + i))
            stream(page_id + 1, "", content.encode())
            if (p + 1) % 25 == 0:
                print(f"{name}: {p + 1}/{pages} pages", flush=True)
        xref = out.tell()
        out.write(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
        for offset in offsets[1:]:
            out.write(f"{offset:010d} 00000 n \n".encode())
        out.write(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    (project / "main.tex").write_text("\\documentclass{article}\n\\begin{document}\nPDF stress fixture.\\end{document}\n")
    metadata = dict(name=name, pages=pages, figures=pages * 4, figureSide=size, bytes=target.stat().st_size)
    (project / "fixture.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata), flush=True)
    return metadata


def create_latex(project):
    project.mkdir(parents=True, exist_ok=True)
    lines = [r"\documentclass{article}", r"\usepackage[margin=1in]{geometry}",
             r"\usepackage{graphicx}", r"\begin{document}"]
    for page in range(16):
        image = project / f"figure-{page}.jpg"
        if not image.exists():
            image.write_bytes(figure(4096, page))
        lines.extend([r"\section{Experiment " + str(page + 1) + "}",
                      "A representative LaTeX preview with a large figure. " * 12,
                      r"\includegraphics[width=\linewidth,height=0.5\textheight,keepaspectratio]{" + image.name + "}",
                      r"\clearpage"])
    lines.append(r"\end{document}")
    (project / "main.tex").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--case", choices=[case[0] for case in CASES])
    parser.add_argument("--latex", action="store_true", help="Generate a 16-page compiled-preview project in output")
    args = parser.parse_args()
    if args.latex:
        create_latex(args.output)
        raise SystemExit(0)
    for case in CASES:
        if args.case is None or args.case == case[0]:
            create(args.output, *case)
