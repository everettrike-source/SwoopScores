// SwoopScores — Content Script
// Scans the DOM for professor names on class-schedule.app.utah.edu,
// makes them clickable, and shows a RateMyProfessor popup on click.

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
    // Generic fallback: table cells whose text looks like a professor name
    // (handled separately via heuristic scan — see scanNode())
  ];

  const PROCESSED_ATTR = 'data-swoop-processed';
  const POPUP_ID = 'swoop-popup';

  // ─── Name normalization ──────────────────────────────────────────────────────

  // Strips titles (Dr., Prof., etc.) and extra whitespace so the RMP search
  // gets a clean "First Last" string.
  function cleanName(raw) {
    return raw
      .replace(/\b(Dr\.?|Prof\.?|Mr\.?|Mrs\.?|Ms\.?)\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Heuristic: does this string look like a "First Last" name?
  // Requires 2–4 words, each starting with a capital letter, no digits.
  function looksLikeName(text) {
    const trimmed = text.trim();
    if (/\d/.test(trimmed)) return false;
    const words = trimmed.split(/\s+/);
    if (words.length < 2 || words.length > 4) return false;
    return words.every((w) => /^[A-Z][a-zA-Z'-]+$/.test(w));
  }

  // ─── DOM wrapping ────────────────────────────────────────────────────────────

  function wrapNameNode(textNode, name) {
    const span = document.createElement('span');
    span.className = 'swoop-prof-name';
    span.title = 'Click to view RateMyProfessor score';
    span.textContent = textNode.textContent;

    span.addEventListener('click', (e) => {
      e.stopPropagation();
      handleProfessorClick(span, name);
    });

    textNode.parentNode.replaceChild(span, textNode);
  }

  function processElement(el) {
    if (el.hasAttribute(PROCESSED_ATTR)) return;
    el.setAttribute(PROCESSED_ATTR, 'true');

    // Walk text nodes inside the element looking for name-like text.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const nodesToWrap = [];

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!text) continue;
      const name = cleanName(text);
      if (looksLikeName(name)) {
        nodesToWrap.push({ node, name });
      }
    }

    // Replace after walking to avoid modifying the tree during traversal.
    for (const { node, name } of nodesToWrap) {
      wrapNameNode(node, name);
    }
  }

  // ─── DOM scanning ────────────────────────────────────────────────────────────

  function scanNode(root) {
    // 1. Targeted selectors first (most reliable)
    for (const selector of INSTRUCTOR_SELECTORS) {
      root.querySelectorAll(`${selector}:not([${PROCESSED_ATTR}])`).forEach(processElement);
    }

    // 2. Heuristic fallback: scan all <td> and <span> elements for name-like text
    root
      .querySelectorAll(`td:not([${PROCESSED_ATTR}]), span:not([${PROCESSED_ATTR}])`)
      .forEach((el) => {
        // Skip elements that already contain child elements (likely layout cells)
        if (el.children.length > 0) return;
        const text = el.textContent.trim();
        const name = cleanName(text);
        if (looksLikeName(name)) {
          processElement(el);
        }
      });
  }

  // ─── MutationObserver ────────────────────────────────────────────────────────
  // Handles dynamically loaded rows (the site is a React SPA).

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
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

    // Keep popup inside the viewport horizontally.
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

      // Popup may have been dismissed while awaiting.
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

  // Rating: ≥3.5 green, 2.5–3.49 yellow, <2.5 red
  function ratingColorClass(value) {
    if (value == null || value < 0) return 'swoop-neutral';
    if (value >= 3.5) return 'swoop-good';
    if (value >= 2.5) return 'swoop-ok';
    return 'swoop-bad';
  }

  // Difficulty: ≤2.5 green (easy), 2.5–3.5 yellow, >3.5 red (hard)
  function difficultyColorClass(value) {
    if (value == null || value < 0) return 'swoop-neutral';
    if (value <= 2.5) return 'swoop-good';
    if (value <= 3.5) return 'swoop-ok';
    return 'swoop-bad';
  }
})();
