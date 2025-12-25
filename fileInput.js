// =======================
// Accessibility helpers (structural only — no UX/labels/handlers)
// =======================
// Akram 20251225 14:05
//
function patchFileControlForAccessibility(baseId) {
  const input = document.getElementById(`${baseId}_input_file`);
  const label = document.getElementById(`${baseId}_label`);
  if (!input || !label) return;
  if (input.dataset.accessibilityPatched === "1") return;
  input.dataset.accessibilityPatched = "1";

  // Expose native input for assistive tech (don't keep display:none)
  input.style.display = "";
  input.classList.add("wb-inv"); // visually hidden, still focusable
  // IMPORTANT: prevent invisible tab stop + VO "form end" edge cases
  input.setAttribute("tabindex", "-1");
  input.setAttribute("aria-hidden", "true");

  // Programmatic name via <label for> + aria-labelledby
  label.setAttribute("for", input.id);
  input.removeAttribute("aria-label");
  input.setAttribute("aria-labelledby", label.id);

  // Optional polite live region
  const container = input.closest(".file-control-container")?.parentElement || input.parentElement;
  const liveId = `${baseId}_live`;
  if (container && !document.getElementById(liveId)) {
    const live = document.createElement("div");
    live.id = liveId;
    live.className = "wb-inv";
    live.setAttribute("aria-live", "polite");
    container.appendChild(live);
  }
}

function patchAllFileControlsForAccessibility() {
  document.querySelectorAll('input[type="file"][id$="_input_file"]').forEach(inp => {
    const baseId = inp.id.replace(/_input_file$/, "");
    patchFileControlForAccessibility(baseId);
  });
  sanitizeFileButtons();
}

// Expose (new names)
window.patchFileControlForAccessibility = patchFileControlForAccessibility;
window.patchAllFileControlsForAccessibility = patchAllFileControlsForAccessibility;

function sanitizeFileButtons() {
  $('.file-control-container, .container-file-input').each(function () {
    const $block = $(this);
    const $btn = $block.find('button.btn-for-file-input').first();
    const $input = $block.find('input[type="file"]').first();

    if (!$btn.length || !$input.length) return;

    // 1) Remove attributes that should never be on a button
    $btn.removeAttr('required')
      .removeAttr('aria-invalid')
      .removeAttr('aria-describedby')   // relabelAllFileUploadControls owns this
      .removeAttr('aria-label')         // relabelAllFileUploadControls owns this
      .removeAttr('aria-labelledby');   // CRITICAL: avoid label becoming the button name

    // 2) Keep only a harmless relationship
    $btn.attr('aria-controls', $input.attr('id'));
  });
}



/* ============================================================
   File field stock cleanup (ALL stock file errors suppressed)
   - Disables PP Required validator on hidden filename partners
   - Hides ALL inline ".error_message" blocks in the file cell
   - Hides stock <span id="<base>_err"> if present
   - Re-hides on change, partial postbacks, and DOM mutations
  - Leaves YOUR custom validators fully in charge
   ============================================================ */

(function () {
  const LOG  = () => {};
  const DBG  = () => {};

  // Disable/hide built-in Required validator for a given base id
  function disableRequiredHidden(baseId){
    const ids = [
      'RequiredFieldValidator' + baseId + 'hidden_filename',
      'RequiredFieldValidator' + baseId + '_hidden_filename'
    ];
    let touched = 0;

    (window.Page_Validators||[]).forEach(v=>{
      if (!v) return;
      if (ids.includes(String(v.id))) {
        // stop it from failing + displaying
        v.enabled = false;
        v.isvalid = true;
        v.evaluationfunction = function(){ return true; };
        if (typeof window.ValidatorUpdateDisplay === 'function') {
          try { window.ValidatorUpdateDisplay(v); } catch(e){}
        }
        touched++;
        LOG('Disabled PP RequiredFieldValidator:', v.id, 'target=', v.controltovalidate);
        // also hide the DOM span if present
        const el = document.getElementById(v.id);
        if (el) el.style.display = 'none';
      }
    });

    // Fallback: hide DOM span directly if not reflected in Page_Validators yet
    ids.forEach(id=>{
      const el = document.getElementById(id);
      if (el) { el.style.display = 'none'; touched++; DBG('Hid DOM validator span:', id); }
    });

    if (!touched) DBG('No Required validator found for', baseId, '(ok if PP didn’t render it here)');
  }

  // Find the TD/cell that houses the control + message
  function findCell(baseId){
    const label = document.getElementById(baseId + '_label');
    if (!label) return null;
    return label.closest('.clearfix.cell, td.cell, .form-control-cell, td, .cell');
  }

  // Hide ALL stock inline error nodes inside the file cell
  function hideAllInlineStockMessages(baseId){
    const cell = findCell(baseId);
    if (!cell) { DBG('No cell found for', baseId); return; }

    // 1) Hide every .error_message block regardless of text
    const blocks = cell.querySelectorAll('.error_message');
    if (blocks.length) {
      blocks.forEach(b => { b.style.display = 'none'; b.setAttribute('data-suppressed','1'); });
      LOG('Suppressed', blocks.length, '.error_message block(s) for', baseId);
    } else {
      DBG('No .error_message blocks for', baseId);
    }

    // 2) Hide stock <span id="<base>_err"> ONLY if it is NOT under the label
    const label = document.getElementById(baseId + '_label');
    const stock = document.getElementById(baseId + '_err');
    const isUnderLabel = !!(label && stock && label.contains(stock));
    if (stock && !isUnderLabel) {
      stock.style.display = 'none';
      DBG('Hid stock inline span outside label:', baseId + '_err');
    }
  }

  // MutationObserver: keep hiding anything new that appears in the cell
  const observers = new Map();
  function ensureObserver(baseId){
    const cell = findCell(baseId);
    if (!cell || observers.has(baseId)) return;

    const obs = new MutationObserver((mutations)=>{
      let changed = false;
      for (const m of mutations) {
        if (m.type === 'childList' || m.type === 'subtree' || m.addedNodes?.length) {
          // If any new error nodes appear, squash them
          const blocks = cell.querySelectorAll('.error_message');
          blocks.forEach(b => {
            if (b.style.display !== 'none') { b.style.display = 'none'; changed = true; }
          });

          // Only hide <base>_err if it's not under the label (our custom inline lives under the label)
          const label = document.getElementById(baseId + '_label');
          const stock = document.getElementById(baseId + '_err');
          const isUnderLabel = !!(label && stock && label.contains(stock));
          if (stock && !isUnderLabel && stock.style.display !== 'none') {
            stock.style.display = 'none';
            changed = true;
          }
        }
      }
      if (changed) LOG('MutationObserver: re-suppressed stock messages for', baseId);
    });

    obs.observe(cell, { childList: true, subtree: true });
    observers.set(baseId, obs);
    DBG('Observer attached for', baseId);
  }

  // Re-hide the inline blocks after any change on the visible file input
  function wireChangeHide(baseId){
    const fin = document.getElementById(baseId + '_input_file') || document.getElementById(baseId);
    if (!fin) { DBG('File input not found for', baseId); return; }
    fin.addEventListener('change', function(){
      hideAllInlineStockMessages(baseId);
    });
  }

  // Public API
  window.suppressStockFileErrors = function(baseIds){
    (baseIds||[]).forEach(id=>{
      LOG('--- suppressStockFileErrors for', id, '---');
      disableRequiredHidden(id);
      hideAllInlineStockMessages(id);
      ensureObserver(id);
      wireChangeHide(id);
    });

    // Handle partial postbacks that may re-inject validators / blocks
    if (window.Sys && Sys.WebForms && Sys.WebForms.PageRequestManager) {
      try {
        Sys.WebForms.PageRequestManager.getInstance().add_endRequest(function(){
          LOG('Partial postback detected; re-suppressed for', baseIds);
          (baseIds||[]).forEach(id=>{
            disableRequiredHidden(id);
            hideAllInlineStockMessages(id);
          });
        });
      } catch(e){ /* ignore */ }
    }
  };
})();



