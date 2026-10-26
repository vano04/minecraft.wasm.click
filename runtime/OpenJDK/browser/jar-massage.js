// In-browser JAR massaging.
//
// The player's client JAR is fetched straight from Mojang's CDN by the browser
// and never touches a server. Before the JVM can load it, it needs the same
// preparation the desktop build applies - starting with the one that is a pure
// archive operation: Mojang ships a *signed* jar, MC-Web's port contributes
// unsigned classes to the same net.minecraft.* packages, and mixing the two
// makes the very first class load die with
//
//   SecurityException: class "net.minecraft.TracingExecutor"'s signer
//   information does not match signer information of other classes in the
//   same package
//
// Entries are copied byte-for-byte, still deflated. Nothing is recompressed
// and nothing is decoded: this rewrites the container, not the content. That
// keeps it fast on a 39 MB archive and keeps every class file bit-identical to
// what Mojang published.
//
// Loaded by the page with a <script> tag and used on its main thread, by
// Install (mojang-upstream.js installPayload) and by pre.js's preRun; it is
// not baked into javavm.js, so it can be edited without relinking the
// runtime. tools/build-wasmjvm.mjs runs this same file to pin the result.

(function () {
  const EOCD_SIGNATURE = 0x06054b50;
  const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
  const EOCD64_SIGNATURE = 0x06064b50;
  const CENTRAL_SIGNATURE = 0x02014b50;
  const LOCAL_SIGNATURE = 0x04034b50;

  // What the desktop transform excludes, as a container-level filter.
  const SIGNATURE_ENTRY = /^META-INF\/(.*\.(SF|RSA|DSA|EC)|SIG-[^/]*)$/i;

  const findEndOfCentralDirectory = (view, bytes) => {
    // The comment field is variable length, so scan back for the signature -
    // exactly what java.util.zip does. 64 KiB is the maximum comment size.
    const limit = Math.max(0, bytes.length - 0x10000 - 22);
    for (let at = bytes.length - 22; at >= limit; at--) {
      if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
    }
    throw new Error("not a zip: no end-of-central-directory record");
  };

  /**
   * Reads the central directory and returns one record per entry, each holding
   * the byte ranges to copy rather than the data itself.
   */
  const readCentralDirectory = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEndOfCentralDirectory(view, bytes);
    let count = view.getUint16(eocd + 10, true);
    let directoryOffset = view.getUint32(eocd + 16, true);

    // Zip64: a 39 MB jar does not need it, but a jar with more than 65535
    // entries does, and silently truncating to 65535 would drop classes.
    if (count === 0xffff || directoryOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || view.getUint32(locator, true) !== EOCD64_LOCATOR_SIGNATURE) {
        throw new Error("zip64 sentinel without a locator");
      }
      const eocd64 = Number(view.getBigUint64(locator + 8, true));
      if (view.getUint32(eocd64, true) !== EOCD64_SIGNATURE) {
        throw new Error("zip64 locator does not point at a zip64 EOCD");
      }
      count = Number(view.getBigUint64(eocd64 + 32, true));
      directoryOffset = Number(view.getBigUint64(eocd64 + 48, true));
    }

    const entries = [];
    let at = directoryOffset;
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
        throw new Error("bad central directory header at entry " + i);
      }
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const headerLength = 46 + nameLength + extraLength + commentLength;
      entries.push({
        name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
        localOffset: view.getUint32(at + 42, true),
        // The central directory is authoritative: a local header carries zero
        // sizes whenever the entry uses a data descriptor.
        method: view.getUint16(at + 10, true),
        compressedSize: view.getUint32(at + 20, true),
        central: bytes.subarray(at, at + headerLength),
      });
      at += headerLength;
    }
    return { entries, view };
  };

  /** The exact on-disk span of one local file record, header plus payload. */
  const localRecordLength = (view, bytes, entry) => {
    const at = entry.localOffset;
    if (view.getUint32(at, true) !== LOCAL_SIGNATURE) {
      throw new Error("bad local header for " + entry.name);
    }
    const flags = view.getUint16(at + 6, true);
    let compressedSize = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    let length = 30 + nameLength + extraLength + compressedSize;
    // Bit 3: sizes live in a data descriptor after the payload, and the local
    // header's are zero. Mojang's jar does not use it, but a repacked one can.
    if (flags & 0x08) {
      const central = new DataView(entry.central.buffer, entry.central.byteOffset,
        entry.central.byteLength);
      compressedSize = central.getUint32(20, true);
      length = 30 + nameLength + extraLength + compressedSize;
      const after = at + length;
      const hasSignature = view.getUint32(after, true) === 0x08074b50;
      length += hasSignature ? 16 : 12;
    }
    return length;
  };

  let crcTable = null;
  const crc32 = (bytes) => {
    if (!crcTable) {
      crcTable = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c;
      }
    }
    let c = -1;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  const inflateRaw = async (bytes) => {
    const stream = new Response(bytes).body
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  /** A replacement entry, written STORED so no deflate is needed. */
  const storedRecord = (name, data) => {
    const nameBytes = new TextEncoder().encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, LOCAL_SIGNATURE, true);
    view.setUint16(4, 20, true);              // version needed
    view.setUint16(8, 0, true);               // method: stored
    view.setUint32(14, crc32(data), true);
    view.setUint32(18, data.length, true);    // compressed size
    view.setUint32(22, data.length, true);    // uncompressed size
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_SIGNATURE, true);
    centralView.setUint16(4, 20, true);       // version made by
    centralView.setUint16(6, 20, true);       // version needed
    centralView.setUint16(10, 0, true);       // method: stored
    centralView.setUint32(16, crc32(data), true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    central.set(nameBytes, 46);
    return { local, central };
  };

  /**
   * Rewrites the archive without the entries the filter rejects, and with the
   * replacements supplied. Untouched entries are copied byte-for-byte, still
   * deflated; replacements are written STORED so the browser never has to
   * deflate anything.
   *
   * @param {Uint8Array} bytes an ordinary zip/jar
   * @param {(name: string) => boolean} [reject]
   * @param {Map<string, Uint8Array>} [replacements] entry name -> new content
   * @returns {{bytes: Uint8Array, kept: number, dropped: string[]}}
   */
  function massageJar(bytes, reject, replacements, additions) {
    const rejects = reject || ((name) => SIGNATURE_ENTRY.test(name));
    const replaced = replacements || new Map();
    const added = additions || new Map();
    const { entries, view } = readCentralDirectory(bytes);
    const kept = [];
    const dropped = [];
    for (const entry of entries) {
      if (rejects(entry.name)) { dropped.push(entry.name); continue; }
      entry.localLength = localRecordLength(view, bytes, entry);
      kept.push(entry);
    }
    if (dropped.length === 0 && replaced.size === 0 && added.size === 0) {
      return { bytes, kept: entries.length, dropped };
    }
    for (const [name, data] of added) {
      kept.push({ name, added: true, stored: storedRecord(name, data) });
    }
    for (const entry of kept) {
      const replacement = replaced.get(entry.name);
      if (replacement) entry.stored = storedRecord(entry.name, replacement);
    }

    let size = 0;
    for (const entry of kept) {
      size += entry.stored
        ? entry.stored.local.length + entry.stored.central.length
        : entry.localLength + entry.central.length;
    }
    size += 22;
    const out = new Uint8Array(size);
    const outView = new DataView(out.buffer);

    let cursor = 0;
    for (const entry of kept) {
      entry.newOffset = cursor;
      if (entry.stored) {
        out.set(entry.stored.local, cursor);
        cursor += entry.stored.local.length;
      } else {
        out.set(bytes.subarray(entry.localOffset, entry.localOffset + entry.localLength), cursor);
        cursor += entry.localLength;
      }
    }
    const directoryStart = cursor;
    for (const entry of kept) {
      const central = entry.stored ? entry.stored.central : entry.central;
      out.set(central, cursor);
      // Only the local-header pointer moves; everything else, including the
      // CRC and the compressed bytes, is carried over untouched.
      outView.setUint32(cursor + 42, entry.newOffset, true);
      cursor += central.length;
    }
    outView.setUint32(cursor, EOCD_SIGNATURE, true);
    outView.setUint16(cursor + 8, kept.length, true);
    outView.setUint16(cursor + 10, kept.length, true);
    outView.setUint32(cursor + 12, directoryStart === cursor ? 0 : cursor - directoryStart, true);
    outView.setUint32(cursor + 16, directoryStart, true);

    return { bytes: out, kept: kept.length, dropped };
  }

  // ---------------------------------------------------------------- classes
  //
  // Some of what the desktop build does with ASM is, at the class-file level,
  // just repointing a method reference at a different owner. A constant pool
  // is indexed, not byte-addressed, so entries can be appended and a
  // Methodref's class_index rewritten in place without touching anything else
  // - no bytecode is decoded, no offsets move, and every other byte of the
  // class survives untouched.

  const CONSTANT = {
    UTF8: 1, INTEGER: 3, FLOAT: 4, LONG: 5, DOUBLE: 6, CLASS: 7, STRING: 8,
    FIELDREF: 9, METHODREF: 10, INTERFACE_METHODREF: 11, NAME_AND_TYPE: 12,
    METHOD_HANDLE: 15, METHOD_TYPE: 16, DYNAMIC: 17, INVOKE_DYNAMIC: 18,
    MODULE: 19, PACKAGE: 20,
  };

  /** Walks the constant pool, returning one record per entry. */
  const readConstantPool = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, false) !== 0xcafebabe) throw new Error("not a class file");
    const count = view.getUint16(8, false);
    const pool = new Array(count);
    let at = 10;
    for (let i = 1; i < count; i++) {
      const tag = view.getUint8(at);
      const entry = { tag, at };
      switch (tag) {
        case CONSTANT.UTF8: {
          const length = view.getUint16(at + 1, false);
          entry.text = new TextDecoder().decode(bytes.subarray(at + 3, at + 3 + length));
          entry.length = 3 + length;
          break;
        }
        case CONSTANT.INTEGER: case CONSTANT.FLOAT: entry.length = 5; break;
        case CONSTANT.LONG: case CONSTANT.DOUBLE: entry.length = 9; break;
        case CONSTANT.CLASS: case CONSTANT.STRING: case CONSTANT.METHOD_TYPE:
        case CONSTANT.MODULE: case CONSTANT.PACKAGE:
          entry.ref = view.getUint16(at + 1, false); entry.length = 3; break;
        case CONSTANT.FIELDREF: case CONSTANT.METHODREF:
        case CONSTANT.INTERFACE_METHODREF: case CONSTANT.NAME_AND_TYPE:
        case CONSTANT.DYNAMIC: case CONSTANT.INVOKE_DYNAMIC:
          entry.a = view.getUint16(at + 1, false);
          entry.b = view.getUint16(at + 3, false);
          entry.length = 5; break;
        case CONSTANT.METHOD_HANDLE: entry.length = 4; break;
        default: throw new Error("unknown constant pool tag " + tag + " at " + i);
      }
      pool[i] = entry;
      at += entry.length;
      // Longs and doubles take two slots; the second is unusable.
      if (tag === CONSTANT.LONG || tag === CONSTANT.DOUBLE) i++;
    }
    return { pool, count, poolEnd: at, view };
  };

  /**
   * Repoint selected method references at a different owner class.
   *
   * @param {Uint8Array} bytes one class file
   * @param {Array<{owner:string,name:string,newOwner:string}>} rules
   * @returns {{bytes: Uint8Array, changed: number}}
   */
  function retargetMethodOwners(bytes, rules) {
    const { pool, count, poolEnd, view } = readConstantPool(bytes);
    const utf8 = (index) => (pool[index] && pool[index].tag === CONSTANT.UTF8)
      ? pool[index].text : null;
    const className = (index) => (pool[index] && pool[index].tag === CONSTANT.CLASS)
      ? utf8(pool[index].ref) : null;

    const wanted = new Map();   // newOwner -> appended class index
    const edits = [];           // {at, classIndex}
    for (let i = 1; i < count; i++) {
      const entry = pool[i];
      if (!entry || (entry.tag !== CONSTANT.METHODREF
          && entry.tag !== CONSTANT.INTERFACE_METHODREF)) continue;
      const owner = className(entry.a);
      const nameAndType = pool[entry.b];
      if (!owner || !nameAndType || nameAndType.tag !== CONSTANT.NAME_AND_TYPE) continue;
      const name = utf8(nameAndType.a);
      const rule = rules.find((r) => r.owner === owner && r.name === name);
      if (!rule) continue;
      wanted.set(rule.newOwner, -1);
      edits.push({ at: entry.at + 1, newOwner: rule.newOwner });
    }
    if (edits.length === 0) return { bytes, changed: 0 };

    // Append one UTF8 + one Class per new owner. Existing indices are stable,
    // so nothing else in the file needs to move.
    const appended = [];
    let nextIndex = count;
    const encoder = new TextEncoder();
    for (const owner of wanted.keys()) {
      const name = encoder.encode(owner);
      const utf8Entry = new Uint8Array(3 + name.length);
      utf8Entry[0] = CONSTANT.UTF8;
      new DataView(utf8Entry.buffer).setUint16(1, name.length, false);
      utf8Entry.set(name, 3);
      const utf8Index = nextIndex++;
      const classEntry = new Uint8Array(3);
      classEntry[0] = CONSTANT.CLASS;
      new DataView(classEntry.buffer).setUint16(1, utf8Index, false);
      const classIndex = nextIndex++;
      appended.push(utf8Entry, classEntry);
      wanted.set(owner, classIndex);
    }

    let appendedLength = 0;
    for (const part of appended) appendedLength += part.length;
    const out = new Uint8Array(bytes.length + appendedLength);
    out.set(bytes.subarray(0, poolEnd), 0);
    let cursor = poolEnd;
    for (const part of appended) { out.set(part, cursor); cursor += part.length; }
    out.set(bytes.subarray(poolEnd), cursor);

    const outView = new DataView(out.buffer);
    outView.setUint16(8, nextIndex, false);            // constant_pool_count
    for (const edit of edits) {
      outView.setUint16(edit.at, wanted.get(edit.newOwner), false);
    }
    return { bytes: out, changed: edits.length };
  }

  const ACC_PUBLIC = 0x0001, ACC_PRIVATE = 0x0002, ACC_PROTECTED = 0x0004;

  /**
   * Make selected methods and fields public.
   *
   * The port calls into Minecraft internals that are private on the desktop -
   * the frame pump drives {@code Minecraft.runTick} directly, for one - and the
   * desktop build widens them with ASM. At the class-file level an access flag
   * is a u2 in the member's header: flipping it changes no lengths and moves
   * nothing, so this is the safest edit of the three.
   *
   * @param {Uint8Array} bytes one class file
   * @param {Array<{kind?: string, name: string, desc?: string}>} rules
   */
  function widenMembers(bytes, rules) {
    const { pool, poolEnd } = readConstantPool(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const utf8 = (index) => (pool[index] && pool[index].tag === CONSTANT.UTF8)
      ? pool[index].text : null;

    let at = poolEnd + 6;                       // access, this_class, super_class
    at += 2 + view.getUint16(at, false) * 2;    // interfaces
    let changed = 0;
    for (const kind of ["field", "method"]) {
      const count = view.getUint16(at, false);
      at += 2;
      for (let i = 0; i < count; i++) {
        const memberAt = at;
        const flags = view.getUint16(at, false);
        const name = utf8(view.getUint16(at + 2, false));
        const desc = utf8(view.getUint16(at + 4, false));
        const attributes = view.getUint16(at + 6, false);
        at += 8;
        for (let a = 0; a < attributes; a++) {
          at += 6 + view.getUint32(at + 2, false);
        }
        const rule = rules.find((r) => (r.kind || "method") === kind
          && r.name === name && (!r.desc || r.desc === desc));
        if (!rule) continue;
        const widened = (flags & ~(ACC_PRIVATE | ACC_PROTECTED)) | ACC_PUBLIC;
        if (widened !== flags) {
          view.setUint16(memberAt, widened, false);
          changed++;
        }
      }
    }
    return { bytes, changed };
  }

  /**
   * The whole in-browser preparation: drop the signature entries, then apply
   * method-owner retargets to a named set of classes.
   *
   * Targets are named rather than discovered. Class data is deflated, so a
   * content scan would have to inflate all 31,707 entries to find the handful
   * that matter; the desktop transform names its entries too, for the same
   * reason. A named target that turns out not to reference the owner is
   * simply left unchanged.
   *
   * @param {Uint8Array} bytes the jar as Mojang published it
   * @param {{targets: string[], rules: Array<{owner:string,name:string,newOwner:string}>}} plan
   */
  /**
   * Replace a void method's body with a bare {@code return}.
   *
   * The fourth mechanism, and the only one that touches code. It is safe
   * because it *replaces* the whole Code attribute rather than editing
   * instructions: there are no branches left to dangle, no stack map to keep
   * consistent, and no offsets outside the attribute to fix. Attribute lengths
   * are self-describing, so shrinking one moves bytes without breaking
   * anything that refers to them - nothing in a class file is byte-addressed.
   *
   * Void methods only. Returning a value would mean synthesising a default,
   * and a caller that needs a real value needs a real implementation.
   *
   * @param {Uint8Array} bytes one class file
   * @param {Array<{name: string, desc: string}>} rules
   */
  function stubMethods(bytes, rules) {
    const { pool, poolEnd } = readConstantPool(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const utf8 = (index) => (pool[index] && pool[index].tag === CONSTANT.UTF8)
      ? pool[index].text : null;

    let at = poolEnd + 6;
    at += 2 + view.getUint16(at, false) * 2;    // interfaces
    // fields
    let fieldCount = view.getUint16(at, false);
    at += 2;
    for (let i = 0; i < fieldCount; i++) {
      const attributes = view.getUint16(at + 6, false);
      at += 8;
      for (let a = 0; a < attributes; a++) at += 6 + view.getUint32(at + 2, false);
    }
    const edits = [];
    const methodCount = view.getUint16(at, false);
    at += 2;
    for (let i = 0; i < methodCount; i++) {
      const flags = view.getUint16(at, false);
      const name = utf8(view.getUint16(at + 2, false));
      const desc = utf8(view.getUint16(at + 4, false));
      const attributes = view.getUint16(at + 6, false);
      at += 8;
      const rule = rules.find((r) => r.name === name && r.desc === desc);
      for (let a = 0; a < attributes; a++) {
        const attributeAt = at;
        const attributeName = utf8(view.getUint16(at, false));
        const length = view.getUint32(at + 2, false);
        at += 6 + length;
        if (rule && attributeName === "Code") {
          if (!desc.endsWith(")V")) throw new Error("cannot stub non-void " + name + desc);
          // this + declared arguments; only the count matters for a body that
          // touches nothing.
          const isStatic = (flags & 0x0008) !== 0;
          const args = (desc.match(/\[*([BCDFIJSZ]|L[^;]+;)/g) || []).length;
          const wide = (desc.match(/\[*[DJ]/g) || []).length;
          edits.push({
            at: attributeAt, span: 6 + length,
            nameIndex: view.getUint16(attributeAt, false),
            maxLocals: (isStatic ? 0 : 1) + args + wide,
          });
        }
      }
    }
    if (edits.length === 0) return { bytes, changed: 0 };

    // Rebuild once, splicing every replacement in order.
    const parts = [];
    let cursor = 0;
    for (const edit of edits) {
      parts.push(bytes.subarray(cursor, edit.at));
      const replacement = new Uint8Array(6 + 13);
      const replacementView = new DataView(replacement.buffer);
      replacementView.setUint16(0, edit.nameIndex, false);
      replacementView.setUint32(2, 13, false);       // attribute_length
      replacementView.setUint16(6, 0, false);        // max_stack
      replacementView.setUint16(8, edit.maxLocals, false);
      replacementView.setUint32(10, 1, false);       // code_length
      replacement[14] = 0xb1;                        // return
      replacementView.setUint16(15, 0, false);       // exception_table_length
      replacementView.setUint16(17, 0, false);       // attributes_count
      parts.push(replacement);
      cursor = edit.at + edit.span;
    }
    parts.push(bytes.subarray(cursor));
    let size = 0;
    for (const part of parts) size += part.length;
    const out = new Uint8Array(size);
    let write = 0;
    for (const part of parts) { out.set(part, write); write += part.length; }
    return { bytes: out, changed: edits.length };
  }

  // ---------------------------------------------------------------- code
  //
  // Two edits inside a method's code, both in place: no length changes, so
  // no offset, branch, exception range or stack map frame moves. Found by
  // decoding the method's instructions (never by a byte-pattern scan across
  // the file), and each rule states how many sites it expects, so a changed
  // jar fails loudly instead of being half-patched.

  /** Byte length of the instruction at `pc` (code is the method's code). */
  const instructionLength = (code, pc) => {
    const op = code[pc];
    if (op === 0xaa || op === 0xab) {              // tableswitch, lookupswitch
      let at = pc + 1;
      at += (4 - (at % 4)) % 4;                    // padding to a 4-byte boundary
      const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
      if (op === 0xaa) {
        const low = view.getInt32(at + 4, false), high = view.getInt32(at + 8, false);
        return at + 12 + (high - low + 1) * 4 - pc;
      }
      return at + 8 + view.getInt32(at + 4, false) * 8 - pc;
    }
    if (op === 0xc4) return code[pc + 1] === 0x84 ? 6 : 4;    // wide
    if (op === 0x10 || op === 0x12 || op === 0xbc) return 2;  // bipush, ldc, newarray
    if ((op >= 0x15 && op <= 0x19) || (op >= 0x36 && op <= 0x3a) || op === 0xa9) return 2;
    if (op === 0x11 || op === 0x13 || op === 0x14 || op === 0x84) return 3;
    if (op >= 0x99 && op <= 0xa8) return 3;        // if*, goto, jsr
    if (op >= 0xb2 && op <= 0xb8) return 3;        // get/putfield/static, invoke v/s/s
    if (op === 0xbb || op === 0xbd || op === 0xc0 || op === 0xc1) return 3;
    if (op === 0xc6 || op === 0xc7) return 3;      // ifnull, ifnonnull
    if (op === 0xb9 || op === 0xba) return 5;      // invokeinterface, invokedynamic
    if (op === 0xc5) return 4;                     // multianewarray
    if (op === 0xc8 || op === 0xc9) return 5;      // goto_w, jsr_w
    return 1;
  };

  /** Every method's code: {name, desc, codeAt (byte offset of the code), codeLength}. */
  const methodCodes = (bytes, pool, poolEnd) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const utf8 = (index) => (pool[index] && pool[index].tag === CONSTANT.UTF8) ? pool[index].text : null;
    let at = poolEnd + 6;
    at += 2 + view.getUint16(at, false) * 2;       // interfaces
    const fieldCount = view.getUint16(at, false);
    at += 2;
    for (let i = 0; i < fieldCount; i++) {
      const attributes = view.getUint16(at + 6, false);
      at += 8;
      for (let a = 0; a < attributes; a++) at += 6 + view.getUint32(at + 2, false);
    }
    const methods = [];
    const methodCount = view.getUint16(at, false);
    at += 2;
    for (let i = 0; i < methodCount; i++) {
      const name = utf8(view.getUint16(at + 2, false));
      const desc = utf8(view.getUint16(at + 4, false));
      const attributes = view.getUint16(at + 6, false);
      at += 8;
      for (let a = 0; a < attributes; a++) {
        const length = view.getUint32(at + 2, false);
        if (utf8(view.getUint16(at, false)) === "Code") {
          methods.push({ name, desc, codeAt: at + 14, codeLength: view.getUint32(at + 10, false) });
        }
        at += 6 + length;
      }
    }
    return methods;
  };

  /**
   * Replace field reads and method calls with calls to static helpers.
   *
   * A rule names a method of the class (`in`, `inDesc`), the reference its
   * instruction uses (`owner`, `name`, `desc`, and `ops`: the opcodes it may
   * appear with) and the helper (`newOwner`, `newName`, `newDesc`); `expect`
   * is how many sites there must be. The instruction becomes invokestatic of
   * the helper, whose descriptor takes the receiver first for an instance
   * member and so consumes and produces exactly what the original did. All
   * these instructions are three bytes, so nothing moves.
   *
   * @param {Uint8Array} bytes one class file
   */
  function redirectReferences(bytes, rules) {
    let { pool, count, poolEnd } = readConstantPool(bytes);
    const utf8 = (index) => (pool[index] && pool[index].tag === CONSTANT.UTF8) ? pool[index].text : null;
    const refOf = (index) => {
      const entry = pool[index];
      if (!entry || ![CONSTANT.FIELDREF, CONSTANT.METHODREF, CONSTANT.INTERFACE_METHODREF].includes(entry.tag)) return null;
      const cls = pool[entry.a], nat = pool[entry.b];
      if (!cls || cls.tag !== CONSTANT.CLASS || !nat || nat.tag !== CONSTANT.NAME_AND_TYPE) return null;
      return { owner: utf8(cls.ref), name: utf8(nat.a), desc: utf8(nat.b) };
    };
    // Constant pool entries to append: the helper's Methodref per rule.
    const appended = [];
    let nextIndex = count;
    const encoder = new TextEncoder();
    const addUtf8 = (text) => {
      const b = encoder.encode(text);
      const e = new Uint8Array(3 + b.length);
      e[0] = CONSTANT.UTF8; new DataView(e.buffer).setUint16(1, b.length, false); e.set(b, 3);
      appended.push(e); return nextIndex++;
    };
    const addRef = (tag, a, b) => {
      const e = new Uint8Array(5); e[0] = tag;
      new DataView(e.buffer).setUint16(1, a, false); new DataView(e.buffer).setUint16(3, b, false);
      appended.push(e); return nextIndex++;
    };
    const addClass = (nameIndex) => {
      const e = new Uint8Array(3); e[0] = CONSTANT.CLASS;
      new DataView(e.buffer).setUint16(1, nameIndex, false);
      appended.push(e); return nextIndex++;
    };
    const methods = methodCodes(bytes, pool, poolEnd);
    const edits = [];   // {pc (absolute), helper}
    for (const rule of rules) {
      // A rule missing a field would otherwise append a zero-length UTF8 and
      // produce a class the JVM rejects with a ClassFormatError pointing at
      // the constant pool rather than at the rule that caused it.
      for (const field of ["ops", "owner", "name", "desc", "newOwner", "newName", "newDesc"]) {
        if (rule[field] == null) {
          throw new Error(`redirect ${rule.owner}.${rule.name} in ${rule.in || "*"}: no ${field}`);
        }
      }
      let found = 0;
      let helper = -1;
      for (const m of methods) {
        if (rule.in && (m.name !== rule.in || (rule.inDesc && m.desc !== rule.inDesc))) continue;
        const code = bytes.subarray(m.codeAt, m.codeAt + m.codeLength);
        for (let pc = 0; pc < code.length; pc += instructionLength(code, pc)) {
          if (!rule.ops.includes(code[pc])) continue;
          const ref = refOf((code[pc + 1] << 8) | code[pc + 2]);
          if (!ref || ref.owner !== rule.owner || ref.name !== rule.name || ref.desc !== rule.desc) continue;
          if (helper < 0) {
            helper = addRef(CONSTANT.METHODREF, addClass(addUtf8(rule.newOwner)),
              addRef(CONSTANT.NAME_AND_TYPE, addUtf8(rule.newName), addUtf8(rule.newDesc)));
          }
          edits.push({ at: m.codeAt + pc, helper, op: code[pc] });
          found++;
        }
      }
      if (found !== rule.expect) {
        throw new Error(`redirect ${rule.owner}.${rule.name} in ${rule.in || "*"}: expected ${rule.expect} site(s), found ${found}`);
      }
    }
    if (edits.length === 0) return { bytes, changed: 0 };
    let appendedLength = 0;
    for (const part of appended) appendedLength += part.length;
    const out = new Uint8Array(bytes.length + appendedLength);
    out.set(bytes.subarray(0, poolEnd), 0);
    let cursor = poolEnd;
    for (const part of appended) { out.set(part, cursor); cursor += part.length; }
    out.set(bytes.subarray(poolEnd), cursor);
    new DataView(out.buffer).setUint16(8, nextIndex, false);
    for (const edit of edits) {
      const at = edit.at + appendedLength;          // code follows the grown pool
      out[at] = 0xb8;                               // invokestatic
      out[at + 1] = edit.helper >> 8;
      out[at + 2] = edit.helper & 0xff;
      // invokeinterface is five bytes (index, count, 0): the two left over
      // become nops, or the count would run as aconst_null.
      if (edit.op === 0xb9) { out[at + 3] = 0x00; out[at + 4] = 0x00; }
    }
    return { bytes: out, changed: edits.length };
  }

  // --------------------------------------------------- in-place int patches
  //
  // The last of the five edit mechanisms, and the only one that changes a
  // value rather than a reference: a ticket radius, a loop bound. Like the
  // others it is in place - the constant is rewritten as a push of exactly
  // the width already there, so no instruction length changes and no offset,
  // branch target or stack map frame moves.


  /** The int an iconst/bipush/sipush pushes, or null for any other opcode. */
  const pushedInt = (code, pc) => {
    const op = code[pc];
    if (op >= 0x02 && op <= 0x08) return op - 0x03;            // iconst_m1 .. iconst_5
    if (op === 0x10) return (code[pc + 1] << 24) >> 24;          // bipush, signed
    if (op === 0x11) {                                          // sipush, signed
      const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
      return view.getInt16(pc + 1, false);
    }
    return null;
  };

  /**
   * Writes `value` as a push of exactly the width already there, so no
   * instruction, offset, branch target or stack map frame moves. A value that
   * needs a wider push is refused rather than silently lengthening the method.
   */
  const writePushedInt = (code, pc, value) => {
    const op = code[pc];
    if (op >= 0x02 && op <= 0x08) {
      if (value < -1 || value > 5) throw new Error(`iconst cannot push ${value}`);
      if (value + 0x03 !== op) code[pc] = value + 0x03;
      return true;
    }
    if (op === 0x10) {
      if (value < -128 || value > 127) throw new Error(`bipush cannot push ${value}`);
      if ((code[pc + 1] << 24 >> 24) !== value) code[pc + 1] = value & 0xff;
      return true;
    }
    if (op === 0x11) {
      if (value < -32768 || value > 32767) throw new Error(`sipush cannot push ${value}`);
      const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
      if (view.getInt16(pc + 1, false) !== value) view.setInt16(pc + 1, value, false);
      return true;
    }
    throw new Error(`opcode 0x${op.toString(16)} does not push an int constant`);
  };

  /**
   * Replace integer constants inside a method, in place.
   *
   * Two shapes, both exact-counted. A rule that names a call (`ops`, `owner`,
   * `name`, `desc`) replaces the constant pushed immediately before it - the
   * argument Mojang passes to that call - which is how a ticket radius is
   * recognised without guessing from the operand. A rule without one replaces
   * every push of `from` in the method, which is what a loop bound and its two
   * comparisons look like.
   *
   * Found by decoding the method's instructions, never by a byte-pattern scan,
   * and `expect` states how many sites there must be, so a changed jar fails
   * loudly instead of being half-patched.
   *
   * @param {Uint8Array} bytes one class file
   * @param {Array} rules
   */
  function patchIntArgs(bytes, rules) {
    const { pool, poolEnd } = readConstantPool(bytes);
    const utf8 = (index) => (pool[index] && pool[index].tag === CONSTANT.UTF8) ? pool[index].text : null;
    const refOf = (index) => {
      const entry = pool[index];
      if (!entry || ![CONSTANT.FIELDREF, CONSTANT.METHODREF, CONSTANT.INTERFACE_METHODREF].includes(entry.tag)) return null;
      const cls = pool[entry.a], nat = pool[entry.b];
      if (!cls || cls.tag !== CONSTANT.CLASS || !nat || nat.tag !== CONSTANT.NAME_AND_TYPE) return null;
      return { owner: utf8(cls.ref), name: utf8(nat.a), desc: utf8(nat.b) };
    };
    const methods = methodCodes(bytes, pool, poolEnd);
    let changed = 0;
    for (const rule of rules) {
      const to = rule.to;
      const where = `${rule.in}${rule.inDesc || ""} ${rule.name || "every push"}`;
      let found = 0;
      for (const m of methods) {
        if (m.name !== rule.in || (rule.inDesc && m.desc !== rule.inDesc)) continue;
        const code = bytes.subarray(m.codeAt, m.codeAt + m.codeLength);
        let previous = -1;
        for (let pc = 0; pc < code.length; pc += instructionLength(code, pc)) {
          let site = false;
          if (rule.name) {
            const ref = rule.ops.includes(code[pc])
              ? refOf((code[pc + 1] << 8) | code[pc + 2]) : null;
            site = !!ref && ref.owner === rule.owner && ref.name === rule.name
              && ref.desc === rule.desc;
          } else {
            site = pushedInt(code, pc) === rule.from;
          }
          if (site) {
            found++;
            // The call-anchored shape asserts the constant as well: a call
            // whose radius Mojang computes would keep vanilla's value, so it
            // is a failure rather than a silent no-op.
            if (rule.name && pushedInt(code, previous) !== rule.from) {
              throw new Error(`intArg ${where}: site ${found} does not push ${rule.from}`);
            }
            if (!rule.name) writePushedInt(code, pc, to);
            else writePushedInt(code, previous, to);
          }
          previous = pc;
        }
      }
      if (found !== rule.expect) {
        throw new Error(`intArg ${where}: expected ${rule.expect} site(s), found ${found}`);
      }
      changed += found;
    }
    return { bytes, changed };
  }

  /**
   * Replace a method's code bytes, `from` with `to` (hex strings of equal
   * length), where `from` is the whole code of the method: a constant in a
   * trivial body, say.
   */
  function patchMethodCode(bytes, rules) {
    const { pool, poolEnd } = readConstantPool(bytes);
    const methods = methodCodes(bytes, pool, poolEnd);
    const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
    let changed = 0;
    for (const rule of rules) {
      const from = hex(rule.from), to = hex(rule.to);
      if (from.length !== to.length) throw new Error("patchCode: lengths differ for " + rule.name);
      const m = methods.find((x) => x.name === rule.name && x.desc === rule.desc);
      if (!m) throw new Error("patchCode: no method " + rule.name + rule.desc);
      const code = bytes.subarray(m.codeAt, m.codeAt + m.codeLength);
      if (code.length !== from.length || !code.every((b, i) => b === from[i])) {
        throw new Error("patchCode: " + rule.name + rule.desc + " is not the expected code");
      }
      code.set(to);
      changed++;
    }
    return { bytes, changed };
  }

  /**
   * The index the port's VanillaPackResources shadow reads to enumerate the
   * pack. The desktop build generates this file and the Zip task adds it to
   * the jar; without it every asset lookup misses and the first one to be
   * needed - the grass colormap - fails the resource reload.
   */
  const buildAssetIndex = (entries) => {
    const lines = [];
    for (const entry of entries) {
      const name = entry.name;
      if (name.endsWith("/")) continue;
      if (!name.startsWith("assets/") && !name.startsWith("data/")) continue;
      const separator = name.indexOf("/");
      const namespaceSeparator = name.indexOf("/", separator + 1);
      if (separator > 0 && namespaceSeparator > separator + 1
          && namespaceSeparator < name.length - 1) {
        lines.push(name);
      }
    }
    lines.sort();
    return new TextEncoder().encode(lines.join("\n") + "\n");
  };

  async function prepareClientJar(bytes, plan) {
    const { entries, view } = readCentralDirectory(bytes);
    // Derive the set rather than trusting a hand-maintained list: an entry
    // named only under stub/widen would otherwise never be inflated, and the
    // patch would silently not happen.
    const targets = new Set([
      ...(plan.targets || []),
      ...(plan.stub || []).map((t) => t.entry),
      ...(plan.widen || []).map((w) => w.entry),
      ...(plan.redirect || []).map((r) => r.entry),
      ...(plan.patchCode || []).map((c) => c.entry),
      ...(plan.intArg || []).map((r) => r.entry),
    ]);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const replacements = new Map();
    const missing = [];
    for (const name of targets) {
      const entry = byName.get(name);
      if (!entry) { missing.push(name); continue; }
      entry.localLength = localRecordLength(view, bytes, entry);
      const at = entry.localOffset;
      const nameLength = view.getUint16(at + 26, true);
      const extraLength = view.getUint16(at + 28, true);
      const dataAt = at + 30 + nameLength + extraLength;
      const raw = bytes.subarray(dataAt, dataAt + entry.compressedSize);
      const classBytes = entry.method === 0 ? raw : await inflateRaw(raw);
      // Widen first: it edits in place, so it must not run on the copy the
      // retarget returns (which would discard the flag change if nothing was
      // retargeted in that class).
      const widen = (plan.widen || []).filter((w) => w.entry === name);
      const widened = widen.length
        ? widenMembers(new Uint8Array(classBytes), widen)
        : { bytes: classBytes, changed: 0 };
      const stubs = (plan.stub || []).filter((t) => t.entry === name);
      const stubbed = stubs.length
        ? stubMethods(widened.bytes, stubs)
        : { bytes: widened.bytes, changed: 0 };
      const patched = retargetMethodOwners(stubbed.bytes, plan.rules || []);
      let current = patched.changed ? patched.bytes : stubbed.bytes;
      let changed = patched.changed || widened.changed || stubbed.changed;
      // A stored entry's bytes are a view into the jar: copy before editing.
      const own = (b) => (b === raw ? new Uint8Array(b) : b);
      const redirects = (plan.redirect || []).filter((r) => r.entry === name);
      if (redirects.length) {
        const r = redirectReferences(own(current), redirects);
        current = r.bytes; changed = changed || r.changed > 0;
      }
      const codes = (plan.patchCode || []).filter((c) => c.entry === name);
      if (codes.length) {
        const r = patchMethodCode(own(current), codes);
        current = r.bytes; changed = changed || r.changed > 0;
      }
      const ints = (plan.intArg || []).filter((r) => r.entry === name);
      if (ints.length) {
        const r = patchIntArgs(own(current), ints);
        current = r.bytes; changed = changed || r.changed > 0;
      }
      if (changed) replacements.set(name, current);
    }
    const additions = new Map();
    let indexed = 0;
    if (plan.assetIndex) {
      const index = buildAssetIndex(entries);
      additions.set(plan.assetIndex, index);
      indexed = index.length;
    }
    const result = massageJar(bytes, undefined, replacements, additions);
    return { ...result, patched: [...replacements.keys()], missing,
             added: [...additions.keys()], indexBytes: indexed };
  }

  /** Entry names, in central-directory order. Used by the provenance audit. */
  const listEntries = (bytes) => readCentralDirectory(bytes).entries.map((e) => e.name);

  /** One entry's uncompressed bytes, or null if the archive has no such entry. */
  const readEntry = async (bytes, name) => {
    const entry = readCentralDirectory(bytes).entries.find((e) => e.name === name);
    if (!entry) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = entry.localOffset;
    const dataAt = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const raw = bytes.subarray(dataAt, dataAt + entry.compressedSize);
    return entry.method === 0 ? raw : await inflateRaw(raw);
  };

  const api = { massageJar, prepareClientJar, retargetMethodOwners, widenMembers,
                stubMethods, redirectReferences, patchMethodCode, patchIntArgs,
                buildAssetIndex, listEntries, readEntry,
                readConstantPool, crc32, SIGNATURE_ENTRY };
  if (typeof globalThis !== "undefined") globalThis.mcWebJarMassage = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
