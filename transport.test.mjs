import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createRelay, publicDial } from './server.mjs';
const token = 'test-relay-token-'.repeat(4), origin = 'https://minecraft.wasm.click';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('self-hosted relay rejects reserved IPv6 before dialing', async () => {
  let dialed = false;
  const relay = createRelay({ token, dial: async () => { dialed = true; throw Error('must not dial'); } });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const url = 'ws://127.0.0.1:' + relay.address().port + '/tcp/?host=3000%3A%3A1&port=25565&token=' + token;
  try {
    const ws = new WebSocket(url, { origin }); ws.on('error', () => {});
    const [, response] = await once(ws, 'unexpected-response');
    assert.equal(response.statusCode, 403); response.resume(); ws.terminate();
    assert.equal(dialed, false);
  } finally { relay.close(); }
});
test('self-hosted relay forwards exact bytes, requires its owner token, bounds receive credit and rejects target changes', {timeout:15000}, async () => {
  const inbound = randomBytes(1536*1024), outbound = randomBytes(128*1024), got = [], connections = [];
  const tcp = createServer(socket => { connections.push(socket); socket.write(inbound); socket.on('data', bytes => got.push(bytes)); });
  tcp.listen(0,'127.0.0.1'); await once(tcp,'listening');
  const relay = createRelay({token, dial: async target => {
    assert.deepEqual(target,{hostname:'mc.example.com',port:25565});
    const socket=connect(tcp.address().port,'127.0.0.1');
    return { opened:once(socket,'connect'), closed:once(socket,'close'), readable:Readable.toWeb(socket), writable:Writable.toWeb(socket), close:async()=>socket.destroy() };
  }}); relay.listen(0,'127.0.0.1'); await once(relay,'listening');
  const base='ws://127.0.0.1:'+relay.address().port+'/tcp/?host=mc.example.com&port=25565'; let ws;
  try {
    for(const [key,headers] of [['bad',{origin}], [token,{origin:'https://evil.example'}]]) {
      const bad=new WebSocket(base+'&token='+key,headers); bad.on('error',()=>{}); const rejected=once(bad,'unexpected-response');
      const [,response]=await rejected; assert.equal(response.statusCode,403); response.resume(); bad.terminate();
    }
    ws=new WebSocket(base+'&token='+token,{origin}); ws.on('error',()=>{});
    const chunks=[]; let size=0, held=0, released=false, done;
    const received=new Promise(resolve=>done=resolve);
    ws.on('message',(raw,binary)=>{if(!binary)return;chunks.push(raw);size+=raw.length;
      if(released)ws.send(JSON.stringify({received:raw.length}));else held+=raw.length;
      if(size===inbound.length)done();});
    await once(ws,'open'); const target=JSON.stringify({connect:{host:'mc.example.com',port:25565}});ws.send(target);
    await new Promise(resolve=>setTimeout(resolve,200));assert.ok(size>0&&size<=1024*1024+65536&&size<inbound.length);
    released=true;ws.send(JSON.stringify({received:held}));
    for(let at=0;at<outbound.length;at+=32768)ws.send(outbound.subarray(at,at+32768));
    await received;assert.equal(hash(Buffer.concat(chunks)),hash(inbound));
    const until=Date.now()+3000;while(Buffer.concat(got).length<outbound.length&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(hash(Buffer.concat(got)),hash(outbound));
    const closed=once(ws,'close');ws.send(target);assert.equal((await closed)[0],1008);
    await assert.rejects(publicDial({hostname:'localhost',port:25565}),/Private addresses/);
  } finally {ws?.terminate();for(const socket of connections)socket.destroy();relay.close();tcp.close();}
});

test('byte credits sustain a transfer larger than the queue through a slow TCP writer', {timeout:10000}, async () => {
  const expected = Buffer.alloc(4 * 1024 * 1024, 0x6d);
  let written = 0; const digest = createHash('sha256');
  const relay = createRelay({ token, dial: async () => ({
    opened: Promise.resolve(), closed: new Promise(() => {}), readable: new ReadableStream(),
    writable: new WritableStream({ async write(bytes) {
      await new Promise(resolve => setTimeout(resolve, 2)); written += bytes.length; digest.update(bytes);
    } }), close: async () => {},
  }) });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const ws = new WebSocket('ws://127.0.0.1:' + relay.address().port + '/tcp/?host=mc.example.com&port=25565&token=' + token, {origin});
  let sent = 0, available = 0, connected = false, finished = false;
  try {
    await new Promise((resolve, reject) => {
      const pump = () => {
        while (connected && available && sent < expected.length) {
          const count = Math.min(32768, available, expected.length - sent);
          ws.send(expected.subarray(sent, sent + count)); sent += count; available -= count;
        }
      };
      ws.on('error', reject);
      ws.on('close', (code, reason) => { if (!finished) reject(Error('Unexpected relay disconnect: ' + code + ' ' + reason)); });
      ws.on('message', (raw, binary) => {
        try {
          assert.equal(binary, false); const value = JSON.parse(raw);
          if (value.relay) {
            available = value.relay.windowBytes;
            ws.send(JSON.stringify({connect:{host:'mc.example.com',port:25565}}));
          } else if (value.connected) { connected = true; pump(); }
          else if (value.written) {
            available += value.written; pump();
            if (sent === expected.length && available === 1048576) { finished = true; resolve(); }
          }
        } catch (error) { reject(error); }
      });
    });
    assert.equal(written, expected.length); assert.equal(digest.digest('hex'), hash(expected));
  } finally { ws.terminate(); relay.close(); }
});
