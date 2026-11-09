// Unit tests for assets/js/booking-links.js: applies the single central booking URL
// (assets/js/site-config.js) to every [data-booking-link] and enforces safe new-tab behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const booking = require('../assets/js/booking-links.js');

function fakeLink(attrs = {}) {
  const map = new Map(Object.entries(attrs));
  return { getAttribute: (k) => (map.has(k) ? map.get(k) : null), setAttribute: (k, v) => map.set(k, String(v)), attrs: map };
}
const fakeDoc = (links) => ({ querySelectorAll: (sel) => (sel === 'a[data-booking-link]' ? links : []) });

test('site-config.js defines a safe Topmate booking URL', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../assets/js/site-config.js', import.meta.url), 'utf8'), sandbox);
  assert.ok(booking.isSafeBookingUrl(sandbox.window.XIOMICS_SITE.bookingUrl), sandbox.window.XIOMICS_SITE.bookingUrl);
  assert.equal(sandbox.window.XIOMICS_SITE.contactEmail, 'contact@xiomics.systems');
  assert.ok(Object.isFrozen(sandbox.window.XIOMICS_SITE));
});

test('applies the configured URL to every booking link and opens it safely in a new tab', () => {
  const links = [fakeLink({ href: 'https://topmate.io/muhammad_dayan/2397800' }), fakeLink({ href: 'https://topmate.io/muhammad_dayan/2397800' })];
  const n = booking.apply(fakeDoc(links), { bookingUrl: 'https://topmate.io/muhammad_dayan/discovery-call' });
  assert.equal(n, 2);
  for (const l of links) {
    assert.equal(l.getAttribute('href'), 'https://topmate.io/muhammad_dayan/discovery-call');
    assert.equal(l.getAttribute('target'), '_blank');
    assert.equal(l.getAttribute('rel'), 'noopener noreferrer');
  }
});

test('an unsafe or missing URL never replaces the working fallback link', () => {
  for (const bad of [undefined, '', 'http://topmate.io/x', 'javascript:alert(1)', 'https://evil.example/topmate.io', 'https://topmate.io.evil.example/x', 'https://topmate.io/x?<script>']) {
    const link = fakeLink({ href: 'https://topmate.io/muhammad_dayan/2397800' });
    booking.apply(fakeDoc([link]), { bookingUrl: bad });
    assert.equal(link.getAttribute('href'), 'https://topmate.io/muhammad_dayan/2397800', String(bad));
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  }
});

test('isSafeBookingUrl accepts only https Topmate pages', () => {
  assert.equal(booking.isSafeBookingUrl('https://topmate.io/muhammad_dayan/2397800'), true);
  assert.equal(booking.isSafeBookingUrl('https://topmate.io/muhammad_dayan'), true);
  assert.equal(booking.isSafeBookingUrl('https://topmate.io'), false);
  assert.equal(booking.isSafeBookingUrl('https://topmate.io/a b'), false);
});