// Runtime i18n (reads <html lang> every time)
function fileI18n() {
  const fr = { choose: "Choisir un fichier", change: "Modifier le fichier", delete: "Supprimer", none: "Aucun fichier sélectionné" };
  const en = { choose: "Choose file", change: "Change file", delete: "Delete", none: "No file selected" };
  const lang = (document.documentElement.getAttribute("lang") || "en").toLowerCase();
  return lang.startsWith("fr") ? fr : en;
}


/* ==========================================================
   WET4 / Power Pages File Control Relabeler (Verbose Logs)
   - Idempotent bindings
   - i18n-aware via fileI18n()
   - Accessible (aria-labelledby, aria-controls)
   - Single debounced MutationObserver
   - Extremely chatty diagnostics (no emojis)

   Configure log level at any time:
     window.FILE_LOG_LEVEL = 'debug'; // default
     // 'trace' > 'debug' > 'info' > 'warn' > 'error' > 'off'
   ========================================================== */

(function () {
  // ---------- Logger (FIXED) ----------
  const logger = (() => {
    const levels = { off: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
    const getLevel = () => levels[(window.FILE_LOG_LEVEL || 'warn').toLowerCase()] ?? 2;
    const prefix = '[WET4][FileCtl]';
    const fmt = (msg, ...args) => [`${prefix} ${msg}`, ...args];
    return {
      level: () => getLevel(),
      setLevel: (lvl) => { window.FILE_LOG_LEVEL = String(lvl || 'warn'); },
      trace: (...a) => getLevel() >= 5 && console.log(...fmt(...a)),
      debug: (...a) => getLevel() >= 4 && console.debug(...fmt(...a)),
      info:  (...a) => getLevel() >= 3 && console.info(...fmt(...a)),
      warn:  (...a) => getLevel() >= 2 && console.warn(...fmt(...a)),
      error: (...a) => getLevel() >= 1 && console.error(...fmt(...a)),
    };
  })();

  function _i18n() {
    // Use fileI18n() if available; fallback to EN literals (no FR hard-coding to avoid stale copies)
    try {
      if (typeof fileI18n === 'function') {
        const t = fileI18n();
        if (t && t.choose && t.change && t.delete && t.none) return t;
      }
    } catch (e) {
      logger.warn('fileI18n() threw; using fallback literals', e);
    }
    const lang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
    // Minimal fallback; adjust if you want French here
    if (lang.startsWith('fr')) {
      return { choose: 'Choisir un fichier', change: 'Modifier le fichier', delete: 'Supprimer', none: 'Aucun fichier sélectionné' };
    }
    return { choose: 'Choose file', change: 'Change file', delete: 'Delete', none: 'No file selected' };
  }

  // Helpers for Option B precedence
  function _readMaxBytesFrom($input) {
    const raw = $input.attr('data-max-bytes');
    if (raw && !isNaN(raw)) return parseInt(raw, 10);
    if (typeof window.DEFAULT_MAX_FILE_BYTES === 'number') return window.DEFAULT_MAX_FILE_BYTES;
    return 4 * 1024 * 1024; // default 4 MiB
  }
  function _readAllowedExtFrom($input) {
    const raw = $input.attr('data-allowed-ext') || '';
    return raw ? raw.split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean) : ['pdf','jpg','png','gif'];
  }

  // Goals:
  // 1) Tab onto Choose/Change => announce LABEL + REQUIRED (if required) + button text
  // 2) After file picker returns focus to Choose/Change => announce button text ONLY (no label/required) ONCE
  // 3) Tab onto Delete => announce "Delete" + FILENAME (no label)
  // 4) Remove the hidden native <input type="file"> from tab order (prevents invisible tab stop)
  // 5) Strip tooltips (title="No file selected" / filename) that cause flicker
  // Fixes:
  // - No aria-labelledby on proxy buttons (prevents label being read multiple times)
  // - Choose/Change announces label (+ required) on TAB focus, but NOT when focus returns from picker (skip once)
  // - Delete announces "Delete" + filename (not the label)
  // - Removes hidden native <input type="file"> from tab order (prevents invisible tab stop + VO weirdness)
  // - Strips tooltip titles ("No file selected" / filename) on filename area + buttons

  window.relabelAllFileUploadControls = function relabelAllFileUploadControls() {
    // If patching hasn’t run yet on this page load / redraw, run it now.
    if (!$('.file-control-container').length && $('input[type="file"]').length) {
      try { window.patchAllFileControlsForAccessibility?.(); } catch (e) { logger.warn('relabelAll: patchAll failed', e); }
    }
    const t0 = performance.now();
    const T = (typeof _i18n === "function")
      ? _i18n()
      : { choose: "Choose file", change: "Change file", delete: "Delete", none: "No file selected" };

    const $blocks = $(".file-control-container, .container-file-input");
    logger.info("relabelAllFileUploadControls: start; containers=%d", $blocks.length);

    $blocks.each(function (idx) {
      const b0 = performance.now();
      const $block = $(this);

      const $chooseBtn  = $block.find("button.btn-for-file-input").first();
      const $delBtn     = $block.find("button.btn-for-delete").first();
      const $input      = $block.find('input[type="file"]').first();

      const $nameBox    = $block.find(".file-name-container").first();
      const $textDiv    = $nameBox.find("div").first();
      const $hiddenSpan = $nameBox.find('span[id$="_file_name"]').first();

      if (!$chooseBtn.length || !$input.length) {
        logger.debug("block[%d]: skipped (missing chooseBtn or input)", idx);
        return;
      }

      try {
        const inputId = $input.attr("id") || "";

        // ---- avoid invisible tab stop on native input
        if ($input.attr("tabindex") !== "-1") $input.attr("tabindex", "-1");
        if ($input.attr("aria-hidden") !== "true") $input.attr("aria-hidden", "true");

        // ---- strip tooltip titles (defensive)
        $chooseBtn.removeAttr("title");
        if ($delBtn.length) $delBtn.removeAttr("title");
        if ($nameBox.length) {
          $nameBox.removeAttr("title");
          $nameBox.find("[title]").removeAttr("title");
        }

        // ---- find label id (for describedby)
        let labelId = "";
        if (inputId) {
          const $label = $block.closest(".cell, td, .form-group").find(`label[for="${inputId}"]`).first();
          if ($label.length) {
            if (!$label.attr("id")) $label.attr("id", inputId + "_label");
            labelId = $label.attr("id") || "";
          }
        }

        // ---- compute hasFile WITHOUT relying on visible text (works EN/FR)
        function computeHasFile() {
          const nativeLen = $input.get(0)?.files?.length || 0;
          const hiddenName = ($hiddenSpan.text() || "").trim();
          const hiddenVal = ($block.find('input[type="hidden"][id$="hidden_filename"]').val() || "").trim();
          return !!(nativeLen || hiddenName || hiddenVal);
        }

        // ---- apply state (choose/change text + delete visibility)
        function applyStateNow() {
          const hasFile = computeHasFile();

          const desiredChoose = hasFile ? T.change : T.choose;
          if ($chooseBtn.text().trim() !== desiredChoose) $chooseBtn.text(desiredChoose);
          if ($chooseBtn.attr("aria-label") !== desiredChoose) $chooseBtn.attr("aria-label", desiredChoose);

          if ($delBtn.length) $delBtn.toggle(hasFile);

          logger.debug("block[%d]: applyStateNow -> hasFile=%s delVisible=%s", idx, hasFile, $delBtn.is(":visible"));
        }

        // Initial state set
        applyStateNow();

        // ---- choose/change semantics
        if (inputId && $chooseBtn.attr("aria-controls") !== inputId) $chooseBtn.attr("aria-controls", inputId);

        // Critical: do not let label become button name
        $chooseBtn.removeAttr("aria-labelledby");
        $chooseBtn.removeAttr("required aria-invalid");

        // We only add describedby on focus (and we suppress once after picker return)
        const NS = ".fileUxChooseAnnounce";
        $chooseBtn.off(NS); // clears focusin/focusout/click for this namespace

        $chooseBtn.on("focusin" + NS, function () {
          const skip = !!$chooseBtn.data("skipDescOnce");
          if (skip) {
            $chooseBtn.removeAttr("aria-describedby");
            $chooseBtn.data("skipDescOnce", 0);
            logger.debug("block[%d]: choose focusin -> suppressed label once", idx);
            return;
          }
          if (labelId) $chooseBtn.attr("aria-describedby", labelId);
          else $chooseBtn.removeAttr("aria-describedby");
        });

        $chooseBtn.on("focusout" + NS, function () {
          // keep stable for next tab-in
          if (labelId) $chooseBtn.attr("aria-describedby", labelId);
          else $chooseBtn.removeAttr("aria-describedby");
        });

        $chooseBtn.on("click" + NS, function () {
          $chooseBtn.data("skipDescOnce", 1);
        });

        // When file picked/cleared through the real input (may happen)
        $input.off("change" + NS).on("change" + NS, function () {
          $chooseBtn.data("skipDescOnce", 1);
          // SINGLE async settle pass (no loops)
          setTimeout(applyStateNow, 0);
        });

        // ---- delete semantics + LOOP-SAFE hide after delete
        if ($delBtn.length) {
          if ($delBtn.attr("aria-label") !== T.delete) $delBtn.attr("aria-label", T.delete);
          $delBtn.removeAttr("aria-labelledby");

          if ($nameBox.length && !$nameBox.attr("id")) {
            $nameBox.attr("id", inputId ? (inputId + "_filename_status") : ("file_filename_status_" + idx));
          }

          const fileNameId =
            ($hiddenSpan.length && $hiddenSpan.attr("id")) ? $hiddenSpan.attr("id") :
            ($nameBox.length && $nameBox.attr("id")) ? $nameBox.attr("id") : "";

          if (fileNameId) $delBtn.attr("aria-describedby", fileNameId);
          else $delBtn.removeAttr("aria-describedby");

          if (inputId && $delBtn.attr("aria-controls") !== inputId) $delBtn.attr("aria-controls", inputId);

          const DEL_NS = ".fileUxDeleteFix";
          $delBtn.off(DEL_NS).on("click" + DEL_NS, function () {
            // Reentrancy guard: prevent scheduling cascades if observers re-run relabel quickly
            if ($delBtn.data("postDeletePending")) {
              logger.debug("block[%d]: delete click ignored (postDeletePending)", idx);
              return;
            }
            $delBtn.data("postDeletePending", 1);

            // SINGLE settle pass; do not chain multiple timers
            setTimeout(() => {
              try {
                applyStateNow();
              } finally {
                $delBtn.data("postDeletePending", 0);
              }
            }, 0);
          });
        }

        logger.debug("block[%d]: relabel done (labelId=%o)", idx, labelId);
      } catch (e) {
        logger.error("block[%d]: error during relabel", idx, e);
      } finally {
        logger.trace("block[%d]: duration=%dms", idx, Math.round(performance.now() - b0));
      }
    });

    logger.info("relabelAllFileUploadControls: done in %dms", Math.round(performance.now() - t0));
  };


  //Single, debounced observer (re-applies after PP redraws)
  function observeFileControls() {

    function applyFilePatches() {
      try { window.patchAllFileControlsForAccessibility?.(); } catch (e) { logger.warn('patchAllFileControlsForAccessibility failed', e); }
      try { window.relabelAllFileUploadControls?.(); } catch (e) { logger.error('relabelAllFileUploadControls failed', e); }
    }

    logger.info('observeFileControls: init -> first apply');
    applyFilePatches();

    let debounceTimer = null;
    const DEBOUNCE_MS = 180;

    const obs = new MutationObserver(function (mutations) {
      let relevant = false;

      for (let i = 0; i < mutations.length && !relevant; i++) {
        const m = mutations[i];

        // If a redraw happens before wrappers exist, we still want to catch raw file inputs:
        if (
          (m.target && m.target.nodeType === 1 && (
            m.target.matches?.('.file-control-container') ||
            m.target.matches?.('input[type="file"]') ||
            $(m.target).find('input[type="file"]').length
          )) ||
          $(m.target).closest('.file-control-container').length
        ) {
          relevant = true;
          break;
        }

        for (let j = 0; j < m.addedNodes.length && !relevant; j++) {
          const n = m.addedNodes[j];
          if (n.nodeType !== 1) continue;

          if (
            n.matches?.('.file-control-container') ||
            n.matches?.('input[type="file"]') ||
            $(n).find('.file-control-container, input[type="file"]').length
          ) {
            relevant = true;
            break;
          }
        }
      }

      if (!relevant) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        logger.info('observeFileControls: mutation -> re-apply');
        applyFilePatches();
      }, DEBOUNCE_MS);
    });

    obs.observe(document.body, { childList: true, subtree: true });
  }

  // Expose for explicit calls (you said SSI Step 3 calls it)
  window.observeFileControls = observeFileControls;
})();


