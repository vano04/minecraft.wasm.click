import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const host=await readFile(process.argv[2]||new URL('../site/testing/webgpu-host.js',import.meta.url),'utf8');
const worker=await readFile(process.argv[3]||new URL('../site/testing/gpu-rpc-worker.js',import.meta.url),'utf8');
const pre=await readFile(process.argv[4]||new URL('../site/testing/javavm.js',import.meta.url),'utf8');
const take=(source,a,b)=>{assert.equal(source.split(a).length,2);const at=source.indexOf(a),end=source.indexOf(b,at);assert.ok(end>at);return source.slice(at,end)};
function scopeFixture(search,pop){
 const context=vm.createContext({URLSearchParams,location:{search},device:{popErrorScope:pop}});
 vm.runInContext(take(host,'  // Opt-in scalar census only:','  const canvas =')+'\nglobalThis.pop=popTrackedErrorScope;globalThis.stats=errorScopeCensus;',context);return context;
}
test('host default-off preserves original promise with no new reactions; opted-in counters settle without retaining values',async()=>{
 let reactions=0;const original={then(){reactions++;return this}};
 const off=scopeFixture('',()=>original);assert.equal(off.pop(),original);assert.equal(reactions,0);assert.equal(off.stats.started,0);
 let resolve,reject;
 const first=new Promise(r=>{resolve=r}),second=new Promise((_,r)=>{reject=r});let next=0;
 const on=scopeFixture('?mcweb_resource_census=1',()=>[first,second][next++]);
 const a=on.pop(),b=on.pop();assert.equal(on.stats.pending,2);assert.equal(on.stats.maximumPending,2);
 const value={privatePayload:'not retained in scalar counters'};resolve(value);assert.equal(await a,value);
 reject(new Error('private-native-error'));await assert.rejects(b,/private-native-error/);
 assert.equal(on.stats.pending,0);assert.equal(on.stats.settled,2);assert.equal(on.stats.rejected,1);
 assert.ok(Object.values(on.stats).every(n=>typeof n==='number'));
 const throws=scopeFixture('?mcweb_resource_census=1',()=>{throw Error('sync')});assert.throws(()=>throws.pop(),/sync/);assert.equal(throws.stats.pending,0);assert.equal(throws.stats.rejected,1);
 Object.assign(on,{objects:new Map(),canvas:{width:4752,height:2673},
  _deferredDestroy:{pendingCount:()=>2,fencedCount:()=>3,graveyardCount:()=>0},
  _bindGroupCache:new Map(),_bindGroupDependencies:new Map(),_bindGroupStats:{evictions:4}});
 vm.runInContext('globalThis.lifetime=({'+take(host,'    resourceLifetime: () => {','    // Progress history')+'}).resourceLifetime;',on);
 const lifetime=on.lifetime();assert.equal(lifetime.canvasWidth,4752);assert.equal(lifetime.canvasHeight,2673);
 assert.equal(lifetime.pendingErrorScopes,0);assert.equal(lifetime.maximumPendingErrorScopes,2);assert.equal(lifetime.errorScopesStarted,2);assert.equal(lifetime.errorScopesRejected,1);
 assert.equal((host.match(/device\.popErrorScope\(\)/g)||[]).length,2,'All native pops outside the tracker use it');
});
function workerFixture(search){
 let receive;const replies=[];
 const context=vm.createContext({URLSearchParams,location:{search},performance:{now:()=>123},
  hostReady:true,rpcCount:77,rpcYieldStats:{enabled:false,active:false,calls:12},
  frameBackpressure:{report:()=>({pending:1,maximumPending:2,completed:3,limit:2})},
  mcWebGpu:{resourceLifetime:()=>({scope:'private-extra-string',liveBufferBytes:88,pendingErrorScopes:2,secret:{token:'not returned'}})},
  self:{addEventListener(type,fn){assert.equal(type,'message');receive=fn}},
  postMessage:m=>replies.push(JSON.parse(JSON.stringify(m)))});
 vm.runInContext(take(worker,'  // Five fixed, opt-in snapshots;','  // Opt-in probe for WebKit') ,context);
 return {context,replies,send:id=>receive({data:{mcwebResourceCensusRequest:id}})};
}
test('actual worker message handler is gated, fixed numeric-ID only, scalar-only and at most five replies',()=>{
 const off=workerFixture('');off.send(1);assert.equal(off.replies.length,0);
 const on=workerFixture('?mcweb_resource_census=1');for(const id of [0,6,-1,1.2,'1',{},NaN])on.send(id);assert.equal(on.replies.length,0);
 for(let id=1;id<=5;id++){on.send(id);on.send(id)}assert.equal(on.replies.length,5);
 const reply=on.replies[0].mcwebResourceCensus;assert.equal(reply.resources.liveBufferBytes,88);assert.equal(reply.frames.pending,1);assert.equal(reply.rpc.count,77);assert.equal(reply.yield.enabled,false);assert.equal(reply.resources.secret,undefined);assert.equal(JSON.stringify(reply).includes('private'),false);
 on.send(6);assert.equal(on.replies.length,5);
 const early=workerFixture('?mcweb_resource_census=1');early.context.hostReady=false;early.send(1);assert.equal(early.replies[0].mcwebResourceCensus.error,'host-not-ready');
 early.context.hostReady=true;early.context.mcWebGpu.resourceLifetime=()=>{throw Error('secret')};early.send(2);assert.equal(early.replies[1].mcwebResourceCensus.error,'census-failed');assert.equal(JSON.stringify(early.replies).includes('secret'),false);
 early.context.postMessage=()=>{throw Error('closed')};assert.doesNotThrow(()=>early.send(3));
});
function pageFixture(search,{sendError=false}={}){
 let now=0,next=0;const timers=new Map(),events=new Map(),nodes=[],sent=[];
 const createElement=tag=>({tagName:tag,style:{},children:[],value:'',attributes:{},
  setAttribute(key,value){this.attributes[key]=value},
  replaceChildren(...children){this.value='';this.children=children},
  get textContent(){return this.value+this.children.map(child=>child.textContent).join('')},
  set textContent(value){this.value=value;this.children=[]}});
 const context=vm.createContext({URLSearchParams,location:{search},document:{createElement,body:{appendChild:n=>nodes.push(n)}},
  setTimeout(fn,delay){const id=++next;timers.set(id,{at:now+delay,fn});return id},clearTimeout:id=>timers.delete(id),
  addEventListener(type,fn){events.set(type,fn)},removeEventListener(type,fn){if(events.get(type)===fn)events.delete(type)},
  gpuWorker:{postMessage:m=>{sent.push(m);if(sendError)throw Error('private failure')}},out(){},cursorWanted(){},playAudio(){}});
 vm.runInContext(take(pre,'    // Diagnostic-only finite display,','    // Sound (see worker-env.js):')+'\nglobalThis.accept=reply=>resourceCensus?.accept(reply);',context);
 const advance=to=>{for(;;){const due=[...timers].filter(([,t])=>t.at<=to).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn()}now=to};
 return {context,get node(){return nodes[0]},nodes,timers,events,sent,advance,accept:reply=>context.accept(reply),frame:value=>context.gpuWorker.onmessage({data:{mcwebFrames:value}})};
}
const reply=id=>({id,atMs:123,resources:{liveHandles:5,pendingErrorScopes:2},frames:{pending:1,limit:2},rpc:{count:99},yield:{enabled:false,queued:0}});
test('actual page default-off creates no timers/UI and opt-in sends exactly five scheduled requests then cleans up',()=>{
 const off=pageFixture('');assert.equal(off.nodes.length,0);assert.equal(off.timers.size,0);assert.equal(off.events.size,0);
 const on=pageFixture('?mcweb_resource_census=1');assert.equal(on.nodes.length,1);assert.match(on.node.style.cssText,/pointer-events:none/);assert.equal(on.timers.size,0);on.frame(1);assert.equal(on.timers.size,5);
 for(const [i,time] of [30000,60000,120000,180000,240000].entries()){
  on.advance(time);assert.equal(on.sent.length,i+1);assert.equal(on.sent[i].mcwebResourceCensusRequest,i+1);on.accept(reply(i+1));
 }
 assert.equal(on.timers.size,0);assert.equal(on.events.size,0);assert.match(on.node.textContent,/240s:.*liveHandles/);assert.match(on.node.textContent,/excludes physical/);assert.ok(on.node.textContent.length<=10500);
 const final=on.node.textContent;on.accept(reply(5));on.advance(900000);assert.equal(on.sent.length,5);assert.equal(on.node.textContent,final);
});
test('page ignores unsolicited, stale and malformed replies, times out, and pagehide cancels remaining work',()=>{
 const on=pageFixture('?mcweb_resource_census=1');on.frame(1);on.accept(reply(1));assert.match(on.node.textContent,/30s: scheduled/);
 on.advance(30000);on.accept({id:1,error:'secret raw exception'});assert.match(on.node.textContent,/30s: waiting/);
 on.advance(40000);assert.match(on.node.textContent,/30s: timeout/);const timed=on.node.textContent;on.accept(reply(1));assert.equal(on.node.textContent,timed);
 on.advance(60000);on.accept({id:2,error:'census-failed'});assert.match(on.node.textContent,/60s: census-failed/);
 on.events.get('pagehide')();assert.equal(on.timers.size,0);assert.equal(on.events.size,0);on.advance(900000);assert.equal(on.sent.length,2);
 const fail=pageFixture('?mcweb_resource_census=1',{sendError:true});fail.frame(1);fail.advance(30000);assert.match(fail.node.textContent,/30s: worker message failed/);assert.equal(fail.sent.length,1);fail.events.get('pagehide')();assert.equal(fail.timers.size,0);
});

