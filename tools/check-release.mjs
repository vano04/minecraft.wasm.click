#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const artifact='build/public-runtime-validation';
await rm(join(root,artifact),{recursive:true,force:true});
const checks=[];
const node=(name,...args)=>checks.push({name,args});
const suite=async(name,directory,extras=[])=>node(name,'--test',...(await readdir(join(root,directory)))
  .filter(path=>path.endsWith('.test.mjs')).sort().map(path=>join(directory,path)),...extras);
node('Public runtime source','tools/verify-runtime-source.mjs');
node('Public source and credential boundaries','tools/audit-public-site.mjs');
node('Public runtime archive','tools/unpack-public-runtime.mjs','--verify-only');
await suite('JSON authentication and standalone server','server');
await suite('Packaging and source-offer behavior','tools',['tools/test-runtime-source.mjs','tools/test-runtime-notices.mjs']);
await suite('Runtime behavior','runtime/tests');
await suite('Multiplayer transport','relay-service');
for(const name of ['game-storage','game-library','vm-identity','own-profile','runtime-discard','direct-server-pack',
  'player-textures','frame-backpressure','mobile-layout','input-mapping'])node(name+' contract','tools/test-'+name+'.mjs');
node('Stage the public runtime and source offer','tools/stage-public.mjs','--output','build/public-site-validation');
node('Extract verified artifact for behavior checks','tools/unpack-public-runtime.mjs',artifact);
node('Artifact frame backpressure','tools/test-frame-backpressure.mjs','--derived',artifact);
node('Artifact GPU resource ownership','tools/test-gpu-resource-ownership.mjs',artifact+'/webgpu-host.js');
node('Artifact storage','tools/test-game-storage.mjs',artifact+'/mobile-runtime.js');
node('Artifact server packs','tools/test-direct-server-pack.mjs',artifact);
node('Artifact pointer release','tools/test-pointer-lock-release.mjs',artifact+'/javavm.js',artifact+'/webgpu-host.js');
node('Artifact resource census','tools/test-resource-census.mjs',artifact+'/webgpu-host.js',artifact+'/gpu-rpc-worker.js',artifact+'/javavm.js');
node('Artifact canvas format','tools/test-preferred-canvas-format.mjs',artifact+'/webgpu-host.js');
node('Artifact runtime disposal','tools/test-runtime-discard.mjs',artifact,join(root,'runtime'));
for(const check of checks){
  console.log('CHECK '+check.name);
  const audit=check.args[0]==='tools/audit-public-site.mjs';
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,check.args,{cwd:root,stdio:audit?['ignore','pipe','inherit']:'inherit'});
    let result='';if(audit)child.stdout.on('data',chunk=>{result+=chunk;if(result.length>4*1024*1024)child.kill();});
    child.once('error',reject);child.once('close',code=>{
      if(audit&&code===0){const report=JSON.parse(result);console.log('Audited '+report.entries.length+' public source files.');}
      resolve(code);
    });
  });
  if(code!==0)throw Error(check.name+' failed with exit '+code);
}
console.log('PASS '+checks.length+' public distribution checks.');
console.log('Browser gameplay, live-account import and physical-device acceptance require separate checks.');
