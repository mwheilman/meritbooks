"""Sample data for S6 / S6b / S6c / S9. One source so every screen ties.

Merit Management Group is a firm-type tenant with 13 clients. The group
"Merit Management Group — Consolidated" = Merit Management Group LLC (own
books, consolidator) + the 8 operating companies it owns. Heritage, Clive,
Swan Creek and Wild Rose are owned through the funds, so they sit outside it.
All amounts whole dollars unless noted. September 2026 is closing (day 12/15).
"""

# key: (name, number, member, rev_sep, rev_bud, rev_aug, gp_sep, gp_aug, gp_bud,
#       ebitda_sep, ebitda_bud, cash_today, cash_sep30, close, step, preparer)
_C = [
    ("mmg", "Merit Management Group LLC", "C-100", True, 312000, 312000, 312000, 312000, 312000, 312000, 41200, 38000, 812300, 798750, "closed", "Closed Oct 9", "Priya Natarajan"),
    ("heartland", "Heartland Heating & Cooling", "C-103", True, 1612400, 1640000, 1701200, 290232, 382770, 311600, 84310, 132000, 1684610, 1598200, "closed", "Closed Oct 14", "Sam Kovac"),
    ("metro", "Metro Heating & Cooling", "C-106", True, 1148600, 1150000, 1180400, 241206, 271492, 253000, 92640, 96000, 1206240, 1171300, "closed", "Closed Oct 13", "Sam Kovac"),
    ("dorrian", "Dorrian HVAC", "C-105", True, 742500, 810000, 788900, 126225, 173558, 170100, -18420, 38000, 438115, 501880, "blocked", "Review · feed down 3 days", "Dana Lee"),
    ("crystal", "Crystal Kitchen & Bath", "C-104", True, 912400, 940000, 884300, 228100, 234340, 244400, 31600, 52000, 296430, 344100, "overdue", "Review · due Oct 16", "Dana Lee"),
    ("aim", "AIM Kitchen & Bath", "C-111", True, 1046800, 1020000, 1012500, 272168, 273375, 265200, 88400, 80000, 588960, 562150, "closed", "Closed Oct 12", "Luis Ortiz"),
    ("icc", "Iowa Custom Cabinets", "C-108", True, 1284500, 1260000, 1240800, 359660, 359832, 352800, 121950, 112000, 922310, 868900, "closed", "Closed Oct 13", "Luis Ortiz"),
    ("revived", "Revived Interiors", "C-109", True, 603200, 600000, 587600, 168896, 170404, 168000, 47800, 44000, 341205, 352600, "closed", "Closed Oct 12", "Luis Ortiz"),
    ("artistry", "Artistry Homes", "C-110", True, 1986000, 2030000, 1871700, None, None, None, None, 87600, None, None, "closed", "Closed Oct 15", "Priya Natarajan"),
    ("clive", "Clive Power Equipment", "C-102", False, 1248500, 1200000, 1301200, 312125, 313589, 306000, 96300, 84000, 615400, 588200, "risk", "Review · due Oct 21", "Dana Lee"),
    ("heritage", "Heritage Interiors", "C-101", False, 884300, 910000, 862400, 247604, 246646, 259350, 61250, 70000, 344180, 371900, "track", "Check · due Oct 23", "Dana Lee"),
    ("swan", "Swan Creek", "C-107", False, 96400, 96400, 96400, 61700, 60925, 61696, 52900, 51000, 377050, 362400, "track", "Reconcile · due Oct 21", "Dana Lee"),
    ("wildrose", "Wild Rose Interiors", "C-112", False, 412700, 400000, 398100, 111429, 105098, 106000, 24180, 21000, 166920, 171300, "ready", "Ready for review", "Dana Lee"),
]
KEYS = ["key", "name", "num", "member", "rev", "rev_bud", "rev_aug", "gp", "gp_aug", "gp_bud",
        "ebitda", "ebitda_bud", "cash", "cash_sep30", "close", "step", "preparer"]
CLIENTS = [dict(zip(KEYS, r)) for r in _C]
BY = {c["key"]: c for c in CLIENTS}

# Group (consolidated) targets — match components.html / S7
G = dict(rev_pre=9648400, rev_pre_aug=9579400, rev_pre_bud=9762000, elim=312000,
         gp=2021559, gp_aug=2222950, gp_bud=2204600,
         oi=306659, oi_aug=528050, oi_bud=489600,
         da=188400, da_aug=186900, da_bud=190000,
         cash=8411220, cash_sep30=7799186, net_debt=14862400, net_debt_sep30=15075000)
