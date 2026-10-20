"""Drop system.css rules whose class selectors never appear in the given pages (deploy bundle only)."""
import re, sys
def purge(css, html):
    used = set(re.findall(r'class="([^"]*)"', html))
    cls = set()
    for u in used: cls.update(u.split())
    cls.update(re.findall(r"classList\.(?:add|toggle|remove)\('([\w-]+)'", html))
    out, i = [], 0
    while i < len(css):
        if css.startswith("@media", i) or css.startswith("@keyframes", i):
            j = css.index("{", i); depth = 1; k = j + 1
            while depth:
                if css[k] == "{": depth += 1
                elif css[k] == "}": depth -= 1
                k += 1
            out.append(css[i:k]); i = k; continue
        j = css.find("{", i)
        if j < 0: break
        k = css.index("}", j) + 1
        sel, body = css[i:j], css[j:k]
        keep = []
        for s in sel.split(","):
            names = re.findall(r"\.([a-zA-Z][\w-]*)", s)
            if all(n in cls for n in names):
                keep.append(s)
        if keep: out.append(",".join(keep) + body)
        i = k
    return "".join(out)
