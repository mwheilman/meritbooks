// Local replica of next build's route/page type check (which tsc alone skips).
// Usage: node apps/web/scripts/gen-next-type-guards.js $PWD/apps/web && (cd apps/web && npx tsc --noEmit)
// Writes .next/types/app/** guard files exactly as Next's NextTypesPlugin does; tsconfig already includes them.
const fs=require('fs'),path=require('path');
const webDir=process.argv[2];
const pluginPath=require.resolve('next/dist/build/webpack/plugins/next-types-plugin/index.js',{paths:[webDir]});
const src=fs.readFileSync(pluginPath,'utf8');
const m={exports:{}};
const req=(id)=>require(require.resolve(id,{paths:[path.dirname(pluginPath)]}));
new Function('require','exports','module','__dirname','__filename',src+'\n;module.exports.__ctg=createTypeGuardFile;module.exports.__base=appTypesBasePath;module.exports.__slots=collectNamedSlots;')(req,m.exports,m,path.dirname(pluginPath),pluginPath);
const {__ctg:ctg,__base:base,__slots:slots}=m.exports;
const appDir=path.join(webDir,'src/app'), distAbs=path.join(webDir,'.next');
function walk(d,o=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())walk(f,o);else o.push(f)}return o}
(async()=>{let n=0;
for(const f of walk(appDir)){
  const isLayout=/[/\\]layout\.[^.]+$/.test(f), isPage=!isLayout&&/[/\\]page\.[^.]+$/.test(f), isRoute=!isPage&&!isLayout&&/[/\\]route\.[^.]+$/.test(f);
  if(!(isLayout||isPage||isRoute)||!/\.(ts|tsx|js|jsx)$/.test(f)) continue;
  const rel=path.relative(appDir,f);
  const typePath=path.join(distAbs,base,rel.replace(/\.(js|jsx|ts|tsx|mjs)$/,'.ts'));
  const modInTypes=path.join(distAbs,base,rel);
  const relImport=path.relative(modInTypes+'/..',f).replace(/\.(js|jsx|ts|tsx|mjs)$/,'');
  const opts=isLayout?{type:'layout',slots:await slots(f)}:{type:isPage?'page':'route'};
  fs.mkdirSync(path.dirname(typePath),{recursive:true});
  fs.writeFileSync(typePath,ctg(f,relImport,opts)); n++;
}
console.log('guards',n);})();
