# GlaciatorProxy

A self-hosted web proxy. It fetches pages on its own server, rewrites every
link/asset URL so browsing stays inside the proxy, and hands you back a page
that looks like the original.

## Run it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## How it works

- `server.js` is the whole backend: one Express route, `/fetch?url=...`,
  fetches the target URL, and:
  - for **HTML**, parses it with `cheerio` and rewrites every `href`, `src`,
    `action`, `srcset`, and CSS `url()` it finds so they point back through
    `/fetch?url=...`, then injects a small script that also reroutes
    `fetch()`/`XMLHttpRequest` calls made by the page's own JavaScript
  - for **CSS**, rewrites `url()` references the same way
  - for everything else (images, fonts, JS, JSON), streams the response
    through unchanged
- It follows redirects itself so the browser only ever sees `/fetch` URLs,
  and strips headers (`X-Frame-Options`, `Content-Security-Policy`) that
  would otherwise stop the rewritten page from working.
- It blocks requests to localhost/private-network addresses, so the proxy
  can't be pointed at your own internal network or cloud metadata endpoints.

## Honest limitations

This is a working proxy, not a full anonymity tool — the landing page spells
this out, but worth repeating here:

- **The proxy operator can see everything** requested through it. Only run
  this on infrastructure you control or trust.
- **It's not encryption.** Anyone who can see your connection to the proxy
  knows you're using it, even though they can't see which pages you loaded.
- **Cookies/logins are simplified.** `Set-Cookie` isn't rehomed to the proxy's
  origin, so most logged-in sessions won't persist.
- **Complex single-page apps** (heavy client routing, WebSockets, Service
  Workers) may partially break — the injected shim covers `fetch` and `XHR`
  but not every technique a modern app can use.
- Many sites' terms of service prohibit proxying/scraping access. That's on
  the user to check, not something the code enforces.

## Deploying it

The proxy is a plain Node/Express app (no database), so any Node host works.
A few options as of mid-2026:

| Host | Free tier | Notes |
|---|---|---|
| **Render** | Yes, no credit card | The most straightforward genuinely-free option for this app. Free web services spin down after 15 minutes idle and take 30–50s to wake on the next request — fine for personal use. |
| **Cloudflare Workers** | Yes, generous | Free, fast, no cold-start sleep — but Workers run on V8 isolates, not full Node, so `server.js` would need a rewrite to Workers-style `fetch` handlers and Workers' HTML-rewriting API instead of `cheerio`/`node-fetch`. Worth it if you want something always-on for free. |
| **Koyeb** | Yes, small free instance | Simple git-push deploys, a free "nano" instance is enough for light personal use. |
| **Oracle Cloud "Always Free"** | Yes | A small always-on VM you manage yourself (more setup: you `git clone`, run `npm install`, and keep the process alive with something like `pm2`). No cold starts since it's a real VM, but more to maintain. |
| **Railway / Fly.io** | No real free tier anymore | Both dropped their ongoing free tiers (Railway gives a one-time trial credit; Fly.io requires a card even for the trial). Cheap ($5/mo range) if you want them anyway. |

**Quickest path:** push this folder to a GitHub repo, connect it on Render as
a Web Service, set the start command to `npm start`, and it deploys with no
config file needed. No credit card required for the free tier.

Whichever host you pick, check that its own terms of service allow running a
proxy — a few hosts restrict this in their acceptable-use policy.
