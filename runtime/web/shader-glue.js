// MC-Web shader glue (docs/SHADERS.md): prepares the GLSL of a pipeline -
// the game's #version 330 stage text with its includes expanded and the
// pipeline's defines injected by the port, read from the player's own jar at
// run time - for naga's Vulkan-flavoured GLSL frontend, with bindings that
// match the host's WebGPU pipeline layout. Then naga (tools/naga-wasm)
// translates it to WGSL. MC-Web ships this code and the translator; no shader
// text from the jar lives in this file or anywhere in the bundle.
//
// A classic script: the GPU worker importScripts it; node loads it with
// new Function (tests/shader-glue.test.mjs). Exposes globalThis.mcWebShaderGlue.
(function (root) {
  "use strict";

  // Bind-group layout of a pipeline, as the host builds it: WebGPU wants
  // unique bindings per group, so within each (merged) group the uniforms take
  // 0..nU-1 and each sampler then takes two (sampler at b, texture at b+1).
  // Groups beyond the device's bind-group limit fold into the last one.
  function computeLayout(groups, cap) {
    cap = cap || 4;
    const K = Math.min(cap, groups.length || 1);
    const map = groups.map((g, gi) => ({ ng: gi < K - 1 ? gi : K - 1, baseU: 0, baseS: 0 }));
    if (K !== groups.length) {
      const u = new Array(K).fill(0);
      groups.forEach((g, gi) => { map[gi].baseU = u[map[gi].ng]; u[map[gi].ng] += g.uniforms.length; });
      const s = u.slice();
      groups.forEach((g, gi) => { map[gi].baseS = s[map[gi].ng]; s[map[gi].ng] += g.samplers.length * 2; });
    }
    const mergedU = new Array(K).fill(0);
    groups.forEach((g, gi) => { mergedU[map[gi].ng] += g.uniforms.length; });
    const uniforms = new Map();
    const samplers = new Map();
    groups.forEach((g, gi) => {
      g.uniforms.forEach((un, ui) => uniforms.set(un.name,
        { g: map[gi].ng, b: map[gi].baseU + ui, type: un.type, format: un.format }));
      const base = Math.max(map[gi].baseS, mergedU[map[gi].ng]);
      g.samplers.forEach((s, si) => samplers.set(s, { g: map[gi].ng, b: base + si * 2 }));
    });
    return { K, uniforms, samplers };
  }

  // Comments go first so no rule below matches inside one; line structure is
  // kept so naga's error spans still point at the right line.
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");

  // GL combined sampler type -> [separate texture type, combined constructor].
  const SAMPLER_TYPES = {
    sampler2D: ["texture2D", "sampler2D"],
    samplerCube: ["textureCube", "samplerCube"],
    isampler2D: ["itexture2D", "isampler2D"],
    usampler2D: ["utexture2D", "usampler2D"],
  };

  // Typed reads of a texel buffer, which becomes a storage buffer of u32 words.
  const TEXEL_FETCH = {
    R8_SINT: (n) => `ivec4 _mcweb_fetch_${n}(int i){ uint w = ${n}_words[i >> 2]; `
      + `int v = int(bitfieldExtract(w, (i & 3) * 8, 8)); v = (v << 24) >> 24; return ivec4(v, 0, 0, 1); }`,
    R8_UINT: (n) => `uvec4 _mcweb_fetch_${n}(int i){ uint w = ${n}_words[i >> 2]; `
      + `return uvec4(bitfieldExtract(w, (i & 3) * 8, 8), 0u, 0u, 1u); }`,
    R32_SINT: (n) => `ivec4 _mcweb_fetch_${n}(int i){ return ivec4(int(${n}_words[i]), 0, 0, 1); }`,
    R32_FLOAT: (n) => `vec4 _mcweb_fetch_${n}(int i){ return vec4(uintBitsToFloat(${n}_words[i]), 0.0, 0.0, 1.0); }`,
  };

  /** The arguments of a call whose '(' is at s[open]: [{start, end}], and the index of ')'. */
  function splitArgs(s, open) {
    let depth = 0;
    const args = [];
    let start = open + 1;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") {
        depth--;
        if (depth === 0) {
          if (i > start || args.length) args.push({ start, end: i });
          return { args, close: i };
        }
      } else if (c === "," && depth === 1) {
        args.push({ start, end: i });
        start = i + 1;
      }
    }
    throw new Error("unbalanced call");
  }

  /**
   * Interface locations are left as they are: every stage the game ships
   * declares layout(location = N) on its inputs and outputs, and naga keeps
   * them (vertexInputs reads the vertex stage's back from the WGSL).
   * @param {string} src   GLSL with includes expanded and defines injected
   * @param {"vertex"|"fragment"} stage
   * @param {{layout: ReturnType<typeof computeLayout>, targets?: object[], notes: string[]}} ctx
   *   targets: the pipeline's colour targets, when the spec names them.
   */
  function glue(src, stage, ctx) {
    const notes = ctx.notes;
    let s = stripComments(src);

    // 1. Normalize OpenGL's vertex/instance IDs to Vulkan's names. GLSL uses
    //    int for these builtins; naga exposes uint, so preserve signed uses.
    const head = ["#version 450"];
    if (stage === "vertex") {
      for (const [gl, vk] of [["gl_VertexID", "gl_VertexIndex"], ["gl_InstanceID", "gl_InstanceIndex"]]) {
        s = s.replace(new RegExp(`\\b${gl}\\b`, "g"), vk);
        if (new RegExp(`\\b${vk}\\b`).test(s)) {
          s = s.replace(new RegExp(`\\b${vk}\\b`, "g"), `int(${vk})`);
          notes.push(`${vk} -> int`);
        }
      }
      if (/\bgl_PointSize\b/.test(s)) {
        head.push("float _mcweb_PointSize;", "#define gl_PointSize _mcweb_PointSize");
        notes.push("gl_PointSize dropped");
      }
    }
    if (!/^[ \t]*#version[^\n]*/m.test(s)) throw new Error("no #version line");
    s = s.replace(/^[ \t]*#version[^\n]*/m, head.join("\n"));

    // Bindings for blocks or samplers the pipeline layout does not list. The
    // source declares them but the pipeline never binds them, so they must be
    // statically unused; WGSL then drops them.
    let spare = 64;

    // 2. Uniform blocks get the layout's set and binding.
    s = s.replace(/layout\s*\(\s*std140\s*\)\s*uniform\s+(\w+)/g, (m, name) => {
      const u = ctx.layout.uniforms.get(name);
      if (!u) {
        notes.push(`block ${name} not in layout`);
        return `layout(std140, set=0, binding=${spare++}) uniform ${name}`;
      }
      return `layout(std140, set=${u.g}, binding=${u.b}) uniform ${name}`;
    });

    // 3. Opaque uniforms: combined samplers split into sampler + texture (a
    //    macro keeps the source's own name usable); texel buffers become
    //    storage buffers with a typed fetch.
    const globalSamplers = new Map();
    s = s.replace(/^([ \t]*)uniform\s+(\w+)\s+(\w+)\s*;/gm, (m, ind, type, name) => {
      const slot = ctx.layout.samplers.get(name) || ctx.layout.uniforms.get(name);
      let g, b;
      if (slot) { g = slot.g; b = slot.b; } else { notes.push(`opaque ${name} not in layout`); g = 0; b = spare; spare += 2; }
      if (type === "isamplerBuffer" || type === "usamplerBuffer" || type === "samplerBuffer") {
        const fmt = (slot && slot.format) || "R8_SINT";
        const fetch = TEXEL_FETCH[fmt];
        if (!fetch) throw new Error(`texel buffer format ${fmt} unsupported by glue`);
        notes.push(`texel buffer ${name} (${fmt}) -> storage`);
        return `${ind}layout(std430, set=${g}, binding=${b}) readonly buffer ${name}_buf { uint ${name}_words[]; };\n${fetch(name)}`;
      }
      const t = SAMPLER_TYPES[type];
      if (!t) throw new Error(`opaque type ${type} unsupported by glue`);
      globalSamplers.set(name, type);
      return `${ind}layout(set=${g}, binding=${b}) uniform sampler ${name}_mcs; `
        + `layout(set=${g}, binding=${b + 1}) uniform ${t[0]} ${name}_mct;\n#define ${name} ${t[1]}(${name}_mct, ${name}_mcs)`;
    });
    s = s.replace(/\btexelFetch\s*\(\s*(\w+)\s*,/g,
      (m, name) => (s.includes(`_mcweb_fetch_${name}(`) ? `_mcweb_fetch_${name}(` : m));

    // 4. Functions that take a combined sampler: split the parameter, keep its
    //    name usable inside the body by macro, and split the argument at
    //    every call site.
    const fnRe = /\b(\w+)\s+(\w+)\s*\(([^()]*)\)\s*\{/g;
    const fns = [];
    let fm;
    while ((fm = fnRe.exec(s))) {
      const params = fm[3].split(",").map((p) => p.trim());
      const idx = params.map((p, i) => {
        const mm = /^(?:in\s+)?(\w+)\s+(\w+)$/.exec(p);
        return mm && SAMPLER_TYPES[mm[1]] ? { i, type: mm[1], name: mm[2] } : null;
      }).filter(Boolean);
      if (idx.length) {
        fns.push({ name: fm[2], start: fm.index, paramsStart: fm.index + fm[0].indexOf("("),
          headerEnd: fm.index + fm[0].length, idx, params });
      }
    }
    for (const f of fns.slice().reverse()) {
      let depth = 1;
      let i = f.headerEnd;
      for (; i < s.length && depth; i++) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") depth--;
      }
      const bodyEnd = i;
      const newParams = f.params.map((p, pi) => {
        const sp = f.idx.find((x) => x.i === pi);
        return sp ? `${SAMPLER_TYPES[sp.type][0]} ${sp.name}_mct, sampler ${sp.name}_mcs` : p;
      }).join(", ");
      const defs = f.idx.map((x) => `#define ${x.name} ${SAMPLER_TYPES[x.type][1]}(${x.name}_mct, ${x.name}_mcs)`).join("\n");
      const undefs = f.idx.map((x) => `#undef ${x.name}` + (globalSamplers.has(x.name)
        ? `\n#define ${x.name} ${SAMPLER_TYPES[globalSamplers.get(x.name)][1]}(${x.name}_mct, ${x.name}_mcs)` : "")).join("\n");
      const header = s.slice(f.start, f.paramsStart) + "(" + newParams + ") {";
      s = s.slice(0, f.start) + `\n${defs}\n` + header + s.slice(f.headerEnd, bodyEnd) + `\n${undefs}\n` + s.slice(bodyEnd);
      notes.push(`fn ${f.name}: sampler param split`);
    }
    const byName = new Map();
    for (const f of fns) if (!byName.has(f.name)) byName.set(f.name, f);
    for (const f of byName.values()) {
      const callRe = new RegExp(`\\b${f.name}\\s*\\(`, "g");
      let out = "";
      let last = 0;
      let cm;
      while ((cm = callRe.exec(s))) {
        const open = cm.index + cm[0].length - 1;
        const before = s.slice(Math.max(0, cm.index - 40), cm.index);
        if (/\b(void|float|vec[234]|ivec[234]|uvec[234]|int|uint|bool|mat[234])\s+$/.test(before)) continue;
        const { args, close } = splitArgs(s, open);
        const call = s.slice(cm.index, open + 1) + args.map((a, ai) => {
          const txt = s.slice(a.start, a.end).trim();
          return f.idx.some((x) => x.i === ai) && /^\w+$/.test(txt) ? `${txt}_mct, ${txt}_mcs` : txt;
        }).join(", ") + ")";
        out += s.slice(last, cm.index) + call;
        last = close + 1;
        callRe.lastIndex = close + 1;
      }
      s = out + s.slice(last);
    }

    // 4b. Unsized const arrays: naga would infer a runtime-sized type, which
    //     cannot be constructed; size them from the initialiser.
    s = s.replace(/\bconst\s+(\w+)\s+(\w+)\s*\[\s*\]\s*=\s*(\w+)\s*\[\s*\]\s*\(/g, (m, t, n, t2, off, str) => {
      const { args } = splitArgs(str, off + m.length - 1);
      notes.push(`const ${n}[] sized ${args.length}`);
      return `const ${t} ${n}[${args.length}] = ${t2}[${args.length}](`;
    });
    s = s.replace(/\bconst\s+(\w+)\s*\[\s*\]\s*(\w+)\s*=\s*(\w+)\s*\[\s*\]\s*\(/g, (m, t, n, t2, off, str) => {
      const { args } = splitArgs(str, off + m.length - 1);
      notes.push(`const ${n}[] sized ${args.length}`);
      return `const ${t}[${args.length}] ${n} = ${t2}[${args.length}](`;
    });

    // 4c. A const int used as an array size: naga's frontend takes a
    //     function-local const as a variable ("Unknown variable") there, so
    //     each such size is replaced by the const's own expression, up to the
    //     next declaration of the same name.
    const consts = [...s.matchAll(/\bconst\s+int\s+(\w+)\s*=\s*([^;]+);/g)];
    for (let ci = consts.length - 1; ci >= 0; ci--) {
      const [decl, name, value] = consts[ci];
      const from = consts[ci].index + decl.length;
      const next = consts.slice(ci + 1).find((c) => c[1] === name);
      const to = next ? next.index : s.length;
      const size = new RegExp(`\\[\\s*${name}\\s*\\]`, "g");
      const scope = s.slice(from, to);
      if (!size.test(scope)) continue;
      s = s.slice(0, from) + scope.replace(size, `[(${value.trim()})]`) + s.slice(to);
      notes.push(`const int ${name} inlined as array size`);
    }

    // 5. Implicit-LOD sampling is fragment-only in WGSL; a GL vertex shader's
    //    texture() samples level 0.
    if (stage === "vertex" && /\btexture\s*\(/.test(s)) {
      s = s.replace(/^#version 450/m, "#version 450\n#define texture(s_, p_) textureLod(s_, p_, 0.0)");
      notes.push("VS texture->textureLod");
    }

    // 6. A fragment output with no colour target at its location (26.3's
    //    depth-only water mask still writes one) becomes a private variable,
    //    so the stage matches the pipeline's targets.
    if (stage === "fragment" && ctx.targets) {
      s = s.replace(/^([ \t]*)layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*out\s+(\w+)\s+(\w+)\s*;/gm,
        (m, ind, loc, type, name) => {
          if (ctx.targets[Number(loc)]) return m;
          notes.push(`FS output ${name} has no colour target`);
          return `${ind}${type} ${name};`;
        });
    }

    return s;
  }

  /** Both stages of one pipeline: {vs, fs, notes, layout}. spec: {bindGroups, colorTargets}, as the host receives it. */
  function gluePipeline(vertexSource, fragmentSource, spec, cap) {
    const layout = computeLayout(spec.bindGroups || [], cap);
    // As the host builds it (pipelineColorTargets): a spec with neither colour
    // targets nor depth state gets a default target, so its outputs stay.
    const targets = spec.colorTargets && (spec.colorTargets.length || spec.depthStencil) ? spec.colorTargets : null;
    const ctx = { layout, targets, notes: [] };
    const vs = glue(vertexSource, "vertex", ctx);
    const fs = glue(fragmentSource, "fragment", ctx);
    return { vs, fs, notes: ctx.notes, layout };
  }

  // ---------------------------------------------------------------------------
  // Host side of the translate path (docs/SHADERS-PLAN.md S5): everything
  // webgpu-host.js needs from a glued and translated pipeline that does not
  // touch the GPU, kept here so node can test it (tests/shader-host-translate).
  // ---------------------------------------------------------------------------

  /** Resource declarations in naga's WGSL: "g:b" -> {space, name, type}. */
  function wgslBindings(wgsl) {
    const out = new Map();
    const re = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]*)>)?\s+(\w+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(wgsl))) out.set(`${m[1]}:${m[2]}`, { space: (m[3] || "").trim(), name: m[4], type: m[5].trim() });
    return out;
  }

  /** WGSL texture type -> the bind-group layout's {sampleType, viewDimension}; null when not a texture. */
  function textureBinding(type) {
    const m = /^texture_(depth_)?(2d_array|cube_array|2d|cube|3d|1d)(?:<\s*(f32|i32|u32)\s*>)?$/.exec(type || "");
    if (!m) return null;
    const sampleType = m[1] ? "depth" : m[3] === "i32" ? "sint" : m[3] === "u32" ? "uint" : "float";
    return { sampleType, viewDimension: m[2].replace("_", "-") };
  }

  /**
   * Textures the translated stages only read texel by texel (textureLoad,
   * textureDimensions, textureNumLevels): never filtered, so their slots can
   * be unfilterable-float, which also takes depth and 32-bit float formats
   * (the game's depth copies and its order-independent transparency
   * targets). A texture passed on to a function counts as filtered.
   */
  function loadOnlyTextures(wgslTexts) {
    const uses = new Map();
    for (const text of wgslTexts) {
      for (const m of text.matchAll(/\b(\w+)_mct\b/g)) {
        const before = text.slice(Math.max(0, m.index - 32), m.index);
        if (/\bvar\s+$/.test(before)) continue;
        const name = m[1];
        const loadOnly = /\btexture(?:Load|Dimensions|NumLevels)\s*\(\s*$/.test(before);
        uses.set(name, (uses.has(name) ? uses.get(name) : true) && loadOnly);
      }
    }
    return new Set([...uses].filter(([, loadOnly]) => loadOnly).map(([name]) => name));
  }

  const VERTEX_AND_FRAGMENT = 3; // GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT

  /**
   * Bind-group layout entries for a translated pipeline, one array per merged
   * group, at the glue's bindings. Everything is visible to both stages (the
   * game samples the lightmap and overlay in vertex shaders); texture sample
   * type and view dimension come from what the shaders declare, and a float
   * texture the shaders only load from takes an unfilterable slot and a
   * non-filtering sampler. A filtered slot that is handed an unfilterable
   * texture at draw time is the host's to adapt (ensureBindGroups).
   * Also returns, per sampler name, what the host must bind there.
   */
  function layoutEntries(groups, layout, declared, loadOnly) {
    const entries = Array.from({ length: layout.K }, () => []);
    const samplerKinds = new Map();
    groups.forEach((g) => {
      g.uniforms.forEach((u) => {
        const at = layout.uniforms.get(u.name);
        entries[at.g].push({ binding: at.b, visibility: VERTEX_AND_FRAGMENT,
          buffer: { type: u.type === "TEXEL_BUFFER" ? "read-only-storage" : "uniform" } });
      });
      g.samplers.forEach((name) => {
        const at = layout.samplers.get(name);
        const decl = declared.get(`${at.g}:${at.b + 1}`);
        const tex = (decl && textureBinding(decl.type)) || { sampleType: "float", viewDimension: "2d" };
        let nonFiltering = false;
        if (tex.sampleType === "float" && loadOnly && loadOnly.has(name)) {
          tex.sampleType = "unfilterable-float";
          nonFiltering = true;
        }
        entries[at.g].push({ binding: at.b, visibility: VERTEX_AND_FRAGMENT,
          sampler: { type: nonFiltering ? "non-filtering" : "filtering" } });
        entries[at.g].push({ binding: at.b + 1, visibility: VERTEX_AND_FRAGMENT, texture: tex });
        samplerKinds.set(name, { nonFiltering, sampleType: tex.sampleType, viewDimension: tex.viewDimension });
      });
    });
    return { entries, samplerKinds };
  }

  /**
   * GPU vertex format for one element on the translate path: the host's own
   * mapping (table: GpuFormat -> {gpu}), except where that mapping reads past
   * the element. WebGPU has no 3-component 8/16-bit formats, so those keep the
   * 4-wide format when the vertex stride leaves room and are an error otherwise.
   */
  const EXACT3 = { RGB32_FLOAT: ["float32x3", 12], RGB32_UINT: ["uint32x3", 12], RGB32_SINT: ["sint32x3", 12] };
  const WIDE3 = { RGB16_FLOAT: ["float16x4", 8], RGB8_UNORM: ["unorm8x4", 4], RGB8_SNORM: ["snorm8x4", 4],
    RGB8_UINT: ["uint8x4", 4], RGB8_SINT: ["sint8x4", 4], RGB16_UINT: ["uint16x4", 8], RGB16_SINT: ["sint16x4", 8] };
  function vertexFormat(element, stride, table) {
    if (EXACT3[element.format]) return EXACT3[element.format][0];
    if (WIDE3[element.format]) {
      const [gpu, bytes] = WIDE3[element.format];
      if (element.offset + bytes > stride) throw new Error(`vertex element ${element.name} (${element.format}) has no exact WebGPU format`);
      return gpu;
    }
    const info = table[element.format];
    if (!info) throw new Error(`vertex format ${element.format} has no WebGPU mapping`);
    return info.gpu;
  }

  /**
   * The vertex stage's inputs as naga declares them on the WGSL entry point:
   * [{location, name}], only those the preprocessor kept. naga appends "_"
   * to a name that ends in a digit (UV0 -> UV0_), so that is undone here.
   */
  function vertexInputs(wgsl) {
    const entry = /@vertex\s+fn\s+\w+\s*\(/.exec(wgsl);
    if (!entry) return [];
    const { close } = splitArgs(wgsl, entry.index + entry[0].length - 1);
    const params = wgsl.slice(entry.index + entry[0].length, close);
    return [...params.matchAll(/@location\((\d+)\)\s*(\w+)\s*:/g)]
      .map((m) => ({ location: Number(m[1]), name: /\d_$/.test(m[2]) ? m[2].slice(0, -1) : m[2] }));
  }

  /**
   * Vertex buffer layouts, one per bound vertex format (null for an unbound
   * slot): each element the vertex stage consumes is an attribute at the
   * location the shader declares for an input of that name, whichever buffer
   * it lives in (the multidraw terrain pipelines read chunk data from a
   * per-instance buffer). An input no element feeds is an error.
   */
  function vertexBuffers(vertexFormats, table, inputs) {
    const formats = (vertexFormats || []).slice();
    while (formats.length && !formats[formats.length - 1]) formats.pop();
    const fed = new Set();
    const buffers = formats.map((vf) => {
      if (!vf) return null;
      if (vf.stepRate > 1) throw new Error(`vertex step rate ${vf.stepRate} has no WebGPU equivalent`);
      const attributes = [];
      for (const e of vf.elements || []) {
        const input = inputs.find((i) => i.name === e.name);
        if (!input || fed.has(input.name)) continue;
        fed.add(input.name);
        attributes.push({ shaderLocation: input.location, offset: e.offset, format: vertexFormat(e, vf.stride, table) });
      }
      return { arrayStride: vf.stride, stepMode: vf.stepRate === 1 ? "instance" : "vertex", attributes };
    });
    const missing = inputs.find((i) => !fed.has(i.name));
    if (missing) throw new Error(`vertex input ${missing.name} (location ${missing.location}) has no vertex element`);
    return buffers;
  }

  /**
   * The GL Y policy: negate gl_Position.y after the shader's own main, so
   * render targets get GL's memory layout (row 0 = bottom) and the host's
   * scissors, region clears and render-to-texture reads need no flip; the
   * host flips once at the composite. The pipeline then needs frontFace "cw".
   */
  function negateClipY(vs) {
    const re = /\bvoid\s+main\s*\(\s*(?:void)?\s*\)/g;
    const n = (vs.match(re) || []).length;
    if (n !== 1) throw new Error(`expected one main(), found ${n}`);
    return vs.replace(re, "void _mcweb_main()")
      + "\nvoid main() { _mcweb_main(); gl_Position.y = -gl_Position.y; }\n";
  }

  /** A cheap 64-bit text hash (two FNV-1a lanes) plus the length, for module cache keys. */
  function textHash(s) {
    let a = 0x811c9dc5, b = 0x050c5d1f;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
    }
    return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0") + ":" + s.length;
  }

  /**
   * Glue and translate one pipeline for the host. translate(source, stage)
   * returns {status, text} (status 0 = WGSL). opts: {cap, vertexTable}.
   * The vertex stage always gets the GL Y policy (negateClipY).
   * Returns {ok: true, vs, fs, notes, layout, entries, samplerKinds, buffers}
   * or {ok: false, stage, message} where message is the first line only.
   */
  function prepareTranslated(spec, translate, opts) {
    const fail = (stage, message) => ({ ok: false, stage, message: String(message || "").split("\n").find((l) => l.trim()) || "(no message)" });
    let glued;
    try {
      glued = gluePipeline(spec.vertexSource, spec.fragmentSource, spec, opts.cap);
    } catch (e) {
      return fail("glue", e && e.message || e);
    }
    let vsSource;
    try { vsSource = negateClipY(glued.vs); } catch (e) { return fail("vertex", e.message); }
    // A trap in the translator (a naga panic) is a failure like any other.
    const run = (source, stage) => {
      try { return translate(source, stage); } catch (e) { return { status: -1, text: `translator trapped: ${e && e.message || e}` }; }
    };
    const vs = run(vsSource, "vertex");
    if (vs.status !== 0) return fail("vertex", vs.text);
    const fs = run(glued.fs, "fragment");
    if (fs.status !== 0) return fail("fragment", fs.text);
    // GLSL compiles implicit texture sampling in divergent branches, with
    // undefined derivatives. Match that policy for translated fragments while
    // retaining a warning and every other WGSL validation rule.
    const fsText = "diagnostic(warning, derivative_uniformity);\n" + fs.text;
    const declared = new Map([...wgslBindings(vs.text), ...wgslBindings(fsText)]);
    let buffers;
    try {
      buffers = vertexBuffers(spec.vertexFormats, opts.vertexTable || {}, vertexInputs(vs.text));
    } catch (e) {
      return fail("vertex-format", e.message);
    }
    const loadOnly = loadOnlyTextures([vs.text, fsText]);
    const { entries, samplerKinds } = layoutEntries(spec.bindGroups || [], glued.layout, declared, loadOnly);
    return { ok: true, vs: vs.text, fs: fsText, notes: glued.notes, layout: glued.layout, entries, samplerKinds, buffers };
  }

  const api = { computeLayout, glue, gluePipeline, wgslBindings, textureBinding, loadOnlyTextures, layoutEntries,
    vertexFormat, vertexInputs, vertexBuffers, negateClipY, textHash, prepareTranslated };
  root.mcWebShaderGlue = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
