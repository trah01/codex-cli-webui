# codex-cli-webui

A personal browser workspace for Codex: project conversations, code changes, approvals, and interactive terminals, with desktop and mobile layouts.

[简体中文 · Default documentation](../../README.md) · [Documentation index](../README.md)

> [!CAUTION]
> **Do not expose this application directly to the public Internet. Direct public access remains dangerous even with passwords, OTP, or OIDC enabled.**
>
> The application can execute commands, read and modify files, open terminals, and use the Codex permissions and credentials available in its runtime environment. Authentication does not replace network isolation. Do not expose the service port through public port mappings, an ordinary reverse proxy, or a tunneling service. HTTPS does not replace access control and network isolation.
>
> For remote access, use a bastion security gateway as a reverse proxy and restrict the WebUI backend to connections from that gateway.
>
> **Disclaimer: The author does not recommend, encourage, or support using this project as a public Internet-facing service.** This project is provided "as is," without warranties of security or fitness for a particular purpose. Users assume the risks of deployment, access control, and use. If you expose this project to the Internet and your computer or server is compromised, credentials are leaked, data is lost, or other damage occurs as a result, the author and contributors accept no liability to the fullest extent permitted by applicable law.

Inspired by [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui), with extensive improvements built on that foundation.

## Features

- Project selection, conversation history, streaming responses, model and reasoning controls, and context usage.
- Tool activity, task status, and queued messages with cancellation and retry when another Codex client owns a conversation.
- Command, file-change, and permission approvals, with visible request and response states.
- Unified and side-by-side diffs, wrapping, expansion, and Git-backed undo/reapply within a configured repository.
- Interactive terminals, file browsing and previews, source-line navigation, website entry points, and subagent conversation controls.
- Markdown, tables, code blocks, formulas, image attachments, conversation records, and saved drafts.
- Chinese and English, light and dark themes, interface scaling, grouped settings, and automatic saving.
- Passwords, passkeys, authenticator codes (OTP), and single sign-on (OIDC) for access within a controlled environment.

The application connects to a real `codex app-server`. It prefers an existing local shared backend and otherwise starts a standalone backend. Available capabilities depend on your Codex version, account, and runtime environment.

## Recommended access

For local use, visit `http://127.0.0.1:8899`. For remote use, access the application through a bastion security gateway acting as a reverse proxy. The gateway must authenticate and authorize access; only the gateway should be able to connect to the WebUI backend.

