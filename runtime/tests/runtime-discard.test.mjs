import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Worker, MessageChannel } from 'node:worker_threads';
import { test } from 'node:test';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const pre = read('../OpenJDK/browser/pre.js');
const builder = read('../tools/build-wasmjvm.mjs');
const worker = read('../OpenJDK/browser/gpu-rpc-worker.js');
const host = read('../web/webgpu-host.js');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const settle = () => new Promise(resolve => setImmediate(resolve));

function moduleEnvironment() {
  const Module = {};
  const sandbox = {Module, ENVIRONMENT_IS_PTHREAD:false, ENVIRONMENT_IS_NODE:true,
    setTimeout, clearTimeout, Promise, console};
  vm.runInNewContext(pre, sandbox, {filename:'actual-pre.js'});
  return {Module, sandbox, api:Module.mcWebRuntime};
}

test('actual loader terminates only its real used/idle workers once and prevents late bootstrap', async () => {
  const e = moduleEnvironment(), workers = [];
  const unrelated = new Worker('setInterval(()=>{},10000)',{eval:true});
  const terminating=[];
  try {
    const first=e.api.discard();
    assert.equal(e.api.discard(),first);
    assert.equal((await first).saved,false);
    assert.equal(e.Module.noInitialRun,true);
    const used=new Worker('setInterval(()=>{},10000)',{eval:true});
    const idle=new Worker('setInterval(()=>{},10000)',{eval:true});
    workers.push(used,idle);
    e.sandbox.PThread={pthreads:{one:used},unusedWorkers:[idle],terminateAllThreads(){
      for(const w of [...Object.values(this.pthreads),...this.unusedWorkers])terminating.push(w.terminate());
      this.pthreads={};this.unusedWorkers=[];
    }};
    for(const fn of e.Module.preRun)fn();
    for(const fn of e.Module.postRun)fn();
    await Promise.all(terminating);
    assert.equal(used.threadId,-1);assert.equal(idle.threadId,-1);
    assert.notEqual(unrelated.threadId,-1);
    assert.equal(e.api.state.usedPthreadTerminationRequests,1);
    assert.equal(e.api.state.idlePthreadTerminationRequests,1);
    assert.equal(e.sandbox.__mcWebOut,undefined);
  } finally {await Promise.all([...workers,unrelated].map(w=>w.terminate()));}
});

function pageEnvironment() {
  const events=new EventTarget(), flush=deferred(), calls=[];
  const start=builder.indexOf('let runtimeTerminal = false;');
  const end=builder.indexOf("let controlsMessage = '';",start);
  assert.ok(start>0&&end>start);
  const sandbox={console,runtimeDiscardRequested:false,playButton:{},installButton:{},mcWebGameStorage:{flush(){calls.push('flush');return flush.promise;}},
    mcWebAudio:{dispose(){calls.push('audio');}},gameStopped(){calls.push('controls');},
    mobileWake:{stop(){calls.push('wake');}},write(){},
    addEventListener:events.addEventListener.bind(events)};
  vm.createContext(sandbox);vm.runInContext(builder.slice(start,end),sandbox);
  sandbox.api={state:{phase:'active'},discard(){calls.push('discard');return Promise.resolve({version:1,phase:'discarded',saved:false});}};
  vm.runInContext('runtimeApi = api;',sandbox);
  return {sandbox,events,flush,calls,api:sandbox.mcWebRuntime};
}
function hide(events,persisted){const event=new Event('pagehide');Object.defineProperty(event,'persisted',{value:persisted});events.dispatchEvent(event);}

test('actual page coordinator commits before ownership release and deduplicates terminal calls',async()=>{
  const e=pageEnvironment(), first=e.api.discard();
  assert.equal(first,e.api.discard());
  assert.deepEqual(e.calls,['flush']);
  e.flush.resolve();
  const result=await first;
  assert.deepEqual(e.calls,['flush','controls','wake','discard']);
  assert.equal(result.saved,false);
  assert.equal(e.api.state.phase,'discarded');
});