/*
 * LookupLoader (unified) + LookupStore
 * ------------------------------------------------------------
 * One-file drop-in for Power Pages bilingual lookups.
 * - load(): fetches options via Web API, populates <select>, attaches data-en/data-fr
 * - switchLanguage(): relabels (and optionally resorts) without network
 * - Auto-persists the *selected* option to localStorage for Step 5 review
 * - getSavedName(): read EN/FR later on any page
 *
 * Dependencies: jQuery, webapi.safeAjax (or safeAjax). No triggers are fired.
 * Logging: verbose by default
 */

(function (window, $) {
  'use strict';

  // ------------------------------
  // Utilities
  // ------------------------------
  const LOG = {
    info: (...a) => console.log('[Lookup]', ...a),
    warn: (...a) => console.warn('[Lookup]', ...a),
    err: (...a) => console.error('[Lookup]', ...a)
  };

  const isFr = (l) => /^fr/i.test(String(l || 'en'));
  const normGuid = (v) => String(v || '').replace(/[{}]/g, '').toLowerCase();

  function ensureFn(fn) { return typeof fn === 'function' ? fn : null; }
  function ajaxImpl() { return window.webapi?.safeAjax || window.safeAjax; }

  // ------------------------------
  // LookupStore (localStorage)
  // ------------------------------
  const LookupStore = window.LookupStore || (() => {
    const PREFIX = 'ssi.lookup.';
    const toJSON = (o) => { try { return JSON.stringify(o); } catch { return '{}'; } };
    const fromJSON = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };

    function save(fieldId, rec) {
      if (!fieldId) return;
      const payload = {
        guid: normGuid(rec?.guid),
        en: String(rec?.en || '').trim(),
        fr: String(rec?.fr || '').trim(),
        ts: Date.now()
      };
      localStorage.setItem(PREFIX + fieldId, toJSON(payload));
      LOG.info('Saved', fieldId, payload);
    }

    function read(fieldId) { return fromJSON(localStorage.getItem(PREFIX + fieldId)); }

    function getName(fieldId, lang) {
      const r = read(fieldId); if (!r) return null;
      return (isFr(lang) ? r.fr : r.en) || r.en || r.fr || null;
    }

    function persistFromSelect(fieldId) {
      const sel = document.getElementById(fieldId);
      if (!sel || !sel.value) return;
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      save(fieldId, {
        guid: sel.value,
        en: opt?.dataset?.en || opt?.text || '',
        fr: opt?.dataset?.fr || opt?.text || ''
      });
    }

    return { save, read, getName, persistFromSelect };
  })();

  // expose early so pages can read even if load fails later
  window.LookupStore = LookupStore;

  // ------------------------------
  // Web API helpers
  // ------------------------------
  function fetchAll(url, headers) {
    const ajax = ensureFn(ajaxImpl());
    return new Promise((resolve, reject) => {
      if (!ajax) { reject(new Error('safeAjax not available')); return; }
      const acc = [];
      const page = (res) => {
        const v = Array.isArray(res?.value) ? res.value : [];
        acc.push(...v);
        const next = res?.['@odata.nextLink'] || res?.['odata.nextLink'];
        if (next) { ajax({ type: 'GET', url: next, headers, success: page, error: reject }); }
        else { resolve(acc); }
      };
      ajax({ type: 'GET', url, headers, success: page, error: reject });
    });
  }

  // ------------------------------
  // DOM builders
  // ------------------------------
  function clearSelect(sel) { sel.innerHTML = ''; }

  function rebuildOptions($select, rows, cfg) {
    const { idField, enField, frField, lang, placeholder } = cfg;
    const sel = $select.get(0);
    const prevVal = normGuid($select.val());
    const holder = placeholder || (isFr(lang) ? 'Sélectionner' : 'Select');

    // sort by active language column for user-facing order
    const key = isFr(lang) ? frField : enField;
    rows.sort((a, b) => String(a?.[key] || '').localeCompare(String(b?.[key] || ''), undefined, { sensitivity: 'base' }));

    clearSelect(sel);

    const opt0 = new Option(holder, '', true, false);
    opt0.disabled = true;
    sel.appendChild(opt0);

    for (const r of rows) {
      const en = r?.[enField] ?? '';
      const fr = r?.[frField] ?? '';
      const txt = isFr(lang) ? (fr || en) : (en || fr);
      const val = r?.[idField];
      const opt = new Option(txt, val, false, false);
      opt.dataset.en = en;
      opt.dataset.fr = fr;
      sel.appendChild(opt);
    }

    // restore previous selection if still present
    if (prevVal) {
      const match = rows.find(r => normGuid(r?.[idField]) === prevVal);
      if (match) { $select.val(String(match[idField])); }
      else { $select.val(''); }
    } else {
      $select.val('');
    }
  }

  // ------------------------------
  // LookupLoader (unified)
  // ------------------------------
  const LookupLoader = {
    /**
     * Load a bilingual lookup into a <select>
     */
    async load(opts = {}) {
      const {
        select, entitySet, idField, enField, frField,
        lang = 'en', filter = 'statecode eq 0', placeholder
      } = opts;

      const $select = (select && select.jquery) ? select : $(select);
      if (!$select.length) { LOG.warn('load: select not found', select); return []; }

      const cols = [idField, enField, frField].filter(Boolean).join(',');
      const url = `/_api/${encodeURIComponent(entitySet)}`
        + `?$select=${encodeURIComponent(cols)}`
        + `&$filter=${encodeURIComponent(filter)}`;

      LOG.info('GET', url);
      const rows = await fetchAll(url, {
        'Accept': 'application/json', 'OData-Version': '4.0', 'OData-MaxVersion': '4.0'
      });
      LOG.info('Rows:', rows.length);

      rebuildOptions($select, rows, { idField, enField, frField, lang, placeholder });

      // auto-persist current selection (if any) and bind change for future
      const fieldId = $select.attr('id');
      if ($select.val()) LookupStore.persistFromSelect(fieldId);
      $select.off('change.lookupstore').on('change.lookupstore', () => LookupStore.persistFromSelect(fieldId));

      return rows;
    },

    /**
     * Relabel an already-populated lookup to EN/FR without network.
     */
    switchLanguage(select, lang = 'en', { resort = true, placeholder } = {}) {
      const $select = (select && select.jquery) ? select : $(select);
      const sel = $select.get(0);
      if (!sel || !sel.options || sel.options.length === 0) { LOG.warn('switchLanguage: empty select'); return; }

      const holder = placeholder || (isFr(lang) ? 'Sélectionner' : 'Select');
      if (sel.options[0]?.value === '') sel.options[0].text = holder;

      // relabel from data attributes
      for (let i = 1; i < sel.options.length; i++) {
        const o = sel.options[i];
        const en = o.dataset?.en || '';
        const fr = o.dataset?.fr || '';
        o.text = isFr(lang) ? (fr || en || o.text) : (en || fr || o.text);
      }

      if (resort) {
        const currentVal = $select.val();
        const opts = Array.from(sel.options).slice(1);
        opts.sort((a, b) => a.text.toLowerCase().localeCompare(b.text.toLowerCase()));
        for (const o of opts) sel.appendChild(o);
        $select.val(currentVal); // preserve selection
      }

      LOG.info('switchLanguage done ->', isFr(lang) ? 'FR' : 'EN');
    },

    /** Force-save current selection of a field id (one-shot) */
    persistNow(fieldId) { LookupStore.persistFromSelect(fieldId); },

    /** Read saved name later on any page */
    getSavedName(fieldId, lang) { return LookupStore.getName(fieldId, lang); }
  };

  // Export
  window.LookupLoader = LookupLoader;

})(window, jQuery);


