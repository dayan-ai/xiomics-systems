# xiomics-systems — website for www.xiomics.systems

Static one-page site for **Xiomics Systems**, an AI automation and digital transformation agency.

## Hosting (unchanged)
- **GitHub Pages**, built from the `main` branch root, with the custom domain in `CNAME` (`www.xiomics.systems`) and HTTPS enforced in the repository's Pages settings.
- No other hosting provider. DNS stays at Name.com and is not managed from this repository.
- `_config.yml` keeps repository-only files (`contact-worker/`, `tests/`, this README) **out** of the published site. Only `index.html`, `CNAME` and `assets/` are published.

## Booking (primary conversion)
- Every "Book a Free Discovery Call" button opens **Topmate** in a new tab (`target="_blank"`, `rel="noopener noreferrer"`).
- **The booking link is set in one place:** `assets/js/site-config.js` → `bookingUrl`.
  - It points to the dedicated, live, free **AI Automation Discovery Call** service on Topmate: `https://topmate.io/muhammad_dayan/2397800`.
  - If that service's link ever changes, put the new link in `bookingUrl`. Nothing else needs editing. `assets/js/booking-links.js` applies it to every button marked `data-booking-link`.
  - Only `https://topmate.io/...` links are accepted. Anything else is ignored, and the buttons keep their built-in link to that service page (which also serves visitors without JavaScript).
- Secondary contact: `mailto:contact@xiomics.systems` (contact section and footer).
- There is **no contact form** on the site.

## Deferred: email contact backend (inactive)
`contact-worker/` holds a Cloudflare Worker + Zoho Mail API backend and a browser form module from an earlier phase. They are **not used by the website** and need **no** Zoho, Cloudflare or Turnstile setup for the current release. They're kept, with their tests, for possible future reuse. See `contact-worker/README.md`.

## Tests
```bash
node --test
```
Run from the repository root (Node 22+, no dependencies). The suite covers:
- the page: services, booking links, claims, accessibility basics;
- the booking-link script;
- the GitHub Pages publish set;
- the deferred Worker and form module.

## After publishing (checks to run on the live site)
`tests/pages-artifact.test.mjs` models GitHub Pages' documented Jekyll rules; it is not the real build. After each publication, confirm:

| URL | Expected |
|---|---|
| `https://www.xiomics.systems/` | 200 |
| `https://www.xiomics.systems/assets/js/site-config.js` | 200 |
| `https://www.xiomics.systems/assets/js/booking-links.js` | 200 |
| `https://www.xiomics.systems/contact-worker/README.md`, `/contact-worker/`, `/contact-worker/src/index.js` | 404 |
| `https://www.xiomics.systems/tests/site.test.mjs`, `/README.md`, `/README.html`, `/_config.yml` | 404 |
