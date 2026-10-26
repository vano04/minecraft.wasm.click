import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { JsonAccountAuth } from './json-auth.mjs';

const ORIGIN = 'https://launcher.example';
const PROFILE = { id: '0123456789abcdef0123456789abcdef', name: 'FixturePlayer' };
const TOKEN = 'fixture-selected-minecraft-token';
const REFRESH = 'fixture-refresh-token-never-retained';
const REQUESTS = [
  'https://api.minecraftservices.com/entitlements/mcstore',
  'https://api.minecraftservices.com/minecraft/profile',
];
const account = (now, changes = {}) => ({ active: true, type: 'MSA', profile: PROFILE,
  ygg: { token: TOKEN, exp: Math.floor(now / 1000) + 3600 },
  msa: { refresh_token: REFRESH }, entitlement: { ownsMinecraft: true, canPlayMinecraft: true }, ...changes });
const text = value => JSON.stringify({ accounts: [value] });
const request = (id, extra = '') => new Request(ORIGIN, { headers: { cookie: `mcweb_session=${id}${extra}` } });
function setup(t, { now = Date.now, fetchImpl, maxSessions, origin = ORIGIN } = {}) {
  const calls = [];
  const auth = new JsonAccountAuth({ origin, now, maxSessions, fetchImpl: fetchImpl || (async (url, options) => {
    calls.push({ url, options });
    assert.ok(REQUESTS.includes(url));
    return Response.json(url === REQUESTS[0] ? { items: [{ name: 'game_minecraft' }] } : PROFILE);
  }) });
  t.after(() => auth.close());
  return { auth, calls };
}
const rejects = (fn, code, status) => assert.rejects(fn, error => {
  assert.equal(error.code, code);
  if (status) assert.equal(error.status, status);
  assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), /fixture-|Bearer|https?:\/\//);
  return true;
});

test('verifies the selected Prism token at fixed provider endpoints and exposes only public session fields', async t => {
  const now = 1_000_000;
  const { auth, calls } = setup(t, { now: () => now });
  const imported = account(now, { profile: { ...PROFILE, id: '01234567-89AB-CDEF-0123-456789ABCDEF' } });
  const { sessionId, session } = await auth.importAccount(text(imported));
  assert.match(sessionId, /^[a-f0-9]{64}$/);
  assert.deepEqual(session, { authenticated: true, mode: 'online', expiresAt: now + 3600000,
    profile: { ...PROFILE, skinPath: '/mcweb/auth/minecraft/skin' } });
  assert.deepEqual(auth.session(request(sessionId)), session);
  assert.deepEqual(auth.credentials(request(sessionId)), { token: TOKEN, ...PROFILE, expiresAt: now + 3600000 });
  assert.equal(Object.isFrozen(auth.credentials(request(sessionId))), true);
  assert.doesNotMatch(JSON.stringify(session), /token|refresh|msa|ygg|fixture-selected/);
  assert.equal(JSON.stringify(auth), '{}');
  assert.deepEqual(calls.map(value => value.url), REQUESTS);
  for (const { options } of calls) {
    assert.equal(options.headers.authorization, 'Bearer ' + TOKEN);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(JSON.stringify(options).includes(REFRESH), false);
  }
  assert.match(auth.cookie(sessionId), /^mcweb_session=[a-f0-9]{64}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Strict; Secure$/);
});

test('each import creates an independent browser session and logout only revokes that browser', async t => {
  const { auth } = setup(t);
  const first = await auth.importAccount(text(account(Date.now())));
  const second = await auth.importAccount(text(account(Date.now())));
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(auth.session(new Request(ORIGIN)), null);
  assert.equal(auth.session(request('0'.repeat(64))), null);
  const firstSocket = new EventEmitter(), secondSocket = new EventEmitter(), closed = [];
  firstSocket.close = (...args) => closed.push(['first', ...args]);
  secondSocket.close = (...args) => closed.push(['second', ...args]);
  assert.equal(auth.trackSocket(request(first.sessionId), firstSocket), true);
  assert.equal(auth.trackSocket(request(second.sessionId), secondSocket), true);
  auth.revoke(first.sessionId);
  assert.equal(auth.credentials(request(first.sessionId)), null);
  assert.ok(auth.credentials(request(second.sessionId)));
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0], ['first', 4401, 'Signed out or session expired; import your account again.']);
  first.session.profile.name = 'Changed';
  assert.equal(auth.session(request(second.sessionId)).profile.name, PROFILE.name);
});

