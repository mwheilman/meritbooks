"""One sample-data source for the onboarding boards, so the Tower, the client workspace, preflight,
mapping, tie-out and the hub all tie. Merit Management Group is a firm tenant migrating 14 clients.
Today is Mon Oct 19, 2026. Wave 1 (cutover Aug 31) proved the mapping set; Wave 2 cutover Sep 30;
Wave 3 is the file-only client (Clive, Sage Intacct cancelled 10/1/2026). Systems come from the Merit
tech-stack record; where the record is blank the client sits in Plan with the question sent, never assumed.
Money in cents where it posts; whole dollars on the Tower."""

# stage index: 0 Plan 1 Connect 2 Preflight 3 Map 4 Tie-out 5 Shadow 6 Certified 7 Live
# blockers: (cents, label, class)   sources: (name, health, sub, bridge)
CLIENTS = [
    dict(key="mmg", name="Merit Management Group LLC", num="C-100", wave=1, cut="Aug 31", hist="20 mo", stage=7, days="since Oct 9",
         sources=[("QuickBooks", "arch", "", False), ("Plaid", "ok", "", False), ("Ramp", "ok", "", False)],
         blk=None, nxt=None, done="Certified CC-0001", prep="Priya Natarajan", rev="Jordan Smith", golive="Oct 9", own=True),
    dict(key="fund3", name="Merit Fund III", num="C-113", wave=1, cut="Aug 31", hist="20 mo", stage=7, days="since Oct 9",
         sources=[("QuickBooks", "arch", "", False), ("Plaid", "ok", "", False)],
         blk=None, nxt=None, done="Certified CC-0002", prep="Luis Ortiz", rev="Jordan Smith", golive="Oct 9"),
    dict(key="aim", name="AIM Kitchen & Bath", num="C-111", wave=1, cut="Aug 31", hist="20 mo", stage=5, days="day 6 · live",
         sources=[("QuickBooks", "ok", "", False), ("Buildertrend", "bridge", "via QB", True), ("Plaid", "ok", "", False)],
         blk=(186240, "2 shadow items", "shadow"), nxt="Resolve 2 items", prep="Luis Ortiz", rev="Jordan Smith", golive="Oct 21"),
    dict(key="heartland", name="Heartland Heating & Cooling", num="C-103", wave=2, cut="Sep 30", hist="21 mo", stage=4, days="day 2",
         sources=[("QuickBooks", "ok", "", False), ("simPRO", "ok", "", False), ("Plaid", "ok", "", False)],
         blk=(314000, "2 cells + 1 stale", "tieout"), nxt="Resolve 2 cells", prep="Sam Kovac", rev="Priya Natarajan", golive="Oct 22"),
    dict(key="heritage", name="Heritage Interiors", num="C-101", wave=2, cut="Sep 30", hist="21 mo", stage=3, days="day 3",
         sources=[("QuickBooks", "ok", "", False), ("RFMS", "ok", "", False), ("QB Time", "ok", "", False)],
         blk=(9241000, "38 to decide", "mapping"), nxt="Decide 38 mappings", prep="Dana Lee", rev="Jordan Smith", golive="Oct 27"),
    dict(key="icc", name="Iowa Custom Cabinets", num="C-108", wave=2, cut="Sep 30", hist="21 mo", stage=3, days="day 1",
         sources=[("QuickBooks", "ok", "", False), ("Innergy", "file", "file", False)],
         blk=(1148000, "WIP ≠ GL", "preflight"), nxt="Review WIP tie", prep="Luis Ortiz", rev="Jordan Smith", golive="Oct 28"),
    dict(key="dorrian", name="Dorrian HVAC", num="C-105", wave=2, cut="Sep 30", hist="21 mo", stage=2, days="day 4", sla=True,
         sources=[("QuickBooks", "ok", "", False), ("FieldEdge", "bridge", "via QB", True), ("Plaid", "err", "", False)],
         blk=(482450, "2 preflight blockers", "preflight"), nxt="Work preflight", prep="Dana Lee", rev="Jordan Smith", golive="Oct 26"),
    dict(key="revived", name="Revived Interiors", num="C-109", wave=2, cut="Sep 30", hist="21 mo", stage=1, days="day 5", sla=True,
         sources=[("Buildertrend", "bridge", "via QB", True), ("Ledger", "plan", "asked", False)],
         blk=None, blk_txt=("No ledger yet", "asked Oct 14"), nxt="Nudge owner", prep="Luis Ortiz", rev="Jordan Smith", golive="Oct 30"),
    dict(key="clive", name="Clive Power Equipment", num="C-102", wave=3, cut="Sep 30", hist="21 mo", stage=1, days="day 9", sla=True, bad=True,
         sources=[("Sage Intacct", "file", "file", False), ("c-Systems", "file", "file", False)],
         blk=None, blk_txt=("3 files missing", "Intacct Jul–Sep"), nxt="Ask Rob for files", prep="Dana Lee", rev="Jordan Smith", golive="Nov 4"),
    dict(key="metro", name="Metro Heating & Cooling", num="C-106", wave=0, cut="Oct 31", hist="22 mo", stage=0, days="day 2",
         sources=[], src_txt="Asked owner Oct 17", blk=None, blk_txt=("Not named", "3 questions sent"), nxt="Plan", prep="Sam Kovac", rev="Priya Natarajan", golive="Nov 16"),
    dict(key="crystal", name="Crystal Kitchen & Bath", num="C-104", wave=0, cut="Oct 31", hist="22 mo", stage=0, days="day 2",
         sources=[], src_txt="Asked owner Oct 17", blk=None, blk_txt=("Not named", "3 questions sent"), nxt="Plan", prep="Dana Lee", rev="Jordan Smith", golive="Nov 16"),
    dict(key="swan", name="Swan Creek", num="C-107", wave=0, cut="Oct 31", hist="22 mo", stage=1, days="today · pulling",
         sources=[("QuickBooks", "ok", "", False)], blk=None, blk_txt=("None yet", "preflight after pull"), nxt="Watch the pull", prep="Dana Lee", rev="Jordan Smith", golive="Nov 16"),
    dict(key="artistry", name="Artistry Homes", num="C-110", wave=0, cut="Oct 31", hist="22 mo", stage=0, days="day 2",
         sources=[("QuickBooks", "plan", "", False)], blk=None, blk_txt=("Not connected", "in QuickBooks loop"), nxt="Connect QuickBooks", prep="Priya Natarajan", rev="Jordan Smith", golive="Nov 16"),
    dict(key="wildrose", name="Wild Rose Interiors", num="C-112", wave=0, cut="Oct 31", hist="22 mo", stage=0, days="day 2",
         sources=[("QuickBooks", "plan", "", False)], blk=None, blk_txt=("Not connected", "in QuickBooks loop"), nxt="Connect QuickBooks", prep="Dana Lee", rev="Jordan Smith", golive="Nov 16"),
]

