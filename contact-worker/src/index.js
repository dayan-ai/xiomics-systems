// Xiomics contact-form endpoint (Cloudflare Worker, zero dependencies).
// POST /api/contact (JSON only)  →  checks  →  validate  →  Zoho Mail API  →  contact@xiomics.systems
// Secrets come only from Worker secrets/vars (see wrangler.toml and .dev.vars.example).
// Visitors without JavaScript never reach this Worker: the form's action is a mailto: link.
import { validateInquiry } from './validation.js';
import { sendInquiry, DeliveryError } from './zoho.js';

const ROUTE = '/api/contact';
const MAX_BODY_BYTES = 32 * 1024;
const MIN_FILL_MS = 3000;
const LOCAL_RATE_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };
const DEFAULT_MAX_DAILY_SENDS = 100;
const DEDUPE_TTL_MS = 30 * 60 * 1000;
const MAP_CAP = 5000;
const REQUIRED_CONFIG = ['ALLOWED_ORIGINS', 'MAIL_FROM', 'MAIL_TO', 'ZOHO_ACCOUNTS_URL', 'ZOHO_MAIL_API_URL',
  'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ACCOUNT_ID'];
const SUBMISSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

/**
 * Per-isolate state. Cloudflare may run several isolates, so the rate limit, daily cap and
 * dedupe are best-effort per instance; Turnstile (required by default) is the strong control.
 */
export function createState() {
  return { token: null, refreshing: null, rate: new Map(), delivered: new Map(), inflight: new Map(), sends: { day: '', count: 0 } };
}
const defaultState = createState();

// Structured, PII-free log line. Only event names and short codes are ever passed in.
const defaultLog = (event, extra = {}) => console.info(JSON.stringify({ event, ...extra }));

export default {
  /** @param {Request} request @param {Record<string, any>} env */
  fetch(request, env) {
    return handleRequest(request, env);
  },
};

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
}

function json(status, body, origin, extra = {}) {
  const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...cors, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

const turnstileRequired = (env) => String(env.TURNSTILE_REQUIRED ?? 'true').toLowerCase() !== 'false';

function prune(map, now, ttlMs) {
  if (map.size < MAP_CAP) return;
  for (const [key, value] of map) {
    if (now - (value.start ?? value) > ttlMs) map.delete(key);
  }
  while (map.size >= MAP_CAP) map.delete(map.keys().next().value);
}

/** @returns {Promise<{allowed: boolean, retryAfter: number}>} */
async function checkRateLimit(env, state, key, now) {
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key });
      return { allowed: Boolean(success), retryAfter: 60 };
    } catch {
      // fall through to the local limiter
    }
  }
  const t = now();
  const current = state.rate.get(key);
  const fresh = !current || t - current.start >= LOCAL_RATE_LIMIT.windowMs;
  const entry = { start: fresh ? t : current.start, count: (fresh ? 0 : current.count) + 1 };
  prune(state.rate, t, LOCAL_RATE_LIMIT.windowMs);
  state.rate.set(key, entry);
  const retryAfter = Math.max(1, Math.ceil((entry.start + LOCAL_RATE_LIMIT.windowMs - t) / 1000));
  return { allowed: entry.count <= LOCAL_RATE_LIMIT.max, retryAfter };
}

