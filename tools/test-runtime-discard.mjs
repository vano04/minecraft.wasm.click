import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const deferred = () => { let resolve, reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('actual auth Return awaits flush and teardown before replacing the document',async()=>{
  const text=fs.readFileSync(new URL('../public/auth/launcher-ui.js',import.meta.url),'utf8');
  const prefix=text.slice(0,text.indexOf('  globalThis.mcWebRuntimeStopped'))+'})();';
  const flushed=deferred(),released=deferred(),calls=[];
  const sandbox={mcWebGameStorage:{flush(){calls.push('flush');return flushed.promise;}},
    mcWebRuntime:{discard(){calls.push('discard');return released.promise;}},
    gameStopped(){calls.push('controls');},document:{exitPointerLock(){},addEventListener(){}},
    location:{replace(url){calls.push('navigate:'+url);}}};
  vm.runInNewContext(prefix,sandbox);
  const quit=sandbox.mcWebQuitToLauncher();assert.equal(sandbox.mcWebQuitToLauncher(),quit);
  assert.deepEqual(calls,['flush']);flushed.resolve();await settle();assert.deepEqual(calls,['flush','discard']);
  released.resolve();await quit;assert.equal(calls.at(-1),'navigate:/');
});


if (process.argv[2]) {
  const {join,resolve} = await import('node:path');
  const {tmpdir} = await import('node:os');
  const {spawnSync} = await import('node:child_process');
  const bundle=resolve(process.argv[2]), source=resolve(process.argv[3] || '');
  if (!process.argv[3]) throw Error('Usage: node tools/test-runtime-discard.mjs BUNDLE SOURCE_ROOT');
  const loader=fs.readFileSync(join(bundle,'javavm.js'),'utf8');
  const start=loader.indexOf('// Emscripten resolves a side');
  const end=loader.indexOf('// end include:',start);
  assert.ok(start>=0&&end>start,'Linked loader must contain its actual pre.js include');
  const pre=loader.slice(start,end),html=fs.readFileSync(join(bundle,'index.html'),'utf8');
  const {launcherPage}=await import('../server/launcher.mjs');
  const themed=launcherPage(html,{profile:{name:'FixturePlayer',id:'1'.repeat(32)}},{});
  const page=[...themed.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  const prepareStart=page.indexOf('    await globalThis.mcWebGameStorage.prepare();');
  const factoryStart=page.indexOf('    await createJavaVM({',prepareStart);
  assert.ok(prepareStart>0&&factoryStart>prepareStart);
  const continuation=page.slice(prepareStart,factoryStart);
  assert.equal(continuation.split('if (runtimeDiscardRequested) return;').length,2,'One guard follows authenticated preparation');
  for(const cancelled of [false,true]){
    const prepared=deferred(),events=[];
    const sandbox={runtimeDiscardRequested:false,__mcWebVerified:{session:{profile:{}}},
      mcWebGameStorage:{prepare:async()=>events.push('storage')},
      mcWebOwnProfile:{prepare:()=>{events.push('profile');return prepared.promise;}},
      createJavaVM:async()=>events.push('factory')};
    const run=vm.runInNewContext('(async()=>{'+continuation+'await createJavaVM({});})()',sandbox);
    await settle();sandbox.runtimeDiscardRequested=cancelled;prepared.resolve();await run;
    assert.deepEqual(events,cancelled?['storage','profile']:['storage','profile','factory']);
  }
  console.log('PASS actual themed page cancels after pending own-profile preparation before factory entry');
  assert.ok(page?.includes('function discardGameRuntime()'),'Actual generated page must own terminal cleanup');
  let fixture=fs.readFileSync(join(source,'tests/runtime-discard.test.mjs'),'utf8');
  fixture=fixture.replace("const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');",
    'const read = path => fs.readFileSync('+JSON.stringify(bundle)+' + "/" + path.split("/").at(-1), "utf8");');
  fixture=fixture.replace("const pre = read('../OpenJDK/browser/pre.js');",'const pre = '+JSON.stringify(pre)+';');
  fixture=fixture.replace("const builder = read('../tools/build-wasmjvm.mjs');",'const builder = '+JSON.stringify(page)+';');
  const temporary=fs.mkdtempSync(join(tmpdir(),'mcweb-linked-discard-'));
  try {
    const file=join(temporary,'actual-linked-runtime-discard.test.mjs');fs.writeFileSync(file,fixture);
    const result=spawnSync(process.execPath,['--test',file],{encoding:'utf8'});
    process.stdout.write(result.stdout);process.stderr.write(result.stderr);
    assert.equal(result.status,0,'Actual linked loader/page/worker/host/audio lifecycle fixture failed');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
}
