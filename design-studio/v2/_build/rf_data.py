"""Sample data for the Reports & FP&A boards (R1, R2, F1, F2). One source; every total asserts.
Builds on data.py (S6/S23 figures) so Heartland's September and the group's September tie to
the screens already approved. Whole dollars. Today is Mon Oct 19, 2026; September is closing."""
from data import BY, G, CLIENTS

H = BY["heartland"]

# ---------------------------------------------------------------- Heartland September, by department
# (key, label, owner) — revenue departments carry revenue and cost of revenue; overhead carries spend.
REV_DEPTS = [
    # act/bud/aug/py revenue, act/bud/aug/py gross profit
    dict(k="service", name="Service", owner="Marcus Bell", rev=(486400, 492000, 501300, 455200), gp=(150800, 157440, 168300, 146700)),
    dict(k="install", name="Install", owner="Brent Kolb", rev=(984600, 1004000, 1057500, 941800), gp=(82872, 95120, 158370, 101500)),
    dict(k="maint", name="Maintenance agreements", owner="Tara Quinn", rev=(141400, 144000, 142400, 128600), gp=(56560, 59040, 56100, 53900)),
]
OH_DEPTS = [
    dict(k="sm", name="Sales & marketing", owner="Jill Ortega", spend=(74800, 62000, 66100, 58900)),
    dict(k="admin", name="Admin & office", owner="Kelsey Ruiz", spend=(98422, 92600, 97600, 88700)),
    dict(k="exec", name="Executive", owner="Dan Hartwell", spend=(32700, 25000, 32700, 23700)),
]
COLS = ("act", "bud", "aug", "py")


def _sum(rows, f, i):
    return sum(r[f][i] for r in rows)


REV = {c: _sum(REV_DEPTS, "rev", i) for i, c in enumerate(COLS)}
GP = {c: _sum(REV_DEPTS, "gp", i) for i, c in enumerate(COLS)}
OH = {c: _sum(OH_DEPTS, "spend", i) for i, c in enumerate(COLS)}
EB = {c: GP[c] - OH[c] for c in COLS}
COGS = {c: REV[c] - GP[c] for c in COLS}
assert REV["act"] == H["rev"] and REV["bud"] == H["rev_bud"] and REV["aug"] == H["rev_aug"]
assert GP["act"] == H["gp"] and GP["bud"] == H["gp_bud"] and GP["aug"] == H["gp_aug"]
assert EB["act"] == H["ebitda"] and EB["bud"] == H["ebitda_bud"]

# Install cost of revenue, by account (the drill in R2 frame 2)
INSTALL_COGS = [("5100", "Equipment", 483400, 461840), ("5200", "Materials & supplies", 118300, 120480),
                ("5300", "Install labor", 214028, 220880), ("5400", "Subcontract · electrical, duct", 86000, 105680)]
assert sum(a for *_, a, b in INSTALL_COGS) == REV_DEPTS[1]["rev"][0] - REV_DEPTS[1]["gp"][0]
assert sum(b for *_, a, b in INSTALL_COGS) == REV_DEPTS[1]["rev"][1] - REV_DEPTS[1]["gp"][1]

# ---------------------------------------------------------------- EBITDA bridge, budget -> actual (R2)
def _vol(d):
    rate = d["gp"][1] / d["rev"][1]
    return round((d["rev"][0] - d["rev"][1]) * rate)


VOL = sum(_vol(d) for d in REV_DEPTS)
RATE = {d["k"]: (d["gp"][0] - d["gp"][1]) - _vol(d) for d in REV_DEPTS}
BRIDGE = [
    ("Volume · all three departments", VOL, "Revenue 27,600 under budget at budget margins"),
    ("Install margin", RATE["install"], "Equipment 49.1% of install revenue vs 46.0% budget"),
    ("Service margin", RATE["service"], "Overtime 312 hours over plan in the heat wave"),
    ("Maintenance margin", RATE["maint"], "Visit cost per member up 4%"),
    ("Sales & marketing", -(OH_DEPTS[0]["spend"][0] - OH_DEPTS[0]["spend"][1]), "Google Local Services Ads"),
    ("Admin & office", -(OH_DEPTS[1]["spend"][0] - OH_DEPTS[1]["spend"][1]), "Software renewals landed in September"),
    ("Executive", -(OH_DEPTS[2]["spend"][0] - OH_DEPTS[2]["spend"][1]), "Recruiting fee, 2 technicians"),
]
assert EB["bud"] + sum(v for _, v, _ in BRIDGE) == EB["act"], (EB, BRIDGE)
assert VOL == -4696 and RATE["install"] == -10410

# Installs that lost money in September (R1 ask). 14 jobs; five shown, nine summed.
LOSS_JOBS = [("J-26-0412", "Ankeny · Hartman residence", "Jun 18", 14800, -3920),
             ("J-26-0398", "Urbandale · Polk Co. Schools annex", "Jun 9", 38600, -3610),
             ("J-26-0431", "West Des Moines · Nguyen residence", "Jun 27", 12900, -2460),
             ("J-26-0407", "Johnston · Prairie Ridge duplex", "Jun 15", 21400, -2180),
             ("J-26-0419", "Altoona · Becker residence", "Jun 22", 11600, -1870)]
