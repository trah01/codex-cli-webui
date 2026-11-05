const encode = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));

export function supportsPasskeys() {
  return Boolean(globalThis.isSecureContext && globalThis.PublicKeyCredential && navigator.credentials?.create && navigator.credentials?.get);
}

export async function passkeyRequest(path, body, method = 'POST') {
  const response = await fetch(path, { method, cache: 'no-store', credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Passkey verification failed. Try again.');
  return data;
}

export function passkeyError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return 'Passkey verification was cancelled or timed out. Try again.';
  if (error?.name === 'InvalidStateError') return 'This device already has a passkey for this address.';
  if (error?.name === 'SecurityError') return 'Use HTTPS for remote passkeys, or localhost on this computer.';
  return error?.message || 'Passkey verification failed. Try again.';
}

export async function usePasskey(action, name) {
  if (!supportsPasskeys()) throw new Error('Use HTTPS for remote passkeys, or localhost on this computer.');
  const registration = action === 'register';
  const options = await passkeyRequest(`/api/auth/passkeys/${action}/options`, name === undefined ? {} : { name });
  options.challenge = decode(options.challenge);
  if (registration) {
    options.user.id = decode(options.user.id);
    options.excludeCredentials = options.excludeCredentials?.map(item => ({ ...item, id: decode(item.id) }));
  } else options.allowCredentials = options.allowCredentials?.map(item => ({ ...item, id: decode(item.id) }));
  const credential = registration ? await navigator.credentials.create({ publicKey: options }) : await navigator.credentials.get({ publicKey: options });
  if (!credential) throw new Error('Passkey verification was cancelled or timed out. Try again.');
  const response = credential.response;
  const payload = { id: credential.id, rawId: encode(credential.rawId), type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment,
    response: { clientDataJSON: encode(response.clientDataJSON), ...(registration
      ? { attestationObject: encode(response.attestationObject), transports: response.getTransports?.() || [] }
      : { authenticatorData: encode(response.authenticatorData), signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null }) } };
  return passkeyRequest(`/api/auth/passkeys/${action}/verify`, payload);
}
