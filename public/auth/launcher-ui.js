'use strict';
(() => {
  // Safari can still zoom during repeated taps with another finger held down.
  // The game uses pointer events; cancel only the browser's touch defaults.
  const preventGameTouchZoom = event => {
    if (document.body.dataset.launcherState !== 'game') return;
    const surface = event.target.closest?.('.mcweb-gc-touch');
    if (surface?.closest('.mcweb-gc-root.is-touch') && event.cancelable) event.preventDefault();
  };
  for (const type of ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'gesturechange']) {
    document.addEventListener(type, preventGameTouchZoom, { passive: false });
  }
  let quitPending = false, quitOperation = null;
  globalThis.mcWebQuitToLauncher = () => {
    quitPending = true;
    return quitOperation ||= (async () => {
      // After Minecraft stops, keep this document alive until intercepted
      // player-file writes commit before replacing the runtime document.
      await globalThis.mcWebGameStorage.flush();
      await globalThis.mcWebRuntime?.discard();
      globalThis.gameStopped?.();
      document.exitPointerLock?.();
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      location.replace('/');
    })().catch(error => { quitOperation = null; throw error; });
  };
  globalThis.mcWebRuntimeStopped = () => {
    delete document.body.dataset.launcherState;
    document.exitPointerLock?.();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  };
  const account = document.getElementById('account-menu');
  document.addEventListener('click', event => {
    if (account && !account.contains(event.target)) account.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && account?.open) {
      account.open = false;
      account.querySelector('summary').focus();
    }
  });
  const settings = document.getElementById('launcher-settings');
  document.getElementById('settings-button')?.addEventListener('click', () => settings.showModal());
  if (settings) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountLibrary(settings), { once: true });
    else mountLibrary(settings);
  }

  function mountLibrary(settingsDialog) {
    const library = globalThis.mcWebGameLibrary;
    if (!library) return;
    const panel = document.createElement('section');
    panel.className = 'game-library';
    panel.innerHTML = '<h3>Worlds and resource packs</h3><p>Files stay in this browser. Export a backup before clearing website data. Import Java Edition worlds and resource packs as ZIP files (up to 512 MiB).</p>'
      + '<div data-library-kind="world" class="library-group" tabindex="0" aria-label="World ZIP import drop area"><h4>Worlds</h4><p>Exit the game and reload this page before importing, exporting or deleting worlds.</p><button type="button" class="pixel-button" data-import>Import world ZIP</button><input type="file" accept=".zip,application/zip" multiple hidden><ul data-items aria-label="Saved worlds"></ul></div>'
      + '<div data-library-kind="pack" class="library-group" tabindex="0" aria-label="Resource pack ZIP import drop area"><h4>Resource packs</h4><p>Choose a ZIP, drag it here, or paste a copied ZIP file. New packs appear after you reopen Minecraft’s Resource Packs screen.</p><button type="button" class="pixel-button" data-import>Import resource pack ZIP</button><input type="file" accept=".zip,application/zip" multiple hidden><ul data-items aria-label="Installed resource packs"></ul></div>'
      + '<p class="library-status" role="status" aria-live="polite"></p>';
    settingsDialog.querySelector('.settings-account')?.before(panel);
    if (!panel.isConnected) settingsDialog.append(panel);
    const packDialog = document.createElement('dialog');
    packDialog.id = 'game-files';
    packDialog.className = 'launcher-dialog';
    packDialog.setAttribute('aria-labelledby', 'game-files-title');
    packDialog.innerHTML = '<div class="dialog-heading"><h2 id="game-files-title">Resource packs</h2><form method="dialog"><button class="pixel-button" aria-label="Close resource packs">Done</button></form></div><p>Choose a texture or resource pack ZIP. You can also drop or paste a ZIP file here.</p>';
    const inGamePanel = panel.querySelector('[data-library-kind="pack"]').cloneNode(true);
    packDialog.append(inGamePanel);
    const inGameStatus = document.createElement('p');
    inGameStatus.className = 'library-status';
    inGameStatus.setAttribute('role', 'status');
    inGameStatus.setAttribute('aria-live', 'polite');
    packDialog.append(inGameStatus);
    document.body.append(packDialog);
    for (const type of ['keydown', 'keyup', 'mouseup']) packDialog.addEventListener(type, event => event.stopPropagation());
    const saveStatus = document.createElement('p');
    saveStatus.className = 'player-save-status';
    saveStatus.setAttribute('role', 'status');
    panel.prepend(saveStatus);
    const gameSaveStatus = saveStatus.cloneNode();
    gameSaveStatus.id = 'game-save-status';
    const stage = document.getElementById('mcweb-game-stage');
    stage?.append(gameSaveStatus);
    const retrySave = document.createElement('button');
    retrySave.type = 'button'; retrySave.className = 'text-button'; retrySave.textContent = 'Retry saving'; retrySave.hidden = true;
    saveStatus.after(retrySave);
    const retry = async () => {
      retrySave.disabled = true;
      try { await (quitPending ? globalThis.mcWebQuitToLauncher() : globalThis.mcWebGameStorage.flush()); showStorageStatus(); }
      catch (error) { showStorageStatus(); }
      finally { retrySave.disabled = false; }
    };
    retrySave.addEventListener('click', retry);

    function showStorageStatus(event) {
      const value = event?.detail || globalThis.mcWebGameStorage?.status();
      if (!value) return;
      const error = value.lastError;
      const text = error ? 'Saving failed: ' + error + ' Keep this page open, free device space, then retry saving.'
        : value.pending ? 'Saving changes to this browser…'
        : value.lastSavedAt ? 'Changes saved in this browser.' : 'Worlds and packs are stored on this device.';
      saveStatus.textContent = text;
      retrySave.hidden = !error;
      saveStatus.classList.toggle('saving-error', Boolean(error));
      gameSaveStatus.textContent = error ? 'Saving failed: ' + error + ' Keep this page open. ' : '';
      if (error) {
        const gameRetry = document.createElement('button'); gameRetry.type = 'button';
        gameRetry.className = 'text-button'; gameRetry.textContent = 'Retry saving'; gameRetry.addEventListener('click', retry);
        gameSaveStatus.append(gameRetry);
      }

      gameSaveStatus.hidden = !error;
    }
    globalThis.addEventListener('mcweb-storage-status', event => { showStorageStatus(event); controls(); });
    showStorageStatus();
    let busy = false;
    let download = null;
    function releaseDownload() {
      if (!download) return;
      clearTimeout(download.timer);
      URL.revokeObjectURL(download.url);
      download.link.remove();
      download = null;
    }
    const message = text => { releaseDownload(); panel.querySelector('.library-status').textContent = text; inGameStatus.textContent = text; };
    globalThis.addEventListener('pagehide', releaseDownload);
    const size = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MiB' : Math.ceil(bytes / 1024) + ' KiB';
    const groups = [...panel.querySelectorAll('[data-library-kind]'), inGamePanel];
    function controls() {
      const running = globalThis.mcWebGameStorage?.status().running;
      for (const group of groups) {
        const world = group.dataset.libraryKind === 'world';
        group.querySelector('[data-import]').disabled = busy || (world && running);
        for (const button of group.querySelectorAll('[data-action]')) button.disabled = busy || (running && (world || button.dataset.action === 'delete'));
      }
    }
    async function refresh() {
      try {
        const inventories = new Map();
        for (const group of groups) {
          const kind = group.dataset.libraryKind;
          if (!inventories.has(kind)) inventories.set(kind, await library.list(kind));
          const items = inventories.get(kind);
          const list = group.querySelector('[data-items]');
          list.replaceChildren();
          if (!items.length) {
            const empty = document.createElement('li'); empty.className = 'library-empty';
            empty.textContent = kind === 'world' ? 'No saved worlds yet.' : 'No imported packs yet.'; list.append(empty);
          }
          for (const item of items) {
            const row = document.createElement('li');
            const label = document.createElement('span');
            const itemSize = document.createElement('span');
            itemSize.className = 'library-item-size';
            itemSize.textContent = size(item.bytes) + ' ·';
            const itemName = document.createElement('span');
            itemName.className = 'library-item-name';
            itemName.textContent = item.name;
            itemName.title = item.name;
            itemName.tabIndex = 0;
            label.append(itemSize, itemName);
            row.append(label);
            for (const action of ['export', 'delete']) {
              const button = document.createElement('button');
              button.type = 'button'; button.className = 'text-button'; button.dataset.action = action;
              button.textContent = action === 'export' ? 'Export ZIP' : 'Delete';
              button.setAttribute('aria-label', button.textContent + ' ' + item.name);
              button.addEventListener('click', () => {
                if (action === 'delete' && !confirm('Delete “' + item.name + '” from this browser? Export a backup first if you want to keep it.')) return;
                perform(async () => {
                  if (action === 'delete') { await library.remove(kind, item.name); message('Deleted “' + item.name + '”.'); }
                  else {
                    message('Preparing “' + item.name + '”…');
                    const blob = await library.exportZip(kind, item.name);
                    const url = URL.createObjectURL(blob), link = document.createElement('a');
                    link.href = url; link.download = item.name + '.zip'; link.textContent = 'Save ' + item.name + '.zip';
                    link.className = 'library-download';
                    const target = packDialog.open ? inGameStatus : panel.querySelector('.library-status');
                    target.textContent = 'Backup ready. '; target.append(link);
                    link.click();
                    download = { url, link, timer: setTimeout(releaseDownload, 60000) };
                  }
                });
              });
              row.append(button);
            }
            list.append(row);
          }
        }
        controls();
      } catch (error) { message(error.message || String(error)); }
    }
    async function perform(action) {
      if (busy) return;
      busy = true; controls();
      try { await action(); } catch (error) { message(error.message || String(error)); }
      finally { busy = false; await refresh(); }
    }
    function importFiles(kind, files) {
      if (!files.length) { message('Copy or choose a ZIP file to import.'); return; }
      perform(async () => {
        for (const file of files) {
          message('Checking “' + file.name + '”…');
          const result = await library.importZip(kind, file, (done, total) => message('Unpacking “' + file.name + '”: ' + done + ' / ' + total));
          message('Imported “' + result.name + '” (' + size(result.bytes) + ').' + (kind === 'pack' && globalThis.mcWebGameStorage?.status().running ? ' Reopen Minecraft’s Resource Packs screen to select it.' : ''));
        }
      });
    }
    for (const group of groups) {
      const kind = group.dataset.libraryKind, input = group.querySelector('input');
      group.querySelector('[data-import]').addEventListener('click', () => input.click());
      input.addEventListener('change', () => { const files = [...input.files]; input.value = ''; importFiles(kind, files); });
      group.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); group.classList.add('library-drag'); } });
      group.addEventListener('dragleave', () => group.classList.remove('library-drag'));
      group.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); group.classList.remove('library-drag'); importFiles(kind, [...(event.dataTransfer?.files || [])]); });
      group.addEventListener('paste', event => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); importFiles(kind, files); } });
    }
    const openPacks = (pick = false) => {
      document.exitPointerLock?.();
      if (!packDialog.open) packDialog.showModal();
      refresh();
      if (pick && navigator.userActivation?.isActive !== false) inGamePanel.querySelector('input').click();
    };
    // Native Open Folder bridge shows a dialog with a user-activated picker:
    // opening an OS picker directly from a JVM message is blocked by browsers.
    globalThis.mcWebOpenResourcePacks = () => openPacks(true);
    globalThis.addEventListener('mcweb-open-resourcepacks', () => openPacks(true));
    packDialog.addEventListener('paste', event => { const files = [...(event.clipboardData?.files || [])]; if (files.length && !event.defaultPrevented) { event.preventDefault(); importFiles('pack', files); } });
    if (stage) {
      stage.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
      stage.addEventListener('drop', event => { if (!event.dataTransfer?.files.length) return; event.preventDefault(); openPacks(); importFiles('pack', [...event.dataTransfer.files]); });
    }
    document.addEventListener('paste', event => {
      const files = [...(event.clipboardData?.files || [])];
      if (files.length && !event.defaultPrevented && document.body.dataset.launcherState === 'game') { event.preventDefault(); openPacks(); importFiles('pack', files); }
    });
    settingsDialog.addEventListener('toggle', () => { if (settingsDialog.open) refresh(); });
    document.getElementById('settings-button')?.addEventListener('click', refresh);
  }

  const notice = document.getElementById('launcher-notice');
  if (!notice) return;
  const read = document.getElementById('notice-read');
  const continueButton = document.getElementById('notice-continue');
  const key = 'minecraft.wasm.click.launcherNotice.2026-10-24-project2';
  const openNotice = () => {
    read.checked = false;
    continueButton.disabled = true;
    notice.showModal();
  };
  const rememberRead = () => {
    try { localStorage.setItem(key, 'read'); } catch {}
    try {
      document.cookie = 'minecraft_launcher_notice=read; Path=/; Max-Age=31536000; SameSite=Lax'
        + (location.protocol === 'https:' ? '; Secure' : '');
    } catch {}
  };
  read.addEventListener('change', () => {
    continueButton.disabled = !read.checked;
    if (read.checked) rememberRead();
  });
  notice.querySelector('form').addEventListener('submit', rememberRead);
  document.querySelectorAll('[data-open-notice]').forEach(button => {
    button.addEventListener('click', openNotice);
  });
  let acknowledged = false;
  try { acknowledged = localStorage.getItem(key) === 'read'; } catch {}
  try { acknowledged ||= document.cookie.split(';').some(value => value.trim() === 'minecraft_launcher_notice=read'); } catch {}
  if (!acknowledged) openNotice();
})();
