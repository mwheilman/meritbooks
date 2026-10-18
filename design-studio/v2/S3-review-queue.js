/* S3 review queue: sample data (Clive Power Equipment, September) and the queue/panel/composer behaviour. */
(function(){
var D=[{"id":"d1","date":"Sep 25","payee":"Check 10482","raw":"CHECK 10482","src":"Farmers State ••2210","k":"bank","amt":-1950.0,"conf":12,"code":"","acct":"AI asks: who was it paid to?","l2":"No check image from the bank · uncategorized","m":["none","No match"],"q":true,"band":"decide","p":{"t":"No code yet. Only Rob can say who check 10482 paid.","why":[["Farmers State sent no image for check 10482, so there is <b>no payee</b>.",0],["Clive’s last 40 checks went to 6 payees. None was for <b>1,950.00</b>.",0],["Nothing in the AP inbox or open bills matches the amount.",1]],"basis":"No evidence to code from","rec":[["5110",22],["5200",4],["3200",2]]},"bank":["1010","Farmers State ••2210"]},
{"id":"d2","date":"Sep 28","payee":"Venmo · J. Ortega","raw":"VENMO PAYMENT 1023884","src":"Farmers State ••2210","k":"bank","amt":-4812.0,"conf":22,"code":"","acct":"AI asks: subcontractor or owner draw?","l2":"Asked Rob Hartley 4 days ago · blocks close","m":["none","No match"],"q":true,"asked":true,"band":"decide","p":{"t":"No code yet. Waiting on Rob since Oct 15.","why":[["<b>J. Ortega</b> is a person, not a business, and isn’t a vendor.",0],["Two earlier Venmo payments to him were coded 5200 Contract labor.",0],["Rob was asked on Oct 15 and reminded once. This blocks close.",1]],"basis":"Request open · 4 days","rec":[["5200",2],["3200",1],["6999",1]]},"bank":["1010","Farmers State ••2210"]},
{"id":"d3","date":"Sep 14","payee":"Grainger","raw":"GRAINGER 1149302","src":"Ramp ••4410 · Tom Becker","k":"ramp","amt":-486.12,"conf":35,"code":"","acct":"Possible duplicate","l2":"Same card, amount, day as 11:02 AM","m":["dup","Duplicate?"],"band":"decide","p":{"t":"Likely a duplicate of the 11:02 AM Grainger charge","why":[["Same card <b>••4410</b>, same amount <b>486.12</b>, same day, 9 minutes apart.",0],["Grainger sent one receipt, order 1149302, for 486.12.",0],["Could be a second order of the same part. Tom’s Ramp memo is empty.",1]],"basis":"Duplicate check EC-1","rec":[["5110",31],["6420",6],["5120",2]]},"bank":["2150","Ramp card payable"]},
{"id":"d4","date":"Sep 22","payee":"Stihl Inc.","raw":"STIHL INC CO-OP CREDIT","src":"Farmers State ••2210","k":"bank","amt":2140.0,"conf":41,"code":"4910","acct":"Vendor rebates","l2":"Returned by Jordan Smith · posted to 5110","m":["none","No match"],"ret":true,"band":"decide","p":{"t":"4910 Vendor rebates, per Jordan Smith","why":[["Jordan returned it Oct 16: a <b>co-op advertising rebate</b>, not a parts credit.",0],["Stihl paid co-op credits in March and June. Both went to 5110.",0],["Reclassing moves <b>2,140.00</b> out of parts inventory.",1]],"basis":"Reviewer instruction","rec":[["4910",0],["5110",18],["2010",41]]},"bank":["1010","Farmers State ••2210"]},
{"id":"d5","date":"Sep 19","payee":"Amazon Business","raw":"AMZN Mktp US*2K4T19","src":"Ramp ••4417 · Kyle Meyer","k":"ramp","amt":-643.18,"conf":48,"code":"6420","acct":"Shop supplies","l2":"Receipt mixes shop supplies and a tablet","m":["receipt","Ramp receipt"],"band":"decide","p":{"t":"6420 Shop supplies, but the cart is mixed","why":[["Kyle coded it <b>Shop supplies</b> in Ramp. That’s a signal, not the answer.",0],["The receipt lists 7 items. One is a <b>Fire HD 10 tablet, 119.99</b>.",0],["Only Rob can say whether the tablet is for the shop counter.",1]],"basis":"Ramp coding + receipt lines","rec":[["6420",52],["5110",9],["3200",3]]},"bank":["2150","Ramp card payable"]},
{"id":"d6","date":"Sep 24","payee":"Justin’s Steakhouse","raw":"SQ *JUSTINS STEAKHOUSE","src":"Ramp ••4402 · Rob Hartley","k":"ramp","amt":-418.6,"conf":52,"code":"6610","acct":"Meals · customers","l2":"No attendees on the receipt","m":["receipt","Ramp receipt"],"band":"decide","p":{"t":"6610 Meals · customers, if Rob names the guests","why":[["Rob’s card, Thursday 7:40 PM, <b>418.60</b> with tip.",0],["Customer meals need attendees to be deductible.",0],["The receipt shows no names.",1]],"basis":"Cardholder + time of day","rec":[["6610",14],["6615",5],["3200",1]]},"bank":["2150","Ramp card payable"]},
{"id":"c1","date":"Sep 21","payee":"Fastenal","raw":"FASTENAL CO01 IAANK","src":"Ramp ••4410 · Tom Becker","k":"ramp","amt":-318.9,"conf":72,"code":"5110","acct":"Parts inventory","l2":"Or 6420 Shop supplies","m":["receipt","Ramp receipt"],"band":"check","p":{"t":"5110 Parts inventory","why":[["8 of 11 Fastenal charges went to 5110.",0],["Receipt lists grade-8 bolts and hydraulic fittings.",0],["3 earlier ones went to 6420 Shop supplies.",1]],"basis":"Vendor memory + receipt","rec":[["5110",8],["6420",3],["5120",1]]},"bank":["2150","Ramp card payable"]},
{"id":"c2","date":"Sep 28","payee":"Kubota Credit Corp.","raw":"KUBOTA CREDIT ACH PMT","src":"Farmers State ••2210","k":"bank","amt":-2904.17,"conf":74,"code":"","acct":"Split · 2510 note + 7110 interest","l2":"Payment 14 of 48 · note KCC-55120","m":["sched","Loan schedule"],"band":"check","p":{"t":"Split: 2510 Note payable and 7110 Interest","why":[["<b>Payment 14 of 48</b> on note KCC-55120: 2,904.17 on the 28th, the same as the last 13.",0],["Interest from the schedule: 68,252.69 × 7.25% ÷ 12 = <b>412.36</b>.",0],["No lender statement for September yet, so the split is computed, not confirmed.",1]],"ev":[["Principal · 2510",-2491.81],["Interest · 7110",-412.36]],"basis":"Loan schedule + 13 prior payments","rec":[["2510",13],["7110",13],["1510",1]],"split":[["2510",2491.81],["7110",412.36]]},"bank":["1010","Farmers State ••2210"]},
{"id":"c3","date":"Sep 18","payee":"Harbor Freight","raw":"HARBOR FREIGHT TOOLS 512","src":"Ramp ••4417 · Kyle Meyer","k":"ramp","amt":-318.76,"conf":74,"code":"6420","acct":"Shop supplies","l2":"No receipt yet · Ramp reminded Kyle","m":["none","No receipt"],"band":"check","p":{"t":"6420 Shop supplies","why":[["Kyle coded it Shop supplies in Ramp.",0],["Harbor Freight went to 6420 9 of 10 times.",0],["No receipt yet. Ramp reminded Kyle on Oct 17.",1]],"basis":"Ramp coding + vendor memory","rec":[["6420",9],["5110",1],["6430",0]]},"bank":["2150","Ramp card payable"]},
{"id":"c4","date":"Sep 24","payee":"Mobile deposit","raw":"MOBILE DEPOSIT REF 88213","src":"Farmers State ••2210","k":"bank","amt":12480.0,"conf":76,"code":"1200","acct":"Accounts receivable","l2":"3 open invoices sum to it","m":["partial","3 invoices · confirm"],"band":"check","p":{"t":"1200 Accounts receivable, paying 3 invoices","why":[["INV-3381, INV-3390 and INV-3402 for Clive Parks &amp; Rec sum to <b>12,480.00</b>.",0],["Clive Parks pays by mailed check, deposited by phone.",0],["Open invoice INV-3377 is also 4,160.00. Confirm which three.",1]],"basis":"Open invoices","rec":[["1200",64],["4010",3],["2410",1]]},"bank":["1010","Farmers State ••2210"]},
{"id":"c5","date":"Sep 17","payee":"Farm Bureau Financial","raw":"FBL INS PREM 0917","src":"Farmers State ••2210","k":"bank","amt":-2410.0,"conf":77,"code":"1310","acct":"Prepaid insurance","l2":"Annual policy · amortize over 12","m":["none","No match"],"band":"check","p":{"t":"1310 Prepaid insurance, amortize over 12 months","why":[["Farm Bureau billed the annual policy, Oct 1 to Sep 30.",0],["Last year’s premium went to 1310 with a 12-month schedule.",0],["Could be a monthly installment instead. Check the policy.",1]],"basis":"Prior-year treatment","rec":[["1310",1],["6110",11],["2010",2]]},"bank":["1010","Farmers State ••2210"]},
{"id":"c6","date":"Sep 25","payee":"Casey’s","raw":"CASEYS #3041 CLIVE IA","src":"Ramp ••4402 · Rob Hartley","k":"ramp","amt":-96.4,"conf":79,"code":"6520","acct":"Fuel","l2":"Service truck 3","m":["receipt","Ramp receipt"],"band":"check","p":{"t":"6520 Fuel","why":[["Casey’s, 96.40, Rob’s card, “service truck 3” in the memo.",0],["Casey’s went to 6520 22 of 23 times.",0]],"basis":"Vendor memory","rec":[["6520",22],["6610",1],["6420",0]]},"bank":["2150","Ramp card payable"]},
{"id":"c7","date":"Sep 15","payee":"Iowa Workforce Development","raw":"IWD UI TAX","src":"Farmers State ••2238","k":"bank","amt":-1128.4,"conf":80,"code":"2240","acct":"State unemployment payable","l2":"Q3 return due Oct 31","m":["none","No match"],"band":"check","p":{"t":"2240 State unemployment payable","why":[["Iowa Workforce Development pulls Q2 unemployment tax in mid-September.",0],["The liability on the books is 1,128.40, matching to the cent.",0]],"basis":"Liability tie-out","rec":[["2240",6],["6650",1],["6110",0]]},"bank":["1020","Farmers State ••2238"]},
{"id":"c8","date":"Sep 29","payee":"NAPA Auto Parts","raw":"NAPA STORE 4471","src":"Ramp ••4410 · Tom Becker","k":"ramp","amt":-212.48,"conf":81,"code":"5110","acct":"Parts inventory","l2":"Work order S-2214","m":["receipt","Ramp receipt"],"band":"check","p":{"t":"5110 Parts inventory","why":[["NAPA went to 5110 14 of 15 times.",0],["Work order S-2214 is on the receipt.",0]],"basis":"Vendor memory + receipt","rec":[["5110",14],["6420",1],["5120",0]]},"bank":["2150","Ramp card payable"]},
{"id":"c9","date":"Sep 16","payee":"Sherwin-Williams","raw":"SHERWIN WILLIAMS 7012","src":"Ramp ••4417 · Kyle Meyer","k":"ramp","amt":-154.22,"conf":83,"code":"6430","acct":"Building repairs","l2":"Showroom paint","m":["receipt","Ramp receipt"],"band":"check","p":{"t":"6430 Building repairs","why":[["Showroom paint, per Kyle’s Ramp memo.",0],["First Sherwin-Williams charge in 6 months.",1]],"basis":"Ramp memo","rec":[["6430",2],["6420",1],["5120",0]]},"bank":["2150","Ramp card payable"]},
{"id":"c10","date":"Sep 30","payee":"The Home Depot Pro","raw":"THE HOME DEPOT PRO 2116","src":"Ramp ••4417 · Kyle Meyer","k":"ramp","amt":-1284.33,"conf":84,"code":"5120","acct":"Job materials","l2":"Job S-2207 · Clive Parks fleet","m":["receipt","Ramp receipt"],"band":"check","p":{"t":"5120 Job materials · job S-2207","why":[["Home Depot Pro went to 5120 17 of 20 times.",0],["Job S-2207 is the only open job using conduit.",0]],"basis":"Vendor memory + open jobs","rec":[["5120",17],["6420",3],["5110",0]]},"bank":["2150","Ramp card payable"]},
{"id":"c11","date":"Sep 23","payee":"MidAmerican Energy","raw":"MIDAMERICAN ENERGY WEB","src":"Farmers State ••2210","k":"bank","amt":-1906.55,"conf":86,"code":"6230","acct":"Utilities","l2":"22% above August","m":["none","No match"],"band":"check","p":{"t":"6230 Utilities","why":[["MidAmerican Energy has gone to 6230 every month.",0],["22% above August. September ran hot.",1]],"basis":"Vendor memory","rec":[["6230",24],["6430",0],["6420",0]]},"bank":["1010","Farmers State ••2210"]},
{"id":"c12","date":"Sep 29","payee":"Verizon Wireless","raw":"VZWRLSS*APOCC VISB","src":"Farmers State ••2210","k":"bank","amt":-687.21,"conf":88,"code":"6310","acct":"Telephone","l2":"Bill B-23019","m":["bill","Bill B-23019"],"band":"check","p":{"t":"6310 Telephone · pays bill B-23019","why":[["Verizon bill B-23019 matches to the cent.",0],["The bill hasn’t been marked paid yet.",1]],"basis":"Bill match","rec":[["6310",24],["2010",2],["6420",0]]},"bank":["1010","Farmers State ••2210"]},
{"id":"r1","date":"Sep 25","payee":"Kubota Tractor Corp.","raw":"KUBOTA TRACTOR ACH","src":"Farmers State ••2210","k":"bank","amt":-48620.0,"conf":98,"code":"2010","acct":"Accounts payable","l2":"Pays bill B-22981","m":["bill","Bill B-22981"],"band":"ready","p":{"t":"2010 Accounts payable","why":[["Pays bill B-22981.",0]],"basis":"Ready band · preselected for batch","rec":[["2010",12],["6420",0],["2010",0]]},"bank":["1010","Farmers State ••2210"]},
{"id":"r2","date":"Sep 25","payee":"Transfer to ••2238","raw":"ONLINE TRANSFER TO CHK 2238","src":"Farmers State ••2210","k":"bank","amt":-38500.0,"conf":99,"code":"1020","acct":"Payroll account","l2":"Paired with the ••2238 deposit","m":["swap","Transfer pair"],"band":"ready","p":{"t":"1020 Payroll account","why":[["Paired with the ••2238 deposit.",0]],"basis":"Ready band · preselected for batch","rec":[["1020",12],["6420",0],["2010",0]]},"bank":["1010","Farmers State ••2210"]},
{"id":"r3","date":"Sep 21","payee":"Stihl Inc.","raw":"STIHL INC DEALER ACH","src":"Farmers State ••2210","k":"bank","amt":-12406.5,"conf":97,"code":"2010","acct":"Accounts payable","l2":"Pays bill B-22957","m":["bill","Bill B-22957"],"band":"ready","p":{"t":"2010 Accounts payable","why":[["Pays bill B-22957.",0]],"basis":"Ready band · preselected for batch","rec":[["2010",12],["6420",0],["2010",0]]},"bank":["1010","Farmers State ••2210"]},
{"id":"r4","date":"Sep 18","payee":"Echo Inc.","raw":"ECHO INC ACH","src":"Farmers State ••2210","k":"bank","amt":-6412.5,"conf":96,"code":"2010","acct":"Accounts payable","l2":"Pays bill B-22940","m":["bill","Bill B-22940"],"band":"ready","p":{"t":"2010 Accounts payable","why":[["Pays bill B-22940.",0]],"basis":"Ready band · preselected for batch","rec":[["2010",12],["6420",0],["2010",0]]},"bank":["1010","Farmers State ••2210"]},
{"id":"r5","date":"Sep 30","payee":"Square deposit","raw":"SQUARE INC DEP 0930","src":"Farmers State ••2210","k":"bank","amt":3412.77,"conf":99,"code":"1050","acct":"Square clearing","l2":"Matches 41 counter sales","m":["bill","41 sales"],"band":"ready","p":{"t":"1050 Square clearing","why":[["Matches 41 counter sales.",0]],"basis":"Ready band · preselected for batch","rec":[["1050",12],["6420",0],["2010",0]]},"bank":["1010","Farmers State ••2210"]},
{"id":"r6","date":"Sep 22","payee":"Cintas","raw":"CINTAS CORP 449","src":"Farmers State ••2210","k":"bank","amt":-189.44,"conf":95,"code":"6440","acct":"Uniforms","l2":"Vendor memory · 11 of 11","m":["none","No match"],"band":"ready","p":{"t":"6440 Uniforms","why":[["Vendor memory · 11 of 11.",0]],"basis":"Ready band · preselected for batch","rec":[["6440",12],["6420",0],["2010",0]]},"bank":["1010","Farmers State ••2210"]},
{"id":"r7","date":"Sep 21","payee":"Waste Management","raw":"WM SUPERCENTER","src":"Farmers State ••2210","k":"bank","amt":-412.18,"conf":94,"code":"6250","acct":"Waste removal","l2":"Vendor memory · 9 of 9","m":["none","No match"],"band":"ready","p":{"t":"6250 Waste removal","why":[["Vendor memory · 9 of 9.",0]],"basis":"Ready band · preselected for batch","rec":[["6250",12],["6420",0],["2010",0]]},"bank":["1010","Farmers State ••2210"]},
{"id":"r8","date":"Sep 29","payee":"Amazon Business","raw":"AMZN Mktp US*7Q2LL1","src":"Ramp ••4417 · Kyle Meyer","k":"ramp","amt":-86.97,"conf":93,"code":"6420","acct":"Shop supplies","l2":"Kyle coded it the same in Ramp","m":["receipt","Ramp receipt"],"band":"ready","p":{"t":"6420 Shop supplies","why":[["Kyle coded it the same in Ramp.",0]],"basis":"Ready band · preselected for batch","rec":[["6420",12],["6420",0],["2010",0]]},"bank":["2150","Ramp card payable"]}], A={"2510": "Note payable · Kubota", "7110": "Interest expense", "1510": "Equipment", "4910": "Vendor rebates", "5110": "Parts inventory", "6420": "Shop supplies", "6610": "Meals · customers", "6615": "Meals · staff", "3200": "Owner draws", "5200": "Contract labor", "2010": "Accounts payable", "1200": "Accounts receivable", "1310": "Prepaid insurance", "6520": "Fuel", "2240": "State unemployment payable", "6430": "Building repairs", "5120": "Job materials", "6230": "Utilities", "6310": "Telephone", "1020": "Payroll account", "1050": "Square clearing", "6440": "Uniforms", "6250": "Waste removal", "6110": "Insurance expense", "6999": "Ask My Accountant", "4010": "Equipment sales", "2410": "Customer deposits", "6650": "Payroll fees", "2150": "Ramp card payable"};
function money(v){var s=Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});return v<0?'('+s+')':s+'<span class="hp">)</span>';}
function moneyP(v){var s=Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});return v<0?'('+s+')':s;}
function ico(n,c){return '<svg class="ico'+(c?' '+c:'')+'" width="16" height="16" aria-hidden="true"><use href="#i-'+n+'"/></svg>';}
function meter(v){var on=Math.floor(v/20),rem=v-on*20,part=(rem>=5&&on<5)?1:0,h='',i;for(i=0;i<on;i++)h+='<i class="on"></i>';if(part)h+='<i class="part"></i>';for(i=0;i<5-on-part;i++)h+='<i></i>';
  return '<span class="conf'+(v<70?' conf--lo':'')+'"><span class="meter" role="img" aria-label="Confidence '+v+' of 100">'+h+'</span><b>'+v+'</b></span>';}
