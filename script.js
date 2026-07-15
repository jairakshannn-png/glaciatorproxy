(function () {
  var form = document.getElementById("launch-form");
  var input = document.getElementById("url-input");
  var homeBtn = document.getElementById("home-btn");
  var landingView = document.getElementById("landing-view");
  var browseView = document.getElementById("browse-view");
  var viewport = document.getElementById("viewport");
  var statusEl = document.getElementById("shell-status");
  var chips = document.querySelectorAll("[data-launch]");

  function looksLikeUrl(value) {
    return /^[a-z]+:\/\//i.test(value) || (/\./.test(value) && !/\s/.test(value));
  }

  function normalize(value) {
    value = value.trim();
    if (!value) return null;
    if (!looksLikeUrl(value)) {
      return "https://duckduckgo.com/html/?q=" + encodeURIComponent(value);
    }
    if (!/^[a-z]+:\/\//i.test(value)) value = "https://" + value;
    return value;
  }

  // Recognize a YouTube watch/shorts/short-link URL and pull out the video ID.
  function extractYouTubeId(rawUrl) {
    try {
      var u = new URL(rawUrl);
      var host = u.hostname.replace(/^www\.|^m\./, "");
      if (host === "youtu.be") {
        var seg = u.pathname.split("/").filter(Boolean)[0];
        return seg || null;
      }
      if (host === "youtube.com") {
        if (u.pathname === "/watch") return u.searchParams.get("v");
        if (u.pathname.indexOf("/shorts/") === 0) return u.pathname.split("/")[2] || null;
        if (u.pathname.indexOf("/embed/") === 0) return u.pathname.split("/")[2] || null;
      }
    } catch (e) { /* not a valid URL */ }
    return null;
  }

  function setStatus(text) {
    if (!statusEl) return;
    if (text) {
      statusEl.textContent = text;
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
  }

  function showBrowseView() {
    landingView.hidden = true;
    browseView.hidden = false;
  }

  function showLandingView() {
    landingView.hidden = false;
    browseView.hidden = true;
    setStatus("");
  }

  // The one and only place that ever sets the iframe's src. Nothing in this
  // app ever does window.open() or window.location — the top-level tab
  // never navigates, no matter what address you enter.
  function launch(rawValue) {
    var target = normalize(rawValue);
    if (!target) {
      input.focus();
      return;
    }
    input.value = target;
    showBrowseView();

    var ytId = extractYouTubeId(target);
    if (ytId) {
      // YouTube's stream URLs are signed and tied to the connection that
      // requested them, so they can't be relayed through this server the
      // way an ordinary page can. We load YouTube's own embeddable player
      // directly instead — playback works, but that traffic talks to
      // YouTube directly rather than being proxied. Everything else
      // (search, browsing, every other site) still routes through /fetch.
      viewport.src = "https://www.youtube.com/embed/" + encodeURIComponent(ytId) + "?autoplay=1&rel=0";
      setStatus("Playing YouTube's own player directly — video isn't relayed through the proxy, only page browsing is.");
      return;
    }

    setStatus("");
    viewport.src = "/fetch?url=" + encodeURIComponent(target);
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    launch(input.value);
  });

  homeBtn.addEventListener("click", showLandingView);

  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      launch(chip.getAttribute("data-launch"));
    });
  });

  // Keep the address bar in sync as navigation happens inside the iframe.
  // Only works when the iframe is same-origin (i.e. our own /fetch pages);
  // the YouTube embed case is cross-origin by design, so this just no-ops.
  viewport.addEventListener("load", function () {
    try {
      var href = viewport.contentWindow.location.href;
      if (!href || href === "about:blank") return;
      var u = new URL(href);
      if (u.origin === location.origin && u.pathname === "/fetch") {
        var inner = u.searchParams.get("url");
        if (inner) input.value = inner;
      }
    } catch (e) {
      // Cross-origin (e.g. the YouTube embed) — nothing to sync.
    }
  });
})();
