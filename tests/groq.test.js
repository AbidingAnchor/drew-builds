import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { groqCompletion } from '../lib/groq.js';
import chat from '../api/chat.js';
import audit from '../api/audit.js';
import { buildBusinessProfile } from '../api/businessProfile.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
after(() => {
  globalThis.fetch = originalFetch;
  for (const key of ['GROQ_MODEL', 'GROQ_API_KEY']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

const completion = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });
function mockGroq(responses) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    calls.push(JSON.parse(options.body));
    assert.ok(responses.length, 'Unexpected extra request');
    return responses.shift();
  };
  return calls;
}
function captureResponse() {
  return { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
}

test('default and trimmed env override preserve JSON content and request options', async () => {
  for (const [env, expected] of [['', 'openai/gpt-oss-120b'], [' custom/model ', 'custom/model'], ['  ', 'openai/gpt-oss-120b']]) {
    process.env.GROQ_MODEL = env;
    const data = completion('{"ok":true}');
    const calls = mockGroq([Response.json(data)]);
    const { response } = await groqCompletion('test-key', { messages: [], response_format: { type: 'json_object' } });
    assert.deepEqual(JSON.parse((await response.json()).choices[0].message.content), { ok: true });
    assert.equal(calls[0].model, expected);
    assert.deepEqual(calls[0].response_format, { type: 'json_object' });
    if (expected.startsWith('openai/gpt-oss')) assert.equal(calls[0].include_reasoning, false);
  }
});

test('404 (including non-JSON), model_not_found code/type retry exactly once', async () => {
  delete process.env.GROQ_MODEL;
  for (const first of [new Response('Not found', { status: 404 }), Response.json({ error: { code: 'model_not_found' } }, { status: 400 }), Response.json({ error: { type: 'model_not_found' } }, { status: 400 })]) {
    const calls = mockGroq([first, Response.json(completion('Hello'))]);
    const { response, model } = await groqCompletion('test-key', { messages: [] });
    assert.equal((await response.json()).choices[0].message.content, 'Hello');
    assert.equal(model, 'openai/gpt-oss-20b');
    assert.deepEqual(calls.map(call => call.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  }
});

test('unrelated errors and an already-selected fallback do not retry; error bodies remain readable', async () => {
  for (const status of [401, 429, 500]) {
    delete process.env.GROQ_MODEL;
    const error = { error: { code: 'other', message: 'Failure' } };
    const calls = mockGroq([Response.json(error, { status })]);
    const { response } = await groqCompletion('test-key', {});
    assert.deepEqual(await response.json(), error);
    assert.equal(calls.length, 1);
  }
  process.env.GROQ_MODEL = 'openai/gpt-oss-20b';
  const calls = mockGroq([new Response('Not found', { status: 404 })]);
  assert.equal((await groqCompletion('test-key', {})).response.status, 404);
  assert.equal(calls.length, 1);
});

test('Vector preserves the chat envelope and exposes final fallback errors', async () => {
  delete process.env.GROQ_MODEL;
  process.env.GROQ_API_KEY = 'test-key';
  const data = completion('Basic websites cost $400.');
  mockGroq([new Response('', { status: 404 }), Response.json(data)]);
  const res = captureResponse();
  await chat({ method: 'POST', body: { messages: [{ role: 'user', content: 'Pricing?' }] } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, data);
  const error = { error: { code: 'model_not_found', message: 'Fallback unavailable' } };
  const calls = mockGroq([new Response('', { status: 404 }), Response.json(error, { status: 404 })]);
  await chat({ method: 'POST', body: { messages: [] } }, res);
  assert.equal(calls.length, 2);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Fallback unavailable');
});

test('business profile JSON and category parser survive fallback', async () => {
  delete process.env.GROQ_MODEL;
  mockGroq([new Response('', { status: 404 }), Response.json(completion('restaurant'))]);
  const profile = await buildBusinessProfile({ html: '<title>Example Cafe</title>', visibleText: 'We are a cafe serving fresh coffee and breakfast every day.', url: 'https://example.com', apiKey: 'test-key' });
  assert.deepEqual(JSON.parse(JSON.stringify(profile)), { category: 'restaurant', businessName: 'Example Cafe', phone: null, address: null, classificationError: null, classificationRaw: 'restaurant' });
});

test('audit spelling parser and JSON output survive fallback', async () => {
  delete process.env.GROQ_MODEL;
  process.env.GROQ_API_KEY = 'test-key';
  const models = [];
  globalThis.fetch = async (url, options) => {
    if (url.includes('api.groq.com')) {
      models.push(JSON.parse(options.body).model);
      return models.length === 1 ? new Response('', { status: 404 }) : Response.json(completion('YES'));
    }
    if (url.includes('languagetool.org')) return Response.json({ matches: [{ offset: 0, length: 10, replacements: [{ value: 'Appetizer' }], rule: { issueType: 'misspelling' } }] });
    if (url.includes('googleapis.com')) return Response.json({});
    return new Response('<html><head><title>Cafe</title><meta name="viewport" content="width=device-width"></head><body><p>Appetizier ' + 'Fresh food and coffee served daily. '.repeat(25) + '</p></body></html>');
  };
  const res = captureResponse();
  await audit({ method: 'POST', body: { url: 'https://example.com' } }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(JSON.stringify(res.body));
  assert.equal(body.spellingIssues.count, 1);
  assert.equal(body.spellingIssues.issues[0].word, 'Appetizier');
  assert.deepEqual(models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
});