LOSS_REST = (9, 101300, -7820)
LOSS_TOTAL = sum(j[4] for j in LOSS_JOBS) + LOSS_REST[2]
LOSS_REV = sum(j[3] for j in LOSS_JOBS) + LOSS_REST[1]
assert LOSS_TOTAL == -21860 and len(LOSS_JOBS) + LOSS_REST[0] == 14

# ---------------------------------------------------------------- FY 2027 budget cycle, Heartland (F1)
# stage: 0 draft, 1 submitted, 2 controller reviewed, 3 CFO approved
CYCLE = [
    dict(k="service", name="Service", owner="Marcus Bell", role="Service manager", tpl="HVAC · Service", kind="rev",
         target=6050000, plan=6112800, gm_t=31.5, gm=31.8, stage=2, cur=2, when="Submitted Oct 12", note="In Erin’s review"),
    dict(k="install", name="Install", owner="Brent Kolb", role="Install manager", tpl="HVAC · Install", kind="rev",
         target=9600000, plan=6412000, gm_t=12.0, gm=11.4, stage=0, cur=0, when="Due Fri Nov 6", note="8 of 12 months drafted"),
    dict(k="maint", name="Maintenance agreements", owner="Tara Quinn", role="Service agreements lead", tpl="HVAC · Agreements", kind="rev",
         target=1800000, plan=1812000, gm_t=40.0, gm=40.6, stage=4, cur=None, when="Approved Oct 16", note="Nora approved"),
    dict(k="sm", name="Sales & marketing", owner="Jill Ortega", role="Marketing manager", tpl="Department · Marketing", kind="oh",
         target=780000, plan=846000, stage=3, cur=3, when="Reviewed Oct 15", note="Waiting on Nora"),
    dict(k="admin", name="Admin & office", owner="Erin Vance", role="Controller · finance-owned", tpl="Department · Admin & office", kind="oh",
         target=1180000, plan=1164500, stage=None, cur=None, when="Drafted Oct 9", note="Finance-owned, no submission"),
    dict(k="exec", name="Executive", owner="Erin Vance", role="Controller · finance-owned", tpl="Department · Executive", kind="oh",
         target=410000, plan=410000, stage=None, cur=None, when="Drafted Oct 9", note="Finance-owned, no submission"),
]
CY_REV_T = sum(c["target"] for c in CYCLE if c["kind"] == "rev")
CY_REV_P = sum(c["plan"] for c in CYCLE if c["kind"] == "rev")
CY_OH_T = sum(c["target"] for c in CYCLE if c["kind"] == "oh")
CY_OH_P = sum(c["plan"] for c in CYCLE if c["kind"] == "oh")
assert CY_REV_T == 17450000 and CY_OH_T == 2370000
IN = sum(1 for c in CYCLE if c["stage"] is not None and c["stage"] >= 1)
assert IN == 3  # S23 widget: "3 of 4 departments in"

# Install template (F1 side panel) — recommended lines, drivers, and where each driver comes from.
INSTALL_TPL = [
    ("Revenue", [("Replacement installs", "installs × average job", "Buildertrend backlog + ServiceTitan pipeline"),
                 ("New-construction installs", "homes × contract per home", "Builder contracts"),
                 ("Add-ons · IAQ, thermostats", "installs × attach rate × average add-on", "ServiceTitan invoices")]),
    ("Cost of revenue", [("Equipment", "install revenue × equipment %", "GL 5100 ÷ 4100, trailing 6 months"),
                         ("Materials & supplies", "installs × cost per install", "GL 5200"),
                         ("Install labor", "crew hours × loaded rate", "Payroll register"),
                         ("Permits & disposal", "installs × cost per install", "GL 5250"),
                         ("Subcontract · electrical, duct", "% of installs × average sub", "GL 5400")]),
    ("Department spend", [("Install manager & coordinators", "headcount plan", "Payroll · 3 people"),
                          ("Trucks & fuel", "trucks × monthly cost", "Fleet · 9 trucks"),
                          ("Warranty reserve", "install revenue × 1.5%", "Policy")]),
]

# Upload mapping (F1 frame 2): Brent's workbook, monthly layout.
UPLOAD_ROWS = [  # file label, mapped account, confidence, annual
    ("Replacement installs", "4100 · Install revenue — replacement", 98, 8124000),
    ("New construction", "4110 · Install revenue — new construction", 96, 1068000),
    ("IAQ add-ons", "4120 · Install revenue — add-ons", 91, 420000),
    ("Equipment", "5100 · Equipment", 99, 4421600),
    ("Materials", "5200 · Materials & supplies", 97, 1152000),
    ("Install labor", "5300 · Install labor", 95, 2304000),
    ("Duct cleaning subs", None, 64, 186000),
    ("Permits/haul-away", None, 58, 96000),
]
UP_REV = sum(r[3] for r in UPLOAD_ROWS[:3])
UP_COST = sum(r[3] for r in UPLOAD_ROWS[3:])
assert UP_REV == 9612000

