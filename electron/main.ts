import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Accounts } from './auth';
import { consumeResponse, ServiceError } from './protocol';
import type { Ask, Model, StreamEvent } from '../shared/types';

app.setName('Local Chat');
let window: BrowserWindow | undefined;
let request: AbortController | undefined;
let currentModels: Model[] = [];
const accounts = new Accounts();
const entry = path.join(__dirname, '../dist/index.html');
const entryURL = pathToFileURL(entry).href;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    await accounts.init();
    window = new BrowserWindow({ width: 1120, height: 820, minWidth: 760, minHeight: 620, backgroundColor: '#f7f9fc', title: 'Local Chat', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== entryURL) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    window.on('closed', () => { request?.abort(); accounts.cancelLogin(); window = undefined; });

    const handle = (channel: string, callback: (...args: any[]) => unknown) => {
      ipcMain.handle(channel, async (event, ...args) => {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== entryURL) throw new Error('Untrusted app request.');
        try { return await callback(...args); }
        catch (error) {
          const message = error instanceof Error ? error.message : 'The operation could not finish.';
          const details = error instanceof ServiceError ? [error.code, error.requestId && `Request: ${error.requestId}`].filter(Boolean).join(' / ') : '';
          throw new Error(`${message}${details ? ` (${details})` : ''}`);
        }
      });
    };
    const idle = () => { if (request) throw new Error('Stop the current answer before changing accounts.'); };
    handle('session', () => accounts.session());
    handle('login', async (id?: unknown, requestConsent?: unknown) => { idle(); if (id !== undefined && typeof id !== 'string') throw new Error('Invalid account.'); if (requestConsent !== undefined && typeof requestConsent !== 'boolean') throw new Error('Invalid sign-in request.'); const session = await accounts.login(id, requestConsent); currentModels = []; return session; });
    handle('cancel-login', () => accounts.cancelLogin());
    handle('select', async (id: unknown) => { idle(); if (typeof id !== 'string') throw new Error('Invalid account.'); currentModels = []; return accounts.select(id); });
    handle('logout', () => { idle(); currentModels = []; return accounts.logout(); });
    handle('welcome', () => accounts.acknowledgeWelcome());
    handle('usage', () => shell.openExternal('https://chatgpt.com/settings/usage'));
    handle('models', async () => {
      const response = await accounts.api('/models');
      const body = await response.json() as { models?: { slug: string; display_name: string; visibility: string }[] };
      if (!Array.isArray(body.models)) throw new Error('OpenAI did not return a ChatGPT model catalog.');
      currentModels = body.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string' && typeof m.display_name === 'string').map(({ slug, display_name }) => ({ slug, display_name }));
      return currentModels;
    });
    handle('cancel', () => request?.abort());
    handle('ask', async (payload: Ask) => {
      if (request) throw new Error('An answer is already in progress.');
      if (!payload || typeof payload.id !== 'string' || payload.id.length > 100 || !currentModels.some(m => m.slug === payload.model)) throw new Error('Select an available model first.');
      if (!Array.isArray(payload.messages) || !payload.messages.length || payload.messages.length > 100 || payload.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) || payload.messages.reduce((n, m) => n + m.content.length, 0) > 120_000) throw new Error('This chat is too long or contains an empty message. Start a new chat.');
      const controller = new AbortController();
      request = controller;
      const timer = setTimeout(() => controller.abort(new Error('The answer timed out. Please try again.')), 180_000);
      const send = (event: StreamEvent) => { if (window && !window.isDestroyed()) window.webContents.send('stream', event); };
      try {
        const response = await accounts.api('/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ model: payload.model, input: payload.messages, instructions: 'You are a helpful assistant. Answer the user clearly and accurately.', store: false, stream: true }) });
        if (!response.body) throw new Error('OpenAI returned no answer stream.');
        await consumeResponse(response.body, text => send({ id: payload.id, type: 'delta', text }));
        send({ id: payload.id, type: 'completed' });
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason?.name === 'AbortError') send({ id: payload.id, type: 'cancelled' });
        else send({ id: payload.id, type: 'error', message: controller.signal.aborted ? 'The answer timed out. Please try again.' : error instanceof Error ? error.message : 'The answer could not finish.' });
      } finally { clearTimeout(timer); request = undefined; }
    });
    await window.loadFile(entry);
  }).catch(error => { dialog.showErrorBox('Local Chat could not start', error instanceof Error ? error.message : 'Unknown startup error.'); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
