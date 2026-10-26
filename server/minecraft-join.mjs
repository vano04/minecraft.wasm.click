import { createHash, createPublicKey, publicEncrypt, constants, randomBytes } from 'node:crypto';

function digest(parts) {
  const bytes = createHash('sha1').update(Buffer.concat(parts)).digest();
  const negative = (bytes[0] & 128) !== 0;
  if (negative) {
    let carry = 1;
    for (let at = bytes.length - 1; at >= 0; at--) {
      const next = (bytes[at] ^ 255) + carry;
      bytes[at] = next & 255; carry = next >>> 8;
    }
  }
  return (negative ? '-' : '') + (bytes.toString('hex').replace(/^0+/, '') || '0');
}
function readBytes(value, maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw Error('Invalid Minecraft challenge');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum) throw Error('Invalid Minecraft challenge');
  return bytes;
}
const varInt = value => {
  const bytes = [];
  do { let b = value & 127; value >>>= 7; if (value) b |= 128; bytes.push(b); } while (value);
  return Buffer.from(bytes);
};

// The server chooses the secret and computes the join digest. This endpoint
// cannot be used as a generic token getter or browser-selected hash signer.
export async function minecraftJoin(challenge, credential, fetchImpl) {
  let stage = 'challenge', upstreamStatus;
  try {
    if (typeof challenge?.serverId !== 'string' || challenge.serverId.length > 20) throw Error('Invalid Minecraft server ID');
    const der = readBytes(challenge.publicKey, 1024), verify = readBytes(challenge.verifyToken, 32);
    stage = 'key';
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    const bits = key.asymmetricKeyDetails?.modulusLength;
    if (key.asymmetricKeyType !== 'rsa' || !bits || bits < 1024 || bits > 4096) throw Error('Invalid Minecraft RSA key');
    const secret = randomBytes(16);
    const serverId = digest([Buffer.from(challenge.serverId), secret, der]);
    stage = 'provider';
    const response = await fetchImpl('https://sessionserver.mojang.com/session/minecraft/join', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: credential.token, selectedProfile: credential.id.replace(/-/g, ''), serverId }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel().catch(() => {});
    upstreamStatus = response.status;
    if (![200, 204].includes(response.status)) throw Error('Minecraft authentication failed; sign in again');
    stage = 'encryption';
    const wrap = bytes => publicEncrypt({ key: der, type: 'spki', format: 'der', padding: constants.RSA_PKCS1_PADDING }, bytes);
    const encryptedSecret = wrap(secret), encryptedVerify = wrap(verify);
    return { secret: secret.toString('base64'), response: Buffer.concat([
      varInt(1), varInt(encryptedSecret.length), encryptedSecret, varInt(encryptedVerify.length), encryptedVerify,
    ]).toString('base64') };
  } catch {
    const error = new Error('Minecraft session join failed');
    error.code = 'minecraft-join-' + stage;
    if (stage === 'provider' && upstreamStatus) error.upstreamStatus = upstreamStatus;
    throw error;
  }
}
