'use strict';
globalThis.mcWebAuthGate = (() => {
  let session = null;
  async function getSession() {
    const response = await fetch('/mcweb/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw Error('Import a fresh Minecraft account JSON file before starting the game.');
    const value = await response.json();
    if (value.authenticated !== true || value.mode !== 'online'
        || !/^[a-f0-9]{32}$/i.test(value.profile?.id || '')
        || !/^[A-Za-z0-9_]{1,16}$/.test(value.profile?.name || '')
        || value.profile.skinPath !== '/mcweb/auth/minecraft/skin'
        || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) {
      throw Error('The Minecraft session is invalid or expired. Import a fresh account JSON file.');
    }
    session = value;
    return value;
  }
  async function logout() {
    const response = await fetch('/mcweb/auth/logout', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw Error('Sign-out failed. Please try again.');
    session = null;
  }
  return { getSession, logout, session: () => session };
})();
