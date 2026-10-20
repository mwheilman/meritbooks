"""V2 — Vendor portal, 390 first (FPB-vendor-compliance-chase §5.3). Iowa Roofing Pros answers Artistry Homes'
welcome request: fill-here W-9, COI upload, the AI read shown back against Artistry's requirements, fix sent to the agent."""
from wf_common import *
from s21 import CSS as S21CSS, status_bar, phone

CSS = S21CSS + """
/* V2 layout only */
.vtop{display:flex;align-items:center;gap:12px;height:56px;padding:0 20px;flex:none;border-bottom:1px solid var(--line)}
.vtop .mk{display:grid;place-items:center;width:32px;height:32px;background:var(--midnight);color:var(--warm);font:700 12px/16px var(--f-display);letter-spacing:.02em}
.vtop b{font-weight:600;display:block;line-height:20px}
.vtop .t-cap{display:block}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-top:4px}
.steps i{display:block;height:4px;background:var(--line-2)}
.steps i.on{background:var(--electric)}
.need{list-style:none;margin-top:12px;border-top:1px solid var(--electric)}
.need li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:center;padding:14px 0;border-bottom:1px solid var(--line)}
.need .m{font-weight:600}
.need .s{grid-column:1/-1;font-size:12px;line-height:16px;color:var(--ink-3)}
.need .go{grid-column:1/-1}
.need .go .btn{width:100%;height:48px;font-size:15px}
.reqs{list-style:none;margin-top:8px;font-size:13px;line-height:20px}
.reqs li{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--line)}
.reqs li b{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.radio-m{display:flex;align-items:center;min-height:48px;width:100%;border-bottom:1px solid var(--line)}
.tin{display:flex;gap:8px;align-items:center}
.tin .input{letter-spacing:.12em;font-variant-numeric:tabular-nums}
.tin .btn{height:48px;flex:none}
.cert{margin-top:12px;padding:12px 14px;background:var(--canvas);font-size:12px;line-height:16px;color:var(--ink-2)}
.pad-s{position:relative;margin-top:12px;height:132px;background:var(--white);border:1px solid var(--line-2)}
.pad-s svg{position:absolute;left:24px;top:22px}
.pad-s .ln{position:absolute;left:20px;right:20px;bottom:28px;height:1px;background:var(--ink-3)}
.pad-s .x{position:absolute;left:20px;bottom:32px;font-weight:600;color:var(--ink-3)}
.pad-s .clr{position:absolute;right:8px;top:8px;height:44px}
.pad-s .who{position:absolute;left:20px;bottom:6px;font-size:12px;line-height:16px;color:var(--ink-3)}
/* signature: the read-back — every value beside the crop it came from */
.rb{list-style:none;margin-top:12px}
.rb li{display:grid;grid-template-columns:124px minmax(0,1fr) 24px;gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}
.crop{position:relative;height:50px;background:var(--white);border:1px solid var(--line-2);padding:5px 7px;overflow:hidden;font-size:12px;line-height:14px;color:var(--ink-3)}
.crop i{display:block;height:3px;background:var(--grey-200);margin:2px 0}
.crop u{display:block;text-decoration:none;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums;box-shadow:inset 0 0 0 1.5px var(--electric);background:var(--sky);padding:1px 3px;margin-top:2px;white-space:nowrap}
.crop.bad u{box-shadow:inset 0 0 0 1.5px var(--neg);background:var(--neg-wash)}
.rb .k{display:block;font-size:12px;line-height:16px;color:var(--ink-3)}
.rb .v{display:block;font-weight:600;font-variant-numeric:tabular-nums}
.rb .v.neg{color:var(--neg)}
.rb .st{display:grid;place-items:center;width:24px;height:24px}
.rb .st.ok{color:var(--pos)}
.rb .st.no{color:var(--neg)}
.fix{margin-top:12px;padding:12px 14px;background:var(--neg-wash);box-shadow:inset 3px 0 var(--neg);font-size:13px;line-height:20px;color:var(--ink)}
.fix b{font-weight:600}
.sw-row{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:56px;border-bottom:1px solid var(--line)}
.sw-row span{font-size:13px;line-height:20px}
.st-list{list-style:none;margin-top:12px}
.st-list li{display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;padding:10px 0;border-bottom:1px solid var(--line)}
.st-list .ic{display:grid;place-items:center;width:24px;height:24px;border:1.5px solid var(--pos);color:var(--pos)}
.st-list .ic.wait{border-color:var(--electric);color:var(--electric)}
.st-list b{font-weight:600;display:block}
.st-list span.s{font-size:12px;line-height:16px;color:var(--ink-3)}
.uplink{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.uplink .btn{height:56px;font-size:15px}
.agent{display:grid;grid-template-columns:40px minmax(0,1fr);gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}
.agent .av{display:grid;place-items:center;width:40px;height:40px;background:var(--canvas);font-weight:600}
"""