function badge(r){
  if(r.asked) return '<span class="match match--partial">'+ico('ask')+'Asked Rob · 4d · blocks close</span>';
  if(r.ret) return '<span class="match match--partial">'+ico('undo')+'Returned by Jordan Smith</span>';
  var m=r.m,k=m[0],ic={bill:'bill',receipt:'receipt',none:'none',dup:'copy',sched:'sched',swap:'swap',partial:'bill'}[k];
  var cls={none:' match--none',partial:' match--partial',dup:' match--partial'}[k]||'';var ic2=(k=='bill'||k=='receipt'||k=='swap'||k=='sched')?'pos':'';
  return '<span class="match'+cls+'">'+ico(ic,ic2)+m[1]+'</span>';}
var BANDS={decide:['Decide','under 70, or a question'],check:['Check','70–89 · one look each'],ready:['Ready','90+ · preselected for batch']};
var READY_N=212, READY_T=-318904.66;
function sum(b){return D.filter(function(r){return r.band==b}).reduce(function(a,r){return a+r.amt},0);}
function q(sel,root){return (root||document).querySelector(sel)}
function byId(id){return D.filter(function(r){return r.id==id})[0];}
function Q(root,state){
  var tb=q('tbody',root), h='';
  ['decide','check','ready'].forEach(function(b){
    var n=b=='ready'?READY_N:D.filter(function(r){return r.band==b}).length, t=b=='ready'?READY_T:sum(b);
    var act=b=='ready'?'<span class="gacts"><button class="btn btn--primary" type="button" data-act="ready">Approve '+READY_N+' Ready<span class="kbd">⇧</span><span class="kbd">A</span></button></span>':'';
    h+='<tr class="q-group"><td colspan="5"><span class="q-group-t">'+BANDS[b][0]+' '+n+'</span><span class="t-cap">'+BANDS[b][1]+' · '+moneyP(t)+'</span>'+act+'</td></tr>';
    D.filter(function(r){return r.band==b}).forEach(function(r){
      var c=r.code?'<span class="l1"><span class="code">'+r.code+'</span>'+r.acct+'</span>':(r.p.split?'<span class="l1">'+r.acct+'</span>':'<span class="l1 asks">'+r.acct+'</span>');
      var sel=state.sel.indexOf(r.id)>-1, cur=state.cur==r.id, done=state.done.indexOf(r.id)>-1;
      h+='<tr class="q-row'+(sel?' is-selected':'')+(cur?' is-cursor':'')+(done?' is-done':'')+((r.asked||r.ret)?' is-attn':'')+'" data-id="'+r.id+'">'+
       '<td><label class="check"><input type="checkbox"'+(sel?' checked':'')+' aria-label="Select '+r.payee+', '+moneyP(r.amt)+'"><i></i></label></td>'+
       '<td><span class="l1"><span class="vend" title="Click to select every '+r.payee+' item">'+r.payee+'</span></span><span class="l2">'+r.date+' · '+r.src+'</span></td>'+
       '<td>'+c+'<span class="l2">'+badge(r)+'</span></td>'+
       '<td>'+meter(r.conf)+'</td><td class="n">'+money(r.amt)+'</td></tr>';
    });
    if(b=='ready') h+='<tr class="more"><td></td><td colspan="4">'+(READY_N-8)+' more Ready, same rules · <a class="link" href="#">Show all '+READY_N+'</a></td></tr>';
  });
  tb.innerHTML=h;
  var bulk=q('.bulk',root);
  if(state.sel.length){var s=D.filter(function(r){return state.sel.indexOf(r.id)>-1});var tot=s.reduce(function(a,r){return a+r.amt},0);
    var bands=s.map(function(r){return BANDS[r.band][0]}).filter(function(v,i,a){return a.indexOf(v)==i}).join(' + ');
    bulk.hidden=false;bulk.innerHTML='<b><span class="tnum">'+s.length+'</span> selected</b><span class="sl">//</span><span>'+bands+'</span><span class="sl">//</span><span class="tnum">'+moneyP(tot)+'</span><span class="sp"></span>'+
     '<button class="btn" type="button" data-act="approve-sel">Approve '+s.length+'<span class="kbd">A</span></button>'+
     '<button class="btn'+(state.mode=='ask'?' btn--primary':'')+'" type="button" data-act="ask" aria-pressed="'+(state.mode=='ask')+'">'+ico('ask')+'Ask client<span class="kbd">Q</span></button>'+
     '<button class="btn btn--quiet" type="button" data-act="clear">Clear<span class="kbd">Esc</span></button>';}
  else{bulk.hidden=true;bulk.innerHTML='';}
  if(state.mode=='ask'&&state.sel.length) composer(root,state); else panel(root,state);
}
function panel(root,state){
  var r=byId(state.cur), p=r.p, el=q('.panel',root);
  var list=D.filter(function(x){return x.band==r.band}), idx=list.indexOf(r)+1, n=r.band=='ready'?READY_N:list.length;
  var why=p.why.map(function(w){return '<li'+(w[1]?' class="against"':'')+'>'+w[0]+'</li>'}).join('');
  var ev='';
  if(p.ev){var t=0;ev='<ul class="ev">'+p.ev.map(function(e){t+=e[1];return '<li>'+e[0]+'<span class="dl"></span><span class="v">'+moneyP(e[1])+'</span></li>'}).join('')+'<li class="ev-total">Payment<span class="dl"></span><span class="v">'+moneyP(t)+'</span></li></ul>';}
  var rec=p.rec.filter(function(x){return A[x[0]]}).map(function(x){var on=p.split?p.split.some(function(s){return s[0]==x[0]}):(x[0]==r.code);
    return '<button class="recent" type="button" aria-pressed="'+on+'"><span class="l1"><span class="code">'+x[0]+'</span>'+A[x[0]]+'</span><span class="ct">'+(x[1]?x[1]+'× for this vendor':'not used yet')+'</span></button>';}).join('');
  var lines, coded=!!(r.code||p.split);
  if(!coded){lines='<p class="ink-2" style="margin-top:4px">Nothing to post until this has a code. Pick an account, or press <span class="kbd">Q</span> to ask Rob.</p>';}
  else{var dr=[],cr=[],bank=r.bank;
    if(p.split){p.split.forEach(function(s){dr.push([s[0],A[s[0]],s[1]])});cr.push([bank[0],bank[1],-r.amt]);}
    else if(r.amt<0){dr.push([r.code,A[r.code]||r.acct,-r.amt]);cr.push([bank[0],bank[1],-r.amt]);}
    else{dr.push([bank[0],bank[1],r.amt]);cr.push([r.code,A[r.code]||r.acct,r.amt]);}
    var td=0,tc=0,row=function(l,d){return '<tr class="fs-line"><td><span class="code">'+l[0]+'</span>'+l[1]+'</td><td class="n">'+(d?moneyP(l[2]):'')+'</td><td class="n">'+(d?'':moneyP(l[2]))+'</td></tr>'};
    lines='<table class="tbl tbl-fs pp"><colgroup><col><col style="width:76px"><col style="width:76px"></colgroup><thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>'+
      dr.map(function(l){td+=l[2];return row(l,1)}).join('')+cr.map(function(l){tc+=l[2];return row(l,0)}).join('')+
      '<tr class="fs-sub"><td>Total</td><td class="n">'+moneyP(td)+'</td><td class="n">'+moneyP(tc)+'</td></tr></tbody></table>';}
  var bal=coded?'<span class="tag tag--pos">Balanced</span>':'<span class="tag">Not coded</span>';
  el.setAttribute('aria-label','Edit '+r.payee);
  el.innerHTML='<div class="panel-head"><div class="eyebrow">'+BANDS[r.band][0]+' · '+idx+' of '+n+'</div><div class="row row--between" style="margin-top:4px"><span class="t-head">'+r.payee+'</span><span class="amt">'+moneyP(r.amt)+'</span></div><span class="l2">'+r.date+' · '+r.src+' · '+r.raw+'</span></div>'+
   '<div class="panel-body"><div class="panel-sec"><div class="note note--panel"><div class="row row--between"><span class="tag tag--ai">AI suggestion</span>'+meter(r.conf)+'</div><h4 class="note-title" style="margin-top:8px">'+p.t+'</h4><ul class="why">'+why+'</ul>'+ev+'<div class="basis"><span><b>'+p.basis+'</b></span><span>Nothing posts until you approve</span></div></div></div>'+
   '<div class="panel-sec"><div class="panel-sec-h"><h3>Account</h3><button class="btn btn--quiet" type="button">'+ico('rule')+'Make rule</button></div><label class="search">'+ico('search')+'<input type="search" aria-label="Search GL accounts" placeholder="Search 214 accounts"><span class="kbd">E</span></label><div class="t-cap" style="margin-top:8px">'+r.payee+' usually goes to</div><div class="recents">'+rec+'</div></div>'+
   '<div class="panel-sec"><label class="field"><span class="field-label">Note for the reviewer</span><textarea class="textarea" rows="2" placeholder="Optional. Jordan sees this at review."></textarea></label></div>'+
   '<div class="panel-sec"><div class="panel-sec-h"><h3>Posting preview</h3>'+bal+'</div>'+lines+'</div></div>'+
   '<div class="panel-foot"><button class="btn btn--primary" type="button" data-act="approve"'+(coded?'':' disabled')+'>Save &amp; approve<span class="kbd">A</span></button><button class="btn" type="button" data-act="flag" aria-label="Flag for the reviewer" title="Flag for the reviewer">'+ico('flag')+'<span class="kbd">F</span></button><span class="sp"></span><button class="btn btn--quiet" type="button" data-act="ask1">Ask client<span class="kbd">Q</span></button></div>';
}
var QS={d1:['Who was check 10482 paid to, and what was it for?',[['Parts supplier','5110',1],['Contract labor','5200',1],['Owner draw','3200',1]]],
 d5:['Is the Fire tablet in this order for the business?',[['All business','6420',1],['Tablet is personal','',1],['All personal','3200',1]]],
 d6:['Who was this dinner at Justin’s with?',[['A customer','6610',1],['Staff','6615',1],['Personal','3200',1]]],
 d2:['Was the Venmo to J. Ortega for work on a job?',[['Subcontractor','5200',1],['Owner draw','3200',1]]],
 d3:['Did Tom buy this Grainger part twice on Sep 14?',[['Yes, two orders','5110',1],['No, charged twice','',1]]],
 d4:['Was the Stihl credit a co-op rebate?',[['Yes, co-op','4910',1],['No, parts return','5110',1]]]};
