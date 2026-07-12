// GlaciatorProxy - server.js
// A self-hosted web proxy: fetches a target page server-side, rewrites every
// link/asset URL so it also flows back through this server, and injects a
// small client-side shim so JS-driven requests (fetch/XHR) get proxied too.

const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { URL } = require("url");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-encoding",
  "content-length"
]);

// Headers that would stop the page from being served/rewritten by us.
const STRIPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "set-cookie" // simplified: cookies aren't rehomed to the proxy origin
]);

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 GlaciatorProxy";

// ---- Basic SSRF guard -------------------------------------------------
// Refuse to let the proxy be used to reach internal/private network
// addresses (localhost, RFC1918 ranges, link-local/cloud metadata, etc).
function isPrivateAddress(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
  }
  if (net.isIP(ip) === 6) {
    const low = ip.toLowerCase();
    if (low === "::1") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
  }
  return false;
}

async function assertSafeTarget(targetUrl) {
  const hostname = targetUrl.hostname;
  if (hostname === "localhost") throw new Error("Refused: local address");
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("Could not resolve host");
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new Error("Refused: private network address");
  }
}

// ---- URL helpers --------------------------------------------------------

// Build a proxy-local path that will re-fetch `absoluteUrl` through /fetch
function toProxyPath(absoluteUrl) {
  return "/fetch?url=" + encodeURIComponent(absoluteUrl);
}