test('failed persistence keeps the runtime intact and retryable',async()=>{
  const e=pageEnvironment(), failure=new Error('IndexedDB quota');
  const first=e.api.discard();e.flush.reject(failure);
  await assert.rejects(first,error=>error===failure);
  assert.deepEqual(e.calls,['flush']);
  assert.equal(e.api.state.phase,'active');
  e.sandbox.mcWebGameStorage.flush=async()=>e.calls.push('flush-retry');
  await e.api.discard();
  assert.deepEqual(e.calls,['flush','flush-retry','controls','wake','discard']);
});

test('ordinary hiding and BFCache pagehide retain resources; permanent pagehide flushes first',async()=>{
  const e=pageEnvironment();
  e.events.dispatchEvent(new Event('visibilitychange'));hide(e.events,true);
  await settle();assert.deepEqual(e.calls,[]);
  hide(e.events,false);assert.deepEqual(e.calls,['flush']);
  e.flush.resolve();await e.api.discard();
  assert.equal(e.calls.at(-1),'discard');
});

test('actual GPU host releases native ownership and caches once, even if unconfigure throws',()=>{
  const match=host.match(/    discard\(\) \{([\s\S]*?)\n    \},\n/);assert.ok(match);
  const calls=[],sandbox={discarded:false,discardedResources:null,objects:new Map([[1,{}],[2,{}]]),
    context:{unconfigure(){calls.push('unconfigure');throw Error('native context failure');}},
    device:{destroy(){calls.push('destroy');}},adapter:{},mcWebPump:{running:true,callback(){}},
    heartbeatInterval:1,countersInterval:2,clearInterval(id){calls.push('timer:'+id);},texInventory:[{}],
    _bindGroupCache:new Map([[1,{}]]),_bindGroupDependencies:new Map([[1,{}]]),_bindGroupDependents:new WeakMap(),
    _shaderModules:new Map(),_errorModules:new Map(),regionClearPipelines:new Map(),loweringIndexBuffers:new Map(),
    _virtualCanvas:{},compositeSource:{},compositePipeline:{},compositeSampler:{}};
  const discard=vm.runInNewContext('({discard(){'+match[1]+'}}).discard',sandbox);
  const first=discard();assert.equal(discard(),first);
  assert.deepEqual(calls,['timer:1','timer:2','unconfigure','destroy']);
  assert.equal(first.deviceDestroyed,true);assert.equal(first.errors.length,1);
  assert.equal(sandbox.objects.size,0);assert.equal(sandbox._bindGroupDependencies.size,0);
  assert.equal(sandbox.device,null);assert.equal(sandbox._virtualCanvas,null);
});

test('actual GPU worker acknowledges terminal discard and closes its ports once',()=>{
  const messages=[],listeners=[],calls=[],channels=[];
  class Channel{constructor(){this.port1={close(){calls.push('port1');}};this.port2={close(){calls.push('port2');}};channels.push(this);}}
  const sandbox={TextEncoder,TextDecoder,URLSearchParams,MessageChannel:Channel,
    location:{search:''},console,postMessage(value){messages.push(value);},
    setInterval(){return 88;},clearInterval(id){calls.push('timer:'+id);},performance:{now:()=>0},mcWebGpu:{discard(){calls.push('gpu');return {deviceDestroyed:true};}},
    self:{addEventListener(type,callback){listeners.push(callback);},close(){calls.push('close');}}};
  vm.runInNewContext(worker,sandbox);
  listeners[0]({data:{mcwebDiscard:{version:1}}});listeners[0]({data:{mcwebDiscard:{version:1}}});
  assert.deepEqual(calls,['timer:88','port1','port2','gpu','close']);
  assert.equal(messages.length,1);assert.equal(messages[0].mcwebDiscarded.resources.deviceDestroyed,true);
});