# ---------------------------------------------------------------- Group September EBITDA bridge, by client (F2)
MEMBERS = [c for c in CLIENTS if c["member"]]
G_EB_BUD = G["ebitda_bud"]
G_EB_ACT = G["ebitda"]
CL_BRIDGE = sorted([(c["name"], c["ebitda"] - c["ebitda_bud"], c["key"]) for c in MEMBERS], key=lambda x: x[1])
assert G_EB_BUD + sum(v for _, v, _ in CL_BRIDGE) == G_EB_ACT

# Group revenue by month FY 2026 (forecast layers chart, F2). Net of intercompany fees.
TOT_YTD, TOT_COM, TOT_EST, TOT_BUD = 79711000, 15799200, 11038740, 108476000  # = S23 TOT
MO_W = [7.6, 7.2, 8.1, 8.6, 9.2, 9.6, 9.9, 9.8]
_rest = TOT_YTD - G["rev"]
MO_ACT = [round(_rest * w / sum(MO_W) / 100) * 100 for w in MO_W]
MO_ACT[-1] += _rest - sum(MO_ACT)
MO_ACT.append(G["rev"])
MO_COM = [6912000, 5104200, 3783000]
MO_EST = [2541740, 3784000, 4713000]
MO_BUD_W = [7.4, 7.0, 8.0, 8.5, 9.0, 9.5, 9.8, 9.7, 9.95, 9.4, 8.9, 8.2]
MO_BUD = [round(TOT_BUD * w / sum(MO_BUD_W) / 100) * 100 for w in MO_BUD_W]
MO_BUD[-1] += TOT_BUD - sum(MO_BUD)
assert sum(MO_ACT) == TOT_YTD and sum(MO_COM) == TOT_COM and sum(MO_EST) == TOT_EST and sum(MO_BUD) == TOT_BUD
BAND = [0.08, 0.12, 0.16]  # estimated layer, p10-p90 half-width as share of estimated

# Group scenarios, FY 2027 (F2). Deltas against plan v1 of the FY 2027 budget.
SC_BASE = dict(rev=114200000, eb=8640000, cash=6120000, dscr=1.71)
SCEN = [("Carrier +6% in January", "Heartland, Metro, Dorrian · pass half through", dict(rev=412000, eb=-418000, cash=-352000, dscr=-0.07)),
        ("Housing starts −15%", "Artistry and Iowa Custom Cabinets · from Q2", dict(rev=-5260000, eb=-781000, cash=-604000, dscr=-0.16)),
        ("Prime +100 bps all year", "Variable debt · 31.4M", dict(rev=0, eb=0, cash=-314000, dscr=-0.11))]

# HVAC KPIs (F2). Sep 2026 unless noted. Peer quartiles: opt-in MeritBooks peers (sample, not a published source).
HVAC_KPI = [
    # label, unit, heartland, metro, dorrian, p25, p50, p75, higher_is_better
    ("Gross margin", "%", H["gp"] / H["rev"] * 100, BY["metro"]["gp"] / BY["metro"]["rev"] * 100, BY["dorrian"]["gp"] / BY["dorrian"]["rev"] * 100, 19.0, 24.0, 29.0, True),
    ("EBITDA margin", "%", H["ebitda"] / H["rev"] * 100, BY["metro"]["ebitda"] / BY["metro"]["rev"] * 100, BY["dorrian"]["ebitda"] / BY["dorrian"]["rev"] * 100, 4.0, 8.0, 12.0, True),
    ("Average service ticket", "$", 237, 262, 214, 220, 255, 290, True),
    ("Install close rate", "%", 41.0, 46.0, 33.0, 35.0, 42.0, 50.0, True),
    ("Equipment % of install", "%", 49.1, 46.2, 50.4, 52.0, 47.0, 43.0, False),
    ("Revenue per technician, annualized", "$k", 509, 488, 402, 380, 450, 520, True),
    ("Agreement renewal rate", "%", 78.0, 82.0, 64.0, 65.0, 74.0, 82.0, True),
    ("Callback rate", "%", 3.1, 2.4, 5.2, 5.0, 3.5, 2.5, False),
]

if __name__ == "__main__":
    print("REV", REV, "GP", GP, "OH", OH, "EB", EB)
    print("BRIDGE", BRIDGE)
    print("cycle", CY_REV_T, CY_REV_P, CY_OH_T, CY_OH_P)
    print("group bridge", CL_BRIDGE, G_EB_BUD, G_EB_ACT)
    print("mo act", MO_ACT)
    for k in HVAC_KPI: print(k[0], [round(x, 1) for x in k[2:5]])
