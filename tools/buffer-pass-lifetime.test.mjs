import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createBufferPassLifetime, queuedBufferHost} from '../server/runtime-fixes.mjs';

function fixture() {
  const objects=new Map(), pending=[], evicted=[], uses=[];
  const lifetime=createBufferPassLifetime({objects,markUse:(encoder,buffer)=>uses.push([encoder,buffer]),deferDestroy:buffer=>pending.push(buffer),evict:buffer=>evicted.push(buffer)});
  const old={kind:'buffer',buffer:{label:'Auto Storage index buffer'}};objects.set(10,old);
  return {objects,pending,evicted,uses,lifetime,old};
}
test('index-buffer growth preserves earlier queued draws until their pass ends',()=>{
  const f=fixture(), encoder={}, pass={_encoderEntry:encoder};f.lifetime.begin(pass);
  const commands=[()=>f.objects.get(10).buffer];
  f.lifetime.destroy(10);f.objects.set(11,{kind:'buffer',buffer:{label:'larger index buffer'}});
  commands.push(()=>f.objects.get(11).buffer);
  assert.equal(commands[0](),f.old.buffer);assert.notEqual(commands[1](),f.old.buffer);
  assert.deepEqual(f.uses,[[encoder,f.old.buffer]]);assert.deepEqual(f.pending,[f.old.buffer]);assert.deepEqual(f.evicted,[f.old.buffer]);
  f.lifetime.end(pass);assert.equal(f.objects.has(10),false);assert.equal(f.objects.has(11),true);
});
test('all existing passes retain a closed buffer, later passes do not prolong its life',()=>{
  const f=fixture(),a={_encoderEntry:{}},b={_encoderEntry:{}},later={_encoderEntry:{}};
  f.lifetime.begin(a);f.lifetime.begin(b);f.lifetime.destroy(10);f.lifetime.begin(later);
  assert.equal(f.uses.length,2);f.lifetime.end(a);assert.ok(f.objects.has(10));f.lifetime.end(a);assert.ok(f.objects.has(10));
  f.lifetime.end(b);assert.equal(f.objects.has(10),false);f.lifetime.end(later);
});
test('closing without a queued pass deletes immediately and rejects repeated closes',()=>{
  const f=fixture();f.lifetime.destroy(10);assert.equal(f.objects.has(10),false);
  assert.throws(()=>f.lifetime.destroy(10),/Unknown buffer/);assert.equal(f.pending.length,1);
});
test('repeated buffer growth releases every logical handle after pass completion',()=>{
  const f=fixture();for(let n=0;n<1000;n++){
    const pass={_encoderEntry:{}};f.objects.set(10,f.old);f.lifetime.begin(pass);f.lifetime.destroy(10);
    assert.throws(()=>f.lifetime.destroy(10),/Unknown buffer/);f.lifetime.end(pass);assert.equal(f.objects.size,0);
  }
});
test('the checked host transforms once and preserves the deferred native destruction path',async()=>{
  const original=await readFile(new URL('../runtime/web/webgpu-host.js',import.meta.url),'utf8');
  const transformed=queuedBufferHost(original);new vm.Script(transformed);
  assert.throws(()=>queuedBufferHost(transformed),/Unexpected/);assert.throws(()=>queuedBufferHost(''),/Unexpected/);
  assert.match(transformed,/_bufferPassLifetime\.begin\(object\)/);assert.match(transformed,/_bufferPassLifetime\.destroy\(handle\)/);
  assert.equal(transformed.split('_bufferPassLifetime.end(objects.get(passHandle))').length,3);
});
