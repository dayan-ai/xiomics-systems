// Tests for the contact Worker. Zoho and Turnstile are mocked: no network, no real email.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest, createState } from '../src/index.js';
import { validateInquiry } from '../src/validation.js';
import { buildEmail } from '../src/zoho.js';

const SITE = 'https://www.xiomics.systems';
const ENDPOINT = 'https://xiomics-contact.example.workers.dev/api/contact';

// Turnstile is required by default in production; most tests switch it off explicitly
// and dedicated tests below cover the required path.
const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://www.xiomics.systems, https://xiomics.systems',
  MAIL_FROM: 'contact@xiomics.systems',
  MAIL_TO: 'contact@xiomics.systems',
  ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.test',
  ZOHO_MAIL_API_URL: 'https://mail.zoho.test',
  ZOHO_CLIENT_ID: 'test-client-id',
  ZOHO_CLIENT_SECRET: 'test-client-secret',
  ZOHO_REFRESH_TOKEN: 'test-refresh-token',
  ZOHO_ACCOUNT_ID: '1234567890',
  TURNSTILE_REQUIRED: 'false',
});
const ENV_TURNSTILE = Object.freeze({ ...ENV, TURNSTILE_REQUIRED: 'true', TURNSTILE_SECRET: 'ts-secret' });

const VALID = Object.freeze({
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  business: 'Analytical Engines Ltd',
  message: 'We want to automate our invoice intake and CRM updates.',
  xs_hp: '',
  elapsed_ms: 12000,
  submission_id: '3f2b1c9e-0d4a-4b7e-9c11-aa22bb33cc44',
});

/** A scripted fetch stub that records every upstream call. */
function makeUpstream({ token = 'ok', send = 'ok', turnstile = true, turnstileHost = 'www.xiomics.systems', tokenDelayMs = 0 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith('/oauth/v2/token')) {
      if (tokenDelayMs) await new Promise((r) => setTimeout(r, tokenDelayMs));
      if (token === 'throw') throw new TypeError('network down');
      if (token === 'fail') return Response.json({ error: 'invalid_code' }, { status: 200 });
      return Response.json({ access_token: 'access-abc', expires_in: 3600, token_type: 'Bearer' });
    }
    if (u.includes('/api/accounts/') && u.endsWith('/messages')) {
      if (send === 'throw') throw new TypeError('network down');
      if (send === 'http500') return Response.json({ status: { code: 500, description: 'Internal Error' } }, { status: 500 });
      if (send === 'rejected') return Response.json({ status: { code: 404, description: 'Invalid input' } }, { status: 200 });
      if (send === 'slow') await new Promise((r) => setTimeout(r, 50));
      if (send === 'unauthorized-once') {
        const sends = calls.filter((c) => c.url.endsWith('/messages')).length;
        if (sends === 1) return Response.json({ data: { errorCode: 'INVALID_OAUTHTOKEN' }, status: { code: 401 } }, { status: 401 });
      }
      return Response.json({ status: { code: 200, description: 'success' }, data: {} });
    }
    if (u.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) {
      return Response.json({ success: turnstile, hostname: turnstileHost, 'error-codes': turnstile ? [] : ['invalid-input-response'] });
    }
    throw new Error(`Unexpected upstream call: ${u}`);
  };
  return { impl, calls };
}

function makeLog() {
  const lines = [];
  return { lines, log: (event, extra = {}) => lines.push(JSON.stringify({ event, ...extra })) };
}

function post(body, { origin = SITE, contentType = 'application/json', ip = '203.0.113.7', headers = {} } = {}) {
  const h = new Headers({ 'Content-Type': contentType, ...headers });
  if (ip) h.set('CF-Connecting-IP', ip);
  if (origin) h.set('Origin', origin);
  const payload = typeof body === 'string' ? body : contentType.startsWith('application/json')
    ? JSON.stringify(body)
    : new URLSearchParams(body).toString();
  return new Request(ENDPOINT, { method: 'POST', headers: h, body: payload });
}

let state;
let upstream;
let logger;
let clock;
const deps = () => ({ fetchImpl: upstream.impl, log: logger.log, state, now: () => clock });

beforeEach(() => {
  state = createState();
  upstream = makeUpstream();
  logger = makeLog();
  clock = Date.UTC(2026, 10, 9, 12, 0, 0);
});

