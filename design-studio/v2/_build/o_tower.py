"""O10 — Migration Control Tower (/clients/onboarding). Jordan Smith, accounting manager, workspace context."""
from onb import *
from onb_data import *

CSS = """
.page{padding-top:24px}
.tw-tabs{grid-template-columns:repeat(9,minmax(0,1fr))}
.tw-tabs .band-tab{padding:10px 12px}
.tw-tabs .band-tab .v{font-size:20px}
.tw-tabs .band-tab .t-cap{white-space:nowrap}
.tw-filters{display:flex;align-items:center;gap:8px;margin:16px 0 0}
.tw-filters .select{width:auto}
.tw-filters .search{width:240px;margin-left:auto}
.tw{margin-top:12px;border:1px solid var(--line);background:var(--white)}
.tw .bulk{border-bottom:1px solid var(--blue-100)}
.tw table th{background:var(--white)}
.tw td{height:64px}
.tw .srcs{flex-wrap:wrap;gap:4px}
.tw .th-sort{min-height:32px}
.tw thead th{height:48px;vertical-align:middle}
.tw tr>*:first-child{padding-left:16px}
.tw tr>*:last-child{padding-right:16px}
.tw tr.q-group td{height:36px}
.tw tr.q-row{cursor:pointer}
.tw .ck{padding-right:0}
.tw .ck .check{min-height:32px}
.tw td .btn{height:32px}
.tw .l2 .warn,.tw .l2 .neg{font-weight:500}
.tw .blk-v{font-weight:600;font-variant-numeric:tabular-nums}
.tw tr.is-hidden{display:none}
.tw-foot{display:flex;align-items:center;gap:16px;height:48px;padding:0 16px 0 24px;border-top:1px solid var(--line-2);color:var(--ink-2)}
.tw-foot b{color:var(--ink);font-variant-numeric:tabular-nums}
.tw-foot .sp{flex:1}
.lower{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:24px;margin-top:24px;align-items:start}
.burn svg{display:block;width:100%;height:auto}
.burn .lg{display:flex;gap:16px;align-items:center;color:var(--ink-2);font-size:12px}
.burn .lg i{display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-2px}
.loop li{list-style:none;display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:12px;align-items:center;min-height:56px;padding:8px 16px;border-bottom:1px solid var(--line)}
.loop li.is-now{background:var(--sky);box-shadow:inset 3px 0 var(--electric)}
.loop li .ix{display:inline-grid;place-items:center;width:24px;height:24px;border:1.5px solid var(--grey-400);font:600 12px/1 var(--f-text);color:var(--ink-2)}
.loop li.is-now .ix{border-color:var(--electric);color:var(--electric)}
.mismatch{margin:12px 16px 16px;padding:12px 16px;background:var(--warn-wash);box-shadow:inset 3px 0 var(--warn)}
.mismatch p{color:var(--ink-2);margin-top:4px}
.mismatch .btn-row{margin-top:10px}
"""


def tabs():
    t = [("All", 14, "14 clients", True, "all")]
    caps = ["2 waiting on owners", "Clive day 9", "Dorrian", "130 to decide", "$3,140 open", "AIM · live", "none yet", "since Oct 9"]
    caps[3] = "52 to decide"
    for i, s in enumerate(STAGES):
        t.append((s, STAGE_COUNTS[i], caps[i], False, str(i)))
    h = "".join(f'<button class="band-tab" role="tab" type="button" data-f="{f}" aria-selected="{"true" if sel else "false"}">'
                f'<span class="eyebrow">{a}</span><span class="v">{b}</span><span class="t-cap">{c}</span></button>' for a, b, c, sel, f in t)
    return f'<div class="bands tw-tabs" role="tablist" aria-label="Migration stage">{h}</div>'


