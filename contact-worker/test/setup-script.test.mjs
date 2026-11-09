// Tests for the one-time Zoho OAuth setup helper (network mocked; no real Zoho calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeAuthorizationCode, findAccountId, SCOPES } from '../scripts/zoho-oauth-setup.mjs';

test('requests only the two scopes the Worker and setup need', () => {
  assert.equal(SCOPES, 'ZohoMail.messages.CREATE,ZohoMail.accounts.READ');
});

test('exchangeAuthorizationCode posts the documented parameters and returns tokens', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, params: new URLSearchParams(init.body) };
    return Response.json({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 });
  };
  const tokens = await exchangeAuthorizationCode({ accountsUrl: 'https://accounts.zoho.test', clientId: 'cid', clientSecret: 'cs', code: 'gc' }, fetchImpl);
  assert.deepEqual(tokens, { refreshToken: 'ref', accessToken: 'acc' });
  assert.equal(seen.url, 'https://accounts.zoho.test/oauth/v2/token');
  assert.equal(seen.params.get('grant_type'), 'authorization_code');
  assert.equal(seen.params.get('code'), 'gc');
  assert.equal(seen.params.get('client_id'), 'cid');
  assert.equal(seen.params.get('client_secret'), 'cs');
});

test('exchangeAuthorizationCode explains an expired grant code', async () => {
  const fetchImpl = async () => Response.json({ error: 'invalid_code' });
  await assert.rejects(
    exchangeAuthorizationCode({ accountsUrl: 'https://a.test', clientId: 'c', clientSecret: 's', code: 'old' }, fetchImpl),
    /invalid_code.*expire/s,
  );
});

test('findAccountId picks the business mailbox among several accounts', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://mail.zoho.test/api/accounts');
    assert.equal(init.headers.Authorization, 'Zoho-oauthtoken acc');
    return Response.json({ status: { code: 200 }, data: [
      { accountId: '111', primaryEmailAddress: 'someone@example.com' },
      { accountId: '222', primaryEmailAddress: 'Contact@Xiomics.Systems' },
    ] });
  };
  assert.equal(await findAccountId({ mailApiUrl: 'https://mail.zoho.test', accessToken: 'acc', mailbox: 'contact@xiomics.systems' }, fetchImpl), '222');
});

test('findAccountId fails clearly when the mailbox is not on this token', async () => {
  const fetchImpl = async () => Response.json({ status: { code: 200 }, data: [{ accountId: '1', primaryEmailAddress: 'other@example.com' }] });
  await assert.rejects(findAccountId({ mailApiUrl: 'https://m.test', accessToken: 'a', mailbox: 'contact@xiomics.systems' }, fetchImpl), /No Zoho Mail account/);
});