// Resolve a possibly-relative URL found in a page against that page's URL,
// then turn it into a proxied path. Leaves data:/mailto:/javascript: alone.
function proxify(rawUrl, baseUrl) {
  if (!rawUrl) return rawUrl;
  const trimmed = rawUrl.trim();
  if (/^(data:|mailto:|javascript:|tel:|#)/i.test(trimmed)) return rawUrl;
  try {
    const abs = new URL(trimmed, baseUrl).toString();
    return toProxyPath(abs);
  } catch {
    return rawUrl;
  }
}

function proxifySrcset(value, baseUrl) {
  if (!value) return value;
  return value
    .split(",")
    .map((part) => {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) return part;
      bits[0] = proxify(bits[0], baseUrl);
      return bits.join(" ");
    })
    .join(", ");
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
function rewriteCss(css, baseUrl) {
  return css.replace(CSS_URL_RE, (match, quote, url) => {
    const proxied = proxify(url, baseUrl);
    return `url(${quote}${proxied}${quote})`;
  });
}

// Client-side shim injected into every proxied HTML page. Rewrites
// window.fetch / XMLHttpRequest calls and intercepts clicks on links that
// get added to the DOM after the initial server-side rewrite (e.g. by an
// app's own JS), so navigation stays inside the proxy.
function buildInjection(pageUrl) {
  return `
<script>
(function () {
  var PAGE_URL = ${JSON.stringify(pageUrl)};
  function toProxied(url) {
    try {
      if (/^(data:|mailto:|javascript:|blob:|#)/i.test(url)) return url;
      var abs = new URL(url, PAGE_URL).toString();
      if (abs.indexOf(location.origin + "/fetch?url=") === 0) return url;
      return "/fetch?url=" + encodeURIComponent(abs);
    } catch (e) { return url; }
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === "string") input = toProxied(input);
    else if (input && input.url) input = new Request(toProxied(input.url), input);
    return origFetch.call(this, input, init);
  };

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = toProxied(url);
    return origOpen.apply(this, arguments);
  };

  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href || /^(data:|mailto:|javascript:|#)/i.test(href)) return;
    if (href.indexOf("/fetch?url=") === 0) return;
    e.preventDefault();
    window.location.href = toProxied(href);
  }, true);
})();
</script>`;
}

// Small fixed toolbar so the visitor can navigate to a new address or get
// back to GlaciatorProxy's home page while browsing a proxied site.
function buildToolbar(currentUrl) {
  const safeUrl = currentUrl.replace(/"/g, "&quot;");
  return `
<div id="glaciator-toolbar" style="all:initial;">
  <style>
    #glaciator-toolbar * { box-sizing: border-box; font-family: 'Space Grotesk', Arial, sans-serif; }
    #glaciator-toolbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      display: flex; align-items: center; gap: 10px;
      background: #0A1420; border-bottom: 1px solid #1E3A4F;
      padding: 8px 12px; height: 44px;
    }
    #glaciator-toolbar a.gp-home {
      color: #6FE3FF; text-decoration: none; font-weight: 700; font-size: 14px;
      white-space: nowrap; letter-spacing: 0.02em;
    }
    #glaciator-toolbar form { flex: 1; display: flex; gap: 8px; }
    #glaciator-toolbar input {
      flex: 1; background: #101E2E; border: 1px solid #1E3A4F; color: #EAF6FB;
      font-family: 'JetBrains Mono', monospace; font-size: 13px;
      padding: 7px 10px; border-radius: 3px; outline: none; min-width: 0;
    }
    #glaciator-toolbar input:focus { border-color: #6FE3FF; }
    #glaciator-toolbar button {
      background: #6FE3FF; color: #0A1420; border: none; font-weight: 700;
      font-size: 13px; padding: 7px 14px; border-radius: 3px; cursor: pointer;
      clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
    }
  </style>
  <a class="gp-home" href="/">&#10052; GlaciatorProxy</a>
  <form onsubmit="event.preventDefault(); var v=this.q.value.trim(); if(!v) return; if(!/^https?:\\/\\//i.test(v)) v='https://'+v; window.top.location.href='/fetch?url='+encodeURIComponent(v);">
    <input name="q" type="text" value="${safeUrl}" spellcheck="false" />
    <button type="submit">Go</button>
  </form>
</div>
<div style="height:44px;"></div>`;
}

function rewriteHtml(html, pageUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  $("base").remove();

  $("a[href], link[href]").each((_, el) => {
    const $el = $(el);
    $el.attr("href", proxify($el.attr("href"), pageUrl));
  });

  $("script[src], img[src], iframe[src], source[src], video[src], audio[src], embed[src]").each((_, el) => {
    const $el = $(el);
    $el.attr("src", proxify($el.attr("src"), pageUrl));
  });

  $("img[srcset], source[srcset]").each((_, el) => {
    const $el = $(el);
    $el.attr("srcset", proxifySrcset($el.attr("srcset"), pageUrl));
  });

  $("form[action]").each((_, el) => {
    const $el = $(el);
    $el.attr("action", proxify($el.attr("action"), pageUrl));
  });
  $("form:not([action])").each((_, el) => {
    $(el).attr("action", proxify(pageUrl, pageUrl));
  });

  $("[style]").each((_, el) => {
    const $el = $(el);
    const style = $el.attr("style");
    if (style && style.indexOf("url(") !== -1) {
      $el.attr("style", rewriteCss(style, pageUrl));
    }
  });

  $("style").each((_, el) => {
    const $el = $(el);
    $el.text(rewriteCss($el.text(), pageUrl));
  });

  $('meta[http-equiv="refresh" i]').each((_, el) => {
    const $el = $(el);
    const content = $el.attr("content") || "";
    const match = content.match(/^(\d+)\s*;\s*url=(.+)$/i);
    if (match) {
      $el.attr("content", `${match[1]};url=${proxify(match[2], pageUrl)}`);
    }
  });

  // Remove integrity attributes: bytes are proxied/re-served, so hashes
  // computed against the original origin would no longer match.
  $("[integrity]").removeAttr("integrity");

  $("head").prepend(buildInjection(pageUrl));
  $("body").prepend(buildToolbar(pageUrl));

  return $.html();
}

// ---- Main proxy route ---------------------------------------------------

app.all("/fetch", async (req, res) => {
  const rawTarget = req.query.url;
  if (!rawTarget) return res.status(400).send("Missing url parameter.");

  let targetUrl;
  try {
    targetUrl = new URL(rawTarget);
    if (!/^https?:$/.test(targetUrl.protocol)) throw new Error("bad protocol");
  } catch {
    return res.status(400).send("That doesn't look like a valid http(s) address.");
  }

  try {
    await assertSafeTarget(targetUrl);
  } catch (err) {
    return res.status(400).send(err.message);
  }

  try {
    const fetchOptions = {
      method: req.method,
      redirect: "manual",
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept: req.headers["accept"] || "*/*",
        "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9"
      }
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.is("application/x-www-form-urlencoded")) {
        fetchOptions.headers["Content-Type"] = "application/x-www-form-urlencoded";
        fetchOptions.body = new URLSearchParams(req.body).toString();
      } else if (req.is("application/json")) {
        fetchOptions.headers["Content-Type"] = "application/json";
        fetchOptions.body = JSON.stringify(req.body);
      }
    }

    const upstream = await fetch(targetUrl.toString(), fetchOptions);

    // Follow redirects ourselves so the browser only ever sees /fetch URLs.
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const loc = upstream.headers.get("location");
      if (loc) {
        const abs = new URL(loc, targetUrl).toString();
        return res.redirect(upstream.status, toProxyPath(abs));
      }
    }

    upstream.headers.forEach((value, key) => {
      if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.status(upstream.status);

    const contentType = upstream.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      const body = await upstream.text();
      res.set("Content-Type", "text/html; charset=utf-8");
      return res.send(rewriteHtml(body, targetUrl.toString()));
    }

    if (contentType.includes("text/css")) {
      const body = await upstream.text();
      res.set("Content-Type", "text/css; charset=utf-8");
      return res.send(rewriteCss(body, targetUrl.toString()));
    }

    // Everything else (images, fonts, JS, JSON, media...) streams through as-is.
    upstream.body.pipe(res);
  } catch (err) {
    res.status(502).send("GlaciatorProxy couldn't reach that address: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`GlaciatorProxy listening on http://localhost:${PORT}`);
});
