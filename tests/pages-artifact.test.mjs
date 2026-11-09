// GitHub Pages publishing safety: reproduces the documented Jekyll file-selection rules
// (https://docs.github.com/en/pages/setting-up-a-github-pages-site-with-jekyll/about-github-pages-and-jekyll)
// against the exact set of files git would push, and asserts only website files are published.
// This is a model of the build, not the build itself: the real artifact must still be checked
// after the first approved publication (see README.md, "After publishing").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PUBLIC = ['CNAME', 'assets/js/booking-links.js', 'assets/js/site-config.js', 'index.html'];

function readExcludes() {
  const text = readFileSync(join(ROOT, '_config.yml'), 'utf8').replace(/\r\n/g, '\n');
  const block = text.match(/^exclude:\n((?:[ \t]+-[^\n]*\n?)+)/m);
  assert.ok(block, '_config.yml must contain an "exclude:" list');
  return block[1].split('\n').map((l) => l.replace(/^[ \t]+-[ \t]*/, '').replace(/#.*$/, '').trim().replace(/^["']|["']$/g, '').replace(/\/$/, '')).filter(Boolean);
}

function filesGitWouldPush() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean).filter((f) => existsSync(join(ROOT, f)));
}

function publishedByJekyll(files, excludes) {
  return files.filter((f) => {
    const parts = f.split('/');
    if (parts.some((p) => /^[._#]/.test(p) || p.endsWith('~'))) return false; // Jekyll default
    if (parts[0] === 'node_modules' || parts[0] === 'vendor') return false; // Jekyll default
    return !excludes.some((e) => f === e || f.startsWith(`${e}/`));
  }).sort();
}

test('_config.yml exists and excludes the backend, tests and repository docs', () => {
  const excludes = readExcludes();
  for (const must of ['contact-worker', 'tests', 'README.md']) assert.ok(excludes.includes(must), `missing exclude: ${must}`);
});

test('_config.yml sets no theme, plugins or build options that could change the page', () => {
  const text = readFileSync(join(ROOT, '_config.yml'), 'utf8');
  assert.doesNotMatch(text, /^(theme|remote_theme|plugins|baseurl|url|permalink|markdown|include)\s*:/m);
});

test('only intended website files would be published', () => {
  const published = publishedByJekyll(filesGitWouldPush(), readExcludes());
  assert.deepEqual(published, EXPECTED_PUBLIC);
});

test('no published file is Markdown, a test, a Worker file or local configuration', () => {
  for (const f of publishedByJekyll(filesGitWouldPush(), readExcludes())) {
    assert.doesNotMatch(f, /\.(md|mjs|toml|json)$|(^|\/)(test|tests|contact-worker)\//, f);
  }
});
