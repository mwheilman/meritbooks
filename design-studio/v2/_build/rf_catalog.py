"""Reads the report catalog out of docs/FPB-reports-fpna.md §1 so R1's shelf counts can't drift from the brief."""
import os, re

DOC = os.path.join(os.path.dirname(__file__), "..", "..", "..", "docs", "FPB-reports-fpna.md")
SHELF_RE = re.compile(r"^### 1\.(\d+) (.+?) — (.+?) \((\d+)\)\s*$")
ROW_RE = re.compile(r"^\| ([A-Z]{2}-\d{2}) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|\s*$")


def load():
    shelves, cur = [], None
    for line in open(DOC):
        m = SHELF_RE.match(line)
        if m:
            cur = dict(q=m.group(2), fam=m.group(3), n=int(m.group(4)), rows=[])
            shelves.append(cur)
            continue
        m = ROW_RE.match(line)
        if m and cur is not None:
            st = m.group(6)
            k = "Live" if st.startswith("Live") else "Partial" if st.startswith("Partial") else "New"
            cur["rows"].append(dict(id=m.group(1), name=re.sub(r"\s*\(flagship, R2\)", "", m.group(2).replace("**", "")), purpose=m.group(3), aud=m.group(4), src=m.group(5), st=k))
        if line.startswith("### 1.15"):
            break
    for s in shelves:
        assert len(s["rows"]) == s["n"], (s["q"], len(s["rows"]), s["n"])
        s["live"] = sum(r["st"] == "Live" for r in s["rows"])
        s["part"] = sum(r["st"] == "Partial" for r in s["rows"])
        s["new"] = sum(r["st"] == "New" for r in s["rows"])
    return shelves


SHELVES = load()
TOTAL = sum(s["n"] for s in SHELVES)
LIVE = sum(s["live"] for s in SHELVES)
PART = sum(s["part"] for s in SHELVES)
NEW = sum(s["new"] for s in SHELVES)

if __name__ == "__main__":
    for s in SHELVES:
        print(f'{s["q"]:40} {s["n"]:3} live {s["live"]:2} part {s["part"]:2} new {s["new"]:2}')
    print("TOTAL", TOTAL, "live", LIVE, "partial", PART, "new", NEW)
