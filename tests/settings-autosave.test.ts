import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { bindSettingsAutosave } from '../public/settings-autosave.js';

function setup(markup = '<input value="initial" required>') {
  const dom = new JSDOM(`<form>${markup}<p role="status"></p></form>`);
  const form = dom.window.document.querySelector('form')!;
  const input = form.querySelector('input')!;
  const feedback = form.querySelector('p')!;
  return { dom, form, input, feedback };
}

afterEach(() => vi.useRealTimers());

describe('settings autosave', () => {
  it('does not save untouched settings or values loaded from the server', async () => {
    const { form, input, feedback } = setup();
    const save = vi.fn();
    const editor = bindSettingsAutosave(form, { save, feedback });
    await editor.flush();
    input.value = 'loaded'; editor.reset(); await editor.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('saves text when leaving the form, while allowing movement between fields', async () => {
    const { dom, form, input, feedback } = setup('<input value="initial"><input>');
    const save = vi.fn(async () => { feedback.textContent = 'Saved'; });
    const editor = bindSettingsAutosave(form, { save, feedback });
    input.value = 'changed';
    input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true, relatedTarget: form.querySelectorAll('input')[1] }));
    expect(save).not.toHaveBeenCalled();
    input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
    await editor.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(feedback.dataset.state).toBe('saved');
  });

  it('blocks invalid and incomplete security settings', async () => {
    const { form, input, feedback } = setup();
    const save = vi.fn(); let complete = false;
    const editor = bindSettingsAutosave(form, { save, feedback, ready: () => complete });
    input.value = ''; await editor.flush();
    input.value = 'changed'; await editor.flush();
    expect(save).not.toHaveBeenCalled();
    complete = true; await editor.flush();
    expect(save).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight write and prevents duplicate submissions', async () => {
    const { form, input, feedback } = setup();
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const editor = bindSettingsAutosave(form, { save, feedback });
    input.value = 'changed'; const first = editor.flush(); const second = editor.flush();
    expect(first).toBe(second);
    expect(input.readOnly).toBe(true);
    finish(); await second;
    expect(input.readOnly).toBe(false);
    await editor.flush(); expect(save).toHaveBeenCalledOnce();
  });

  it('retains failed edits and permits retry', async () => {
    const { form, input, feedback } = setup();
    const save = vi.fn().mockRejectedValueOnce(new Error('Write failed')).mockResolvedValueOnce(undefined);
    const editor = bindSettingsAutosave(form, { save, feedback });
    input.value = 'changed'; await editor.flush();
    expect(input.value).toBe('changed'); expect(input.readOnly).toBe(false);
    expect(feedback.textContent).toBe('Write failed'); expect(feedback.dataset.state).toBe('error');
    await editor.flush(); expect(save).toHaveBeenCalledTimes(2);
  });

  it('debounces instruction edits and flushes them before navigation', async () => {
    vi.useFakeTimers();
    const { dom, form, input, feedback } = setup();
    const save = vi.fn();
    const editor = bindSettingsAutosave(form, { save, feedback, delay: 800 });
    input.value = 'first'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(500);
    input.value = 'final'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(500); expect(save).not.toHaveBeenCalled();
    await editor.flush(); await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledOnce();
  });
});
