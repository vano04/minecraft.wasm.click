'use strict';
globalThis.mcWebOwnProfile = (() => {
  const path = '/app/mcweb/own-profile.json', limit = 96 * 1024;
  let prepared;
  async function prepare(profile) {
    prepared = null;
    if (!profile) return; // The standalone private test fixture has no account.
    try {
      const response = await fetch('/mcweb/auth/minecraft/profile', {
        credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Signed player profile unavailable'); }
      const reader = response.body.getReader(), parts = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > limit) throw new Error('Player profile exceeds limit');
          parts.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (value.id !== profile.id || value.name !== profile.name || value.properties?.length !== 1) throw new Error('Player profile identity differs');
      const property = value.properties[0];
      if (property.name !== 'textures' || typeof property.value !== 'string' || !property.value || property.value.length > 65536
          || typeof property.signature !== 'string' || !property.signature || property.signature.length > 8192) throw new Error('Signed player textures unavailable');
      prepared = new TextEncoder().encode(JSON.stringify({ id: value.id, name: value.name, properties: [property] }));
    } catch {
      // Appearance failure does not weaken the separate login/entitlement gate.
      console.warn('Signed player profile unavailable; using the default appearance.');
    }
  }
  function attach(module) {
    if (!prepared) return;
    module.FS.mkdirTree('/app/mcweb');
    module.FS.writeFile(path, prepared, { canOwn: true });
    prepared = null;
  }
  return Object.freeze({ prepare, attach });
})();