Keep the WebUI listening on `127.0.0.1` when the gateway runs on the same server. For separate hosts, use an isolated internal network and firewall rules limiting the source. The proxy must support WebSocket connections and streaming responses. See [configuration](#configuration) for related settings.

## Requirements

- Node.js **24.22.1 or later within 24.x**, or **26.12.1 or later within 26.x**, and npm.
- [Codex CLI](https://www.npmjs.com/package/@openai/codex), installed and authenticated.
- Git for review undo/reapply.
- macOS or Linux recommended; Windows has not been fully verified.

If needed, install and authenticate Codex first:

```bash
npm install -g @openai/codex
codex
```

## Local start

Run from the project directory:

```bash
npm ci
npm start
```

Open **http://localhost:8899**. The default listener is `127.0.0.1:8899`.

Complete initial credential setup through the server's local browser, then select a project directory. Credential configuration requires direct access using `127.0.0.1` or `localhost`. IPv6 address literals, other IP addresses, domains, and forwarded requests cannot manage local credentials. Passkeys can only be managed locally after login through localhost. Remote HTTPS access supports sign-in with an existing credential for that domain; management is unavailable.

## Settings and authentication

Open settings from the sidebar to change appearance, language, models, reasoning, permissions, and global instructions. Switches and selections apply immediately; text saves automatically when editing finishes. Some Codex settings apply only to new conversations, as indicated in the interface.

Local security pages provide:

- **Credentials:** passwords must contain 12–256 characters. Changing credentials invalidates existing sessions. Local login is enabled by default.
- **Domain binding:** validates the hostname used by a controlled entry point. It does not configure DNS, certificates, or network restrictions, and does not authorize public exposure.
- **Passkeys:** open Settings → Security → Passkeys after signing in. Manage credentials through `http://localhost:8899` on the server. Remote HTTPS access only supports sign-in with existing credentials for that domain; localhost credentials cannot be used on a remote hostname. Enrollment and removal require identity verification within the last five minutes. Device fingerprint, face, PIN, or a security key replaces password and OTP entry for Passkey login. Existing password and OIDC methods remain available. Public keys are stored in `.passkeys.json` next to the authentication store; private keys stay with the authenticator. Removing a key signs out other sessions.
- **OTP:** authenticator-based codes for password login; enrollment requires a current code.
- **OIDC:** bind the controlled entry domain, register the displayed callback with your identity provider, and enter client settings. Restrict provider access to trusted people: this application has no separate user allowlist. Enforce OIDC MFA at the identity provider.

**All authorized users operate the same Codex instance and server environment. This application does not provide tenant isolation and must not be shared with untrusted users.**

## Configuration

Defaults are sufficient for local use. See [.env.example](../../.env.example) for the complete environment variable reference.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listener address; keep the default where possible |
| `PORT` | `8899` | Service port |
| `CODEX_WEBUI_CWD` | Application directory | Default working directory |
| `CODEX_WEBUI_REVIEW_ROOT` | Default working directory | Git root allowed for undo/reapply |
| `CODEX_HOME` | `~/.codex` | Codex configuration and state |
| `CODEX_WEBUI_APP_SERVER_MODE` | `auto` | `auto`, shared-only `shared`, or independent `standalone` backend |
| `CODEX_WEBUI_APP_SERVER_SOCKET` | Default Codex control socket | Override the shared backend socket |
| `CODEX_AUTH_PATH` | `$CODEX_HOME/auth.json` | Override the Codex authentication file |
| `CODEX_WEBUI_AUTH_STORE` | `$CODEX_HOME/codex-webui-auth.json` | Base path for WebUI credentials and related storage |
| `CODEX_WEBUI_PASSWORD` | Unset | Startup login password; takes precedence over the managed password |
| `CODEX_WEBUI_ACCESS_TOKEN` | Unset | Explicit Bearer credential in password mode; disabled with OTP or OIDC |
| `CODEX_WEBUI_NTFY_TOPIC` | Unset | Optional completion notification topic |
| `CODEX_WEBUI_NTFY_URL` | `https://ntfy.sh` | Optional notification service URL |

The example environment file is not loaded automatically. To use it, copy it, replace placeholders, and load it explicitly:

```bash
cp .env.example .env
node --env-file=.env --import tsx server/index.ts
```

Alternatively, inject environment variables through your service manager. Never commit environment files containing passwords, tokens, or client secrets.

## Data and permissions

Codex authentication and state default to `~/.codex`. WebUI credentials, access configuration, message queues, conversation records, and drafts are stored near its authentication store. Include related data when moving or backing up `CODEX_WEBUI_AUTH_STORE`.

Conversations and attachments may contain source code, commands, file paths, and business data. Protect them accordingly. Before enabling notifications, check who can access the notification topic and service.

Codex and terminals run with the service user's permissions. Prefer a dedicated unprivileged user with access only to required projects. Read approval requests carefully and use unrestricted access cautiously.

## Docker

See [Dockerfile](../../Dockerfile) and [docker-compose.yml](../../docker-compose.yml). Compose publishes the service to host loopback `127.0.0.1:8899` by default; preserve that boundary.

Prepare a Codex executable matching the Linux container architecture, configure `CODEX_BIN`, the review root and Codex state directory, and verify mount permissions. Only mounted projects are accessible inside the container; check host and container paths separately. A macOS Codex executable cannot be used in a Linux container.

Listening on `0.0.0.0` inside the container does not authorize public host-port exposure. Do not change `WEBUI_BIND_IP` to a public listener or mount the host Docker socket.

## Development

```bash
npm run dev        # Watch backend and frontend dependencies
npm run check      # Syntax checks
npm run test:unit  # Unit tests
```

The frontend entry is `public/app.js`; startup generates the browser bundle. Refresh the page after frontend changes. The backend entry is `server/index.ts`.

For a standalone build, run `npm run build`, then `node dist/server.js`. Browser, integration, and end-to-end test commands are listed in [package.json](../../package.json). Some require Chromium or an authenticated Codex installation.

## Notices and license

This is an unofficial tool, not affiliated with, endorsed by, or maintained by OpenAI. Codex interfaces may change between versions; verify key workflows after upgrading the CLI.

See [LICENSE](../../LICENSE) for source licensing, [Third-party notices](../legal/第三方声明.md) for third-party dependencies and visual assets, and [SECURITY.md](../../.github/SECURITY.md) for security reporting.
