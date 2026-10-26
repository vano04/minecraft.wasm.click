import test from 'node:test';
import assert from 'node:assert/strict';
import { publicTcpTarget } from './public-target.mjs';

test('self-hosted relay rejects special-use IPv6 targets', () => {
  for (const host of ['::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '100::1',
    '2001::1', '2001:2::1', '[2001:0002:0000:0::1]', '2001:10::1', '2001:20::1',
    '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:db8::1',
    '2002:7f00:1::', '2d00::1', '2e00::1', '3000::1', '3ffe::1',
    '3fff::1', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '3fff:1000::1',
    'fc00::1', 'fe80::1', 'ff02::1']) {
    assert.equal(publicTcpTarget(host, 25565), null, host);
  }
  for (const host of ['2001:200::1', '2001:4860:4860::8888', '2003::1', '2400::1', '2410::1',
    '2606:4700:4700::1111', '2610::1', '2620::1', '2630::1', '2800::1', '2a00::1',
    '2a10::1', '2c00::1']) {
    assert.deepEqual(publicTcpTarget(host, 25565), { hostname: host, port: 25565 });
  }
});

test('the shared gateway boundary rejects private IPv4 destinations and invalid ports', () => {
  for (const host of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','0.0.0.0']) {
    assert.equal(publicTcpTarget(host,25565),null,host);
  }
  for (const port of [0,-1,65536,1.5]) assert.equal(publicTcpTarget('example.com',port),null);
  assert.deepEqual(publicTcpTarget('example.com',25565),{hostname:'example.com',port:25565});
});
