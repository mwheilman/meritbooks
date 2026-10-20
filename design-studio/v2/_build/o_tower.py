"""O10 — Migration Control Tower (/clients/onboarding). Jordan Smith, accounting manager, workspace context."""
from onb import *
from onb_data import *

CSS = """
.page{padding-top:24px}
/* stage tabs: each tab carries the slash its rows carry, its plain name, a one-line description, count, status */
.tw-tabs,.sg-t{grid-template-columns:repeat(9,minmax(0,1fr))}
.tw-tabs .band-tab{padding:10px 12px 12px;gap:2px;min-width:0;justify-content:flex-start}
.tw-tabs .band-tab .meter{padding:0 2px 0 3px;margin:2px 0 6px}
.tw-tabs .band-tab .eyebrow{min-height:32px;white-space:normal;overflow-wrap:anywhere;color:var(--ink)}
.tw-tabs .band-tab .tb-d{display:block;min-height:32px;font-size:12px;line-height:16px;color:var(--ink-2);white-space:normal}
.tw-tabs .band-tab .v{font-size:20px;margin-top:auto;padding-top:8px}
.tw-tabs .band-tab .t-cap{white-space:normal;min-height:32px}
.tw-tabs .band-tab:focus-visible{outline:2px solid var(--electric);outline-offset:-2px}
/* the stage guide: a disclosure under the tabs whose eight columns sit exactly under their tabs */
.sg{border:1px solid var(--line);border-top:0;background:var(--white)}
.sg>summary{display:flex;align-items:center;gap:10px;min-height:40px;padding:0 16px;cursor:pointer;list-style:none;color:var(--electric);font-weight:600}
.sg>summary::-webkit-details-marker{display:none}
.sg>summary:hover{background:var(--grey-100)}
.sg>summary:focus-visible{outline:2px solid var(--electric);outline-offset:-2px}
.sg>summary .ico{transition:transform var(--fast)}
.sg[open]>summary .ico{transform:rotate(180deg)}
.sg>summary .t-cap{font-weight:400;color:var(--ink-3)}
.sg:not([open]) .sg-t{display:none}
.sg-t{width:100%;table-layout:fixed;border-collapse:collapse;border-top:1px solid var(--line)}
.sg-t th,.sg-t td{padding:10px 12px;vertical-align:top;text-align:left;border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:12px;line-height:16px;color:var(--ink-2)}
.sg-t tr>*:last-child{border-right:0}
.sg-t tr:last-child>*{border-bottom:0}
.sg-t thead th{font:600 13px/20px var(--f-text);color:var(--ink);background:var(--canvas)}
.sg-t thead th .no{display:block;font:500 12px/16px var(--f-text);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.sg-t tbody th{font:500 12px/16px var(--f-text);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);background:var(--canvas)}
.sg-t td.dn{color:var(--ink);font-weight:500}
.tw-wave{display:flex;align-items:center;gap:8px;margin-top:8px;color:var(--ink-2);font-size:12px;line-height:16px}
.tw-wave b{color:var(--ink);font-weight:600}
.tw-filters{display:flex;align-items:center;gap:8px;margin:16px 0 0}
.tw-filters .select{width:auto}
.tw-filters .search{width:240px;margin-left:auto}
.tw{margin-top:12px;border:1px solid var(--line);background:var(--white)}
.tw .bulk{border-bottom:1px solid var(--blue-100)}
.tw table th{background:var(--white)}
.tw td{height:64px;padding-top:8px;padding-bottom:8px}
.tw td .l1,.tw td .l2{white-space:normal;overflow-wrap:anywhere}
.tw td{overflow:visible;white-space:normal}
.tw .srcs{flex-wrap:wrap;gap:4px}
.tw .stg-l2{display:flex;align-items:center;gap:6px}
.tw .stg-l2 .meter{padding:0 2px 0 4px}
.tw .th-sort{min-height:32px}
.tw thead th{height:48px;vertical-align:middle}
.tw tr>*:first-child{padding-left:16px}
.tw tr>*:last-child{padding-right:16px}
.tw tr.q-group td{height:40px}
.tw tr.q-group .t-cap{color:var(--ink-2)}
.tw tr.q-row{cursor:pointer}
.tw .ck{padding-right:0}
.tw .ck .check{min-height:32px}
.tw td .btn{height:auto;min-height:32px;padding-top:6px;padding-bottom:6px;white-space:normal;text-align:left;line-height:18px}
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


TAB_CAPS = ["2 waiting on owners", "Clive late · day 9", "Dorrian", "52 to decide", "$3,140 open", "AIM · live", "none yet", "since Oct 9"]


def tabs():
    h = ('<button class="band-tab" role="tab" type="button" data-f="all" aria-selected="true" aria-describedby="sgd-all">'
         '<span class="meter" aria-hidden="true">' + '<i class="on"></i>' * 8 + '</span>'
         '<span class="eyebrow">All stages</span><span class="tb-d">Every client in migration</span>'
         '<span class="v">14</span><span class="t-cap">14 clients</span></button>')
    for i, s_ in enumerate(STAGES):
        strokes = '<i class="on"></i>' * i + ('<i class="on"></i>' if i == 7 else '<i class="cur"></i>') + "<i></i>" * (7 - i)
        h += (f'<button class="band-tab" role="tab" type="button" data-f="{i}" aria-selected="false" aria-describedby="sgd-{i}" title="{E(stage_desc(i))}">'
              f'<span class="meter" aria-hidden="true">{strokes}</span>'
              f'<span class="eyebrow">{s_}</span><span class="tb-d">{STAGE_INFO[i]["short"]}</span>'
              f'<span class="v">{STAGE_COUNTS[i]}</span><span class="t-cap">{TAB_CAPS[i]}</span></button>')
    desc = ('<div hidden><span id="sgd-all">All fourteen clients, every stage.</span>'
            + "".join(f'<span id="sgd-{i}">{E(stage_desc(i))}</span>' for i in range(8)) + '</div>')
    return f'<div class="bands tw-tabs" role="tablist" aria-label="Migration stage">{h}</div>{desc}'


def guide(open_=False):
    """What happens in each stage: eight columns under their tabs; the first column labels the rows."""
    head = '<tr><th scope="col"><span class="sr">Stage</span></th>' + "".join(
        f'<th scope="col"><span class="no">Stage {i + 1}</span>{STAGES[i]}</th>' for i in range(8)) + "</tr>"
    rows = ""
    for lab, k, cls in (("What happens", "what", ""), ("Who does it", "who", ""), ("Done when", "done", "dn")):
        rows += f'<tr><th scope="row">{lab}</th>' + "".join(f'<td class="{cls}">{STAGE_INFO[i][k]}</td>' for i in range(8)) + "</tr>"
    return (f'<details class="sg"{" open" if open_ else ""}><summary>{ico("down")}What happens in each stage'
            f'<span class="t-cap">what the work is, who does it, and when it’s done</span></summary>'
            f'<table class="sg-t" aria-label="The eight migration stages"><colgroup>{"<col>" * 9}</colgroup><thead>{head}</thead><tbody>{rows}</tbody></table></details>')


def row(c, checked=False):
    st = c["stage"]
    bad = c.get("bad", False)
    meter_ = stage_meter(st, bad=bad)
    sla = ' · <span class="warn">late</span>' if c.get("sla") else ""
    if bad:
        sla = ' · <span class="neg">late</span>'
    stage_cell = f'<span class="l1">{STAGES[st]}</span><span class="l2 stg-l2">{meter_}<span>{c["days"]}{sla}</span></span>'
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
        nxt = '<span class="l1 ink-2">Handed to close</span><span class="l2">in the Close grid</span>'
    ppl = f'<span class="l1">{c["prep"]}</span><span class="l2">reviewer {c["rev"]}</span>'
    attn = " is-attn" if bad else ""
    sel = " is-selected" if checked else ""
    ck = " checked" if checked else ""
    l2 = c.get("note") or (f'cutover {c["cut"]}' if c["cut"] else "cutover not set")
    gl = (f'<span class="l1 tnum">{c["golive"]}</span><span class="l2">{"live" if st == 7 else "target"}</span>' if c["golive"]
          else '<span class="l1 ink-2">Not set</span>')
    return (f'<tr class="q-row{attn}{sel}" tabindex="0" data-stage="{st}" data-wave="{c["wave"]}" data-drill="{c["name"]} migration">'
            f'<td class="ck"><label class="check"><input type="checkbox" aria-label="Select {c["name"]}"{ck}><i></i></label></td>'
            f'<td><span class="l1">{c["name"]}</span><span class="l2">{c["num"]}{" · own books" if c.get("own") else ""} · {l2}</span></td>'
            f'<td>{stage_cell}</td><td>{srcs}</td><td>{blk}</td><td>{nxt}</td><td>{ppl}</td><td>{gl}</td></tr>')


def table():
    sel = {"heritage", "icc", "dorrian"}
    body = ""
    for w in WAVE_ORDER:                       # chronological by cutover; Unscheduled last
        cs = [c for c in CLIENTS if c["wave"] == w]
        sub = WAVE_BLK[w]
        right = f'{dollars(sub)} in blockers' if sub else "no dollar blockers"
        body += (f'<tr class="q-group" data-wave="{w}"><td colspan="8"><span class="q-group-t">{WAVES[w]}</span>'
                 f'<span class="t-cap">{WAVE_WHY[w]} · {len(cs)} client{"s" if len(cs) != 1 else ""} · {right}</span></td></tr>')
        # worst first inside a wave: a cancelled source, then dollars blocked, then earliest stage; live clients last
        order = sorted(cs, key=lambda c: (c["stage"] == 7, not c.get("bad", False), -(c["blk"][0] if c["blk"] else 0), c["stage"]))
        body += "".join(row(c, c["key"] in sel) for c in order)
    bulk = (f'<div class="bulk" id="tw-bulk"><b><span data-n>3</span> selected</b><span class="t-cap">Heritage Interiors, Iowa Custom Cabinets, Dorrian HVAC</span><span class="sp"></span>'
            f'<button class="btn" type="button">Set cutover</button><button class="btn" type="button">Assign</button>'
            f'<button class="btn" type="button">Request documents</button><button class="btn" type="button">Check data quality</button>'
            f'<button class="btn btn--primary" type="button" data-toast="Applied Merit standard v3 to 3 clients">Apply mapping set</button></div>')
    t = f"""<table class="tbl tbl-q" aria-label="Clients in migration, grouped by wave, earliest cutover first">
