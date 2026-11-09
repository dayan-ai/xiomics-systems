/*!
 * Xiomics Systems contact form: progressive enhancement, no dependencies.
 *
 * STATUS: DEFERRED. Not loaded by the website. Bookings go through Topmate (see ../../README.md).
 * Kept with its tests for possible future reuse together with the contact Worker in this folder.
 *
 * Configuration lives on the <form>:
 *   action="mailto:contact@xiomics.systems"   always; without JavaScript the browser opens an email.
 *   data-endpoint absent/empty                 → email mode: opens the visitor's email app with the
 *                                                inquiry prefilled. Never claims the message was sent.
 *   data-endpoint="https://…/api/contact"      → API mode: POSTs JSON to the contact Worker and shows
 *                                                success ONLY when the server confirms delivery.
 * Validation rules mirror contact-worker/src/validation.js (shared test vectors keep them in sync).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.XiomicsContactForm = api;
    api.autoInit(root.document);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = { name: 100, email: 254, business: 120, messageMin: 10, messageMax: 5000 };
  var REQUEST_TIMEOUT_MS = 15000;
  var MAILTO_MAX_LENGTH = 1900;
  // Same character rules as the server (see contact-worker/src/validation.js for the rationale).
  var SINGLE_LINE_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u{200B}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]/u;
  var MULTI_LINE_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;
  var EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  var EMAIL_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
  var FIELDS = ['name', 'email', 'business', 'message'];

  var FIELD_LABEL = { name: 'your name', email: 'your email address', business: 'your business name', message: 'a short description of what you need' };
  var MAX_FOR = { name: LIMITS.name, email: LIMITS.email, business: LIMITS.business, message: LIMITS.messageMax };

  function asText(v) { return typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : ''; }

  function isValidEmail(address) {
    var at = address.lastIndexOf('@');
    if (at < 1 || at !== address.indexOf('@')) return false;
    var local = address.slice(0, at);
    var labels = address.slice(at + 1).split('.');
    if (local.length > 64 || !EMAIL_LOCAL.test(local)) return false;
    if (labels.length < 2) return false;
    for (var i = 0; i < labels.length; i += 1) if (!EMAIL_LABEL.test(labels[i])) return false;
    return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]);
  }

  function checkSingleLine(value, max) {
    if (value.length === 0) return 'required';
    if (SINGLE_LINE_FORBIDDEN.test(value)) return 'invalid_characters';
    if (value.length > max) return 'too_long';
    return null;
  }

  /** Same rules and error codes as the server. */
  function validateInquiry(input) {
    input = input || {};
    var value = {
      name: asText(input.name).trim(),
      email: asText(input.email).trim(),
      business: asText(input.business).trim(),
      message: asText(input.message).replace(/\r\n?/g, '\n').trim(),
    };
    var errors = {};
    var e = checkSingleLine(value.name, LIMITS.name);
    if (e) errors.name = e;
    if (value.email.length === 0) errors.email = 'required';
    else if (value.email.length > LIMITS.email) errors.email = 'too_long';
    else if (SINGLE_LINE_FORBIDDEN.test(value.email) || /\s/.test(value.email) || !isValidEmail(value.email)) errors.email = 'invalid_email';
    e = checkSingleLine(value.business, LIMITS.business);
    if (e) errors.business = e;
    if (value.message.length === 0) errors.message = 'required';
    else if (MULTI_LINE_FORBIDDEN.test(value.message)) errors.message = 'invalid_characters';
    else if (value.message.length < LIMITS.messageMin) errors.message = 'too_short';
    else if (value.message.length > LIMITS.messageMax) errors.message = 'too_long';
    return { ok: Object.keys(errors).length === 0, errors: errors, value: value };
  }

  function errorText(field, code) {
    switch (code) {
      case 'required': return 'Please enter ' + FIELD_LABEL[field] + '.';
      case 'too_long': return 'Please shorten this to ' + MAX_FOR[field] + ' characters or fewer.';
      case 'too_short': return 'Please add a little more detail (at least ' + LIMITS.messageMin + ' characters).';
      case 'invalid_email': return 'Please enter a valid email address, for example name@company.com.';
      case 'invalid_characters': return 'Please remove unsupported characters such as line breaks or symbols.';
      default: return 'Please check this field.';
    }
  }

  /** 'api' for an https endpoint, 'mailto' for a mailto: action, otherwise 'none'. */
  function getMode(action) {
    var a = asText(action).trim();
    if (/^https:\/\/[^\s]+$/i.test(a)) return 'api';
    if (/^mailto:[^\s?]+@[^\s?]+/i.test(a)) return 'mailto';
    return 'none';
  }

  /** Prefilled email for the visitor's own email app. Shortens long messages to stay within URL limits. */
  function buildMailtoUrl(to, inquiry) {
    var subject = 'Website inquiry — ' + inquiry.business;
    var tail = '\n\nName: ' + inquiry.name + '\nEmail: ' + inquiry.email + '\nBusiness: ' + inquiry.business;
    var message = inquiry.message;
    var make = function (msg) {
      var body = ('Hi Xiomics Systems,\n\n' + msg + tail).replace(/\n/g, '\r\n');
      return 'mailto:' + to + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    };
    var url = make(message);
    var note = '\n[Message shortened to fit your email app — please paste the rest before sending.]';
    while (url.length > MAILTO_MAX_LENGTH && message.length > 0) {
      message = message.slice(0, Math.max(0, Math.floor(message.length * 0.85)));
      url = make(message + '…' + note);
    }
    return url;
  }

  /** Map an HTTP result to a UI state. Success requires an explicit {ok:true} from the server. */
  function interpretResponse(status, body) {
    if (status >= 200 && status < 300 && body && body.ok === true) return { state: 'success' };
    if (status === 400 && body && body.error === 'validation' && body.fields) return { state: 'invalid', fields: body.fields };
    if (status === 422 && body && body.error === 'too_fast') return { state: 'too_fast' };
    if (status === 429) return { state: 'rate_limited' };
    if (status === 503) return { state: 'unavailable' };
    return { state: 'error' };
  }

  function newSubmissionId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function initContactForm(form) {
    if (!form || form.__xiomicsContactReady) return null;
    form.__xiomicsContactReady = true;
    var doc = form.ownerDocument;
    var ui = {
      submit: form.querySelector('[type="submit"]'),
      label: doc.getElementById('submit-label'),
      hint: doc.getElementById('form-mode-hint'),
      status: doc.getElementById('form-status'),
      honeypot: form.querySelector('#xs-hp'),
    };
    var fallbackEmail = form.getAttribute('data-fallback-email') || 'contact@xiomics.systems';
    var idleLabel = ui.label ? ui.label.textContent : 'Send Inquiry →';
    var session = { startedAt: Date.now(), submissionId: newSubmissionId(), inFlight: false };

    form.noValidate = true; // we show our own accessible errors; without JS the browser validates natively
    updateModeHint(form, ui, fallbackEmail);

    FIELDS.forEach(function (name) {
      var input = form.elements[name];
      if (input) input.addEventListener('input', function () { setFieldError(form, name, null); });
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (session.inFlight) return; // duplicate-submission guard
      handleSubmit(form, ui, session, fallbackEmail, idleLabel);
    });
    return { form: form };
  }

  function updateModeHint(form, ui, fallbackEmail) {
    if (!ui.hint) return;
    var mode = getMode(form.getAttribute('data-endpoint'));
    ui.hint.textContent = mode === 'api'
      ? 'Your message goes straight to our team at ' + fallbackEmail + '.'
      : 'This opens your email app with your message ready to send to ' + fallbackEmail + '.';
  }

  function readValues(form) {
    var out = {};
    FIELDS.forEach(function (name) { out[name] = form.elements[name] ? form.elements[name].value : ''; });
    return out;
  }

  function setFieldError(form, name, code) {
    var input = form.elements[name];
    var holder = form.ownerDocument.getElementById(name + '-error');
    if (!input || !holder) return;
    if (code) {
      input.setAttribute('aria-invalid', 'true');
      holder.textContent = errorText(name, code);
      holder.hidden = false;
    } else {
      input.removeAttribute('aria-invalid');
      holder.textContent = '';
      holder.hidden = true;
    }
  }

  function showFieldErrors(form, errors) {
    var first = null;
    FIELDS.forEach(function (name) {
      setFieldError(form, name, errors[name] || null);
      if (errors[name] && !first) first = form.elements[name];
    });
    if (first) first.focus();
  }

  function setStatus(ui, state, title, text, link) {
    var el = ui.status;
    if (!el) return;
    var t = el.querySelector('[data-status-title]');
    var p = el.querySelector('[data-status-text]');
    var a = el.querySelector('[data-status-link]');
    if (state) el.setAttribute('data-state', state); else el.removeAttribute('data-state');
    if (t) t.textContent = title || '';
    if (p) p.textContent = text || '';
    if (a) {
      a.hidden = !link;
      if (link) { a.href = link.href; a.textContent = link.text; }
    }
  }

  function setLoading(form, ui, loading, idleLabel) {
    if (ui.submit) ui.submit.disabled = loading;
    if (loading) form.setAttribute('aria-busy', 'true'); else form.removeAttribute('aria-busy');
    if (ui.label) ui.label.textContent = loading ? 'Sending…' : idleLabel;
  }

  function openEmailApp(doc, url) {
    var a = doc.createElement('a');
    a.href = url;
    a.style.display = 'none';
    doc.body.appendChild(a);
    a.click();
    a.parentNode.removeChild(a);
  }

  function handleSubmit(form, ui, session, fallbackEmail, idleLabel) {
    updateModeHint(form, ui, fallbackEmail);
    var check = validateInquiry(readValues(form));
    if (!check.ok) {
      setStatus(ui, 'error', 'Please check the highlighted fields.', 'Your message has not been sent yet.', null);
      showFieldErrors(form, check.errors);
      return;
    }
    showFieldErrors(form, {});
    var mailto = buildMailtoUrl(fallbackEmail, check.value);
    var mode = getMode(form.getAttribute('data-endpoint'));
    if (mode === 'api' && ui.honeypot && ui.honeypot.value) {
      // Something (usually browser autofill) filled the hidden spam trap. Don't send a message the
      // server would silently discard; offer the email route instead.
      setStatus(ui, 'error', 'We couldn’t send this automatically.', 'Please email us directly — your message is prefilled.',
        { href: mailto, text: 'Email ' + fallbackEmail });
      return;
    }
    if (mode !== 'api') {
      openEmailApp(form.ownerDocument, mailto);
      setStatus(ui, 'info', 'Almost done — please press Send in your email app.',
        'We opened your email app with your message addressed to ' + fallbackEmail + '. It is only delivered once you send it from there.',
        { href: mailto, text: 'Email app didn’t open? Click here to try again' });
      return;
    }
    sendToApi(form, ui, session, check.value, mailto, fallbackEmail, idleLabel);
  }

  function sendToApi(form, ui, session, value, mailto, fallbackEmail, idleLabel) {
    session.inFlight = true;
    setLoading(form, ui, true, idleLabel);
    setStatus(ui, null, '', '', null);
    var payload = {
      name: value.name, email: value.email, business: value.business, message: value.message,
      xs_hp: ui.honeypot ? ui.honeypot.value : '',
      elapsed_ms: Date.now() - session.startedAt,
      submission_id: session.submissionId,
    };
    var turnstile = form.querySelector('[name="cf-turnstile-response"]');
    if (turnstile) payload['cf-turnstile-response'] = turnstile.value;
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;

    fetch(form.getAttribute('data-endpoint'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit',
      signal: controller ? controller.signal : undefined,
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) { return interpretResponse(res.status, body); });
      })
      .catch(function (err) { return { state: err && err.name === 'AbortError' ? 'timeout' : 'network' }; })
      .then(function (outcome) {
        if (timer) clearTimeout(timer);
        session.inFlight = false;
        setLoading(form, ui, false, idleLabel);
        showOutcome(form, ui, session, outcome, mailto, fallbackEmail);
      });
  }

  function resetTurnstile() {
    // Turnstile tokens are single-use: get a fresh one for any further attempt.
    var ts = typeof window !== 'undefined' ? window.turnstile : null;
    if (ts && typeof ts.reset === 'function') {
      try { ts.reset(); } catch (e) { /* widget not rendered; nothing to reset */ }
    }
  }

  function showOutcome(form, ui, session, outcome, mailto, fallbackEmail) {
    var emailLink = { href: mailto, text: 'Email ' + fallbackEmail + ' instead (your message is prefilled)' };
    resetTurnstile();
    switch (outcome.state) {
      case 'success':
        form.reset();
        session.submissionId = newSubmissionId();
        session.startedAt = Date.now();
        setStatus(ui, 'success', 'Message sent — thank you.', 'Your message has reached our team. We’ll reply by email within 24 hours.', null);
        return;
      case 'invalid':
        setStatus(ui, 'error', 'Please check the highlighted fields.', 'Your message has not been sent yet.', null);
        showFieldErrors(form, outcome.fields);
        return;
      case 'too_fast':
        setStatus(ui, 'error', 'That was quick — please press Send again.', 'For spam protection we wait a few seconds before accepting a message. Your message is still in the form.', null);
        return;
      case 'rate_limited':
        setStatus(ui, 'error', 'Too many attempts.', 'Please wait a few minutes and try again, or email us directly. Your message is still in the form.', emailLink);
        return;
      case 'timeout':
      case 'network':
        setStatus(ui, 'error', 'We couldn’t reach our server.', 'Please check your connection and try again. Your message is still in the form.', emailLink);
        return;
      default:
        setStatus(ui, 'error', 'Your message could not be sent.', 'Nothing was delivered. Please try again later, or email us directly — your message is still in the form.', emailLink);
    }
  }

  /** Service-card links prefill the inquiry when the message box is still empty. */
  function initServiceLinks(doc) {
    var links = doc.querySelectorAll('a[data-service]');
    Array.prototype.forEach.call(links, function (link) {
      link.addEventListener('click', function () {
        var box = doc.getElementById('message');
        if (box && box.value.trim() === '') box.value = 'I’m interested in ' + link.getAttribute('data-service') + '. ';
      });
    });
  }

  function autoInit(doc) {
    if (!doc) return;
    var run = function () {
      initContactForm(doc.getElementById('contact-form'));
      initServiceLinks(doc);
    };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', run); else run();
  }

  return {
    LIMITS: LIMITS,
    validateInquiry: validateInquiry,
    errorText: errorText,
    getMode: getMode,
    buildMailtoUrl: buildMailtoUrl,
    interpretResponse: interpretResponse,
    initContactForm: initContactForm,
    autoInit: autoInit,
  };
});
