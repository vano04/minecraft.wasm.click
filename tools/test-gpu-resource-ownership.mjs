#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
// Run against the staged host by default, or an explicit source/bundle file.
const source=await readFile(process.argv[2] || new URL('../site/testing/webgpu-host.js',import.meta.url),'utf8');
const take=(a,b)=>{assert.equal(source.split(a).length,2);const start=source.indexOf(a);return source.slice(start,source.indexOf(b,start));};
const objects=new Map(),deferred=[],closedTextures=[],closedViews=[],deferredTextures=[];let created=0;
const context={URLSearchParams,location:{search:''},console,
 canvas:{width:64,height:64},GPUTextureUsage:{RENDER_ATTACHMENT:1,TEXTURE_BINDING:2,COPY_SRC:4,COPY_DST:8},put:entry=>{const handle=objects.size+1000000;objects.set(handle,entry);return handle;},deferDestroyTexture:t=>deferredTextures.push(t),
 objects,get:handle=>{assert.ok(objects.has(handle));return objects.get(handle);},
 device:{createTexture:()=>({}),limits:{maxDynamicUniformBuffersPerPipelineLayout:8},createBindGroup:spec=>({id:++created,resources:spec.entries.map(e=>e.resource.buffer||e.resource)})},
 ensureDummies(){},dummyUniform:{},dummyStorage:{},dummySampler:{},
 _markUse(){},adaptSampleTypes(){},_textureHistoryCaptured:false,_useVirtualCanvas:true,
 pipelineBindGroupLayouts:new WeakMap(),deferDestroyBuffer:b=>deferred.push(b),
 _textureLifetime:{requestDestroy:t=>closedTextures.push(t),releaseView:v=>closedViews.push(v)}};
