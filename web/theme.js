// Light, dark, or the system's choice; the same mechanism as puna's theme.js.
//
// Every color in app.css goes through light-dark(), so a theme is only `color-scheme` on <html>,
// chosen by `data-theme`. Loaded from <head> without `defer` so a stored choice applies before the
// first paint instead of flashing the system theme. "system" is the absence of a stored value.
(function () {
  "use strict";

  var KEY = "kalapana-theme";
  var CHOICES = ["light", "dark"];

  function stored() {
    try {
      var value = localStorage.getItem(KEY);
      return CHOICES.indexOf(value) === -1 ? null : value;
    } catch (e) {
      // Storage can throw (private browsing, blocked site data); the theme still works for this page.
      return null;
    }
  }

  function apply(choice) {
    if (choice) document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
  }

  apply(stored());
  // Reveals the control, which can't work without script.
  document.documentElement.classList.add("js-theme");

  function wire() {
    var group = document.querySelector("[data-theme-toggle]");
    if (!group) return;
    var buttons = Array.prototype.slice.call(group.querySelectorAll("button[data-set]"));

    // The active look comes from [data-theme] in the stylesheet; aria-pressed is what CSS can't set.
    function mark() {
      var current = stored() || "system";
      buttons.forEach(function (button) {
        button.setAttribute("aria-pressed", button.dataset.set === current ? "true" : "false");
      });
    }

    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        var choice = button.dataset.set === "system" ? null : button.dataset.set;
        apply(choice);
        try {
          if (choice) localStorage.setItem(KEY, choice);
          else localStorage.removeItem(KEY);
        } catch (e) {
          // Unstorable, so the choice lasts until the page is left.
        }
        mark();
      });
    });

    mark();

    // Other tabs on this origin follow a change made here.
    window.addEventListener("storage", function (event) {
      if (event.key !== KEY) return;
      apply(stored());
      mark();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