// =========================================================
// Dataverse helpers (Power Pages) - FetchXML + OData
// - Robust FetchXML runners (POST + GET)
// - Robust OData GET (with paging via @odata.nextLink)
// - Verbose debug logging
//
// FIXES APPLIED:
//  1) No direct calls to bare safeAjax().
//  2) Always resolves ajax implementation at call-time:
//        window.webapi.safeAjax (preferred) OR window.safeAjax (legacy alias)
//  3) Exposes methods on window.webapi.
// =========================================================

(function () {
  "use strict";

  var WEBAPI_DBG = true;

  function webLog() {
    if (!WEBAPI_DBG) return;
    try {
      console.log.apply(console, ["[WEBAPI]"].concat([].slice.call(arguments)));
    } catch (e) {}
  }

  function isNonEmptyString(s) {
    return typeof s === "string" && s.trim().length > 0;
  }

  // Resolve ajax impl at runtime (safe even if safeAjax is defined later in the file)
  function ajaxImpl() {
    if (window.webapi && typeof window.webapi.safeAjax === "function") return window.webapi.safeAjax;
    if (typeof window.safeAjax === "function") return window.safeAjax;
    return null;
  }

  function requireAjax(callerName) {
    var ajax = ajaxImpl();
    if (!ajax) {
      var msg = callerName + ": safeAjax is not available (window.webapi.safeAjax / window.safeAjax missing).";
      webLog(msg);
      throw new Error(msg);
    }
    return ajax;
  }

  // ---- Extract FetchXML from many possible calling styles -------------------
  function extractFetchXml(arg1, arg2) {
    if (isNonEmptyString(arg1)) return arg1.trim();
    if (isNonEmptyString(arg2)) return arg2.trim();

    var o = arg1 && typeof arg1 === "object" ? arg1 : null;
    if (!o) return "";

    var direct = o.fetchXml || o.fetchxml || o.FetchXml || o.fetchXML || o.query;
    if (isNonEmptyString(direct)) return direct.trim();

    if (o.payload && isNonEmptyString(o.payload.query)) return o.payload.query.trim();
    if (o.payload && isNonEmptyString(o.payload.fetchXml)) return o.payload.fetchXml.trim();
    if (o.opts && isNonEmptyString(o.opts.fetchXml)) return o.opts.fetchXml.trim();
    if (o.opts && isNonEmptyString(o.opts.query)) return o.opts.query.trim();

    return "";
  }

  function sanitizeFetchXmlForLog(fetchXml) {
    var s = (fetchXml || "").replace(/\s+/g, " ").trim();
    if (s.length > 300) s = s.slice(0, 300) + " …";
    return s;
  }

  // ---- FetchXML via POST ---------------------------------------------------
  async function runFetch_POST(fetchXml, opts) {
    var fx = extractFetchXml(fetchXml, opts);

    webLog("runFetch_POST() called", {
      hasFetchXml: !!fx,
      fetchXmlPreview: sanitizeFetchXmlForLog(fx)
    });

    if (!isNonEmptyString(fx)) {
      var msg = "runFetch_POST: FetchXML is empty after extraction.";
      webLog(msg, { fetchXml, opts });
      throw new Error(msg);
    }

    var payload = { query: fx };

    return new Promise(function (resolve, reject) {
      try {
        var ajax = requireAjax("runFetch_POST");
        ajax({
          type: "POST",
          url: "/_api/retrieveMultiple",
          contentType: "application/json",
          data: JSON.stringify(payload),
          success: function (data) {
            webLog("runFetch_POST success", {
              hasValue: !!(data && data.value),
              valueCount: data && data.value ? data.value.length : 0
            });
            resolve(data);
          },
          error: function (xhr) {
            var body = xhr && xhr.responseText ? xhr.responseText : "";
            webLog("runFetch_POST ERROR", {
              status: xhr && xhr.status,
              statusText: xhr && xhr.statusText,
              responseTextPreview: (body || "").slice(0, 500)
            });
            reject(xhr);
          }
        });
      } catch (e) {
        webLog("runFetch_POST exception", e && e.message, e);
        reject(e);
      }
    });
  }

  // ---- FetchXML via GET ----------------------------------------------------
  async function runFetch_GET(fetchXml, opts) {
    var fx = extractFetchXml(fetchXml, opts);

    webLog("runFetch_GET() called", {
      hasFetchXml: !!fx,
      fetchXmlPreview: sanitizeFetchXmlForLog(fx)
    });

    if (!isNonEmptyString(fx)) {
      var msg = "runFetch_GET: FetchXML is empty after extraction.";
      webLog(msg, { fetchXml, opts });
      throw new Error(msg);
    }

    var url = "/_api/retrieveMultiple?fetchXml=" + encodeURIComponent(fx);

    return new Promise(function (resolve, reject) {
      try {
        var ajax = requireAjax("runFetch_GET");
        ajax({
          type: "GET",
          url: url,
          success: function (data) {
            webLog("runFetch_GET success", {
              hasValue: !!(data && data.value),
              valueCount: data && data.value ? data.value.length : 0
            });
            resolve(data);
          },
          error: function (xhr) {
            var body = xhr && xhr.responseText ? xhr.responseText : "";
            webLog("runFetch_GET ERROR", {
              status: xhr && xhr.status,
              statusText: xhr && xhr.statusText,
              responseTextPreview: (body || "").slice(0, 500),
              urlPreview: url.slice(0, 250) + (url.length > 250 ? " …" : "")
            });
            reject(xhr);
          }
        });
      } catch (e) {
        webLog("runFetch_GET exception", e && e.message, e);
        reject(e);
      }
    });
  }

  // ---- Flexible runner -----------------------------------------------------
  async function runFetchFlex(arg1, arg2) {
    var method = (arg2 && arg2.method ? String(arg2.method) : "POST").toUpperCase();
    if (method === "GET") return runFetch_GET(arg1, arg2);
    return runFetch_POST(arg1, arg2);
  }

  // ---- Robust OData GET (paging) ------------------------------------------
  async function odataGetAll(url, opts) {
    var out = [];
    var next = url;
    var page = 0;
    var maxPages = (opts && opts.maxPages) ? opts.maxPages : 50;

    webLog("odataGetAll start", { url: url });

    while (next && page < maxPages) {
      /* eslint-disable no-await-in-loop */
      var data = await odataGetOnce(next);
      /* eslint-enable no-await-in-loop */

      var rows = (data && data.value) ? data.value : [];
      out = out.concat(rows);

      next = data && (data["@odata.nextLink"] || data["odata.nextLink"])
        ? (data["@odata.nextLink"] || data["odata.nextLink"])
        : null;
      page++;

      webLog("odataGetAll page", {
        page: page,
        received: rows.length,
        total: out.length,
        hasNext: !!next
      });
    }

    if (page >= maxPages) {
      webLog("odataGetAll stopped at maxPages", { maxPages: maxPages });
    }

    return out;
  }

  function odataGetOnce(url) {
    return new Promise(function (resolve, reject) {
      try {
        var ajax = requireAjax("odataGetOnce");
        ajax({
          type: "GET",
          url: url,
          success: function (data) {
            resolve(data);
          },
          error: function (xhr) {
            var body = xhr && xhr.responseText ? xhr.responseText : "";
            webLog("odataGetOnce ERROR", {
              status: xhr && xhr.status,
              statusText: xhr && xhr.statusText,
              responseTextPreview: (body || "").slice(0, 500),
              url: url
            });
            reject(xhr);
          }
        });
      } catch (e) {
        webLog("odataGetOnce exception", e && e.message, e);
        reject(e);
      }
    });
  }

  window.webapi = window.webapi || {};
  window.webapi.runFetchFlex = runFetchFlex;
  window.webapi.runFetch_POST = runFetch_POST;
  window.webapi.runFetch_GET = runFetch_GET;
  window.webapi.odataGetAll = odataGetAll;

  webLog("Dataverse helpers registered", Object.keys(window.webapi));
})();