test('actual page chunks each bounded row into separate accessibility text descendants without losing any of five snapshots',()=>{
 const on=pageFixture('?mcweb_resource_census=1');
 on.frame(1);
 const expected=['Logical ownership only; excludes physical process/native driver memory. Times are seconds after the first positive frame.'];
 for(const [index,time] of [30,60,120,180,240].entries()){
  on.advance(time*1000);
  const data=reply(index+1);
  data.resources=Object.fromEntries(Array.from({length:32},(_,i)=>['counter'+String(i).padStart(2,'0')+'x'.repeat(39),123456789012345]));
  const text=JSON.stringify({atMs:data.atMs,resources:data.resources,frames:data.frames,rpc:data.rpc,yield:data.yield});
  assert.ok(text.length>2048,'Exercise the existing full per-row bound');
  expected.push(time+'s: '+text.slice(0,2048));on.accept(data);
 }
 assert.equal(on.node.textContent,expected.join('\n')+'\n');
 assert.ok(on.node.children.length<=31,'One scope heading and no more than six chunks per row');
 assert.ok(on.node.children.length>6,'Long rows produce independently readable descendants');
 assert.ok(on.node.children.every(chunk=>chunk.tagName==='div'&&chunk.textContent.length<=350));
 assert.match(on.node.style.cssText,/overflow:auto/);assert.match(on.node.style.cssText,/pointer-events:none/);
 assert.equal(on.node.attributes.tabindex,undefined);assert.equal(on.timers.size,0);assert.equal(on.events.size,0);
});

test('actual frame handler anchors once after startup and never arms disabled, zero, invalid or disposed census',()=>{
 const on=pageFixture('?mcweb_resource_census=1');
 for(const value of [0,-1,NaN,Infinity,'1'])on.frame(value);
 on.advance(300000);assert.equal(on.sent.length,0);assert.equal(on.timers.size,0);
 on.frame(1);assert.equal(on.timers.size,5);on.frame(2);assert.equal(on.timers.size,5);
 on.advance(329999);assert.equal(on.sent.length,0);on.advance(330000);assert.equal(on.sent.length,1);
 on.frame(100);on.advance(360000);assert.equal(on.sent.length,2);
 on.events.get('pagehide')();on.frame(1000);assert.equal(on.timers.size,0);
 const off=pageFixture('');off.frame(1);assert.equal(off.timers.size,0);assert.equal(off.nodes.length,0);
 const closed=pageFixture('?mcweb_resource_census=1');closed.events.get('pagehide')();closed.frame(1);assert.equal(closed.timers.size,0);
});