test('rejects duplicate, malformed and encoded session cookies on Node and Fetch requests', async t => {
  const { auth } = setup(t);
  const { sessionId } = await auth.importAccount(text(account(Date.now())));
  assert.equal(auth.sessionId({ headers: { cookie: `other=1; mcweb_session=${sessionId}; other2=2` } }), sessionId);
  for (const cookie of [`mcweb_session=${sessionId}; mcweb_session=${sessionId}`,
    `mcweb_session=invalid; mcweb_session=${sessionId}`, `mcweb_session=${sessionId}%20`,
    `mcweb_session=${sessionId.toUpperCase()}`, 'mcweb_session=invalid']) {
    assert.equal(auth.sessionId({ headers: { cookie } }), null);
    assert.equal(auth.session(new Request(ORIGIN, { headers: { cookie } })), null);
  }
  assert.equal(auth.sessionId({ headers: { cookie: [`mcweb_session=${sessionId}`, `mcweb_session=${sessionId}`] } }), null);
});

test('different imported accounts keep their own token and profile behind each browser cookie', async t => {
  const other = { id: 'f'.repeat(32), name: 'OtherPlayer' };
  const otherToken = 'fixture-other-minecraft-token';
  const { auth } = setup(t, { fetchImpl: async (url, options) => Response.json(url === REQUESTS[0]
    ? { items: [{ name: 'game_minecraft' }] }
    : options.headers.authorization === 'Bearer ' + TOKEN ? PROFILE : other) });
  const first = await auth.importAccount(text(account(Date.now())));
  const second = await auth.importAccount(text(account(Date.now(), {
    profile: other, ygg: { token: otherToken, exp: Math.floor(Date.now() / 1000) + 3600 },
  })));
  assert.deepEqual(auth.session(request(first.sessionId)).profile, { ...PROFILE, skinPath: '/mcweb/auth/minecraft/skin' });
  assert.deepEqual(auth.session(request(second.sessionId)).profile, { ...other, skinPath: '/mcweb/auth/minecraft/skin' });
  assert.equal(auth.credentials(request(first.sessionId)).token, TOKEN);
  assert.equal(auth.credentials(request(second.sessionId)).token, otherToken);
});

test('caps expiry at four hours and honors an earlier JWT expiry without treating its payload as verification', async t => {
  const now = 1_000_000;
  const { auth, calls } = setup(t, { now: () => now });
  const long = await auth.importAccount(text(account(now, { ygg: { token: TOKEN, exp: (now + 24 * 3600000) / 1000 } })));
  assert.equal(long.session.expiresAt, now + 4 * 3600000);
  const token = 'fixture.' + Buffer.from(JSON.stringify({ exp: (now + 60000) / 1000 })).toString('base64url') + '.fixture';
  const short = await auth.importAccount(text(account(now, { ygg: { token, exp: (now + 3600000) / 1000 } })));
  assert.equal(short.session.expiresAt, now + 60000);
  assert.equal(calls.length, 4, 'A token payload never replaces live upstream verification');
  const expired = 'fixture.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.fixture';
  await rejects(() => auth.importAccount(text(account(now, { ygg: { token: expired, exp: (now + 3600000) / 1000 } }))), 'expired-token', 400);
});

