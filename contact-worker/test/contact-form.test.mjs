// Unit tests for the DEFERRED browser contact-form module (contact-worker/client/contact-form.js).
// It is not used by the live site (Topmate booking replaced the form) but is kept, tested, for reuse.
// The module is a dependency-free UMD script; Node loads it via require().
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const form = require('../client/contact-form.js');

describe('validateInquiry matches the shared server vectors', () => {
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
      const result = form.validateInquiry(input);
      assert.equal(result.ok, c.ok);
      assert.deepEqual(result.errors, c.errors);
    });
  }

  test('returns trimmed, normalised values', () => {
    const r = form.validateInquiry({ name: '  Ada ', email: ' ada@example.com ', business: ' Acme ', message: ' Line one here\r\nLine two ' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { name: 'Ada', email: 'ada@example.com', business: 'Acme', message: 'Line one here\nLine two' });
  });
});

describe('error messages', () => {
  test('every field/code combination has human-readable text', () => {
    for (const field of ['name', 'email', 'business', 'message']) {
      for (const code of ['required', 'too_long', 'too_short', 'invalid_email', 'invalid_characters']) {
        const text = form.errorText(field, code);
        assert.equal(typeof text, 'string');
        assert.ok(text.length > 5, `${field}/${code}`);
      }
    }
  });
});

describe('getMode', () => {
  test('https endpoint → api', () => assert.equal(form.getMode('https://xiomics-contact.example.workers.dev/api/contact'), 'api'));
  test('mailto action → mailto', () => assert.equal(form.getMode('mailto:contact@xiomics.systems'), 'mailto'));
  test('missing or unsafe action → none', () => {
    assert.equal(form.getMode(''), 'none');
    assert.equal(form.getMode(null), 'none');
    assert.equal(form.getMode('http://insecure.example/api'), 'none');
    assert.equal(form.getMode('javascript:alert(1)'), 'none');
  });
});

describe('buildMailtoUrl', () => {
  const inquiry = { name: 'Ada Lovelace', email: 'ada@example.com', business: 'Acme & Co', message: 'Line one\nLine two?' };

  test('targets the business mailbox with an encoded subject and body', () => {
    const url = form.buildMailtoUrl('contact@xiomics.systems', inquiry);
    assert.ok(url.startsWith('mailto:contact@xiomics.systems?subject='));
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    assert.equal(params.get('subject'), 'Website inquiry — Acme & Co');
    const body = params.get('body');
    assert.match(body, /Line one\r\nLine two\?/);
    assert.match(body, /Name: Ada Lovelace/);
    assert.match(body, /Email: ada@example\.com/);
  });

  test('stays within a safe URL length by shortening long messages', () => {
    const url = form.buildMailtoUrl('contact@xiomics.systems', { ...inquiry, message: 'word '.repeat(2000) });
    assert.ok(url.length <= 1900, `length ${url.length}`);
    assert.match(decodeURIComponent(url), /shortened/i);
  });
});

describe('interpretResponse never reports success without server confirmation', () => {
  test('200 + {ok:true} → success', () => assert.equal(form.interpretResponse(200, { ok: true }).state, 'success'));
  test('200 + duplicate → success', () => assert.equal(form.interpretResponse(200, { ok: true, duplicate: true }).state, 'success'));
  test('200 without ok:true → error', () => assert.equal(form.interpretResponse(200, {}).state, 'error'));
  test('200 with unparseable body → error', () => assert.equal(form.interpretResponse(200, null).state, 'error'));
  test('400 validation → invalid with fields', () => {
    const r = form.interpretResponse(400, { ok: false, error: 'validation', fields: { email: 'invalid_email' } });
    assert.equal(r.state, 'invalid');
    assert.deepEqual(r.fields, { email: 'invalid_email' });
  });
  test('429 → rate_limited', () => assert.equal(form.interpretResponse(429, { error: 'rate_limited' }).state, 'rate_limited'));
  test('422 too_fast → too_fast (ask the person to resend, never success)', () => assert.equal(form.interpretResponse(422, { ok: false, error: 'too_fast' }).state, 'too_fast'));
  test('502 → error', () => assert.equal(form.interpretResponse(502, { error: 'delivery_failed' }).state, 'error'));
  test('503 → unavailable', () => assert.equal(form.interpretResponse(503, { error: 'not_configured' }).state, 'unavailable'));
  test('403 → error', () => assert.equal(form.interpretResponse(403, { error: 'verification_failed' }).state, 'error'));
});
