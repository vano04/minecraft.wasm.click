import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test as nodeTest } from 'node:test';

const candidate = fs.readFileSync(new URL('../web/audio-host.js', import.meta.url), 'utf8');
const workerEnvironment = fs.readFileSync(new URL('../OpenJDK/browser/worker-env.js', import.meta.url), 'utf8');
const pageBootstrap = fs.readFileSync(new URL('../OpenJDK/browser/pre.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject}; };
const flush = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };
const definitions = {
  music: {sounds: [{name:'music/one',stream:true,weight:1,volume:0.4,pitch:0.5}, {name:'music/two',stream:true,weight:3}]},
  effect: {sounds:[{name:'effect',volume:0.4,pitch:0.5}]},
  explosion: {sounds:['explosion']},
  distant: {sounds:[{name:'distant',volume:0.5,attenuation_distance:32}]},
};

function response(parts=[new Uint8Array([1,2,3])], length='3') {
  let index=0;
  const state={cancelled:0,released:0,reads:0};
  const reader={
    async read(){state.reads++;return index<parts.length ? {done:false,value:parts[index++]} : {done:true};},
    async cancel(){state.cancelled++;}, releaseLock(){state.released++;},
  };
  const value={ok:true,headers:{get:()=>length},body:{getReader:()=>reader,async cancel(){state.cancelled++;}}};
  return {value,state,reader};
}

function environment(source=candidate, options={}) {
  const state={nodes:[],audio:[],fetch:[],receiver:[],urls:new Map(),revoked:[],decode:0,warnings:[],rng:0,active:false,now:0,timers:new Map(),nextTimer:1};
  state.advance=ms=>{state.now+=ms;for(const [id,t]of state.timers)if(t.at<=state.now){state.timers.delete(id);t.run();}};
  const mediaOwners=new WeakSet();
  function node(kind){
    const n={kind,connections:[],disconnects:0,connect(to){this.connections.push(to);},disconnect(){this.disconnects++;this.connections=[];}};
    state.nodes.push(n);return n;
  }
  const param=()=>({value:0});
  class Context {
    constructor(){this.state='running';this.currentTime=0;this.destination=node('destination');this.listener=options.legacyListener
      ? {setPosition(...position){this.position=position;},setOrientation(...orientation){this.orientation=orientation;}}
      : Object.fromEntries(['positionX','positionY','positionZ','forwardX','forwardY','forwardZ','upX','upY','upZ'].map(key=>[key,param()]));state.context=this;}
    createGain(){return Object.assign(node('gain'),{gain:param()});}
    createDynamicsCompressor(){return Object.assign(node('limiter'),Object.fromEntries(['threshold','knee','ratio','attack','release'].map(k=>[k,param()])));}
    createPanner(){return Object.assign(node('panner'),{positionX:param(),positionY:param(),positionZ:param()});}
    createBufferSource(){return Object.assign(node('buffer'),{playbackRate:param(),start(){options.bufferStart?.(this);this.started=true;},stop(){this.stopped=true;}});}
    createMediaElementSource(element){if(options.sourceThrows)throw Error('source failure');if(mediaOwners.has(element))throw Error('Element already owns a MediaElementAudioSourceNode');mediaOwners.add(element);return Object.assign(node('media'),{element});}
    async decodeAudioData(bytes){state.decode++;return options.decode ? options.decode(bytes) : {duration:1};}
    async resume(){this.state='running';}
    async close(){this.state='closed';}
  }
  class Audio {
    constructor(){this.paused=true;this.pauseCount=0;this.loadCount=0;this.playCalls=[];this.currentTime=0;this.defaultPlaybackRate=this.playbackRate=1;this.volume=1;this.muted=false;state.audio.push(this);}
    set src(value){this._src=value;this.playbackRate=this.defaultPlaybackRate;}
    get src(){return this._src||'';}
    play(){
      this.playCalls.push({src:this.src,active:state.active,now:state.now,muted:this.muted,volume:this.volume});
      if(options.requireGesture&&!state.active&&!this.authorized)return Promise.reject(Object.assign(Error('Element needs user activation'),{name:'NotAllowedError'}));
      if(state.active&&!this.muted&&this.volume>0)this.authorized=true;
      this.paused=false;return options.play ? options.play(this) : Promise.resolve();
    }
    pause(){this.paused=true;this.pauseCount++;}
    removeAttribute(name){if(name==='src')this.src='';}
    load(){this.loadCount++;this.playbackRate=this.defaultPlaybackRate;}
  }
  class LocalURL extends URL {
    static createObjectURL(blob){const id='blob:owned-'+(state.urls.size+state.revoked.length+1);state.urls.set(id,blob);return id;}
    static revokeObjectURL(id){state.revoked.push(id);state.urls.delete(id);}
  }
  const math=Object.create(Math);math.random=()=>state.rng;
  const sandbox={URL:LocalURL,URLSearchParams,Blob,Uint8Array,Math:math,Audio,AudioContext:Context,
    location:{href:'https://audio-fixture.invalid/testing/',origin:'https://audio-fixture.invalid',search:options.search||''},
    document:{addEventListener(){}}, console:{log(){},warn(...x){state.warnings.push(x);}},
    navigator:{userActivation:{get isActive(){return state.active;}}},
    setTimeout(run,ms){const id=state.nextTimer++;state.timers.set(id,{run,at:state.now+ms});return id;},clearTimeout(id){state.timers.delete(id);},
    async fetch(url){state.fetch.push(url);const result=url.endsWith('sounds.json') ? options.definitions : options.nonstream;
      return typeof result==='function' ? result(url) : result || (url.endsWith('sounds.json') ? {ok:true,json:async()=>definitions} : {ok:true,arrayBuffer:async()=>new ArrayBuffer(4)});},
    mcWebUpstream: options.missingReceiver ? {} : {installed:{fetch(url){state.receiver.push(url);return options.receiver ? options.receiver(url) : Promise.resolve(response().value);},assetDirectUrl:async()=> 'https://cached.example/direct.ogg'}},
  };
  vm.runInNewContext(source,sandbox,{filename:'audio-host.js'});
  return {api:sandbox.mcWebAudio,state,sandbox};
}

let passed=0;
async function test(name, fn){await nodeTest(name, async()=>{await fn();passed++;});}
const stream=async(e,{loop=false,pitch=1,volume=0.5,position=true}={})=>{
  const handle=e.api.playInstance('music','music',volume,pitch,loop);
  if(position)e.api.positionInstance(handle,1,2,3);
  await flush();return handle;
};
const clean=e=>{assert.equal(e.api.liveCount(),0);assert.equal(e.state.urls.size,0);assert.equal(e.api.diagnostics().streaming.ownedObjectURLs,0);};

await test('prepared weighted stream retains metadata only and uses graph gains/position',async()=>{
  const e=environment();const selected=await e.api.preloadEvent('music');
  assert.match(selected,/music\/one.ogg$/);assert.equal(e.state.receiver.length,0);assert.equal(e.state.decode,0);assert.equal(e.state.urls.size,0);
  e.state.rng=0.99;
  const h=await stream(e,{loop:true,pitch:2});
  assert.match(e.state.receiver[0],/music\/one.ogg$/);assert.equal(e.state.receiver.length,1);assert.equal(e.state.decode,0);
  const a=e.state.audio[0], media=e.state.nodes.find(n=>n.kind==='media'), gain=media.connections[0], panner=gain.connections[0];
  assert.equal(a.loop,true);assert.equal(a.preservesPitch,false);assert.equal(a.playbackRate,1);assert.equal(a.volume,1);
  assert.equal(gain.gain.value,0.2);assert.equal(panner.kind,'panner');assert.equal(panner.positionZ.value,3);
  e.api.setCategoryVolume('music',0.25);e.api.setVolume(0.5);e.api.setListener(4,5,6);e.api.positionInstance(h,7,8,9);
  assert.equal(a.volume,1);assert.equal(panner.positionZ.value,9);assert.equal(panner.connections[0].gain.value,0.25);
  assert.equal(panner.connections[0].connections[0].gain.value,0.35);assert.equal(e.state.context.listener.positionX.value,4);
  assert.equal(e.api.diagnostics().preparedEvents,0);assert.equal(e.api.diagnostics().streaming.starts,1);
  a.onended();e.api.stopInstance(h);e.api.stopAll();clean(e);assert.equal(e.state.revoked.length,1);assert.equal(a.pauseCount,1);assert.equal(a.loadCount,1);
  assert.equal(media.disconnects,1);assert.equal(gain.disconnects,1);assert.equal(panner.disconnects,1);
});

await test('unprepared stream uses weighted metadata and supported rate bounds',async()=>{
  const e=environment();e.state.rng=0.99;const h=await stream(e,{pitch:32,position:false});
  assert.match(e.state.receiver[0],/music\/two.ogg$/);assert.equal(e.state.audio[0].playbackRate,16);
  assert.equal(e.state.nodes.filter(n=>n.kind==='panner').length,0);e.api.stopInstance(h);clean(e);
});

await test('verified receiver Response without Content-Length plays encoded Blob only',async()=>{
  const e=environment(candidate,{receiver:()=>Promise.resolve(new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/ogg'}}))});
  const h=await stream(e);assert.equal(e.state.audio.length,1);assert.equal(e.state.decode,0);assert.equal(e.api.diagnostics().streaming.activeHandles[0].encodedBytes,3);
  const blob=[...e.state.urls.values()][0];assert.equal(blob.type,'audio/ogg');assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())],[1,2,3]);e.api.stopInstance(h);clean(e);
});

await test('stop before definitions resolves prevents transport and playback',async()=>{
  const d=deferred(), e=environment(candidate,{definitions:d.promise});
  const h=e.api.playInstance('music','music',1,1,false);e.api.stopInstance(h);d.resolve({ok:true,json:async()=>definitions});await flush();
  clean(e);assert.equal(e.state.receiver.length,0);assert.equal(e.state.audio.length,0);
});

await test('stop during receiver request discards response without claiming abort',async()=>{
  const d=deferred(), e=environment(candidate,{receiver:()=>d.promise}), r=response();
  const h=await stream(e);assert.equal(e.api.isPlaying(h),true);e.api.stopInstance(h);d.resolve(r.value);await flush();
  clean(e);assert.equal(r.state.cancelled,1);assert.equal(r.state.reads,0);assert.equal(e.state.audio[0].playCalls.length,0);assert.equal(e.api.diagnostics().streaming.pool.busy,0);assert.equal(e.api.diagnostics().streaming.lateDiscards,1);
});

await test('stop during body read cancels once, releases reader and does not create URL',async()=>{
  const r=response(), d=deferred();r.reader.read=()=>d.promise;r.reader.cancel=async()=>{r.state.cancelled++;d.resolve({done:true});};
  const e=environment(candidate,{receiver:()=>Promise.resolve(r.value)}),h=await stream(e);
  e.api.stopInstance(h);await flush();clean(e);assert.equal(r.state.cancelled,1);assert.equal(r.state.released,1);assert.equal(e.state.audio[0].playCalls.length,0);assert.equal(e.api.diagnostics().streaming.pool.busy,0);
});

for(const reject of [false,true]) await test('stop during pending play ignores late '+(reject?'rejection':'fulfillment'),async()=>{
  const d=deferred(),e=environment(candidate,{play:()=>d.promise}),h=await stream(e),a=e.state.audio[0];
  e.api.stopInstance(h);reject?d.reject(Error('late')):d.resolve();await flush();clean(e);
  assert.equal(e.state.revoked.length,1);assert.equal(a.pauseCount,1);assert.equal(e.api.diagnostics().streaming.starts,0);assert.equal(e.api.diagnostics().streaming.failures,0);
});

for(const reason of ['play','source','element']) await test(reason+' error cleans stream ownership',async()=>{
  const e=environment(candidate,{sourceThrows:reason==='source',play:reason==='play'?()=>Promise.reject(Error('blocked')):undefined});
  const h=await stream(e);if(reason==='element')e.state.audio[0].onerror();await flush();clean(e);
  assert.equal(e.api.isPlaying(h),false);assert.equal(e.state.revoked.length,reason==='source'?0:1);assert.equal(e.api.diagnostics().streaming.failures,1);assert.equal(e.state.decode,0);
});

for(const reason of ['header','body','mismatch','zero','missingbody','badstatus','receiver','missingreceiver']) await test('bounded transport rejects '+reason+' without raw audio fetch or decode',async()=>{
  const r=response();
  if(reason==='header')r.value.headers.get=()=>String(16*1024*1024+1);
  if(reason==='body'){r.value.headers.get=()=>null;r.reader.read=async()=>({done:false,value:new Uint8Array(16*1024*1024+1)});}
  if(reason==='mismatch')r.value.headers.get=()=> '4';
  if(reason==='zero'){r.value.headers.get=()=> '0';r.reader.read=async()=>({done:true});}
  if(reason==='missingbody')r.value.body=null;
  if(reason==='badstatus')r.value.ok=false;
  const e=environment(candidate,{missingReceiver:reason==='missingreceiver',receiver:()=>reason==='receiver'?Promise.reject(Error('cache missing')):Promise.resolve(r.value)});
  await stream(e);await flush();clean(e);assert.equal(e.state.audio[0].playCalls.length,0);assert.equal(e.api.diagnostics().streaming.pool.busy,0);assert.equal(e.state.decode,0);assert.equal(e.state.fetch.length,1);assert.equal(e.api.diagnostics().streaming.failures,1);
});

await test('disable stops all streamed handles and releases each owned URL',async()=>{
  const e=environment();await stream(e);await stream(e);assert.equal(e.state.urls.size,2);e.api.setEnabled(false);await flush();clean(e);assert.equal(e.state.revoked.length,2);assert.equal(e.api.playInstance('music','music',1,1,false),0);
});

function bufferShape(e){const b=e.state.nodes.find(n=>n.kind==='buffer'),g=b.connections[0],p=g.connections[0];return {loop:b.loop,rate:b.playbackRate.value,gain:g.gain.value,panner:p.kind,position:[p.positionX.value,p.positionY.value,p.positionZ.value],maxDistance:p.maxDistance,category:p.connections[0].gain.value,master:p.connections[0].connections[0].gain.value};}
await test('the worker audio facade transports all nine pose values through the production page dispatcher',async()=>{
  const posted=[],worker={addEventListener(){},postMessage:message=>posted.push(JSON.parse(JSON.stringify(message)))};
  vm.runInNewContext(workerEnvironment,worker,{filename:'worker-env.js'});
  const pose=[-1000,64.5,2000,-0.36,-0.48,0.8,-0.64,0.768,0.024];
  worker.mcWebAudio.setListenerPose(...pose);
  assert.deepEqual(posted,[{mcwebAudio:{m:'setListenerPose',a:pose}}]);

  const e=environment();e.api.ensureContext();
  const dispatchStart=pageBootstrap.indexOf('    const playAudio = ({ m, a }) => {');
  const dispatchEnd=pageBootstrap.indexOf('    const audioInterval =',dispatchStart);
  assert.ok(dispatchStart>=0&&dispatchEnd>dispatchStart,'production page audio dispatcher must be present');
  const page=vm.createContext({mcWebAudio:e.api,audioHandles:new Map(),gpuWorker:{postMessage(){}},console:{warn(...args){throw Error(args.join(' '));}}});
  vm.runInContext(pageBootstrap.slice(dispatchStart,dispatchEnd)+'\nglobalThis.receiveAudio=playAudio;',page,{filename:'pre.js audio dispatcher'});
  page.receiveAudio(posted[0].mcwebAudio);
  const listener=e.state.context.listener;
  assert.deepEqual(['positionX','positionY','positionZ','forwardX','forwardY','forwardZ','upX','upY','upZ'].map(key=>listener[key].value),pose);
});

for(const legacyListener of [false,true])await test((legacyListener?'legacy':'modern')+' listener keeps the full camera pose before context creation and during stationary rotation',async()=>{
  const e=environment(candidate,{legacyListener});
  const read=()=>{const l=e.state.context.listener;return legacyListener ? [...l.position,...l.orientation]
    : ['positionX','positionY','positionZ','forwardX','forwardY','forwardZ','upX','upY','upZ'].map(key=>l[key].value);};
  e.api.setListenerPose(-1000,64.5,2000,-1,0,0,0,1,0);
  assert.equal(e.state.context,undefined);
  e.api.ensureContext();assert.deepEqual(read(),[-1000,64.5,2000,-1,0,0,0,1,0]);
  e.api.setListenerPose(-1000,64.5,2000,0,-1,0,0,0,1);
  assert.deepEqual(read(),[-1000,64.5,2000,0,-1,0,0,0,1]);
  e.api.setListener(4,5,6);assert.deepEqual(read(),[4,5,6,0,-1,0,0,0,1]);
});

await test('positional sound distance uses raw volume, sound metadata and the vanilla zero reference distance',async()=>{
  const e=environment();
  for(const [name,volume,distance,resolvedVolume]of [['explosion',4,64,1],['effect',4,25.6,0.4],['distant',4,64,0.5]]) {
    const handle=e.api.playInstance(name,'blocks',volume,1,false);e.api.positionInstance(handle,32,64,100);await flush();
    const panner=e.state.nodes.filter(n=>n.kind==='panner').at(-1);
    assert.equal(panner.refDistance,0);assert.equal(panner.maxDistance,distance);
    e.api.setCategoryVolume('blocks',0.1);e.api.setVolume(0.2);
    assert.equal(panner.maxDistance,distance);e.api.stopInstance(handle);
    const direct=environment(candidate,{search:'?mcweb_audio_direct'});direct.api.setVolume(0.1);
    const element=direct.api.playInstance(name,'blocks',volume,1,false);
    direct.api.positionInstance(element,distance/2,0,0);await flush();
    assert.ok(Math.abs(direct.state.audio[0].volume-volume*resolvedVolume*0.07*0.5)<0.00000001);
    direct.api.stopAll();clean(direct);
  }
});

await test('ordinary BufferSource preserves gain, pitch, position and decode reuse',async()=>{
  const e=environment();const h=e.api.playInstance('effect','blocks',0.5,2,true);e.api.positionInstance(h,1,2,3);await flush();
  e.api.setCategoryVolume('blocks',0.25);e.api.setVolume(0.5);
  assert.deepEqual(bufferShape(e),{loop:true,rate:1,gain:0.2,panner:'panner',position:[1,2,3],maxDistance:16,category:0.25,master:0.35});
  assert.equal(e.state.decode,1);assert.equal(e.state.audio.length,0);assert.equal(e.state.receiver.length,0);
  e.api.stopInstance(h);e.api.playInstance('effect','blocks',1,1,false);await flush();assert.equal(e.state.decode,1);assert.equal(e.state.fetch.length,2);
});

await test('a cached sound becomes positional when its separate position call arrives after playback starts',async()=>{
  const e=environment();
  const warm=e.api.playInstance('effect','blocks',1,1,false);await flush();e.api.stopInstance(warm);
  const handle=e.api.playInstance('effect','blocks',0.5,2,false);await flush();
  const buffer=e.state.nodes.filter(n=>n.kind==='buffer').at(-1),gain=buffer.connections[0],category=gain.connections[0];
  assert.equal(buffer.started,true);assert.equal(e.state.decode,1);
  e.api.positionInstance(handle,100,64,100);
  const panner=gain.connections[0];
  assert.equal(panner.kind,'panner');assert.equal(panner.connections[0],category);
  assert.equal(gain.connections.length,1);assert.equal(gain.disconnects,1);
  assert.deepEqual([panner.positionX.value,panner.positionY.value,panner.positionZ.value],[100,64,100]);
  e.api.positionInstance(handle,101,65,102);
  assert.equal(gain.connections[0],panner);assert.equal(e.state.nodes.filter(n=>n.kind==='panner').length,1);
  assert.deepEqual([panner.positionX.value,panner.positionY.value,panner.positionZ.value],[101,65,102]);
  e.api.stopInstance(handle);e.api.stopInstance(handle);
  buffer.onended();
  assert.equal(e.api.isPlaying(handle),false);assert.equal(buffer.disconnects,1);
  assert.equal(gain.disconnects,2);assert.equal(panner.disconnects,1);
});

for(const action of ['ended','dispose'])await test('a late positional graph releases every owned node once on '+action,async()=>{
  const e=environment(),handle=e.api.playInstance('effect','blocks',0.5,1,false);await flush();
  const buffer=e.state.nodes.find(n=>n.kind==='buffer'),gain=buffer.connections[0];
  e.api.positionInstance(handle,100,64,100);const panner=gain.connections[0];
  if(action==='ended')buffer.onended();else await e.api.dispose();
  e.api.stopInstance(handle);
  assert.equal(e.api.isPlaying(handle),false);assert.equal(buffer.disconnects,1);
  assert.equal(gain.disconnects,2);assert.equal(panner.disconnects,1);
});

await test('master slider controls every category and preserves its value before context creation',async()=>{
  const e=environment();e.api.setCategoryVolume('master',0.2);
  const h=e.api.playInstance('effect','blocks',0.5,2,true);e.api.positionInstance(h,1,2,3);await flush();
  assert.equal(bufferShape(e).master,0.2*0.7);
  await stream(e,{position:false});
  const media=e.state.nodes.find(n=>n.kind==='media'),music=media.connections[0].connections[0];
  e.api.setCategoryVolume('music',0.25);e.api.setCategoryVolume('master',0);
  assert.equal(bufferShape(e).master,0);assert.equal(music.connections[0].gain.value,0);
  e.api.setCategoryVolume('master',0.5);
  assert.equal(bufferShape(e).master,0.35);assert.equal(music.gain.value,0.25);
});

await test('master mute before first playback is retained for direct media elements',async()=>{
  const e=environment(candidate,{search:'?mcweb_audio_direct'});
  e.api.setVolume(0);e.api.playInstance('effect','blocks',1,1,false);await flush();
  assert.equal(e.state.audio[0].volume,0);
  e.api.setCategoryVolume('master',0.5);assert.equal(e.state.audio[0].volume,0.4*0.35);
  e.api.setCategoryVolume('master',0);assert.equal(e.state.audio[0].volume,0);
});

await test('saved category volumes do not initialize disabled audio and apply when playback starts',async()=>{
  const e=environment(candidate,{search:'?mcweb_no_audio'});
  e.api.setCategoryVolume('master',0.5);e.api.setCategoryVolume('music',0);e.api.setCategoryVolume('blocks',0.25);
  assert.equal(e.api.state(),'uninitialized');assert.equal(e.state.nodes.length,0);
  e.api.setEnabled(true);
  const h=e.api.playInstance('effect','blocks',0.5,2,true);e.api.positionInstance(h,1,2,3);await flush();
  assert.equal(bufferShape(e).category,0.25);assert.equal(bufferShape(e).master,0.35);
});

for(const reason of ['fetch','decode'])await test('a transient '+reason+' failure shares concurrent work, retries and then reuses the successful buffer',async()=>{
  const failure=deferred(),decoded={duration:1};let unavailable=true;
  const e=environment(candidate,{
    nonstream:()=>unavailable&&reason==='fetch' ? failure.promise : {ok:true,arrayBuffer:async()=>new ArrayBuffer(4)},
    decode:()=>unavailable&&reason==='decode' ? failure.promise : decoded,
  });
  const play=()=>e.api.playInstance('effect','blocks',1,1,false);
  const first=play(),second=play();await flush();
  assert.equal(e.state.fetch.length,2);assert.equal(e.state.decode,reason==='decode'?1:0);
  assert.equal(e.api.isPlaying(first),true);assert.equal(e.api.isPlaying(second),true);
  failure.reject(Error('temporary '+reason+' failure'));await flush();
  assert.equal(e.api.diagnostics().requested,0);assert.equal(e.state.audio.length,2);
  e.api.stopAll();unavailable=false;
  const recovered=play(),concurrent=play();await flush();
  const buffers=e.state.nodes.filter(n=>n.kind==='buffer');
  assert.equal(e.state.fetch.length,3);assert.equal(e.state.decode,reason==='decode'?2:1);
  assert.equal(buffers.length,2);assert.equal(buffers.every(node=>node.started&&node.buffer===decoded),true);
  assert.equal(e.api.isPlaying(recovered),true);assert.equal(e.api.isPlaying(concurrent),true);
  e.api.stopAll();play();await flush();
  assert.equal(e.state.fetch.length,3);assert.equal(e.state.decode,reason==='decode'?2:1);
  assert.equal(e.state.nodes.filter(n=>n.kind==='buffer').at(-1).buffer,decoded);
  assert.equal(e.state.audio.length,2);assert.equal(e.api.diagnostics().decodedBuffers,1);
  assert.equal(e.api.diagnostics().missing.length,0);e.api.stopAll();clean(e);
});

await test('concurrent playback shares a failed definitions request and recovers on the next playback',async()=>{
  const failed=deferred(),retried=deferred();let definitionsRequests=0;
  const e=environment(candidate,{definitions:()=>++definitionsRequests===1 ? failed.promise : retried.promise});
  const play=()=>e.api.playInstance('effect','blocks',1,1,false);
  const first=play(),second=play();await flush();assert.equal(definitionsRequests,1);
  failed.reject(Error('temporary sounds.json failure'));await flush();
  assert.equal(e.api.isPlaying(first),false);assert.equal(e.api.isPlaying(second),false);
  assert.equal(e.state.decode,0);assert.equal(e.state.audio.length,0);
  const recovered=play(),concurrent=play();await flush();assert.equal(definitionsRequests,2);
  retried.resolve({ok:true,json:async()=>definitions});await flush();
  assert.equal(e.api.isPlaying(recovered),true);assert.equal(e.api.isPlaying(concurrent),true);
  assert.equal(e.state.nodes.filter(n=>n.kind==='buffer'&&n.started).length,2);
  assert.equal(e.state.fetch.length,3);assert.equal(e.state.decode,1);
  e.api.stopAll();play();await flush();
  assert.equal(definitionsRequests,2);assert.equal(e.state.fetch.length,3);assert.equal(e.state.decode,1);
  assert.equal(e.api.diagnostics().missing.length,0);e.api.stopAll();clean(e);
});

await test('a BufferSource start exception releases its graph and leaves cached audio usable',async()=>{
  let unavailable=true;
  const e=environment(candidate,{bufferStart:()=>{if(unavailable)throw Error('temporary source start failure');}});
  const failed=e.api.playInstance('effect','blocks',1,1,false);e.api.positionInstance(failed,1,2,3);await flush();
  const buffer=e.state.nodes.find(n=>n.kind==='buffer');
  assert.equal(e.api.isPlaying(failed),false);assert.equal(e.api.liveCount(),0);
  assert.equal(buffer.stopped,true);assert.equal(buffer.disconnects,1);
  assert.equal(e.state.nodes.find(n=>n.kind==='panner').disconnects,1);
  assert.equal(e.state.nodes.filter(n=>n.kind==='gain'&&n.connections.length===0).length,1);
  assert.equal(e.state.nodes.find(n=>n.kind==='gain'&&n.disconnects===1).connections.length,0);
  assert.equal(e.state.warnings.some(parts=>parts.includes('[mcweb-audio] could not start')),true);
  unavailable=false;
  const recovered=e.api.playInstance('effect','blocks',1,1,false);await flush();
  assert.equal(e.api.isPlaying(recovered),true);assert.equal(e.state.nodes.filter(n=>n.kind==='buffer').at(-1).started,true);
  assert.equal(e.state.decode,1);assert.equal(e.state.fetch.length,2);e.api.stopAll();clean(e);
});

await test('direct-only mode preserves media playback without fetching or decoding sound bytes',async()=>{
  const direct=environment(candidate,{search:'?mcweb_audio_direct'});direct.api.playInstance('music','music',1,1,false);await flush();assert.equal(direct.state.receiver.length,0);assert.equal(direct.state.decode,0);assert.equal(direct.state.audio.length,1);
});

await test('gesture priming is synchronous, finite, unmuted own silence and fully stopped after completion',async()=>{
  const e=environment(candidate,{requireGesture:true});e.state.active=true;
  const pending=e.api.prepareStreaming();
  assert.equal(e.state.audio.length,4);assert.equal(e.state.audio.every(a=>a.playCalls.length===1&&a.playCalls[0].active&&!a.playCalls[0].muted&&a.playCalls[0].volume===1),true);
  const blobs=[...e.state.urls.values()];assert.equal(blobs.length,4);
  e.state.active=false;
  const result=await pending;assert.equal(result.ready,4);assert.equal(result.errors.length,0);
  assert.equal(e.state.audio.every(a=>a.paused&&a.src===''),true);assert.equal(e.state.urls.size,0);
  assert.equal(e.state.nodes.filter(n=>n.kind==='media').every(n=>n.connections.length===0),true);
  assert.equal(e.state.fetch.length,0);assert.equal(e.state.receiver.length,0);assert.equal(e.state.decode,0);
  for(const blob of blobs){const bytes=new Uint8Array(await blob.arrayBuffer()),v=new DataView(bytes.buffer);assert.equal(blob.type,'audio/wav');assert.equal(bytes.length,1644);assert.equal(new TextDecoder().decode(bytes.subarray(0,4)),'RIFF');assert.equal(v.getUint16(22,true),1);assert.equal(v.getUint32(24,true),8000);assert.equal(v.getUint16(34,true),16);assert.equal(bytes.subarray(44).every(x=>x===0),true);}
  assert.equal((await e.api.prepareStreaming()).ready,4);assert.equal(e.state.audio.length,4);assert.equal(e.state.audio.every(a=>a.playCalls.length===1),true);
});

await test('delayed first stream and later weighted track reuse activated element/source after grace window',async()=>{
  const e=environment(candidate,{requireGesture:true});e.state.active=true;await e.api.prepareStreaming();e.state.active=false;e.state.now=7001;
  const api=e.api;vm.runInNewContext(candidate,e.sandbox,{filename:'audio-host-reloaded.js'});
  assert.equal(e.sandbox.mcWebAudio,api);assert.equal(e.state.audio.length,4);
  const first=await stream(e);const a=e.state.audio[0],media=e.state.nodes.filter(n=>n.kind==='media');
  assert.equal(e.api.isPlaying(first),true);assert.equal(e.api.diagnostics().streaming.starts,1);assert.equal(a.playCalls.at(-1).active,false);assert.equal(a.playCalls.at(-1).now,7001);
  assert.equal(a.playbackRate,0.5);assert.equal(a.defaultPlaybackRate,0.5);assert.equal(e.api.diagnostics().streaming.activeHandles[0].slotId,1);
  a.currentTime=1.25;assert.equal(e.api.diagnostics().streaming.activeHandles[0].currentTime,1.25);
  e.api.stopInstance(first);clean(e);assert.equal(e.api.diagnostics().streaming.pool.busy,0);assert.equal(a.src,'');assert.equal(media[0].connections.length,0);
  e.state.now=14002;e.state.rng=0.99;
  const second=await stream(e,{pitch:2});assert.equal(e.api.isPlaying(second),true);assert.match(e.state.receiver.at(-1),/music\/two.ogg$/);assert.equal(e.api.diagnostics().streaming.starts,2);
  assert.equal(e.state.audio.length,4);assert.equal(e.state.nodes.filter(n=>n.kind==='media').length,4);assert.equal(a.playCalls.length,3);assert.equal(a.playCalls.at(-1).active,false);assert.equal(a.playbackRate,2);
  e.api.stopAll();clean(e);assert.equal(e.state.decode,0);assert.equal(e.api.diagnostics().streaming.pool.busy,0);assert.equal(media.every(n=>n.connections.length===0),true);
});

await test('four legitimate concurrent streams stay intact; overflow fails before encoded fetch and freed slot is reusable',async()=>{
  const e=environment(candidate,{requireGesture:true});e.state.active=true;await e.api.prepareStreaming();e.state.active=false;
  const handles=[];for(let i=0;i<4;i++)handles.push(await stream(e));
  assert.equal(e.api.diagnostics().streaming.pool.busy,4);assert.equal(e.state.receiver.length,4);
  const extra=await stream(e);assert.equal(e.api.isPlaying(extra),false);assert.equal(e.api.diagnostics().streaming.pool.exhaustions,1);assert.equal(e.state.receiver.length,4);assert.equal(handles.every(h=>e.api.isPlaying(h)),true);
  const slot=e.api.diagnostics().streaming.activeHandles.find(x=>x.handle===handles[1]).slotId;
  e.api.stopInstance(handles[1]);const next=await stream(e);assert.equal(e.api.diagnostics().streaming.activeHandles.find(x=>x.handle===next).slotId,slot);
  assert.equal(e.state.audio.length,4);assert.equal(e.state.urls.size,4);e.api.stopAll();clean(e);
});

await test('disabled/no-gesture preparation has no side effects, and native denial is reported without PCM fallback',async()=>{
  const disabled=environment(candidate,{search:'?mcweb_no_audio'});assert.equal((await disabled.api.prepareStreaming()).disabled,true);assert.equal(disabled.state.audio.length,0);assert.equal(disabled.state.context,undefined);
  const e=environment(candidate,{requireGesture:true});const result=await e.api.prepareStreaming();assert.equal(result.errors.length,1);assert.equal(e.state.audio.length,0);
  const h=await stream(e);assert.equal(e.api.isPlaying(h),false);clean(e);assert.equal(e.api.diagnostics().streaming.failures,1);assert.equal(e.state.decode,0);
  e.state.active=true;const retry=await e.api.prepareStreaming();assert.equal(retry.ready,4);assert.equal(retry.errors.length,0);e.state.active=false;assert.equal(e.api.isPlaying(await stream(e)),true);e.api.stopAll();clean(e);
});

await test('failed priming cleans URLs and retries the same elements in a later gesture',async()=>{
  let reject=true;const e=environment(candidate,{play:()=>reject?Promise.reject(Error('native prime failed')):Promise.resolve()});e.state.active=true;
  const first=await e.api.prepareStreaming();assert.equal(first.ready,0);assert.equal(first.errors.length,4);assert.equal(e.state.urls.size,0);assert.equal(e.state.audio.every(a=>a.paused&&a.src===''),true);
  reject=false;const retry=await e.api.prepareStreaming();assert.equal(retry.ready,4);assert.equal(e.state.audio.length,4);assert.equal(e.state.nodes.filter(n=>n.kind==='media').length,4);assert.equal(e.state.urls.size,0);
});

await test('concurrent preparation shares native calls and reports pending denials to both callers',async()=>{
  const d=deferred(),e=environment(candidate,{play:()=>d.promise});e.state.active=true;const first=e.api.prepareStreaming();e.state.active=false;const second=e.api.prepareStreaming();
  assert.equal(e.state.audio.every(a=>a.playCalls.length===1),true);
  d.reject(Error('denied'));const results=await Promise.all([first,second]);assert.equal(results.every(r=>r.ready===0&&r.errors.length===4),true);assert.equal(e.state.urls.size,0);
});

await test('stop while priming is pending releases only its lease; late completion cannot resurrect it',async()=>{
  const d=deferred(),e=environment(candidate,{play:()=>d.promise});e.state.active=true;const preparation=e.api.prepareStreaming();e.state.active=false;
  const h=await stream(e);assert.equal(e.api.isPlaying(h),true);e.api.stopInstance(h);assert.equal(e.api.diagnostics().streaming.pool.busy,0);
  d.resolve();await preparation;await flush();clean(e);assert.equal(e.state.receiver.length,0);assert.equal(e.api.diagnostics().streaming.starts,0);assert.equal(e.api.diagnostics().streaming.pool.primeObjectURLs,0);
});

await test('late prior play rejection cannot stop a newer lease on the same element',async()=>{
  const d=deferred();let calls=0;const e=environment(candidate,{play:()=>++calls===1?d.promise:Promise.resolve()});
  const first=await stream(e);e.api.stopInstance(first);const second=await stream(e);assert.equal(e.api.isPlaying(second),true);
  d.reject(Object.assign(Error('old denial'),{name:'NotAllowedError'}));await flush();assert.equal(e.api.isPlaying(second),true);assert.equal(e.api.diagnostics().streaming.activeHandles[0].handle,second);assert.equal(e.state.audio.length,1);e.api.stopAll();clean(e);
});

for(const reject of [false,true])await test('priming deadline cleans a never-settling play; late '+(reject?'rejection':'fulfillment')+' cannot modify a retried lease',async()=>{
  const d=deferred();let pending=true;const e=environment(candidate,{play:()=>pending?d.promise:Promise.resolve()});e.state.active=true;
  const preparation=e.api.prepareStreaming();e.state.active=false;
  assert.equal(e.state.timers.size,4);e.state.advance(5001);const result=await preparation;
  assert.equal(result.ready,0);assert.equal(result.errors.length,4);assert.equal(result.errors.every(x=>x.includes('timed out')),true);
  assert.equal(e.state.urls.size,0);assert.equal(e.state.timers.size,0);assert.equal(e.state.audio.every(a=>a.paused&&a.src===''),true);
  assert.equal(e.api.diagnostics().streaming.pool.priming,0);assert.equal(e.api.diagnostics().streaming.pool.primeObjectURLs,0);
  pending=false;e.state.active=true;assert.equal((await e.api.prepareStreaming()).ready,4);e.state.active=false;const h=await stream(e);
  const a=e.state.audio[0],src=a.src,pauses=a.pauseCount;
  reject?d.reject(Error('old native rejection')):d.resolve();await flush();
  assert.equal(e.api.isPlaying(h),true);assert.equal(a.src,src);assert.equal(a.pauseCount,pauses);assert.equal(e.api.diagnostics().streaming.pool.ready,4);
  assert.equal(e.state.audio.length,4);assert.equal(e.state.nodes.filter(n=>n.kind==='media').length,4);e.api.stopAll();clean(e);
});