function composer(root,state){
  var s=D.filter(function(r){return state.sel.indexOf(r.id)>-1}),el=q('.panel',root);
  var cards=s.map(function(r){var qq=QS[r.id]||['What was this for?',[['Business','6420',1],['Personal','3200',1]]];
    var chips=qq[1].map(function(c){return '<button class="chip" type="button" aria-pressed="'+(c[2]?'true':'false')+'">'+c[0]+(c[1]?' <span class="code">'+c[1]+'</span>':'')+'</button>'}).join('');
    return '<div class="qa"><div class="qa-top"><span class="l1">'+r.payee+' <span class="ink-3" style="font-weight:400">· '+r.date+'</span></span><span class="tnum">'+moneyP(r.amt)+'</span></div>'+
      '<textarea class="textarea" aria-label="Question about '+r.payee+'">'+qq[0]+'</textarea>'+
      '<div class="t-cap" style="margin-top:8px">One-tap answers Rob will see</div><div class="chips">'+chips+'<span class="chip chip--fixed" title="Always offered">Don’t know · call me</span><button class="chip chip--add" type="button">'+ico('camera')+'Ask for a photo</button></div></div>';}).join('');
  var tot=s.reduce(function(a,r){return a+r.amt},0);
  el.setAttribute('aria-label','Ask client');
  el.innerHTML='<div class="panel-head"><div class="eyebrow">Ask client · '+s.length+' question'+(s.length>1?'s':'')+' · '+moneyP(tot)+'</div><div class="row row--between" style="margin-top:4px"><span class="t-head">To Rob Hartley</span><span class="tag">Owner</span></div><span class="l2">Text to (515) •••-0148 and email · magic link, no login</span></div>'+
   '<div class="panel-body">'+cards+
   '<div class="panel-sec"><div class="opts"><span class="k">Blocks close</span><label class="switch"><input type="checkbox" checked><i></i>Yes, show it on the close</label><span class="k">Due</span><span class="b">Thu Oct 22</span><span class="k">Reminders</span><span>Gentle: Wed and Thu, 8:00 AM</span></div></div>'+
   '<a class="preview-link" href="S4-client-request-mobile.html">'+ico('eye')+'<span>See what Rob sees on his phone</span><span class="sp"></span>'+ico('right')+'</a></div>'+
   '<div class="panel-foot"><button class="btn btn--primary" type="button" data-act="send">Send '+s.length+' question'+(s.length>1?'s':'')+'<span class="kbd">⌘</span><span class="kbd">↵</span></button><span class="t-cap">Draft saved</span><span class="sp"></span><button class="btn btn--quiet" type="button" data-act="closeask">Cancel<span class="kbd">Esc</span></button></div>';
}
function toast(root,msg){var t=q('.toast-region',root);t.innerHTML='<div class="toast" role="status"><span class="toast-mark"></span><span>'+msg+'</span><button class="btn btn--quiet" type="button">Undo<span class="kbd">⌘</span><span class="kbd">Z</span></button></div>';clearTimeout(t._t);t._t=setTimeout(function(){t.innerHTML=''},4000);}
function wire(root,state,live){
  Q(root,state);
  if(!live) return;
  var vis=function(){return D.filter(function(r){return state.done.indexOf(r.id)<0}).map(function(r){return r.id})};
  root.addEventListener('click',function(e){
    var tr=e.target.closest('tr.q-row'), a=e.target.closest('[data-act]');
    if(e.target.closest('.vend')&&tr){var p=byId(tr.dataset.id).payee;D.forEach(function(r){if(r.payee==p&&state.sel.indexOf(r.id)<0)state.sel.push(r.id)});Q(root,state);return;}
    if(e.target.closest('label.check')&&tr){e.preventDefault();var id=tr.dataset.id,i=state.sel.indexOf(id);if(i>-1)state.sel.splice(i,1);else state.sel.push(id);Q(root,state);return;}
    if(tr&&!a){state.cur=tr.dataset.id;Q(root,state);return;}
    if(!a)return;var k=a.dataset.act;
    if(k=='approve'){state.done.push(state.cur);toast(root,'Approved 1 · posted to Clive Power Equipment');var v=vis();state.cur=v[0]||state.cur;Q(root,state);}
    if(k=='approve-sel'){var n=state.sel.length;state.done=state.done.concat(state.sel);state.sel=[];state.mode='edit';toast(root,'Approved '+n+' · posted to Clive Power Equipment');Q(root,state);}
    if(k=='ready'){toast(root,'Approved '+READY_N+' Ready · posted to Clive Power Equipment');}
    if(k=='ask'||k=='ask1'){if(!state.sel.length)state.sel=[state.cur];state.mode='ask';Q(root,state);}
    if(k=='closeask'){state.mode='edit';Q(root,state);}
    if(k=='clear'){state.mode='edit';state.sel=[];Q(root,state);}
    if(k=='send'){var n2=state.sel.length;state.mode='edit';state.sel=[];toast(root,'Sent '+n2+' question'+(n2>1?'s':'')+' to Rob Hartley');Q(root,state);}
    if(k=='flag'){toast(root,'Flagged 1 for Jordan Smith');}
  });
  document.addEventListener('keydown',function(e){
    if(e.target.closest&&e.target.closest('input,textarea'))return; var v=vis(),i=v.indexOf(state.cur);
    if(e.key=='j'){state.cur=v[Math.min(v.length-1,i+1)];}
    else if(e.key=='k'){state.cur=v[Math.max(0,i-1)];}
    else if(e.key=='x'){var j=state.sel.indexOf(state.cur);if(j>-1)state.sel.splice(j,1);else state.sel.push(state.cur);}
    else if(e.key=='q'){if(!state.sel.length)state.sel=[state.cur];state.mode='ask';}
    else if(e.key=='Escape'){state.mode='edit';state.sel=[];}
    else if(e.key=='a'&&state.mode!='ask'){var r=byId(state.cur);if(!(r.code||r.p.split))return;state.done.push(state.cur);toast(root,'Approved 1 · posted to Clive Power Equipment');var v2=vis();state.cur=v2[Math.min(i,v2.length-1)];}
    else if(e.key=='A'){toast(root,'Approved '+READY_N+' Ready · posted to Clive Power Equipment');return;}
    else return;
    e.preventDefault();Q(root,state);
    var c=q('tr.is-cursor',root);if(c)c.scrollIntoView({block:'nearest'});
  });
}
wire(document.getElementById('f1'),{cur:'c2',sel:[],done:[],mode:'edit'},true);
wire(document.getElementById('f2'),{cur:'d5',sel:['d1','d5','d6'],done:[],mode:'ask'},false);
})();
