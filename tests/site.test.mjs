// Static acceptance checks for index.html (Phase 1.5: positioning, five service pillars,
// Topmate booking as the primary conversion, no contact form, no backend dependency).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&rsquo;|&#39;/g, "'");
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const visible = stripTags(html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, ''));

const BOOKING_URL = 'https://topmate.io/muhammad_dayan/2397800';
const PRIMARY_CTA = 'Book a Free Discovery Call';

const attr = (tagText, name) => {
  const m = tagText.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
};
const anchors = [...html.matchAll(/<a\s[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
const openTag = (a) => a.match(/<a\s[^>]*>/)[0];
const bookingLinks = anchors.filter((a) => /\sdata-booking-link(\s|>|=)/.test(openTag(a)));

describe('navigation integrity and landmarks', () => {
  test('every in-page link points at an element that exists', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const targets = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    assert.ok(targets.length > 5);
    for (const t of targets) assert.ok(ids.has(t), `broken anchor #${t}`);
  });

  test('no empty or javascript: links', () => {
    assert.doesNotMatch(html, /href=""/);
    assert.doesNotMatch(html, /href="javascript:/i);
  });

  test('mobile menu toggle exposes its state', () => {
    const btn = html.match(/<button id="hamburger"[^>]*>/)[0];
    assert.equal(attr(btn, 'aria-controls'), 'mobile-menu');
    assert.equal(attr(btn, 'aria-expanded'), 'false');
  });

  test('page has exactly one <main> landmark and one h1', () => {
    assert.equal((html.match(/<main[\s>]/g) || []).length, 1);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  });

  test('headings never skip a level', () => {
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    for (let i = 1; i < levels.length; i += 1) assert.ok(levels[i] - levels[i - 1] <= 1, `h${levels[i - 1]} → h${levels[i]}`);
  });
});

describe('positioning', () => {
  test('title states the AI automation & digital transformation positioning', () => {
    const title = decode(html.match(/<title>([^<]*)<\/title>/)[1]);
    assert.match(title, /AI Automation & Digital Transformation/);
  });

  test('hero carries the brand message', () => {
    assert.ok(visible.includes('We build intelligent AI systems and automated workflows that help businesses reduce repetitive work, streamline operations, improve customer experiences, and grow digitally.'));
  });
});

describe('five service pillars', () => {
  const pillars = {
    'AI Voice Agents': ['Inbound', 'Outbound', 'AI receptionists', 'Lead qualification', 'Appointment scheduling', 'follow-ups', 'Call routing', 'After-hours'],
    'AI & Business Workflow Automation': ['CRM', 'WhatsApp', 'Customer onboarding', 'Document and data processing', 'API integrations', 'Cross-platform', 'administrative'],
    'Custom AI Agents & Assistants': ['research agents', 'knowledge assistants', 'Internal AI assistants', 'Document Q&A', 'document extraction', 'Multi-step AI workflows'],
    'Small Business Digital Transformation': ['websites', 'landing pages', 'catalogs', 'Booking and appointment', 'Lead capture forms', 'WhatsApp Business', 'Google Business Profile', 'CRM', 'enquiry'],
    'Data Analytics & Business Intelligence': ['Data cleaning', 'dashboards', 'KPI reporting', 'Automated business reports', 'insights', 'Business intelligence'],
  };
  const headings = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => stripTags(m[1]).trim());

  for (const [name, items] of Object.entries(pillars)) {
    test(`"${name}" is a service with its key offerings`, () => {
      assert.ok(headings.includes(name), `missing h3 "${name}" in ${JSON.stringify(headings)}`);
      const start = html.indexOf(`data-pillar="${name.replace(/&/g, '&amp;')}"`);
      assert.ok(start > -1, `missing data-pillar for ${name}`);
      const card = stripTags(html.slice(start, html.indexOf('</article>', start)));
      for (const item of items) assert.ok(card.toLowerCase().includes(item.toLowerCase()), `${name}: missing "${item}"`);
    });
  }

  test('supporting capabilities are listed', () => {
    for (const s of ['Automation audits', 'System integrations', 'Workflow optimization', 'Ongoing maintenance']) {
      assert.ok(visible.includes(s), s);
    }
  });

  test('positioned broadly, not as a single-tool agency', () => {
    assert.doesNotMatch(visible, /\bn8n\b/i);
    assert.doesNotMatch(visible, /chatbot agency|voice[- ]agent agency/i);
  });
});

describe('Topmate booking is the primary conversion', () => {
  test('booking links exist across the page (nav, mobile menu, hero, services, banner, contact, footer)', () => {
    assert.ok(bookingLinks.length >= 10, `only ${bookingLinks.length} booking links`);
  });

  test('every booking link opens the Topmate discovery-call service in a new tab safely', () => {
    for (const a of bookingLinks) {
      const tag = openTag(a);
      assert.equal(attr(tag, 'href'), BOOKING_URL, tag);
      assert.equal(attr(tag, 'target'), '_blank', tag);
      const rel = (attr(tag, 'rel') || '').split(/\s+/);
      assert.ok(rel.includes('noopener') && rel.includes('noreferrer'), tag);
    }
  });

  test('every link that opens a new tab has rel="noopener noreferrer"', () => {
    for (const a of anchors.filter((x) => /target="_blank"/.test(openTag(x)))) {
      const rel = (attr(openTag(a), 'rel') || '').split(/\s+/);
      assert.ok(rel.includes('noopener') && rel.includes('noreferrer'), openTag(a));
    }
  });

  test('new-tab booking links say so to screen-reader users', () => {
    for (const a of bookingLinks) assert.match(stripTags(a), /opens in a new tab/i, openTag(a));
  });

  test(`the primary CTA reads "${PRIMARY_CTA}" in the nav, hero and contact section`, () => {
    for (const id of ['nav-cta', 'hero-cta-primary', 'contact-cta']) {
      const a = anchors.find((x) => attr(openTag(x), 'id') === id);
      assert.ok(a, `missing #${id}`);
      assert.ok(bookingLinks.includes(a), `#${id} is not a booking link`);
      assert.ok(stripTags(a).includes(PRIMARY_CTA), `#${id}: ${stripTags(a)}`);
    }
  });

  test('no leftover audit/booking wording from earlier versions', () => {
    assert.doesNotMatch(visible, /Request a Free Audit|Request Your Free Audit|Book a Free Audit|Book Audit|Send Inquiry/i);
  });

  test('one central booking configuration, loaded before the script that applies it', () => {
    const cfgPath = join(ROOT, 'assets', 'js', 'site-config.js');
    assert.ok(existsSync(cfgPath));
    const cfg = readFileSync(cfgPath, 'utf8');
    assert.match(cfg, /bookingUrl:\s*'https:\/\/topmate\.io\/muhammad_dayan[^']*'/);
    const cfgAt = html.indexOf('<script src="assets/js/site-config.js"');
    const applyAt = html.indexOf('<script src="assets/js/booking-links.js"');
    assert.ok(cfgAt > -1 && applyAt > cfgAt, 'site-config.js must load before booking-links.js');
  });
});

describe('contact without a form or backend', () => {
  test('there is no form or form field on the page', () => {
    assert.doesNotMatch(html, /<form[\s>]/i);
    assert.doesNotMatch(html, /<(input|textarea|select)[\s>]/i);
  });

  test('the business email stays available as a secondary contact', () => {
    const mailtos = [...html.matchAll(/href="mailto:([^"?]+)/g)].map((m) => m[1]);
    assert.ok(mailtos.length >= 2, 'email link in contact section and footer');
    for (const m of mailtos) assert.equal(m, 'contact@xiomics.systems');
    const contact = html.slice(html.indexOf('id="contact"'), html.indexOf('</section>', html.indexOf('id="contact"')));
    assert.match(contact, /href="mailto:contact@xiomics\.systems"/);
    assert.match(contact, /data-booking-link/);
  });

  test('nothing on the page depends on the deferred contact Worker', () => {
    for (const needle of ['contact-form.js', 'data-endpoint', 'workers.dev', 'contact-worker', 'fetch(', 'cf-turnstile']) {
      assert.ok(!html.includes(needle), `index.html references ${needle}`);
    }
    for (const f of ['site-config.js', 'booking-links.js']) {
      const js = readFileSync(join(ROOT, 'assets', 'js', f), 'utf8');
      assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|sendBeacon|workers\.dev/);
    }
    assert.ok(!existsSync(join(ROOT, 'assets', 'js', 'contact-form.js')), 'deferred form module must not ship with the site');
  });

  test('approved wording: no fixed reply-time promise, no implied client portfolio, optional ongoing support', () => {
    assert.doesNotMatch(visible, /within 24 hours|every caller|runs on its own|open-ended|different sizes and industries|work with companies/i);
    assert.ok(visible.includes('Contact us to discuss your business requirements.'));
    assert.ok(visible.includes('We build tailored solutions for businesses across different industries, from small businesses to growing teams.'));
    assert.ok(visible.includes('Handle incoming calls, answer common enquiries, qualify leads, and route conversations according to your business requirements.'));
    assert.ok(visible.includes('Automate repetitive tasks so routine business operations require less manual effort.'));
    assert.ok(visible.includes('Clear project scope, agreed milestones, and defined deliverables.'));
    assert.match(visible, /optional ongoing support services, available separately and not automatically included in every project/);
    assert.ok(visible.includes('Serving Businesses Internationally') && visible.includes('Remote-First Delivery'));
  });

  test('no message ever claims to have been sent', () => {
    assert.doesNotMatch(visible, /message sent|we'll reach out|has been sent/i);
  });
});

describe('unsupported marketing claims are absent', () => {
  for (const phrase of ['10x', '300%', 'Lead Growth', 'AI Uptime', '24/7', 'Most Popular', 'Proven', 'guarantee',
    'faster-growing', 'focused exclusively', 'as little as', '100%', 'exactly which', 'No templates', 'highest ROI']) {
    test(`"${phrase}" is not on the page`, () => assert.ok(!visible.toLowerCase().includes(phrase.toLowerCase()), phrase));
  }
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
    assert.ok(!files.some((f) => f.endsWith('.dev.vars')), '.dev.vars must never be committed');
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
