export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGES_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGES_MAX_COUNT = 10;
export const TURN_REQUEST_MAX_BYTES = Math.ceil(IMAGES_MAX_BYTES / 3) * 4 + 1024 * 1024;
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function validateImageInputs(input = []) {
  let count = 0, bytes = 0;
  for (const part of input) {
    if (part?.type !== 'image') continue;
    const match = typeof part.url === 'string' && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.url);
    if (!match || match[2].length % 4 !== 0) throw new Error('Use PNG, JPEG, WebP or GIF images');
    const size = match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
    if (size > IMAGE_MAX_BYTES) throw new Error('Each image must be 10 MB or smaller');
    bytes += size; count++;
  }
  if (bytes > IMAGES_MAX_BYTES || count > IMAGES_MAX_COUNT) throw new Error('Attach up to 10 images, 20 MB in total');
}

export function buildTurnInput(text, images = []) {
  const input = [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map(image => ({ type: 'image', url: image.url }))];
  validateImageInputs(input);
  return input;
}

export async function readImageFiles(files, existing = []) {
  const incoming = Array.from(files);
  if (incoming.some(file => !IMAGE_MIME_TYPES.includes(file.type))) throw new Error('Use PNG, JPEG, WebP or GIF images');
  if (incoming.some(file => !file.size || file.size > IMAGE_MAX_BYTES)) throw new Error('Each image must be 10 MB or smaller');
  if (incoming.length + existing.length > IMAGES_MAX_COUNT || incoming.reduce((total, file) => total + file.size, 0) + existing.reduce((total, image) => total + image.size, 0) > IMAGES_MAX_BYTES) throw new Error('Attach up to 10 images, 20 MB in total');
  return Promise.all(incoming.map(file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read image'));
    reader.onabort = reader.onerror;
    reader.onload = () => resolve({ id: crypto.randomUUID(), name: file.name || 'Image', size: file.size, url: reader.result });
    reader.readAsDataURL(file);
  })));
}