<colgroup><col style="width:48px"><col><col style="width:168px"><col style="width:168px"><col style="width:136px"><col style="width:176px"><col style="width:160px"><col style="width:80px"></colgroup>
<thead><tr><th class="ck"><span class="sr">Select</span></th><th><button class="th-sort" type="button">Client</button></th><th>Stage</th><th>Sources</th><th><button class="th-sort" type="button">Blockers {ico("down",12)}</button></th><th>Next step</th><th>Preparer</th><th>Go-live</th></tr></thead>
<tbody>{body}</tbody></table>"""
    foot = (f'<div class="tw-foot"><span><b>14</b> clients</span><span><b>2</b> live</span><span><b>{dollars(BLOCKER_CENTS)}</b> in open blockers = sum of the column and of the wave subtotals</span>'
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
    return (f'<section class="card" aria-labelledby="h-loop"><div class="card-h"><h3 id="h-loop">Connect the next company</h3><span class="t-cap">Wave 3 · QuickBooks, one company per sign-in</span></div>'
            f'<ol class="loop" style="padding:0">{li}</ol>{mm}'
            f'<div class="card-f"><span>Each sign-in returns here with the next client picked. Read-only, nothing in QuickBooks changes.</span></div></section>')


def states():
    return ('<div class="states">'
            + state("Empty · new tenant", "empty", "No clients are being onboarded",
                    "Paste a client list, drop formation documents, or connect QuickBooks companies one after another. Each becomes a client with its own migration.",
                    '<button class="btn btn--primary" type="button">Add clients</button><button class="btn" type="button">Connect QuickBooks companies</button>')
            + state("Done · every client signed off", "done", "All 14 clients signed off and live",
                    "Average 4.2 days from Gather info to Live, 31 human minutes per client. The tracker leaves the menu until a new client starts at Gather info.",
                    '<button class="btn" type="button">Download all 14 certificates</button><button class="btn btn--quiet" type="button">Open Close grid</button>')
            + state("Filtered · Dana Lee’s view", "none", "6 clients assigned to you",
                    "A preparer sees only the clients she’s assigned to. The other 8 rows aren’t hidden; they don’t exist for her, in the page or the API.",
                    '<button class="btn" type="button">Show my next step</button>',
                    '<div class="kv" style="width:100%;max-width:360px;margin:4px 0"><dt>Heritage Interiors</dt><dd>Match accounts</dd><dt>Dorrian HVAC</dt><dd>Check data quality</dd><dt>Clive, Swan Creek, Wild Rose</dt><dd>Connect systems</dd><dt>Crystal Kitchen &amp; Bath</dt><dd>Gather info</dd></div>')
            + '</div>')


SCRIPT_T = """<script>
(function(){
  var tw=document.querySelector('.tw'); if(!tw) return;
  var bulk=document.getElementById('tw-bulk'); var f={stage:'all',wave:'all'};
  function sync(){var n=tw.querySelectorAll('tbody input:checked').length;bulk.querySelector('[data-n]').textContent=n;bulk.hidden=n===0;
    tw.querySelectorAll('tbody tr.q-row').forEach(function(r){r.classList.toggle('is-selected',r.querySelector('input').checked);});}
  function apply(){tw.querySelectorAll('tbody tr.q-row').forEach(function(r){r.classList.toggle('is-hidden',(f.stage!=='all'&&r.getAttribute('data-stage')!==f.stage)||(f.wave!=='all'&&r.getAttribute('data-wave')!==f.wave));});
    tw.querySelectorAll('tbody tr.q-group').forEach(function(g){var w=g.getAttribute('data-wave');var any=[].some.call(tw.querySelectorAll('tbody tr.q-row[data-wave="'+w+'"]'),function(r){return !r.classList.contains('is-hidden')});g.classList.toggle('is-hidden',!any);});}
  tw.addEventListener('change',sync);
  tw.querySelectorAll('tbody tr.q-row').forEach(function(r){r.addEventListener('keydown',function(e){if(e.key==='x'||e.key==='X'){var i=r.querySelector('input');i.checked=!i.checked;sync();}
    if(e.key==='j'||e.key==='k'){var rows=[].slice.call(tw.querySelectorAll('tbody tr.q-row:not(.is-hidden)'));var i2=rows.indexOf(r)+(e.key==='j'?1:-1);if(rows[i2])rows[i2].focus();}});});
  document.querySelectorAll('.tw-tabs .band-tab').forEach(function(b){b.addEventListener('click',function(){
    b.parentNode.querySelectorAll('.band-tab').forEach(function(x){x.setAttribute('aria-selected',x===b?'true':'false')});f.stage=b.getAttribute('data-f');apply();});});
  document.querySelectorAll('.tw-filters [data-w]').forEach(function(b){b.addEventListener('click',function(){
    b.parentNode.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false')});f.wave=b.getAttribute('data-w');apply();});});
  document.querySelectorAll('[data-toast]').forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();var t=document.getElementById('toast');t.querySelector('[data-msg]').textContent=b.getAttribute('data-toast');t.hidden=false;setTimeout(function(){t.hidden=true},4000);});});
})();
</script>"""


def tower(guide_open=False, lower=True, rows=True):
    ctl = ctxline(["Mon Oct 19", "Wave 2 · Sep 30 cutover", "Wave 3 next · Oct 31", "<b>2 of 14 live</b>", f'<b>{dollars(BLOCKER_CENTS)} in open blockers</b>', "3 over SLA"],
                  '<span class="tag" style="margin-right:12px">Sample data</span>')
    head_ = ('<div class="page-head"><div><div class="eyebrow">Clients<span class="sl">//</span>Onboarding tracker</div>'
             '<h1 class="t-title" style="margin-top:8px">Migration Control Tower</h1></div>'
             f'<div class="btn-row"><button class="btn" type="button">{ico("plus")}Add clients</button>'
             f'<button class="btn" type="button">{ico("link")}Resume QuickBooks loop · 2 left</button></div></div>')
    waves = "".join(f'<button type="button" aria-pressed="false" data-w="{w}">{WAVE_SHORT[w]}<span class="n">{WAVE_COUNTS[w]}</span></button>' for w in WAVE_ORDER)
    filters = ('<div class="tw-filters"><div class="seg" role="group" aria-label="Wave" aria-describedby="tw-wave-def"><button type="button" aria-pressed="true" data-w="all">All waves</button>'
               f'{waves}</div>'
               '<select class="select" aria-label="System"><option>Every system</option><option>QuickBooks</option><option>simPRO</option><option>Buildertrend</option></select>'
               '<select class="select" aria-label="Preparer"><option>Every preparer</option><option>Dana Lee</option><option>Sam Kovac</option></select>'
               f'<label class="search">{ico("search")}<input type="search" placeholder="Find a client" aria-label="Find a client"></label></div>'
               f'<p class="tw-wave" id="tw-wave-def">{ico("layers", 12)}<span><b>A wave is a group of clients moving on the same cutover date.</b> '
               'Waves list earliest cutover first; clients without a cutover wait in Unscheduled.</span></p>')
    main = (ctl + '<div class="page">' + head_ + tabs() + guide(guide_open) + filters + (table() if rows else "")
            + (f'<div class="lower">{burndown()}{connect_loop()}</div>' if lower else "") + '</div>')
    app_ = app("workspace", "density-cockpit", rail_manager(), bar(ctx_workspace(), "Onboarding tracker", "Jump to client, person, request…"), main, extra_cls="", style="")
    return app_.replace('class="app ', 'data-live class="app ', 1)


def build():
    body = (board_h("O10<span class=\"sl\">//</span>08-ONBOARDING §6", "Fourteen clients, one motion",
                    "Jordan Smith runs Merit’s move onto MeritBooks from here. A wave is a group of clients moving on the same cutover date, so waves read in date order: Aug 31, Sep 30, Oct 31, then the two clients not scheduled yet. "
                    "Inside a wave, worst first: a cancelled source outranks everything, then dollars blocked. Every stage tab says what the work is; each row says exactly what’s next as a verb button.",
                    '<span class="tag">Sample data</span> O10')
            + frame(tower(), "O10.1 · Populated, 3 Wave 2 clients selected, bulk bar open. Stage guide collapsed (the default). Tabs and wave buttons filter; J/K/X work on rows.")
            + anno([("Stages say what the work is", "Gather info, Connect systems, Check data quality, Match accounts, Prove balances, Practice close, Signed off, Live. Each tab adds one line of description; hover or focus gives what happens, who does it and when it’s done."),
                    ("The stage is the brand’s slash", "Eight strokes, Gather info to Live. Filled = done, outlined = current, red = current and blocked. Each tab draws the slash its rows carry, so the tabs are the legend."),
                    ("Waves are cutover dates", "Wave 1 Aug 31, Wave 2 Sep 30, Wave 3 Oct 31, then Unscheduled with no cutover and no go-live until the owner names the systems. Wave subtotals and the footer are sums of the blocker column."),
                    ("Many clients, one motion", "Bulk set cutover, assign, request documents, check data quality, apply a mapping set. The QuickBooks loop binds each Intuit company to the right client by EIN before anything is pulled.")])
            + section_h("O10.2 · What happens in each stage", "The guide open: eight columns, each under its own tab")
            + frame(tower(guide_open=True, lower=False, rows=False), "O10.2 · “What happens in each stage” expanded, cropped above the client table. Remembered per person; new staff see it open on their first visit.")
            + anno([("Under its own tab", "The guide is a table on the same nine-column grid as the tabs, so each stage’s definition sits directly below its count. The first column names the rows."),
                    ("What happens", "One sentence per stage in the client’s terms: cutover, systems, checks, accounts, balances, a month closed twice, a signature, live."),
                    ("Who does it", "Real people at Merit: Jordan Smith plans and settles shared rules, the preparer does the work, a reviewer who never prepared the client signs."),
                    ("Done when", "The exit test for every stage, the same rule the product uses to move a client to the next tab.")])
            + section_h("O10.3 · Empty, done and filtered", "Every module defines all three")
            + f'<div class="frame" style="background:var(--canvas)">{states()}</div>')
    return page("O10 · Migration Control Tower", CSS, body, "O-control-tower.html", SCRIPT_T)


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "O-control-tower.html")
    open(out, "w").write(build())
    print(out)
