// SwoopScores — Content Script
// Scans the DOM for professor names on class-schedule.app.utah.edu,
// inserts a color-coded RMP score badge after each name, and shows a
// detailed popup when the badge is clicked.

(function () {
  'use strict';

  // ─── Selectors ──────────────────────────────────────────────────────────────
  // These target the instructor cells on class-schedule.app.utah.edu.
  // Extend this list if the site updates its markup.
  const INSTRUCTOR_SELECTORS = [
    '.instructor',
    '.instructorName',
    '.instructor-name',
    '[data-instructor]',
    'td.instructor',
    'span.instructor',
  ];

  const PROCESSED_ATTR = 'data-swoop-processed';
  const POPUP_ID = 'swoop-popup';

  // ─── Name normalization ──────────────────────────────────────────────────────

  // Strips titles (Dr., Prof., etc.), normalizes whitespace, and converts the
  // "Last, First" format used by class-schedule.app.utah.edu into "First Last"
  // so RMP search gets the most natural query string.
  function cleanName(raw) {
    let name = raw
      .replace(/\b(Dr\.?|Prof\.?|Mr\.?|Mrs\.?|Ms\.?)\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Flip "Last, First" → "First Last" (e.g. "Smith, Jenn" → "Jenn Smith")
    const lastFirst = name.match(/^([A-Z][a-zA-Z''-]+),\s*(.+)$/);
    if (lastFirst) name = `${lastFirst[2].trim()} ${lastFirst[1].trim()}`;

    return name;
  }

  // Heuristic: does this string look like a person's name?
  // Accepts both "First Last" and "Last, First" formats, 2–4 name parts, no digits.
  function looksLikeName(text) {
    const trimmed = text.trim();
    if (!trimmed || /\d/.test(trimmed)) return false;

    // "Last, First" — e.g. "Smith, Jenn" or "O'Brien, Mary Jane"
    if (/^[A-Z][a-zA-Z''-]+,\s*[A-Z][a-zA-Z'\s-]+$/.test(trimmed)) return true;

    // "First [Middle] Last" — e.g. "John Smith" or "Mary Jane Watson"
    const words = trimmed.split(/\s+/);
    if (words.length < 2 || words.length > 4) return false;
    return words.every((w) => /^[A-Z][a-zA-Z''-]+$/.test(w));
  }

  // ─── Eager fetch queue ───────────────────────────────────────────────────────
  // All professor badges are queued on detection. Fetches run staggered (200ms
  // apart) so we don't hammer the RMP API when a page has many instructors.

  const fetchQueue = [];
  let fetchTimerActive = false;

  function queueEagerFetch(professorName, badgeEl) {
    fetchQueue.push({ professorName, badgeEl });
    if (!fetchTimerActive) {
      fetchTimerActive = true;
      // 600ms delay lets the initial DOM scan fully complete before we start
      // firing network requests.
      setTimeout(drainFetchQueue, 600);
    }
  }

  async function drainFetchQueue() {
    const items = fetchQueue.splice(0);
    for (const { professorName, badgeEl } of items) {
      // Fire-and-forget — badge updates itself when the response arrives.
      fetchRMPForBadge(professorName, badgeEl);
      await new Promise((r) => setTimeout(r, 200));
    }
    fetchTimerActive = false;
  }

  async function fetchRMPForBadge(professorName, badgeEl) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'fetchRMP',
        professorName,
      });

      if (!badgeEl.isConnected) return; // element may have been removed

      if (response.error) {
        badgeEl.className = 'swoop-badge swoop-badge-unknown';
        badgeEl.textContent = '?';
        badgeEl.title = `Not found on RMP — click to try manually`;
        console.log(`[SwoopScores] No RMP data for "${professorName}": ${response.error}`);
      } else {
        const colorKey = ratingColorKey(response.avgRating);
        badgeEl.className = `swoop-badge swoop-badge-${colorKey}`;
        badgeEl.textContent = Number(response.avgRating).toFixed(1);
        badgeEl.title = `RMP: ${Number(response.avgRating).toFixed(1)} / 5 — click for details`;
        console.log(
          `[SwoopScores] Badge updated for "${professorName}": ${response.avgRating} (${colorKey})`
        );
      }
    } catch (err) {
      console.error(`[SwoopScores] fetchRMPForBadge error for "${professorName}":`, err);
      if (badgeEl.isConnected) {
        badgeEl.className = 'swoop-badge swoop-badge-unknown';
        badgeEl.textContent = '!';
        badgeEl.title = 'Extension error — check console';
      }
    }
  }

  // ─── Badge insertion ─────────────────────────────────────────────────────────

  function insertBadge(professorName, afterEl) {
    const badge = document.createElement('span');
    badge.className = 'swoop-badge swoop-badge-loading';
    badge.textContent = '···';
    badge.title = 'Loading RMP score…';
    badge.dataset.swoopName = professorName;

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      handleProfessorClick(badge, professorName);
    });

    afterEl.insertAdjacentElement('afterend', badge);
    queueEagerFetch(professorName, badge);
    return badge;
  }

  // ─── DOM processing ──────────────────────────────────────────────────────────

  // For <a> elements: leave the link intact, insert badge after it.
  function processAnchorElement(el) {
    if (el.hasAttribute(PROCESSED_ATTR)) return;
    const text = el.textContent.trim();
    if (!looksLikeName(text)) return;

    el.setAttribute(PROCESSED_ATTR, 'true');
    insertBadge(cleanName(text), el);
  }

  // For non-anchor elements (targeted selectors / td/span heuristic):
  // insert a badge after the element itself.
  function processElement(el) {
    if (el.hasAttribute(PROCESSED_ATTR)) return;
    el.setAttribute(PROCESSED_ATTR, 'true');

    // Walk text nodes to find the name-like text.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let bestName = null;

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!text) continue;
      const name = cleanName(text);
      if (looksLikeName(name)) {
        bestName = name;
        break;
      }
    }

    if (bestName) insertBadge(bestName, el);
  }

  // ─── DOM scanning ────────────────────────────────────────────────────────────

  function scanNode(root) {
    // 1. Targeted selectors first (most reliable)
    for (const selector of INSTRUCTOR_SELECTORS) {
      root.querySelectorAll(`${selector}:not([${PROCESSED_ATTR}])`).forEach(processElement);
    }

    // 2. Heuristic fallback: scan <td> and <span> leaf elements for name-like text
    root
      .querySelectorAll(`td:not([${PROCESSED_ATTR}]), span:not([${PROCESSED_ATTR}])`)
      .forEach((el) => {
        if (el.children.length > 0) return;
        const text = el.textContent.trim();
        const name = cleanName(text);
        if (looksLikeName(name)) {
          processElement(el);
        }
      });

    // 3. Scan <a> elements — instructor names on class-schedule.app.utah.edu are
    //    rendered as hyperlinks (e.g. <a href="...">Smith, Jenn</a>).
    //    Badges are inserted after the <a> so the link itself still works.
    root
      .querySelectorAll(`a:not([${PROCESSED_ATTR}])`)
      .forEach((el) => {
        if (el.children.length > 0) return;
        processAnchorElement(el);
      });
  }

  // ─── MutationObserver ────────────────────────────────────────────────────────
  // Handles dynamically loaded rows (the site is a React SPA).

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Skip badge elements we inserted ourselves to avoid infinite loops.
          if (node.classList?.contains('swoop-badge')) continue;
          scanNode(node);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial scan on load.
  scanNode(document.body);
  console.log('[SwoopScores] Content script active, observing DOM.');

  // ─── Popup ───────────────────────────────────────────────────────────────────

  function removePopup() {
    const existing = document.getElementById(POPUP_ID);
    if (existing) existing.remove();
  }

  function positionPopup(popup, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    let top = rect.bottom + scrollY + 6;
    let left = rect.left + scrollX;

    const popupWidth = 260;
    const viewportWidth = document.documentElement.clientWidth;
    if (left + popupWidth > viewportWidth + scrollX) {
      left = viewportWidth + scrollX - popupWidth - 8;
    }
    if (left < scrollX + 8) left = scrollX + 8;

    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  }

  function buildLoadingPopup(professorName) {
    const popup = document.createElement('div');
    popup.id = POPUP_ID;
    popup.className = 'swoop-popup';
    popup.innerHTML = `
      <div class="swoop-header">
        <span class="swoop-logo">⭐ RateMyProfessors</span>
      </div>
      <div class="swoop-body swoop-loading">
        <div class="swoop-spinner"></div>
        <span>Looking up ${escapeHtml(professorName)}…</span>
      </div>
    `;
    return popup;
  }

  function buildDataPopup(data) {
    const ratingClass = ratingColorClass(data.avgRating);
    const diffClass = difficultyColorClass(data.avgDifficulty);

    const takeAgainHtml =
      data.wouldTakeAgainPercent != null && data.wouldTakeAgainPercent >= 0
        ? `<div class="swoop-stat">
            <span class="swoop-label">Would Take Again</span>
            <span class="swoop-value">${Math.round(data.wouldTakeAgainPercent)}%</span>
           </div>`
        : '';

    return `
      <div class="swoop-header">
        <span class="swoop-logo">⭐ RateMyProfessors</span>
      </div>
      <div class="swoop-body">
        <div class="swoop-name">${escapeHtml(data.name)}</div>
        ${data.department ? `<div class="swoop-dept">${escapeHtml(data.department)}</div>` : ''}
        <div class="swoop-stats">
          <div class="swoop-stat">
            <span class="swoop-label">Rating</span>
            <span class="swoop-value ${ratingClass}">${formatStat(data.avgRating)}<span class="swoop-denom">/5</span></span>
          </div>
          <div class="swoop-stat">
            <span class="swoop-label">Difficulty</span>
            <span class="swoop-value ${diffClass}">${formatStat(data.avgDifficulty)}<span class="swoop-denom">/5</span></span>
          </div>
          <div class="swoop-stat">
            <span class="swoop-label">Ratings</span>
            <span class="swoop-value swoop-neutral">${data.numRatings ?? 'N/A'}</span>
          </div>
          ${takeAgainHtml}
        </div>
        <a class="swoop-link" href="${escapeHtml(data.profileUrl)}" target="_blank" rel="noopener">
          View Full Profile →
        </a>
      </div>
    `;
  }

  function buildErrorPopup(professorName, errorMsg) {
    return `
      <div class="swoop-header">
        <span class="swoop-logo">⭐ RateMyProfessors</span>
      </div>
      <div class="swoop-body swoop-error">
        <div class="swoop-error-icon">✗</div>
        <div class="swoop-error-name">${escapeHtml(professorName)}</div>
        <div class="swoop-error-msg">${escapeHtml(errorMsg)}</div>
      </div>
    `;
  }

  async function handleProfessorClick(anchorEl, professorName) {
    removePopup();

    const popup = buildLoadingPopup(professorName);
    document.body.appendChild(popup);
    positionPopup(popup, anchorEl);

    console.log(`[SwoopScores] Requesting RMP data for "${professorName}"`);

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'fetchRMP',
        professorName,
      });

      const currentPopup = document.getElementById(POPUP_ID);
      if (!currentPopup) return;

      if (response.error) {
        currentPopup.innerHTML = buildErrorPopup(professorName, response.error);
      } else {
        currentPopup.innerHTML = buildDataPopup(response);
      }

      positionPopup(currentPopup, anchorEl);
    } catch (err) {
      console.error('[SwoopScores] sendMessage error:', err);
      const currentPopup = document.getElementById(POPUP_ID);
      if (currentPopup) {
        currentPopup.innerHTML = buildErrorPopup(professorName, 'Extension error — check console.');
      }
    }
  }

  // Dismiss popup on outside click or Escape key.
  document.addEventListener('click', (e) => {
    const popup = document.getElementById(POPUP_ID);
    if (popup && !popup.contains(e.target)) removePopup();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') removePopup();
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatStat(value) {
    if (value == null || value < 0) return 'N/A';
    return Number(value).toFixed(1);
  }

  // Returns a short key used for both badge classes and popup color classes.
  // Rating: ≥3.5 → good/green, 2.5–3.49 → ok/yellow, <2.5 → bad/red
  function ratingColorKey(value) {
    if (value == null || value < 0) return 'unknown';
    if (value >= 3.5) return 'good';
    if (value >= 2.5) return 'ok';
    return 'bad';
  }

  function ratingColorClass(value) {
    return `swoop-${ratingColorKey(value)}`;
  }

  // Difficulty: ≤2.5 → good/green (easy), 2.5–3.5 → ok/yellow, >3.5 → bad/red (hard)
  function difficultyColorClass(value) {
    if (value == null || value < 0) return 'swoop-neutral';
    if (value <= 2.5) return 'swoop-good';
    if (value <= 3.5) return 'swoop-ok';
    return 'swoop-bad';
  }
})();