test('actual audio disposal closes context and cannot resurrect on late fetch/gesture',async()=>{
  const fetched=deferred(),events=new EventTarget(),calls=[];
  const node=()=>({gain:{value:0},threshold:{},knee:{},ratio:{},attack:{},release:{},connect(){},disconnect(){calls.push('disconnect');}});
  class Context{constructor(){calls.push('context');this.state='running';this.destination={};this.listener={setPosition(){},setOrientation(){}};}createGain(){return node();}createDynamicsCompressor(){return node();}close(){calls.push('close');return Promise.resolve();}}
  const sandbox={document:events,location:{search:''},URLSearchParams,AudioContext:Context,console,
    fetch(){return fetched.promise;},setTimeout,clearTimeout,URL,Blob};
  vm.runInNewContext(read('../web/audio-host.js'),sandbox);
  const api=sandbox.mcWebAudio;api.ensureContext();const definitions=api.loadDefinitions();
  const first=api.dispose();assert.equal(api.dispose(),first);await first;
  fetched.resolve({ok:true,json:async()=>({music:{sounds:['one']}})});await definitions;
  events.dispatchEvent(new Event('pointerdown'));
  assert.equal(api.state(),'closed');assert.equal(api.resolvedCount(),0);
  assert.equal(api.playInstance('music','music',1,1,true),0);
  assert.equal(calls.filter(x=>x==='context').length,1);assert.equal(calls.filter(x=>x==='close').length,1);
});

function gpuPageEnvironment({acknowledges=true,created,terminateThrows=false}={}) {
  const timers=new Map(),calls=[],events=new EventTarget();let timerId=0;
  class OwnedWorker extends EventTarget {
    postMessage(message){if(message.mcwebDiscard){calls.push('request');if(acknowledges)queueMicrotask(()=>{
      const event=new Event('message');Object.defineProperty(event,'data',{value:{mcwebDiscarded:{version:1,resources:{deviceDestroyed:true}}}});this.dispatchEvent(event);
    });}}
    terminate(){calls.push('terminate');if(terminateThrows)throw Error('Native worker termination failure');}
  }
  const originalPost=OwnedWorker.prototype.postMessage;
  const Module={mcWebCanvas:{},onMcWebRuntimeCreated:created};
  const sandbox={Module,ENVIRONMENT_IS_PTHREAD:false,Worker:OwnedWorker,URLSearchParams,AbortController,
    location:{search:''},mcWebAudio:{dispose(){calls.push('audio');return Promise.resolve();}},console,
    setInterval(){return 9;},clearInterval(id){calls.push('interval:'+id);},
    setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},
    addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),
    document:{head:{appendChild(){}},createElement(){return {};},pointerLockElement:null}};
  vm.runInNewContext(pre,sandbox);
  return {Module,sandbox,timers,calls,OwnedWorker,originalPost};
}

test('actual page-owned GPU bridge clears polling/globals and restores only its Worker hook after acknowledgement',async()=>{
  const e=gpuPageEnvironment();assert.notEqual(e.OwnedWorker.prototype.postMessage,e.originalPost);
  const promise=e.Module.mcWebRuntime.discard();const result=await promise;
  assert.equal(e.Module.mcWebRuntime.discard(),promise);
  assert.equal(result.gpu.acknowledged,true);
  assert.deepEqual(e.calls,['interval:9','request','audio','terminate']);
  assert.equal(e.sandbox.__mcWebGpuWorker,undefined);assert.equal(e.sandbox.__mcWebJoin,undefined);
  assert.equal(e.OwnedWorker.prototype.postMessage,e.originalPost);
  assert.equal(e.Module.mcWebCanvas,null);assert.equal(e.timers.size,0);
});

test('a wedged GPU worker is terminated after the bounded acknowledgement deadline',async()=>{
  const e=gpuPageEnvironment({acknowledges:false});const promise=e.Module.mcWebRuntime.discard();
  await settle();assert.equal(e.calls.includes('terminate'),false);
  for(const timer of [...e.timers.values()])timer();
  const result=await promise;
  assert.equal(result.gpu.acknowledged,false);assert.equal(e.calls.filter(x=>x==='terminate').length,1);
  assert.equal(e.sandbox.__mcWebGpuWorker,undefined);assert.equal(e.timers.size,0);
});

