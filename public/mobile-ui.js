export function initializeSidebarDismiss({ sidebar, toggle, close, titleToggle }) {
  document.addEventListener('click', event => {
    if (!sidebar.classList.contains('mobile-open')) return;
    const path = event.composedPath();
    if (path.includes(sidebar) || path.includes(toggle) || (titleToggle && path.includes(titleToggle))) return;
    if (document.querySelector('dialog[open]')) return;
    // Consume this tap so closing the drawer cannot activate controls beneath it.
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
    (titleToggle || toggle).focus({ preventScroll: true });
  }, true);
}

export function initializeMobileNavigation({ isMobile, toggleSidebar, newChat, closePanels, refreshUsage }) {
  const $ = selector => document.querySelector(selector);
  const header = $('.topbar'), title = $('#threadHeadingButton');
  const toolsButton = $('#mobileToolsButton'), tools = $('#topActions');
  const usageButton = $('#mobileUsageButton'), usage = $('#mobileUsagePanel');
  const chatTab = $('#mobileChatTab'), previewTab = $('#mobilePreviewTab');
  const conversation = $('#conversation'), preview = $('#mobilePreviewHost');
  const browser = $('#browserPanel'), browserAnchor = document.createComment('browser-panel-home');
  browser.before(browserAnchor);
  let previewActive = false;

  const setToolsOpen = open => {
    header.classList.toggle('mobile-tools-open', open);
    toolsButton.setAttribute('aria-expanded', String(open));
    tools.inert = isMobile() && !open;
  };
  const setUsageOpen = open => {
    if (open) refreshUsage();
    usage.hidden = !open;
    usageButton.setAttribute('aria-expanded', String(open));
  };
  const setPreview = active => {
    previewActive = active;
    conversation.hidden = active;
    preview.hidden = !active;
    chatTab.setAttribute('aria-selected', String(!active));
    previewTab.setAttribute('aria-selected', String(active));
    chatTab.tabIndex = active ? -1 : 0;
    previewTab.tabIndex = active ? 0 : -1;
    if (active) {
      if (browser.parentElement !== preview) preview.append(browser);
      browser.hidden = false;
    }
  };
  const showChat = () => setPreview(false);
  const showPreview = () => {
    if (!isMobile()) return;
    setToolsOpen(false);
    setUsageOpen(false);
    closePanels();
    setPreview(true);
  };
  title.onclick = () => {
    if (!isMobile()) return;
    setToolsOpen(false);
    toggleSidebar();
  };
  $('#mobileNewTask').onclick = () => {
    setToolsOpen(false);
    showChat();
    closePanels();
    newChat();
  };
  toolsButton.onclick = () => {
    setUsageOpen(false);
    setToolsOpen(toolsButton.getAttribute('aria-expanded') !== 'true');
  };
  usageButton.onclick = () => setUsageOpen(usage.hidden);
  tools.addEventListener('click', event => {
    if (isMobile() && event.target.closest('button')) setToolsOpen(false);
  });
  chatTab.onclick = showChat;
  previewTab.onclick = showPreview;
  $('.mobile-view-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const active = event.key === 'Home' ? false : event.key === 'End' ? true : !previewActive;
    if (active) showPreview(); else showChat();
    (active ? previewTab : chatTab).focus();
  });
  document.addEventListener('click', event => {
    const path = event.composedPath();
    if (!path.includes(tools) && !path.includes(toolsButton)) setToolsOpen(false);
    if (!path.includes(usage) && !path.includes(usageButton)) setUsageOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!usage.hidden) { setUsageOpen(false); usageButton.focus(); }
    if (toolsButton.getAttribute('aria-expanded') === 'true') { setToolsOpen(false); toolsButton.focus(); }
  });
  const sync = () => {
    const mobile = isMobile();
    title.disabled = !mobile;
    if (mobile) {
      title.setAttribute('aria-controls', 'sidebar');
      title.setAttribute('aria-expanded', String($('#sidebar').classList.contains('mobile-open')));
    } else {
      title.removeAttribute('aria-controls');
      title.removeAttribute('aria-expanded');
      if (previewActive) showChat();
      if (browser.parentElement === preview) {
        browserAnchor.after(browser);
        browser.hidden = true;
      }
    }
    setToolsOpen(false);
    setUsageOpen(false);
  };
  // Keyboard viewport resize must not reset the currently selected view.
  let previousMobile = null;
  addEventListener('resize', () => {
    if (isMobile() !== previousMobile) { previousMobile = isMobile(); sync(); }
  });
  previousMobile = isMobile();
  sync();
  return { showChat, showPreview };
}

// Follow the visible viewport when a mobile keyboard resizes or pans the page.
export function initializeMobileViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (Math.abs(viewport.scale - 1) > .01) return;
      const root = document.documentElement;
      root.style.setProperty('--mobile-viewport-height', `${viewport.height}px`);
      root.style.setProperty('--mobile-viewport-top', `${viewport.offsetTop}px`);
      root.style.setProperty('--mobile-viewport-bottom', `${Math.max(0, innerHeight - viewport.height - viewport.offsetTop)}px`);
    });
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
}