describe('validation parity with shared vectors', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/inquiry-vectors.json', import.meta.url), 'utf8'));
  const expand = (v) => {
    if (!v || typeof v !== 'object') return v;
    if (v.codepoint) return v.prefix + String.fromCodePoint(parseInt(v.codepoint, 16)) + v.suffix;
    return v.repeat.repeat(v.times) + (v.suffix || '');
  };
  for (const c of vectors.cases) {
    test(c.case, () => {
      const input = { ...vectors.base };
      for (const [k, v] of Object.entries(c.override)) input[k] = expand(v);
      const result = validateInquiry(input);
      assert.equal(result.ok, c.ok);
      assert.deepEqual(result.errors, c.errors);
    });
  }

  test('non-string JSON values are rejected, not stringified', () => {
    const r = validateInquiry({ name: { a: 1 }, email: ['ada@example.com'], business: 42, message: true });
    assert.equal(r.errors.name, 'required');
    assert.equal(r.errors.email, 'required');
    assert.equal(r.errors.message, 'required');
    assert.equal(r.errors.business, undefined, 'numbers are acceptable as text');
  });
});

describe('routing and CORS', () => {
  test('preflight from an allowed origin returns CORS headers', async () => {
    const req = new Request(ENDPOINT, { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST' } });
    const res = await handleRequest(req, ENV, deps());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), SITE);
    assert.match(res.headers.get('Access-Control-Allow-Methods'), /POST/);
    assert.equal(res.headers.get('Vary'), 'Origin');
  });

  test('preflight from a foreign origin is refused', async () => {
    const req = new Request(ENDPOINT, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    const res = await handleRequest(req, ENV, deps());
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  });

  test('POST from a foreign origin is refused without calling Zoho', async () => {
    const res = await handleRequest(post(VALID, { origin: 'https://evil.example' }), ENV, deps());
    assert.equal(res.status, 403);
    assert.equal(upstream.calls.length, 0);
  });

  test('POST without an Origin header, or with Origin "null", is refused', async () => {
    assert.equal((await handleRequest(post(VALID, { origin: null }), ENV, deps())).status, 403);
    assert.equal((await handleRequest(post(VALID, { origin: 'null' }), ENV, deps())).status, 403);
  });

  test('POST without a client IP header is rejected (never shares one rate-limit bucket)', async () => {
    const res = await handleRequest(post(VALID, { ip: null }), ENV, deps());
    assert.equal(res.status, 400);
    assert.equal(upstream.calls.length, 0);
  });

  test('GET is not allowed', async () => {
    const res = await handleRequest(new Request(ENDPOINT, { headers: { Origin: SITE } }), ENV, deps());
    assert.equal(res.status, 405);
    assert.match(res.headers.get('Allow'), /POST/);
  });

  test('unknown paths return 404', async () => {
    const res = await handleRequest(new Request('https://x.example.workers.dev/other', { method: 'POST', headers: { Origin: SITE } }), ENV, deps());
    assert.equal(res.status, 404);
  });

  test('every response carries no-store and nosniff', async () => {
    const res = await handleRequest(post(VALID), ENV, deps());
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  });
});

describe('valid submission', () => {
  test('sends exactly one plain-text email to the fixed mailbox and returns ok', async () => {
    const res = await handleRequest(post(VALID), ENV, deps());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), SITE);

    const sends = upstream.calls.filter((c) => c.url.endsWith('/messages'));
    assert.equal(sends.length, 1);
    assert.equal(sends[0].url, 'https://mail.zoho.test/api/accounts/1234567890/messages');
    assert.equal(sends[0].init.headers.Authorization, 'Zoho-oauthtoken access-abc');
    const body = JSON.parse(sends[0].init.body);
    assert.equal(body.fromAddress, 'contact@xiomics.systems');
    assert.equal(body.toAddress, 'contact@xiomics.systems');
    assert.equal(body.mailFormat, 'plaintext');
    assert.match(body.subject, /Analytical Engines Ltd/);
    assert.match(body.content, /ada@example\.com/);
    assert.match(body.content, /invoice intake/);
  });

  test('refreshes the OAuth token with the documented parameters', async () => {
    await handleRequest(post(VALID), ENV, deps());
    const tokenCall = upstream.calls.find((c) => c.url.endsWith('/oauth/v2/token'));
    assert.equal(tokenCall.url, 'https://accounts.zoho.test/oauth/v2/token');
    const params = new URLSearchParams(String(tokenCall.init.body));
    assert.equal(params.get('grant_type'), 'refresh_token');
    assert.equal(params.get('refresh_token'), 'test-refresh-token');
    assert.equal(params.get('client_id'), 'test-client-id');
    assert.equal(params.get('client_secret'), 'test-client-secret');
  });

  test('caches the access token across requests (Zoho allows 10 refreshes per 10 minutes)', async () => {
    await handleRequest(post({ ...VALID, submission_id: 'aaaaaaaa-1111' }), ENV, deps());
    await handleRequest(post({ ...VALID, submission_id: 'bbbbbbbb-2222' }, { ip: '203.0.113.8' }), ENV, deps());
    assert.equal(upstream.calls.filter((c) => c.url.endsWith('/oauth/v2/token')).length, 1);
  });

  test('concurrent requests with a cold cache share one token refresh (no stampede)', async () => {
    upstream = makeUpstream({ tokenDelayMs: 30 });
    const results = await Promise.all([
      handleRequest(post({ ...VALID, submission_id: 'cccccccc-0001' }, { ip: '198.51.100.11' }), ENV, deps()),
      handleRequest(post({ ...VALID, submission_id: 'cccccccc-0002' }, { ip: '198.51.100.12' }), ENV, deps()),
      handleRequest(post({ ...VALID, submission_id: 'cccccccc-0003' }, { ip: '198.51.100.13' }), ENV, deps()),
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    assert.equal(upstream.calls.filter((c) => c.url.endsWith('/oauth/v2/token')).length, 1);
  });

  test('a recipient supplied by the client is ignored (no open relay)', async () => {
    await handleRequest(post({ ...VALID, toAddress: 'victim@example.test', to: 'victim@example.test' }), ENV, deps());
    const body = JSON.parse(upstream.calls.find((c) => c.url.endsWith('/messages')).init.body);
    assert.equal(body.toAddress, 'contact@xiomics.systems');
  });

  test('form-encoded POSTs are refused: JSON only (no-JS visitors use the mailto action instead)', async () => {
    const res = await handleRequest(post(VALID, { contentType: 'application/x-www-form-urlencoded' }), ENV, deps());
    assert.equal(res.status, 415);
    assert.equal(upstream.calls.length, 0);
  });
});

describe('validation failures (server-side)', () => {
  const cases = [
    ['missing name', { name: '' }, 'name', 'required'],
    ['invalid email', { email: 'not-an-email' }, 'email', 'invalid_email'],
    ['empty message', { message: '   ' }, 'message', 'required'],
    ['header injection in name', { name: 'Ada\r\nBcc: attacker@example.test' }, 'name', 'invalid_characters'],
  ];
  for (const [label, override, field, code] of cases) {
    test(`${label} → 400 with field error and no email sent`, async () => {
      const res = await handleRequest(post({ ...VALID, ...override }), ENV, deps());
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, 'validation');
      assert.equal(body.fields[field], code);
      assert.equal(upstream.calls.length, 0);
    });
  }

  test('malformed JSON → 400', async () => {
    const res = await handleRequest(post('{"name":', {}), ENV, deps());
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_request');
  });

  test('JSON that is not an object → 400', async () => {
    const res = await handleRequest(post('["a"]'), ENV, deps());
    assert.equal(res.status, 400);
  });

  test('missing elapsed_ms → 400 (the browser always sends it)', async () => {
    const { elapsed_ms, ...rest } = VALID;
    void elapsed_ms;
    const res = await handleRequest(post(rest), ENV, deps());
    assert.equal(res.status, 400);
    assert.equal(upstream.calls.length, 0);
  });

  test('unsupported content type → 415', async () => {
    const res = await handleRequest(post('name=x', { contentType: 'text/plain' }), ENV, deps());
    assert.equal(res.status, 415);
  });

  test('oversized body → 413 without calling Zoho', async () => {
    const res = await handleRequest(post({ ...VALID, message: 'x'.repeat(40 * 1024) }), ENV, deps());
    assert.equal(res.status, 413);
    assert.equal(upstream.calls.length, 0);
  });
});

