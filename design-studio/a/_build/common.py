"""Shared tokens, CSS, shell and formatters for Concept A — "The Annual Report"."""

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">'
         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
         '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700'
         '&family=Syne:wght@700&display=swap" rel="stylesheet">')

CSS = r"""
:root{
  /* Brand — exact hex from Merit Brand Guidelines 2026 */
  --blue:#2563EB; --signal:#3B82F6; --midnight:#0A1628; --steel:#3D4F65; --slate:#8494A7;
  --warm:#FDFCFA; --canvas:#F5F3EF; --sky:#EBF2FE; --white:#FFFFFF;
  /* Ramps derived from the guide's Usage page (blue / grey / midnight tints) */
  --blue-700:#1E4FC2; --blue-200:#A6CAFF; --blue-100:#DCE9FF;
  --grey-100:#F2F3F5; --grey-200:#E1E4E8; --grey-300:#CDD2D9; --grey-400:#B8BFC9;
  --mid-800:#1B2940; --mid-700:#2C3D56;
  /* Functional — dark, low-chroma so they sit inside the palette */
  --neg:#B42318; --pos:#17694A; --warn:#8A5300;
  /* 8-pt spacing */
  --s1:8px; --s2:16px; --s3:24px; --s4:32px; --s5:40px; --s6:48px; --s8:64px;
  /* Type scale — five sizes, used across all screens */
  --t-xs:12px; --t-sm:13px; --t-md:15px; --t-lg:28px; --t-xl:64px;
  --ease:cubic-bezier(.2,.7,.2,1);
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{font-family:'DM Sans',system-ui,sans-serif;font-size:var(--t-md);line-height:24px;color:var(--midnight);
  background:var(--warm);min-width:1512px;font-optical-sizing:auto}
a{color:inherit;text-decoration:none}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.tnum,td.n,th.n{font-variant-numeric:tabular-nums lining-nums}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.shell :focus-visible,.band :focus-visible{outline-color:var(--signal)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* ---------- Shell: Midnight rail, real logo ---------- */
.app{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
.shell{background:var(--midnight);position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:32px 0 24px}
.shell .logo{display:block;padding:0 24px}
.shell .logo img{height:32px;width:auto;display:block}
.shell .product{margin:24px 24px 0;padding-top:16px;border-top:1px solid var(--mid-700);font-size:var(--t-xs);line-height:16px;
  letter-spacing:.14em;text-transform:uppercase;color:var(--slate)}
.shell .product b{display:block;color:var(--white);font-weight:500;letter-spacing:0;text-transform:none;font-size:var(--t-sm);line-height:20px;margin-top:4px}
.shell nav{margin-top:32px;display:flex;flex-direction:column}
.shell nav a{position:relative;display:grid;grid-template-columns:32px 1fr auto;align-items:center;height:40px;padding:0 24px;
  font-size:var(--t-sm);color:var(--grey-300);transition:background .15s var(--ease),color .15s var(--ease)}
.shell nav a .k{font-size:var(--t-xs);color:var(--slate);font-variant-numeric:tabular-nums}
.shell nav a .c{font-size:var(--t-xs);color:var(--slate);font-variant-numeric:tabular-nums}
.shell nav a:hover{background:var(--mid-800);color:var(--white)}
.shell nav a[aria-current=page]{background:var(--mid-800);color:var(--white);font-weight:500}
.shell nav a[aria-current=page]::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--signal)}
.shell nav a[aria-current=page] .k{color:var(--white)}
.shell .navhint{margin:16px 24px 0;font-size:var(--t-xs);line-height:16px;color:var(--slate)}
.shell .period{margin:auto 24px 0;padding-top:16px;border-top:1px solid var(--mid-700)}
.shell .period .lbl{font-size:var(--t-xs);line-height:16px;letter-spacing:.14em;text-transform:uppercase;color:var(--slate)}
.shell .period .v{font-size:var(--t-sm);line-height:20px;color:var(--white);margin-top:4px}
.shell .period .bar{display:grid;grid-template-columns:repeat(15,1fr);gap:2px;margin-top:8px}
.shell .period .bar i{height:4px;background:var(--mid-700)}
.shell .period .bar i.on{background:var(--signal)}
.shell .who{margin:16px 24px 0;display:flex;justify-content:space-between;font-size:var(--t-xs);line-height:16px;color:var(--slate)}
.shell .who b{color:var(--grey-300);font-weight:500}
.app.mini{grid-template-columns:64px 1fr}
.shell.mini{padding:24px 0 16px;align-items:center}
.shell.mini .logo{padding:0}
.shell.mini .logo img{height:24px}
.shell.mini nav{margin-top:40px;width:100%}
.shell.mini nav a{grid-template-columns:1fr;justify-items:center;padding:0;height:40px}
.shell.mini nav a .k{font-size:var(--t-xs);color:var(--grey-300)}
.shell.mini nav a[aria-current=page] .k{color:var(--white);font-weight:600}
.shell.mini .period{margin:auto 8px 0;width:48px;text-align:center}
.shell.mini .period .v{font-size:var(--t-xs);color:var(--grey-300);margin:0}
.shell.mini .who{margin:16px 0 0;justify-content:center;width:32px;height:32px;align-items:center;border:1px solid var(--mid-700)}

/* ---------- Page chrome ---------- */
.main{min-width:0}
.pagehead{display:flex;align-items:flex-start;justify-content:space-between;padding:32px 40px 0}
.eyebrow{font-size:var(--t-xs);line-height:16px;letter-spacing:.14em;text-transform:uppercase;font-weight:500;color:var(--steel)}
.eyebrow .sl{color:var(--blue);margin:0 4px}
.band .eyebrow{color:var(--slate)} .band .eyebrow .sl{color:var(--signal)}
.pageno{font-size:var(--t-md);line-height:24px;color:var(--midnight);font-variant-numeric:tabular-nums}
.title{font-family:'Syne',sans-serif;font-weight:700;font-size:var(--t-lg);line-height:32px;letter-spacing:-.01em;color:var(--blue)}
.sub{font-size:var(--t-sm);line-height:20px;color:var(--steel)}
.rule{height:1px;background:var(--blue);border:0}

/* ---------- Controls ---------- */
.btn{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 12px;font-size:var(--t-sm);font-weight:600;
  border:1px solid var(--grey-300);background:var(--white);color:var(--midnight);transition:background .15s var(--ease),border-color .15s var(--ease)}
.btn:hover{border-color:var(--blue);color:var(--blue)}
.btn.primary{background:var(--blue);border-color:var(--blue);color:var(--white)}
.btn.primary:hover{background:var(--blue-700);border-color:var(--blue-700);color:var(--white)}
.btn.ghost{border-color:transparent;background:transparent;color:var(--blue);padding:0 8px}
.btn.ghost:hover{background:var(--sky)}
kbd{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 4px;
  font:500 var(--t-xs)/1 'DM Sans',sans-serif;color:var(--steel);background:var(--white);border:1px solid var(--grey-300);border-bottom-width:2px}
.btn.primary kbd{background:transparent;color:var(--white);border-color:rgba(255,255,255,.55)}
.seg{display:inline-flex;border:1px solid var(--grey-300);background:var(--white)}
.seg button{height:32px;padding:0 12px;font-size:var(--t-sm);color:var(--steel);border-right:1px solid var(--grey-300)}
.seg button:last-child{border-right:0}
.seg button[aria-pressed=true]{background:var(--midnight);color:var(--white);font-weight:500}
.seg button:not([aria-pressed=true]):hover{background:var(--sky);color:var(--midnight)}

/* ---------- Ledger tables: rules only where they work ---------- */
table.ledger{width:100%;border-collapse:collapse}
table.ledger th{font-size:var(--t-xs);line-height:16px;letter-spacing:.08em;text-transform:uppercase;font-weight:500;color:var(--steel);
  text-align:left;padding:8px 12px;border-bottom:1px solid var(--blue);vertical-align:bottom;white-space:nowrap}
table.ledger th.n,table.ledger td.n{text-align:right}
table.ledger td{padding:8px 12px;font-size:var(--t-sm);line-height:24px;vertical-align:middle;white-space:nowrap}
table.ledger td.n{font-variant-numeric:tabular-nums lining-nums}
table.ledger tr>*:first-child{padding-left:0}
table.ledger tr>*:last-child{padding-right:0}
.hp{visibility:hidden}               /* hanging paren keeps positives aligned with (negatives) */
tr.sub td.n{border-top:1px solid var(--midnight);font-weight:600}
tr.sub td.l{font-weight:600}
tr.grand td.n{border-top:1px solid var(--midnight);border-bottom:3px double var(--blue);font-weight:700}
tr.grand td.l{font-weight:700}
tr.gap td{height:16px;padding:0}
tr.head td{padding-top:24px;font-size:var(--t-xs);letter-spacing:.14em;text-transform:uppercase;font-weight:500;color:var(--steel)}
.mut{color:var(--steel)}
.neg-t{color:var(--neg)} .pos-t{color:var(--pos)} .warn-t{color:var(--warn)}
.fu{display:inline-block;width:16px;text-align:center;font-size:var(--t-xs);font-weight:700}

/* ---------- SIGNATURE: Notes to the figures ---------- */
.nref{position:relative;display:inline-block;margin-left:2px;font-size:var(--t-xs);line-height:1;font-weight:700;color:var(--blue);
  vertical-align:top;top:-2px;font-variant-numeric:tabular-nums;transition:color .15s var(--ease)}
.nref::after{content:"";position:absolute;inset:-12px -12px}   /* 32px hit area */
.nref:hover,.nref.lit{color:var(--white);background:var(--blue)}
td.n .nref{position:absolute;margin-left:4px}               /* hangs outside the figure column, like a printed footnote */
td.n{position:relative}
.lit-fig{background:var(--sky)!important;box-shadow:inset 0 -1px 0 var(--blue)}
.notes{background:var(--canvas)}
.notes-h{display:flex;justify-content:space-between;align-items:baseline}
.note{position:relative;border-top:1px solid var(--blue);padding:16px 0 24px;transition:background .2s var(--ease),box-shadow .2s var(--ease)}
.note.lit{background:var(--white);box-shadow:-16px 0 0 var(--white),16px 0 0 var(--white),inset 2px 0 0 var(--blue)}
.note-top{display:grid;grid-template-columns:56px 1fr;column-gap:8px;align-items:start}
.note-no{font-family:'Syne',sans-serif;font-weight:700;font-size:var(--t-lg);line-height:32px;color:transparent;-webkit-text-stroke:1px var(--blue);
  font-variant-numeric:tabular-nums}
.note .kind{font-size:var(--t-xs);line-height:16px;letter-spacing:.14em;text-transform:uppercase;font-weight:500;color:var(--steel)}
.note h3{font-size:var(--t-md);line-height:24px;font-weight:600;color:var(--midnight);margin-top:4px}
.note p{font-size:var(--t-sm);line-height:20px;color:var(--steel);margin-top:8px}
.note p b{color:var(--midnight);font-weight:600}
.ev{margin-top:12px;list-style:none}
.ev li{display:flex;align-items:baseline;gap:8px;font-size:var(--t-sm);line-height:24px;color:var(--midnight)}
.ev li .dl{flex:1;border-bottom:1px dotted var(--grey-400);transform:translateY(-4px)}
.ev li .v{font-variant-numeric:tabular-nums;white-space:nowrap}
.basis{margin-top:12px;display:flex;gap:16px;font-size:var(--t-xs);line-height:16px;color:var(--steel)}
.basis b{font-weight:600;color:var(--midnight)}
.note .acts{margin-top:12px;display:flex;gap:8px;margin-left:-8px}
.conf{display:inline-grid;grid-template-columns:repeat(10,4px);gap:1px;vertical-align:middle;margin-right:8px}
.conf i{height:8px;background:var(--grey-300)} .conf i.on{background:var(--blue)}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
"""

