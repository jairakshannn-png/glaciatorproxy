(function () {
  var form = document.getElementById("launch-form");
  var input = document.getElementById("url-input");

  function looksLikeUrl(value) {
    // has a dot with no spaces, or already has a scheme
    return /^[a-z]+:\/\//i.test(value) || (/\./.test(value) && !/\s/.test(value));
  }

  function normalize(value) {
    value = value.trim();
    if (!value) return null;
    if (!looksLikeUrl(value)) {
      return "https://duckduckgo.com/html/?q=" + encodeURIComponent(value);
    }
    if (!/^[a-z]+:\/\//i.test(value)) {
      value = "https://" + value;
    }
    return value;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var target = normalize(input.value);
    if (!target) {
      input.focus();
      return;
    }
    window.location.href = "/fetch?url=" + encodeURIComponent(target);
  });
})();
