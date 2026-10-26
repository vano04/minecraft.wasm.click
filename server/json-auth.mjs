import { randomBytes } from 'node:crypto';
import { createLauncherAccountParser } from './account-json.mjs';

const COOKIE = 'mcweb_session';
const MAX_SESSION_MS = 4 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 64 * 1024;
const ENTITLEMENTS = 'https://api.minecraftservices.com/entitlements/mcstore';
const PROFILE = 'https://api.minecraftservices.com/minecraft/profile';

export class JsonAuthError extends Error {
  constructor(code, status = 401) {
    super(code === 'session-limit'
    ? 'Too many active sessions. Try again later.'
    : 'Could not verify this Minecraft account. Refresh it in your launcher and import it again.');
    this.code = code;
    this.status = status;
  }
}
const failure = (code, status = 401) => new JsonAuthError(code, status);

async function readJson(response) {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_JSON_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw failure('account-verification-unavailable', 503);
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) throw failure('account-verification-unavailable', 503);
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function skinUrl(profile) {
  const skins = Array.isArray(profile.skins) ? profile.skins : [];
  const skin = skins.find(value => value?.state === 'ACTIVE') || skins[0];
  try {
    const url = new URL(skin?.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'textures.minecraft.net'
        || url.port || url.username || url.password || url.search || url.hash
        || !/^\/texture\/[a-f0-9]{64}$/i.test(url.pathname)) return null;
    url.protocol = 'https:';
    return url.href;
  } catch { return null; }
}

function tokenExpiry(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return Infinity;
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number.isSafeInteger(value.exp) && Number.isSafeInteger(value.exp * 1000)
      ? value.exp * 1000 : Infinity;
  } catch { return Infinity; }
}

export class JsonAccountAuth {
  #fetch;
  #now;
  #secure;
  #maxSessions;
  #sessions = new Map();
  #requests = new Set();
  #pending = 0;
  #closed = false;