describe('spam protection', () => {
  test('filled honeypot is silently dropped (no email, generic ok for bots)', async () => {
    const res = await handleRequest(post({ ...VALID, xs_hp: 'http://spam.example' }), ENV, deps());
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 0);
    assert.ok(logger.lines.some((l) => l.includes('dropped_honeypot')));
  });

  test('a too-fast submission is NOT reported as success: 422 too_fast so a person can resend', async () => {
    const res = await handleRequest(post({ ...VALID, elapsed_ms: 400 }), ENV, deps());
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { ok: false, error: 'too_fast' });
    assert.equal(upstream.calls.length, 0);
  });

  test('rate limit: the 6th attempt from one IP within the window → 429 with Retry-After', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await handleRequest(post({ ...VALID, submission_id: `rate-test-000${i}` }), ENV, deps());
      assert.equal(res.status, 200);
    }
    const res = await handleRequest(post({ ...VALID, submission_id: 'rate-test-0006' }), ENV, deps());
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('Retry-After')) > 0);
    assert.equal((await res.json()).error, 'rate_limited');
  });

  test('rate limit window resets', async () => {
    for (let i = 0; i < 6; i += 1) await handleRequest(post({ ...VALID, submission_id: `reset-test-00${i}` }), ENV, deps());
    clock += 11 * 60 * 1000;
    const res = await handleRequest(post({ ...VALID, submission_id: 'reset-test-0099' }), ENV, deps());
    assert.equal(res.status, 200);
  });

  test('uses the Cloudflare rate-limit binding when configured', async () => {
    const binding = { limit: async () => ({ success: false }) };
    const res = await handleRequest(post(VALID), { ...ENV, RATE_LIMITER: binding }, deps());
    assert.equal(res.status, 429);
  });

  test('daily send cap per instance stops quota exhaustion with a generic 503', async () => {
    const env = { ...ENV, MAX_DAILY_SENDS: '2' };
    for (let i = 0; i < 2; i += 1) {
      const ok = await handleRequest(post({ ...VALID, submission_id: `cap-test-000${i}` }, { ip: `198.51.100.${30 + i}` }), env, deps());
      assert.equal(ok.status, 200);
    }
    const capped = await handleRequest(post({ ...VALID, submission_id: 'cap-test-0009' }, { ip: '198.51.100.39' }), env, deps());
    assert.equal(capped.status, 503);
    assert.deepEqual(await capped.json(), { ok: false, error: 'unavailable' });
    clock += 24 * 60 * 60 * 1000;
    const nextDay = await handleRequest(post({ ...VALID, submission_id: 'cap-test-0010' }, { ip: '198.51.100.40' }), env, deps());
    assert.equal(nextDay.status, 200);
  });

  test('Turnstile is required by default: no secret configured → 503 unavailable, nothing sent', async () => {
    const { TURNSTILE_REQUIRED, ...productionDefaults } = ENV;
    void TURNSTILE_REQUIRED;
    const res = await handleRequest(post(VALID), productionDefaults, deps());
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'unavailable' });
    assert.equal(upstream.calls.length, 0);
  });

  test('Turnstile: missing token → 403', async () => {
    const res = await handleRequest(post(VALID), ENV_TURNSTILE, deps());
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'verification_failed');
    assert.equal(upstream.calls.filter((c) => c.url.endsWith('/messages')).length, 0);
  });

  test('Turnstile: verified token for our hostname allows delivery', async () => {
    const res = await handleRequest(post({ ...VALID, 'cf-turnstile-response': 'token-xyz' }), ENV_TURNSTILE, deps());
    assert.equal(res.status, 200);
    const verify = upstream.calls.find((c) => c.url.includes('siteverify'));
    const sent = new URLSearchParams(String(verify.init.body));
    assert.equal(sent.get('secret'), 'ts-secret');
    assert.equal(sent.get('response'), 'token-xyz');
  });

  test('Turnstile: rejected token → 403', async () => {
    upstream = makeUpstream({ turnstile: false });
    const res = await handleRequest(post({ ...VALID, 'cf-turnstile-response': 'bad' }), ENV_TURNSTILE, deps());
    assert.equal(res.status, 403);
  });

  test('Turnstile: a token issued for another hostname → 403', async () => {
    upstream = makeUpstream({ turnstileHost: 'evil.example' });
    const res = await handleRequest(post({ ...VALID, 'cf-turnstile-response': 'stolen' }), ENV_TURNSTILE, deps());
    assert.equal(res.status, 403);
    assert.equal(upstream.calls.filter((c) => c.url.endsWith('/messages')).length, 0);
  });
});