def row(c, checked=False):
    st = c["stage"]
    bad = c.get("bad", False)
    meter_ = stage_meter(st, bad=bad)
    sla = ' · <span class="warn">late</span>' if c.get("sla") else ""
    if c.get("bad"):
        sla = ' · <span class="neg">late</span>'
    stage_cell = f'<div class="stgw">{meter_}<span class="who"><span class="l1">{STAGES[st]}</span><span class="l2">{c["days"]}{sla}</span></span></div>'
    if c["sources"]:
        srcs = '<div class="srcs">' + "".join(src(n, h, s, b) for n, h, s, b in c["sources"]) + "</div>"
    else:
        srcs = f'<span class="l1 ink-2">Not named yet</span><span class="l2">{c.get("src_txt", "")}</span>'
    if c["blk"]:
        cents, lab, cls = c["blk"]
        blk = f'<span class="l1 blk-v">{dollars(cents)}</span><span class="l2">{lab}</span>'
    elif c.get("blk_txt"):
        a, b = c["blk_txt"]
        blk = f'<span class="l1">{a}</span><span class="l2">{b}</span>'
    else:
        blk = f'<span class="l1 pos">None</span><span class="l2">{c.get("done", "")}</span>'
    if c["nxt"]:
        prim = c["key"] in ("heartland",)
        nxt = f'<button class="btn{" btn--primary" if prim else ""}" type="button">{c["nxt"]}</button>'
    else:
        nxt = f'<span class="l1 ink-2">Hand to close</span><span class="l2">in Close grid</span>'
    ppl = f'<span class="l1">{c["prep"]}</span><span class="l2">rev. {c["rev"]}</span>'
    attn = " is-attn" if bad else ""
    sel = " is-selected" if checked else ""
    own = ""
    ck = " checked" if checked else ""
    return (f'<tr class="q-row{attn}{sel}" tabindex="0" data-stage="{st}" data-wave="{c["wave"]}" data-drill="{c["name"]} migration">'
            f'<td class="ck"><label class="check"><input type="checkbox" aria-label="Select {c["name"]}"{ck}><i></i></label></td>'
            f'<td><span class="l1">{c["name"]}</span><span class="l2">{c["num"]}{" · own" if c.get("own") else ""} · cutover {c["cut"]}</span></td>'
            f'<td>{stage_cell}</td><td>{srcs}</td><td>{blk}</td><td>{nxt}</td><td>{ppl}</td>'
            f'<td><span class="l1 tnum">{c["golive"]}</span><span class="l2">{"live" if st == 7 else "target"}</span></td></tr>')


def table():
    sel = {"heritage", "icc", "dorrian"}
    body = ""
    for w in (3, 2, 1, 0):
        cs = [c for c in CLIENTS if c["wave"] == w]
        sub = sum(c["blk"][0] for c in cs if c["blk"])
        cut = cs[0]["cut"]
        right = f'{dollars(sub)} in blockers' if sub else "no dollar blockers"
        body += (f'<tr class="q-group" data-wave="{w}"><td colspan="8"><span class="q-group-t">{WAVES[w]}</span>'
                 f'<span class="t-cap">{len(cs)} client{"s" if len(cs) != 1 else ""} · cutover {cut} · {right}</span></td></tr>')
        order = sorted(cs, key=lambda c: (c["stage"] == 7, -(c["blk"][0] if c["blk"] else 0), c["stage"]))
        body += "".join(row(c, c["key"] in sel) for c in order)
    bulk = (f'<div class="bulk" id="tw-bulk"><b><span data-n>3</span> selected</b><span class="t-cap">Heritage Interiors, Iowa Custom Cabinets, Dorrian HVAC</span><span class="sp"></span>'
            f'<button class="btn" type="button">Set cutover</button><button class="btn" type="button">Assign</button>'
            f'<button class="btn" type="button">Request documents</button><button class="btn" type="button">Run preflight</button>'
            f'<button class="btn btn--primary" type="button" data-toast="Applied Merit standard v3 to 3 clients">Apply mapping set</button></div>')
    t = f"""<table class="tbl tbl-q" aria-label="Clients in migration, grouped by wave">
<colgroup><col style="width:48px"><col><col style="width:184px"><col style="width:188px"><col style="width:128px"><col style="width:184px"><col style="width:132px"><col style="width:72px"></colgroup>
<thead><tr><th class="ck"><span class="sr">Select</span></th><th><button class="th-sort" type="button">Client</button></th><th>Stage</th><th>Sources</th><th><button class="th-sort" type="button">Blockers {ico("down",12)}</button></th><th>Next step</th><th>Preparer</th><th>Go-live</th></tr></thead>
<tbody>{body}</tbody></table>"""
    foot = (f'<div class="tw-foot"><span><b>14</b> clients</span><span><b>2</b> live</span><span><b>{dollars(BLOCKER_CENTS)}</b> in open blockers = sum of the column</span>'
            f'<span class="sp"></span><span class="keyhints"><span class="keys"><span class="kbd">J</span><span class="kbd">K</span></span> move'
            f'<span class="keys"><span class="kbd">X</span></span> select<span class="keys"><span class="kbd">↵</span></span> open</span></div>')
    return f'<div class="tw">{bulk}{t}{foot}</div>'


