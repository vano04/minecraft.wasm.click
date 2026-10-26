import { createHash, timingSafeEqual } from 'node:crypto';
export function allowed(request, token, origins = 'https://minecraft.wasm.click') {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) return false;
  const url = new URL(request.url);
  const supplied = url.searchParams.get('token') || '';
  return supplied.length <= 256 && timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(token).digest())
    && origins.split(',').map(value => value.trim()).includes(request.headers.get('Origin'));
}
