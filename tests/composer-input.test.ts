import { expect, test } from 'vitest';
import { buildTurnInput, IMAGE_MAX_BYTES, TURN_REQUEST_MAX_BYTES, validateImageInputs } from '../public/composer-input.js';

const url = 'data:image/png;base64,iVBORw0KGgo=';

test('sends mixed and image-only messages using the Codex image input protocol', () => {
  expect(buildTurnInput('See this', [{ url }])).toEqual([{ type: 'text', text: 'See this', text_elements: [] }, { type: 'image', url }]);
  expect(buildTurnInput('', [{ url }])).toEqual([{ type: 'image', url }]);
});

test('rejects unsupported content and enforces image count and byte limits on the server path', () => {
  for (const invalid of ['https://example.com/photo.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,!!!!', 'data:image/png;base64,abc']) {
    expect(() => validateImageInputs([{ type: 'image', url: invalid }])).toThrow();
  }
  expect(() => buildTurnInput('', Array.from({ length: 11 }, () => ({ url })))).toThrow('Attach up to');
  const large = `data:image/png;base64,${Buffer.alloc(IMAGE_MAX_BYTES).toString('base64')}`;
  expect(() => validateImageInputs([{ type: 'image', url: large }])).not.toThrow();
  expect(() => validateImageInputs(Array.from({ length: 3 }, () => ({ type: 'image', url: large })))).toThrow('Attach up to');
  expect(() => validateImageInputs([{ type: 'image', url: `data:image/png;base64,${Buffer.alloc(IMAGE_MAX_BYTES + 1).toString('base64')}` }])).toThrow('Each image');
  const payload = JSON.stringify({ method: 'turn/start', params: { input: [{ type: 'image', url: large }, { type: 'image', url: large }] } });
  expect(Buffer.byteLength(payload)).toBeLessThan(TURN_REQUEST_MAX_BYTES);
});
