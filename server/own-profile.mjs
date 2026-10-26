const LIMIT = 96 * 1024;

class OwnProfileError extends Error {
  constructor(code, message, upstreamStatus) {
    super(message);
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}
const fail = (code, message, status) => { throw new OwnProfileError(code, message, status); };
// Only fixed application codes/statuses are exposed; upstream bodies, URLs,
// profile identifiers, properties and native exception messages stay private.
export function ownProfileDiagnostic(error) {
  if (!(error instanceof OwnProfileError)) return { code: 'profile-unavailable' };
  return { code: error.code, ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}) };
}
function parseJson(bytes, code) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(code, 'Invalid profile JSON'); }
}

// Only the authenticated player's public signed texture property leaves this
// endpoint. The requested UUID is derived from the server session, never a URL.
export async function ownProfile(credential, verifier, fetchImpl = fetch) {
  const { id, name } = credential;
  if (!/^[a-f0-9]{32}$/.test(id) || !/^[A-Za-z0-9_]{1,16}$/.test(name)) fail('profile-session-invalid', 'Invalid session profile');
  let response;
  try {
    response = await fetchImpl('https://sessionserver.mojang.com/session/minecraft/profile/' + id + '?unsigned=false', {
      headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10000),
    });
  } catch { fail('profile-upstream-network', 'Profile unavailable'); }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    fail('profile-upstream-http', 'Profile unavailable', response.status);
  }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) fail('profile-response-limit', 'Profile exceeds limit');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OwnProfileError) throw error;
    fail('profile-upstream-read', 'Profile unavailable');
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const profile = parseJson(bytes, 'profile-response-invalid');
  if (profile?.id !== id || profile?.name !== name || !Array.isArray(profile?.properties)) fail('profile-identity-mismatch', 'Profile identity differs');
  const textures = profile.properties.filter(property => property?.name === 'textures');
  if (textures.length !== 1) fail('profile-textures-missing', 'Signed textures unavailable');
  const { value, signature } = textures[0];
  if (typeof value !== 'string' || !value || value.length > 65536
      || typeof signature !== 'string' || !signature || signature.length > 8192) fail('profile-textures-invalid', 'Invalid signed textures');
  // The verifier otherwise deliberately collapses key-fetch failure into false.
  // Resolve its keys first so the authenticated endpoint can diagnose that step.
  if (typeof verifier.getKeys === 'function') {
    try { await verifier.getKeys(); }
    catch { fail('profile-verification-keys', 'Profile verification unavailable'); }
  }
  let verified;
  try { verified = await verifier.verify(value, signature); }
  catch { fail('profile-verification-unavailable', 'Profile verification unavailable'); }
  if (!verified) fail('profile-signature-invalid', 'Invalid signed textures');
  const payload = parseJson(Buffer.from(value, 'base64'), 'profile-textures-json-invalid');
  if (payload?.profileId !== id || payload?.profileName !== name) fail('profile-texture-identity-mismatch', 'Signed texture identity differs');
  return { id, name, properties: [{ name: 'textures', value, signature }] };
}