test('expiry timers close associated sockets and remove credentials without another HTTP request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000;
  const { auth } = setup(t, { now: () => now });
  const { sessionId } = await auth.importAccount(text(account(now, { ygg: { token: TOKEN, exp: 2 } })));
  const socket = new EventEmitter(), closed = [];
  socket.close = (...args) => closed.push(args);
  auth.trackSocket(request(sessionId), socket);
  now = 2001;
  t.mock.timers.tick(1001);
  assert.deepEqual(closed, [[4401, 'Signed out or session expired; import your account again.']]);
  assert.equal(auth.session(request(sessionId)), null);
});

test('rejects invalid, expired and forbidden account files before contacting the provider', async t => {
  const now = 1000000;
  const { auth, calls } = setup(t, { now: () => now });
  for (const [value, code] of [
    ['bad JSON', 'invalid-json'], ['[]', 'invalid-shape'],
    [text(account(now, { type: 'Offline' })), 'unsupported-schema'],
    [text(account(now, { password: 'fixture-password' })), 'forbidden-credential'],
    [text(account(now, { ygg: { token: TOKEN, exp: 1 } })), 'expired-token'],
    [text(account(now, { entitlement: { ownsMinecraft: false, canPlayMinecraft: true } })), 'missing-entitlement'],
    [text(account(now, { ygg: { token: TOKEN + '\nfixture-header', exp: 2000 } })), 'invalid-account'],
    ['x'.repeat(1024 * 1024 + 1), 'too-large'],
  ]) await rejects(() => auth.importAccount(value), code, 400);
  assert.equal(calls.length, 0);
});

test('does not authorize forged ownership flags or a different upstream profile', async t => {
  const now = Date.now();
  const variants = [
    [{ items: [] }, PROFILE, 'missing-entitlement'],
    [{ items: [{ name: 'unrelated_product' }] }, PROFILE, 'missing-entitlement'],
    [{ items: [{ name: 'product_minecraft' }] }, { ...PROFILE, name: 'Different' }, 'profile-mismatch'],
    [{ items: [{ name: 'product_minecraft' }] }, { ...PROFILE, id: 'f'.repeat(32) }, 'profile-mismatch'],
  ];
  for (const [entitlement, profile, code] of variants) {
    const { auth } = setup(t, { fetchImpl: async url => Response.json(url === REQUESTS[0] ? entitlement : profile) });
    await rejects(() => auth.importAccount(text(account(now))), code, 401);
    assert.equal(auth.session(new Request(ORIGIN)), null);
  }
});

test('upstream failures, redirects, oversized bodies and invalid JSON reveal no upstream content', async t => {
  const now = Date.now();
  const providers = [
    async () => { throw new Error('fixture-secret-network-error'); },
    async () => new Response('fixture-secret-upstream-body', { status: 302, headers: { location: 'https://untrusted.example' } }),
    async () => new Response('fixture-secret-upstream-body', { status: 500 }),
    async () => new Response('fixture-secret-invalid-json'),
    async () => new Response('fixture-secret', { headers: { 'content-length': '65537' } }),
    async () => new Response('x'.repeat(65537)),
  ];
  for (const fetchImpl of providers) {
    const { auth } = setup(t, { fetchImpl });
    await rejects(() => auth.importAccount(text(account(now))), 'account-verification-unavailable', 503);
  }
  for (const status of [401, 403, 404]) {
    const { auth } = setup(t, { fetchImpl: async () => new Response('fixture-secret', { status }) });
    await rejects(() => auth.importAccount(text(account(now))), 'account-rejected', 401);
  }
});

test('capacity includes in-flight imports and is released after failed verification', async t => {
  let complete;
  const started = new Promise(resolve => { complete = resolve; });
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const { auth } = setup(t, { maxSessions: 1, fetchImpl: async () => { complete(); await blocked; return Response.json({ items: [] }); } });
  const importing = auth.importAccount(text(account(Date.now())));
  await started;
  await rejects(() => auth.importAccount(text(account(Date.now()))), 'session-limit', 429);
  unblock();
  await rejects(() => importing, 'missing-entitlement', 401);
  await rejects(() => auth.importAccount(text(account(Date.now()))), 'missing-entitlement', 401);
});

