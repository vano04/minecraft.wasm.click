'use strict';
(() => {
  if ('serviceWorker' in navigator && globalThis.isSecureContext) {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' })
      .catch(error => console.warn('App installation is unavailable:', error.message));
  }
  let installPrompt;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
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
    description.textContent = installed ? 'The launcher is running as an installed app.'
      : installPrompt ? 'Add this launcher to your home screen or desktop.'
      : /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        ? 'In Safari, use Share → Add to Home Screen → Open as Web App. Internet is required to sign in and play. Safari and the installed app may use separate storage; export your worlds before switching.'
        : 'Use your browser’s Install app or Add to Home Screen menu. Internet is required to sign in and play.';
    button.hidden = installed || !installPrompt;
  };
  addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; update(); });
  addEventListener('appinstalled', () => { installPrompt = null; update(); });
  button.addEventListener('click', async () => {
    if (!installPrompt) return;
    const prompt = installPrompt; installPrompt = null; update();
    try { await prompt.prompt(); await prompt.userChoice; } catch (error) { description.textContent = error.message; }
  });
  update();
})();
