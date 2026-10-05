import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const userData = await mkdtemp(path.join(os.tmpdir(), 'local-chat-smoke-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.LOCAL_CHAT_TEST_EXE || electronPath;
const packaged = !!process.env.LOCAL_CHAT_TEST_EXE;
const application = await electron.launch({ executablePath, args: [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`], cwd: process.cwd(), env });
try {
  const page = await application.firstWindow();
  await page.getByRole('heading', { name: 'What’s on your mind?' }).waitFor();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: 'Send', exact: false }).isDisabled(), true);
  const state = await page.evaluate(async () => ({ account: await window.desktop.session(), hasNode: typeof window.require !== 'undefined', blocked: await fetch('https://api.openai.com/v1/models').then(() => false, () => true) }));
  assert.deepEqual(state.account.accounts, []);
  assert.equal(state.hasNode, false); assert.equal(state.blocked, true);
  const preferences = await application.evaluate(({ BrowserWindow, app }) => ({ preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(), userData: app.getPath('userData') }));
  assert.equal(preferences.preferences.contextIsolation, true); assert.equal(preferences.preferences.sandbox, true); assert.equal(preferences.preferences.nodeIntegration, false);
  const credentialFile = await readFile(path.join(preferences.userData, 'accounts.enc'));
  assert.equal(credentialFile.includes(Buffer.from('hostId')), false);
  await page.getByRole('button', { name: 'Explain something simply' }).click();
  assert.match(await page.getByRole('textbox', { name: 'Your question' }).inputValue(), /computer/);
  assert.equal(await page.getByRole('button', { name: 'Send', exact: false }).isDisabled(), true);
  await mkdir('work', { recursive: true });
  await page.getByRole('textbox', { name: 'Your question' }).fill('');
  await page.screenshot({ path: 'work/desktop-preview.png' });

  // Replace IPC only inside this isolated test process. Never use real accounts or requests.
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    const profile = { id: 'test-account', label: 'Connection 1', email: 'sample@example.com', connected: true, sharing: true };
    let welcome = true;
    let pending;
    const session = () => ({ accounts: [profile], activeId: profile.id, welcome });
    for (const name of ['login', 'session', 'welcome', 'models', 'ask', 'cancel']) ipcMain.removeHandler(name);
    ipcMain.handle('session', session);
    ipcMain.handle('login', session);
    ipcMain.handle('welcome', () => { welcome = false; });
    ipcMain.handle('models', () => [{ slug: 'test-model', display_name: 'Sample model' }]);
    ipcMain.handle('ask', async (_event, payload) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.send('stream', { id: payload.id, type: 'delta', text: 'An example answer 🌍' });
      if (payload.messages.at(-1).content === 'Test stop') {
        await new Promise(resolve => { pending = { id: payload.id, resolve }; });
      } else if (payload.messages.at(-1).content === 'Test limit') {
        window.webContents.send('stream', { id: payload.id, type: 'error', message: 'Usage limit reached. Open Manage usage.' });
      } else {
        window.webContents.send('stream', { id: payload.id, type: 'completed' });
      }
    });
    ipcMain.handle('cancel', () => {
      BrowserWindow.getAllWindows()[0].webContents.send('stream', { id: pending.id, type: 'cancelled' });
      pending.resolve(); pending = undefined;
    });
  });
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.getByLabel('Model', { exact: true }).selectOption('test-model');
  await page.getByRole('textbox', { name: 'Your question' }).fill('Test question');
  await page.getByRole('button', { name: 'Send', exact: false }).click();
  await page.getByText('An example answer 🌍', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Send', exact: false }).waitFor();
  assert.equal(await page.getByText('Answer did not complete', { exact: true }).count(), 0);
  await page.screenshot({ path: 'work/chat-preview.png' });
  await page.getByRole('textbox', { name: 'Your question' }).fill('Test limit');
  await page.getByRole('button', { name: 'Send', exact: false }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /Usage limit/);
  await page.getByRole('textbox', { name: 'Your question' }).fill('Test stop');
  await page.getByRole('button', { name: 'Send', exact: false }).click();
  await page.getByRole('button', { name: 'Stop', exact: false }).click();
  await page.getByRole('button', { name: 'Send', exact: false }).waitFor();
  assert.equal(await page.getByText('Answer did not complete', { exact: true }).count(), 2);
  await page.getByRole('button', { name: 'New chat', exact: false }).click();
  await page.getByRole('heading', { name: 'What’s on your mind?' }).waitFor();
  console.log(`${packaged ? 'Packaged executable' : 'Electron'} smoke check passed: isolated UI, encrypted local state, composer, welcome, models, answer, late limit, stop, and new chat. Live OAuth/inference was not exercised.`);
} catch (error) {
  const page = await application.firstWindow();
  console.log(await page.locator('body').innerText());
  await page.screenshot({ path: 'work/smoke-failure.png' });
  throw error;
} finally { await application.close(); }