test('provider reads stop at their timeout and expose only a fixed failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started, signal;
  const ready = new Promise(resolve => { started = resolve; });
  const { auth } = setup(t, { fetchImpl: async (_url, options) => {
    signal = options.signal;
    const body = new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new Error('fixture-secret-slow-provider')), { once: true });
    } });
    started();
    return new Response(body);
  } });
  const pending = auth.importAccount(text(account(Date.now())));
  await ready;
  t.mock.timers.tick(10001);
  assert.equal(signal.aborted, true);
  await rejects(() => pending, 'account-verification-unavailable', 503);
});

test('an active session occupies capacity until revoked', async t => {
  const { auth } = setup(t, { maxSessions: 1 });
  const first = await auth.importAccount(text(account(Date.now())));
  await rejects(() => auth.importAccount(text(account(Date.now()))), 'session-limit', 429);
  auth.revoke(first.sessionId);
  const second = await auth.importAccount(text(account(Date.now())));
  assert.ok(auth.session(request(second.sessionId)));
});

test('uses secure cookies only on HTTPS and clears matching cookie attributes', async t => {
  for (const origin of [ORIGIN, 'http://localhost:8080']) {
    const { auth } = setup(t, { origin });
    const { sessionId } = await auth.importAccount(text(account(Date.now())));
    assert.equal(auth.cookie(sessionId).includes('; Secure'), origin.startsWith('https:'));
    assert.equal(auth.clearCookie(), 'mcweb_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' + (origin.startsWith('https:') ? '; Secure' : ''));
    assert.throws(() => auth.cookie('invalid'), /Invalid session identifier/);
  }
});

test('stores only permitted texture URLs and closes all sessions on shutdown', async t => {
  const url = 'http://textures.minecraft.net/texture/' + 'a'.repeat(64);
  const { auth } = setup(t, { fetchImpl: async location => Response.json(location === REQUESTS[0]
    ? { items: [{ name: 'game_minecraft' }] } : { ...PROFILE, skins: [{ state: 'ACTIVE', url }] }) });
  const { sessionId } = await auth.importAccount(text(account(Date.now())));
  assert.equal(auth.credentials(request(sessionId)).skinUrl, url.replace('http:', 'https:'));
  const socket = new EventEmitter(), closed = [];
  socket.close = (...args) => closed.push(args);
  auth.trackSocket(request(sessionId), socket);
  socket.emit('close');
  auth.close();
  assert.deepEqual(closed, [], 'Already closed sockets are removed from the session');
  assert.equal(auth.session(request(sessionId)), null);
  const invalid = new EventEmitter(); invalid.close = (...args) => closed.push(args);
  assert.equal(auth.trackSocket(request(sessionId), invalid), false);
  assert.deepEqual(closed, [[4401, 'Account import required.']]);
  await rejects(() => auth.importAccount(text(account(Date.now()))), 'authentication-unavailable', 503);
  const unsafe = setup(t, { fetchImpl: async location => Response.json(location === REQUESTS[0]
    ? { items: [{ name: 'game_minecraft' }] } : { ...PROFILE, skins: [{ url: 'https://untrusted.example/fixture-secret' }] }) }).auth;
  const imported = await unsafe.importAccount(text(account(Date.now())));
  assert.equal(unsafe.credentials(request(imported.sessionId)).skinUrl, undefined);
});

test('shutdown during verification cannot create a late session', async t => {
  let release, called, signal;
  const started = new Promise(resolve => { called = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const { auth } = setup(t, { fetchImpl: async (url, options) => {
    signal = options.signal;
    called(); await blocked;
    return Response.json(url === REQUESTS[0] ? { items: [{ name: 'game_minecraft' }] } : PROFILE);
  } });
  const pending = auth.importAccount(text(account(Date.now())));
  await started;
  auth.close();
  assert.equal(signal.aborted, true);
  release();
  await rejects(() => pending, 'authentication-unavailable', 503);
});
