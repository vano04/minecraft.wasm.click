'use strict';
const skin = document.querySelector('.testing-account img');
if (skin) {
  skin.hidden = true;
  const showFace = () => {
    if (!skin.isConnected || !skin.naturalWidth) return;
    const face = document.createElement('canvas');
    face.width = face.height = 64;
    face.setAttribute('role', 'img');
    face.setAttribute('aria-label', 'Minecraft skin face');
    const context = face.getContext('2d');
    if (!context) return;
    const unit = skin.naturalWidth / 64;
    context.imageSmoothingEnabled = false;
    context.drawImage(skin, 8 * unit, 8 * unit, 8 * unit, 8 * unit, 0, 0, 64, 64);
    context.drawImage(skin, 40 * unit, 8 * unit, 8 * unit, 8 * unit, 0, 0, 64, 64);
    skin.replaceWith(face);
  };
  skin.addEventListener('load', showFace, { once: true });
  if (skin.complete) showFace();
}
document.getElementById('logout-button').onclick = async () => {
  await mcWebAuthGate.logout(); location.reload();
};
// An expired session cannot keep a previously loaded game connected.
const lifetime = Math.max(1, __mcWebVerified.session.expiresAt - Date.now());
setTimeout(() => location.reload(), lifetime);
addEventListener('focus', () => { mcWebAuthGate.getSession().catch(() => location.reload()); });
