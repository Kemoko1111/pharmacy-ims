#!/usr/bin/env python3
"""Convert the pharmacy-ims markdown docs to Word (.docx).
Mermaid blocks -> PNG via mermaid-cli, then pandoc md -> docx.
"""
import re, struct, subprocess, sys
from pathlib import Path

ROOT = Path.home() / "development/pharmacy-ims"
BUILD = Path(__file__).parent / "docx-build"
DIAG = BUILD / "diagrams"
WORD = ROOT / "word"
for d in (BUILD, DIAG, WORD):
    d.mkdir(parents=True, exist_ok=True)

DOCS = [
    ("docs/week1/problem-discovery-note.md", "01 Problem Discovery Note"),
    ("docs/week1/team-charter.md",           "02 Team Charter"),
    ("docs/week2/requirements-document.md",  "03 Requirements Document (SRS)"),
    ("docs/week2/wireframes-ui-ux.md",       "04 Wireframes and UI-UX Specification"),
    ("docs/week2/class-pitch.md",            "05 Class Pitch"),
    ("docs/week3/adrs.md",                   "06 Architecture Decision Records"),
    ("docs/week3/database-design.md",        "07 Database Design (ERD)"),
    ("SCHEMA_SQL",                            "08 Database Schema (SQL DDL)"),
    ("docs/week3/api-schema.md",             "09 API Schema"),
    ("docs/analysis-models.md",              "10 Analysis and Design Models"),
    ("docs/project-plan.md",                 "11 Project Plan"),
]

MERMAID_RE = re.compile(r"```mermaid\n(.*?)```\n?", re.S)
MAX_W_IN = 6.3          # usable width on A4 with default margins
DPI = 192               # we render mermaid at scale 2 => 192 dpi logical


def png_size(path: Path):
    head = path.read_bytes()[:26]
    return struct.unpack(">II", head[16:24])


def render_mermaid(code: str, out_png: Path):
    mmd = out_png.with_suffix(".mmd")
    mmd.write_text(code)
    subprocess.run(
        ["npx", "-y", "@mermaid-js/mermaid-cli", "-i", str(mmd), "-o", str(out_png),
         "-b", "white", "-s", "2", "-w", "1600"],
        check=True, capture_output=True, text=True,
    )


def process_doc(src: str, name: str) -> Path:
    if src == "SCHEMA_SQL":
        sql = (ROOT / "docs/week3/schema.sql").read_text()
        text = ("# PharmaTrack — Database Schema (PostgreSQL DDL)\n\n"
                "**COE 454 — Week 3 supplement to the Database Design document.** "
                "Authoritative DDL; production migrations are generated via Prisma.\n\n"
                "```sql\n" + sql + "\n```\n")
    else:
        text = (ROOT / src).read_text()

    stem = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower()
    counter = 0

    def repl(m):
        nonlocal counter
        counter += 1
        png = DIAG / f"{stem}-{counter:02d}.png"
        render_mermaid(m.group(1), png)
        w, h = png_size(png)
        w_in, h_in = w / DPI, h / DPI
        scale = min(MAX_W_IN / w_in, 8.8 / h_in, 1.0)   # fit within one page
        attr = f"{{width={w_in*scale:.2f}in}}"
        print(f"    rendered {png.name} ({w}x{h} -> {w_in*scale:.1f}in wide)")
        return f"![Figure {counter}](diagrams/{png.name}){attr}\n\n"

    text = MERMAID_RE.sub(repl, text)
    out_md = BUILD / f"{stem}.md"
    out_md.write_text(text)
    return out_md


def pandoc(md: Path, docx: Path, toc: bool = False):
    cmd = ["pandoc", str(md), "-f", "markdown", "-t", "docx",
           "-o", str(docx), "--resource-path", str(BUILD)]
    if toc:
        cmd += ["--toc", "--toc-depth=2", "-s", "--metadata",
                "title=PharmaTrack — Pharmacy Inventory & POS System",
                "--metadata", "subtitle=COE 454 Client Project — Weeks 1–3 Documentation Package"]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


PAGE_BREAK = '\n\n```{=openxml}\n<w:p><w:r><w:br w:type="page"/></w:r></w:p>\n```\n\n'


def main(diagrams_only: bool = False):
    processed = []
    for src, name in DOCS:
        print(f"[{name}]")
        md = process_doc(src, name)
        processed.append((md, name))
        if not diagrams_only:
            pandoc(md, WORD / f"{name}.docx")
            print(f"    -> word/{name}.docx")

    if diagrams_only:
        print("diagrams + processed md ready")
        return

    combined = PAGE_BREAK.join(p.read_text() for p, _ in processed)
    combined_md = BUILD / "combined.md"
    combined_md.write_text(combined)
    pandoc(combined_md, WORD / "00 COMBINED — PharmaTrack Weeks 1-3.docx", toc=True)
    print("-> word/00 COMBINED — PharmaTrack Weeks 1-3.docx")
    print("DONE")


if __name__ == "__main__":
    main(diagrams_only="--diagrams-only" in sys.argv)
