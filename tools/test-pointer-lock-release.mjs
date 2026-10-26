import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(process.argv[3] || new URL('../site/testing/webgpu-host.js', import.meta.url), 'utf8');
const pre = await readFile(process.argv[2] || new URL('../site/testing/javavm.js', import.meta.url), 'utf8');
const start = source.indexOf('  // SDL_Keymod bits,');
const end = source.indexOf('  // Text input for a touch screen', start);
assert.ok(start >= 0 && end > start);
const handlers = source.slice(start, end);
function fixture({ synchronousUnlock = true } = {}) {
  const listeners = new Map(), events = [], actions = [];
  let now = 1000, requests = 0, exits = 0;
  const add = (type, callback) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(callback);
  };
  const emit = (type, props = {}) => {
    const event = { type, code: '', key: '', button: 0, clientX: 20, clientY: 30,
      target: canvas, preventDefault() {}, ...props };
    for (const callback of listeners.get(type) || []) callback(event);
  };
  const canvas = { width: 100, height: 100, addEventListener: add, focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    requestPointerLock() { requests++; } };
  const document = { body: {dataset:{}}, pointerLockElement: null, addEventListener: add,
    querySelector: () => canvas,
    exitPointerLock() {
      exits++; actions.push('exit');
      if (synchronousUnlock) { document.pointerLockElement = null; emit('pointerlockchange'); }
    } };
  const context = vm.createContext({ canvas, document, navigator:{vendor:'Apple Computer, Inc.'},
    performance:{now:()=>now}, addEventListener:add, recordStage() {}, Date, console });
  vm.runInContext(handlers, context);
  const input = context.mcWebInput;
  input.register((...args) => { actions.push(args[0]+':'+args[3]); events.push(args); });
  // External cursor-mode messages: Java's existing SDL compatibility layer
  // emits these only when relativeMouseMode changes. It is not modified here.
  const javaMode = disabled => { input.lockPointerOnNextClick = disabled !== 0; if (!disabled && document.pointerLockElement) document.exitPointerLock(); };
  const grab = () => { javaMode(1); document.pointerLockElement = canvas; emit('pointerlockchange'); };
  return { input, document, canvas, emit, events, actions, javaMode, grab,
    tick: amount => {now += amount;}, get requests(){return requests;},get exits(){return exits;} };
}
const escapeEvents = h => h.events.filter(e=>e[0]==='key' && e[1]===41);