vm.createContext(context);
vm.runInContext('let _virtualCanvas=null;'+take('  const _bindGroupCache =','  // Formats a filtering slot')+take('  const setObjectBinding =','  // Largest buffer that gets a diagnostic CPU mirror')+'\nglobalThis.replacePipeline=(entry,fallback)=>{'+take('            evictPipelineBindGroups(entry);','          }).catch(() => {});')+'};\nglobalThis.draw=ensureBindGroups;globalThis.cache=_bindGroupCache;globalThis.dependencies=_bindGroupDependencies;globalThis.stats=_bindGroupStats;globalThis.keysFor=r=>_bindGroupDependents.get(r);\nglobalThis.close=({'+take('    destroyTexture(handle) {','    createCommandEncoder() {')+take('    destroyBuffer(handle) {','    writeBuffer64(')+take('    acquireCanvasTexture() {','    present(handle) {')+'});',context);
let next=100;
function generation(pipeline={},parentTexture={}){
 const b=next++,v=next++,sam=next++,t=next++;const buffer={},view={},sampler={};
 const textureEntry={kind:'texture',texture:parentTexture};
 objects.set(b,{kind:'buffer',buffer});objects.set(v,{kind:'textureView',view,textureEntry});objects.set(sam,{kind:'sampler',sampler});objects.set(t,textureEntry);
 context.pipelineBindGroupLayouts.set(pipeline,{layouts:[{}],dynamic:null});
 const uniform={kind:'uniform',buffer,bufferHandle:b,size:256,bufferSize:1048576,offset:0};
 const tex={kind:'texture',view,sampler,viewHandle:v,samplerHandle:sam,_texEntry:textureEntry};
 const state={pipeline:{pipeline,spec:{label:'reload-generation',bindGroups:[{uniforms:[{name:'U'}],samplers:['T']}]},groupRemap:[{ng:0,baseU:0,baseS:1}],groupCount:1,samplerBases:[1],samplerKinds:new Map()},resources:new Map([['U',uniform],['T',tex]]),drawTexBinds:[tex],boundGroups:[],pass:{setBindGroup(_ng,group){state.group=group;}}};
 return {b,v,sam,t,buffer,view,sampler,parentTexture,pipeline,state,uniform};
}
const draw=g=>{g.state.boundGroups=[];context.draw(g.state);return g.state.group;};
const canvasHandle=context.close.acquireCanvasTexture(),nativeCanvas=objects.get(canvasHandle).texture;
const canvas=generation({},nativeCanvas);const canvasGroup=draw(canvas);context.close.destroyTexture(canvasHandle);assert.equal(draw(canvas),canvasGroup);assert.equal(context.keysFor(nativeCanvas).size,1);assert.equal(closedTextures.length,0);
context.canvas.width=128;const resizedHandle=context.close.acquireCanvasTexture();assert.notEqual(objects.get(resizedHandle).texture,nativeCanvas);assert.equal(deferredTextures[0],nativeCanvas);assert.equal(context.cache.size,0);draw(canvas);assert.equal(context.cache.size,0);assert.equal(context.keysFor(nativeCanvas),undefined);context.close.destroyObject(canvas.v);closedViews.length=0;created=0;
const a=generation(),b=generation();const ag=draw(a),bg=draw(b);assert.equal(context.cache.size,2);for(let n=0;n<100;n++)assert.equal(draw(b),bg);assert.equal(created,2);
context.close.destroyBuffer(a.b);assert.equal(context.cache.size,1);assert.equal(context.keysFor(a.buffer),undefined);assert.equal(draw(b),bg);assert.equal(created,2);assert.equal(deferred[0],a.buffer);
const retiredDraw=draw(a);assert.ok(retiredDraw);assert.equal(context.cache.size,1);assert.equal(context.dependencies.size,1);assert.equal(context.keysFor(a.buffer),undefined);
const c=generation();draw(c);context.close.destroyObject(c.v);assert.equal(context.keysFor(c.view),undefined);assert.equal(context.cache.size,1);assert.equal(closedViews.length,1);
const shared={};const d=generation({},shared),e=generation({},shared);draw(d);draw(e);assert.equal(context.cache.size,3);context.close.destroyTexture(d.t);assert.equal(context.cache.size,1);assert.equal(context.keysFor(shared),undefined);assert.equal(closedTextures.length,1);
const f=generation();draw(f);context.close.destroyObject(f.sam);assert.equal(context.keysFor(f.sampler),undefined);assert.equal(context.cache.size,1);
const pipes=[{},{},{},{}],variants=pipes.map(p=>generation(p));for(const g of variants)draw(g);const ph=next++;objects.set(ph,{kind:'pipeline',pipeline:pipes[0],byDepth:new Map([[null,pipes[1]]]),variants:new Map([['depth',{pipeline:pipes[2]}]]),stages:{unfilterable:new Map([['float',{pipeline:pipes[3]}]])}});context.close.destroyObject(ph);for(const p of pipes)assert.equal(context.keysFor(p),undefined);assert.equal(context.cache.size,1);assert.equal(draw(b),bg);
const fallbackPipes=[{},{},{},{}],fallbackStates=fallbackPipes.map(p=>generation(p));for(const g of fallbackStates)draw(g);
const fallbackEntry={pipeline:fallbackPipes[0],byDepth:new Map([[null,fallbackPipes[1]]]),variants:new Map([['depth',{pipeline:fallbackPipes[2]}]]),stages:{unfilterable:new Map([['float',{pipeline:fallbackPipes[3]}]])}};
const fallback={built:{pipeline:{},stages:{}},byDepth:new Map()};context.replacePipeline(fallbackEntry,fallback);
for(const p of fallbackPipes)assert.equal(context.keysFor(p),undefined);assert.equal(context.cache.size,1);assert.equal(fallbackEntry.pipeline,fallback.built.pipeline);assert.equal(fallbackEntry.variants,undefined);
for(const g of fallbackStates)draw(g);assert.equal(context.cache.size,1);assert.equal(context.dependencies.size,1);
context.close.destroyTexture(b.t);assert.equal(context.cache.size,0);assert.equal(context.dependencies.size,0);
const fresh=generation();const freshGroup=draw(fresh);assert.notEqual(freshGroup,bg);assert.equal(context.cache.size,1);
// Exercise the real32768-entry capacity boundary; reverse ownership must reset
// with the native cache rather than retaining evicted resource signatures.
for(let n=0;n<32768;n++){fresh.uniform.bufferHandle=100000+n;draw(fresh);}
assert.equal(context.stats.clears,1);assert.equal(context.cache.size,1);assert.equal(context.dependencies.size,1);assert.equal(context.keysFor(fresh.buffer).size,1);context.close.destroyBuffer(fresh.b);assert.equal(context.cache.size,0);assert.equal(context.dependencies.size,0);
console.log('PASS actual host bind-group ownership: targeted buffer/view/texture/sampler/pipeline-variant/fallback invalidation, retired rebind stays pass-local, unrelated100draw cache hits, new-generation draw, fence deferral preserved, real32768capacity cleanup');
console.log(JSON.stringify({created,evictions:context.stats.evictions,capacityClears:context.stats.clears}));