VENDOR, CONTACT, CLIENT = "Iowa Roofing Pros LLC", "Nate Hollis", "Artistry Homes"


def vtop(step=None):
    st = ""
    if step is not None:
        st = '<div class="steps" aria-hidden="true">' + "".join(f'<i class="{"on" if j < step else ""}"></i>' for j in range(3)) + "</div>"
    return (f'<div class="vtop"><span class="mk" aria-hidden="true">AH</span><span style="flex:1;min-width:0"><b>{CLIENT}</b>'
            f'<span class="t-cap">Documents for {VENDOR}</span>{st}</span><span class="t-cap" style="text-align:right">Secure link<br>no sign-in</span></div>')


def p_sms():
    inner = status_bar("12:06") + f"""<div class="lock-time">12:06</div><div class="lock-date">Tuesday, October 20</div>
<div class="notif"><div class="notif-top"><span>Messages · {CLIENT}</span><span>7:02 AM</span></div>
<b>2 documents needed before your first payment</b><p>{CLIENT} added {VENDOR} as a subcontractor. Send your W-9 and insurance certificate, about 3 minutes: mbks.co/v/Q4m9</p></div>
<div class="notif old"><div class="notif-top"><span>Mail · ap@artistryhomes.mbks.co</span><span>7:02 AM</span></div>
<b>Welcome, and what we need from you</b><p>Requirement sheet attached (PDF). You can forward it to your insurance agent.</p></div>
<div class="lock-quiet">{ico("moon")}<span>Texts only between 7:00 AM and 8:00 PM, weekdays. Reply STOP and you’ll get email only.</span></div>
<div class="lock-foot"><span>Swipe to open</span><span>Sent for {CLIENT}</span></div>"""
    return phone(inner, "lock", "Lock screen with the welcome text")


def p_open():
    inner = status_bar("12:06") + vtop() + f"""<div class="ph-body"><p class="ph-p" style="margin-top:0"><b class="ink">Nate</b>, {CLIENT} needs two things on file before it can pay {VENDOR}.</p>
<ul class="need" aria-label="What’s needed">
<li><span class="m">W-9</span><span class="t-cap">2 min</span><span class="s">Fill it in here and sign with your finger, or upload a signed one.</span><span class="go"><button class="btn btn--primary" type="button">Start W-9</button></span></li>
<li><span class="m">Certificate of insurance</span><span class="t-cap">1 min</span><span class="s">Upload yours, or send the request straight to your insurance agent.</span>
<ul class="reqs" style="grid-column:1/-1" aria-label="What the certificate must show"><li><span>General liability</span><b>1,000,000 / 2,000,000</b></li><li><span>Auto</span><b>1,000,000</b></li><li><span>Workers’ comp</span><b>Statutory · EL 500,000</b></li><li><span>Umbrella</span><b>2,000,000</b></li><li><span>Endorsements</span><b>AI · waiver · primary</b></li></ul>
<span class="go" style="margin-top:4px"><button class="btn" type="button">Add certificate</button></span></li></ul></div>
<div class="ph-foot" style="padding-top:8px"><p class="ph-legal" style="margin-top:0">Requested by Priya Natarajan for {CLIENT} · questions? Reply to the text</p></div>"""
    return phone(inner, "", "What's needed")