test('dispatched locked Escape releases immediately before one Java keydown and keeps normal keyup',()=>{
 const h=fixture();h.grab();h.emit('keydown',{code:'Escape',key:'Escape'});
 assert.equal(h.input.lockPointerOnNextClick,false);assert.equal(h.document.pointerLockElement,null);
 assert.deepEqual(h.actions.slice(0,2),['exit','key:1']);
 assert.equal(escapeEvents(h).filter(e=>e[3]===1).length,1);
 h.emit('keyup',{code:'Escape',key:'Escape'});assert.deepEqual(escapeEvents(h).map(e=>e[3]),[1,0]);
 h.emit('mousedown');assert.equal(h.requests,0,'Delayed Java pause must not let the next click capture');
 h.javaMode(0);h.javaMode(1);h.emit('mousedown');assert.equal(h.requests,1,'A real Java resume request rearms capture');
});
test('browser-swallowed Escape disarms before synthesizing one pause and cannot recapture while Java is delayed',()=>{
 const h=fixture();h.grab();h.document.pointerLockElement=null;h.emit('pointerlockchange');
 assert.equal(h.input.lockPointerOnNextClick,false);assert.deepEqual(escapeEvents(h).map(e=>e[3]),[1,0]);
 h.tick(2000);h.emit('pointerlockchange');h.emit('mousedown');
 assert.equal(escapeEvents(h).filter(e=>e[3]===1).length,1);assert.equal(h.requests,0);
});
test('late native unlock after delivered Escape cannot synthesize another pause even after500ms',()=>{
 const h=fixture({synchronousUnlock:false});h.grab();h.emit('keydown',{code:'Escape',key:'Escape'});
 h.tick(1000);h.document.pointerLockElement=null;h.emit('pointerlockchange');
 assert.equal(escapeEvents(h).filter(e=>e[3]===1).length,1);h.emit('mousedown');assert.equal(h.requests,0);
});
test('an in-flight request acquiring after release immediately exits without rearming or duplicate Escape',()=>{
 const h=fixture();h.grab();h.document.pointerLockElement=null;h.emit('pointerlockchange');
 const count=escapeEvents(h).length;h.document.pointerLockElement=h.canvas;h.emit('pointerlockchange');
 assert.equal(h.document.pointerLockElement,null);assert.equal(h.input.lockPointerOnNextClick,false);
 assert.equal(h.exits,1);assert.equal(escapeEvents(h).length,count);
});
test('focus release disarms capture, pauses once and releases held keyboard state',()=>{
 const h=fixture();h.grab();h.emit('keydown',{code:'KeyW',key:'w'});h.emit('blur');
 assert.equal(h.input.lockPointerOnNextClick,false);assert.equal(h.document.pointerLockElement,null);
 assert.equal(escapeEvents(h).filter(e=>e[3]===1).length,1);
 assert.equal(h.events.filter(e=>e[0]==='key'&&e[1]===26&&e[3]===0).length,1);
 h.emit('mousedown');assert.equal(h.requests,0);
});
test('normal Java menu release adds no Escape, and missing bridge cannot trap dispatched Escape',()=>{
 const h=fixture();h.grab();h.javaMode(0);assert.equal(escapeEvents(h).length,0);
 h.grab();h.input.bridge=null;h.emit('keydown',{code:'Escape',key:'Escape'});
 assert.equal(h.input.lockPointerOnNextClick,false);assert.equal(h.document.pointerLockElement,null);
});