def burndown():
    # Blockers $ (thousands) by day, Oct 5 → Oct 19 (Wave 2 opened Oct 1)
    pts = [212, 236, 241, 228, 219, 204, 196, 189, 171, 168, 152, 139, 131, 120, 113.7]
    W, H, L, B = 600, 200, 44, 28
    xs = [L + i * (W - L - 12) / (len(pts) - 1) for i in range(len(pts))]
    ys = [12 + (250 - p) / 250 * (H - B - 12) for p in pts]
    path = " ".join(("M" if i == 0 else "L") + f"{x:.1f},{y:.1f}" for i, (x, y) in enumerate(zip(xs, ys)))
    grid = ""
    for v in (0, 50, 100, 150, 200, 250):
        y = 12 + (250 - v) / 250 * (H - B - 12)
        grid += f'<line x1="{L}" x2="{W-12}" y1="{y:.1f}" y2="{y:.1f}" stroke="var(--line)"/><text x="{L-8}" y="{y+4:.1f}" text-anchor="end" font-size="12" fill="var(--ink-3)">{v}k</text>'
    labels = ""
    for i, d in enumerate(range(5, 20)):
        if i % 2 == 0:
            anc = "end" if i == len(pts) - 1 else "middle"
            labels += f'<text x="{xs[i]:.1f}" y="{H-8}" text-anchor="{anc}" font-size="12" fill="var(--ink-3)">Oct {d}</text>'
    # live clients as stacked marks on the axis
    bars = ""
    live = [0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]
    target = f'<line x1="{L}" x2="{W-12}" y1="{12 + 250/250*(H-B-12):.1f}" y2="{12 + 250/250*(H-B-12):.1f}" stroke="var(--midnight)"/>'
    end = f'<circle cx="{xs[-1]:.1f}" cy="{ys[-1]:.1f}" r="4" fill="var(--electric)"/><text x="{xs[-1]-4:.1f}" y="{ys[-1]+22:.1f}" text-anchor="end" font-size="12" font-weight="600" fill="var(--ink)">$113,717 today</text>'
    peak = f'<text x="{xs[2]+6:.1f}" y="{ys[2]-8:.1f}" font-size="12" fill="var(--ink-2)">Wave 2 pulls land · $241k</text>'
    svg = (f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="Open blockers in dollars by day, down from $241k on Oct 7 to $113,717 today">'
           f'{grid}{target}<path d="{path}" fill="none" stroke="var(--electric)" stroke-width="2"/>{end}{peak}{labels}</svg>')
    body = f'<div class="card-b burn">{svg}<div class="lg" style="margin-top:8px"><span><i style="background:var(--electric);height:2px;vertical-align:3px"></i>Open blockers, $</span><span>Every point drills to the blockers open that day</span></div></div>'
    return (f'<section class="card" aria-labelledby="h-burn"><div class="card-h"><h3 id="h-burn">Blocker burndown</h3><span class="t-cap">Waves 1–3 · last 15 days</span>'
            f'<span class="sp" style="flex:1"></span><div class="seg" role="group" aria-label="Measure"><button type="button" aria-pressed="true">Dollars</button><button type="button" aria-pressed="false">Stage counts</button></div></div>'
            f'{body}<div class="card-f"><span>Down $127k in 12 days. At this pace Wave 2 clears blockers by Oct 25.</span><span class="sp"></span><button class="btn btn--quiet" type="button">{ico("download")}Export tracker</button></div></section>')