/** Read at most MAX_BODY_BYTES; returns null when the body is larger. */
async function readBodyCapped(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

function parseJsonObject(text) {
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function verifyTurnstile(env, token, ip, fetchImpl) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;
  try {
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await res.json();
    const hosts = allowedOrigins(env).map((o) => o.replace(/^https?:\/\//, ''));
    return Boolean(result && result.success === true && hosts.includes(String(result.hostname || '')));
  } catch {
    return false;
  }
}

/** Origin, client IP, rate limit and configuration. Returns a Response to stop, or null to continue. */
async function guard(ctx) {
  const { env, deps } = ctx;
  if (!ctx.origin) return json(403, { ok: false, error: 'forbidden_origin' }, null);
  if (!ctx.ip) return json(400, { ok: false, error: 'bad_request' }, ctx.origin);
  const limit = await checkRateLimit(env, deps.state, ctx.ip, deps.now);
  if (!limit.allowed) {
    deps.log('rate_limited');
    return json(429, { ok: false, error: 'rate_limited' }, ctx.origin, { 'Retry-After': String(limit.retryAfter) });
  }
  const missingConfig = REQUIRED_CONFIG.some((k) => !env[k]) || (turnstileRequired(env) && !env.TURNSTILE_SECRET);
  if (missingConfig) {
    deps.log('not_configured'); // the owner sees the reason in logs; visitors get a generic error
    return json(503, { ok: false, error: 'unavailable' }, ctx.origin);
  }
  return null;
}

/**
 * Handle one request. Dependencies are injectable for tests.
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{fetchImpl?: typeof fetch, now?: () => number, log?: Function, state?: ReturnType<typeof createState>}} [overrides]
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, env, overrides = {}) {
  const deps = { fetchImpl: globalThis.fetch, now: Date.now, log: defaultLog, state: defaultState, ...overrides };
  if (new URL(request.url).pathname !== ROUTE) return json(404, { ok: false, error: 'not_found' }, null);

  const requestOrigin = (request.headers.get('Origin') || '').replace(/\/$/, '');
  const origin = allowedOrigins(env).includes(requestOrigin) ? requestOrigin : null;

  if (request.method === 'OPTIONS') {
    if (!origin) return json(403, { ok: false, error: 'forbidden_origin' }, null);
    return new Response(null, {
      status: 204,
      headers: { ...BASE_HEADERS, 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept', 'Access-Control-Max-Age': '86400' },
    });
  }
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, origin, { Allow: 'POST, OPTIONS' });

  const ctx = { env, deps, origin, ip: request.headers.get('CF-Connecting-IP') || '' };
  const stop = await guard(ctx);
  if (stop) return stop;
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
    return json(415, { ok: false, error: 'unsupported_media_type' }, origin);
  }
  const text = await readBodyCapped(request);
  if (text === null) return json(413, { ok: false, error: 'payload_too_large' }, origin);
  const payload = parseJsonObject(text);
  if (!payload) return json(400, { ok: false, error: 'bad_request' }, origin);
  return processInquiry(payload, ctx);
}

async function processInquiry(payload, ctx) {
  const { env, deps, origin } = ctx;
  if (String(payload.xs_hp || '').trim() !== '') {
    deps.log('dropped_honeypot'); // automated senders get a generic answer; the browser never sends a filled trap
    return json(200, { ok: true }, origin);
  }
  if (payload.elapsed_ms === undefined || !Number.isFinite(Number(payload.elapsed_ms))) return json(400, { ok: false, error: 'bad_request' }, origin);
  if (Number(payload.elapsed_ms) < MIN_FILL_MS) {
    deps.log('too_fast'); // a real person may be fast: tell them, never pretend success
    return json(422, { ok: false, error: 'too_fast' }, origin);
  }
  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env, payload['cf-turnstile-response'], ctx.ip, deps.fetchImpl))) {
    deps.log('turnstile_failed');
    return json(403, { ok: false, error: 'verification_failed' }, origin);
  }
  const result = validateInquiry(payload);
  if (!result.ok) {
    deps.log('validation_failed', { fields: Object.keys(result.errors) });
    return json(400, { ok: false, error: 'validation', fields: result.errors }, origin);
  }
  const id = SUBMISSION_ID.test(String(payload.submission_id || '')) ? String(payload.submission_id) : null;
  return deliverOnce(result.value, id, ctx);
}

/** Dedupe by submission id: an already-delivered id is not resent; a concurrent duplicate shares the outcome. */
async function deliverOnce(inquiry, id, ctx) {
  const { deps, origin } = ctx;
  const t = deps.now();
  const deliveredAt = id && deps.state.delivered.get(id);
  if (deliveredAt && t - deliveredAt < DEDUPE_TTL_MS) {
    deps.log('duplicate_ignored');
    return json(200, { ok: true, duplicate: true }, origin);
  }
  const pending = id && deps.state.inflight.get(id);
  const outcome = pending ? await pending : await trackInflight(id, deliver(inquiry, ctx), deps.state);
  if (outcome.status === 200 && id) {
    prune(deps.state.delivered, deps.now(), DEDUPE_TTL_MS);
    deps.state.delivered.set(id, deps.now());
  }
  return json(outcome.status, outcome.body, origin);
}

async function trackInflight(id, promise, state) {
  if (!id) return promise;
  state.inflight.set(id, promise);
  try {
    return await promise;
  } finally {
    state.inflight.delete(id);
  }
}

function underDailyCap(env, state, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (state.sends.day !== day) state.sends = { day, count: 0 };
  const cap = Number(env.MAX_DAILY_SENDS) > 0 ? Number(env.MAX_DAILY_SENDS) : DEFAULT_MAX_DAILY_SENDS;
  return state.sends.count < cap;
}

/** @returns {Promise<{status: number, body: object}>} */
async function deliver(inquiry, ctx) {
  const { env, deps } = ctx;
  if (!underDailyCap(env, deps.state, deps.now())) {
    deps.log('daily_cap_reached');
    return { status: 503, body: { ok: false, error: 'unavailable' } };
  }
  deps.state.sends.count += 1; // counted per attempt, so failures cannot be used to bypass the cap
  try {
    await sendInquiry({ env, state: deps.state, fetchImpl: deps.fetchImpl, now: deps.now }, inquiry);
  } catch (err) {
    deps.log('delivery_failed', { code: err instanceof DeliveryError ? err.code : 'unexpected' });
    return { status: 502, body: { ok: false, error: 'delivery_failed' } };
  }
  deps.log('delivered');
  return { status: 200, body: { ok: true } };
}
