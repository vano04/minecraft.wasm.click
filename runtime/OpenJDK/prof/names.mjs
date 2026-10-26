// names.mjs <module.wasm|.so> <out.json>: function index -> name, from the
// wasm "name" section. For reading an unnamed profile by hand; profile.sh does not need it.
import { readFileSync, writeFileSync } from "node:fs";
const [file, out] = process.argv.slice(2);
const d = readFileSync(file);
let i = 8;
const leb = () => { let r = 0, s = 0, b; do { b = d[i++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
const names = {};
while (i < d.length) {
  const id = d[i++]; const size = leb(); const end = i + size;
  if (id === 0) {
    const nl = leb(); const nm = d.subarray(i, i + nl).toString(); i += nl;
    if (nm === "name") {
      while (i < end) {
        const sub = d[i++]; const ssz = leb(); const send = i + ssz;
        if (sub === 1) {
          const cnt = leb();
          for (let k = 0; k < cnt; k++) { const idx = leb(); const l = leb(); names[idx] = d.subarray(i, i + l).toString(); i += l; }
        }
        i = send;
      }
    }
  }
  i = end;
}
writeFileSync(out, JSON.stringify(names));
console.log(`${Object.keys(names).length} names -> ${out}`);