NAV = [("01", "Portfolio", "portfolio.html", ""), ("02", "Bank feed", "bank-feed.html", "142"),
       ("03", "Statements", "statement.html", ""), ("04", "Close", "#", "4"), ("05", "Payables", "#", ""),
       ("06", "Receivables", "#", ""), ("07", "Journal", "#", ""), ("08", "Covenants", "#", "1")]


def shell(active, who="Mike Heilman", role="Owner", collapsed=False):
    if collapsed:
        its = []
        for k, label, href, count in NAV:
            cur = ' aria-current="page"' if label == active else ""
            its.append(f'<a href="{href}"{cur} aria-label="{label}" title="{label} (G {int(k)})"><span class="k">{k}</span></a>')
        ini = "".join(w[0] for w in who.split()[:2])
        return f"""<aside class="shell mini" aria-label="MeritBooks">
  <a class="logo" href="index.html"><img src="assets/merit-icon@2x.png" alt="Merit" width="27" height="24"></a>
  <nav aria-label="Primary">{''.join(its)}</nav>
  <div class="period" title="October close: 11 of 15 entities closed"><div class="v tnum">11/15</div></div>
  <div class="who" title="{who}, {role}"><b>{ini}</b></div>
</aside>"""
    items = []
    for k, label, href, count in NAV:
        cur = ' aria-current="page"' if label == active else ""
        c = f'<span class="c">{count}</span>' if count else '<span></span>'
        items.append(f'<a href="{href}"{cur}><span class="k">{k}</span><span>{label}</span>{c}</a>')
    bars = "".join('<i class="on"></i>' if i < 11 else "<i></i>" for i in range(15))
    return f"""<aside class="shell" aria-label="MeritBooks">
  <a class="logo" href="index.html"><img src="assets/merit-logo-on-dark@2x.png" alt="Merit" width="106" height="32"></a>
  <div class="product">MeritBooks<b>Merit Management Group</b></div>
  <nav aria-label="Primary">{''.join(items)}</nav>
  <p class="navhint">Press <span style="color:#CDD2D9">G</span> then a number to jump.</p>
  <div class="period"><div class="lbl">Closing</div><div class="v">October 2026 · 11 of 15 closed</div>
    <div class="bar" aria-hidden="true">{bars}</div></div>
  <div class="who"><b>{who}</b><span>{role}</span></div>
</aside>"""


