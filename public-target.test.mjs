import test from 'node:test';
import assert from 'node:assert/strict';
import { publicTcpTarget } from './public-target.mjs';

test('public target rejects special-purpose and unallocated IPv6', () => {
  for (const hostname of [
    '::1', '::ffff:127.0.0.1', '2000::1', '2001::1', '2001:2::1',
    '[2001:0002:0000:0::1]', '2001:2::ffff:192.0.2.1',
    '2001:10::1', '2001:20::1', '2001:30::1', '2001:1ff::1',
    '2001:db8::1', '2001:0db8:0:0:0:0:0:1',
    '2001:6000::1', '2001:c000::1', '2002::1', '2003:4000::1', '23ff::1',
    '2420::1', '2640::1', '2810::1', '2a20::1', '2c10::1', '2d00::1',
    '3000::1', '3ffe::1', '3fff::1', '3fff:1000::1',
    'fc00::1', 'fe80::1',
  ]) assert.equal(publicTcpTarget(hostname, 25565), null, hostname);
});

test('public target accepts allocated globally reachable IPv6', () => {
  for (const hostname of [
    '2001:1::1', '2001:3::1', '2001:4:112::1', '2001:200::1',
    '2001:3ff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:4860:4860::8888', '2001:bfff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2003::1', '2003:3fff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2400::1', '240f:ffff::1', '2410::1', '241f:ffff::1',
    '2606:4700:4700::1111', '2610::1', '2610:1ff:ffff::1',
    '2620:4f:8000::1', '2620:1ff:ffff::1', '2630::1', '263f:ffff::1',
    '2800::1', '280f:ffff::1', '2a00::1', '2a0f:ffff::1',
    '2a10::1', '2a1f:ffff::1', '2c00::1', '2c0f:ffff::1',
  ]) assert.deepEqual(publicTcpTarget(hostname, 25565), { hostname, port: 25565 }, hostname);
});

test('public target canonicalizes an allocated IPv6 literal before matching', () => {
  assert.deepEqual(publicTcpTarget('[2606:4700:4700:0000:0000:0000:0000:1111]', '25565'),
    { hostname: '2606:4700:4700::1111', port: 25565 });
});
