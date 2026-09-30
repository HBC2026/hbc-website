(function () {
  "use strict";

  // Header solid background after scrolling past hero
  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function () {
      if (window.scrollY > 60) header.classList.add("is-scrolled");
      else header.classList.remove("is-scrolled");
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // Mobile nav toggle
  var menuBtn = document.querySelector(".menu-toggle");
  var mobileNav = document.querySelector(".mobile-nav");
  if (menuBtn && mobileNav) {
    var closeMenu = function () {
      mobileNav.classList.remove("is-open");
      menuBtn.setAttribute("aria-expanded", "false");
    };
    menuBtn.addEventListener("click", function () {
      var isOpen = mobileNav.classList.toggle("is-open");
      menuBtn.setAttribute("aria-expanded", String(isOpen));
    });
    mobileNav.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", closeMenu);
    });
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMenu();
    });
  }

  // Scroll-reveal
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var revealEls = document.querySelectorAll("[data-reveal]");
  if (revealEls.length && !reduceMotion && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  }

  // Arabic / RTL toggle — swaps data-en / data-ar text and flips document direction
  var langToggles = document.querySelectorAll(".lang-toggle");
  if (langToggles.length) {
    var applyLang = function (lang) {
      document.documentElement.lang = lang;
      document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
      document.querySelectorAll("[data-en]").forEach(function (el) {
        var text = lang === "ar" ? el.getAttribute("data-ar") : el.getAttribute("data-en");
        if (text) el.textContent = text;
      });
      langToggles.forEach(function (btn) {
        btn.querySelector(".lt-label").textContent = lang === "ar" ? "English" : "العربية";
      });
      try { localStorage.setItem("hbc-lang", lang); } catch (e) {}
    };
    var current = "en";
    try { current = localStorage.getItem("hbc-lang") || "en"; } catch (e) {}
    if (current === "ar") applyLang("ar");
    langToggles.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var next = document.documentElement.lang === "ar" ? "en" : "ar";
        applyLang(next);
      });
    });
  }
})();