function parseAjaxError(jqXHR) {
  let body = null;
  try { body = jqXHR.responseJSON ?? JSON.parse(jqXHR.responseText); }
  catch { body = jqXHR.responseText || null; }
  console.error("[retrieveMultiple] HTTP", jqXHR?.status, body);
  return { status: jqXHR?.status ?? 0, body };
}

(function (webapi, $) {
  function safeAjax(ajaxOptions) {
    var deferredAjax = $.Deferred();

    shell.getTokenDeferred().done(function (token) {
      // add headers for AJAX
      if (!ajaxOptions.headers) {
        $.extend(ajaxOptions, {
          headers: {
            "__RequestVerificationToken": token
          }
        });
      } else {
        ajaxOptions.headers["__RequestVerificationToken"] = token;
      }
      $.ajax(ajaxOptions)
        .done(function (data, textStatus, jqXHR) {
          validateLoginSession(data, textStatus, jqXHR, deferredAjax.resolve);
        }).fail(deferredAjax.reject); //AJAX
    }).fail(function () {
      deferredAjax.rejectWith(this, arguments); // on token failure pass the token AJAX and args
    });

    return deferredAjax.promise();
  }

  webapi.safeAjax = safeAjax;

  // Optional legacy alias (harmless; helps older code)
  // NOTE: Dataverse helpers prefer webapi.safeAjax; this is just fallback support.
  window.safeAjax = window.safeAjax || safeAjax;

})(window.webapi = window.webapi || {}, jQuery);

// Detects expired/invalid session and redirects to sign-in.
// Signature matches your call site: (data, textStatus, jqXHR, onSuccess)
function validateLoginSession(data, textStatus, jqXHR, onSuccess) {
  var log = function () {
    if (window.console && console.log) console.log.apply(console, arguments);
  };

  try {
    var status = jqXHR && jqXHR.status;
    var ct = jqXHR && jqXHR.getResponseHeader ? (jqXHR.getResponseHeader('content-type') || '') : '';

    // Heuristics: HTML response (not JSON) or known login markers in the body
    var isHtml = /text\/html|application\/xhtml\+xml/i.test(ct);
    var bodyStr = (typeof data === 'string') ? data : '';
    var looksLikeLoginHtml =
      /<form[^>]+action[^>]+signin/i.test(bodyStr) ||
      /<a[^>]+href[^>]+signin/i.test(bodyStr) ||
      /<title[^>]*>\s*(sign\s*in|connexion|login)\b/i.test(bodyStr);

    // Some APIs may return JSON flags instead
    var loginUrl = null;
    if (data && typeof data === 'object') {
      loginUrl = data.loginUrl || data.LoginUrl || null;
      if (data.isAuthorized === false || data.IsAuthorized === false) status = status || 401;
    }

    // Treat 401/403 or login-like HTML as an expired session
    if (status === 401 || status === 403 || looksLikeLoginHtml || (isHtml && !/application\/json/i.test(ct))) {
      log('[safeAjax] Session invalid/expired; redirecting to sign-in. status=%s, ct=%s', status, ct);

      // Try to discover a login URL from the HTML if not supplied
      if (!loginUrl && bodyStr) {
        var $doc = $('<div>').html(bodyStr);
        var $form = $doc.find('form[action*="signin"], form[action*="SignIn"], form[action*="Account/Login"]');
        if ($form.length) loginUrl = $form.attr('action');

        if (!loginUrl) {
          var $a = $doc.find('a[href*="signin"], a[href*="SignIn"], a[href*="Account/Login"]');
          if ($a.length) loginUrl = $a.first().attr('href');
        }
      }

      // Fallbacks for common portal routes
      if (!loginUrl) {
        var here = location.pathname + location.search + location.hash;
        loginUrl = '/SignIn?returnUrl=' + encodeURIComponent(here); // typical Power Pages route
      }

      window.location.href = loginUrl;
      return;
    }

    // Otherwise, session is fine -> pass through to the original success resolver
    if (typeof onSuccess === 'function') onSuccess(data, textStatus, jqXHR);
  } catch (e) {
    // In doubt, do not block the call
    log('[safeAjax] validateLoginSession threw; passing through. Error:', e);
    if (typeof onSuccess === 'function') onSuccess(data, textStatus, jqXHR);
  }
}


/**
 * Remove any role="group" on the <tr> that wraps a boolean radio group.
 * baseId is the id of the span/field container (e.g., "ethi_canadiancoastguard").
 */
