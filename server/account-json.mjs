// Shared PrismLauncher parser. Parsing alone does not verify ownership or authenticate a session.
export function createLauncherAccountParser({ now = Date.now } = {}) {
  const MAX_AUTH_BYTES = 1024 * 1024;
  const MAX_AUTH_DEPTH = 64;
  const PRISM_AUTH_SCHEMA = "prismlauncher-accounts-v1";
  let memoryCredential = null;
  let memoryProfile = null;

  function normaliseKey(key) {
    return key.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function inspectValue(value, state, depth = 0) {
    if (depth > MAX_AUTH_DEPTH) {
      state.tooDeep = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) inspectValue(item, state, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const normalised = normaliseKey(key);
      if (normalised.includes("password")
          || normalised.includes("clientsecret")
          || normalised.includes("privatekey")) {
        state.forbiddenCredential = true;
      }
      if (normalised.includes("token") || normalised.includes("secret")) {
        state.credentialLike = true;
      }
      inspectValue(child, state, depth + 1);
    }
  }

  function validProfile(profile) {
    return profile && typeof profile === "object"
      && typeof profile.name === "string"
      && /^[A-Za-z0-9_]{1,16}$/.test(profile.name)
      && typeof profile.id === "string"
      && /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(profile.id);
  }

  function validTokenRecord(record) {
    return record && typeof record === "object"
      && typeof record.token === "string"
      && record.token.length >= 16
      && Number.isSafeInteger(Number(record.exp) * 1000)
      && Number(record.exp) * 1000 > now();
  }

  function prismAccounts(value) {
    if (Array.isArray(value?.accounts)) return value.accounts;
    if (value && typeof value === "object" && value.profile) return [value];
    return null;
  }

  function parsePrismAuthValue(value) {
    memoryCredential = null;
    memoryProfile = null;
    const accounts = prismAccounts(value);
    if (!accounts || accounts.length === 0 || accounts.length > 32) {
      return { ok: false, code: "unsupported-schema", message: "The file is not a PrismLauncher account store." };
    }
    const account = accounts.find((candidate) => candidate?.active === true) || accounts[0];
    if (!account || String(account.type || "").toUpperCase() !== "MSA") {
      return { ok: false, code: "unsupported-schema", message: "The file does not contain a Microsoft account from PrismLauncher." };
    }
    if (!validProfile(account.profile)) {
      return { ok: false, code: "invalid-profile", message: "The Prism account has no valid Minecraft profile." };
    }
    if (!validTokenRecord(account.ygg)) {
      return { ok: false, code: "expired-token", message: "The Prism account has no unexpired Minecraft session token." };
    }
    if (account.entitlement?.ownsMinecraft !== true
        || account.entitlement?.canPlayMinecraft !== true) {
      return { ok: false, code: "missing-entitlement", message: "Minecraft ownership and play entitlement were not confirmed by PrismLauncher." };
    }
    memoryCredential = Object.freeze({
      accessToken: account.ygg.token,
      profileId: account.profile.id,
      profileName: account.profile.name,
      expiresAt: Number(account.ygg.exp) * 1000,
    });
    memoryProfile = Object.freeze({
      id: account.profile.id,
      name: account.profile.name,
    });
    return {
      ok: true,
      code: "prism-accounts-v1",
      schema: PRISM_AUTH_SCHEMA,
      profile: { id: account.profile.id, name: account.profile.name },
      expiresAt: Number(account.ygg.exp) * 1000,
      hasRefreshToken: typeof account.msa?.refresh_token === "string"
        && account.msa.refresh_token.length >= 16,
    };
  }

  function validateAuthJsonText(text) {
    memoryCredential = null;
    memoryProfile = null;
    if (typeof text !== "string") {
      return { ok: false, code: "invalid-input", message: "The selected file could not be read as text." };
    }
    if (new TextEncoder().encode(text).byteLength > MAX_AUTH_BYTES) {
      return { ok: false, code: "too-large", message: "The selected JSON file is larger than the parser limit." };
    }

    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, code: "invalid-json", message: "The selected file is not valid JSON." };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, code: "invalid-shape", message: "The selected JSON must contain one object." };
    }

    const state = { forbiddenCredential: false, credentialLike: false, tooDeep: false };
    inspectValue(value, state);
    if (state.tooDeep) {
      return { ok: false, code: "too-deep", message: "The selected JSON is too deeply nested to inspect safely." };
    }
    if (state.forbiddenCredential) {
      return { ok: false, code: "forbidden-credential", message: "The file contains a password or client secret and was rejected locally." };
    }

    const result = parsePrismAuthValue(value);
    return { ...result, credentialLike: state.credentialLike };
  }

  return Object.freeze({
    maxBytes: MAX_AUTH_BYTES,
    schema: PRISM_AUTH_SCHEMA,
    parse: validateAuthJsonText,
    profile: () => memoryProfile ? { ...memoryProfile } : null,
    takeCredential() {
      const credential = memoryCredential?.expiresAt > now() ? memoryCredential : null;
      memoryCredential = null;
      memoryProfile = null;
      return credential;
    },
    clear() { memoryCredential = null; memoryProfile = null; },
  });
}
