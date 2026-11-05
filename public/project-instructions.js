export function createProjectInstructionsEditor({ rpc, t = text => text, document = globalThis.document }) {
  const view = document.defaultView, bound = new WeakSet();
  const menu = document.createElement('div'), edit = document.createElement('button');
  menu.className = 'project-context-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
  edit.type = 'button'; edit.setAttribute('role', 'menuitem'); edit.textContent = t('Edit AGENTS.md'); menu.append(edit);
  const dialog = document.createElement('dialog'); dialog.className = 'project-instructions-dialog';
  dialog.setAttribute('aria-labelledby', 'projectInstructionsTitle');
  const form = document.createElement('form'), header = document.createElement('header'), title = document.createElement('strong');
  header.className = 'project-instructions-header'; title.id = 'projectInstructionsTitle'; title.textContent = 'AGENTS.md';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'folder-cancel'; close.textContent = t('Close'); header.append(title, close);
  const path = document.createElement('p'); path.className = 'project-instructions-path';
  const input = document.createElement('textarea'); input.setAttribute('aria-label', t('Project instructions')); input.spellcheck = false;
  const actions = document.createElement('div'), status = document.createElement('span'), save = document.createElement('button');
  actions.className = 'project-instructions-actions'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  save.type = 'submit'; save.className = 'integration-refresh'; save.textContent = t('Save'); actions.append(status, save);
  form.append(header, path, input, actions); dialog.append(form); document.body.append(menu, dialog);
  let project = null, anchor = null, file = null, saving = false, generation = 0;
  const dirty = () => file && (input.value !== file.instructions || !file.exists);
  const closeMenu = (restore = false) => { menu.hidden = true; if (restore && anchor?.isConnected) anchor.focus(); };
  function closeDialog() {
    if (saving || (file && input.value !== file.instructions && !view.confirm(t('Discard unsaved changes?')))) return;
    generation++; dialog.close();
  }
  close.onclick = closeDialog;
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  input.addEventListener('input', () => { save.disabled = saving || !dirty(); status.textContent = ''; });
  async function open(cwd) {
    closeMenu(); const current = ++generation;
    file = null; input.value = ''; path.textContent = `${cwd}/AGENTS.md`; status.textContent = t('Loading…');
    input.disabled = true; save.disabled = true; dialog.showModal();
    try {
      const result = await rpc('host/settings/read', { scope: 'project-instructions', cwd });
      if (current !== generation) return;
      file = result; path.textContent = file.path; input.value = file.instructions; input.disabled = false;
      status.textContent = ''; save.disabled = !dirty(); input.focus();
      form.onsubmit = async event => {
        event.preventDefault(); if (saving || save.disabled) return;
        saving = true; input.disabled = true; save.disabled = true; close.disabled = true; status.textContent = t('Saving…');
        try {
          file = await rpc('host/settings/write', { field: 'projectInstructions', cwd, value: input.value, version: file.version });
          status.textContent = t('Saved');
        } catch (error) { status.textContent = t(error.message); }
        finally { saving = false; input.disabled = false; close.disabled = false; save.disabled = !dirty(); }
      };
    } catch (error) { if (current === generation) status.textContent = t(error.message); }
  }
  edit.onclick = () => { if (project) void open(project); };
  function show(event, cwd, heading) {
    event.preventDefault(); project = cwd; anchor = heading;
    const bounds = heading.getBoundingClientRect(), keyboard = event.type === 'keydown';
    const scale = Number(view.getComputedStyle(document.documentElement).getPropertyValue('--interface-scale')) || 1;
    menu.hidden = false;
    menu.style.left = `${Math.max(4, Math.min((keyboard ? bounds.left : event.clientX) / scale, view.innerWidth / scale - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min((keyboard ? bounds.bottom : event.clientY) / scale, view.innerHeight / scale - menu.offsetHeight - 4))}px`;
    edit.focus();
  }
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); closeMenu(true); }
  });
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) closeMenu(); });
  document.addEventListener('scroll', () => closeMenu(), true);
  view.addEventListener('resize', () => closeMenu());
  return {
    bind(row, cwd) {
      if (cwd === '__tasks__' || bound.has(row)) return;
      bound.add(row);
      const heading = row.querySelector('.sidebar-project-row') || row;
      heading.setAttribute('aria-haspopup', 'menu');
      row.addEventListener('contextmenu', event => show(event, cwd, heading));
      heading.addEventListener('keydown', event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) show(event, cwd, heading);
      });
    },
  };
}
