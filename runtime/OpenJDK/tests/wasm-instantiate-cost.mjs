// Isolated measurement behind the JIT's module imports (docs/JIT-DESIGN.md,
// Status 2026-09-25): what instantiating a tiny module costs when it imports
// a large funcref table, versus importing two functions. Run: node <this>
// Expect (Node 22): table 60k -> ~2.5 ms/instance and table.set growing with
// the number of importing instances; function imports -> a few us each.
function leb(n){const o=[];do{let b=n&0x7f;n>>>=7;if(n)b|=0x80;o.push(b);}while(n);return o;}
function sec(id,b){return [id,...leb(b.length),...b];}
function str(s){return [...leb(s.length),...Buffer.from(s)];}
function mod(k, withTable){
  // type0: body (5 x i32)->i32 ; type1: (i32,i32,i32)->i32 ; type2: (i32,i32)->i32
  const types=[3,0x60,5,0x7f,0x7f,0x7f,0x7f,0x7f,1,0x7f, 0x60,3,0x7f,0x7f,0x7f,1,0x7f, 0x60,2,0x7f,0x7f,1,0x7f];
  const imps=[...str("env"),...str("memory"),0x02,0x03,0,...leb(65536),
              ...str("env"),...str("i"),0x00,1, ...str("env"),...str("s"),0x00,2];
  const n = 3 + (withTable?1:0);
  const imp=[n,...imps, ...(withTable?[...str("env"),...str("__indirect_function_table"),0x01,0x70,0x00,0]:[])];
  const fn=[1,0]; const ex=[1,...str("f"),0x00,2];   // func index 2 (after 2 imported funcs)
  // body: call import 0 with (a,b,c), add k
  const body=[0, 0x20,0, 0x20,1, 0x20,2, 0x10,0, 0x41,...leb(k&0x3f), 0x6a, 0x0b];
  const code=[1,...leb(body.length),...body];
  return new Uint8Array([0,0x61,0x73,0x6d,1,0,0,0,...sec(1,types),...sec(2,imp),...sec(3,fn),...sec(7,ex),...sec(10,code)]);
}
const memory=new WebAssembly.Memory({initial:256,maximum:65536,shared:true});
// helper functions as real wasm functions
const helper = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0,0x61,0x73,0x6d,1,0,0,0,
  ...sec(1,[2,0x60,3,0x7f,0x7f,0x7f,1,0x7f,0x60,2,0x7f,0x7f,1,0x7f]), ...sec(3,[2,0,1]),
  ...sec(7,[2,...str("i"),0,0,...str("s"),0,1]),
  ...sec(10,[2, 4,0,0x20,0,0x0b, 4,0,0x20,1,0x0b])]))).exports;
const table=new WebAssembly.Table({initial:60000,element:"anyfunc"});
for (const withTable of [false, true]) {
  const N=3000; let tInst=0, tSet=0, tMod=0, sum=0;
  for(let i=0;i<N;i++){
    const a=performance.now(); const m=new WebAssembly.Module(mod(i, withTable)); const b=performance.now();
    const env={memory,i:helper.i,s:helper.s}; if (withTable) env.__indirect_function_table=table;
    const inst=new WebAssembly.Instance(m,{env}); const c=performance.now();
    table.set(i, inst.exports.f); const d=performance.now();
    sum += inst.exports.f(1,2,3,4,5);
    tMod+=b-a; tInst+=c-b; tSet+=d-c;
  }
  console.log(`funcs${withTable?"+table":""} n=${N}: module ${(tMod/N*1000).toFixed(0)}us inst ${(tInst/N*1000).toFixed(0)}us set ${(tSet/N*1000).toFixed(1)}us sum=${sum}`);
}
// call cost: via import vs via call_indirect through table
