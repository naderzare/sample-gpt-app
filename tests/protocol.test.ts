import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { consumeResponse, oauthSecrets, validateCallback, ServiceError } from '../electron/protocol';

function stream(events: unknown[], byteChunks = 7) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += byteChunks) controller.enqueue(bytes.slice(i, i + byteChunks)); controller.close(); } });
}
test('PKCE uses fresh values and the S256 digest', () => {
  const first = oauthSecrets(), second = oauthSecrets();
  assert.notEqual(first.state, second.state); assert.notEqual(first.nonce, second.nonce); assert.notEqual(first.verifier, second.verifier);
  assert.equal(first.challenge, createHash('sha256').update(first.verifier).digest('base64url'));
});
test('OAuth rejects missing/wrong state, mismatched client IDs and incomplete registration', () => {
  const base = 'http://127.0.0.1:12345/auth/callback?code=code&state=state';
  assert.throws(() => validateCallback(new URL(base), 'different'), /state/);
  assert.throws(() => validateCallback(new URL(base), 'state'), /complete/);
  assert.throws(() => validateCallback(new URL(base + '&client_id=dynamic_agent_client'), 'state'), /complete/);
  assert.throws(() => validateCallback(new URL(base + '&client_id=oaiapp_wrong'), 'state', 'oaiapp_saved'), /match/);
  assert.deepEqual(validateCallback(new URL(base), 'state', 'oaiapp_saved'), { code: 'code', clientId: 'oaiapp_saved' });
  assert.deepEqual(validateCallback(new URL(base + '&client_id=oaiapp_new'), 'state'), { code: 'code', clientId: 'oaiapp_new' });
});
test('OAuth denial is validated before exchanging a code', () => {
  assert.throws(() => validateCallback(new URL('http://127.0.0.1/auth/callback?error=access_denied&state=state'), 'state'), /declined/);
});
test('SSE handles arbitrary frame and UTF-8 splits and waits for completion', async () => {
  let text = '';
  const result = await consumeResponse(stream([{ type: 'response.output_text.delta', delta: 'Hello 🌍' }, { type: 'response.output_text.delta', delta: '!' }, { type: 'response.completed' }], 1), delta => { text += delta; });
  assert.equal(text, 'Hello 🌍!'); assert.equal(result, text);
});
test('a usage error after text has arrived is still a failure', async () => {
  await assert.rejects(consumeResponse(stream([{ type: 'response.output_text.delta', delta: 'Partial text' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }]), () => {}), (error: unknown) => error instanceof ServiceError && error.code === 'subscription_sharing_usage_limit_exceeded');
});
test('truncated, incomplete and empty streams are not treated as answers', async () => {
  await assert.rejects(consumeResponse(stream([{ type: 'response.output_text.delta', delta: 'Partial text' }]), () => {}), /before.*completed/);
  await assert.rejects(consumeResponse(stream([{ type: 'response.incomplete' }]), () => {}), /incomplete/);
  await assert.rejects(consumeResponse(stream([{ type: 'response.completed' }]), () => {}), /no text/);
});
