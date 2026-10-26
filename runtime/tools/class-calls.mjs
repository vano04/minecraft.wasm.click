// Usage: node tools/class-calls.mjs <jar> <class> [<method>]
//   e.g. node tools/class-calls.mjs build/mojang-cache/versions/26.3/26.3.jar \
//          net.minecraft.client.multiplayer.ClientLevel tickEntities
// Lists each method's signature and the methods it calls, field it reads or
// invokedynamic it links, in code order: references only, never code. This
// is what a massage-plan `redirect` rule needs (owner, name, desc, opcode and
// how many sites) without a JDK's javap. Lambda bodies are separate methods
// (lambda$name$N); list them by name.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { jarTools } = await import(P + "/tools/wasmjvm-provenance.mjs");
const [jar, className, only] = process.argv.slice(2);
if (!className) {
  console.error("usage: node tools/class-calls.mjs <jar> <class> [<method>]");
  process.exit(2);
}
const raw = await jarTools(P).readEntry(new Uint8Array(await readFile(jar)), className.replace(/\./g, "/") + ".class");
if (!raw) throw new Error("no " + className + " in " + jar);
const bytes = new Uint8Array(raw);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const pool = [];
let at = 10;
for (let i = 1; i < view.getUint16(8); i++) {
  const tag = bytes[at];
  const e = { tag };
  if (tag === 1) {
    const n = view.getUint16(at + 1);
    e.text = new TextDecoder().decode(bytes.subarray(at + 3, at + 3 + n));
    at += 3 + n;
  } else if (tag === 3 || tag === 4) at += 5;
  else if (tag === 5 || tag === 6) { at += 9; pool[i] = e; i++; continue; }
  else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) { e.a = view.getUint16(at + 1); at += 3; }
  else if (tag === 15) at += 4;
  else { e.a = view.getUint16(at + 1); e.b = view.getUint16(at + 3); at += 5; }
  pool[i] = e;
}
const utf8 = (i) => pool[i]?.text;
const nat = (i) => `${utf8(pool[i].a)} ${utf8(pool[i].b)}`;
const ref = (i) => {
  const e = pool[i];
  if (e.tag === 18) return "indy " + nat(e.b);
  return `${utf8(pool[e.a].a)}.${nat(e.b)}`;
};

const OPS = { 0xb2: "getstatic", 0xb4: "getfield", 0xb6: "invokevirtual", 0xb7: "invokespecial",
  0xb8: "invokestatic", 0xb9: "invokeinterface", 0xba: "invokedynamic" };
const length = (code, pc) => {
  const op = code[pc];
  if (op === 0xaa || op === 0xab) {
    let a = pc + 1;
    a += (4 - (a % 4)) % 4;
    const v = new DataView(code.buffer, code.byteOffset, code.byteLength);
    if (op === 0xaa) return a + 12 + (v.getInt32(a + 8) - v.getInt32(a + 4) + 1) * 4 - pc;
    return a + 8 + v.getInt32(a + 4) * 8 - pc;
  }
  if (op === 0xc4) return code[pc + 1] === 0x84 ? 6 : 4;
  if (op === 0x10 || op === 0x12 || op === 0xbc) return 2;
  if ((op >= 0x15 && op <= 0x19) || (op >= 0x36 && op <= 0x3a) || op === 0xa9) return 2;
  if (op === 0x11 || op === 0x13 || op === 0x14 || op === 0x84) return 3;
  if (op >= 0x99 && op <= 0xa8) return 3;
  if (op >= 0xb2 && op <= 0xb8) return 3;
  if (op === 0xbb || op === 0xbd || op === 0xc0 || op === 0xc1 || op === 0xc6 || op === 0xc7) return 3;
  if (op === 0xb9 || op === 0xba || op === 0xc8 || op === 0xc9) return 5;
  if (op === 0xc5) return 4;
  return 1;
};

at += 6;
at += 2 + view.getUint16(at) * 2;
for (let n = view.getUint16(at), i = 0, f = (at += 2); i < n; i++) {
  const attrs = view.getUint16(at + 6);
  at += 8;
  for (let a = 0; a < attrs; a++) at += 6 + view.getUint32(at + 2);
}
const methods = view.getUint16(at);
at += 2;
for (let i = 0; i < methods; i++) {
  const name = utf8(view.getUint16(at + 2)), desc = utf8(view.getUint16(at + 4));
  const attrs = view.getUint16(at + 6);
  at += 8;
  for (let a = 0; a < attrs; a++) {
    const len = view.getUint32(at + 2);
    if (utf8(view.getUint16(at)) === "Code" && (!only || name === only)) {
      const codeLength = view.getUint32(at + 10);
      const code = bytes.subarray(at + 14, at + 14 + codeLength);
      console.log(`${name}${desc}  [${codeLength} bytes]`);
      for (let pc = 0; pc < code.length; pc += length(code, pc)) {
        const op = OPS[code[pc]];
        if (op && op !== "getstatic") console.log(`  ${pc}: ${op} ${ref((code[pc + 1] << 8) | code[pc + 2])}`);
      }
    }
    at += 6 + len;
  }
}
