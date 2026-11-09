# Xiomics contact-form endpoint — DEFERRED / INACTIVE

> **Status:** not used by the website, and not deployed.
> - The site's primary conversion is booking through **Topmate** (see `../README.md`). The site has no contact form.
> - **Nothing in this folder is required** for the current website release:
>   - no Cloudflare account, Worker deployment or Turnstile widget;
>   - no Zoho OAuth / Self Client;
>   - no secrets.
> - Everything here (Worker, deferred browser form module in `client/`, tests) is kept, and still tested, only for possible future reuse.
> - `_config.yml` excludes this folder from the published GitHub Pages site.
> - The setup steps below apply **only if** the owner later decides to bring back a website contact form.

A small Cloudflare Worker that receives inquiries from a (future) www.xiomics.systems contact form and delivers them to **contact@xiomics.systems** through the Zoho Mail REST API.

- **No runtime dependencies.** The Worker uses only `fetch`.
- **No SMTP password.** It authenticates with an OAuth refresh token limited to two scopes, which can be revoked at any time: `ZohoMail.messages.CREATE` to send, and `ZohoMail.accounts.READ`, used only once during setup to look up the mailbox's account ID.
- **No DNS changes.** The Worker runs on its free `*.workers.dev` address. A custom domain is optional and needs a separate approval.

## How a site would use it (if re-enabled)
The deferred browser module is `client/contact-form.js` (tests: `test/contact-form.test.mjs`). To re-enable, copy it to `../assets/js/` and restore a form whose `action` is `mailto:contact@xiomics.systems`, so visitors without JavaScript still get a working email route. JavaScript then chooses the mode from the form's `data-endpoint` attribute:

| `data-endpoint` | Behaviour |
|---|---|
| absent (current) | Opens the visitor's email app with the inquiry prefilled. The page says clearly that they must press Send in their email app. It never claims the message was sent. |
| `https://xiomics-contact.<your-subdomain>.workers.dev/api/contact` | Sends through this Worker. "Message sent" appears **only** after the Worker confirms that Zoho accepted the email. On any failure the visitor sees an honest error, keeps their text, and is offered an email link. |

## What the Worker does on each request
1. **Origin check.** Only `ALLOWED_ORIGINS` may call it. A missing or `null` Origin is refused, as is a request without a client IP header.
2. **Rate limit.** Without a binding, the Worker allows 5 requests per IP per 10 minutes, counted in memory per Worker instance. With the optional Cloudflare binding, the limit is 5 per IP per minute per location, because the binding allows only 10- or 60-second periods.
3. **Daily cap.** No more than `MAX_DAILY_SENDS` emails per instance per UTC day (default 100). Above that, requests get a generic 503, which protects the Zoho sending quota.
4. **Configuration check.** Turnstile is **required** by default. If `TURNSTILE_SECRET` or any Zoho secret is missing, the Worker returns a generic 503 and sends nothing. The logs say why; visitors are not told.
5. **Size and type checks.** The body is capped at 32 KB and must be JSON.
6. **Bot checks.**
   - A filled honeypot (`xs_hp`) is silently dropped. The browser never sends a filled trap; if autofill fills it, the visitor is offered the email route instead.
   - `elapsed_ms` is required. A form sent under 3 seconds after page load gets `422 too_fast`, and the visitor is asked to press Send again. It is never shown as a success.
   - The Turnstile token must verify, and its hostname must be one of the allowed origins.
7. **Validation.** This is the same rule set as the browser, and both are tested against `test/fixtures/inquiry-vectors.json`.
   - Required fields: name, email, business and message. Non-string values count as missing.
   - Length limits: 100, 254, 120 and 10–5000 characters respectively.
   - A strict email format.
   - CR/LF, control, zero-width-space and bidi-override characters are rejected, which prevents header injection and display spoofing. The joiners U+200C and U+200D stay allowed, because Urdu and Persian text needs them.