def page(title, active, body, extra_css="", js="", who="Mike Heilman", role="Owner", collapsed=False):
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=1512">
<title>{title} — MeritBooks</title>
{FONTS}
<link rel="stylesheet" href="assets/annual-report.css">
<style>{extra_css}</style></head>
<body><div class="app{' mini' if collapsed else ''}">{shell(active, who, role, collapsed)}<main class="main" id="main">{body}</main></div>
<script>{NOTE_JS}{js}</script></body></html>"""


# Note linking: hovering/focusing a marker lights its note and figure, and vice-versa.
NOTE_JS = r"""
(function(){
  function lit(id,on){
    document.querySelectorAll('[data-note='+id+']').forEach(function(el){
      el.classList.toggle(el.classList.contains('nref')?'lit':(el.classList.contains('note')?'lit':'lit-fig'),on);
    });
  }
  document.querySelectorAll('.nref,.note').forEach(function(el){
    var id=el.getAttribute('data-note'); if(!id) return;
    ['mouseenter','focus'].forEach(function(e){el.addEventListener(e,function(){lit(id,true)})});
    ['mouseleave','blur'].forEach(function(e){el.addEventListener(e,function(){lit(id,false)})});
  });
})();
"""


def nref(n, label=None):
    lab = label or f"See note {n}"
    return f'<a class="nref" href="#note-{n}" data-note="{n}" aria-label="{lab}">{n}</a>'


def acct(v, dec=0, dollar=False):
    """Accounting format: (1,234) for negatives, hanging paren for positives."""
    if round(v, dec) == 0:
        return '—<span class="hp">)</span>'
    s = f"{abs(v):,.{dec}f}"
    if dollar:
        s = "$" + s
    if round(v, dec) < 0:
        return f"({s})"
    return f'{s}<span class="hp">)</span>'


def pct(v, dec=1):
    if round(v, dec) == 0:
        return '—<span class="hp">)</span>'
    s = f"{abs(v):.{dec}f}%"
    return f"({s})" if v < 0 else f'{s}<span class="hp">)</span>'


def conf_bar(c):
    on = round(c / 10)
    return '<span class="conf" aria-hidden="true">' + "".join(
        '<i class="on"></i>' if i < on else "<i></i>" for i in range(10)) + "</span>"


if __name__ == "__main__":
    import re
    css = re.sub(r"/\*[^*]*\*/", "", CSS)
    css = re.sub(r"\n[ \t]+", "\n", css)
    open("../assets/annual-report.css", "w").write(css.strip() + "\n")
