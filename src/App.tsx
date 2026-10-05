import { useEffect, useRef, useState } from 'react';
import type { Message, Model, Session } from '../shared/types';
type ChatMessage = Message & { id: string; state?: 'streaming' | 'complete' | 'partial' };
const suggestions = ['Explain something simply', 'Help me write a message', 'Think through an idea'];
const exampleQuestions = ['Explain how a computer works in simple terms.', 'Help me write a friendly message to reschedule a meeting.', 'What questions should I ask before starting a new project?'];

export function App() {
  const [session, setSession] = useState<Session>({ accounts: [], welcome: false });
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelRevision, setModelRevision] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const activeRequest = useRef<string | undefined>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const active = session.accounts.find(account => account.id === session.activeId);
  const changingAccount = signingIn || accountBusy;
  const canAsk = !!active?.connected && !!active.sharing && !!model && !busy && !changingAccount && !loadingModels;

  useEffect(() => {
    let mounted = true;
    window.desktop.session().then(value => { if (mounted) { setSession(value); setReady(true); } }).catch(reason => { if (mounted) setError(cleanError(reason)); });
    const unsubscribe = window.desktop.onStream(event => {
      if (event.id !== activeRequest.current) return;
      if (event.type === 'delta') setMessages(previous => previous.map(message => message.id === event.id ? { ...message, content: message.content + event.text } : message));
      else {
        setMessages(previous => previous.map(message => message.id === event.id ? { ...message, state: event.type === 'completed' ? 'complete' : 'partial' } : message));
        if (event.type === 'error') setError(event.message);
        setBusy(false); activeRequest.current = undefined; composer.current?.focus();
      }
    });
    return () => { mounted = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    let mounted = true;
    setModels([]); setModel(''); setLoadingModels(false);
    if (!active?.connected || !active.sharing) return;
    setLoadingModels(true);
    window.desktop.models().then(value => {
      if (!mounted) return;
      setModels(value); setModel(value[0]?.slug ?? '');
      if (!value.length) setError('No models are available for this account. Review your ChatGPT plan and workspace, then refresh models.');
    }).catch(reason => { if (mounted) setError(cleanError(reason)); }).finally(() => { if (mounted) setLoadingModels(false); });
    return () => { mounted = false; };
  }, [active?.id, active?.connected, active?.sharing, modelRevision]);

  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'auto' }); }, [messages, busy]);

  async function login(id?: string, requestConsent = false) {
    setSigningIn(true); setError(''); setNotice('');
    try {
      const value = await window.desktop.login(id, requestConsent);
      setSession(value); setMessages([]);
      // Reauthorization may keep the same profile ID. Always refresh its model catalog.
      setModels([]); setModel(''); setModelRevision(previous => previous + 1);
    } catch (reason) { setError(cleanError(reason)); }
    finally { setSigningIn(false); }
  }
  function refreshModels() {
    setLoadingModels(true); setError(''); setModels([]); setModel(''); setModelRevision(previous => previous + 1);
  }
  async function selectAccount(id: string) {
    setAccountBusy(true); setError(''); setNotice('');
    try { setSession(await window.desktop.select(id)); setMessages([]); }
    catch (reason) { setError(cleanError(reason)); }
    finally { setAccountBusy(false); }
  }
  async function logout() {
    setAccountBusy(true); setError(''); setNotice('');
    try { const value = await window.desktop.logout(); setSession(value.session); setMessages([]); setNotice(value.warning ?? 'Signed out on this device.'); }
    catch (reason) { setError(cleanError(reason)); }
    finally { setAccountBusy(false); }
  }
  async function ask() {
    const content = question.trim();
    if (!canAsk || !content) return;
    setQuestion(''); setError(''); setNotice(''); setBusy(true);
    const id = crypto.randomUUID();
    activeRequest.current = id;
    // A stopped/failed answer remains visible, but is not sent as completed history.
    const history = messages.filter(message => message.role === 'user' || message.state === 'complete').map(({ role, content }) => ({ role, content }));
    const next: Message = { role: 'user', content };
    setMessages(previous => [...previous, { ...next, id: crypto.randomUUID() }, { role: 'assistant', content: '', id, state: 'streaming' }]);
    try { await window.desktop.ask({ id, model, messages: [...history, next] }); }
    catch (reason) {
      setError(cleanError(reason));
      setMessages(previous => previous.map(message => message.id === id ? { ...message, state: 'partial' } : message));
      setBusy(false); activeRequest.current = undefined; composer.current?.focus();
    }
  }
  async function acknowledge() {
    try { await window.desktop.acknowledgeWelcome(); setSession(previous => ({ ...previous, welcome: false })); }
    catch (reason) { setError(cleanError(reason)); }
  }
  async function openUsage() { try { await window.desktop.openUsage(); } catch (reason) { setError(cleanError(reason)); } }

  return <div className="app-shell">
    <aside className="sidebar" inert={session.welcome}>
      <div className="brand"><span className="brand-symbol" aria-hidden="true">✳</span><span>Local Chat</span></div>
      <button className="new-chat" disabled={busy || changingAccount} onClick={() => { setMessages([]); setError(''); composer.current?.focus(); }}><span aria-hidden="true">＋</span> New chat</button>
      <div className="sidebar-note"><p>A little space<br />to think out loud.</p><span>Your conversation stays in this window. Close the app to clear it.</span></div>
      <div className="account-area">
        <div className="account-heading"><span className={`status-dot ${active?.connected ? 'connected' : ''}`} />{active?.connected ? 'Account connected' : 'Connect your account'}</div>
        {session.accounts.length > 0 && <label className="field-label">ChatGPT account<select aria-label="ChatGPT account" value={session.activeId ?? ''} disabled={busy || changingAccount || loadingModels} onChange={event => void selectAccount(event.target.value)}>{session.accounts.map(account => <option value={account.id} key={account.id}>{account.label} — {account.email}{account.connected ? '' : ' (signed out)'}</option>)}</select></label>}
        <p className="account-caption">{active?.connected ? active.sharing ? 'Eligible answers use your ChatGPT plan.' : 'Signed in. ChatGPT plan usage is disabled.' : 'Use an eligible ChatGPT Plus or Pro plan. No API key needed.'}</p>
        {signingIn ? <><button className="login-button" disabled>Waiting for browser sign-in…</button><button className="text-button" onClick={() => void window.desktop.cancelLogin().catch(reason => setError(cleanError(reason)))}>Cancel sign-in</button></> : <>
          <button className="login-button" disabled={!ready || busy || accountBusy || loadingModels} onClick={() => void login(active?.id)}>Continue with ChatGPT</button>
          {active?.connected && !active.sharing && <button className="text-button" disabled={busy || accountBusy} onClick={() => void login(active.id, true)}>Enable ChatGPT plan usage</button>}
          {session.accounts.length > 0 && <button className="text-button" disabled={busy || accountBusy || loadingModels} onClick={() => void login()}>Add another account or workspace</button>}
          {active?.connected && <button className="text-button" disabled={busy || accountBusy || loadingModels} onClick={() => void logout()}>Sign out</button>}
        </>}
        <button className="usage-link" onClick={() => void openUsage()}>Manage usage <span aria-hidden="true">↗</span></button>
      </div>
    </aside>
    <main inert={session.welcome}>
      <header><div><strong>{messages.length ? 'Your conversation' : 'A fresh conversation'}</strong><span>{active?.connected ? active.email : 'On your Windows PC'}</span></div><div className="model-controls"><label htmlFor="model">Model</label><select id="model" disabled={!models.length || busy || changingAccount || loadingModels} value={model} onChange={event => setModel(event.target.value)}>{!models.length && <option value="">{loadingModels ? 'Loading models…' : 'Connect to choose'}</option>}{models.map(item => <option key={item.slug} value={item.slug}>{item.display_name}</option>)}</select>{active?.sharing && active.connected && <button title="Refresh models" aria-label="Refresh models" disabled={busy || changingAccount || loadingModels} onClick={() => void refreshModels()}>↻</button>}</div></header>
      <div className="conversation" ref={scroll} role="log" aria-label="Conversation" aria-live="polite">
        {messages.length === 0 ? <div className="empty-state"><div className="conversation-mark" aria-hidden="true">✳</div><h1>What’s on your mind?</h1><p>Ask a question, work through an idea,<br />or find the words you’re looking for.</p><div className="suggestions">{suggestions.map((text, index) => <button disabled={busy} key={text} onClick={() => { setQuestion(exampleQuestions[index]); composer.current?.focus(); }}>{text}<span aria-hidden="true">↗</span></button>)}</div></div> : <div className="messages">{messages.map(message => <article key={message.id} className={`message ${message.role}`}><div className="message-label">{message.role === 'user' ? 'You' : 'Local Chat'}</div><div className="message-text">{message.content || (message.state === 'streaming' ? 'Thinking…' : 'No answer received.')}</div>{message.state === 'partial' && <span className="partial-label">Answer did not complete</span>}</article>)}</div>}
      </div>
      <div className="composer-area">
        {error && <div className="alert error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        {notice && <div className="alert notice" role="status"><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}
        <form className="composer" onSubmit={event => { event.preventDefault(); void ask(); }}><textarea ref={composer} aria-label="Your question" placeholder={active?.connected ? 'Ask anything…' : 'Connect your ChatGPT account, then ask anything…'} value={question} maxLength={20000} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} /><div className="composer-bottom"><span>{active?.connected && active.sharing ? <><span className="status-dot connected" /> Using ChatGPT plan</> : 'Sign in to send a question'}</span>{busy ? <button type="button" className="send-button stop" onClick={() => void window.desktop.cancel().catch(reason => setError(cleanError(reason)))}>Stop <span aria-hidden="true">■</span></button> : <button type="submit" className="send-button" disabled={!canAsk || !question.trim()}>Send <span aria-hidden="true">↑</span></button>}</div></form>
        <p className="composer-help">Enter to send · Shift + Enter for a new line. Answers can contain mistakes.</p>
      </div>
    </main>
    {session.welcome && <div className="modal-backdrop"><section className="welcome-modal" role="dialog" aria-modal="true" aria-labelledby="welcome-title"><div className="conversation-mark" aria-hidden="true">✳</div><h2 id="welcome-title">You’re using your ChatGPT plan</h2><p>Eligible AI requests in Local Chat use your ChatGPT plan or authorized credits. You can review access and set available limits in ChatGPT settings.</p><button className="usage-link" onClick={() => void openUsage()}>Manage usage ↗</button><button className="send-button" autoFocus onClick={() => void acknowledge()}>Got it</button></section></div>}
  </div>;
}
function cleanError(reason: unknown) {
  return (reason instanceof Error ? reason.message : 'The operation could not finish. Try again.').replace(/^Error invoking remote method '[^']+': Error: /, '');
}
