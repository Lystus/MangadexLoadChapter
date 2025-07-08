// ==UserScript==
// @name         Mangadex – show chapters in advanced search
// @namespace    https://mangadex.org/
// @version      2.5.1
// @description  Show newest-chapter number on covers (one-shots count as 1), hide manga below a minimum count, retry stubborn feeds for up to 5 minutes.
// @author       you
// @match        https://mangadex.org/titles*
// @grant        GM_xmlhttpRequest
// @connect      api.mangadex.org
// ==/UserScript==

/* -------------------------------------------------------------
   CONFIG
----------------------------------------------------------------*/
const BADGE_STYLE   = `
  position:absolute;top:4px;left:4px;z-index:2;
  padding:2px 5px;border-radius:4px;font-size:11px;font-weight:700;
  background:#FFD166;color:#000;pointer-events:none;
`;
const CONCURRENCY_LIMIT = 6;   // simultaneous API calls
const LANG              = 'en';
const LS_KEY            = 'mdex_min_chapters';

const SHORT_RETRY_BASE  = 2000; // 2 s, 4 s, 8 s (in fetchLatestChapter)
const SHORT_RETRY_COUNT = 10;    // attempts inside fetchLatestChapter

const LONG_RETRY_BASE   = 5000; // 5 s, 10 s, 20 s …
const LONG_RETRY_MAX    = 6;    // … up to ~5 minutes total
/* ------------------------------------------------------------- */

