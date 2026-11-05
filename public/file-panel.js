import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { localDownloadUrl } from './rendering.js';

export function createFilePanel(host, { getCwd }) {
  host.classList.add('file-panel');
  host.innerHTML = `<div class="file-toolbar"><button type="button" data-up>上一级</button><input aria-label="文件夹路径" spellcheck="false"><button type="button" data-go>打开</button><button type="button" data-refresh>刷新</button></div><div class="file-panel-body"><div class="file-list" aria-label="文件列表"></div><section class="file-preview" aria-label="文件预览"><div class="file-preview-toolbar"><button type="button" data-back hidden>返回文件列表</button><span class="file-preview-name"></span><button type="button" data-source hidden>源码</button><a data-download hidden download>下载</a></div><div class="file-preview-content" role="region" aria-label="文件内容" tabindex="0">点击文件查看内容</div></section></div>`;
  const find = selector => host.querySelector(selector);
  const input = find('input'), list = find('.file-list'), content = find('.file-preview-content');
  const up = find('[data-up]'), source = find('[data-source]'), download = find('[data-download]');
  let cwd = '', path = '', parent = null, directoryRequest = 0, previewRequest = 0, selected = null, raw = false, reference = null;
  async function request(endpoint, params) {
    const response = await fetch(`/api/files/${endpoint}?${new URLSearchParams(params)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取失败');
    return data;
  }
  function resetPreview() {
    ++previewRequest;
    selected = null; reference = null;
    host.classList.remove('file-preview-open');
    source.hidden = download.hidden = find('[data-back]').hidden = true;
    find('.file-preview-name').textContent = '';
    content.className = 'file-preview-content';
    content.textContent = '点击文件查看内容';
    content.removeAttribute('aria-busy');
  }
  function renderPreview() {
    source.hidden = !selected?.markdown;
    source.textContent = raw ? '预览' : '源码';
    source.setAttribute('aria-pressed', String(raw));
    content.className = 'file-preview-content' + (selected.markdown && !raw ? ' message-text' : ' file-source');
    if (selected.markdown && !raw) {
      const fragment = DOMPurify.sanitize(marked.parse(selected.text, { async: false, gfm: true }), {
        RETURN_DOM_FRAGMENT: true,
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
        FORBID_ATTR: ['style'],
      });
      for (const link of fragment.querySelectorAll('a')) {
        const href = link.getAttribute('href') || '';
        if (/^https?:/i.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        else if (!/^(#|mailto:)/i.test(href)) link.removeAttribute('href');
      }
      // File documents should not trigger arbitrary remote image requests.
      for (const image of fragment.querySelectorAll('img')) image.replaceWith(document.createTextNode(image.alt || '[图片]'));
      content.replaceChildren(fragment);
    } else {
      content.textContent = selected.text || '（空文件）';
      if (reference?.lineStart) {
        const lines = selected.text.split('\n'), start = reference.lineStart, end = Math.min(reference.lineEnd || start, lines.length);
        if (start <= lines.length) {
          const mark = document.createElement('mark'); mark.className = 'file-reference-highlight';
          mark.textContent = lines.slice(start - 1, end).join('\n');
          content.replaceChildren(document.createTextNode(lines.slice(0, start - 1).join('\n') + (start > 1 ? '\n' : '')), mark, document.createTextNode((end < lines.length ? '\n' : '') + lines.slice(end).join('\n')));
          requestAnimationFrame(() => mark.scrollIntoView?.({ block: 'center' }));
        } else find('.file-preview-name').textContent = `${selected.filename}（共 ${lines.length} 行，无第 ${start} 行）`;
      }
    }
  }
  async function preview(item, button, location = null) {
    const id = ++previewRequest;
    for (const row of list.querySelectorAll('button')) row.setAttribute('aria-pressed', String(row === button));
    selected = null;
    source.hidden = true;
    host.classList.add('file-preview-open');
    find('[data-back]').hidden = false;
    find('.file-preview-name').textContent = item.name;
    download.href = localDownloadUrl(item.path, cwd);
    download.hidden = false;
    content.className = 'file-preview-content';
    content.textContent = '正在读取…';
    content.setAttribute('aria-busy', 'true');
    try {
      const data = await request('preview', { path: item.path, cwd });
      if (id !== previewRequest) return;
      selected = data;
      reference = location; raw = Boolean(location?.lineStart);
      download.href = localDownloadUrl(data.path, cwd);
      find('.file-preview-name').textContent = `${data.filename}${location?.lineStart ? `:${location.lineStart}` : ''}`;
      renderPreview();
      return data;
    } catch (error) { if (id === previewRequest) content.textContent = error.message; }
    finally { if (id === previewRequest) content.removeAttribute('aria-busy'); }
  }
  async function load(nextPath = path || cwd, { preservePreview = false } = {}) {
    const id = ++directoryRequest;
    if (!preservePreview) resetPreview();
    input.value = nextPath;
    up.disabled = true;
    list.textContent = '正在加载…';
    list.setAttribute('aria-busy', 'true');
    try {
      const data = await request('list', { path: nextPath, cwd });
      if (id !== directoryRequest) return;
      path = data.path;
      parent = data.parent;
      input.value = path;
      up.disabled = !parent;
      list.replaceChildren();
      for (const item of data.items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'file-row';
        button.textContent = item.name + (item.kind === 'folder' ? '/' : '');
        button.title = item.path;
        button.dataset.kind = item.kind;
        button.onclick = () => item.kind === 'folder' ? load(item.path) : preview(item, button);
        list.append(button);
      }
      if (!data.items.length) list.textContent = '此文件夹为空';
    } catch (error) { if (id === directoryRequest) list.textContent = error.message; }
    finally { if (id === directoryRequest) list.removeAttribute('aria-busy'); }
  }
  up.onclick = () => parent && load(parent);
  find('[data-go]').onclick = () => load(input.value.trim() || cwd);
  input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); load(input.value.trim() || cwd); } };
  find('[data-refresh]').onclick = () => load();
  find('[data-back]').onclick = () => { host.classList.remove('file-preview-open'); list.querySelector('[aria-pressed="true"]')?.focus(); };
  source.onclick = () => { raw = !raw; renderPreview(); };
  return {
    async openFile(location) {
      if (!location || typeof location.path !== 'string') throw new Error('文件路径无效。');
      cwd = getCwd();
      const data = await preview({ path: location.path, name: location.path.split('/').at(-1) }, null, {
        lineStart: Number.isSafeInteger(location.lineStart) && location.lineStart > 0 ? location.lineStart : null,
        lineEnd: Number.isSafeInteger(location.lineEnd) && location.lineEnd >= location.lineStart ? location.lineEnd : null,
      });
      if (data) await load(data.path.slice(0, data.path.lastIndexOf('/')) || '/', { preservePreview: true });
    },
    show() {
      const nextCwd = getCwd();
      if (cwd !== nextCwd || !path) { cwd = nextCwd; void load(cwd); }
    },
    sync() { if (!host.hidden) this.show(); },
  };
}
