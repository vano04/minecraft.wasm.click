import { createLauncherAccountParser } from '/auth/account-json.mjs';

const form = document.getElementById('account-import');
const input = document.getElementById('account-file');
const button = document.getElementById('login-button');
const status = document.getElementById('account-status');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const parser = createLauncherAccountParser();
  button.disabled = true;
  try {
    const file = input.files?.[0];
    if (!file) throw Error('Choose your PrismLauncher accounts.json file.');
    if (file.size > parser.maxBytes) throw Error('The account JSON file must be no larger than 1 MiB.');
    const parsed = parser.parse(await file.text());
    input.value = '';
    if (!parsed.ok) throw Error(parsed.message);
    const credential = parser.takeCredential();
    status.textContent = 'Verifying your Minecraft account...';
    // Send only the selected short-lived Minecraft credential.
    const response = await fetch('/mcweb/auth/import', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'MSA', profile: { id: credential.profileId, name: credential.profileName },
        ygg: { token: credential.accessToken, exp: credential.expiresAt / 1000 },
        entitlement: { ownsMinecraft: true, canPlayMinecraft: true } }),
    });
    let result;
    try { result = await response.json(); } catch {}
    if (!response.ok) throw Error(result?.error || 'The Minecraft account could not be verified.');
    location.assign('/play/');
  } catch (error) {
    status.textContent = error.message || 'The account file could not be imported.';
  } finally {
    parser.clear(); input.value = ''; button.disabled = false;
  }
});
