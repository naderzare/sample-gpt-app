import { app, safeStorage, shell } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Session } from '../shared/types';
import { ISSUER, RESOURCE, SCOPES, oauthSecrets, serviceError, validateCallback } from './protocol';

interface Tokens { access_token: string; refresh_token?: string; id_token: string; scope: string; expires_at: number }
interface Profile { id: string; email: string; subject: string; label: string; tokens?: Tokens; welcomeSeen?: boolean }
interface Database { version: 1; hostId: string; profiles: Profile[]; activeId?: string; pendingClientId?: string }
interface TokenResponse { access_token: string; refresh_token?: string; id_token?: string; scope?: string; expires_in: number; token_type: string }
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export class Accounts {
  private db!: Database;
  private file = path.join(app.getPath('userData'), 'accounts.enc');
  private refreshing?: Promise<string>;
  private saving: Promise<void> = Promise.resolve();
  private loginBusy = false;
  private cancelPending?: () => void;

  async init() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable. The app cannot save sign-in securely.');
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const bytes = await readFile(this.file);
      this.db = JSON.parse(safeStorage.decryptString(bytes));
      if (this.db.version !== 1 || !Array.isArray(this.db.profiles) || !this.db.hostId) throw new Error('Unsupported account storage.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved accounts could not be read. Restore your Windows user profile or remove accounts.enc from the app data folder to reset this app.');
      this.db = { version: 1, hostId: `urn:uuid:${randomUUID()}`, profiles: [] };
      await this.save();
    }
  }

  private save() {
    const encrypted = safeStorage.encryptString(JSON.stringify(this.db));
    const next = this.saving.catch(() => {}).then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, encrypted);
      await rename(temporary, this.file);
    });
    this.saving = next;
    return next;
  }

  session(): Session {
    const active = this.db.profiles.find(p => p.id === this.db.activeId);
    return {
      accounts: this.db.profiles.map(p => ({ id: p.id, label: p.label, email: p.email, connected: !!p.tokens, sharing: !!p.tokens?.scope.split(' ').includes('chatgpt.tokens.use.direct') })),
      activeId: this.db.activeId,
      welcome: !!active?.tokens?.scope.split(' ').includes('chatgpt.tokens.use.direct') && !active.welcomeSeen
    };
  }

  async acknowledgeWelcome() {
    const profile = this.db.profiles.find(p => p.id === this.db.activeId);
    if (profile) { profile.welcomeSeen = true; await this.save(); }
  }

  async select(id: string) {
    if (this.loginBusy || this.refreshing) throw new Error('Wait for the current sign-in operation to finish.');
    if (!this.db.profiles.some(p => p.id === id)) throw new Error('Account not found.');
    this.db.activeId = id;
    await this.save();
    return this.session();
  }

  cancelLogin() { this.cancelPending?.(); }

  async login(accountId?: string, requestConsent = false): Promise<Session> {
    if (this.loginBusy || this.refreshing) throw new Error('A sign-in operation is already in progress.');
    const existing = accountId ? this.db.profiles.find(p => p.id === accountId) : undefined;
    if (accountId && !existing) throw new Error('Account not found.');
    this.loginBusy = true;
    const secrets = oauthSecrets();
    const requestedId = existing?.id ?? this.db.pendingClientId;
    try {
      return await new Promise<Session>((resolve, reject) => {
        let consumed = false;
        let timer: NodeJS.Timeout;
        const server = createServer((req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
          if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end('Not found.'); return; }
          // Ignore forged callbacks without consuming the valid authorization attempt.
          if (url.searchParams.get('state') !== secrets.state) { res.writeHead(400).end('Invalid sign-in state. Return to Local Chat to continue.'); return; }
          if (consumed) { res.writeHead(409).end('This sign-in has already been handled.'); return; }
          consumed = true;
          void (async () => {
            try {
              const { clientId, code } = validateCallback(url, secrets.state, requestedId);
              if (!existing) { this.db.pendingClientId = clientId; await this.save(); }
              const response = await this.tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: secrets.verifier, redirect_uri: callback, resource: RESOURCE });
              if (!response.id_token) throw new Error('OpenAI did not return a verified identity token.');
              const { payload } = await jwtVerify(response.id_token, jwks, { issuer: ISSUER, audience: clientId, requiredClaims: ['exp', 'sub', 'nonce'] });
              if (payload.nonce !== secrets.nonce || !payload.sub) throw new Error('OpenAI identity validation failed. Please sign in again.');
              if (existing && existing.subject !== payload.sub) throw new Error('A different account was returned. Add it as a separate account instead.');
              const profile: Profile = {
                id: clientId,
                subject: payload.sub,
                email: typeof payload.email === 'string' ? payload.email : 'ChatGPT account',
                label: existing?.label ?? `Connection ${this.db.profiles.length + 1}`,
                welcomeSeen: existing?.welcomeSeen,
                tokens: this.tokens(response)
              };
              const index = this.db.profiles.findIndex(p => p.id === clientId);
              if (index >= 0 && this.db.profiles[index].subject !== profile.subject) throw new Error('The registration belongs to a different account.');
              if (index >= 0) this.db.profiles[index] = profile; else this.db.profiles.push(profile);
              this.db.activeId = clientId;
              this.db.pendingClientId = undefined;
              await this.save();
              res.end('<!doctype html><title>Connected</title><body style="font-family:system-ui;padding:48px"><h1>You’re connected.</h1><p>Return to Local Chat. You can close this tab.</p></body>');
              finish(); resolve(this.session());
            } catch (error) {
              res.writeHead(400).end('<!doctype html><title>Sign-in incomplete</title><body style="font-family:system-ui;padding:48px"><h1>Sign-in could not finish.</h1><p>Return to Local Chat for details. You can close this tab.</p></body>');
              finish(); reject(error);
            }
          })();
        });
        let callback = '';
        const finish = () => { clearTimeout(timer); this.cancelPending = undefined; server.close(); };
        this.cancelPending = () => {
          if (consumed) return;
          consumed = true; finish(); reject(new Error('Sign-in cancelled.'));
        };
        server.once('error', () => { finish(); reject(new Error('Could not open the local sign-in callback. Please try again.')); });
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') { finish(); reject(new Error('No sign-in callback port was available.')); return; }
          callback = `http://127.0.0.1:${address.port}/auth/callback`;
          const authorize = new URL(`${ISSUER}/api/accounts/authorize`);
          authorize.search = new URLSearchParams({
            client_id: requestedId ?? 'dynamic_agent_client', ext_agent_host_id: this.db.hostId,
            response_type: 'code', redirect_uri: callback, scope: SCOPES, resource: RESOURCE,
            state: secrets.state, nonce: secrets.nonce, code_challenge_method: 'S256', code_challenge: secrets.challenge,
            ...(!requestedId ? { agent_name_hint: 'Local Chat' } : {}),
            ...(requestConsent ? { prompt: 'consent' } : {}),
            ...(existing?.tokens?.id_token ? { id_token_hint: existing.tokens.id_token, login_hint: existing.email } : {})
          }).toString();
          timer = setTimeout(() => this.cancelPending?.(), 180_000);
          void shell.openExternal(authorize.toString()).catch(() => this.cancelPending?.());
        });
      });
    } finally { this.loginBusy = false; this.cancelPending = undefined; }
  }

  private tokens(response: TokenResponse, old?: Tokens): Tokens {
    if (!response.access_token || response.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(response.expires_in) || response.expires_in <= 0) throw new Error('OpenAI returned an invalid token response.');
    return { access_token: response.access_token, refresh_token: response.refresh_token ?? old?.refresh_token, id_token: response.id_token ?? old?.id_token ?? '', scope: response.scope ?? old?.scope ?? '', expires_at: Date.now() + response.expires_in * 1000 };
  }

  private async tokenRequest(fields: Record<string, string>): Promise<TokenResponse> {
    const result = await fetch(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), signal: AbortSignal.timeout(30_000) });
    const body = await result.json().catch(() => ({}));
    if (!result.ok) {
      if (body.error === 'invalid_grant') throw new Error('Your sign-in has expired or was revoked. Continue with ChatGPT to reconnect.');
      throw new Error(`OpenAI sign-in failed (${result.status}). Please try again.`);
    }
    return body as TokenResponse;
  }

  async accessToken(): Promise<string> {
    const profile = this.db.profiles.find(p => p.id === this.db.activeId);
    if (!profile?.tokens) throw new Error('Continue with ChatGPT to connect your account.');
    if (!profile.tokens.scope.split(' ').includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan usage is disabled. Open Manage usage to review access, then reconnect.');
    if (profile.tokens.expires_at > Date.now() + 60_000) return profile.tokens.access_token;
    if (!profile.tokens.refresh_token) throw new Error('Your sign-in has expired. Continue with ChatGPT to reconnect.');
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const response = await this.tokenRequest({ grant_type: 'refresh_token', client_id: profile.id, refresh_token: profile.tokens!.refresh_token!, resource: RESOURCE });
        if (response.id_token) {
          const { payload } = await jwtVerify(response.id_token, jwks, { issuer: ISSUER, audience: profile.id, requiredClaims: ['sub', 'exp'] });
          if (payload.sub !== profile.subject) throw new Error('Refreshed identity does not match the saved account.');
        }
        profile.tokens = this.tokens(response, profile.tokens);
        await this.save();
        if (!profile.tokens.scope.split(' ').includes('chatgpt.tokens.use.direct')) throw new Error('Permission to use your ChatGPT plan was removed. Reconnect to review access.');
        return profile.tokens.access_token;
      })().finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }

  async logout(): Promise<{ session: Session; warning?: string }> {
    if (this.loginBusy || this.refreshing) throw new Error('Wait for sign-in to finish before signing out.');
    const profile = this.db.profiles.find(p => p.id === this.db.activeId);
    let warning: string | undefined;
    if (profile?.tokens?.refresh_token) {
      try {
        const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
        if (!discovery.ok) throw new Error('Discovery unavailable.');
        const { revocation_endpoint: endpoint } = await discovery.json() as { revocation_endpoint?: string };
        if (!endpoint || new URL(endpoint).origin !== ISSUER) throw new Error('Revocation unavailable.');
        let confirmed = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: profile.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: profile.id }), signal: AbortSignal.timeout(10_000) });
            if (response.status === 200) { confirmed = true; break; }
            if (response.status < 500) break;
          } catch { /* Retry once while the refresh token is still available. */ }
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!confirmed) throw new Error('Revocation unconfirmed.');
      } catch { warning = 'Signed out on this device. Remote revocation was not confirmed; disconnect Local Chat in ChatGPT Settings → Usage.'; }
    }
    if (profile) profile.tokens = undefined;
    await this.save();
    return { session: this.session(), warning };
  }

  async api(pathname: '/models' | '/responses', options: RequestInit = {}) {
    const token = await this.accessToken();
    const response = await fetch(`${RESOURCE}${pathname}`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` }, signal: options.signal ?? AbortSignal.timeout(30_000) });
    if (!response.ok) {
      const error = serviceError(await response.json().catch(() => ({})), response.status, response.headers.get('x-request-id') ?? undefined);
      if (response.status === 401) error.message = 'Your connection was not accepted. Continue with ChatGPT to reconnect.';
      throw error;
    }
    return response;
  }
}
