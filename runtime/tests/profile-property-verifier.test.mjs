import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { ProfilePropertyVerifier } from "../tools/profile-property-verifier.mjs";

test("profile property verifier accepts valid and rejects tampered signatures", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  let fetches = 0;
  const verifier = new ProfilePropertyVerifier({
    publicKeysUrl: "http://127.0.0.1:25586/publickeys",
    fetchImpl: async (url) => {
      fetches++;
      assert.equal(url, "http://127.0.0.1:25586/publickeys");
      return {
        ok: true,
        async json() {
          return {
            profilePropertyKeys: [{ publicKey: publicKeyDer.toString("base64") }],
          };
        },
      };
    },
  });

  const value = Buffer.from('{"textures":{"SKIN":{"url":"fixture"}}}')
    .toString("base64");
  const signature = crypto.sign(
    "RSA-SHA1",
    Buffer.from(value, "utf8"),
    privateKey,
  ).toString("base64");

  assert.equal(await verifier.verify(value, signature), true);
  assert.equal(await verifier.verify(`${value}tampered`, signature), false);
  assert.equal(await verifier.verify(value, ""), false);
  assert.equal(fetches, 1, "Mojang's service key set should be cached");
});

test("profile property verifier fails closed when no usable key is returned", async () => {
  const verifier = new ProfilePropertyVerifier({
    fetchImpl: async () => ({
      ok: true,
      async json() { return { profilePropertyKeys: [{ publicKey: "broken" }] }; },
    }),
  });
  assert.equal(await verifier.verify("value", "c2lnbmF0dXJl"), false);
});
