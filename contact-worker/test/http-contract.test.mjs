// HTTP-level contract test: the Worker handler behind a real local socket, exercised with fetch()
// the way a browser would call it (Origin header, CORS preflight, JSON). Upstream Zoho is mocked.
// The server lives only inside this test process; nothing is left running.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { handleRequest, createState } from '../src/index.js';

const SITE = 'https://www.xiomics.systems';
const ENV = {
  ALLOWED_ORIGINS: SITE,
  SITE_URL: SITE,
  MAIL_FROM: 'contact@xiomics.systems',
  MAIL_TO: 'contact@xiomics.systems',
  ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.test',
  ZOHO_MAIL_API_URL: 'https://mail.zoho.test',
  ZOHO_CLIENT_ID: 'id',
  ZOHO_CLIENT_SECRET: 'secret',
  ZOHO_REFRESH_TOKEN: 'refresh',
  ZOHO_ACCOUNT_ID: '42',
  TURNSTILE_REQUIRED: 'false',
};

const upstreamCalls = [];
const fakeZoho = async (url) => {
  upstreamCalls.push(String(url));
  if (String(url).endsWith('/oauth/v2/token')) return Response.json({ access_token: 't', expires_in: 3600 });
  return Response.json({ status: { code: 200, description: 'success' } });
};

let server;
let base;
const state = createState();

before(async () => {
  server = http.createServer(async (req, res) => {
    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: 'half',
    });
    const response = await handleRequest(request, ENV, { fetchImpl: fakeZoho, state, log: () => {} });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('CORS preflight over HTTP', async () => {
  const res = await fetch(`${base}/api/contact`, {
    method: 'OPTIONS',
    headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  assert.match(res.headers.get('access-control-allow-headers'), /content-type/i);
});

test('valid JSON POST over HTTP returns {ok:true} after the mocked Zoho accepts it', async () => {
  const res = await fetch(`${base}/api/contact`, {
    method: 'POST',
    headers: { Origin: SITE, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.1' },
    body: JSON.stringify({
      name: 'Ada Lovelace', email: 'ada@example.com', business: 'Analytical Engines Ltd',
      message: 'Please automate our onboarding workflow.', xs_hp: '', elapsed_ms: 9000, submission_id: 'http-contract-0001',
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { ok: true });
  assert.ok(upstreamCalls.some((u) => u.endsWith('/api/accounts/42/messages')));
});

test('invalid POST over HTTP returns field errors', async () => {
  const res = await fetch(`${base}/api/contact`, {
    method: 'POST',
    headers: { Origin: SITE, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.2' },
    body: JSON.stringify({ name: '', email: 'bad', business: 'X', message: '', elapsed_ms: 9000 }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.fields.name, 'required');
  assert.equal(body.fields.email, 'invalid_email');
  assert.equal(body.fields.message, 'required');
});

test('oversized POST over HTTP is rejected with 413', async () => {
  const res = await fetch(`${base}/api/contact`, {
    method: 'POST',
    headers: { Origin: SITE, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.3' },
    body: JSON.stringify({ message: 'x'.repeat(64 * 1024) }),
  });
  assert.equal(res.status, 413);
});