function removeRadioWrapperRole(baseId) {
    try {
        if (!baseId) {
            console.log('[WET-RADIO] removeRadioWrapperRole: no baseId provided');
            return;
        }

        var $base = $('#' + baseId);
        if (!$base.length) {
            console.log('[WET-RADIO] removeRadioWrapperRole: element not found for baseId:', baseId);
            return;
        }

        // Target only <tr> wrappers that incorrectly have role="group"
        var $trWrapper = $base.closest('tr[role="group"]');
        if ($trWrapper.length) {
            console.log(
                '[WET-RADIO] removeRadioWrapperRole: removing role="group" from <tr> for baseId:',
                baseId
            );
            $trWrapper.removeAttr('role');
        } else {
            // Optional debug noise; keep or comment out as you like
            console.log(
                '[WET-RADIO] removeRadioWrapperRole: no <tr role="group"> wrapper found for baseId:',
                baseId
            );
        }
    } catch (e) {
        console.log(
            '[WET-RADIO] removeRadioWrapperRole: error while stripping role="group":',
            e && e.message,
            e
        );
    }
}

// - Pass the span id that wraps the radio inputs (e.g., "ethi_canadiancoastguard")
// - Builds <fieldset><legend>Group Label</legend>...</fieldset>
// - Moves the existing radios + their <label for="..."> into the fieldset
// - Does NOT add any required validation
// - Idempotent: safe to call multiple times
// - How to use it on one group:   window.patchRadioGroup('ethi_canadiancoastguard');
// - Many groups at once:          window.patchRadioGroups(['id1','id2','id3']);
(function () {

  // NEW: normalize CRM read-only radios so NVDA does not say "unavailable"
  function normalizeReadOnlyRadios(fsEl) {
    if (!fsEl) return;

    var radios = fsEl.querySelectorAll('input[type="radio"]');
    if (!radios.length) return;

    // Consider group read-only only if *all* radios look "ro-bound"
    var allReadOnly = true;
    for (var i = 0; i < radios.length; i++) {
      var r = radios[i];
      var ariaDisabled = r.getAttribute('aria-disabled');
      var roBound = (r.dataset && r.dataset.roBound) || r.getAttribute('data-ro-bound');

      if (ariaDisabled !== 'true' && roBound !== '1') {
        allReadOnly = false;
        break;
      }
    }
    if (!allReadOnly) return;

    // Mark the group as read-only and remove aria-disabled from radios.
    // IMPORTANT: do NOT use the "disabled" attribute or the value will not post back.
    fsEl.setAttribute('aria-readonly', 'true');
    for (var j = 0; j < radios.length; j++) {
      radios[j].removeAttribute('aria-disabled');
      // Do NOT set radios[j].disabled = true;
    }
  }

  function patchRadioGroup(baseId) {
    if (!baseId) return false;

    // Already patched?
    if (document.getElementById(baseId + '_group')) return false;

    var span = document.getElementById(baseId);
    if (!span) return false;

    // Clean up any <tr role="group"> wrapper for this radio group
    if (typeof window.removeRadioWrapperRole === 'function') {
      window.removeRadioWrapperRole(baseId);
    } else {
      // fallback direct call if not on window
      try { removeRadioWrapperRole(baseId); } catch (e) {}
    }

    var labelId = baseId + '_label';
    var oldLabel = document.getElementById(labelId);

    var group = document.createElement('div');
    group.id = baseId + '_group';
    group.className = 'form-group wet-patched-radio';

    var fs = document.createElement('fieldset');
    fs.className = 'wet-radio-fieldset'; // no "boolean-radio" to avoid legacy offsets
    fs.setAttribute('data-wet-patched-radio', '1');

    var legend = document.createElement('legend');
    legend.id = baseId + '_legend';

    var nameSpan = document.createElement('span');
    nameSpan.className = 'field-label field-name';  // inherit same font/weight as other labels

    // Prefer explicit <baseId>_label, else fallback to table header text
    var labelText =
      (oldLabel && oldLabel.textContent) ||
      (span.closest('td')?.querySelector('.table-info .field-label')?.textContent) ||
      'Options';

    nameSpan.textContent = String(labelText || 'Options').trim();
    legend.appendChild(nameSpan);
    legend.classList.add('field-label'); // if your CSS targets the element directly
    fs.appendChild(legend);

    // Re-wrap: use the EXISTING <label for="..."> as the wrapper and move the input INSIDE it
    Array.from(span.querySelectorAll('input[type="radio"]')).forEach(function (r, idx) {
      var pl = document.querySelector('label[for="' + CSS.escape(r.id) + '"]');

      if (pl) {
        // --- eliminate duplicate ids -----------------------------------
        // If this per-option label is reusing <baseId>_label, rename it so the
        // original group label keeps that id and we do not end up with duplicates.
        if (pl.id && pl.id === labelId) {
          var suffix = r.value || r.id || ('opt' + idx);
          // normalize suffix to be id-safe-ish
          suffix = String(suffix).replace(/\s+/g, '_');
          pl.id = labelId + '_' + suffix;
        }
        // ----------------------------------------------------------------

        // Clean stray hidden field-name fragments (legend covers group name)
        pl.querySelectorAll('.visually-hidden,.wb-inv,.wb-invisible').forEach(function (n) {
          n.remove();
        });

        pl.classList.add('radio-inline'); // inline layout
        pl.removeAttribute('for');        // not needed when input is inside label

        // Put the radio as the FIRST child of the label
        pl.insertBefore(r, pl.firstChild);

        // Ensure a little space if your CSS lacks it
        var secondNode = pl.childNodes[1] || null;
        if (!secondNode || (secondNode.nodeType === Node.TEXT_NODE && !/\S/.test(secondNode.textContent))) {
          // If there is no meaningful spacing text node after input, create one
          pl.insertBefore(document.createTextNode(' '), pl.childNodes[1] || null);
        }

        fs.appendChild(pl);  // move the label (now the wrapper) under the fieldset
      } else {
        // Fallback: create a wrapper label if none found
        var lbl = document.createElement('label');
        lbl.className = 'radio-inline';
        lbl.appendChild(r);
        lbl.appendChild(document.createTextNode(' Option'));
        fs.appendChild(lbl);
      }
    });

    // Preserve original onchange behavior (the span used to have onchange="setIsDirty(this.id)"
    fs.addEventListener('change', function () {
      if (typeof window.setIsDirty === 'function') window.setIsDirty(baseId);
    });

    var control = span.closest('.control') || span.parentElement;
    group.appendChild(fs);
    control.insertBefore(group, span);
    span.remove();

    // Hide the original group label but keep its id for ARIA / error wiring
    if (oldLabel) {
      oldLabel.classList.add('wb-inv');
      oldLabel.setAttribute('aria-hidden', 'true');
      oldLabel.removeAttribute('for');
    }

    // Clean any old role="radiogroup" off the <td>
    var td = group.closest('td');
    if (td && td.getAttribute('role') === 'radiogroup') {
      td.removeAttribute('role');
    }

    // NEW: Normalize any CRM read-only radios inside this fieldset
    normalizeReadOnlyRadios(fs);

    return true;
  }

  // Export to global for your new call sites
  window.patchRadioGroup = patchRadioGroup;
  window.patchRadioGroups = function (ids) {
    var fn = window.patchRadioGroup || patchRadioGroup;
    return Array.isArray(ids)
      ? ids.reduce(function (count, id) { return count + (fn(id) ? 1 : 0); }, 0)
      : 0;
  };
})();


jQuery(function ($) {
  // Disable native HTML5 tooltips (“Please fill out this field.”)
  var $form = $('#liquid_form');
  if ($form.length) {
    $form.attr('novalidate', 'novalidate');
    console.debug('[WET] novalidate applied to #liquid_form');
  }
});