describe('duplicate submissions', () => {
  test('the same submission_id is delivered only once', async () => {
    const first = await handleRequest(post(VALID), ENV, deps());
    const second = await handleRequest(post(VALID), ENV, deps());
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { ok: true, duplicate: true });
    assert.equal(upstream.calls.filter((c) => c.url.endsWith('/messages')).length, 1);
  });

  test('concurrent requests with the same submission_id send once and share the outcome', async () => {
    upstream = makeUpstream({ send: 'slow' });
    const [a, b] = await Promise.all([
      handleRequest(post(VALID), ENV, deps()),
      handleRequest(post(VALID, { ip: '203.0.113.99' }), ENV, deps()),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(upstream.calls.filter((c) => c.url.endsWith('/messages')).length, 1);
  });

  test('a failed delivery does not mark the id as delivered (retry still sends)', async () => {
    upstream = makeUpstream({ send: 'http500' });
    const first = await handleRequest(post(VALID), ENV, deps());
    assert.equal(first.status, 502);
    upstream = makeUpstream();
    const retry = await handleRequest(post(VALID), ENV, deps());
    assert.deepEqual(await retry.json(), { ok: true });
  });
});

describe('delivery failures never report success', () => {
  for (const [label, opts] of [
    ['token endpoint unreachable', { token: 'throw' }],
    ['token refresh rejected', { token: 'fail' }],
    ['send API network error', { send: 'throw' }],
    ['send API HTTP 500', { send: 'http500' }],
    ['send API status code not success', { send: 'rejected' }],
  ]) {
    test(`${label} → 502 delivery_failed with no internal detail`, async () => {
      upstream = makeUpstream(opts);
      const res = await handleRequest(post(VALID), ENV, deps());
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.deepEqual(body, { ok: false, error: 'delivery_failed' });
    });
  }

  test('an expired token (401) is refreshed once and the send retried', async () => {
    upstream = makeUpstream({ send: 'unauthorized-once' });
    const res = await handleRequest(post(VALID), ENV, deps());
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.filter((c) => c.url.endsWith('/oauth/v2/token')).length, 2);
  });

  test('missing configuration → generic 503 unavailable (does not reveal what is missing)', async () => {
    const { ZOHO_REFRESH_TOKEN, ...partial } = ENV;
    void ZOHO_REFRESH_TOKEN;
    const res = await handleRequest(post(VALID), partial, deps());
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'unavailable' });
    assert.equal(upstream.calls.length, 0);
    assert.ok(logger.lines.some((l) => l.includes('not_configured')), 'the owner still sees the reason in logs');
  });
});

