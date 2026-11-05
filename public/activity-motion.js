const terminalStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'canceled']);

// Each activity owns at most one pending load and one player, including during teardown.
export function createActivityMotion({ animations = new Map(), loadData, createAnimation, hidden = () => false, onError = () => {} }) {
  const pending = new Map();
  const active = (row, holder) => holder.isConnected && row.classList.contains('active')
    && !terminalStatuses.has(row.closest('[data-turn-id]')?.dataset.timingStatus);
  function stop(row) {
    pending.get(row)?.abort(); pending.delete(row);
    animations.get(row)?.destroy(); animations.delete(row);
  }
  return {
    async mount(row, holder, name) {
      stop(row);
      if (!active(row, holder)) return;
      const controller = new AbortController(); pending.set(row, controller);
      try {
        const animationData = await loadData(name, controller.signal);
        if (pending.get(row) !== controller || controller.signal.aborted || !active(row, holder)) return;
        const animation = createAnimation(holder, animationData);
        animations.set(row, animation);
        if (hidden()) animation.pause();
      } catch (error) {
        if (pending.get(row) === controller && !controller.signal.aborted && active(row, holder)) onError(holder, error);
      } finally {
        if (pending.get(row) === controller) pending.delete(row);
      }
    },
    stop,
    clear(root) {
      for (const row of new Set([...pending.keys(), ...animations.keys()])) if (!root || root.contains(row)) stop(row);
    },
    updateVisibility() {
      for (const [row, animation] of animations) {
        const holder = row.querySelector('.activity-motion');
        if (!holder || !active(row, holder)) stop(row);
        else if (hidden()) animation.pause();
        else animation.play();
      }
    },
  };
}
