// Keep buffers available until queued render-pass commands have consumed their handles.
export function createBufferPassLifetime({objects, markUse, deferDestroy, evict}) {
  const passes = new Set();
  const retired = new Map();
  return {
    begin(pass) { passes.add(pass); },
    destroy(handle) {
      const entry = objects.get(handle);
      if (!entry || entry.kind !== 'buffer' || retired.has(handle)) throw Error('Unknown buffer handle ' + handle);
      evict(entry.buffer);
      if (passes.size) {
        const waiting = new Set(passes);
        for (const pass of waiting) markUse(pass._encoderEntry, entry.buffer);
        retired.set(handle, {entry, waiting});
      } else objects.delete(handle);
      deferDestroy(entry.buffer);
    },
    end(pass) {
      if (!passes.delete(pass)) return;
      for (const [handle, row] of retired) {
        row.waiting.delete(pass);
        if (!row.waiting.size) {
          if (objects.get(handle) === row.entry) objects.delete(handle);
          retired.delete(handle);
        }
      }
    },
  };
}
export function queuedBufferHost(source) {
  const api = '  globalThis.mcWebGpu = {';
  const put = '    objects.set(handle, object);';
  const destroy = '      const entry = get(handle, "buffer");\n      evictResourceBindGroups(entry.buffer);\n      if (entry?.buffer) deferDestroyBuffer(entry.buffer);\n      objects.delete(handle);';
  const drop = 'objects.delete(passHandle);';
  for (const marker of [api, put, destroy]) if (source.split(marker).length !== 2) throw Error('Unexpected GPU buffer lifetime wiring');
  if (source.split(drop).length !== 3) throw Error('Unexpected render pass cleanup');
  return source.replace(api, '  const _bufferPassLifetime = ('+createBufferPassLifetime.toString()+')({objects, markUse: _markResourceUse, deferDestroy: deferDestroyBuffer, evict: evictResourceBindGroups});\n'+api)
    .replace(put, put+'\n    if (object.kind === "renderPass") _bufferPassLifetime.begin(object);')
    .replace(destroy, '      _bufferPassLifetime.destroy(handle);')
    .replaceAll(drop, '_bufferPassLifetime.end(objects.get(passHandle)); '+drop);
}

export function keyboardGameControls(source) {
  const position = 'root.style.top = (rect.top - hostBox.top - container.clientTop) + "px";';
  const fullscreen = 'rootBox.top = hostBox.top + container.clientTop;';
  const shift = 'container.classList.toggle("mcweb-gc-kb-shifted", px !== 0);';
  for (const marker of [position, fullscreen, shift]) {
    if (source.split(marker).length !== 2) throw new Error('Unexpected touch keyboard geometry');
  }
  return source.replace(position,
    '// The canvas rectangle already includes the keyboard translation.\n        root.style.top = (rect.top + textState.shift - hostBox.top - container.clientTop) + "px";')
    .replace(fullscreen, 'rootBox.top = hostBox.top + container.clientTop - textState.shift;')
    .replace(shift, shift + '\n      layout();');
}