  constructor({ origin, fetchImpl = fetch, now = Date.now, maxSessions = 256 }) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) throw new TypeError('Invalid authentication origin');
    if (typeof fetchImpl !== 'function' || typeof now !== 'function'
        || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 4096) {
      throw new TypeError('Invalid authentication configuration');
    }
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#secure = url.protocol === 'https:';
    this.#maxSessions = maxSessions;
  }

  async #provider(url, token) {
    if (this.#closed) throw failure('authentication-unavailable', 503);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    timeout.unref?.();
    this.#requests.add(controller);
    let response;
    try {
      response = await this.#fetch(url, { headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
        redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw failure([401, 403, 404].includes(response.status)
          ? 'account-rejected' : 'account-verification-unavailable', [401, 403, 404].includes(response.status) ? 401 : 503);
      }
      return await readJson(response);
    } catch (error) {
      if (this.#closed) throw failure('authentication-unavailable', 503);
      if (error?.code === 'account-rejected') throw failure('account-rejected');
      throw failure('account-verification-unavailable', 503);
    } finally {
      clearTimeout(timeout);
      this.#requests.delete(controller);
    }
  }

  #public(credential) {
    return { authenticated: true, mode: 'online', expiresAt: credential.expiresAt,
      profile: { id: credential.id, name: credential.name, skinPath: '/mcweb/auth/minecraft/skin' } };
  }

  #prune() {
    for (const [id, value] of this.#sessions) {
      if (value.credential.expiresAt <= this.#now()) this.revoke(id);
    }
  }

  async importAccount(text) {
    if (this.#closed) throw failure('authentication-unavailable', 503);
    this.#prune();
    if (this.#sessions.size + this.#pending >= this.#maxSessions) throw failure('session-limit', 429);
    const parser = createLauncherAccountParser({ now: this.#now });
    let imported;
    try {
      const result = parser.parse(text);
      if (!result.ok) throw failure(result.code, 400);
      imported = parser.takeCredential();
    } finally { parser.clear(); text = null; }
    if (!imported || imported.accessToken.length > 16384 || /[\s\x00-\x1f\x7f]/.test(imported.accessToken)) {
      throw failure('invalid-account', 400);
    }
    const token = imported.accessToken;
    const expiresAt = Math.min(imported.expiresAt, tokenExpiry(token), this.#now() + MAX_SESSION_MS);
    if (expiresAt <= this.#now()) throw failure('expired-token', 400);
    this.#pending++;
    try {
      const entitlement = await this.#provider(ENTITLEMENTS, token);
      if (this.#closed) throw failure('authentication-unavailable', 503);
      if (!Array.isArray(entitlement?.items)
          || !entitlement.items.some(item => ['game_minecraft', 'product_minecraft'].includes(item?.name))) {
        throw failure('missing-entitlement');
      }
      const profile = await this.#provider(PROFILE, token);
      const id = typeof profile?.id === 'string' ? profile.id.replaceAll('-', '').toLowerCase() : '';
      const expectedId = imported.profileId.replaceAll('-', '').toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(id) || !/^[A-Za-z0-9_]{1,16}$/.test(profile?.name || '')
          || id !== expectedId || profile.name !== imported.profileName) throw failure('profile-mismatch');
      if (expiresAt <= this.#now()) throw failure('expired-token');
      if (this.#closed) throw failure('authentication-unavailable', 503);
      const skin = skinUrl(profile);
      const credential = Object.freeze({ token, id, name: profile.name, expiresAt, ...(skin ? { skinUrl: skin } : {}) });
      const sessionId = randomBytes(32).toString('hex');
      const timer = setTimeout(() => this.revoke(sessionId), Math.max(1, expiresAt - this.#now()));
      timer.unref?.();
      this.#sessions.set(sessionId, { credential, timer, sockets: new Set() });
      return { sessionId, session: this.#public(credential) };
    } finally { this.#pending--; }
  }

  sessionId(request) {
    const headers = request?.headers;
    const value = typeof headers?.get === 'function' ? headers.get('cookie') : headers?.cookie;
    if (typeof value !== 'string') return null;
    const matches = value.split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
    if (matches.length !== 1) return null;
    const id = matches[0].slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(id) ? id : null;
  }

  credentials(request) {
    this.#prune();
    return this.#sessions.get(this.sessionId(request))?.credential || null;
  }

  session(request) {
    const credential = this.credentials(request);
    return credential ? this.#public(credential) : null;
  }

  cookie(sessionId) {
    if (!/^[a-f0-9]{64}$/.test(sessionId)) throw new TypeError('Invalid session identifier');
    const credential = this.#sessions.get(sessionId)?.credential;
    if (!credential || credential.expiresAt <= this.#now()) throw failure('session-unavailable');
    const maxAge = Math.max(1, Math.floor((credential.expiresAt - this.#now()) / 1000));
    return `${COOKIE}=${sessionId}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${this.#secure ? '; Secure' : ''}`;
  }

  clearCookie() {
    return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${this.#secure ? '; Secure' : ''}`;
  }

  revoke(sessionId) {
    const value = this.#sessions.get(sessionId);
    if (!value) return;
    this.#sessions.delete(sessionId);
    clearTimeout(value.timer);
    for (const ws of value.sockets) {
      try { ws.close(4401, 'Signed out or session expired; import your account again.'); } catch {}
    }
    value.sockets.clear();
  }

  trackSocket(request, ws) {
    this.#prune();
    const value = this.#sessions.get(this.sessionId(request));
    if (!value) {
      try { ws.close(4401, 'Account import required.'); } catch {}
      return false;
    }
    value.sockets.add(ws);
    const remove = () => value.sockets.delete(ws);
    if (typeof ws.once === 'function') ws.once('close', remove);
    else ws.addEventListener?.('close', remove, { once: true });
    return true;
  }

  close() {
    this.#closed = true;
    for (const request of this.#requests) request.abort();
    this.#requests.clear();
    for (const id of this.#sessions.keys()) this.revoke(id);
  }
}