const pageStart=pre.indexOf('// Pointer lock belongs to this page.');
const pageEnd=pre.indexOf('if (!Worker.prototype.__mcWebRpcPatched)',pageStart);
assert.ok(pageStart>=0&&pageEnd>pageStart);
function pageFixture({blocked=false,synchronousUnlock=true}={}) {
 const host=fixture(),listeners=new Map(),messages=[],forwarded=[],actions=[];
 let requests=0,exits=0,modal=false;
 const add=(type,fn)=>{if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn)};
 const emit=(type,props={})=>{const e={type,target:canvas,code:'',key:'',preventDefault(){},...props};for(const fn of listeners.get(type)||[])fn(e)};
 const deliver=m=>{const {type,init}=m.mcwebDom;host.document.pointerLockElement=init.locked?host.canvas:null;host.emit(type,init)};
 const canvas={addEventListener:add,requestPointerLock(){requests++;actions.push('request') }};
 const document={pointerLockElement:null,querySelector:()=>modal?{}:null,addEventListener:add,exitPointerLock(){
  exits++;actions.push('exit');if(synchronousUnlock){document.pointerLockElement=null;emit('pointerlockchange')}
 }};
 const context=vm.createContext({AbortController,canvasElement:canvas,document,navigator:{userActivation:{isActive:true}},addEventListener:add,
  gpuWorker:{postMessage(m){messages.push(m);if(!blocked)deliver(m)}},
  forwardMouse(type,event){actions.push('forward:'+type);forwarded.push(type);if(!blocked)host.emit(type,event)}});
 vm.runInContext(pre.slice(pre.indexOf('const inputListeners ='),pre.indexOf('let restoreWorkerMessages ='))+'let cursorWanted;'+pre.slice(pageStart,pageEnd).replace(/\s*}\s*$/, '')+';globalThis.want=cursorWanted;',context);
 const wanted=v=>context.want(v);
 const grab=()=>{host.javaMode(1);wanted(true);document.pointerLockElement=canvas;emit('pointerlockchange');};
 return {host,document,canvas,emit,wanted,grab,messages,forwarded,actions,deliver,
  setModal:v=>{modal=v},get requests(){return requests},get exits(){return exits}};
}
test('actual page releases on Escape before forwarding even with GPU/Java blocked, repeated true cannot recapture',()=>{
 const p=pageFixture({blocked:true});p.grab();const before=p.requests;
 p.emit('keydown',{code:'Escape',key:'Escape'});
 assert.equal(p.document.pointerLockElement,null);assert.ok(p.actions.indexOf('exit')<p.actions.indexOf('forward:keydown'));
 p.wanted(true);p.emit('mousedown');assert.equal(p.requests,before);
 p.wanted(false);p.wanted(true);assert.equal(p.requests,before+1,'Only a new false-to-true cursor request rearms');
});
test('page unlock message arriving synchronously before delivered Escape still produces one Java down/up',()=>{
 const p=pageFixture();p.grab();p.emit('keydown',{code:'Escape',key:'Escape'});p.emit('keyup',{code:'Escape',key:'Escape'});
 assert.deepEqual(escapeEvents(p.host).map(e=>e[3]),[1,0]);
 assert.equal(p.messages.some(m=>m.mcwebDom.init.escapeDispatched),true);
});
test('native swallowed Escape and focus loss disarm page before a blocked worker handles either',()=>{
 for(const kind of ['native','blur']) {
  const p=pageFixture({blocked:true});p.grab();const count=p.requests;
  if(kind==='native'){p.document.pointerLockElement=null;p.emit('pointerlockchange')}else p.emit('blur');
  p.emit('mousedown');p.wanted(true);p.emit('mousedown');assert.equal(p.requests,count);
  for(const message of p.messages)p.deliver(message);
  assert.equal(escapeEvents(p.host).filter(e=>e[3]===1).length,1);
 }
});
test('late native acquisition is immediately undone on page, while modal and noncanvas clicks cannot capture',()=>{
 const p=pageFixture({blocked:true});p.grab();p.emit('keydown',{code:'Escape',key:'Escape'});
 const exits=p.exits;p.document.pointerLockElement=p.canvas;p.emit('pointerlockchange');
 assert.equal(p.exits,exits+1);assert.equal(p.document.pointerLockElement,null);
 const q=pageFixture();q.setModal(true);q.wanted(true);q.emit('mousedown');assert.equal(q.requests,0);
 q.setModal(false);q.emit('mousedown',{target:{}});assert.equal(q.requests,0);q.emit('mousedown');assert.equal(q.requests,1);
});
test('a genuine quick second Escape after Java pause remains delivered and can resume normally',()=>{
 const p=pageFixture();p.grab();p.emit('keydown',{code:'Escape',key:'Escape'});p.emit('keyup',{code:'Escape',key:'Escape'});
 p.host.javaMode(0);p.wanted(false);p.host.tick(20);
 p.emit('keydown',{code:'Escape',key:'Escape'});p.emit('keyup',{code:'Escape',key:'Escape'});
 assert.deepEqual(escapeEvents(p.host).map(e=>e[3]),[1,0,1,0]);
 const before=p.requests;p.host.javaMode(1);p.wanted(true);assert.equal(p.requests,before+1);
});

test('Escape while only armed cannot suppress the next native Escape after a genuine resume',()=>{
 const p=pageFixture();p.host.javaMode(1);p.wanted(true);
 p.emit('keydown',{code:'Escape',key:'Escape'});p.emit('keyup',{code:'Escape',key:'Escape'});
 p.host.javaMode(0);p.wanted(false);p.host.javaMode(1);p.wanted(true);
 p.document.pointerLockElement=p.canvas;p.emit('pointerlockchange');
 p.document.pointerLockElement=null;p.emit('pointerlockchange');
 assert.equal(escapeEvents(p.host).filter(e=>e[3]===1).length,2);
});