test('terminal request during actual title-assets/mobile preparation continuation never reaches factory stage',async()=>{
  const start=builder.indexOf('  const titleAssets = await Promise.race([');
  const end=builder.indexOf("    const { prepareVmIdentity } = await import('./vm-identity.mjs');",start);
  assert.ok(start>0&&end>start);
  const actual=builder.slice(start,end);
  for(const phase of ['assets','mobile']){
    const e=pageEnvironment(),assets=deferred(),prepared=deferred();
    vm.runInContext('runtimeApi = null;',e.sandbox);
    e.sandbox.upstream={fetch:()=>assets.promise};
    e.sandbox.mobile={prepareMobileRuntime(){e.calls.push('prepare');return prepared.promise;}};
    Object.assign(e.sandbox,{memoryWasmMaxMiB:null,mobileRuntimeConfig:{},loadingStatus(){},setTimeout(){return 0;}});
    const launch=vm.runInContext('(async()=>{'+actual+'globalThis.reachedFactoryStage=true;})()',e.sandbox);
    if(phase==='mobile'){assets.resolve({ok:false});await settle();assert.ok(e.calls.includes('prepare'));}
    e.flush.resolve();await e.api.discard();
    assets.resolve({ok:false});prepared.resolve();await launch;
    assert.equal(e.sandbox.reachedFactoryStage,undefined,phase);
    if(phase==='assets')assert.equal(e.calls.includes('prepare'),false);
  }
});

test('a late Module callback after terminal completion rejects bootstrap and gets its own cleanup',async()=>{
  const e=pageEnvironment();vm.runInContext('runtimeApi = null;',e.sandbox);
  e.flush.resolve();await e.api.discard();
  let releases=0;e.sandbox.late={discard(){releases++;return Promise.resolve({phase:'discarded',saved:false});}};
  assert.equal(vm.runInContext('runtimeCreated(late)',e.sandbox),false);
  await settle();assert.equal(releases,1);assert.equal(e.api.state.phase,'discarded');
  const late=gpuPageEnvironment({created:()=>false});
  assert.equal(late.Module.noInitialRun,true);
  assert.equal(late.sandbox.__mcWebGpuWorker,undefined,'Cancelled factory never creates a GPU worker');
  await late.Module.mcWebRuntime.discard();
});

test('actual terminal callback keeps Return usable after cleanup success or failed-save retry',async()=>{
  const start=builder.indexOf('function gameStopped()'),end=builder.indexOf('fullscreenButton.onclick =',start);
  for(const fails of [false,true]){
    const e=pageEnvironment(),loading={hidden:false},canvas={classList:{remove(){}}};
    Object.assign(e.sandbox,{gameReady:true,status:{},fullscreenButton:{},
      gameControls:{setReady(){},releaseAll(){}},
      document:{body:{dataset:{launcherState:'game'}},getElementById(id){return id==='game-loading'?loading:canvas;}},
      async mcWebQuitToLauncher(){await e.sandbox.mcWebGameStorage.flush();await e.api.discard();e.calls.push('navigate');}});
    vm.runInContext(builder.slice(start,end),e.sandbox);
    vm.runInContext("runtimeStopped('Exited.');",e.sandbox);
    assert.equal(e.sandbox.playButton.disabled,false,'Return stays enabled while automatic terminal cleanup runs');
    if(fails)e.flush.reject(Error('disk full'));else e.flush.resolve();
    await settle();
    assert.equal(e.sandbox.playButton.disabled,false,'Settled cleanup must not trap the terminal document');
    assert.equal(e.sandbox.playButton.textContent,'Return to launcher');
    if(fails){assert.equal(e.calls.includes('discard'),false);await e.sandbox.playButton.onclick();assert.equal(e.sandbox.playButton.disabled,false);}
    e.sandbox.mcWebGameStorage.flush=async()=>{};
    await e.sandbox.playButton.onclick();assert.equal(e.calls.at(-1),'navigate');
  }
});

test('native Worker termination errors still settle terminal cleanup and release other owners',async()=>{
  const e=gpuPageEnvironment({terminateThrows:true});
  const result=await e.Module.mcWebRuntime.discard();
  assert.equal(result.phase,'discard-failed');assert.equal(result.gpu.terminationRequested,false);
  assert.match(result.errors[0],/termination failure/);assert.ok(e.calls.includes('audio'));
  assert.equal(e.sandbox.__mcWebGpuWorker,undefined);assert.equal(e.Module.mcWebCanvas,null);
});