describe('privacy of logs', () => {
  test('logs never contain the visitor name, email or message', async () => {
    await handleRequest(post(VALID), ENV, deps());
    upstream = makeUpstream({ send: 'http500' });
    await handleRequest(post({ ...VALID, submission_id: 'privacy-0002' }, { ip: '203.0.113.9' }), ENV, deps());
    const all = logger.lines.join('\n');
    assert.ok(logger.lines.length >= 2);
    for (const secret of ['Ada Lovelace', 'ada@example.com', 'invoice intake', 'test-client-secret', 'test-refresh-token', 'access-abc']) {
      assert.ok(!all.includes(secret), `log leaked: ${secret}`);
    }
  });
});

describe('email composition', () => {
  test('builds a plain-text email with all fields and a bounded subject', () => {
    const email = buildEmail(
      { name: 'Ada', email: 'ada@example.com', business: 'B'.repeat(120), message: 'Hello\nWorld, please help.' },
      { submittedAt: '2026-11-09T12:00:00.000Z' },
    );
    assert.ok(email.subject.length <= 160);
    assert.doesNotMatch(email.subject, /[\r\n]/);
    assert.match(email.content, /Name: Ada/);
    assert.match(email.content, /Email: ada@example\.com/);
    assert.match(email.content, /Hello\nWorld/);
    assert.match(email.content, /2026-11-09T12:00:00\.000Z/);
  });
});
