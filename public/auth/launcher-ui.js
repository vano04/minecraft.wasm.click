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

  function createElement(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === undefined || value === false || value === null) continue;
      if (value === true) node.setAttribute(name, '');
      else if (name === 'textContent') node.textContent = value;
      else node.setAttribute(name, value);
    }
    for (const child of children) {
      if (child !== undefined && child !== null) node.append(child);
    }
    return node;
  }

  function enableLightDismiss(dialog) {
    if (!dialog || ('closedBy' in (globalThis.HTMLDialogElement?.prototype || {}))) return;
    let pointerDownOutside = false;
    const isOutside = event => {
      const rect = dialog.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom;
    };
    dialog.addEventListener('pointerdown', event => {
      pointerDownOutside = event.target === dialog && isOutside(event);
    });
    dialog.addEventListener('pointerup', event => {
      if (pointerDownOutside && event.target === dialog && isOutside(event)) dialog.close();
      pointerDownOutside = false;
    });
  }

  if (!('commandForElement' in (globalThis.HTMLButtonElement?.prototype || {}))) {
    document.querySelectorAll?.('button[commandfor][command]').forEach(button => {
      button.addEventListener('click', () => {
        const target = document.getElementById(button.getAttribute('commandfor'));
        const command = button.getAttribute('command');
        if (!target) return;
        if (command === 'show-modal' && !target.open) target.showModal?.();
        else if (command === 'close' && target.open) target.close?.();
        else if (command === 'toggle-popover') target.togglePopover?.();
      });
    });
  }

  const account = document.getElementById('account-menu');
  const accountTrigger = document.getElementById('account-menu-trigger');
  if (account && accountTrigger) {
    const positionPopover = () => {
      if (globalThis.CSS?.supports?.('position-area: block-end')) return;
      const rect = accountTrigger.getBoundingClientRect();
      account.style.top = Math.round(rect.bottom + 6) + 'px';
      account.style.right = Math.max(16, Math.round(globalThis.innerWidth - rect.right)) + 'px';
    };
    account.addEventListener('toggle', event => {
      const open = event.newState === 'open';
      accountTrigger.setAttribute('aria-expanded', String(open));
      if (open) {
        positionPopover();
        account.querySelector('button')?.focus?.();
      }
    });
    const focusGroup = account.querySelector('[focusgroup]');
    if (focusGroup && !('focusgroup' in (globalThis.HTMLElement?.prototype || {}))) {
      focusGroup.setAttribute('role', 'menu');
      const items = [...focusGroup.querySelectorAll('button, a')];
      items.forEach(item => item.setAttribute('role', 'menuitem'));
      focusGroup.addEventListener('keydown', event => {
        const index = items.indexOf(document.activeElement);
        if (index < 0 || !items.length) return;
        let next = index;
        if (event.key === 'ArrowDown') next = (index + 1) % items.length;
        else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = items.length - 1;
        else return;
        event.preventDefault();
        items[next].focus();
      });
    }
  }

  const settings = document.getElementById('launcher-settings');
  enableLightDismiss(settings);
  if (settings) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountLibrary(settings), { once: true });
    else mountLibrary(settings);
  }

  function mountLibrary(settingsDialog) {
    const library = globalThis.mcWebGameLibrary;
    if (!library) return;

    function createLibraryGroup(kind, headingLevel, headingText, descriptionText, buttonText, dropLabel, listLabel) {
      return createElement('div', { 'data-library-kind': kind, class: 'library-group', tabindex: '0', 'aria-label': dropLabel }, [
        createElement(headingLevel, { textContent: headingText }),
        createElement('p', { textContent: descriptionText }),
        createElement('button', { type: 'button', class: 'pixel-button', 'data-import': true, textContent: buttonText }),
        createElement('input', { type: 'file', accept: '.zip,application/zip', multiple: true, hidden: true }),
        createElement('ul', { 'data-items': true, 'aria-label': listLabel }),
      ]);
    }

    const worldGroup = createLibraryGroup(
      'world',
      'h4',
      'Worlds',
      'Exit the game and reload this page before importing, exporting or deleting worlds.',
      'Import world ZIP',
      'World ZIP import drop area',
      'Saved worlds',
    );
    const packGroup = createLibraryGroup(
      'pack',
      'h4',
      'Resource packs',
      'Choose a ZIP, drag it here, or paste a copied ZIP file. New packs appear after you reopen Minecraft’s Resource Packs screen.',
      'Import resource pack ZIP',
      'Resource pack ZIP import drop area',
      'Installed resource packs',
    );
    const settingsProgress = createElement('progress', { class: 'library-progress', hidden: true });
    const settingsStatus = createElement('p', { class: 'library-status', role: 'status', 'aria-live': 'polite' });
    const panel = createElement('section', { class: 'game-library' }, [
      createElement('h3', { textContent: 'Worlds and resource packs' }),
      createElement('p', { textContent: 'Files stay in this browser. Export a backup before clearing website data. Import Java Edition worlds and resource packs as ZIP files (up to 512 MiB).' }),
      worldGroup,
      packGroup,
      settingsProgress,
      settingsStatus,
    ]);
    settingsDialog.querySelector('.settings-account')?.before(panel);
    if (!panel.isConnected) settingsDialog.append(panel);

    const inGamePanel = createLibraryGroup(
      'pack',
      'h3',
      'Resource packs',
      'Choose a ZIP, drag it here, or paste a copied ZIP file. New packs appear after you reopen Minecraft’s Resource Packs screen.',
      'Import resource pack ZIP',
      'Resource pack ZIP import drop area',
      'Installed resource packs',
    );
    const inGameProgress = createElement('progress', { class: 'library-progress', hidden: true });
    const inGameStatus = createElement('p', { class: 'library-status', role: 'status', 'aria-live': 'polite' });
    const packDialog = createElement('dialog', {
      id: 'game-files',
      class: 'launcher-dialog',
      closedby: 'any',
      'aria-labelledby': 'game-files-title',
    }, [
      createElement('div', { class: 'dialog-heading' }, [
        createElement('h2', { id: 'game-files-title', textContent: 'Resource packs' }),
        createElement('form', { method: 'dialog' }, [
          createElement('button', { class: 'pixel-button', 'aria-label': 'Close resource packs', textContent: 'Done' }),
        ]),
      ]),
      createElement('p', { textContent: 'Choose a texture or resource pack ZIP. You can also drop or paste a ZIP file here.' }),
      inGamePanel,
      inGameProgress,
      inGameStatus,
    ]);
    enableLightDismiss(packDialog);
    document.body.append(packDialog);
    for (const type of ['keydown', 'keyup', 'mouseup']) packDialog.addEventListener(type, event => event.stopPropagation());

    const confirmMessage = createElement('p', { id: 'confirm-delete-message' });
    const confirmCancel = createElement('button', { type: 'button', class: 'pixel-button', value: 'cancel', textContent: 'Cancel' });
    const confirmSubmit = createElement('button', { type: 'submit', class: 'pixel-button pixel-button-red', value: 'confirm', textContent: 'Delete' });
    const confirmDialog = createElement('dialog', {
      id: 'confirm-delete',
      class: 'launcher-dialog',
      closedby: 'any',
      'aria-labelledby': 'confirm-delete-title',
      'aria-describedby': 'confirm-delete-message',
    }, [
      createElement('h2', { id: 'confirm-delete-title', textContent: 'Delete saved item' }),
      confirmMessage,
      createElement('form', { method: 'dialog', class: 'confirm-actions' }, [confirmCancel, confirmSubmit]),
    ]);
    enableLightDismiss(confirmDialog);
    confirmCancel.addEventListener('click', () => confirmDialog.close('cancel'));
    document.body.append(confirmDialog);
    function askDeleteConfirmation(itemName) {
      return new Promise(resolve => {
        confirmMessage.textContent = 'Delete “' + itemName + '” from this browser? Export a backup first if you want to keep it.';
        confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'confirm'), { once: true });
        confirmDialog.showModal();
      });
    }

    const saveStatus = createElement('p', { class: 'player-save-status', role: 'status' });
    panel.prepend(saveStatus);
    const gameSaveStatus = saveStatus.cloneNode();
    gameSaveStatus.id = 'game-save-status';
    const stage = document.getElementById('mcweb-game-stage');
    stage?.append(gameSaveStatus);
    const retrySave = createElement('button', { type: 'button', class: 'text-button', textContent: 'Retry saving', hidden: true });
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
        const gameRetry = createElement('button', { type: 'button', class: 'text-button', textContent: 'Retry saving' });
        gameRetry.addEventListener('click', retry);
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
    const setProgress = (done, total) => {
      for (const bar of [settingsProgress, inGameProgress]) {
        if (!total) { bar.hidden = true; bar.removeAttribute('value'); bar.removeAttribute('max'); }
        else { bar.hidden = false; bar.max = total; bar.value = done; }
      }
    };
    const message = text => { releaseDownload(); setProgress(0, 0); settingsStatus.textContent = text; inGameStatus.textContent = text; };
    globalThis.addEventListener('pagehide', releaseDownload);
    const size = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MiB' : Math.ceil(bytes / 1024) + ' KiB';
    const groups = [worldGroup, packGroup, inGamePanel];
    function controls() {
      const running = globalThis.mcWebGameStorage?.status().running;
      for (const group of groups) {
        const world = group.dataset.libraryKind === 'world';
        group.querySelector('[data-import]').disabled = busy || (world && running);
        for (const button of group.querySelectorAll('[data-action]')) button.disabled = busy || (running && (world || button.dataset.action === 'delete'));
      }
    }
    function updateOverflowFocus(group) {
      const check = () => {
        for (const itemName of group.querySelectorAll('.library-item-name')) {
          if (itemName.scrollWidth > itemName.clientWidth) itemName.tabIndex = 0;
          else itemName.removeAttribute('tabindex');
        }
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(check);
      else check();
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
            list.append(createElement('li', { class: 'library-empty', textContent: kind === 'world' ? 'No saved worlds yet.' : 'No imported packs yet.' }));
          }
          for (const item of items) {
            const row = createElement('li');
            const label = createElement('span', {}, [
              createElement('span', { class: 'library-item-size', textContent: size(item.bytes) + ' ·' }),
              createElement('span', { class: 'library-item-name', title: item.name, textContent: item.name }),
            ]);
            row.append(label);
            for (const action of ['export', 'delete']) {
              const button = createElement('button', {
                type: 'button',
                class: 'text-button',
                'data-action': action,
                textContent: action === 'export' ? 'Export ZIP' : 'Delete',
              });
              button.setAttribute('aria-label', button.textContent + ' ' + item.name);
              button.addEventListener('click', () => {
                perform(async () => {
                  if (action === 'delete') {
                    if (!(await askDeleteConfirmation(item.name))) return;
                    await library.remove(kind, item.name);
                    message('Deleted “' + item.name + '”.');
                  } else {
                    message('Preparing “' + item.name + '”…');
                    const blob = await library.exportZip(kind, item.name);
                    const url = URL.createObjectURL(blob);
                    const link = createElement('a', {
                      href: url,
                      download: item.name + '.zip',
                      textContent: 'Save ' + item.name + '.zip',
                      class: 'library-download',
                    });
                    const target = packDialog.open ? inGameStatus : settingsStatus;
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
          updateOverflowFocus(group);
        }
        controls();
      } catch (error) { message(error.message || String(error)); }
    }
    async function perform(action) {
      if (busy) return;
      busy = true; controls();
      try { await action(); } catch (error) { message(error.message || String(error)); }
      finally { setProgress(0, 0); busy = false; await refresh(); }
    }
    function importFiles(kind, files) {
      if (!files.length) { message('Copy or choose a ZIP file to import.'); return; }
      perform(async () => {
        for (const file of files) {
          message('Checking “' + file.name + '”…');
          let lastAnnounced = 0;
          const result = await library.importZip(kind, file, (done, total) => {
            setProgress(done, total);
            const now = Date.now();
            if (done === total || now - lastAnnounced >= 400) {
              lastAnnounced = now;
              const text = 'Unpacking “' + file.name + '”: ' + done + ' / ' + total;
              settingsStatus.textContent = text;
              inGameStatus.textContent = text;
            }
          });
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
  const purchase = document.getElementById('entitlement-notice');
  enableLightDismiss(notice);
  enableLightDismiss(purchase);
  const showPurchase = () => {
    if (!purchase || purchase.open) return;
    if (notice?.open) notice.addEventListener('close', showPurchase, { once: true });
    else purchase.showModal();
  };
  globalThis.addEventListener('minecraft-entitlement-required', showPurchase);
  if (!notice) return;
  const read = document.getElementById('notice-read');
  const noticeForm = document.getElementById('launcher-notice-form') || notice.querySelector('form');
  const noticeError = document.getElementById('notice-error');
  const key = 'minecraft.wasm.click.launcherNotice.2026-10-24-project2';
  const prepareNotice = () => {
    read.checked = false;
    if (noticeError) noticeError.hidden = true;
  };
  const openNotice = () => {
    prepareNotice();
    if (!notice.open) notice.showModal();
  };
  const rememberRead = () => {
    try { localStorage.setItem(key, 'read'); } catch {}
    try {
      document.cookie = 'minecraft_launcher_notice=read; Path=/; Max-Age=31536000; SameSite=Lax'
        + (location.protocol === 'https:' ? '; Secure' : '');
    } catch {}
  };
  let acknowledged = false, signInPending = false;
  const publicIntroduction = document.body.hasAttribute('data-public-introduction');
  const loginButton = document.getElementById('login-button');
  read.addEventListener('change', () => {
    if (read.checked) {
      if (noticeError) noticeError.hidden = true;
      rememberRead();
    }
  });
  noticeForm?.addEventListener('submit', event => {
    if (!read.checked) {
      event.preventDefault();
      if (noticeError) noticeError.hidden = false;
      read.focus();
      return;
    }
    if (noticeError) noticeError.hidden = true;
    rememberRead();
    acknowledged = true;
    if (signInPending) {
      signInPending = false;
      loginButton.click();
    }
  });
  document.querySelectorAll?.('[data-open-notice]').forEach(button => {
    button.addEventListener('click', prepareNotice);
  });
  try { acknowledged = localStorage.getItem(key) === 'read'; } catch {}
  try { acknowledged ||= document.cookie.split(';').some(value => value.trim() === 'minecraft_launcher_notice=read'); } catch {}
  if (publicIntroduction) {
    loginButton.addEventListener('click', event => {
      if (acknowledged) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      signInPending = true;
      openNotice();
    }, { capture: true });
    notice.addEventListener('close', () => { signInPending = false; });
  } else if (!acknowledged) openNotice();
})();