G["rev"] = G["rev_pre"] - G["elim"]
G["rev_aug"] = G["rev_pre_aug"] - G["elim"]
G["rev_bud"] = G["rev_pre_bud"] - G["elim"]
G["ebitda"] = G["oi"] + G["da"]
G["ebitda_aug"] = G["oi_aug"] + G["da_aug"]
G["ebitda_bud"] = G["oi_bud"] + G["da_bud"]

members = [c for c in CLIENTS if c["member"]]
art = BY["artistry"]
# Artistry is the plug so the group ties to the statement
art["gp"] = G["gp"] + G["elim"] - sum(c["gp"] for c in members if c["key"] != "artistry")
art["gp_aug"] = G["gp_aug"] + G["elim"] - sum(c["gp_aug"] for c in members if c["key"] != "artistry")
art["gp_bud"] = G["gp_bud"] + G["elim"] - sum(c["gp_bud"] for c in members if c["key"] != "artistry")
art["ebitda"] = G["ebitda"] - sum(c["ebitda"] for c in members if c["key"] != "artistry")
art["cash"] = G["cash"] - sum(c["cash"] for c in members if c["key"] != "artistry")
art["cash_sep30"] = G["cash_sep30"] - sum(c["cash_sep30"] for c in members if c["key"] != "artistry")
art["ebitda_bud"] = (G["ebitda_bud"]) - sum(c["ebitda_bud"] for c in members if c["key"] != "artistry")

def S(k, cs=CLIENTS):
    return sum(c[k] for c in cs)

assert S("rev", members) == G["rev_pre"], S("rev", members)
assert S("rev_aug", members) == G["rev_pre_aug"]
assert S("rev_bud", members) == G["rev_pre_bud"]
assert S("gp", members) - G["elim"] == G["gp"]
assert S("ebitda", members) == G["ebitda"]
assert S("cash", members) == G["cash"]

# Tenant-wide, intercompany excluded (owner glance + CFO strip)
T = dict(
    rev=S("rev") - G["elim"], rev_aug=S("rev_aug") - G["elim"], rev_bud=S("rev_bud") - G["elim"],
    gp=S("gp") - G["elim"], gp_aug=S("gp_aug") - G["elim"], gp_bud=S("gp_bud") - G["elim"],
    ebitda=S("ebitda"), ebitda_bud=S("ebitda_bud"),
    cash=S("cash"), cash_sep30=S("cash_sep30"), cash_low=9146200,
    ar_overdue=1214880, ar_overdue_lw=1128470, ar_overdue_n=42,
    ap_14=2186450,
)
T["gm"] = T["gp"] / T["rev"] * 100
T["gm_aug"] = T["gp_aug"] / T["rev_aug"] * 100
T["gm_bud"] = T["gp_bud"] / T["rev_bud"] * 100

# Receivables aging, intercompany excluded
AR = [("Current", 6778520), ("1–30 days past due", 702330), ("31–60 days", 248620), ("61–90 days", 179800), ("Over 90 days", 84130)]
assert sum(v for _, v in AR[1:]) == T["ar_overdue"]
AP = [("Due in the next 14 days", 2186450), ("Due in 15–30 days", 1402300), ("Past due", 96240)]
assert AP[0][1] == T["ap_14"]

# Payment run awaiting Mike (owner) approval — Heartland
RUN = [("Ferguson Enterprises", 3, 62418.20), ("Johnstone Supply", 2, 41206.75), ("Carrier Enterprise", 1, 38950.00),
       ("Winsupply", 2, 17284.40), ("Grainger", 2, 9812.65), ("4 other vendors", 4, 16748.55)]
RUN_TOTAL = round(sum(v for *_, v in RUN), 2)
assert abs(RUN_TOTAL - 186420.55) < .001
assert sum(n for _, n, _ in RUN) == 14
RUN_BAL = 1061330.18
RUN_AFTER = round(RUN_BAL - RUN_TOTAL, 2)

ELIM = [("Heating and cooling, 3 × 39,000", 117000), ("Kitchen, bath, cabinets, 4 × 39,000", 156000), ("Artistry Homes, 1 × 39,000", 39000)]
assert sum(v for _, v in ELIM) == G["elim"]

if __name__ == "__main__":
    for c in CLIENTS:
        print(f'{c["name"]:30} rev {c["rev"]:>10,} gp {c["gp"]:>9,} {c["gp"]/c["rev"]*100:5.1f}% aug {c["gp_aug"]/c["rev_aug"]*100:5.1f}% eb {c["ebitda"]:>9,} bud {c["ebitda_bud"]:>8,} cash {c["cash"]:>10,} {c["cash_sep30"]:>10,}')
    print(T)
    print(G)
