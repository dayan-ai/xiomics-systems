#!/usr/bin/env node
// One-time helper: turns a Zoho "Self Client" grant code into the Worker secrets.
// Run it on your own machine after `npx wrangler login`:   node scripts/zoho-oauth-setup.mjs
// It never writes secrets to disk. With your confirmation it stores them via
// `wrangler secret put`, which reads each value from stdin.
// Zoho docs: https://www.zoho.com/accounts/protocol/oauth/self-client/authorization-code-flow.html
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SCOPES = 'ZohoMail.messages.CREATE,ZohoMail.accounts.READ';

/**
 * Exchange a self-client grant code for tokens.
 * @returns {Promise<{refreshToken: string, accessToken: string}>}
 */
export async function exchangeAuthorizationCode({ accountsUrl, clientId, clientSecret, code }, fetchImpl = fetch) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code });
  const res = await fetchImpl(`${accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.error || !json.refresh_token || !json.access_token) {
    const reason = json && json.error ? String(json.error) : `HTTP ${res.status}`;
    throw new Error(`Zoho did not issue a refresh token (${reason}). Grant codes expire after about 2-3 minutes; generate a new one and retry.`);
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token };
}

/**
 * Find the Zoho Mail accountId whose primary address is the business mailbox.
 * @returns {Promise<string>}
 */
export async function findAccountId({ mailApiUrl, accessToken, mailbox }, fetchImpl = fetch) {
  const res = await fetchImpl(`${mailApiUrl}/api/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: 'application/json' },
  });
  const json = await res.json().catch(() => null);
  const accounts = json && Array.isArray(json.data) ? json.data : [];
  const wanted = mailbox.toLowerCase();
  const match = accounts.find((a) => String(a.primaryEmailAddress || '').toLowerCase() === wanted
    || (Array.isArray(a.emailAddress) && a.emailAddress.some((e) => String(e.mailId || '').toLowerCase() === wanted)));
  if (!res.ok || !match || !match.accountId) {
    throw new Error(`No Zoho Mail account for ${mailbox} was found with this token (HTTP ${res.status}).`);
  }
  return String(match.accountId);
}

function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    // Fixed arguments only; the secret travels over stdin, never on the command line.
    const child = spawn('npx', ['wrangler@4', 'secret', 'put', name], {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.stdin.on('error', (err) => reject(new Error(`could not pass ${name} to wrangler (${err.code || 'stdin error'})`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`wrangler secret put ${name} exited with ${code}`))));
    child.stdin.end(value);
  });
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const accountsUrl = 'https://accounts.zoho.com';
  const mailApiUrl = 'https://mail.zoho.com';
  const mailbox = 'contact@xiomics.systems';
  console.log(`\nIn https://api-console.zoho.com → Self Client → "Generate Code", use scope:\n  ${SCOPES}\n`);
  console.log('Note: what you paste below is visible on screen. Run this on your own computer, and clear the');
  console.log('terminal afterwards (Windows: cls, macOS/Linux: clear).\n');
  const clientId = (await rl.question('Client ID: ')).trim();
  const clientSecret = (await rl.question('Client Secret: ')).trim();
  const code = (await rl.question('Generated code (use it within 2 minutes): ')).trim();

  const { refreshToken, accessToken } = await exchangeAuthorizationCode({ accountsUrl, clientId, clientSecret, code });
  const accountId = await findAccountId({ mailApiUrl, accessToken, mailbox });
  console.log(`\nFound Zoho Mail account for ${mailbox}.`);

  const answer = (await rl.question('Store the 4 values as Cloudflare Worker secrets now? (y/N) ')).trim().toLowerCase();
  rl.close();
  const secrets = { ZOHO_CLIENT_ID: clientId, ZOHO_CLIENT_SECRET: clientSecret, ZOHO_REFRESH_TOKEN: refreshToken, ZOHO_ACCOUNT_ID: accountId };
  if (answer !== 'y') {
    console.log('\nNothing was stored. Re-run this script when you are ready; the grant code must be regenerated.');
    return;
  }
  for (const [name, value] of Object.entries(secrets)) {
    await putSecret(name, value);
  }
  console.log('\nAll four secrets are stored in Cloudflare. Nothing was written to disk.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`\nSetup failed: ${err.message}`);
    process.exitCode = 1;
  });
}
