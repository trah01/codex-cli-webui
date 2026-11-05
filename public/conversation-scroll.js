export function createConversationScroll({ root, button, requestFrame = requestAnimationFrame }) {
  let following = true, scheduled = false;
  const nearBottom = () => root.scrollHeight - root.scrollTop - root.clientHeight < 80;
  const update = () => { button.hidden = following || nearBottom(); };
  const pause = () => { following = false; update(); };
  root.addEventListener('wheel', event => { if (event.deltaY < 0) pause(); }, { passive: true });
  let touchY;
  root.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY; }, { passive: true });
  root.addEventListener('touchmove', event => {
    const next = event.touches[0]?.clientY;
    if (next > touchY) pause(); touchY = next;
  }, { passive: true });
  root.addEventListener('keydown', event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pause(); });
  root.addEventListener('scroll', () => { following = nearBottom(); update(); }, { passive: true });
  function bottom(force = false) {
    if (force) following = true;
    update();
    if (!following || scheduled) return;
    scheduled = true;
    requestFrame(() => {
      scheduled = false;
      // Recheck intent: a wheel/touch gesture may arrive after scheduling.
      if (following) root.scrollTop = root.scrollHeight;
      update();
    });
  }
  button.addEventListener('click', () => bottom(true));
  return { bottom, following: () => following, update };
}