8. **Duplicate guard.** The browser sends a submission ID. An ID that was already delivered isn't sent again, and a concurrent duplicate waits for, and shares, the first attempt's outcome.
9. **Delivery.** A plain-text email from `MAIL_FROM` to `MAIL_TO`. Both are fixed server-side, so visitors can never choose a recipient. Zoho access tokens are cached, and concurrent requests share one refresh, because Zoho allows only 10 refreshes per 10 minutes.
10. **Response.** `{"ok":true}` only on confirmed acceptance; otherwise a short error code such as `validation`, `too_fast`, `rate_limited`, `verification_failed`, `delivery_failed` or `unavailable`. No internal details are returned.

**Known limit.** If Zoho accepts a message but the reply times out (10 s), the visitor sees an error. A retry may then send the inquiry twice. This fails in the safe direction: a duplicate, never a lost lead.

**Logs** contain event names and error codes only: never names, email addresses, message text, tokens or secrets. A test enforces this.

## Tests
```bash
node --test
```
Run this from this folder (Worker tests) or from the repository root (all tests). Zoho and Turnstile are mocked, so no email is ever sent by the tests.

## One-time setup (needs the owner's accounts — free tiers, no payment)
These steps need your own logins and credentials, so the engineer cannot do them for you. None of them changes DNS, MX, SPF, DKIM, DMARC or your Zoho mailbox settings.

1. **Cloudflare account** (free): sign up at https://dash.cloudflare.com/sign-up if you don't have one.
2. **Log Wrangler in** on this computer, from this folder: `npx wrangler@4 login` (a browser window asks you to approve).
3. **Zoho API client:**
   1. Sign in at https://api-console.zoho.com with the account that owns contact@xiomics.systems.
   2. Choose **Self Client → Create**.
   3. On the **Generate Code** tab, enter the scope `ZohoMail.messages.CREATE,ZohoMail.accounts.READ` and any description.
   4. Click Create and copy the code. **It expires in about 2 minutes.**
4. **Store the secrets** by running `node scripts/zoho-oauth-setup.mjs` and pasting the Client ID, Client Secret and code when asked. The script:
   - exchanges the code;
   - finds the Zoho account ID for contact@xiomics.systems;
   - with your confirmation, stores all four values as Cloudflare Worker secrets (`wrangler secret put`). Nothing is written to disk or into the repository.
5. **Turnstile (required, free):**
   1. In the Cloudflare dashboard, open **Turnstile → Add widget** for the hostname `www.xiomics.systems`.
   2. Run `npx wrangler@4 secret put TURNSTILE_SECRET` and paste the **secret key**.
   3. Keep the **site key**. It's public and will go into the page.
6. **Deploy:** `npx wrangler@4 deploy`. Wrangler prints the Worker URL (`https://xiomics-contact.<subdomain>.workers.dev`).
7. **Connect the site.** The engineer can do this once you share the Worker URL and the Turnstile site key; neither is secret. In `../index.html`:
   - add `data-endpoint="<Worker URL>/api/contact"` to the `<form id="contact-form">` tag;
   - add `<div class="cf-turnstile" data-sitekey="<site key>" data-theme="dark"></div>` inside the form, above the Send button;
   - add `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` before `</body>`.
8. **Verify** (needs your explicit approval, because it sends one real email): submit **one** clearly labelled test inquiry from the deployed page, using **your own personal email address**. Confirm it arrives in contact@xiomics.systems, then delete it. Never use a customer's address for testing.

### Optional hardening
- **Rate-limit binding:** uncomment `[[ratelimits]]` in `wrangler.toml` once you've confirmed it's available on your plan.
- **Custom domain:** once the endpoint lives on your own domain, set `workers_dev = false`. This needs a DNS change and a separate approval.

## Rollback
- **Site:** remove `data-endpoint` from the form. It falls back to visitors' email apps immediately, and `action` is always `mailto:`.
- **Worker:** `npx wrangler@4 delete`, or disable it in the Cloudflare dashboard.
- **Zoho access:** revoke the Self Client in https://api-console.zoho.com. The refresh token stops working immediately.
