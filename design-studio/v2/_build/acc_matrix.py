"""Client-side capability matrix renderer shared by S14, S15 and S16."""

MATRIX_JS = r"""
window.MBM=(function(){
  var A=MB.actions,CAT={},ORDER=[];
  MB.catalog.forEach(function(d){d[2].forEach(function(r){CAT[r[0]]={dom:d[0],domL:d[1],label:r[1],acts:r[2],flags:r[3]};ORDER.push(r[0]);});});
  var AN={};A.forEach(function(a){AN[a[0]]=a[1]});
  function has(g,cap){var p=cap.split(':');return (g[p[0]]||'').indexOf(p[1])>-1}
  function relMoney(g){return Object.keys(g).some(function(k){return CAT[k]&&CAT[k].flags.indexOf('M')>-1&&(g[k]||'').indexOf('R')>-1})}
  function sodHits(g){return MB.sod.filter(function(r){return r.need.every(function(n){return n==='@release_money'?relMoney(g):has(g,n)})})}
  function capName(cap){var p=cap.split(':');if(p[0]==='@release_money')return 'Any money release';var c=CAT[p[0]];return c.label+': '+AN[p[1]]}
  function norm(s,acts){return acts.split('').filter(function(c){return s.indexOf(c)>-1}).join('')}
  var PRESETS={None:'',View:'VX',Prepare:'VCED',Approve:'VA',Full:'VCEDAPRXK'};
  function presetOf(acts,g){g=g||'';if(!g)return 'None';if(norm(PRESETS.Full,acts)===g)return 'Full';
    for(var k in PRESETS){if(k!=='Full'&&k!=='None'&&norm(PRESETS[k],acts)===g)return k}return 'Custom'}
  function applyPreset(acts,p){return norm(PRESETS[p]||'',acts)}
  function flags(f){var h='';
    if(f.indexOf('M')>-1)h+='<svg class="ico" width="14" height="14" role="img" aria-label="Moves money"><title>Moves money</title><use href="#i-money"/></svg>';
    if(f.indexOf('S')>-1)h+='<svg class="ico" width="14" height="14" role="img" aria-label="Sensitive fields"><title>Sensitive fields</title><use href="#i-eye-off"/></svg>';
    if(f.indexOf('L')>-1)h+='<svg class="ico" width="14" height="14" role="img" aria-label="Re-verify to use"><title>Re-verify to use</title><use href="#i-lock"/></svg>';
    return h?'<span class="flags">'+h+'</span>':''}
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')}
  /* o: {grants, base?, limits?, edit?, doms?(list), only?(fn key->bool), src?(fn key,act->{t,set,muted}), hits?, sel?} */
  function render(tbl,o){
    var rows=[],cols=A.length+(o.edit?2:1),hard={},soft={};
    (o.hits||[]).forEach(function(r){r.need.forEach(function(n){(r.hard?hard:soft)[n]=1})});
    MB.catalog.forEach(function(d){
      if(o.doms&&o.doms.indexOf(d[0])<0)return;
      var res=d[2].filter(function(r){return !o.only||o.only(r[0])});
      if(!res.length)return;
      var n=0;res.forEach(function(r){n+=norm(o.grants[r[0]]||'',r[2]).length});
      rows.push('<tr class="capm-dom" id="'+(o.idp||'d')+'-'+d[0].replace(/\W/g,'')+'"><td colspan="'+cols+'"><span class="q-group-t">'+esc(d[1])+'</span><span class="t-cap tnum">'+n+' granted</span></td></tr>');
      res.forEach(function(r){
        var k=r[0],g=o.grants[k]||'',lim=[],acts=o.acts?o.acts(k):r[2];
        r[2].split('').forEach(function(a){var L=o.limits&&o.limits[k+':'+a];if(L)lim.push(AN[a]+' '+L)});
        var tr='<tr class="capm-res" data-k="'+k+'"><td><div class="res"><span class="l1">'+esc(r[1])+'</span>'+flags(r[3])+'</div>'+(lim.length?'<span class="l2">'+esc(lim.join(' · '))+'</span>':'')+'</td>';
        if(o.edit){var p=presetOf(acts,g);tr+='<td><select class="select" aria-label="Preset for '+esc(r[1])+'" data-preset="'+k+'">'+['None','View','Prepare','Approve','Full','Custom'].map(function(x){return '<option'+(x===p?' selected':'')+(x==='Custom'?' disabled':'')+'>'+x+'</option>'}).join('')+'</select></td>';}
        A.forEach(function(a){
          var c=a[0];
          if(acts.indexOf(c)<0){tr+='<td></td>';return}
          var on=g.indexOf(c)>-1,cap=k+':'+c,cls='cap',extra='',lab=r[1]+': '+a[1];
          var s=o.src?o.src(k,c):null;
          if(s&&s.muted){cls+=' is-muted';lab+=', muted'}
          else if(s&&s.set&&on){cls+=' is-set';lab+=', from a permission set'}
          else if(on)cls+=' is-on';
          if(on&&o.limits&&o.limits[cap]){cls+=' is-lim';lab+=', limit '+o.limits[cap]}
          if(on&&hard[cap])cls+=' is-hard';else if(on&&soft[cap])cls+=' is-soft';
          if(o.base){var b=(o.base[k]||'').indexOf(c)>-1;if(on&&!b)extra+=' data-delta="add"';if(!on&&b)extra+=' data-delta="rem"';}
          if(o.sel===cap)cls+=' is-sel';
          if(o.edit){tr+='<td><button type="button" class="'+cls+'" aria-pressed="'+on+'" data-c="'+cap+'" aria-label="'+esc(lab+(on?', granted':', not granted'))+'"'+extra+'><i></i></button></td>';}
          else{tr+='<td><span class="'+cls+' cap--ro" tabindex="0" role="img" data-c="'+cap+'" aria-label="'+esc(lab+(on?', granted':', not granted')+(s&&s.t?'. '+s.t:''))+'" data-tip="'+esc(s&&s.t?s.t:(on?'Granted':'Not granted'))+'"'+extra+'><i></i></span></td>';}
        });
        rows.push(tr+'</tr>');
      });
    });
    tbl.querySelector('tbody').innerHTML=rows.join('');
  }
  function head(edit,first){return '<thead><tr><th>'+(first||'Capability')+'</th>'+(edit?'<th style="text-align:left">Preset</th>':'')+A.map(function(a){return '<th>'+a[1]+'</th>'}).join('')+'</tr></thead><tbody></tbody>'}
  /* tooltip for read-only cells */
  var tip;function showTip(el){var t=el.getAttribute('data-tip');if(!t)return;if(!tip){tip=document.createElement('div');tip.className='tooltip';tip.setAttribute('role','tooltip');document.body.appendChild(tip)}
    tip.textContent=t;var r=el.getBoundingClientRect();tip.style.left=Math.max(8,r.left+window.scrollX+16-tip.offsetWidth/2)+'px';tip.style.top=(r.top+window.scrollY-30)+'px';tip.hidden=false}
  function hideTip(){if(tip)tip.hidden=true}
  document.addEventListener('mouseover',function(e){var c=e.target.closest&&e.target.closest('[data-tip]');if(c)showTip(c)});
  document.addEventListener('mouseout',function(e){if(e.target.closest&&e.target.closest('[data-tip]'))hideTip()});
  document.addEventListener('focusin',function(e){if(e.target.matches&&e.target.matches('[data-tip]'))showTip(e.target)});
  document.addEventListener('focusout',hideTip);
  return {CAT:CAT,ORDER:ORDER,AN:AN,has:has,sodHits:sodHits,capName:capName,presetOf:presetOf,applyPreset:applyPreset,norm:norm,render:render,head:head,esc:esc};
})();
"""
