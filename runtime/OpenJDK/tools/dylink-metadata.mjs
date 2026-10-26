// Small, dependency-free validation mirror for Emscripten's dylink.0 reader.
//
// The generated Emscripten loader remains the production parser.  This module
// owns the byte-boundary contract used by its post-link patch and by the
// focused regression test, so a truncated native resource cannot reach a
// typed-array constructor with an invalid byte length.

export const MIN_DYNAMIC_LIBRARY_BYTES = 24;

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

function bytesOf(binary, label) {
  if (binary instanceof Uint8Array) return binary;
  if (binary instanceof ArrayBuffer) return new Uint8Array(binary);
  if (ArrayBuffer.isView(binary)) {
    return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
  }
  throw new TypeError(`${label} must be an ArrayBuffer or byte view`);
}

/**
 * Validate the minimum input needed by the generated dylink parser.
 *
 * This deliberately checks length only.  It does not pad or otherwise alter
 * the supplied bytes; magic/section validation belongs to the parser below.
 */
export function validateDynamicLibraryBytes(binary, label = "dynamic library") {
  const bytes = bytesOf(binary, label);
  if (bytes.byteLength < MIN_DYNAMIC_LIBRARY_BYTES) {
    throw new Error(
      `${label} is truncated: ${bytes.byteLength} bytes; `
      + `WebAssembly side modules require at least ${MIN_DYNAMIC_LIBRARY_BYTES} bytes`
    );
  }
  return bytes;
}

function readLeb(bytes, cursor, end, what) {
  let value = 0;
  let shift = 0;
  while (cursor.offset < end && shift < 35) {
    const byte = bytes[cursor.offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
  throw new Error(`invalid ${what} LEB128 in dynamic library`);
}

function readString(bytes, cursor, end, what) {
  const length = readLeb(bytes, cursor, end, `${what} length`);
  if (length > end - cursor.offset) {
    throw new Error(`truncated ${what} in dynamic library`);
  }
  const value = new TextDecoder().decode(bytes.subarray(cursor.offset, cursor.offset + length));
  cursor.offset += length;
  return value;
}

/**
 * Parse the small metadata prefix used by an Emscripten Wasm side module.
 * This is intentionally limited to the fields the loader needs for its
 * dynamic-link bookkeeping; unknown subsections remain forward-compatible.
 */
export function parseDylinkMetadata(binary, label = "dynamic library") {
  const bytes = validateDynamicLibraryBytes(binary, label);
  for (let i = 0; i < WASM_MAGIC.length; i++) {
    if (bytes[i] !== WASM_MAGIC[i]) {
      throw new Error(`${label} is not a WebAssembly module (missing wasm magic)`);
    }
  }

  // Emscripten's fast path requires dylink.0 to be the first custom section.
  if (bytes[8] !== 0) {
    throw new Error(`${label} is missing the first dylink.0 custom section`);
  }

  const sectionCursor = { offset: 9 };
  const sectionSize = readLeb(bytes, sectionCursor, bytes.byteLength, "dylink section size");
  const sectionEnd = sectionCursor.offset + sectionSize;
  if (sectionEnd > bytes.byteLength) {
    throw new Error(`${label} has a truncated dylink.0 section`);
  }

  const name = readString(bytes, sectionCursor, sectionEnd, "dylink section name");
  if (name !== "dylink.0") {
    throw new Error(`${label} first custom section is ${JSON.stringify(name)}, not dylink.0`);
  }

  const metadata = { neededDynlibs: [], runtimePaths: [] };
  while (sectionCursor.offset < sectionEnd) {
    const subsectionType = bytes[sectionCursor.offset++];
    const subsectionSize = readLeb(bytes, sectionCursor, sectionEnd, "dylink subsection size");
    const subsectionEnd = sectionCursor.offset + subsectionSize;
    if (subsectionEnd > sectionEnd) {
      throw new Error(`${label} has a truncated dylink.0 subsection`);
    }

    const subsectionCursor = { offset: sectionCursor.offset };
    if (subsectionType === 1) {
      metadata.memorySize = readLeb(bytes, subsectionCursor, subsectionEnd, "memory size");
      metadata.memoryAlign = readLeb(bytes, subsectionCursor, subsectionEnd, "memory alignment");
      metadata.tableSize = readLeb(bytes, subsectionCursor, subsectionEnd, "table size");
      metadata.tableAlign = readLeb(bytes, subsectionCursor, subsectionEnd, "table alignment");
    } else if (subsectionType === 2) {
      const count = readLeb(bytes, subsectionCursor, subsectionEnd, "needed library count");
      for (let i = 0; i < count; i++) {
        metadata.neededDynlibs.push(readString(
          bytes, subsectionCursor, subsectionEnd, "needed library name"
        ));
      }
    } else if (subsectionType === 5) {
      const count = readLeb(bytes, subsectionCursor, subsectionEnd, "runtime path count");
      for (let i = 0; i < count; i++) {
        metadata.runtimePaths.push(readString(
          bytes, subsectionCursor, subsectionEnd, "runtime path"
        ));
      }
    }

    // Unknown subsections and unconsumed fields are deliberately skipped just
    // like the generated Emscripten loader.
    sectionCursor.offset = subsectionEnd;
  }
  return metadata;
}
