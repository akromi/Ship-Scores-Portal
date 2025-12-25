(function () {
  "use strict";
  // Akram 20251225  14:05
  // =========================================================
  // Ship Scores - Focus + A11y + Search (liners + ships) + Dataverse liners
  //
  //
  // Keeps:
  // - initial collapse
  // - tabbable summaries
  // - enforced tab routing for open ships (summary -> info -> history -> next)
  // - search matches liners + ships and uses snippet-driven status strings
  // =========================================================

  var DBG = true;

  function log() {
    if (!DBG) return;
    try { console.log.apply(console, ["[SHIPDBG]"].concat([].slice.call(arguments))); } catch (e) {}
  }

  function qsa(root, sel) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function qs(root, sel) {
    return (root || document).querySelector(sel);
  }
  function textOf(el) {
    return (el && el.textContent ? el.textContent : "").trim();
  }
  function safeId(prefix) {
    return prefix + "_" + Math.random().toString(36).slice(2) + "_" + Date.now().toString(36);
  }
  function isVisible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    var cs = window.getComputedStyle(el);
    return !(cs.display === "none" || cs.visibility === "hidden");
  }

  function getSummary(detailsEl) {
    return qs(detailsEl, ":scope > summary.browse-tree__summary");
  }

  function getShipRegions(ship) {
    return {
      info: qs(ship, ':scope .ship-details [data-ship-focus="info"]'),
      history: qs(ship, ':scope .ship-details [data-ship-focus="history"]')
    };
  }

  // =========================================================
  // Title sync: make document.title match the rendered page title
  // =========================================================
  function syncDocumentTitle() {
    // Power Pages typically renders the page title into #wb-cont
    var h1 = document.getElementById("wb-cont") || qs(document, "main h1") || qs(document, "h1");
    var t = textOf(h1);
    if (t) {
      document.title = t;
      log("document.title set to:", t);
    } else {
      log("document.title not changed (no title found).");
    }
  }

  // =========================================================
  // Summaries tabbable
  // =========================================================
  function ensureSummariesTabbable() {
    qsa(document, "details.browse-tree__liner, details.browse-tree__ship").forEach(function (d) {
      var s = getSummary(d);
      if (!s) return;

      if (!s.hasAttribute("tabindex")) s.setAttribute("tabindex", "0");
      if (!s.hasAttribute("role")) s.setAttribute("role", "button");
    });

    log("Summaries ensured tabbable.");
  }

  // =========================================================
  // Region semantics + tabbability
  // =========================================================
  function ensureRegionSemantics(ship) {
    var sum = getSummary(ship);
    var shipLabel = textOf(sum) || "(ship)";
    var r = getShipRegions(ship);

    [
      { key: "info", el: r.info, fallback: "Vessel information" },
      { key: "history", el: r.history, fallback: "Vessel inspection history" }
    ].forEach(function (x) {
      if (!x.el) {
        log("Region missing:", shipLabel, x.key);
        return;
      }

      x.el.setAttribute("role", "region");

      if (x.el.hasAttribute("aria-label") || x.el.hasAttribute("aria-labelledby")) return;

      var title = null;
      var cursor = x.el.previousElementSibling;
      while (cursor) {
        if ((cursor.tagName || "").toLowerCase() === "h3") {
          title = cursor;
          break;
        }
        cursor = cursor.previousElementSibling;
      }

      if (title) {
        if (!title.id) title.id = safeId("shipTitle");
        x.el.setAttribute("aria-labelledby", title.id);
        log("A11Y name wired:", shipLabel, x.key, "->", "#" + title.id, "(" + textOf(title) + ")");
      } else {
        x.el.setAttribute("aria-label", x.fallback);
        log("A11Y name fallback aria-label set:", shipLabel, x.key);
      }
    });
  }

  function setRegionsTabbable(ship, enabled) {
    var sum = getSummary(ship);
    var shipLabel = textOf(sum) || "(ship)";
    var r = getShipRegions(ship);

    [r.info, r.history].forEach(function (el) {
      if (!el) return;
      if (enabled) el.setAttribute("tabindex", "0");
      else el.removeAttribute("tabindex");
    });

    log("Tabbable regions:", shipLabel, "enabled=", enabled, {
      infoExists: !!r.info,
      infoVisible: !!r.info && isVisible(r.info),
      historyExists: !!r.history,
      historyVisible: !!r.history && isVisible(r.history)
    });
  }

  // =========================================================
  // Initial collapse
  // =========================================================
  function collapseAllOnLoad() {
    qsa(document, "details.browse-tree__liner, details.browse-tree__ship").forEach(function (d) {
      d.open = false;
    });

    qsa(document, "details.browse-tree__ship").forEach(function (ship) {
      setRegionsTabbable(ship, false);
    });

    log("All tree nodes collapsed on load.");
  }

  // =========================================================
  // Tab routing inside open ship
  // =========================================================
  function getNextFocusableAfterShip(ship) {
    var liner = ship.closest("details.browse-tree__liner");
    if (!liner) return null;

    var ships = qsa(liner, "details.browse-tree__ship").filter(function (s) { return isVisible(s); });
    var idx = ships.indexOf(ship);

    if (idx >= 0 && idx < ships.length - 1) {
      return getSummary(ships[idx + 1]);
    }

    var allLiners = qsa(document, "details.browse-tree__liner").filter(function (l) { return isVisible(l); });
    var lidx = allLiners.indexOf(liner);

    if (lidx >= 0 && lidx < allLiners.length - 1) {
      return getSummary(allLiners[lidx + 1]);
    }
    return null;
  }

  function focusEl(el, why) {
    if (!el) return false;
    var ok = false;

    try {
      el.focus({ preventScroll: false });
      ok = document.activeElement === el;
    } catch (e) {
      try {
        el.focus();
        ok = document.activeElement === el;
      } catch (e2) {}
    }

    log("focus()", why || "", {
      ok: ok,
      activeTag: document.activeElement ? document.activeElement.tagName : null,
      activeId: document.activeElement ? document.activeElement.id : null,
      activeClass: document.activeElement ? document.activeElement.className : null
    });

    return ok;
  }

  function setupTabRouting() {
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;

      var active = document.activeElement;
      if (!active || !active.matches) return;

      // Ship summary -> Info
      if (active.matches("summary.browse-tree__summary")) {
        var ship = active.closest("details.browse-tree__ship");
        if (ship && ship.open && isVisible(ship)) {
          var r = getShipRegions(ship);
          ensureRegionSemantics(ship);
          setRegionsTabbable(ship, true);

          if (!e.shiftKey && r.info && isVisible(r.info)) {
            e.preventDefault();
            log("TAB route: ship summary -> INFO", textOf(active));
            focusEl(r.info, "summary->info");
            return;
          }
        }
      }

      // Info -> History
      if (active.matches('[data-ship-focus="info"]')) {
        var ship1 = active.closest("details.browse-tree__ship");
        if (ship1 && ship1.open) {
          var r1 = getShipRegions(ship1);
          if (!e.shiftKey && r1.history && isVisible(r1.history)) {
            e.preventDefault();
            log("TAB route: INFO -> HISTORY", textOf(getSummary(ship1)));
            focusEl(r1.history, "info->history");
            return;
          }
        }
      }

      // History -> next summary
      if (active.matches('[data-ship-focus="history"]')) {
        var ship2 = active.closest("details.browse-tree__ship");
        if (ship2 && ship2.open) {
          var next = getNextFocusableAfterShip(ship2);
          if (!e.shiftKey && next) {
            e.preventDefault();
            log("TAB route: HISTORY -> next summary", textOf(next));
            focusEl(next, "history->next");
            return;
          }
        }
      }
    });

    log("Tab routing enabled.");
  }

  // =========================================================
  // Setup ships & liners (idempotent-ish: mark nodes bound)
  // =========================================================
  function setupShips() {
    qsa(document, "details.browse-tree__ship").forEach(function (ship) {
      if (ship.getAttribute("data-ship-bound") === "1") return;
      ship.setAttribute("data-ship-bound", "1");

      var sum = getSummary(ship);
      var shipLabel = textOf(sum) || "(ship)";

      ensureRegionSemantics(ship);
      setRegionsTabbable(ship, ship.open);

      ship.addEventListener("toggle", function () {
        log("TOGGLE ship:", shipLabel, "open=", ship.open);
        ensureRegionSemantics(ship);
        setRegionsTabbable(ship, ship.open);
      });

      if (sum) {
        sum.addEventListener("focus", function () {
          log("FOCUS ship summary:", shipLabel, "open=", ship.open);
        });
      }
    });

    log("Ships initialized:", qsa(document, "details.browse-tree__ship").length);
  }

  function setupLiners() {
    qsa(document, "details.browse-tree__liner").forEach(function (liner) {
      if (liner.getAttribute("data-liner-bound") === "1") return;
      liner.setAttribute("data-liner-bound", "1");

      var sum = getSummary(liner);
      var linerLabel = textOf(sum) || "(liner)";

      liner.addEventListener("toggle", function () {
        log("TOGGLE liner:", linerLabel, "open=", liner.open);

        if (!liner.open) {
          qsa(liner, "details.browse-tree__ship").forEach(function (ship) {
            ship.open = false;
            setRegionsTabbable(ship, false);
          });
        }
      });
    });

    log("Liners initialized:", qsa(document, "details.browse-tree__liner").length);
  }

  // =========================================================
  // Search (snippet-driven status strings via #shipScores_i18n or #linerSearchStatus)
  // =========================================================
  function setupSearch() {
    var input = document.getElementById("linerSearch");
    var status = document.getElementById("linerSearchStatus");
    var tree = document.getElementById("browseTree");

    if (!input || !status || !tree) {
      log("Search not initialized: missing #linerSearch, #linerSearchStatus, or #browseTree.", {
        hasInput: !!input, hasStatus: !!status, hasTree: !!tree
      });
      return;
    }

    function linerEls() { return qsa(tree, "details.browse-tree__liner"); }
    function shipEls(liner) { return qsa(liner, "details.browse-tree__ship"); }

    function readStatusStrings() {
      var i18n = document.getElementById("shipScores_i18n");
      var node = i18n || status;

      return {
        template: node.getAttribute("data-status-template") || "",
        none: node.getAttribute("data-status-none") || "",
        cleared: node.getAttribute("data-status-cleared") || ""
      };
    }

    function formatTemplate(tpl, liners, ships) {
      return String(tpl || "")
        .replace(/\{\{\s*liners\s*\}\}/gi, String(liners))
        .replace(/\{\{\s*ships\s*\}\}/gi, String(ships));
    }

    function setStatusText(q, matchedLiners, matchedShips) {
      var s = readStatusStrings();

      if (!q) {
        status.textContent = s.cleared || "";
        return;
      }

      if (matchedLiners === 0 || matchedShips === 0) {
        status.textContent = s.none || "";
        return;
      }

      if (!s.template) {
        status.textContent = matchedLiners + " cruise line(s) match. " + matchedShips + " ship(s) shown.";
        return;
      }

      status.textContent = formatTemplate(s.template, matchedLiners, matchedShips);
    }

    function applyFilter(raw) {
      var q = (raw || "").trim().toLowerCase();
      var matchedLiners = 0;
      var matchedShips = 0;

      linerEls().forEach(function (liner) {
        var linerSum = getSummary(liner);
        var linerName = (linerSum ? textOf(linerSum) : "").toLowerCase();
        var linerMatch = !q || linerName.indexOf(q) !== -1;

        var ships = shipEls(liner);

        var shipMatches = ships.map(function (ship) {
          var s = getSummary(ship);
          var shipName = (s ? textOf(s) : "").toLowerCase();
          var match = !q || shipName.indexOf(q) !== -1;
          return { ship: ship, match: match };
        });

        var anyShipMatch = shipMatches.some(function (m) { return m.match; });

        var linerVisible = !q || linerMatch || anyShipMatch;
        liner.style.display = linerVisible ? "" : "none";

        if (!linerVisible) {
          liner.open = false;
          ships.forEach(function (ship) {
            ship.open = false;
            ship.style.display = "";
            setRegionsTabbable(ship, false);
          });
          return;
        }

        matchedLiners++;

        shipMatches.forEach(function (m) {
          var shipVisible = !q || linerMatch || m.match;
          m.ship.style.display = shipVisible ? "" : "none";

          if (!shipVisible) {
            m.ship.open = false;
            setRegionsTabbable(m.ship, false);
          } else {
            matchedShips++;
          }
        });

        if (q) liner.open = true;
        else {
          liner.open = false;
          ships.forEach(function (ship) {
            ship.open = false;
            setRegionsTabbable(ship, false);
          });
        }
      });

      setStatusText(q, matchedLiners, matchedShips);

      log("Search applied:", q || "(empty)", { matchedLiners: matchedLiners, matchedShips: matchedShips });
    }

    input.addEventListener("input", function () { applyFilter(input.value); });
    input.addEventListener("search", function () { applyFilter(input.value); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        input.value = "";
        applyFilter("");
      }
    });

    // Expose for reuse after rebuilding tree
    window.__ShipScoresApplyFilter = applyFilter;

    applyFilter(input.value);
    log("Search initialized.");
  }



  function getSnippetTextFromDom(key, fallback) {
    // Optional helper if you later want more labels from #shipScores_i18n
    var i18n = document.getElementById("shipScores_i18n");
    if (!i18n) return fallback;
    var v = i18n.getAttribute(key);
    return v || fallback;
  }

  function buildLinerNode(linerName) {
    var d = document.createElement("details");
    d.className = "browse-tree__liner";

    var s = document.createElement("summary");
    s.className = "browse-tree__summary";
    s.textContent = linerName;

    var panel = document.createElement("div");
    panel.className = "browse-tree__panel";

    // Keep the “Ships” line if you still want it; otherwise remove.
    // If you want this bilingual later, swap the text for a snippet.
    var p = document.createElement("p");
    p.className = "mrgn-tp-sm";
    var strong = document.createElement("strong");
    strong.textContent = "Ships";
    p.appendChild(strong);

    panel.appendChild(p);

    d.appendChild(s);
    d.appendChild(panel);
    return d;
  }

  // =========================================================
  // Dataverse liners load (accounts from your saved view FetchXML)
  // =========================================================
  var FETCHXML_LINERS =
    '<fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="true">' +
    '  <entity name="account">' +
    '    <attribute name="name" />' +
    '    <attribute name="accountid" />' +
    '  </entity>' +
    '</fetch>';

  function loadLinersFromDataverse(done) {
  var tree = document.getElementById("browseTree");
  if (!tree) {
    log("Dataverse load skipped: #browseTree not found.");
    if (done) done(false);
    return;
  }

  // NEW: check for runFetchFlex (registered under window.webapi)
  if (!window.webapi || typeof window.webapi.runFetchFlex !== "function") {
    log("Dataverse load skipped: window.webapi.runFetchFlex is not available. Ensure updated fileInput.js is loaded.");
    if (done) done(false);
    return;
  }

  log("Dataverse load: running FetchXML for liners view...");

  // NEW: call runFetchFlex using the fetchXml string (or an object with fetchXml)
  window.webapi.runFetchFlex({ fetchXml: FETCHXML_LINERS }) // defaults to POST in runFetchFlex
    .then(function (data) {
      try {
        var rows = (data && data.value) ? data.value : [];
        log("Dataverse load: rows returned:", rows.length);

        // Clear existing liners
        qsa(tree, "details.browse-tree__liner").forEach(function (n) { n.remove(); });

        // Build liners
        rows.forEach(function (r) {
          var name = (r && r.name) ? String(r.name) : "";
          if (!name) return;
          tree.appendChild(buildLinerNode(name));
        });

        // Re-bind behaviors on new DOM
        ensureSummariesTabbable();
        collapseAllOnLoad();
        setupLiners();
        setupShips();

        // Re-apply search filter (if present)
        if (typeof window.__ShipScoresApplyFilter === "function") {
          var input = document.getElementById("linerSearch");
          window.__ShipScoresApplyFilter(input ? input.value : "");
        }

        if (done) done(true);
      } catch (e) {
        log("Dataverse load error:", e && e.message, e);
        if (done) done(false);
      }
    })
    .catch(function (err) {
      log("Dataverse load failed:", err);
      if (done) done(false);
    });
}



  // =========================================================
  // Debug focus logs
  // =========================================================
  function setupDebug() {
    document.addEventListener("focusin", function (e) {
      var t = e.target;
      if (!t || !t.matches) return;

      if (t.matches("summary.browse-tree__summary")) {
        log('FOCUSIN -> SUMMARY "' + textOf(t) + '"');
        return;
      }
      if (t.matches('[data-ship-focus="info"]')) {
        log("FOCUSIN -> INFO", {
          name: t.getAttribute("aria-label") || t.getAttribute("aria-labelledby"),
          visible: isVisible(t),
          tabindex: t.getAttribute("tabindex")
        });
        return;
      }
      if (t.matches('[data-ship-focus="history"]')) {
        log("FOCUSIN -> HISTORY", {
          name: t.getAttribute("aria-label") || t.getAttribute("aria-labelledby"),
          visible: isVisible(t),
          tabindex: t.getAttribute("tabindex")
        });
        return;
      }
      if (t.matches("#linerSearch")) {
        log("FOCUSIN -> SEARCH");
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Tab") log("TAB key pressed", e.shiftKey ? "(shift)" : "");
    });

    log("Debug enabled.");
  }

  // =========================================================
  // Init
  // =========================================================
  function init() {
    log("Init start.");

    syncDocumentTitle();

    setupDebug();
    ensureSummariesTabbable();
    collapseAllOnLoad();

    setupLiners();
    setupShips();
    setupTabRouting();
    setupSearch();

    // Load real liners from Dataverse (accounts) and rebuild the tree
    loadLinersFromDataverse(function (ok) {
      log("Dataverse load complete. ok=", ok);
    });

    log("Init complete.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