def connect_loop():
    items = [("1", "Swan Creek", "C-107", "Bound 9:14 AM · EIN matches", "done"),
             ("2", "Artistry Homes", "C-110", "Company picked doesn’t match", "now"),
             ("3", "Wild Rose Interiors", "C-112", "Queued", "next")]
    li = ""
    for ix, n, num, s, st in items:
        r = {"done": status("ready", "Connected"), "now": status("risk", "Check"),
             "next": '<button class="btn" type="button">Ask the owner to connect</button>'}[st]
        li += f'<li class="{"is-now" if st == "now" else ""}"><span class="ix">{ix}</span><span class="who"><span class="l1">{n}</span><span class="l2">{num} · {s}</span></span>{r}</li>'
    mm = ('<div class="mismatch" role="alert"><p class="t-head" style="margin:0">This looks like Wild Rose Interiors, not Artistry Homes.</p>'
          '<p>You picked “Wild Rose Interiors LLC” in Intuit. Its EIN ends 4410, which is Wild Rose’s legal record. Nothing was pulled.</p>'
          '<div class="btn-row"><button class="btn btn--primary" type="button">Bind it to Wild Rose</button><button class="btn" type="button">Pick again for Artistry</button></div></div>')
    return (f'<section class="card" aria-labelledby="h-loop"><div class="card-h"><h3 id="h-loop">Connect the next company</h3><span class="t-cap">QuickBooks · one company per sign-in</span></div>'
            f'<ol class="loop" style="padding:0">{li}</ol>{mm}'
            f'<div class="card-f"><span>Each sign-in returns here with the next client picked. Read-only, nothing in QuickBooks changes.</span></div></section>')


def states():
    return ('<div class="states">'
            + state("Empty · new tenant", "empty", "No clients are being onboarded",
                    "Paste a client list, drop formation documents, or connect QuickBooks companies one after another. Each becomes a client with its own migration.",
                    '<button class="btn btn--primary" type="button">Add clients</button><button class="btn" type="button">Connect QuickBooks companies</button>')
            + state("Done · every client certified", "done", "All 14 clients certified",
                    "Average 4.2 days from plan to live, 31 human minutes per client. The tracker leaves the menu until a client enters Plan again.",
                    '<button class="btn" type="button">Download all 14 certificates</button><button class="btn btn--quiet" type="button">Open Close grid</button>')
            + state("Filtered · Dana Lee’s view", "none", "6 clients assigned to you",
                    "A preparer sees only the clients she’s assigned to. The other 8 rows aren’t hidden; they don’t exist for her, in the page or the API.",
                    '<button class="btn" type="button">Show my next step</button>',
                    '<div class="kv" style="width:100%;max-width:320px;margin:4px 0"><dt>Heritage Interiors</dt><dd>Map</dd><dt>Dorrian HVAC</dt><dd>Preflight</dd><dt>Clive Power Equipment</dt><dd>Connect</dd><dt>3 more</dt><dd>Plan</dd></div>')
            + '</div>')


SCRIPT_T = """<script>
(function(){
  var tw=document.querySelector('.tw'); if(!tw) return;
  var bulk=document.getElementById('tw-bulk');
  function sync(){var n=tw.querySelectorAll('tbody input:checked').length;bulk.querySelector('[data-n]').textContent=n;bulk.hidden=n===0;
    tw.querySelectorAll('tbody tr.q-row').forEach(function(r){r.classList.toggle('is-selected',r.querySelector('input').checked);});}
  tw.addEventListener('change',sync);
  tw.querySelectorAll('tbody tr.q-row').forEach(function(r){r.addEventListener('keydown',function(e){if(e.key==='x'||e.key==='X'){var i=r.querySelector('input');i.checked=!i.checked;sync();}
    if(e.key==='j'||e.key==='k'){var rows=[].slice.call(tw.querySelectorAll('tbody tr.q-row:not(.is-hidden)'));var i2=rows.indexOf(r)+(e.key==='j'?1:-1);if(rows[i2])rows[i2].focus();}});});
  document.querySelectorAll('.tw-tabs .band-tab').forEach(function(b){b.addEventListener('click',function(){var f=b.getAttribute('data-f');
    tw.querySelectorAll('tbody tr.q-row').forEach(function(r){r.classList.toggle('is-hidden',f!=='all'&&r.getAttribute('data-stage')!==f);});
    tw.querySelectorAll('tbody tr.q-group').forEach(function(g){var w=g.getAttribute('data-wave');var any=[].some.call(tw.querySelectorAll('tbody tr.q-row[data-wave="'+w+'"]'),function(r){return !r.classList.contains('is-hidden')});g.classList.toggle('is-hidden',!any);});});});
  document.querySelectorAll('[data-toast]').forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();var t=document.getElementById('toast');t.querySelector('[data-msg]').textContent=b.getAttribute('data-toast');t.hidden=false;setTimeout(function(){t.hidden=true},4000);});});
})();
</script>"""


