// Server-side validation for contact inquiries. This is the authoritative check.
// The (deferred) browser copy lives in contact-worker/client/contact-form.js; both are tested
// against contact-worker/test/fixtures/inquiry-vectors.json so their rules cannot drift apart.

export const LIMITS = Object.freeze({
  name: { max: 100 },
  email: { max: 254 },
  business: { max: 120 },
  message: { min: 10, max: 5000 },
});

// Single-line fields reject every C0/C1 control character, DEL and Unicode line/paragraph
// separator (this blocks CR/LF header injection), plus zero-width space, BOM and the
// bidirectional embedding/override/isolate controls that can visually spoof what the owner reads.
// Zero-width non-joiner/joiner (U+200C/U+200D) stay allowed: Urdu and Persian text needs them.
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u{200B}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]/u;
// The message may contain newlines and tabs, but no other control or bidi-override characters.
const MULTI_LINE_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;
const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const EMAIL_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

// Only strings (and finite numbers) count as text; objects/arrays/booleans become '' → "required".
const asText = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

function isValidEmail(address) {
  const at = address.lastIndexOf('@');
  if (at < 1 || at !== address.indexOf('@')) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || !EMAIL_LOCAL.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => EMAIL_LABEL.test(l))) return false;
  return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]);
}

function checkSingleLine(value, { max }) {
  if (value.length === 0) return 'required';
  if (SINGLE_LINE_FORBIDDEN.test(value)) return 'invalid_characters';
  if (value.length > max) return 'too_long';
  return null;
}

/**
 * Validate and normalise an inquiry.
 * @param {Record<string, unknown>} input raw fields (from JSON or form data)
 * @returns {{ ok: boolean, errors: Record<string,string>, value: {name:string,email:string,business:string,message:string} }}
 */
export function validateInquiry(input = {}) {
  const value = {
    name: asText(input.name).trim(),
    email: asText(input.email).trim(),
    business: asText(input.business).trim(),
    message: asText(input.message).replace(/\r\n?/g, '\n').trim(),
  };
  const errors = {};

  const nameError = checkSingleLine(value.name, LIMITS.name);
  if (nameError) errors.name = nameError;

  if (value.email.length === 0) errors.email = 'required';
  else if (value.email.length > LIMITS.email.max) errors.email = 'too_long';
  else if (SINGLE_LINE_FORBIDDEN.test(value.email) || /\s/.test(value.email) || !isValidEmail(value.email)) errors.email = 'invalid_email';

  const businessError = checkSingleLine(value.business, LIMITS.business);
  if (businessError) errors.business = businessError;

  if (value.message.length === 0) errors.message = 'required';
  else if (MULTI_LINE_FORBIDDEN.test(value.message)) errors.message = 'invalid_characters';
  else if (value.message.length < LIMITS.message.min) errors.message = 'too_short';
  else if (value.message.length > LIMITS.message.max) errors.message = 'too_long';

  return { ok: Object.keys(errors).length === 0, errors, value };
}
