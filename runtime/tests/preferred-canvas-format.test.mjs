import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(process.argv[2]||new URL('../web/webgpu-host.js',import.meta.url),'utf8');
const take=(a,b)=>{assert.equal(source.split(a).length,2);const at=source.indexOf(a),end=source.indexOf(b,at);assert.ok(end>at);return source.slice(at,end)};
function fixture({worker=false,search='',preferred='bgra8unorm',missing=false}={}){
 const configs=[],pipelines=[],textures=[],deferred=[];let preferredReads=0;
 const device={createSampler:()=>({}),createShaderModule:()=>({}),createPipelineLayout:()=>({}),createBindGroupLayout:()=>({}),
  createRenderPipeline:p=>(pipelines.push(p),{}),createTexture:p=>(textures.push(p),{})};
 const context=vm.createContext({location:{search},navigator:{gpu:missing?{}:{getPreferredCanvasFormat:()=>{preferredReads++;return preferred}}},URLSearchParams,
  ...(worker?{WorkerGlobalScope:function(){}}:{}),
  GPUTextureUsage:{RENDER_ATTACHMENT:16,COPY_DST:2,TEXTURE_BINDING:4,COPY_SRC:1},GPUShaderStage:{FRAGMENT:2},devicePixelRatio:2,
  canvas:{width:1,height:1,getBoundingClientRect:()=>({width:1344,height:756})},context:{configure:c=>configs.push(c),getCurrentTexture:()=>({direct:true})},device,
  _useVirtualCanvas:worker,_virtualCanvas:null,put:x=>x,evictResourceBindGroups(){},deferDestroyTexture:t=>deferred.push(t)});
 vm.runInContext(take('  // Probe only the GPU Worker\'s final displayed surface.','  const diagnostics =')
  +take('  globalThis.mcWebCanvas = {','  addEventListener("resize"')
  +'\nlet compositeSampler=null,compositePipeline=null,compositePipelineH=0;\n'
  +take('  const ensureComposite =','  // Render pass state')
  +'\nglobalThis.testComposite=ensureComposite;globalThis.surface=({'
  +take('    configureCanvas(width, height) {','    // Mojang gets a persistent')
  +take('    acquireCanvasTexture() {','    present(handle) {')+'});',context);
 return {context,configs,pipelines,textures,deferred,get preferredReads(){return preferredReads}};
}
test('only exact worker opt-in selects preferred final canvas target; default and nonworker preserve RGBA',()=>{
 for(const [worker,search,preferred,expected,reads] of [
  [true,'','bgra8unorm','rgba8unorm',0],
  [false,'?mcweb_preferred_canvas_format=1','bgra8unorm','rgba8unorm',0],
  [true,'?mcweb_preferred_canvas_format=0','bgra8unorm','rgba8unorm',0],
  [true,'?mcweb_canvas_format=preferred','bgra8unorm','rgba8unorm',0],
  [true,'?mcweb_preferred_canvas_format=1','bgra8unorm','bgra8unorm',1],
  [true,'?mcweb_preferred_canvas_format=1','rgba8unorm','rgba8unorm',1]]){
  const f=fixture({worker,search,preferred});f.context.mcWebCanvas.resizeBackingStore();f.context.surface.configureCanvas(2688,1512);
  f.context.testComposite(1512);f.context.testComposite(1512);
  const entry=f.context.surface.acquireCanvasTexture();
  assert.equal(f.configs.length,2);assert.ok(f.configs.every(c=>c.format===expected&&c.usage===18&&c.alphaMode==='opaque'));
  assert.equal(f.pipelines.length,1,'Immutable page format preserves composite cache reuse');assert.equal(f.pipelines[0].fragment.targets[0].format,expected);
  assert.equal(entry.format,'rgba8unorm');assert.equal(entry.width,2688);assert.equal(entry.height,1512);
  if(worker){assert.equal(f.textures.length,1);assert.equal(f.textures[0].format,'rgba8unorm');assert.equal(f.textures[0].usage,23)}
  else assert.equal(f.textures.length,0);
  assert.equal(f.preferredReads,reads);assert.equal(f.context.canvas.width,2688);assert.equal(f.context.canvas.height,1512);
 }
 assert.equal((source.match(/format: canvasFormat/g)||[]).length,3,'Only both real context configurations and final composite use selected format');
});
test('missing preferred API falls back and virtual canvas resize retains RGBA plus existing deferred destruction',()=>{
 const f=fixture({worker:true,search:'?mcweb_preferred_canvas_format=1',missing:true});
 f.context.surface.configureCanvas(1280,720);f.context.surface.acquireCanvasTexture();
 f.context.surface.configureCanvas(2688,1512);const entry=f.context.surface.acquireCanvasTexture();
 assert.ok(f.configs.every(c=>c.format==='rgba8unorm'));assert.equal(entry.format,'rgba8unorm');
 assert.equal(f.deferred.length,1);assert.equal(f.textures.length,2);assert.ok(f.textures.every(t=>t.format==='rgba8unorm'));
});