def p_w9():
    inner = status_bar("12:07") + vtop(1) + f"""<div class="ph-body"><h1 class="ph-h ink" style="margin-top:0">W-9 · who gets paid</h1>
<div class="field field-m" style="margin-top:12px"><label class="field-label" for="ln">Legal name (line 1, as on your tax return)</label><input class="input" id="ln" value="Iowa Roofing Pros LLC"></div>
<div class="field field-m" style="margin-top:12px"><label class="field-label" for="dba">Business name, if different</label><input class="input" id="dba" placeholder="Leave blank if the same"></div>
<p class="field-label" style="margin-top:12px">Federal tax classification</p>
<div role="radiogroup" aria-label="Tax classification"><label class="radio radio-m"><input type="radio" name="tc"><i></i>Individual or sole proprietor</label>
<label class="radio radio-m"><input type="radio" name="tc" checked><i></i>LLC taxed as an S corporation</label><label class="radio radio-m"><input type="radio" name="tc"><i></i>Other LLC, corporation, partnership…</label></div>
<div class="field field-m" style="margin-top:12px"><label class="field-label" for="tin">EIN</label><div class="tin"><input class="input" id="tin" value="•• – ••• 4417" inputmode="numeric" aria-describedby="tin-h"><button class="btn" type="button" aria-label="Show EIN">{ico("eye")}</button></div>
<span class="field-help" id="tin-h">Checked with the IRS after you sign. Never shown in full again.</span></div></div>
<div class="ph-foot"><button class="btn btn--primary" type="button">Next · address and sign</button></div>"""
    return phone(inner, "", "Fill-here W-9")


SIG = ('<svg width="250" height="64" viewBox="0 0 250 64" aria-hidden="true"><path d="M6 46c10-22 18-36 22-30s-8 34-2 34 14-30 22-30-6 26 2 26 12-18 18-18 0 14 6 14 10-10 16-10 2 8 8 8 '
       '18-14 26-14 4 10 12 10 30-6 46-12 30-4 50-6" fill="none" stroke="#0A1628" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>')


def p_sign():
    inner = status_bar("12:09") + vtop(2) + f"""<div class="ph-body"><h1 class="ph-h ink" style="margin-top:0">Check and sign</h1>
<ul class="reqs" aria-label="Your W-9"><li><span>Name</span><b>Iowa Roofing Pros LLC</b></li><li><span>Classification</span><b>LLC · S corporation</b></li><li><span>EIN</span><b>•• – ••• 4417</b></li><li><span>Address</span><b>1840 NE 66th Ave, Altoona IA</b></li><li><span>Backup withholding</span><b>Not subject</b></li></ul>
<div class="cert"><b class="ink">Under penalties of perjury, I certify that</b> the number shown is my correct taxpayer identification number, I am not subject to backup withholding, I am a U.S. person, and the FATCA code entered (if any) is correct.</div>
<div class="pad-s" aria-label="Signature pad, signed">{SIG}<span class="x" aria-hidden="true">×</span><span class="ln" aria-hidden="true"></span><span class="who">Nate Hollis · Owner · Oct 20, 2026</span><button class="btn btn--quiet clr" type="button">Clear</button></div></div>
<div class="ph-foot"><button class="btn btn--primary" type="button">Sign and send W-9</button><p class="ph-legal">Makes a signed IRS Form W-9 (Rev. March 2024) PDF · a copy is emailed to you</p></div>"""
    return phone(inner, "", "Sign the W-9")


def p_coi():
    inner = status_bar("12:10") + vtop() + f"""<div class="ph-body"><span class="ok-mark">{ico("check", 20)}</span><p class="ph-p">W-9 received. One left.</p>
<h1 class="ph-h ink">Certificate of insurance</h1><p class="ph-p">Holder must read <b class="ink">Artistry Homes LLC, 4100 Westown Pkwy, Ste 200, West Des Moines IA 50266</b>. Add the endorsement pages if you have them.</p>
<div class="uplink"><button class="btn btn--primary" type="button">{ico("camera")}Take photos</button><button class="btn" type="button">{ico("upload")}Choose file</button></div>
<button class="btn big" type="button" style="margin-top:8px;height:52px">{ico("forward")}Send this to my insurance agent</button>
<div class="hint">{ico("info")}<span><b>Don’t have it handy?</b> Your agent issues certificates. We’ll send them Artistry’s requirement sheet and a link of their own, and copy you.</span></div></div>
<div class="ph-foot" style="padding-top:8px"><p class="ph-legal" style="margin-top:0">PDF, JPG or PNG · up to 15 MB · several pages is fine</p></div>"""
    return phone(inner, "", "Certificate: upload or send to agent")


