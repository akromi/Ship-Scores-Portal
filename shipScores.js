// shipScores.js
(function () {
  "use strict";

  // Ship Scores — Focus + A11y + Search (liners + ships) + Dataverse vessels
  //
  // Keeps:
  // - initial collapse
  // - tabbable summaries
  // - native tab routing (no custom interceptions)
  // - search matches liners + ships and uses snippet-driven status strings
  //
  // Uses:
  // - Liners + ships loaded from ethi_vessels (OData)
  // - Inspection history loaded LAZY via incidents OData when a ship node is expanded
  //
  // OPTIMIZATION:
  // - ethi_shipweightrange loaded with ethi_vessels query
  // - Stored on ship node (data-vessel-weight)
  // - Filled immediately on expand from cached vessel metadata
  //
  // NOTE:
  // - Last-5-years filtering is applied client-side to avoid tenant-specific
  //   OData function issues.
  // - Wrap summary label text in <span class="browse-tree__label">...</span>
  //   so CSS can add spacing between native marker and label without truncation.
  //
  // CHANGES (2026-02-26 review):
  // - H1: Removed ~80 lines of commented-out dead code
  // - H2: Added user-visible error message on vessel load failure
  // - H3: Enforce aria-live="polite" on search status element
  // - M1: Integrated eTHIDiagnostics structured logging
  // - M2: Removed dead fillTypeAndWeight() code path (info section commented out)
  // - M3: Consolidated window.* into window.ShipScores namespace
  // - M4: Added loading skeleton in tree during vessel fetch
  // - L1: Shared doOdataGet using eTHIDataverse.safeAjax (preferred) with webapi.safeAjax fallback
  // - L2: localeCompare with locale for French accent handling
  // =========================================================

  var DBG = true;

  // =========================================================
  // M1: eTHIDiagnostics integration (matches SSI/GI pattern)
  // =========================================================
  var logger = (function () {
    if (window.eTHIDiagnostics && typeof eTHIDiagnostics.createLogger === "function") {
      return eTHIDiagnostics.createLogger("ShipScores");
    }

    // Fallback logger with structured prefix
    var prefix = "[ShipScores]";
    return {
      log:   function (msg, data) { if (DBG) try { console.log(prefix, msg, data || ""); } catch (e) {} },
      info:  function (msg, data) { if (DBG) try { console.log(prefix, msg, data || ""); } catch (e) {} },
      warn:  function (msg, data) { try { console.warn(prefix, msg, data || ""); } catch (e) {} },
      error: function (msg, data) { try { console.error(prefix, msg, data || ""); } catch (e) {} },
      debug: function (msg, data) { if (DBG) try { console.log(prefix, msg, data || ""); } catch (e) {} }
    };
  })();

  // Tracks whether Dataverse returned any data at all (system-empty vs search-no-match)
  var __ShipScoresData = {
    loaded: false,
    totalLiners: 0,
    totalShips: 0
  };

  // Lazy inspection cache:
  // vesselId -> { loaded:boolean, loading:boolean, rows:[{date,score}], promise:Promise }
  var __InspectionCache = Object.create(null);

  function qsa(root, sel) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function qs(root, sel) {
    return (root || document).querySelector(sel);
  }
  function textOf(el) {
    return (el && el.textContent ? el.textContent : "").trim();
  }

  // =========================================================
  // Summary label wrapper for CSS marker spacing (no truncation)
  // =========================================================
  function setSummaryLabel(summaryEl, labelText, level) {
    if (!summaryEl) return;

    var lvl = parseInt(level, 10);
    if (!lvl || lvl < 1 || lvl > 6) lvl = 2;

    while (summaryEl.firstChild) summaryEl.removeChild(summaryEl.firstChild);

    var heading = document.createElement("h" + String(lvl));
    heading.className = "browse-tree__heading";

    var span = document.createElement("span");
    span.className = "browse-tree__label";
    span.textContent = labelText || "";
    heading.appendChild(span);

    summaryEl.appendChild(heading);
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

  function isFrench() {
    var lang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    return lang.indexOf("fr") === 0;
  }

  // L2: locale-aware sort helper
  function localeSortLocale() {
    return isFrench() ? "fr" : "en";
  }

  function cruiseShipLabel() {
    return isFrench() ? "Navire de croisière" : "Cruise ship";
  }

  function dateOnly(isoDateTime) {
    var s = String(isoDateTime || "");
    return s.length >= 10 ? s.slice(0, 10) : s;
  }

  function formatScore(v) {
    if (v === null || v === undefined || v === "") return "";
    var n = Number(v);
    return isFinite(n) ? (String(n) + "/100") : String(v);
  }

  function isWithinLastYears(isoDateTime, years) {
    if (!isoDateTime) return false;
    var dtMs = Date.parse(isoDateTime);
    if (isNaN(dtMs)) return false;

    var y = (years || 5);
    var now = new Date();
    var cutoffUtcMs = Date.UTC(
      now.getUTCFullYear() - y,
      now.getUTCMonth(),
      now.getUTCDate()
    );

    return dtMs >= cutoffUtcMs;
  }

  function normalizeGuid(g) {
    return String(g || "").trim().replace(/[{}]/g, "");
  }

  function odataGuidLiteral(g) {
    var id = normalizeGuid(g);
    return "guid'" + id + "'";
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
  // L1: Shared OData GET utility
  //
  // Priority:
  //   1. eTHIDataverse.safeAjax — enhanced error parsing, token diagnostics,
  //      structured logging (preferred; from ethiLibrary.js)
  //   2. webapi.safeAjax — basic CSRF-aware AJAX (fallback)
  //
  // Both return jQuery deferreds; we wrap into a native Promise so the
  // rest of shipScores.js can use .then()/.catch() uniformly.
  // =========================================================
  function doOdataGet(url) {
    var hasETHI = window.eTHIDataverse && typeof window.eTHIDataverse.safeAjax === "function";
    var hasWebapi = window.webapi && typeof window.webapi.safeAjax === "function";

    if (!hasETHI && !hasWebapi) {
      return Promise.reject({ status: 0, statusText: "eTHIDataverse.safeAjax / webapi.safeAjax not available" });
    }

    // Both return jQuery deferred; wrap into native Promise (resolves with data only)
    return new Promise(function (resolve, reject) {
      var opts = { type: "GET", url: url, dataType: "json" };
      var deferred;

      if (hasETHI) {
        deferred = window.eTHIDataverse.safeAjax(opts);
        logger.debug("doOdataGet: using eTHIDataverse.safeAjax", { url: url });
      } else {
        deferred = window.webapi.safeAjax(opts);
        logger.debug("doOdataGet: using webapi.safeAjax (fallback)", { url: url });
      }

      deferred
        .done(function (data) { resolve(data); })
        .fail(function (err)  { reject(err); });
    });
  }

  // Normalize OData response to array
  function odataToArray(dataOrRows) {
    return Array.isArray(dataOrRows)
      ? dataOrRows
      : (dataOrRows && Array.isArray(dataOrRows.value) ? dataOrRows.value : []);
  }

  // =========================================================
  // Title sync: make document.title match the rendered page title
  // =========================================================
  function syncDocumentTitle() {
    var h1 = document.getElementById("wb-cont") || qs(document, "main h1") || qs(document, "h1");
    var t = textOf(h1);
    if (t) {
      document.title = t;
      logger.info("document.title set", { title: t });
    } else {
      logger.debug("document.title not changed (no title found)");
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
      // 2026-02-25: Do NOT add role="button" — native <summary> already has
      // disclosure semantics. Adding role="button" forces NVDA into focus mode.
      if (s.getAttribute("role") === "button") s.removeAttribute("role");
    });

    logger.debug("Summaries ensured tabbable");
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
        logger.debug("Region missing", { ship: shipLabel, region: x.key });
        return;
      }

      x.el.setAttribute("role", "region");

      if (x.el.hasAttribute("aria-label")) return;

      // 2026-02-25: Validate existing aria-labelledby references
      var existingLB = x.el.getAttribute("aria-labelledby");
      if (existingLB && document.getElementById(existingLB)) return;
      if (existingLB) {
        x.el.removeAttribute("aria-labelledby");
        logger.debug("A11Y removed orphaned aria-labelledby", { ship: shipLabel, region: x.key, id: existingLB });
      }

      var title = null;
      var cursor = x.el.previousElementSibling;
      while (cursor) {
        var tag = (cursor.tagName || "").toLowerCase();
        if (tag === "h3" || tag === "h4") {
          title = cursor;
          break;
        }
        cursor = cursor.previousElementSibling;
      }

      if (title) {
        if (!title.id) title.id = safeId("shipTitle");
        x.el.setAttribute("aria-labelledby", title.id);
        logger.debug("A11Y name wired", { ship: shipLabel, region: x.key, titleId: title.id });
      } else {
        x.el.setAttribute("aria-label", x.fallback);
        logger.debug("A11Y name fallback set", { ship: shipLabel, region: x.key });
      }
    });
  }

  // Non-interactive regions should NOT be tab stops.
  function setRegionsTabbable(ship, enabled) {
    var r = getShipRegions(ship);
    [r.info, r.history].forEach(function (el) {
      if (!el) return;
      if (el.hasAttribute("tabindex")) el.removeAttribute("tabindex");
    });
  }

  // =========================================================
  // Focus management for expanded ship content — 2026-02-25
  // =========================================================
  function focusShipContent(detailsWrap, shipLabel) {
    if (!detailsWrap) return;

    var heading = detailsWrap.querySelector(".ship-details__title");
    if (!heading) {
      logger.debug("focusShipContent: no heading found", { ship: shipLabel });
      return;
    }

    if (!heading.hasAttribute("tabindex")) {
      heading.setAttribute("tabindex", "-1");
    }

    var delay = 150;
    if (window.UniversalAnnounce && typeof UniversalAnnounce.getATTiming === "function") {
      var timing = UniversalAnnounce.getATTiming();
      delay = timing.focus || 150;
    }

    setTimeout(function () {
      try {
        heading.focus({ preventScroll: false });
        logger.debug("focusShipContent: heading focused", { ship: shipLabel });
      } catch (e) {
        logger.warn("focusShipContent: focus failed", { ship: shipLabel, error: e && e.message });
      }
    }, delay);
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
    logger.debug("All tree nodes collapsed on load");
  }

  // =========================================================
  // Tab routing — native (no custom interception)
  // =========================================================
  function setupTabRouting() {
    logger.debug("Tab routing: native (no custom interception)");
  }

  function getShipScoresText() {
    var el = document.getElementById("shipScoresText");
    return {
      vesselInfoTitle: el?.getAttribute("data-vessel-info-title") || "Vessel information",
      vesselHistoryTitle: el?.getAttribute("data-vessel-history-title") || "Inspection details",
      cruiseLineLabel: el?.getAttribute("data-cruise-line-label") || "Cruise line",
      vesselTypeLabel: el?.getAttribute("data-vessel-type-label") || "Vessel type",
      vesselWeightLabel: el?.getAttribute("data-vessel-weight-label") || "Vessel weight",
      tableCaption: el?.getAttribute("data-table-caption") || "Inspection history",
      dateFormatHint: el?.getAttribute("data-date-format-hint") || "YYYY-MM-DD",
      dateOfInspectionLabel: el?.getAttribute("data-date-of-inspection-label") || "Date of inspection",
      scoreObtainedLabel: el?.getAttribute("data-score-obtained-label") || "Score obtained"
    };
  }

  // =========================================================
  // Lazy inspection history renderers
  // =========================================================
  function renderLoadingRow(shipDetailsEl) {
    var tbody = shipDetailsEl ? shipDetailsEl.querySelector(".ship-details__history tbody") : null;
    if (!tbody) return;
    tbody.innerHTML = "";
    var tr = document.createElement("tr");
    var td = document.createElement("td");
    td.colSpan = 2;
    td.textContent = isFrench() ? "Chargement..." : "Loading...";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function renderEmptyHistoryRow(shipDetailsEl) {
    var tbody = shipDetailsEl ? shipDetailsEl.querySelector(".ship-details__history tbody") : null;
    if (!tbody) return;
    tbody.innerHTML = "";
    var tr = document.createElement("tr");
    var td = document.createElement("td");
    td.colSpan = 2;
    td.textContent = isFrench() ? "Aucun historique d'inspection trouvé." : "No inspection history found.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function renderHistoryIntoShip(shipDetailsEl, rows) {
    var tbody = shipDetailsEl ? shipDetailsEl.querySelector(".ship-details__history tbody") : null;
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!rows || rows.length === 0) {
      renderEmptyHistoryRow(shipDetailsEl);
      return;
    }

    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      var td1 = document.createElement("td");
      var td2 = document.createElement("td");
      td1.textContent = r.date;
      td2.textContent = r.score;
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbody.appendChild(tr);
    });
  }

  function renderHistoryErrorRow(shipDetailsEl) {
    var tbody = shipDetailsEl ? shipDetailsEl.querySelector(".ship-details__history tbody") : null;
    if (!tbody) return;
    tbody.innerHTML = "";
    var tr = document.createElement("tr");
    var td = document.createElement("td");
    td.colSpan = 2;
    td.textContent = isFrench()
      ? "Impossible de charger l'historique d'inspection."
      : "Unable to load inspection history.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  // =========================================================
  // Inspection history: lazy-load per vessel
  // =========================================================
  function buildIncidentsUrlForVessel(vesselId, useGuidLiteral) {
    var idExpr = useGuidLiteral ? odataGuidLiteral(vesselId) : normalizeGuid(vesselId);
    // Ensure raw GUID string (strip guid'...' wrapper if present)
    idExpr = idExpr.replace(/^guid'?/i, "").replace(/'/g, "");

    var filter =
      "(" +
        "ethi_finalreportcreated ne null" +
        " and statecode eq 0" +
        " and statuscode ne 6" +
        " and ethi_establishmenttype eq 992800002" +
        " and _ethi_conveyance_value ne null" +
        " and ethi_inspectionscope eq 786080000" +
        " and (" +
               "_ethi_rbiinspectiontype_value eq 05aea5d2-11eb-ef11-9342-0022486e14f0" +
               " or _ethi_rbiinspectiontype_value eq 4c5048c5-11eb-ef11-9342-0022486e14f0" +
              ")" +
        " and (_ethi_conveyance_value eq " + idExpr + ")" +
      ")";

    return "/_api/incidents" +
      "?$select=_ethi_conveyance_value,ethi_inspectionenddateandtime,ethi_inspectionscore,statecode,statuscode" +
      "&$filter=" + encodeURIComponent(filter) +
      "&$orderby=" + encodeURIComponent("ethi_inspectionenddateandtime desc") +
      "&$top=1000";
  }

  function fetchIncidentsWithFallback(vesselId) {
    // Try 1: guid'...'
    var url1 = buildIncidentsUrlForVessel(vesselId, true);
    logger.debug("Inspection lazy-load: GET (guid literal)", { vesselId: vesselId });

    return doOdataGet(url1).catch(function (err1) {
      var st = err1 && err1.status;
      if (st === 400) {
        var url2 = buildIncidentsUrlForVessel(vesselId, false);
        logger.debug("Inspection lazy-load: RETRY (raw guid) after 400", { vesselId: vesselId });
        return doOdataGet(url2);
      }
      throw err1;
    });
  }

  function loadInspectionHistoryForVessel(vesselIdRaw) {
    var vesselId = normalizeGuid(vesselIdRaw);
    if (!vesselId) return Promise.resolve({ rows: [] });

    var c = __InspectionCache[vesselId];
    if (c && c.loaded) return Promise.resolve({ rows: c.rows || [] });
    if (c && c.loading && c.promise) return c.promise;

    var p = fetchIncidentsWithFallback(vesselId)
      .then(function (dataOrRows) {
        var rows = odataToArray(dataOrRows);
        logger.debug("Inspection lazy-load rows (raw)", { vesselId: vesselId, count: rows.length });

        var outRows = [];
        rows.forEach(function (r) {
          var iso = r ? r.ethi_inspectionenddateandtime : null;
          if (!iso) return;
          if (!isWithinLastYears(iso, 5)) return;

          outRows.push({
            date: dateOnly(iso),
            score: formatScore(r.ethi_inspectionscore)
          });
        });

        outRows.sort(function (a, b) {
          return (a.date < b.date) ? 1 : (a.date > b.date ? -1 : 0);
        });

        __InspectionCache[vesselId] = { loaded: true, loading: false, rows: outRows };
        return { rows: outRows };
      })
      .catch(function (err) {
        try {
          if (err && err.status) {
            logger.error("Inspection lazy-load failed", {
              vesselId: vesselId, status: err.status, statusText: err.statusText
            });
          } else {
            logger.error("Inspection lazy-load failed", { vesselId: vesselId, error: err });
          }
        } catch (e) {}

        // Do NOT mark as loaded on error — allows retry on next expand
        __InspectionCache[vesselId] = { loaded: false, loading: false, rows: [] };
        return { rows: [], error: true };
      });

    __InspectionCache[vesselId] = { loaded: false, loading: true, rows: [], promise: p };
    return p;
  }

  // =========================================================
  // Setup ships & liners (idempotent: mark nodes bound)
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
        logger.debug("TOGGLE ship", { ship: shipLabel, open: ship.open });
        ensureRegionSemantics(ship);

        if (!ship.open) {
          setRegionsTabbable(ship, false);
          return;
        }

        setRegionsTabbable(ship, true);

        var vesselId = ship.getAttribute("data-vessel-id") || "";
        var detailsWrap = ship.querySelector(":scope > .ship-details") || ship.querySelector(".ship-details");

        renderLoadingRow(detailsWrap);

        loadInspectionHistoryForVessel(vesselId).then(function (r) {
          if (r && r.error) {
            renderHistoryErrorRow(detailsWrap);
            logger.warn("Inspection history error rendered", { ship: shipLabel, vesselId: normalizeGuid(vesselId) });
            focusShipContent(detailsWrap, shipLabel);
            return;
          }

          renderHistoryIntoShip(detailsWrap, (r && r.rows) ? r.rows : []);
          logger.debug("Inspection history rendered", {
            ship: shipLabel,
            vesselId: normalizeGuid(vesselId),
            rows: (r && r.rows) ? r.rows.length : 0
          });

          focusShipContent(detailsWrap, shipLabel);
        });
      });

      if (sum) {
        sum.addEventListener("focus", function () {
          logger.debug("FOCUS ship summary", { ship: shipLabel, open: ship.open });
        });
      }
    });

    logger.debug("Ships initialized", { count: qsa(document, "details.browse-tree__ship").length });
  }

  function setupLiners() {
    qsa(document, "details.browse-tree__liner").forEach(function (liner) {
      if (liner.getAttribute("data-liner-bound") === "1") return;
      liner.setAttribute("data-liner-bound", "1");

      var sum = getSummary(liner);
      var linerLabel = textOf(sum) || "(liner)";

      liner.addEventListener("toggle", function () {
        logger.debug("TOGGLE liner", { liner: linerLabel, open: liner.open });

        if (!liner.open) {
          qsa(liner, "details.browse-tree__ship").forEach(function (ship) {
            ship.open = false;
            setRegionsTabbable(ship, false);
          });
        }
      });
    });

    logger.debug("Liners initialized", { count: qsa(document, "details.browse-tree__liner").length });
  }

  // =========================================================
  // Search (snippet-driven status strings)
  // =========================================================
  function setupSearch() {
    var input = document.getElementById("linerSearch");
    var status = document.getElementById("linerSearchStatus");
    var tree = document.getElementById("browseTree");

    if (!input || !status || !tree) {
      logger.warn("Search not initialized: missing elements", {
        hasInput: !!input, hasStatus: !!status, hasTree: !!tree
      });
      return;
    }

    // H3: Enforce aria-live="polite" on search status for screen readers
    if (!status.hasAttribute("aria-live")) {
      status.setAttribute("aria-live", "polite");
    }
    if (!status.hasAttribute("aria-atomic")) {
      status.setAttribute("aria-atomic", "true");
    }

    function linerEls() { return qsa(tree, "details.browse-tree__liner"); }
    function shipEls(liner) { return qsa(liner, "details.browse-tree__ship"); }

    function readStatusStrings() {
      var i18n = document.getElementById("shipScores_i18n");
      var node = i18n || status;
      return {
        loading: node.getAttribute("data-status-loading") || "",
        empty: node.getAttribute("data-status-empty") || "",
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

    function setLoadingStatus() {
      var s = readStatusStrings();
      if (s.loading) status.textContent = s.loading;
    }

    function setEmptyStatus() {
      var s = readStatusStrings();
      status.textContent = s.empty || s.none || "";
    }

    function setStatusText(q, matchedLiners, matchedShips) {
      var s = readStatusStrings();
      var hasAnyData = (__ShipScoresData.loaded && (__ShipScoresData.totalLiners > 0 || __ShipScoresData.totalShips > 0));

      if (__ShipScoresData.loaded && !hasAnyData) {
        setEmptyStatus();
        return;
      }
      if (!q) {
        status.textContent = s.cleared || "";
        return;
      }
      if (matchedLiners === 0 && matchedShips === 0) {
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
      logger.debug("Search applied", { query: q || "(empty)", matchedLiners: matchedLiners, matchedShips: matchedShips });
    }

    input.addEventListener("input", function () { applyFilter(input.value); });
    input.addEventListener("search", function () { applyFilter(input.value); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        input.value = "";
        applyFilter("");
      }
    });

    // M3: Expose via consolidated namespace
    window.ShipScores = window.ShipScores || {};
    window.ShipScores.applyFilter = applyFilter;
    window.ShipScores.setLoading = setLoadingStatus;
    window.ShipScores.setEmpty = setEmptyStatus;

    // Backward-compat aliases (safe to remove once all callers updated)
    window.__ShipScoresApplyFilter = applyFilter;
    window.__ShipScoresSetLoading = setLoadingStatus;
    window.__ShipScoresSetEmpty = setEmptyStatus;

    applyFilter(input.value);
    logger.info("Search initialized");
  }

  function buildLinerNode(linerName) {
    var d = document.createElement("details");
    d.className = "browse-tree__liner";

    var sum = document.createElement("summary");
    sum.className = "browse-tree__summary";
    sum.setAttribute("tabindex", "0");
    setSummaryLabel(sum, linerName, 2);

    var panel = document.createElement("div");
    panel.className = "browse-tree__panel";

    d.appendChild(sum);
    d.appendChild(panel);
    return d;
  }

  // =========================================================
  // Ship details template (cloned from server-rendered demo HTML)
  // =========================================================
  var __shipDetailsTemplate = null;

  function getShipDetailsTemplate() {
    if (__shipDetailsTemplate) return __shipDetailsTemplate;

    var demo = document.querySelector(".browse-tree__ship .ship-details");
    if (!demo) {
      var ui = getShipScoresText();
      var fb = document.createElement("div");
      fb.className = "ship-details";
      fb.innerHTML =
        '<h4 class="ship-details__title">' + ui.vesselHistoryTitle + '</h4>' +
        '<section data-ship-focus="history" role="region" class="ship-details__history">' +
          '<table class="ship-details__table table table-striped table-hover">' +
            '<caption class="wb-inv">' + ui.tableCaption +
              '<span> (</span>' + ui.dateFormatHint + '<span>) </span>' +
            '</caption>' +
            '<thead><tr>' +
              '<th scope="col">' + ui.dateOfInspectionLabel +
                ' <span>(<span>' + ui.dateFormatHint + '</span>)</span>' +
              '</th>' +
              '<th scope="col">' + ui.scoreObtainedLabel + '</th>' +
            '</tr></thead>' +
            '<tbody></tbody>' +
          '</table>' +
        '</section>';

      __shipDetailsTemplate = fb;
      return __shipDetailsTemplate;
    }

    __shipDetailsTemplate = demo.cloneNode(true);
    return __shipDetailsTemplate;
  }

  function makeShipDomId(prefix) {
    return prefix + "_" + Math.random().toString(36).slice(2, 8) + "_" + Date.now().toString(36);
  }

  function buildShipNode(ownerName, shipName, vesselId, weight) {
    var ship = document.createElement("details");
    ship.className = "browse-tree__ship";
    ship.setAttribute("data-ship-name", shipName);

    if (vesselId) ship.setAttribute("data-vessel-id", normalizeGuid(vesselId));
    if (weight) ship.setAttribute("data-vessel-weight", String(weight));

    var sum = document.createElement("summary");
    sum.className = "browse-tree__summary";
    sum.setAttribute("tabindex", "0");
    setSummaryLabel(sum, shipName, 3);

    var detailsWrap = getShipDetailsTemplate().cloneNode(true);

    // Fix IDs + aria-labelledby so clones are valid
    var allTitles = detailsWrap.querySelectorAll(".ship-details__title");
    var infoTitle = detailsWrap.querySelector('[id$="_info_title"], [id*="_info_title"]') || allTitles[0] || null;
    var histTitle = detailsWrap.querySelector('[id$="_hist_title"], [id*="_hist_title"]') || allTitles[1] || null;

    var infoSection = detailsWrap.querySelector('section[data-ship-focus="info"]');
    var histSection = detailsWrap.querySelector('section[data-ship-focus="history"]');
    if (!infoSection && !histTitle && infoTitle) {
      histTitle = infoTitle;
      infoTitle = null;
    }

    var infoId = makeShipDomId("ship_info_title");
    var histId = makeShipDomId("ship_hist_title");

    if (infoTitle) infoTitle.id = infoId;
    if (histTitle) histTitle.id = histId;

    if (infoSection && infoTitle) infoSection.setAttribute("aria-labelledby", infoId);
    if (histSection && histTitle) histSection.setAttribute("aria-labelledby", histId);

    // Fill "Cruise line" (owner) value + type immediately (if info section exists in template)
    try {
      var dds = detailsWrap.querySelectorAll(".ship-details__info-box dd");
      if (dds && dds.length >= 1) dds[0].textContent = ownerName;
      if (dds && dds.length >= 2) dds[1].textContent = cruiseShipLabel();
      if (dds && dds.length >= 3) dds[2].textContent = "";
    } catch (e) {}

    // Leave history tbody empty until lazy-load on expand
    try {
      var tbody = detailsWrap.querySelector(".ship-details__history tbody");
      if (tbody) tbody.innerHTML = "";
    } catch (e2) {}

    ship.appendChild(sum);
    ship.appendChild(detailsWrap);
    return ship;
  }

  function primeShipDetailsTemplateCache() {
    try {
      if (__shipDetailsTemplate) return;
      var demo = document.querySelector(".browse-tree__ship .ship-details");
      if (demo) {
        __shipDetailsTemplate = demo.cloneNode(true);
        logger.info("Primed ship details template cache from demo DOM");
      } else {
        logger.debug("No demo ship-details found; will use fallback template");
      }
    } catch (e) {
      logger.warn("primeShipDetailsTemplateCache failed", { error: e && e.message });
    }
  }

  function normalizeShipSummaryMarkup(root) {
    var scope = root || document;

    (scope.querySelectorAll("details.browse-tree__ship > summary") || []).forEach(function (s) {
      if (!s.classList.contains("browse-tree__summary")) {
        s.classList.add("browse-tree__summary");
      }
      if (!s.querySelector(".browse-tree__label")) {
        var d = s.closest("details");
        var isShip = d && d.classList && d.classList.contains("browse-tree__ship");
        setSummaryLabel(s, textOf(s), isShip ? 3 : 2);
      }
    });

    (scope.querySelectorAll("details.browse-tree__liner") || []).forEach(function (liner) {
      var panel = liner.querySelector(".browse-tree__panel");
      if (!panel) return;
      Array.from(liner.children).forEach(function (child) {
        if (child && child.matches && child.matches("details.browse-tree__ship")) {
          panel.appendChild(child);
        }
      });
    });
  }

  // =========================================================
  // M4: Loading skeleton for tree area during vessel fetch
  // =========================================================
  function showTreeLoading(tree) {
    var msg = isFrench() ? "Chargement des données..." : "Loading cruise ship data...";
    tree.innerHTML =
      '<div class="browse-tree__loading" role="status" aria-live="polite">' +
        '<p>' + msg + '</p>' +
      '</div>';
  }

  // =========================================================
  // H2: User-visible error message on vessel load failure
  // =========================================================
  function showTreeError(tree) {
    var msg = isFrench()
      ? "Impossible de charger les données des navires. Veuillez réessayer plus tard."
      : "Unable to load cruise ship data. Please try again later.";
    tree.innerHTML =
      '<div class="browse-tree__error" role="alert">' +
        '<p class="text-danger">' + msg + '</p>' +
      '</div>';
  }

  // =========================================================
  // Dataverse OData load from ethi_vessels (Active only)
  // =========================================================
  function loadLinersAndShipsFromVessels(done) {
    var tree = document.getElementById("browseTree");
    if (!tree) {
      logger.warn("Vessels OData load skipped: #browseTree not found");
      if (done) done(false);
      return;
    }

    var hasETHI = window.eTHIDataverse && typeof window.eTHIDataverse.safeAjax === "function";
    var hasWebapi = window.webapi && typeof window.webapi.safeAjax === "function";

    if (!hasETHI && !hasWebapi) {
      logger.warn("Vessels OData load skipped: eTHIDataverse / webapi not available");
      if (done) done(false);
      return;
    }

    // Announce loading (status text + M4 tree skeleton)
    try {
      var ssNs = window.ShipScores || {};
      if (typeof ssNs.setLoading === "function") ssNs.setLoading();
      else if (typeof window.__ShipScoresSetLoading === "function") window.__ShipScoresSetLoading();
    } catch (e) {}
    showTreeLoading(tree);

    // GUIDs for ethi_rbiinspectiontype_value:
    // Routine - Announced:   05aea5d2-11eb-ef11-9342-0022486e14f0
    // Routine - Unannounced: 4c5048c5-11eb-ef11-9342-0022486e14f0
    var url =
      "/_api/ethi_vessels" +
      "?$select=ethi_establishmenttype,ethi_name,_ethi_ownerid_value,ethi_vesselid,statecode,statuscode,ethi_shipweightrange" +
      "&$expand=" +
      "ethi_Incident_Conveyance_ethi_vessel(" +
      "$select=incidentid;" +
      "$filter=(" +
      "ethi_inspectionscore ne null and " +
      "Microsoft.Dynamics.CRM.LastXYears(PropertyName='ethi_inspectionenddateandtime',PropertyValue=5) and " +
      "ethi_inspectionscope eq 786080000 and " +
      "statecode eq 0 and " +
      "statuscode ne 6 and " +
      "_ethi_rbiinspectiontype_value eq 05aea5d2-11eb-ef11-9342-0022486e14f0 and " +
      "ethi_finalreportcreated ne null" +
      ")" +
      ")," +
      "ethi_OwnerId($select=name,statecode)" +
      "&$filter=" + encodeURIComponent(
        "statecode eq 0 and " +
        "ethi_Incident_Conveyance_ethi_vessel/any(o1:" +
        "o1/ethi_inspectionscore ne null and " +
        "o1/Microsoft.Dynamics.CRM.LastXYears(PropertyName='ethi_inspectionenddateandtime',PropertyValue=5) and " +
        "o1/ethi_inspectionscope eq 786080000 and " +
        "o1/statecode eq 0 and " +
        "o1/statuscode ne 6 and " +
        "(" +
        "o1/_ethi_rbiinspectiontype_value eq 05aea5d2-11eb-ef11-9342-0022486e14f0 or " +
        "o1/_ethi_rbiinspectiontype_value eq 4c5048c5-11eb-ef11-9342-0022486e14f0" +
        ") and " +
        "o1/ethi_finalreportcreated ne null and " +
        "o1/_ownerid_value ne null" +
        ") and " +
        "(ethi_OwnerId/name ne null and ethi_OwnerId/statecode eq 0)"
      ) +
      "&$top=10000";

    logger.info("Vessels OData load: GET", { url: url });

    doOdataGet(url)
      .then(function (dataOrRows) {
        var rows = odataToArray(dataOrRows);

        logger.info("Vessels OData load: rows returned", { count: rows.length });

        __ShipScoresData.loaded = true;
        __ShipScoresData.totalShips = 0;
        __ShipScoresData.totalLiners = 0;

        // ownerName -> shipName -> { vesselId, weight }
        var map = Object.create(null);

        rows.forEach(function (r) {
          var ownerName = "";
          try {
            ownerName = r && r.ethi_OwnerId && r.ethi_OwnerId.name ? String(r.ethi_OwnerId.name).trim() : "";
          } catch (e) {}

          var shipName = (r && r.ethi_name) ? String(r.ethi_name).trim() : "";
          var vesselId = (r && r.ethi_vesselid) ? normalizeGuid(r.ethi_vesselid) : "";
          var weight = (r && r.ethi_shipweightrange !== null && r.ethi_shipweightrange !== undefined)
            ? String(r.ethi_shipweightrange)
            : "";

          if (!ownerName || !shipName || !vesselId) return;

          if (!map[ownerName]) map[ownerName] = Object.create(null);
          map[ownerName][shipName] = { vesselId: vesselId, weight: weight };
        });

        // Clear loading skeleton
        tree.innerHTML = "";

        // L2: locale-aware sort
        var locale = localeSortLocale();
        var owners = Object.keys(map).sort(function (a, b) {
          return a.localeCompare(b, locale, { sensitivity: "base" });
        });
        __ShipScoresData.totalLiners = owners.length;

        var shipCount = 0;

        // If Dataverse has no data at all, announce empty and stop
        if (owners.length === 0) {
          try {
            var ssNs2 = window.ShipScores || {};
            if (typeof ssNs2.setEmpty === "function") ssNs2.setEmpty();
            else if (typeof window.__ShipScoresSetEmpty === "function") window.__ShipScoresSetEmpty();
          } catch (e2) {}

          var applyFn = (window.ShipScores && window.ShipScores.applyFilter) || window.__ShipScoresApplyFilter;
          if (typeof applyFn === "function") {
            var input0 = document.getElementById("linerSearch");
            applyFn(input0 ? input0.value : "");
          }

          if (done) done(true);
          return;
        }

        owners.forEach(function (ownerName) {
          var linerNode = buildLinerNode(ownerName);
          tree.appendChild(linerNode);

          var panel = linerNode.querySelector(".browse-tree__panel");
          if (!panel) {
            logger.error("Liner panel not found", { owner: ownerName });
            return;
          }

          var ships = Object.keys(map[ownerName]).sort(function (a, b) {
            return a.localeCompare(b, locale, { sensitivity: "base" });
          });

          ships.forEach(function (shipName) {
            var meta = map[ownerName][shipName] || {};
            var shipsWrap = panel.querySelector(".browse-tree__ships") || panel;

            shipsWrap.appendChild(
              buildShipNode(ownerName, shipName, meta.vesselId || "", meta.weight || "")
            );
            shipCount++;
          });
        });

        __ShipScoresData.totalShips = shipCount;

        normalizeShipSummaryMarkup(tree);

        // Re-bind behaviors on new DOM
        ensureSummariesTabbable();
        collapseAllOnLoad();
        setupLiners();
        setupShips();

        // Re-apply search filter if present
        var applyFn2 = (window.ShipScores && window.ShipScores.applyFilter) || window.__ShipScoresApplyFilter;
        if (typeof applyFn2 === "function") {
          var input = document.getElementById("linerSearch");
          applyFn2(input ? input.value : "");
        }

        if (done) done(true);
      })
      .catch(function (err) {
        // H2: Show user-visible error message
        logger.error("Vessels OData load failed", { error: err });
        showTreeError(tree);
        if (done) done(false);
      });
  }

  // =========================================================
  // Debug focus logs
  // =========================================================
  function setupDebug() {
    if (!DBG) return;

    document.addEventListener("focusin", function (e) {
      var t = e.target;
      if (!t || !t.matches) return;

      if (t.matches("summary.browse-tree__summary")) {
        logger.debug("FOCUSIN -> SUMMARY", { text: textOf(t) });
        return;
      }
      if (t.matches('[data-ship-focus="info"]')) {
        logger.debug("FOCUSIN -> INFO", {
          name: t.getAttribute("aria-label") || t.getAttribute("aria-labelledby"),
          visible: isVisible(t)
        });
        return;
      }
      if (t.matches('[data-ship-focus="history"]')) {
        logger.debug("FOCUSIN -> HISTORY", {
          name: t.getAttribute("aria-label") || t.getAttribute("aria-labelledby"),
          visible: isVisible(t)
        });
        return;
      }
      if (t.matches("#linerSearch")) {
        logger.debug("FOCUSIN -> SEARCH");
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Tab") logger.debug("TAB key", { shift: e.shiftKey });
    });

    logger.debug("Debug listeners enabled");
  }

  // =========================================================
  // Init
  // =========================================================
  function init() {
    logger.info("=== Init start ===");

    syncDocumentTitle();
    setupDebug();
    ensureSummariesTabbable();
    collapseAllOnLoad();

    setupLiners();
    setupShips();
    setupTabRouting();
    setupSearch();

    primeShipDetailsTemplateCache();

    loadLinersAndShipsFromVessels(function (ok) {
      logger.info("Vessels OData load complete", { success: ok });
    });

    logger.info("=== Init complete ===");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
