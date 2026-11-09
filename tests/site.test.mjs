// Static acceptance checks for index.html (Phase 1: honest, functional, conversion-ready).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const visible = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');

function tag(re) {
  const m = html.match(re);
  assert.ok(m, `missing: ${re}`);
  return m[0];
}
const attr = (tagText, name) => {
  const m = tagText.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
};

describe('navigation integrity', () => {
  test('every in-page link points at an element that exists', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const targets = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    assert.ok(targets.length > 5);
    for (const t of targets) assert.ok(ids.has(t), `broken anchor #${t}`);
  });

  test('every mailto link targets the confirmed business mailbox', () => {
    const mailtos = [...html.matchAll(/(?:href|action)="mailto:([^"?]+)/g)].map((m) => m[1]);
    assert.ok(mailtos.length >= 2);
    for (const m of mailtos) assert.equal(m, 'contact@xiomics.systems');
  });

  test('no empty or javascript: links', () => {
    assert.doesNotMatch(html, /href=""/);
    assert.doesNotMatch(html, /href="javascript:/i);
  });

  test('mobile menu toggle exposes its state', () => {
    const btn = tag(/<button id="hamburger"[^>]*>/);
    assert.equal(attr(btn, 'aria-controls'), 'mobile-menu');
    assert.equal(attr(btn, 'aria-expanded'), 'false');
  });
});

describe('no booking promises without a booking system', () => {
  test('no "Book …" CTA wording remains', () => {
    assert.doesNotMatch(visible, /\bBook (a |your )?free/i);
    assert.doesNotMatch(visible, /Book Audit|Book Your Free|Book a Free/i);
  });
});

describe('unsupported marketing claims are gone', () => {
  for (const phrase of ['10x', '300%', 'Lead Growth', 'AI Uptime', 'Most Popular', 'Proven ROI', 'faster-growing',
    'focused exclusively', 'as little as 2 weeks', '100% value', 'exactly which']) {
    test(`"${phrase}" is not on the page`, () => assert.ok(!visible.includes(phrase), phrase));
  }
});

describe('functional defects fixed', () => {
  test('no hover-only "Learn more" pseudo-links remain', () => {
    assert.doesNotMatch(visible, /Learn more/);
  });

  test('each service card has a real link to the inquiry form', () => {
    const links = [...html.matchAll(/<a [^>]*data-service="([^"]+)"[^>]*>/g)];
    assert.equal(links.length, 3);
    for (const l of links) assert.equal(attr(l[0], 'href'), '#contact');
  });

  test('the LinkedIn logo is no longer used as the ROI icon', () => {
    assert.ok(!html.includes('M16 8a6 6 0 016 6v7'));
  });

  test('footer link row can wrap on narrow screens', () => {
    assert.match(html, /<div class="[^"]*flex-wrap[^"]*"[^>]*>\s*<a href="#services"/);
  });
});

describe('contact form is honest and accessible', () => {
  const formTag = tag(/<form id="contact-form"[^>]*>/);

  test('without JavaScript the form opens an email to the business mailbox — never nowhere', () => {
    assert.equal(attr(formTag, 'action'), 'mailto:contact@xiomics.systems');
    assert.equal(attr(formTag, 'method'), 'post');
  });

  test('the optional backend endpoint, if set, is https', () => {
    const endpoint = attr(formTag, 'data-endpoint');
    assert.ok(endpoint === null || endpoint === '' || /^https:\/\/\S+$/.test(endpoint), `data-endpoint=${endpoint}`);
  });

  test('the fake-success simulation is gone', () => {
    assert.ok(!html.includes('Simulate network'));
    assert.ok(!/setTimeout\(r,\s*1500\)/.test(html));
  });

  for (const [id, max] of [['name', '100'], ['email', '254'], ['business', '120'], ['message', '5000']]) {
    test(`#${id} is labelled, named, length-limited and wired to an error message`, () => {
      const field = tag(new RegExp(`<(input|textarea) id="${id}"[^>]*>`));
      assert.equal(attr(field, 'name'), id);
      assert.equal(attr(field, 'maxlength'), max);
      assert.ok(html.includes(`<label for="${id}"`), `label for ${id}`);
      const describedBy = attr(field, 'aria-describedby');
      assert.ok(describedBy, `aria-describedby on ${id}`);
      for (const ref of describedBy.split(/\s+/)) assert.ok(html.includes(`id="${ref}"`), `missing #${ref}`);
    });
  }

  test('honeypot field is hidden from people and assistive technology, and not an autofill target', () => {
    const hp = tag(/<input id="xs-hp"[^>]*>/);
    assert.equal(attr(hp, 'name'), 'xs_hp');
    assert.equal(attr(hp, 'tabindex'), '-1');
    assert.equal(attr(hp, 'autocomplete'), 'off');
    assert.match(html, /<div class="hp-field" aria-hidden="true">[\s\S]*?<input id="xs-hp"/);
    assert.ok(!/name="website"/.test(html), 'a "website" field name invites browser autofill');
  });

  test('form status is announced through a live region', () => {
    const status = tag(/<div id="form-status"[^>]*>/);
    assert.equal(attr(status, 'aria-live'), 'polite');
  });

  test('the contact-form script is included and exists', () => {
    assert.match(html, /<script src="assets\/js\/contact-form\.js" defer><\/script>/);
    assert.ok(existsSync(join(ROOT, 'assets', 'js', 'contact-form.js')));
  });

  test('a privacy note sits with the form', () => {
    assert.match(visible, /only to (reply|respond) to your inquiry/i);
  });
});

describe('no secrets committed', () => {
  const SKIP = new Set(['.git', 'node_modules', '.wrangler']);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p); else files.push(p);
    }
  };
  walk(ROOT);

  test('no .dev.vars file with real values exists in the tree', () => {
    assert.ok(!files.some((f) => f.endsWith(`${'.dev.vars'}`)), '.dev.vars must never be committed');
  });

  test('no Zoho token or credential-shaped values in any file', () => {
    const patterns = [
      /\b1000\.[a-f0-9]{32}\.[a-f0-9]{32}\b/, // Zoho refresh / access token shape
      /\b1000\.[A-Z0-9]{30,}\b/, // Zoho client id shape
      /client_secret\s*[=:]\s*["']?[a-f0-9]{30,}/i, // literal Zoho client secret assignment
    ];
    for (const f of files) {
      if (/\.(png|jpe?g|gif|ico|woff2?)$/i.test(f)) continue;
      const text = readFileSync(f, 'utf8');
      for (const p of patterns) assert.doesNotMatch(text, p, `${f} matches ${p}`);
    }
  });
});
