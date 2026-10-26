// Isolated measurement behind docs/JIT-DESIGN.md (what is left, item 1):
// the cost of a call from one wasm instance into another, which is what every
// compiled-to-compiled call in the wasm JIT does. Run: node <this>.
// Node 22 on x86: local ~2.1 ns, import ~2.5 ns, call_indirect ~2.5 ns.
function leb(n){const o=[];do{let b=n&0x7f;n>>>=7;if(n)b|=0x80;o.push(b);}while(n);return o;}
function sleb(n){const o=[];while(true){let b=n&0x7f;n>>=7;if((n===0&&!(b&0x40))||(n===-1&&(b&0x40))){o.push(b);return o;}o.push(b|0x80);}}
function sec(id,b){return [id,...leb(b.length),...b];}
function str(s){return [...leb(s.length),...Buffer.from(s)];}
const hdr=[0,0x61,0x73,0x6d,1,0,0,0];
// callee: (i32)->i32 : x+1
const callee = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([...hdr,
  ...sec(1,[1,0x60,1,0x7f,1,0x7f]), ...sec(3,[1,0]), ...sec(7,[1,...str("f"),0,0]),
  ...sec(10,[1, ...leb(7), 0, 0x20,0, 0x41,1, 0x6a, 0x0b])]))).exports.f;
const table = new WebAssembly.Table({initial:4, element:"anyfunc"}); table.set(1, callee);
// driver: loop n times acc = call(acc) via (a) local func, (b) import, (c) call_indirect table slot 1
function driver(kind){
  const types=[1,0x60,1,0x7f,1,0x7f];
  let imp=[], funcs, code;
  const loopBody = (callInstr) => [ // (param n) local acc, i
    1, 2,0x7f,
    0x03,0x40, // loop
      0x20,1, ...callInstr, 0x21,1,          // acc = call(acc)
      0x20,2, 0x41,1, 0x6a, 0x22,2,          // i++ (tee)
      0x20,0, 0x48, 0x0d,0,                  // br_if i < n
    0x0b, 0x20,1, 0x0b];
  if (kind==="local") {
    funcs=[2,0,0]; // f0 = local inc, f1 = driver
    const inc=[0, 0x20,0, 0x41,1, 0x6a, 0x0b];
    const body=loopBody([0x10,0]);
    code=[2, ...leb(inc.length), ...inc, ...leb(body.length), ...body];
    return new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([...hdr, ...sec(1,types), ...sec(3,funcs), ...sec(7,[1,...str("d"),0,1]), ...sec(10,code)]))).exports.d;
  }
  if (kind==="import") {
    imp=[1, ...str("e"),...str("f"),0x00,0];
    const body=loopBody([0x10,0]);
    return new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([...hdr, ...sec(1,types), ...sec(2,imp), ...sec(3,[1,0]), ...sec(7,[1,...str("d"),0,1]), ...sec(10,[1,...leb(body.length),...body])])), {e:{f:callee}}).exports.d;
  }
  imp=[1, ...str("e"),...str("t"),0x01,0x70,0x00,0];
  const body=loopBody([0x41,1, 0x11,0,0]);
  return new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([...hdr, ...sec(1,types), ...sec(2,imp), ...sec(3,[1,0]), ...sec(7,[1,...str("d"),0,0]), ...sec(10,[1,...leb(body.length),...body])])), {e:{t:table}}).exports.d;
}
for (const k of ["local","import","indirect"]) {
  const d=driver(k); d(1e6);
  const n=5e7; const t=performance.now(); const r=d(n); const ms=performance.now()-t;
  console.log(`${k.padEnd(9)} ${(ms*1e6/n).toFixed(2)} ns/call  r=${r}`);
}