def build():
    ctl = ctxline(["Mon Oct 19", "Wave 2 cutover Sep 30", "<b>2 of 14 live</b>", "2 certified", f'<b>{dollars(BLOCKER_CENTS)} in open blockers</b>', "3 over SLA"],
                  '<span class="tag" style="margin-right:12px">Sample data</span>')
    head_ = ('<div class="page-head"><div><div class="eyebrow">Clients<span class="sl">//</span>Onboarding tracker</div>'
             '<h1 class="t-title" style="margin-top:8px">Migration Control Tower</h1></div>'
             f'<div class="btn-row"><button class="btn" type="button">{ico("plus")}Add clients</button>'
             f'<button class="btn" type="button">{ico("link")}Resume QuickBooks loop · 2 left</button></div></div>')
    filters = ('<div class="tw-filters"><div class="seg" role="group" aria-label="Wave"><button type="button" aria-pressed="true">All waves</button>'
               '<button type="button" aria-pressed="false">Wave 1<span class="n">3</span></button><button type="button" aria-pressed="false">Wave 2<span class="n">5</span></button>'
               '<button type="button" aria-pressed="false">Wave 3<span class="n">1</span></button><button type="button" aria-pressed="false">No wave<span class="n">5</span></button></div>'
               '<select class="select" aria-label="System"><option>Every system</option><option>QuickBooks</option><option>simPRO</option><option>Buildertrend</option></select>'
               '<select class="select" aria-label="Preparer"><option>Every preparer</option><option>Dana Lee</option><option>Sam Kovac</option></select>'
               f'<label class="search">{ico("search")}<input type="search" placeholder="Find a client" aria-label="Find a client"></label></div>')
    main = (ctl + '<div class="page">' + head_ + tabs() + filters + table()
            + f'<div class="lower">{burndown()}{connect_loop()}</div></div>')
    app_ = app("workspace", "density-cockpit", rail_manager(), bar(ctx_workspace(), "Onboarding tracker", "Jump to client, person, request…"), main, extra_cls="", style="")
    app_ = app_.replace('class="app ', 'data-live class="app ', 1)
    body = (board_h("O10<span class=\"sl\">//</span>08-ONBOARDING §6", "Fourteen clients, one motion",
                    "Jordan Smith runs Merit’s move onto MeritBooks from here. Rows group by wave, worst first: a cancelled source outranks everything, then dollars blocked. "
                    "Each row says exactly what’s next as a verb button. Three Wave 2 clients are selected to receive the Merit standard mapping set in one action.",
                    '<span class="tag">Sample data</span> O10')
            + frame(app_, "O10.1 · Populated, 3 selected, bulk bar open. Tabs filter; J/K/X work on rows.")
            + anno([("Dollars, not dots", "Blockers are stated in dollars with their class (mapping, preflight, tie-out, shadow). The wave subtotal and the footer are sums of the column."),
                    ("The stage is the brand’s slash", "Eight strokes, Plan to Live. Filled = done, outlined = current, red = current and blocked. Same reading as the S5 close grid."),
                    ("Honest sources", "Each system chip carries its health pip. Dashed chips are bridges through QuickBooks, labelled temporary. Clients whose systems aren’t known say so and show the question sent."),
                    ("Many clients, one motion", "Bulk set cutover, assign, request documents, run preflight, apply a mapping set. The QuickBooks loop binds each Intuit company to the right client by EIN before anything is pulled.")])
            + section_h("O10.2 · Empty, done and filtered", "Every module defines all three")
            + f'<div class="frame" style="background:var(--canvas)">{states()}</div>')
    return page("O10 · Migration Control Tower", CSS, body, "O-control-tower.html", SCRIPT_T)


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "O-control-tower.html")
    open(out, "w").write(build())
    print(out)
