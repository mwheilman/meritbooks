// Fails if any 'use client' module (transitively, incl. dynamic import()) reaches server-only code.
// Next's webpack bundles dynamic imports too, so they count. Usage: node scripts/check-client-server-imports.js
const fs=require('fs'),path=require('path');
const SRC=path.join(__dirname,'..','src');
const SERVER_SPEC=[/^next\/headers$/,/^server-only$/,/^@clerk\/nextjs\/server$/];
const SERVER_FILES=[path.join(SRC,'lib/supabase/server.ts')];
const exts=['.ts','.tsx','.js','.jsx','/index.ts','/index.tsx'];
function resolve(from,spec){let base;if(spec.startsWith('@/'))base=path.join(SRC,spec.slice(2));else if(spec.startsWith('.'))base=path.resolve(path.dirname(from),spec);else return null;
  if(fs.existsSync(base)&&fs.statSync(base).isFile())return base;for(const e of exts){if(fs.existsSync(base+e))return base+e}return null}
const cache=new Map();
function deps(f){if(cache.has(f))return cache.get(f);const s=fs.readFileSync(f,'utf8');const out=[];
  const re=/(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;let m;
  while((m=re.exec(s))){const whole=m[0];if(/^import\s+type\b/.test(whole)||/^export\s+type\b/.test(whole))continue;out.push(m[1]||m[2])}
  cache.set(f,out);return out}
function walk(dir,o=[]){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p,o);else if(/\.(tsx?|jsx?)$/.test(e.name)&&!/\.test\./.test(e.name))o.push(p)}return o}
const files=walk(SRC);const bad=[];
for(const f of files){const head=fs.readFileSync(f,'utf8').slice(0,200);if(!/^\s*['"]use client['"]/.test(head))continue;
  const seen=new Set([f]);const stack=[[f,[f]]];let hit=null;
  while(stack.length&&!hit){const [cur,trail]=stack.pop();for(const spec of deps(cur)){
    if(SERVER_SPEC.some(r=>r.test(spec))){hit=[...trail,spec];break}
    const r=resolve(cur,spec);if(!r)continue;if(SERVER_FILES.includes(r)){hit=[...trail,r];break}
    const h=fs.readFileSync(r,'utf8').slice(0,200);if(/^\s*['"]use server['"]/.test(h))continue; // server actions are allowed
    if(!seen.has(r)){seen.add(r);stack.push([r,[...trail,r]])}}}
  if(hit)bad.push(hit.map(x=>path.relative(SRC,x)).join('\n    -> '))}
if(bad.length){console.log(`${bad.length} client module(s) reach server-only code:\n`);bad.forEach(b=>console.log('  '+b+'\n'));process.exit(1)}
console.log('ok: no client module reaches server-only code');
