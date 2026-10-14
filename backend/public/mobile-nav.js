// Mobile menu: the nine links fold behind a menu button on phones.
(function () {
  var header = document.querySelector(".site-header");
  var btn = document.querySelector(".nav-toggle");
  if (!header || !btn) return;
  btn.addEventListener("click", function () {
    var open = header.classList.toggle("nav-open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });
})();
