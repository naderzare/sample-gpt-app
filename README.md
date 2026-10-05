# Local Chat for Windows

A small Electron + React + TypeScript application. Sign in using your ChatGPT account, choose an available model, and ask questions using eligible ChatGPT plan usage. No OpenAI API key, developer client secret, Codex installation, or hosted backend is required.

## Requirements

- Windows 10 or newer (64-bit), internet access, and a browser for sign-in.
- An eligible ChatGPT Plus or Pro account and permission to use its plan. Workspace policies and service availability may restrict access.
- For development only: Node.js 22.12+ and npm.

## Run

```powershell
cd D:\workspace\gpt\sample_app
npm install
npm start
```

Click **Continue with ChatGPT**, complete sign-in in your system browser, select a workspace if asked, and approve ChatGPT plan usage. Return to Local Chat, choose a model, type a question, and press Enter or click Send. Shift + Enter inserts a line break. Stop cancels an answer. New chat clears the window’s conversation.

The first successful authorization explains plan usage. **Manage usage** opens ChatGPT Settings → Usage to review access, app limits, and any credits permission. If sign-in succeeds without plan permission, **Enable ChatGPT plan usage** explicitly requests consent again. The app does not invent a remaining-token balance or reset time. Usage follows the allowance of your ChatGPT plan and authorized credits; this is distinct from OpenAI API billing.

Saved registrations appear in the account selector. Use **Add another account or workspace** for a separate registration. **Continue with ChatGPT** reconnects the selected registration. **Sign out** attempts remote session revocation and removes its local credentials, retaining the client/account mapping for later sign-in. If remote revocation cannot be confirmed, the UI directs you to disconnect the app in ChatGPT settings.

## Standalone Windows executable

```powershell
npm run package:win
```

Output: `release\Local-Chat-0.1.0-Windows.exe`. This portable executable includes Electron and Node.js. End users do not need Node, npm, or a running development server. Internet is still required to sign in and get answers. The file is unsigned; public distribution should add Windows code signing.

An optional installer can be built with `npm run installer:win`.

## Checks

```powershell
npm test
npm run build
npm run smoke
```

The smoke check opens the actual Electron app with a separate temporary Windows user-data directory. It verifies the disconnected UI, isolation settings, blocked renderer network access, account-state bridge, and question composer, and saves a screenshot under `work`. It never signs into an account or consumes plan usage. Protocol tests verify PKCE, callback checks, streamed Unicode, late usage errors, and incomplete-stream handling.

Real authorization and completed inference must be checked with your own eligible account. A connected badge and model catalog alone do not verify that a request can use your plan; a completed answer does.

## Architecture and security

- `src/`: React interface, rendered in a sandbox without Node integration. Access and refresh tokens never go to the UI.
- `electron/preload.ts`: a narrow, typed IPC bridge.
- `electron/auth.ts`: dynamic OAuth registration, browser sign-in, ephemeral loopback callback, PKCE, state/nonce checks, signature/issuer/audience/expiry validation with `jose`, account storage, serialized refresh, and logout/revocation.
- `electron/main.ts`: window lifecycle, validated IPC, account-specific model discovery, Responses streaming, cancellation, and timeout.
- `electron/protocol.ts`: callback and SSE handling with explicit completion checks.
- `shared/types.ts`: UI/main-process message contracts.

The stable installation host ID and separate account registrations are stored in `%APPDATA%\Local Chat\accounts.enc`. Electron `safeStorage` uses Windows DPAPI to encrypt them for the current Windows user. Writes are atomic. A single-instance lock prevents separate app processes racing rotating refresh tokens. Tokens are never written to source files, browser storage, or logs. Someone running as the same Windows user may still access that user’s secrets; encryption is not protection against a compromised Windows account.

Chat messages stay in memory and clear when the app closes or accounts change. The app sends the current conversation to OpenAI to generate replies. Every request uses the public `https://api.openai.com/v1/responses` endpoint with `store: false`, `stream: true`, and explicit message history. There is no local conversation archive, background processing, tool execution, or API-key billing fallback. Stopped/failed assistant text stays visible but is excluded from subsequent request history.

The loopback listener binds only `127.0.0.1` on an available port and closes when sign-in completes, fails, is cancelled, or times out. No fixed partner client ID or private ChatGPT endpoint is used. Models come from the signed-in account’s current catalog, without a hard-coded model choice.

## Official integration documentation

- [Local-app overview and availability](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts, refresh, and sign-out](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)

This sample is a local personal app. Offering the integration through a paid or remotely hosted app requires the applicable OpenAI access process; do not assume this local registration flow grants commercial hosted access.
