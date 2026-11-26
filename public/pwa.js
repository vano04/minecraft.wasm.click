'use strict';
(() => {
  if ('serviceWorker' in navigator && globalThis.isSecureContext) {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' })
      .catch(error => console.warn('App installation is unavailable:', error.message));
  }
  let installPrompt;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const hasNativeInstall = () => typeof navigator.install === 'function';
  const settings = document.getElementById('launcher-settings');
  if (!settings) return;
  const section = document.createElement('section');
  section.className = 'settings-account';
  const title = document.createElement('h3'); title.textContent = 'Install app';
  const description = document.createElement('p');
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'pixel-button'; button.textContent = 'INSTALL APP';
  section.append(title, description, button); settings.append(section);
  const update = () => {
    const installed = standalone();
    const canInstall = !installed && (hasNativeInstall() || Boolean(installPrompt));
    description.textContent = installed ? 'The launcher is running as an installed app.'
      : canInstall ? 'Add this launcher to your home screen or desktop. Safari and an installed home-screen app may keep separate browser storage; export world backups before switching.'
      : 'Use your browser’s Install app or Add to Home Screen menu when available. Internet is required to sign in and play.';
    button.hidden = !canInstall;
  };
  addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; update(); });
  addEventListener('appinstalled', () => { installPrompt = null; update(); });
  button.addEventListener('click', async () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    button.setAttribute('aria-disabled', 'true');
    try {
      if (hasNativeInstall()) {
        await navigator.install();
        update();
      } else if (installPrompt) {
        const prompt = installPrompt;
        installPrompt = null;
        update();
        await prompt.prompt();
        await prompt.userChoice;
      }
    } catch (error) {
      description.textContent = error?.message || 'App installation could not be started.';
    } finally {
      button.removeAttribute('aria-disabled');
    }
  });
  update();
})();
