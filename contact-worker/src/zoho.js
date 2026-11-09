// Zoho Mail delivery via the documented REST API (OAuth 2.0, scope ZohoMail.messages.CREATE).
//   Token: POST {ZOHO_ACCOUNTS_URL}/oauth/v2/token   grant_type=refresh_token
//   Send:  POST {ZOHO_MAIL_API_URL}/api/accounts/{accountId}/messages
//          Authorization: Zoho-oauthtoken <access token>
// Docs: https://www.zoho.com/mail/help/api/post-send-an-email.html
//       https://www.zoho.com/accounts/protocol/oauth/web-apps/access-token-expiry.html

const UPSTREAM_TIMEOUT_MS = 10_000;
const TOKEN_SAFETY_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_S = 3600;
const SUBJECT_MAX = 150;

/** A delivery failure with a short, non-sensitive code (safe to log). */
export class DeliveryError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = 'DeliveryError';
    this.code = code;
  }
}

/**
 * Compose the notification email. Plain text only, so visitor input can never become markup.
 * @param {{name:string,email:string,business:string,message:string}} inquiry validated values
 * @param {{submittedAt:string}} meta
 * @returns {{subject:string, content:string}}
 */
export function buildEmail(inquiry, { submittedAt }) {
  const subjectRaw = `Website inquiry — ${inquiry.business} (${inquiry.name})`;
  const subject = subjectRaw.length > SUBJECT_MAX ? `${subjectRaw.slice(0, SUBJECT_MAX - 1)}…` : subjectRaw;
  const content = [
    'New inquiry from the contact form on www.xiomics.systems',
    '',
    `Name: ${inquiry.name}`,
    `Email: ${inquiry.email}`,
    `Business: ${inquiry.business}`,
    '',
    'Message:',
    inquiry.message,
    '',
    '---',
    `Submitted: ${submittedAt}`,
    'To reply, write to the email address above. This message was sent by the website form,',
    'so replying directly to it will go to your own mailbox, not to the visitor.',
  ].join('\n');
  return { subject, content };
}

async function upstream(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    throw new DeliveryError('network');
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Return a cached access token, refreshing it only when it is about to expire.
 * Concurrent callers share one in-flight refresh (Zoho allows only 10 refreshes per 10 minutes).
 * @param {object} ctx
 * @param {Record<string,string>} ctx.env
 * @param {{token: null | {value:string, expiresAt:number}, refreshing: null | Promise<string>}} ctx.state per-isolate cache
 * @param {typeof fetch} ctx.fetchImpl
 * @param {() => number} ctx.now
 * @param {boolean} [force] ignore the cached token (after a 401)
 * @returns {Promise<string>}
 */
export async function getAccessToken(ctx, force = false) {
  const { state, now } = ctx;
  if (!force && state.token && now() < state.token.expiresAt - TOKEN_SAFETY_MARGIN_MS) {
    return state.token.value;
  }
  if (!state.refreshing) {
    state.refreshing = refreshAccessToken(ctx).finally(() => { state.refreshing = null; });
  }
  return state.refreshing;
}

async function refreshAccessToken({ env, state, fetchImpl, now }) {
  const body = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const res = await upstream(fetchImpl, `${env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = await readJson(res);
  if (!res.ok || !json || typeof json.access_token !== 'string' || json.error) {
    state.token = null;
    throw new DeliveryError('token_refresh_failed');
  }
  const lifetime = Number(json.expires_in) > 0 ? Number(json.expires_in) : DEFAULT_TOKEN_LIFETIME_S;
  state.token = { value: json.access_token, expiresAt: now() + lifetime * 1000 };
  return state.token.value;
}

function isAccepted(response, json) {
  if (!response.ok) return false;
  if (!json) return false; // never assume success from an unreadable body
  const code = json.status && Number(json.status.code);
  return code === 200 || code === 201;
}

/**
 * Send the inquiry to the fixed business mailbox. Throws DeliveryError unless Zoho
 * explicitly accepts the message.
 * @param {object} ctx { env, state, fetchImpl, now }
 * @param {{name:string,email:string,business:string,message:string}} inquiry
 * @returns {Promise<void>}
 */
export async function sendInquiry(ctx, inquiry) {
  const { env, fetchImpl, now } = ctx;
  const { subject, content } = buildEmail(inquiry, { submittedAt: new Date(now()).toISOString() });
  const url = `${env.ZOHO_MAIL_API_URL}/api/accounts/${encodeURIComponent(env.ZOHO_ACCOUNT_ID)}/messages`;
  const payload = JSON.stringify({
    fromAddress: env.MAIL_FROM,
    toAddress: env.MAIL_TO, // fixed server-side: visitors can never choose the recipient
    subject,
    content,
    mailFormat: 'plaintext',
    encoding: 'UTF-8',
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getAccessToken(ctx, attempt > 0);
    const res = await upstream(fetchImpl, url, {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: payload,
    });
    if (res.status === 401 && attempt === 0) continue; // expired or revoked token: refresh once
    const json = await readJson(res);
    if (isAccepted(res, json)) return;
    throw new DeliveryError(res.ok ? 'send_rejected' : `send_http_${res.status}`);
  }
  throw new DeliveryError('send_unauthorized');
}