// Minimal helpers to render/clear inline errors when validations.js helpers aren’t present
function setInlineErrorForFile(baseId, messageHtml) {
  // Prefer shared helper from validations.js if available
  if (typeof window.updateLabelErrorMessage === 'function') {
    try { window.updateLabelErrorMessage(baseId, 'file', messageHtml); return; } catch (_) {}
  }
  const $label = $('#' + baseId + '_label');
  if (!$label.length) return;
  let $err = $label.find("span[id='" + baseId + "_err']");
  if (!$err.length) {
    const last = $label.contents().last();
    if (!last.length || last[0].nodeName !== 'BR') $label.append('<br />');
    $label.append('<span id="' + baseId + '_err" class="label label-danger wrapped">' + messageHtml + '</span>');
  } else {
    const newTxt = $('<div/>').html(messageHtml).text().replace(/\s+/g, ' ').trim();
    if ($err.text().replace(/\s+/g, ' ').trim() !== newTxt) $err.html(messageHtml);
  }
  $label.find('br + br').remove();
}

function clearInlineErrorForFile(baseId) {
  // Prefer validations.js helper if present
  if (typeof window.clearFieldErrorUI === 'function') {
    try { window.clearFieldErrorUI(baseId, 'file'); return; } catch (_) {}
  }
  const $label = $('#' + baseId + '_label');
  const $err = $label.find('#' + baseId + '_err');
  if ($err.length) {
    const $prev = $err.prev();
    $err.remove();
    if ($prev.is('br')) $prev.remove();
  }
}

/* ============================================================
 * Power Pages table normalizer
 * - Keeps hidden sections in DOM (logic-safe)
 * - Fixes row column counts by adding neutral filler cells
 *   or reducing colspans—no destructive deletions.
 * - Idempotent; runs after partial postbacks.
 * ============================================================ */
(function () {
  'use strict';

  var DEBUG = true; // set false once verified
  function log() { if (DEBUG) console.log('[PP-TABLE]', ...arguments); }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else { fn(); }
  }

  function getExpectedCols(table) {
    // Prefer explicit columns from <colgroup>
    var n = table.querySelectorAll(':scope > colgroup > col').length;
    if (n) return n;

    // Fallback: infer from the most common row width
    var counts = Object.create(null), best = 3, max = 0;
    table.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr')
      .forEach(function (tr) {
        var w = rowWidth(tr);
        counts[w] = (counts[w] || 0) + 1;
        if (counts[w] > max) { max = counts[w]; best = w; }
      });
    return best;
  }

  function rowWidth(tr) {
    var sum = 0;
    for (var i = 0; i < tr.cells.length; i++) {
      var td = tr.cells[i];
      var span = parseInt(td.getAttribute('colspan') || '1', 10);
      sum += (isNaN(span) || span < 1) ? 1 : span;
    }
    return sum;
  }

  function ensureWidth(tr, expected) {
    var have = rowWidth(tr);
    if (have === expected) return;

    if (have < expected) {
      // Add neutral filler cells before the trailing zero-cell if present
      var deficit = expected - have;
      var zero = findZeroCell(tr);
      for (var i = 0; i < deficit; i++) {
        var filler = document.createElement('td');
        filler.className = 'cell zero-cell';
        filler.setAttribute('data-td-fix', '1');
        if (zero) tr.insertBefore(filler, zero); else tr.appendChild(filler);
      }
      log('Added', deficit, 'filler <td> to reach', expected, tr);
      return;
    }

    // have > expected → shrink colspans non-destructively
    var excess = have - expected;

    // 1) Prefer shrinking the trailing zero-cell if it has colspan > 1
    var zero = findZeroCell(tr);
    if (zero && (zero.colSpan || 1) > 1) {
      var reduce = Math.min(excess, zero.colSpan - 1);
      zero.colSpan = zero.colSpan - reduce;
      excess -= reduce;
    }

    // 2) Then shrink any previously-added filler cell with colspan > 1
    if (excess > 0) {
      var fillers = tr.querySelectorAll('td[data-td-fix]');
      for (var j = fillers.length - 1; j >= 0 && excess > 0; j--) {
        var f = fillers[j];
        if ((f.colSpan || 1) > 1) {
          var r = Math.min(excess, f.colSpan - 1);
          f.colSpan = f.colSpan - r;
          excess -= r;
        }
      }
    }

    // 3) Last resort: shrink the last non-interactive cell with colspan > 1
    if (excess > 0) {
      var cells = Array.from(tr.cells).reverse();
      var target = cells.find(function (td) {
        if ((td.colSpan || 1) <= 1) return false;
        // Avoid cells that contain form controls (inputs/select/textarea/button)
        return td.querySelector('input,select,textarea,button') == null;
      });
      if (target) {
        var r2 = Math.min(excess, (target.colSpan || 1) - 1);
        target.colSpan = target.colSpan - r2;
        excess -= r2;
      }
    }

    // Note: we DO NOT remove any cells; we only reduce span.
    if (excess > 0 && DEBUG) {
      log('Row still wide by', excess, '(no safe shrink target found):', tr);
    } else {
      log('Shrank row to', expected, tr);
    }
  }

  function findZeroCell(tr) {
    for (var i = tr.cells.length - 1; i >= 0; i--) {
      var td = tr.cells[i];
      if (td.classList && td.classList.contains('zero-cell')) return td;
    }
    return null;
  }

  function normalizeTables(root) {
    root.querySelectorAll('table.section').forEach(function (table) {
      var expected = getExpectedCols(table);
      table.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr')
        .forEach(function (tr) { ensureWidth(tr, expected); });
    });
  }

  function run() { try { normalizeTables(document); } catch (e) { console.error(e); } }

  // Initial run
  onReady(run);

  // Re-run after partial postbacks (Power Pages / ASP.NET WebForms)
  try {
    if (window.Sys && Sys.WebForms && Sys.WebForms.PageRequestManager) {
      Sys.WebForms.PageRequestManager.getInstance().add_endRequest(run);
      log('Hooked PageRequestManager.endRequest');
    }
  } catch (e) { /* ignore */ }

  // Optional: expose a manual trigger for QA
  window.ppNormalizeTables = run;
})();


