export function bindImageViewerControls(dialog) {
  const stage = dialog.querySelector('.image-viewer-stage');
  const image = stage.querySelector('img');
  let scale = 1, x = 0, y = 0, drag = null;
  const available = () => dialog.open && !image.hidden && image.naturalWidth > 0;

  function render() {
    // Keep part of the image reachable even after a long drag.
    const maxX = Math.max(0, (image.offsetWidth * scale + stage.clientWidth) / 2 - 48);
    const maxY = Math.max(0, (image.offsetHeight * scale + stage.clientHeight) / 2 - 48);
    x = Math.max(-maxX, Math.min(maxX, x));
    y = Math.max(-maxY, Math.min(maxY, y));
    image.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
  }
  function stopDrag() {
    const pointerId = drag?.id;
    drag = null;
    stage.classList.remove('dragging');
    if (pointerId !== undefined && stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
  }
  function reset() { stopDrag(); scale = 1; x = 0; y = 0; render(); }
  function zoom(factor, anchorX = 0, anchorY = 0) {
    const next = Math.max(0.1, Math.min(16, scale * factor)), ratio = next / scale;
    x = anchorX - (anchorX - x) * ratio;
    y = anchorY - (anchorY - y) * ratio;
    scale = next;
    render();
  }

  stage.addEventListener('wheel', event => {
    if (!available()) return;
    event.preventDefault();
    const bounds = stage.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
    zoom(Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002), event.clientX - bounds.left - bounds.width / 2, event.clientY - bounds.top - bounds.height / 2);
  }, { passive: false });
  stage.addEventListener('pointerdown', event => {
    if (!available() || event.button !== 0 || drag) return;
    event.preventDefault();
    stage.focus({ preventScroll: true });
    drag = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, x, y };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    x = drag.x + event.clientX - drag.clientX;
    y = drag.y + event.clientY - drag.clientY;
    render();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(type, stopDrag);
  stage.addEventListener('dblclick', event => {
    if (!available()) return;
    event.preventDefault();
    if (scale !== 1) reset(); else zoom(2);
  });
  dialog.addEventListener('keydown', event => {
    if (!available() || event.altKey || event.metaKey || event.ctrlKey || event.target.closest('a,input,textarea,select')) return;
    const step = event.shiftKey ? 96 : 32;
    if (event.key === '+' || event.key === '=') zoom(1.2);
    else if (event.key === '-' || event.key === '_') zoom(1 / 1.2);
    else if (event.key === '0') reset();
    else if (event.key === 'ArrowLeft') { x -= step; render(); }
    else if (event.key === 'ArrowRight') { x += step; render(); }
    else if (event.key === 'ArrowUp') { y -= step; render(); }
    else if (event.key === 'ArrowDown') { y += step; render(); }
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  image.addEventListener('dragstart', event => event.preventDefault());
  image.addEventListener('load', reset);
  dialog.addEventListener('close', reset);
  new ResizeObserver(() => { if (available()) render(); }).observe(stage);
  return { reset };
}
