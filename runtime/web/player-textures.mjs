// GPU-worker fetch adapter for the portable JVM. Authlib still parses profiles
// and validates texture domains; the existing authenticated verifier owns RSA.
const VERIFIER_HOST = 'mcweb-profile-verifier.invalid';
const MAX_TEXTURE_BYTES = 4 * 1024 * 1024;
function bytesResponse(bytes, status = 200) {
  const length = bytes.length;
  return new Response(new ReadableStream({ type: 'bytes', start(controller) { controller.enqueue(bytes); controller.close(); } }), {
    status, headers: { 'content-type': 'application/octet-stream', 'content-length': String(length), 'content-encoding': 'identity' },
  });
}
export function createPlayerTextureFetch({ fetchImpl = globalThis.fetch.bind(globalThis), origin = globalThis.location?.origin } = {}) {
  const endpoint = new URL('/mcweb/verify-profile-property', origin);
  if (!/^https?:$/.test(endpoint.protocol)) throw new Error('Profile verifier requires the launcher origin');
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === VERIFIER_HOST) {
      const keys = [...url.searchParams.keys()];
      const value = url.searchParams.get('value'), signature = url.searchParams.get('signature');
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.pathname !== '/verify'
          || keys.length !== 2 || !keys.includes('value') || !keys.includes('signature')
          || !value || !signature || value.length > 65536 || signature.length > 8192) throw new Error('Invalid profile verification operation');
      const response = await fetchImpl(endpoint.href, {
        method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, signature }), signal: options.signal,
      });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return bytesResponse(Uint8Array.of(0)); }
      // Bound even a broken gateway's JSON reply before parsing it.
      const reader = response.body?.getReader();
      if (!reader) return bytesResponse(Uint8Array.of(0));
      let text = '', count = 0;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          count += chunk.byteLength;
          if (count > 1024) throw new Error('Profile verification response is too large');
          text += decoder.decode(chunk, { stream: true });
        }
        text += decoder.decode();
        return bytesResponse(Uint8Array.of(JSON.parse(text)?.valid === true ? 1 : 0));
      } finally { await reader.cancel().catch(() => {}); }
    }
    if (url.hostname !== 'textures.minecraft.net') return fetchImpl(input, options);
    if (!/^https?:$/.test(url.protocol) || url.port || url.username || url.password || url.search || url.hash
        || !/^\/texture\/[0-9a-f]{32,64}$/i.test(url.pathname)) throw new Error('Invalid Minecraft player texture URL');
    url.protocol = 'https:';
    const response = await fetchImpl(url.href, { ...options, credentials: 'omit', mode: 'cors', redirect: 'error' });
    if (!response.ok || !response.body) return response;
    if (Number(response.headers.get('content-length')) > MAX_TEXTURE_BYTES) {
      await response.body.cancel().catch(() => {}); throw new Error('Player texture exceeds 4 MiB');
    }
    const reader = response.body.getReader();
    let count = 0;
    const body = new ReadableStream({
      type: 'bytes',
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            const pending = controller.byobRequest;
            controller.close();
            pending?.respond(0);
            return;
          }
          count += part.value.byteLength;
          if (count > MAX_TEXTURE_BYTES) throw new Error('Player texture exceeds 4 MiB');
          controller.enqueue(part.value);
        } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    const headers = new Headers(response.headers);
    headers.delete('content-length'); headers.set('content-encoding', 'identity');
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  };
}
