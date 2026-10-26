import { connect as tcpConnect } from 'node:net';
import { ADDRCONFIG } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { Readable, Writable } from 'node:stream';
import { publicTcpTarget } from './public-target.mjs';

export async function publicDial(target) {
  const addresses = await lookup(target.hostname, { all: true, verbatim: true, hints: ADDRCONFIG });
  if (!addresses.length || addresses.some(value => !publicTcpTarget(value.address, target.port))) throw Error('Private addresses are forbidden');
  // Connect to the validated address without resolving the hostname again.
  const socket = tcpConnect({ host: addresses[0].address, port: target.port }); socket.setNoDelay(true);
  const opened = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const closed = new Promise(resolve => socket.once('close', resolve));
  return { opened, closed, readable: Readable.toWeb(socket), writable: Writable.toWeb(socket), close: async () => { socket.destroy(); } };
}
