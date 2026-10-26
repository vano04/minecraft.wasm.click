// Class-file reading for the SDL shim gate: zip/jar/directory sources, and
// the member and class references each method's bytecode actually uses.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { inflateRawSync } from "node:zlib";

/** Every .class in a jar or directory as {name, bytes()}. */
export function classFiles(path) {
  if (statSync(path).isDirectory()) {
    const out = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".class")) out.push({ name: relative(path, full).split("\\").join("/"), bytes: () => readFileSync(full) });
      }
    };
    walk(path);
    return out;
  }
  const buf = readFileSync(path);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip: " + path);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    // Multi-release overlays are not on Minecraft's runtime path for these jars.
    if (!name.endsWith(".class") || name.startsWith("META-INF/")) continue;
    out.push({
      name,
      bytes() {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + csize);
        return method === 0 ? data : inflateRawSync(data);
      },
    });
  }
  return out;
}

// Instruction lengths (0 = variable: switches and wide).
const LEN = new Uint8Array(256).fill(1);
for (const op of [0x10, 0x12, 0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3a, 0xa9, 0xbc]) LEN[op] = 2;
for (let op = 0x99; op <= 0xa8; op++) LEN[op] = 3;
for (const op of [0x11, 0x13, 0x14, 0x84, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xbd, 0xc0, 0xc1, 0xc6, 0xc7]) LEN[op] = 3;
LEN[0xc5] = 4;
for (const op of [0xb9, 0xba, 0xc8, 0xc9]) LEN[op] = 5;
LEN[0xaa] = LEN[0xab] = LEN[0xc4] = 0;
/** Opcodes whose operand is a constant-pool index (u2, except ldc's u1). */
const CP_OPS = new Set([0x12, 0x13, 0x14, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xbb, 0xbd, 0xc0, 0xc1, 0xc5]);

/**
 * Parses a class: its name, declared members, and per method the member
 * references ({kind, owner, name, desc}) and class references its code uses.
 * Constant-pool entries no instruction uses are ignored on purpose: the
 * in-tab massager retargets a call by adding a new Methodref, and the old one
 * stays behind unused.
 */
export function parseClass(b) {
  const u2 = (o) => (b[o] << 8) | b[o + 1];
  const u4 = (o) => b.readUInt32BE(o);
  if (u4(0) !== 0xcafebabe) throw new Error("not a class file");
  const n = u2(8);
  const cp = new Array(n);
  let p = 10;
  for (let i = 1; i < n; i++) {
    const tag = b[p];
    switch (tag) {
      case 1: { const len = u2(p + 1); cp[i] = { tag, text: b.toString("utf8", p + 3, p + 3 + len) }; p += 3 + len; break; }
      case 7: case 8: case 16: case 19: case 20: cp[i] = { tag, a: u2(p + 1) }; p += 3; break;
      case 15: cp[i] = { tag, a: u2(p + 2) }; p += 4; break;
      case 3: case 4: cp[i] = { tag }; p += 5; break;
      case 9: case 10: case 11: case 12: case 17: case 18: cp[i] = { tag, a: u2(p + 1), b: u2(p + 3) }; p += 5; break;
      case 5: case 6: cp[i] = { tag }; p += 9; i++; break;
      default: throw new Error("bad constant tag " + tag);
    }
  }
  const utf = (i) => cp[i].text;
  const className = (i) => utf(cp[i].a);
  const memberRef = (i) => {
    const e = cp[i];
    const nt = cp[e.b];
    return { kind: e.tag === 9 ? "field" : "method", owner: className(e.a), name: utf(nt.a), desc: utf(nt.b) };
  };
  const self = className(u2(p + 2));
  const superIndex = u2(p + 4);
  const superName = superIndex ? className(superIndex) : null;
  p += 6;
  p += 2 + 2 * u2(p);
  const members = [];
  const methods = [];
  for (const kind of ["field", "method"]) {
    const count = u2(p); p += 2;
    for (let i = 0; i < count; i++) {
      const name = utf(u2(p + 2)), desc = utf(u2(p + 4));
      members.push({ kind, access: u2(p), name, desc });
      const used = { name, desc, refs: [], classes: [] };
      let attrs = u2(p + 6); p += 8;
      while (attrs--) {
        const len = u4(p + 2);
        if (kind === "method" && utf(u2(p)) === "Code") scanCode(b, p + 14, u4(p + 10), cp, memberRef, className, used);
        p += 6 + len;
      }
      if (kind === "method") methods.push(used);
    }
  }
  // Method handles are used by invokedynamic bootstraps (lambdas, method
  // references); count them as used by the class.
  const handles = [];
  for (let i = 1; i < n; i++) if (cp[i] && cp[i].tag === 15) handles.push(memberRef(cp[i].a));
  return { name: self, superName, members, methods, handles };
}

function scanCode(b, start, length, cp, memberRef, className, used) {
  const u2 = (o) => (b[o] << 8) | b[o + 1];
  const end = start + length;
  let pc = start;
  while (pc < end) {
    const op = b[pc];
    let len = LEN[op];
    if (op === 0xaa) { // tableswitch
      const pad = 3 - ((pc - start) % 4);
      const at = pc + 1 + pad;
      const low = b.readInt32BE(at + 4), high = b.readInt32BE(at + 8);
      len = 1 + pad + 12 + 4 * (high - low + 1);
    } else if (op === 0xab) { // lookupswitch
      const pad = 3 - ((pc - start) % 4);
      const at = pc + 1 + pad;
      len = 1 + pad + 8 + 8 * b.readInt32BE(at + 4);
    } else if (op === 0xc4) { // wide
      len = b[pc + 1] === 0x84 ? 6 : 4;
    }
    if (CP_OPS.has(op)) {
      const index = op === 0x12 ? b[pc + 1] : u2(pc + 1);
      const e = cp[index];
      if (e.tag === 9 || e.tag === 10 || e.tag === 11) used.refs.push(memberRef(index));
      else if (e.tag === 7) used.classes.push(className(index));
    }
    pc += len;
  }
}
