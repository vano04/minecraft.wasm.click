#!/usr/bin/env node
import { queuedBufferHost, keyboardGameControls } from '../server/runtime-fixes.mjs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackPublicRuntime } from './unpack-public-runtime.mjs';
import { verifyRuntimeSource } from './verify-runtime-source.mjs';
import { portableTestingPage } from './stage-testing.mjs';
import { stageRuntimeNotices } from './stage-runtime-notices.mjs';
import { authenticatedGpuWorker, relayPackHttp } from '../server/launcher.mjs';
import { testingAssetResolver } from '../server/runtime-assets.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function stagePublic({directory=root,destination=join(directory,'site')}={}) {
  await verifyRuntimeSource({root:directory,checkGit:false,requireReleaseMatch:true});
  const site=resolve(destination);
  await rm(site,{recursive:true,force:true});await mkdir(site,{recursive:true});
  const play=join(site,'play');
  await unpackPublicRuntime({archivePath:join(directory,'artifacts/runtime.tar.gz'),manifestPath:join(directory,'artifacts/runtime.json'),destination:play});
  const artifact=JSON.parse(await readFile(join(directory,'artifacts/runtime.json'),'utf8'));
  await cp(join(directory,'public'),site,{recursive:true});
  await cp(join(directory,'server/account-json.mjs'),join(site,'auth/account-json.mjs'));
  let html=portableTestingPage(await readFile(join(play,'index.html'),'utf8'));
  html=html.replaceAll('/testing/','/play/');
  await writeFile(join(play,'index.html'),html);
  await writeFile(join(play,'webgpu-host.js'),queuedBufferHost(await readFile(join(play,'webgpu-host.js'),'utf8')));
  const gpu=authenticatedGpuWorker(await readFile(join(play,'gpu-rpc-worker.js'),'utf8'));
  await writeFile(join(play,'gpu-rpc-worker.js'),gpu);
  await writeFile(join(play,'game-controls.js'),keyboardGameControls(await readFile(join(play,'game-controls.js'),'utf8')));
  await writeFile(join(play,'pack-http.js'),relayPackHttp(await readFile(join(play,'pack-http.js'),'utf8')));
  await writeFile(join(play,'mojang-upstream.js'),testingAssetResolver(await readFile(join(play,'mojang-upstream.js'),'utf8')));
  await writeFile(join(site,'runtime-files.json'),JSON.stringify(artifact.files,null,2)+'\n');
  const source=await stageRuntimeNotices({root:directory,site,thirdParty:await readFile(join(play,'THIRD-PARTY.json'))});
  const publicFiles=[];
  async function walk(path='') {
    for(const entry of await readdir(join(site,path),{withFileTypes:true})) {
      const name=path?path+'/'+entry.name:entry.name;
      if(name==='play'||name==='runtime-files.json'||name==='public-files.json')continue;
      if(entry.isDirectory())await walk(name);else if(entry.isFile())publicFiles.push(name);
      else throw Error('Unexpected linked staged file: '+name);
    }
  }
  await walk();publicFiles.sort();
  await writeFile(join(site,'public-files.json'),JSON.stringify(publicFiles,null,2)+'\n');
  return {files:Object.keys(artifact.files).length,sourceSha256:source.distributionSourceSha256};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length && (args.length!==2 || args[0]!=='--output'))throw Error('Usage: node tools/stage-public.mjs [--output DIRECTORY]');
  console.log(JSON.stringify(await stagePublic(args.length?{destination:resolve(args[1])}:{})));
}
