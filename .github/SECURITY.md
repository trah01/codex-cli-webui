# Security Policy

## Supported version

Security fixes are applied to the latest version on the `main` branch.

## Reporting a vulnerability

Do not publish exploitable details in a public issue. Use GitHub's private vulnerability reporting feature for this repository and include the affected version, reproduction steps, impact, and suggested mitigation if known.

## Security model

codex-cli-webui runs commands and edits files through the local Codex app-server. Treat it as a local developer tool, not as a hardened multi-tenant service.

- Do not expose the WebUI directly to the public Internet, even with authentication or HTTPS. For remote access, use a bastion security gateway as a reverse proxy and restrict backend connections to that gateway. See the [deployment guide](../docs/guides/部署与访问.md).
- The default listener is `127.0.0.1`. All execution APIs, terminal connections, event streams and WebSocket bridges require login, including loopback. Initial credential setup is restricted to direct 127.0.0.1 or localhost access; subsequent credential/domain changes also require an authenticated session.
- Managed passwords use salted `scrypt`. Optional TOTP protects remote password login. Direct 127.0.0.1 access uses password-only login by default; local login can be disabled in local settings without bypassing remote authentication. OIDC uses PKCE, state, nonce and signed ID Token validation. Any user authenticated by the configured provider can access the same Codex instance; manage login eligibility and MFA at the identity provider.
- Sessions are random, stored server-side, expire after eight hours, and are revoked on logout, credential rotation or restart. Cookies are HttpOnly and SameSite=Strict; an HTTPS public origin or OIDC enables Secure cookies. Configure TLS and restrict the backend network.
- Explicit Bearer machine credentials are available only in password mode without OTP. Basic authentication and passwords cannot directly authorize API requests. Login attempts are rate limited by TCP peer and globally.
- Browser WebSocket RPC is allowlisted and cannot invoke app-server filesystem, configuration, or account methods.
- Static files are allowlisted, canonicalized, and symbolic links are never served.
- Folder browsing canonicalizes paths and rejects symbolic links that escape the user's home directory.
- Review Undo/Reapply accepts only server-owned app-server diff notifications. Client-supplied `cwd` and diff data, symbolic-link patches, `.git`, `.env`, and `node_modules` targets are rejected.
- Review approval prompts before allowing commands or file changes.
- Secrets must never be committed, included in screenshots, or pasted into Issues.

Passkeys use WebAuthn with required device user verification, one-use browser-bound challenges, exact origin and RP ID checks, and signature-counter updates. Registration and removal require a recently verified browser session. Local passkeys use localhost; remote passkeys require HTTPS and are scoped to the configured domain. Private keys are never stored on the server.