def crop(lbl, val, bad=False):
    return f'<span class="crop{" bad" if bad else ""}" aria-hidden="true">{lbl}<i style="width:80%"></i><u>{val}</u></span>'


def p_readback():
    rows = [("General liability", "1,000,000 / 2,000,000", "COMMERCIAL GL", "1,000,000", False),
            ("Workers’ comp", "Statutory · EL 500,000", "WORKERS COMP", "E.L. 500,000", False),
            ("Umbrella", "1,000,000 · needs 2,000,000", "UMBRELLA LIAB", "1,000,000", True),
            ("Certificate holder", "Artistry Homes LLC · exact", "CERT HOLDER", "Artistry Homes", False),
            ("Endorsement pages", "3 pages · AI, waiver, primary", "CG 20 10 04 13", "ADDL INSURED", False)]
    lis = ""
    for k, v, cl, cv, bad in rows:
        st = f'<span class="st no" role="img" aria-label="Doesn’t meet">{ico("x", 18)}</span>' if bad else f'<span class="st ok" role="img" aria-label="Meets">{ico("check", 18)}</span>'
        lis += f'<li>{crop(cl, cv, bad)}<span><span class="k">{k}</span><span class="v{" neg" if bad else ""}">{v}</span></span>{st}</li>'
    inner = status_bar("12:11") + vtop() + f"""<div class="ph-body"><h1 class="ph-h ink" style="margin-top:0">Here’s what we read</h1><p class="ph-p">From your 4 pages, each beside where we found it. Auto matched too.</p>
<ul class="rb" aria-label="Read from your certificate">{lis}</ul>
<div class="fix"><b>One thing to fix:</b> Artistry needs a 2,000,000 umbrella. Yours is 1,000,000. Your agent can raise it or add Artistry to a larger policy.</div></div>
<div class="ph-foot"><button class="btn btn--primary" type="button">Send the fix to my agent</button><button class="btn" type="button">Upload a different certificate</button></div>"""
    return phone(inner, "", "The read, shown back")


def p_agent():
    inner = status_bar("12:12") + vtop() + f"""<div class="ph-body"><h1 class="ph-h ink" style="margin-top:0">Send to your agent</h1>
<div class="agent"><span class="av" aria-hidden="true">TG</span><span><b>Tasha Greer</b><br><span class="t-cap">Raccoon River Insurance · from your certificate</span></span></div>
<div class="field field-m" style="margin-top:12px"><label class="field-label" for="ae">Agent’s email</label><input class="input" id="ae" value="tasha.greer@raccoonriverins.com"></div>
<div class="msg" style="margin-top:12px;padding:12px 14px;background:var(--canvas);box-shadow:inset 3px 0 var(--electric);font-size:13px;line-height:20px">
<span class="eyebrow">What Tasha gets</span><p style="margin-top:4px">Nate Hollis at Iowa Roofing Pros asked us to send this. Artistry Homes needs the umbrella on certificate #A-2210 raised to 2,000,000, holder unchanged. Requirement sheet attached. Upload the new certificate here: a link of your own.</p></div>
<label class="check" style="margin-top:12px;min-height:44px"><input type="checkbox" checked><i></i>Copy me on the email</label></div>
<div class="ph-foot"><button class="btn btn--primary" type="button">Send to Tasha</button></div>"""
    return phone(inner, "", "Send the fix to the agent")


def p_done():
    inner = status_bar("12:13") + vtop() + f"""<div class="ph-body"><span class="ok-mark">{ico("check", 20)}</span><h1 class="ph-h ink">Thanks, Nate. You’re nearly done.</h1>
<ul class="st-list" aria-label="Where things stand"><li><span class="ic">{ico("check")}</span><span><b>W-9 signed</b><span class="s">IRS check runs today · Priya at Merit reviews it this afternoon</span></span></li>
<li><span class="ic wait">{ico("mail")}</span><span><b>Certificate · waiting on Tasha Greer</b><span class="s">Umbrella to 2,000,000. We’ll remind Tasha Friday and tell you when it’s in.</span></span></li>
<li><span class="ic wait">{ico("calendar")}</span><span><b>Renewal reminder</b><span class="s">Your policies renew Mar 1, 2027. We’ll ask 30 days before.</span></span></li></ul>
<div class="sw-row"><span>Text me about these documents</span><label class="switch"><input type="checkbox" checked aria-label="Text me about these documents"><i></i></label></div>
<p class="t-cap" style="margin-top:8px">Texts to (515) ••• – 0193 · reply STOP anytime</p></div>
<div class="ph-foot"><button class="btn" type="button">Close</button></div>"""
    return phone(inner, "", "Done, with what's next")