// -----------------------------------------------------
// Read-only summary accessibility helper (generic)
// -----------------------------------------------------
(function (global, $) {
  'use strict';

  if (!$) return; // jQuery required

  var LOG_PREFIX = '[SUMMARY-RO]';

  function logDebug() {
    if (!global || !global.console || !console.debug) return;
    if (global.SUMMARY_RO_LOG_LEVEL !== 'debug') return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift(LOG_PREFIX);
    console.debug.apply(console, args);
  }

  function logWarn() {
    if (!global || !global.console || !console.warn) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift(LOG_PREFIX);
    console.warn.apply(console, args);
  }

  function ensureId($el, fallbackId) {
    if (!$el || !$el.length) return null;
    var id = $el.attr('id');
    if (!id && fallbackId) {
      id = fallbackId;
      $el.attr('id', id);
    }
    return id || null;
  }

  // 1) Lookups: make display inputs focusable, labelled, read-only (but visually flat)
  function patchLookups($root) {
    $root.find('.lookup.form-control-cell').each(function () {
      var $cell = $(this);
      var $label = $cell.find('.table-info label').first();
      var $input = $cell.find('.control input[type="text"]').first();

      if (!$label.length || !$input.length) {
        logDebug('lookup cell skipped (no label/input)');
        return;
      }

      var inputId = ensureId($input);
      if (!inputId) {
        logDebug('lookup cell skipped (input without id)');
        return;
      }

      var labelId = ensureId($label, inputId + '_label');

      if (!$label.attr('for')) {
        $label.attr('for', inputId);
      }

      // Enable but keep read-only so it can be tabbed to
      if ($input.is(':disabled') || $input.attr('aria-disabled') === 'true') {
        $input.prop('disabled', false);
        $input.removeAttr('disabled aria-disabled');
      }
      $input.prop('readOnly', true);
      $input.attr('aria-readonly', 'true');

      // NEW: add .readonly so CSS can flatten visuals on summary step
      if (!$input.hasClass('readonly')) {
        $input.addClass('readonly');
      }

      // Prefer label text; drop any "is a required field" aria-label
      if ($input.attr('aria-label')) {
        $input.attr('data-aria-label-removed', $input.attr('aria-label'));
        $input.removeAttr('aria-label');
      }

      $input.attr('aria-labelledby', labelId);

      logDebug('lookup patched: %s -> %s', inputId, labelId);
    });
  }

  // 2) Emails: associate mailto link with its label + its own text
  function patchEmails($root) {
    $root.find('a[href^="mailto:"]').each(function () {
      var $link = $(this);
      var $row = $link.closest('tr');
      var $label = $row.find('.table-info label').first();

      if (!$label.length) {
        logDebug('email patch skipped (no label for link)');
        return;
      }

      var labelId = ensureId($label);
      var linkId = ensureId($link, labelId + '_value');

      // Accessible name: "<Label text> <email@address>"
      $link.attr('aria-labelledby', labelId + ' ' + linkId);

      // Remove any conflicting aria-label
      if ($link.attr('aria-label')) {
        $link.attr('data-aria-label-removed', $link.attr('aria-label'));
        $link.removeAttr('aria-label');
      }

      logDebug('email link patched: %s %s', labelId, linkId);
    });
  }

  // 3) Files: label + filename as accessible name
  function patchFiles($root) {
    $root.find('.file-name-container span[id$="_file_name"]').each(function () {
      var $span = $(this);
      var spanId = ensureId($span);
      if (!spanId) {
        logDebug('file span skipped (no id)');
        return;
      }

      var base = spanId.replace(/_file_name$/, '');
      if (!base) {
        logDebug('file span skipped (no base) for %s', spanId);
        return;
      }

      var $label = $('#' + base + '_label');
      if (!$label.length) {
        logDebug('file patch skipped (no label for base %s)', base);
        return;
      }

      var labelId = ensureId($label, base + '_label');
      var $link = $span.closest('a');

      if (!$link.length) {
        logDebug('file patch skipped (no link for base %s)', base);
        return;
      }

      var linkId = ensureId($link, base + '_file_link');

      // Accessible name: "<Label text> <filename>"
      $link.attr('aria-labelledby', labelId + ' ' + spanId);

      if ($link.attr('aria-label')) {
        $link.attr('data-aria-label-removed', $link.attr('aria-label'));
        $link.removeAttr('aria-label');
      }

      logDebug('file link patched: %s -> %s %s %s', base, labelId, spanId, linkId);
    });
  }

  // 4) Radio groups: use the existing legend as the single tabbable summary,
  //    and announce "Group label: Checked value" via aria-label.
  function patchRadioSummaries($root, radioConfigs) {
    if (!radioConfigs || !radioConfigs.length) return;

    $.each(radioConfigs, function (_, cfg) {
      if (!cfg || !cfg.baseId) return;

      var base = cfg.baseId;
      var groupSelector = cfg.group || ('#' + base + '_group');
      var legendSelector = cfg.legend || ('#' + base + '_legend');
      var $group = $(groupSelector);
      var $legend = $(legendSelector);

      if (!$group.length || !$legend.length) {
        logDebug('radio summary skipped (no group/legend) for base %s', base);
        return;
      }

      // Group name (e.g., "Canadian coast guard")
      var labelText = $.trim($legend.text() || cfg.labelText || 'Options');

      // Checked value ("Yes", "No", or full label text)
      var $checked = $group.find('input[type="radio"]:checked').first();
      var valueText = '';

      if ($checked.length) {
        valueText = $.trim($checked.closest('label').text());
      } else if (cfg.emptyValueText) {
        valueText = cfg.emptyValueText;
      }

      var summaryText = valueText ? (labelText + ': ' + valueText) : labelText;

      // Make the legend itself the focusable summary; no extra visible text is added.
      if (!$legend.attr('tabindex')) {
        $legend.attr('tabindex', '0');
      }

      // AT will hear "Canadian coast guard: No"
      $legend.attr('aria-label', summaryText);

      // Optionally keep radios out of tab order on this read-only step
      $group.find('input[type="radio"]').each(function () {
        var $radio = $(this);
        if ($radio.is(':disabled')) return;
        if (!$radio.attr('tabindex')) $radio.attr('tabindex', '-1');
      });

      logDebug('radio legend patched for base %s -> "%s"', base, summaryText);
    });
  }

  // Public entry-point
  function patch(config) {
    config = config || {};
    var $root;

    if (config.root) $root = $(config.root);
    else $root = $('.crmEntityFormView').first();

    if (!$root.length) {
      logWarn('No root container found for ReadOnlySummary.patch');
      return;
    }

    if (config.lookups !== false) patchLookups($root);
    if (config.emails !== false) patchEmails($root);
    if (config.files !== false) patchFiles($root);
    if (config.radioSummaries && config.radioSummaries.length) patchRadioSummaries($root, config.radioSummaries);

    logDebug('patch complete', config);
  }

  global.ReadOnlySummary = global.ReadOnlySummary || {};
  global.ReadOnlySummary.patch = patch;

})(window, window.jQuery);

// ===============================
// Read-only summary: radio groups
// ===============================
window.ReadOnlySummary = window.ReadOnlySummary || {};

(function (ns) {
  'use strict';

  ns.makeRadioCellSummary = function (cfg) {
    try {
      if (!cfg || !cfg.baseId) {
        console.log('[ReadOnlySummary][RadioCell] Missing baseId in config');
        return;
      }

      var baseId = cfg.baseId;
      var root = cfg.root || document;

      if (typeof root === 'string') root = document.querySelector(root) || document;
      if (!root) {
        console.log('[ReadOnlySummary][RadioCell] Root not found for baseId:', baseId);
        return;
      }

      var span = root.querySelector('#' + baseId);
      if (!span) {
        console.log('[ReadOnlySummary][RadioCell] Span #' + baseId + ' not found');
        return;
      }

      // Idempotent: do not wire twice
      if (span.dataset && span.dataset.roSummaryApplied === '1') return;
      if (span.dataset) span.dataset.roSummaryApplied = '1';

      // Gather radios
      var radios = Array.prototype.slice.call(
        span.querySelectorAll('input[type="radio"]') || []
      );
      if (!radios.length) {
        console.log('[ReadOnlySummary][RadioCell] No radios found under #' + baseId);
        return;
      }

      // Optional: clean up wrapper td (remove old aria-label/tabindex experiments)
      var cell = span.closest('td.boolean-radio-cell, td[role="radiogroup"], td');
      if (cell) {
        if (cell.getAttribute('aria-label')) cell.removeAttribute('aria-label');
        if (cell.getAttribute('tabindex') === '0') cell.removeAttribute('tabindex');
      }

      // Choose which radio should get the Tab stop: the checked one if any
      var checkedIndex = -1;
      for (var i = 0; i < radios.length; i++) {
        if (radios[i].checked) { checkedIndex = i; break; }
      }
      if (checkedIndex < 0) checkedIndex = 0;
      var initialIndex = checkedIndex;

      // Event handler: block changes but allow Tab/Shift+Tab
      var blockEvent = function (ev) {
        var key = ev.type === 'keydown' ? ev.key : null;

        // Let Tab / Shift+Tab through so user can leave the group
        if (key === 'Tab') return;

        if (
          ev.type === 'click' ||
          key === ' ' || key === 'Spacebar' ||
          key === 'ArrowLeft' || key === 'ArrowRight' ||
          key === 'ArrowUp' || key === 'ArrowDown' ||
          key === 'Home' || key === 'End'
        ) {
          ev.preventDefault();
          ev.stopPropagation();

          // Restore original selection and tab order
          radios.forEach(function (r, idx) {
            var isInitial = (idx === initialIndex);
            if (r.checked !== isInitial) r.checked = isInitial;
            r.tabIndex = isInitial ? 0 : -1;
          });
        }
      };

      // Wire radios: focusable, read-only
      radios.forEach(function (r, idx) {
        // Remove disabled to make them focusable, but mark as aria-disabled
        if (r.disabled) r.removeAttribute('disabled');
        r.setAttribute('aria-disabled', 'true');

        // Roving tab index: only the "current" one gets Tab focus
        r.tabIndex = (idx === checkedIndex) ? 0 : -1;

        // Prevent toggling while still allowing focus
        r.addEventListener('click', blockEvent);
        r.addEventListener('keydown', blockEvent);
      });

      console.log(
        '[ReadOnlySummary][RadioCell] Read-only, focusable radios wired for',
        baseId, 'checked index =', initialIndex
      );
    } catch (e) {
      console.log(
        '[ReadOnlySummary][RadioCell] Unexpected error for baseId:',
        cfg && cfg.baseId, e && e.message
      );
    }
  };

})(window.ReadOnlySummary);
