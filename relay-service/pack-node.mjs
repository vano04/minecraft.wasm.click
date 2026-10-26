import { request } from 'node:https';
import { ADDRCONFIG } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { publicTcpTarget } from './public-target.mjs';

export function nodePackFetch(url, options) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: 'GET', headers: { ...options.headers, 'accept-encoding': 'identity' }, signal: options.signal,
      lookup(host, settings, callback) {
        lookup(host, { all: true, verbatim: true, hints: ADDRCONFIG }).then(addresses => {
          if (!addresses.length || addresses.some(value => !publicTcpTarget(value.address, 443))) throw Error('Private resource-pack addresses are forbidden');
          // Pin the DNS answer used for this TLS connection.
          if (settings.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }).catch(callback);
      } }, incoming => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      let body = incoming;
      if ([204, 205, 304].includes(incoming.statusCode)) {
        incoming.resume();
        resolve(new Response(null, { status: incoming.statusCode, headers }));
        return;
      }
      const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[headers.get('content-encoding')];
      if (decoder) {
        body = incoming.pipe(decoder());
        headers.delete('content-length'); headers.delete('content-encoding');
      }
      try { resolve(new Response(Readable.toWeb(body, { strategy: {
        highWaterMark: 65536, size: chunk => chunk.byteLength,
      } }), { status: incoming.statusCode, headers })); }
      catch (error) { incoming.destroy(); reject(error); }
    });
    outgoing.setTimeout(15000, () => outgoing.destroy(Error('Resource-pack host timed out')));
    outgoing.on('error', reject);
    outgoing.end();
  });
}