(function () {
  'use strict';

  //----------------------------------------------------------------
  // Persistent state
  //----------------------------------------------------------------
  let minChapters = Number(localStorage.getItem(LS_KEY) || 0);

  //----------------------------------------------------------------
  // Lightweight async-queue
  //----------------------------------------------------------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const queue = [];
  let active  = 0;
  const runJob = job => new Promise(async resolve => {
    queue.push({ job, resolve });
    while (active >= CONCURRENCY_LIMIT) await sleep(50);
    const { job: j, resolve: res } = queue.shift();
    active++;
    try   { res(await j()); }
    catch (e) { res(null); }
    finally { active--; }
  });

  //----------------------------------------------------------------
  // API helper with 3 short retries (2 s → 4 s → 8 s)
  //----------------------------------------------------------------
  async function fetchLatestChapter(mangaId) {
    const url =
      `https://api.mangadex.org/manga/${mangaId}/feed` +
      `?limit=1&translatedLanguage[]=${LANG}&order[chapter]=desc`;

    const doRequest = () =>
      new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method:   'GET',
          url,
          anonymous: true,                // strip cookies
          timeout:  8000,
          headers: {
            Accept:  'application/json',
            Referer: 'https://mangadex.org'
          },
          onload: r => {
            if (r.status !== 200)
              return reject(new Error(`HTTP ${r.status}`));
            try {
              const j     = JSON.parse(r.responseText);
              let   chap  = j.data?.[0]?.attributes?.chapter;

              // ─────────── One-shot handling ────────────
              // MangaDex returns null (or sometimes “Oneshot”) for one-shots.
              if (
                chap == null ||                       // null / undefined
                /one[\s-]?shot/i.test(String(chap))   // “Oneshot”, “One-shot” …
              ) {
                chap = '1';
              }

              resolve(chap ?? '?');
            } catch (e) { reject(e); }
          },
          onerror:   () => reject(new Error('network')),
          ontimeout: () => reject(new Error('timeout')),
          onabort:   () => reject(new Error('aborted'))
        });
      });

    for (let a = 0; a < SHORT_RETRY_COUNT; a++) {
      try   { return await runJob(doRequest); }
      catch (_) { await sleep(SHORT_RETRY_BASE * 2 ** a); }
    }
    return '?';
  }

  //----------------------------------------------------------------
  // Card logic (short+long retries)
  //----------------------------------------------------------------
  const processed = new WeakSet();
  function applyVisibility(card) {
    const n = parseFloat(card.dataset.chap);
    card.style.display =
      !Number.isNaN(n) && minChapters > 0 && n < minChapters ? 'none' : '';
  }

  async function tryFillBadge(card, mangaId, badge, longTry = 0) {
    if (!document.body.contains(card)) return;              // card got removed
    const chap = await fetchLatestChapter(mangaId);

    // success?
    if (chap !== '?' && chap != null) {
      badge.textContent = chap;
      card.dataset.chap = chap;
      applyVisibility(card);
      return; // stop all retries
    }

    // schedule another long retry if limit not reached
    if (longTry < LONG_RETRY_MAX) {
      const delay = LONG_RETRY_BASE * 2 ** longTry;         // 5,10,20,40,80,160 s
      badge.textContent = '…';                              // keep spinning
      card.dataset.chap = '';                               // unknown → stay visible
      card._mdexTimer = setTimeout(() =>
        tryFillBadge(card, mangaId, badge, longTry + 1), delay);
    } else {
      // give up after ~5 min
      badge.textContent = '?';
      card.dataset.chap = '';
    }
  }

  async function enhanceCard(card) {
    if (processed.has(card)) return;
    processed.add(card);

    const titleLink = card.querySelector('a.title');
    titleLink?.querySelector('.mdex-latest-badge')?.remove();

    const cover = card.querySelector('.manga-card-cover');
    if (!cover) return;
    cover.style.position = 'relative';
    let badge = cover.querySelector('.mdex-latest-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'mdex-latest-badge';
      badge.setAttribute('style', BADGE_STYLE);
      cover.appendChild(badge);
    }
    badge.textContent = '…';

    const mangaId = card
      .querySelector('a[href*="/title/"]')
      ?.getAttribute('href')
      ?.split('/')[2];

    if (!mangaId) {
      badge.textContent = '?';
      return;
    }
    tryFillBadge(card, mangaId, badge, 0);
  }

  //----------------------------------------------------------------
  // DOM observer
  //----------------------------------------------------------------
  const obs = new MutationObserver(muts => {
    muts.forEach(m =>
      m.addedNodes.forEach(n => {
        if (n.nodeType === 1) {
          if (n.matches?.('.manga-card')) enhanceCard(n);
          n.querySelectorAll?.('.manga-card').forEach(enhanceCard);
        }
      })
    );
  });
  obs.observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll('.manga-card').forEach(enhanceCard);

  //----------------------------------------------------------------
  // “Min chapters” filter UI
  //----------------------------------------------------------------
  function injectBox() {
    if (document.getElementById('mdex-minchap-input')) return;
    const resetBtn = [...document.querySelectorAll('button, a')].find(el =>
      /reset\s*filters?/i.test(el.textContent)
    );
    if (!resetBtn) return;

    const box = document.createElement('div');
    Object.assign(box.style, {
      display: 'inline-flex', flexDirection: 'column',
      marginRight: '1rem', minWidth: '8rem'
    });

    const label = document.createElement('label');
    label.textContent = 'Min chapters';
    label.style.marginBottom = '0.25rem';
    box.appendChild(label);

    const input = Object.assign(document.createElement('input'), {
      id: 'mdex-minchap-input', type: 'number', min: 0, step: 1,
      placeholder: 'Any', value: minChapters || ''
    });
    Object.assign(input.style, {
      padding: '6px 8px', borderRadius: '4px',
      background: '#2c2c2c', color: '#fff', border: '1px solid #444'
    });
    input.addEventListener('input', () => {
      minChapters = Number(input.value) || 0;
      localStorage.setItem(LS_KEY, minChapters);
      document.querySelectorAll('.manga-card').forEach(applyVisibility);
    });
    box.appendChild(input);
    resetBtn.parentNode.insertBefore(box, resetBtn);
  }

  const poll = setInterval(() => {
    if (document.getElementById('mdex-minchap-input')) clearInterval(poll);
    else injectBox();
  }, 500);
})();
