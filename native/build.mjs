// Build tooling only. End users run the resulting self-contained executable.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const go=process.env.MCWC_GO || 'go', version='0.3.0';
function run(args,env={}) {
 const result=spawnSync(go,args,{cwd:root,env:{...process.env,...env},encoding:'utf8'});
 if(result.status!==0) throw Error(result.stderr || result.error?.message || 'Go command failed');
 return result.stdout.trim();
}
export async function sourceHash() {
 const paths=[];
 async function walk(folder,prefix='') {
  for(const entry of (await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
   const path=prefix+entry.name;
   if(entry.isDirectory() && entry.name==='licenses') await walk(join(folder,entry.name),path+'/');
   else if(entry.isFile() && (/\.(?:go|mod|sum|mjs|sh|ps1)$/.test(entry.name)||prefix==='licenses/')) paths.push(path);
  }
 }
 await walk(root);const hash=createHash('sha256');
 for(const path of paths.sort()) {hash.update(path+'\0');hash.update(await readFile(join(root,path)));hash.update('\0');}
 return hash.digest('hex');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 if(process.argv.includes('--notices')) {
  const used=new Set(run(['list','-deps','-f','{{if .Module}}{{.Module.Path}}{{end}}','.']).split('\n'));
  const modules=run(['list','-m','-json','all']).split(/\n(?=\{)/).map(text=>JSON.parse(text)).filter(row=>used.has(row.Path));
  let notices='Third-party notices for minecraft.wasm.click relay '+version+'\n\n';
  const goroot=run(['env','GOROOT']);notices+='Go standard library\n'+await readFile(join(goroot,'LICENSE'),'utf8')+'\n';
  for(const mod of modules.filter(row=>!row.Main).sort((a,b)=>a.Path.localeCompare(b.Path))) {
   if(!mod.Dir)throw Error('Missing module source: '+mod.Path);
   const names=(await readdir(mod.Dir)).filter(name=>/^(?:licen[cs]e|copying|copyright)(?:\..*)?$/i.test(name));
   if(!names.length)throw Error('Missing license: '+mod.Path);
   notices+='\n'+mod.Path+' '+mod.Version+'\n';
   for(const name of names.sort())notices+=name+'\n'+await readFile(join(mod.Dir,name),'utf8')+'\n';
  }
  await writeFile(join(root,'licenses/THIRD_PARTY.txt'),notices);
  let gpl;for(const path of [join(root,'../LICENSE'),join(root,'../../LICENSE')]) {try{gpl=await readFile(path);break;}catch{}}
  if(!gpl)throw Error('Missing project GPL license');await writeFile(join(root,'licenses/GPL-3.0.txt'),gpl);
  console.log('Wrote pinned native dependency licenses.');process.exit(0);
 }
 const out=resolve(process.argv[2] || join(root,'../build/cli'));await mkdir(out,{recursive:true});
 if(run(['env','GOVERSION'])!=='go1.27.3')throw Error('Use the pinned Go 1.27.3 toolchain.');
 const manifest={schema:1,version,go:'go1.27.3',sourceSha256:await sourceHash(),files:{}};
 for(const os of ['darwin','linux','windows'])for(const arch of ['amd64','arm64']) {
  const name='mcwc-relay-'+os+'-'+arch+(os==='windows'?'.exe':'');
  run(['build','-mod=readonly','-trimpath','-buildvcs=false','-ldflags','-s -w -X main.version='+version,'-o',join(out,name),'.'],{CGO_ENABLED:'0',GOOS:os,GOARCH:arch});
  const bytes=await readFile(join(out,name));if(bytes.length>24*1024*1024)throw Error('CLI exceeds asset limit');
  manifest.files[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  console.log('Built '+name+' ('+bytes.length+' bytes)');
 }
 await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 await writeFile(join(out,'SHA256SUMS'),Object.entries(manifest.files).map(([name,row])=>row.sha256+'  '+name).join('\n')+'\n');
 console.log('Built six self-contained CLI downloads with checksums.');
}
