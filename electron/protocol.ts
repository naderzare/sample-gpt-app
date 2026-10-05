import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export const RESOURCE = 'https://api.openai.com/v1';
export const ISSUER = 'https://auth.openai.com';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export function oauthSecrets() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url') };
}
export function validateCallback(url: URL, state: string, issuedId?: string) {
  const returnedState = url.searchParams.get('state') ?? '';
  const a = Buffer.from(state), b = Buffer.from(returnedState);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Sign-in state did not match. Start sign-in again.');
  if (url.searchParams.has('error')) throw new Error(url.searchParams.get('error') === 'access_denied' ? 'Sign-in was declined. You can try again when ready.' : 'OpenAI could not complete sign-in. Try again.');
  const suppliedId = url.searchParams.get('client_id');
  if (issuedId && suppliedId && suppliedId !== issuedId) throw new Error('The returned account registration did not match.');
  const clientId = issuedId ?? suppliedId;
  const code = url.searchParams.get('code');
  if (!clientId || clientId === 'dynamic_agent_client' || !code) throw new Error('OpenAI did not return a complete account registration. Try signing in again.');
  return { clientId, code };
}
export class ServiceError extends Error {
  constructor(message: string, public status?: number, public code?: string, public requestId?: string) { super(message); }
}
export function serviceError(body: unknown, status?: number, requestId?: string) {
  const data = body as { error?: { message?: string; code?: string }; detail?: string } | undefined;
  const code = data?.error?.code;
  const friendly: Record<string, string> = {
    subscription_sharing_usage_limit_exceeded: 'Usage limit reached. Open Manage usage to review your plan or this app’s limit.',
    subscription_sharing_user_not_eligible: 'This account or workspace is not eligible for ChatGPT plan usage. Check your ChatGPT plan and workspace.',
    subscription_sharing_usage_unavailable: 'ChatGPT usage is temporarily unavailable. Try again later.'
  };
  const message = (code && friendly[code]) || data?.error?.message || data?.detail || `OpenAI request failed${status ? ` (${status})` : ''}.`;
  return new ServiceError(message, status, code, requestId);
}
// SSE frames can be split anywhere, including in the middle of a UTF-8 character.
export async function* sseData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function consumeResponse(body: ReadableStream<Uint8Array>, delta: (text: string) => void) {
  let text = '';
  for await (const event of sseData(body)) {
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (typeof event.delta === 'string') { text += event.delta; delta(event.delta); }
    } else if (event.type === 'response.completed') {
      if (!text.trim()) throw new Error('The completed response contained no text. Try another question or model.');
      return text;
    } else if (event.type === 'response.failed' || event.type === 'error') {
      throw serviceError({ error: event.response?.error ?? event.error ?? event });
    } else if (event.type === 'response.incomplete') {
      throw new Error('The answer was incomplete. Please try again.');
    }
  }
  throw new Error('The connection ended before the answer completed. Please try again.');
}