WAVES = {1: "Wave 1 · prove the mapping set", 2: "Wave 2 · field systems", 3: "Wave 3 · file-only", 0: "No wave yet"}

BLOCKER_CENTS = sum(c["blk"][0] for c in CLIENTS if c["blk"])
assert BLOCKER_CENTS == 186240 + 314000 + 9241000 + 1148000 + 482450 == 11371690

STAGE_COUNTS = [sum(1 for c in CLIENTS if c["stage"] == i) for i in range(8)]
assert sum(STAGE_COUNTS) == 14
assert STAGE_COUNTS == [4, 3, 1, 2, 1, 1, 0, 2]

# ---------------------------------------------------------------- Heartland tie-out (cents)
# Two non-zero cells = 314,000 cents = $3,140.00 (matches Tower)
HEARTLAND_CELLS = [("Aug 2026", "4010", "Revenue · Install", -157000), ("Aug 2026", "4020", "Revenue · Service", 157000)]
assert sum(abs(c[3]) for c in HEARTLAND_CELLS) == 314000

# ---------------------------------------------------------------- Dorrian preflight blockers (cents) = 482,450
DORRIAN_BLOCKERS = [("PF-01", 421250), ("PF-02", 61200)]
assert sum(v for _, v in DORRIAN_BLOCKERS) == 482450

# ---------------------------------------------------------------- AIM shadow residual (cents) = 186,240
AIM_SHADOW_OPEN = [("5110", "Cabinet materials", 141600), ("6210", "Subcontractors · install", 44640)]
assert sum(v for *_, v in AIM_SHADOW_OPEN) == 186240


def money(c, dec=2):
    """cents → '1,234.56' / '(1,234.56)'."""
    v = c / 100
    s = f"{abs(v):,.{dec}f}"
    return f"({s})" if c < 0 else s


def dollars(c):
    return "$" + f"{c / 100:,.0f}"

# ---------------------------------------------------------------- AIM September 2026, side by side (cents)
# MeritBooks is the book of record (live since Sep 1); QuickBooks kept in parallel for the shadow month.
# (code, name, MeritBooks, QuickBooks)  QB − MB differences: timing draw 18,400.00 (revenue), the two open items, a meals/supplies swap.
AIM_PL = {
    "rev": [("4010", "Revenue · Remodel", 74230000, 72390000), ("4020", "Revenue · Cabinets", 25160000, 25160000), ("4030", "Revenue · Design", 5290000, 5290000)],
    "cogs": [("5110", "Cabinet materials", 28431600, 28573200), ("5120", "Countertops &amp; tile", 11840400, 11840400),
             ("5210", "Subcontractors · install", 27191200, 27235840), ("5300", "Field labor", 10000000, 10000000)],
    "opex": [("6100", "Salaries &amp; wages", 9624000, 9624000), ("6200", "Rent &amp; occupancy", 1850000, 1850000), ("6300", "Vehicles", 1186000, 1186000),
             ("6500", "Marketing", 2241000, 2241000), ("6610", "Meals", 121418, 100000), ("6620", "Office supplies", 314000, 335418),
             ("6800", "Insurance", 982000, 982000), ("6990", "Other operating", 2058382, 2058382)],
}
def _s(k, i): return sum(r[i] for r in AIM_PL[k])
AIM_MB = dict(rev=_s("rev", 2), cogs=_s("cogs", 2), opex=_s("opex", 2))
AIM_QB = dict(rev=_s("rev", 3), cogs=_s("cogs", 3), opex=_s("opex", 3))
for d in (AIM_MB, AIM_QB):
    d["gp"] = d["rev"] - d["cogs"]; d["oi"] = d["gp"] - d["opex"]
assert AIM_MB["rev"] == 104680000 and AIM_MB["gp"] == 27216800 and AIM_MB["oi"] == 8840000   # = S6 data (AIM Sep)
assert AIM_QB["oi"] - AIM_MB["oi"] == -2026240
AIM_TIMING = 1840000
assert AIM_QB["oi"] - AIM_MB["oi"] + AIM_TIMING == -sum(v for *_, v in AIM_SHADOW_OPEN)