def p_expired():
    inner = status_bar("4:40") + f"""<div class="vtop"><span class="mk" aria-hidden="true">AH</span><span style="flex:1"><b>{CLIENT}</b><span class="t-cap">Document request</span></span></div>
<div class="ph-body"><span class="ok-mark" style="border-color:var(--ink-3);color:var(--ink-3)">{ico("lock", 20)}</span><h1 class="ph-h ink">This link has been replaced</h1>
<p class="ph-p">For your security each link opens one request, and this one was replaced by a newer link on Oct 23. Nothing you uploaded is lost.</p>
<button class="btn btn--primary big" type="button" style="margin-top:16px">Text me the current link</button>
<button class="btn big" type="button" style="margin-top:8px;height:52px">Email it instead</button>
<p class="t-cap" style="margin-top:16px">We’ll send it to the number or email Artistry has on file for {VENDOR}. We can’t show which one here.</p></div>
<div class="ph-foot" style="padding-top:8px"><p class="ph-legal" style="margin-top:0">Need help? Call Artistry Homes accounts payable, (515) 555-0110</p></div>"""
    return phone(inner, "", "Replaced link")


def build():
    html = head("V2 · Vendor portal", CSS) + sheet_top("V2-vendor-portal-mobile.html") + '<main id="main" class="sheet">'
    html += board_h("V2", "FPB-vendor-compliance-chase §5.3 portal · §6 TIN · M-7 vendor_document",
                    "Nate’s phone: two documents in four minutes, read back before he leaves",
                    f"Nate Hollis owns {VENDOR}, added by {CLIENT} this morning. The welcome text opens one link, no sign-in. He fills the W-9 on the phone instead of hunting for a PDF, "
                    "uploads his certificate, and sees exactly what was read and the one thing that falls short, then sends that fix to his agent in one tap. 390 wide, 44px targets, 15px text.", "390 × 844")
    caps = [("1", "The welcome text", "7:02 AM · quiet hours and STOP stated"),
            ("2", "What’s needed", "Artistry’s requirements in plain numbers"),
            ("3", "W-9, filled here", "no PDF, TIN masked"),
            ("4", "Check and sign", "the IRS certification, signed with a finger"),
            ("5", "Certificate", "upload, or hand it to the agent"),
            ("6", "What we read", "every value beside its crop · the signature"),
            ("7", "The fix goes to the agent", "producer taken from the certificate"),
            ("8", "Done, and what’s next", "status, SMS opt-in, renewal date"),
            ("9", "Replaced link", "a safe dead end, never a 404")]
    phones = [p_sms(), p_open(), p_w9(), p_sign(), p_coi(), p_readback(), p_agent(), p_done(), p_expired()]
    html += '<div class="phones">'
    for (no, t, c), ph in zip(caps, phones):
        html += phone_grid_cell(no, t, c, ph)
    html += "</div>"
    html += anno([("Fill, don’t find", "Most vendors can’t find last year’s W-9. Filling it here makes a signed IRS form, and the TIN is typed, never photographed, so it never goes to a model."),
                  ("The read is shown back", "Each value sits beside the crop it came from. A vendor can fix what they typed, not what their insurer printed: for a certificate the only fix is a new one."),
                  ("Short is specific", "“Umbrella 1,000,000, needs 2,000,000” is a sentence an agent can act on. “Non-compliant” is not. The agent gets the same sentence."),
                  ("Ties to V1", "This is the Iowa Roofing Pros row on Priya’s desk: welcome request, link opened 8:15 AM, held bill B-1190. After this flow the W-9 cell turns to review, umbrella stays not met.")])
    html += foot()
    return html


if __name__ == "__main__":
    open("../V2-vendor-portal-mobile.html", "w").write(build())
    print("ok")
