(() => {
  const CJK = /[一-鿿㐀-䶿]/;

  let popup = null;
  let active = true;
  let popupSize = 's';
  let debounceTimer = null;
  let scannedNodes = new WeakSet();
  let wordCache = {};
  let phraseCache = {};
  let combinedRegex = null;
  let phraseSet = new Set();

  // ---------- Init ----------
  chrome.storage.local.get(['ext_active', 'word_cache', 'phrase_cache', 'popup_size'], (d) => {
    if (d.ext_active === false) active = false;
    wordCache = d.word_cache || {};
    phraseCache = d.phrase_cache || {};
    popupSize = d.popup_size || 'm';
    rebuildRegex();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.ext_active) active = changes.ext_active.newValue !== false;
    if (changes.popup_size) popupSize = changes.popup_size.newValue || 's';
    if (changes.word_cache) {
      wordCache = changes.word_cache.newValue || {};
      rebuildRegex();
      scannedNodes = new WeakSet();
    }
    if (changes.phrase_cache) {
      phraseCache = changes.phrase_cache.newValue || {};
      rebuildRegex();
      scannedNodes = new WeakSet();
    }
  });

  function rebuildRegex() {
    const phrases = Object.keys(phraseCache);
    phraseSet = new Set(phrases);
    const words = Object.keys(wordCache).filter(w => !phraseSet.has(w));
    const all = [...phrases, ...words].sort((a, b) => b.length - a.length);
    if (all.length === 0) { combinedRegex = null; return; }
    const escaped = all.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    combinedRegex = new RegExp('(' + escaped.join('|') + ')', 'g');
  }

  // ---------- Keyboard toggle ----------
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'T') {
      active = !active;
      chrome.storage.local.set({ ext_active: active });
      if (!active) removePopup();
    }
  });

  // ---------- Selection / click handlers ----------
  document.addEventListener('mouseup', (e) => {
    if (!active) return;
    if (popup && popup.contains(e.target)) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      if (isInteractiveMarker(e.target)) return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => handleSelection(), 150);
  });

  document.addEventListener('mousedown', (e) => {
    if (popup && !popup.contains(e.target) && !isInteractiveMarker(e.target)) removePopup();
  });

  document.addEventListener('click', (e) => {
    if (!active) return;
    const word = e.target.closest && e.target.closest('.cn-trans-known');
    if (word) {
      e.preventDefault();
      e.stopPropagation();
      const w = word.dataset.word;
      const data = wordCache[w];
      if (data) showWordPopup(word.getBoundingClientRect(), data);
      return;
    }
    const phrase = e.target.closest && e.target.closest('.cn-phrase');
    if (phrase) {
      e.preventDefault();
      e.stopPropagation();
      const key = phrase.dataset.phraseKey;
      const data = phraseCache[key];
      if (data) {
        showPhrasePopup(phrase.getBoundingClientRect(), data, true, key);
      }
    }
  }, true);

  function isInteractiveMarker(el) {
    return el && el.closest && el.closest('.cn-phrase, .cn-trans-known');
  }

  function handleSelection() {
    const sel = window.getSelection();
    const text = sel.toString().trim();
    if (!text || !CJK.test(text)) return;
    if (text.length > 500) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const context = extractContext(range, text);

    // Exact match → cache hit, no override
    if (phraseCache[text]) {
      showPhrasePopup(rect, phraseCache[text], true, text);
      const cacheAnchor = resolveAnchor(range);
      if (cacheAnchor && cacheAnchor.isConnected) scanDeep(cacheAnchor);
      return;
    }

    // Climb past any wrapper spans so the anchor survives unwrap.
    const anchor = resolveAnchor(range);

    // Only record the overlap here; nothing is removed unless the translation succeeds.
    const overlap = collectOverlap(range);

    showLoadingPopup(rect);
    translate(text, context, rect, anchor, overlap);
  }

  function resolveAnchor(range) {
    let node = range.commonAncestorContainer;
    if (node && node.nodeType !== 1) node = node.parentElement;
    while (
      node && node.classList &&
      (node.classList.contains('cn-trans-known') ||
       node.classList.contains('cn-phrase') ||
       node.classList.contains('cn-phrase-marker'))
    ) {
      node = node.parentElement;
    }
    return node;
  }

  function extractContext(range, selectedText) {
    let node = range.startContainer;
    while (node && node.nodeType !== 1) node = node.parentNode;
    while (
      node && node.classList &&
      (node.classList.contains('cn-trans-known') || node.classList.contains('cn-phrase'))
    ) {
      node = node.parentElement;
    }
    if (!node) return { before: '', after: '' };
    const txt = (node.textContent || '').replace(/\s+/g, ' ');
    if (!txt) return { before: '', after: '' };
    const idx = txt.indexOf(selectedText);
    if (idx < 0) return { before: '', after: '' };
    const before = txt.slice(Math.max(0, idx - 50), idx);
    const after = txt.slice(idx + selectedText.length, idx + selectedText.length + 50);
    return { before, after };
  }

  // ---------- Scan-on-hover: wrap cached phrases and words in page text ----------
  document.addEventListener('mouseover', (e) => {
    if (!active) return;
    if (combinedRegex) scanElement(e.target);
  });

  function scanElement(el) {
    if (!el || !combinedRegex) return;
    if (el.tagName && /^(SCRIPT|STYLE|TEXTAREA|INPUT|NOSCRIPT)$/.test(el.tagName)) return;
    if (el.id === 'cn-trans-popup') return;
    if (el.closest && (el.closest('#cn-trans-popup') || el.closest('.cn-phrase') || el.closest('.cn-trans-known'))) return;
    if (el.isContentEditable) return;

    const textNodes = [];
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && !scannedNodes.has(child) && CJK.test(child.nodeValue)) {
        textNodes.push(child);
      }
    }
    for (const node of textNodes) {
      wrapMatches(node);
      scannedNodes.add(node);
    }
  }

  function scanDeep(el) {
    if (!el) return;
    scanElement(el);
    if (!el.children) return;
    for (const child of el.children) scanDeep(child);
  }

  function wrapMatches(textNode) {
    const text = textNode.nodeValue;
    combinedRegex.lastIndex = 0;
    if (!combinedRegex.test(text)) return;
    combinedRegex.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    while ((match = combinedRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const matched = match[0];
      if (phraseSet.has(matched)) {
        frag.appendChild(buildPhraseNode(matched, phraseCache[matched]));
      } else if (wordCache[matched] && !CONNECTOR_CHARS.has(matched)) {
        frag.appendChild(buildWordNode(matched));
      } else {
        frag.appendChild(document.createTextNode(matched));
      }
      lastIndex = match.index + matched.length;
    }
    if (lastIndex < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    if (textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
  }

  function buildPhraseNode(phraseText, phraseData) {
    const span = document.createElement('span');
    span.className = 'cn-phrase';
    span.dataset.phraseKey = phraseText;

    const marker = document.createElement('span');
    marker.className = 'cn-phrase-marker';
    span.appendChild(marker);

    const words = (phraseData && phraseData.words) || [];
    let cursor = 0;
    for (const w of words) {
      if (!w || !w.hanzi) continue;
      const idx = phraseText.indexOf(w.hanzi, cursor);
      if (idx < 0) continue;
      if (idx > cursor) {
        span.appendChild(document.createTextNode(phraseText.slice(cursor, idx)));
      }
      span.appendChild(buildWordNode(w.hanzi));
      cursor = idx + w.hanzi.length;
    }
    if (cursor < phraseText.length) {
      span.appendChild(document.createTextNode(phraseText.slice(cursor)));
    }
    return span;
  }

  function buildWordNode(word) {
    const span = document.createElement('span');
    span.className = 'cn-trans-known';
    span.dataset.word = word;
    span.textContent = word;
    return span;
  }

  // ---------- Popups ----------
  function showLoadingPopup(rect) {
    const p = createPopup(rect);
    p.classList.add('cn-loading');
    p.innerHTML = `<img class="cn-loading-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="">`;
    finalizePopupPosition(p, rect);
  }

  const TRASH_SVG = '<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h10"/><path d="M5 4V2.5h4V4"/><path d="M3.5 4l.5 8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8"/></svg>';

  function showPhrasePopup(rect, data, fromCache, key) {
    const p = createPopup(rect);
    p.innerHTML = `
      <button class="cn-trans-close" title="Close">×</button>
      <button class="cn-trans-trash" title="Delete translation">${TRASH_SVG}</button>
      ${buildPopupHTML(data)}`;
    p.querySelector('.cn-trans-close').addEventListener('click', removePopup);
    p.querySelector('.cn-trans-trash').addEventListener('click', () => deleteCachedEntry(key, 'phrase'));
    finalizePopupPosition(p, rect);
  }

  function showWordPopup(rect, wordData) {
    const p = createPopup(rect);
    const key = wordData && wordData.hanzi;
    const syntheticData = { full_translation: wordData.meaning || '', words: [wordData] };
    p.innerHTML = `
      <button class="cn-trans-close" title="Close">×</button>
      <button class="cn-trans-trash" title="Delete translation">${TRASH_SVG}</button>
      ${buildPopupHTML(syntheticData, false)}`;
    p.querySelector('.cn-trans-close').addEventListener('click', removePopup);
    p.querySelector('.cn-trans-trash').addEventListener('click', () => deleteCachedEntry(key, 'word'));
    finalizePopupPosition(p, rect);
  }

  function createPopup(rect) {
    removePopup();
    popup = document.createElement('div');
    popup.id = 'cn-trans-popup';
    if (popupSize === 'm') popup.classList.add('cn-size-m');
    else if (popupSize === 'l') popup.classList.add('cn-size-l');
    popup.style.visibility = 'hidden';
    popup.style.left = '0px';
    popup.style.top = '0px';
    document.body.appendChild(popup);
    return popup;
  }

  function getPopupZoom(p) {
    if (p.classList.contains('cn-size-l')) return 1.67;
    if (p.classList.contains('cn-size-m')) return 1.33;
    return 1;
  }

  function finalizePopupPosition(p, rect) {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const factor = getPopupZoom(p);

    // getBoundingClientRect gives actual rendered (zoomed) dimensions
    const bcr = p.getBoundingClientRect();
    const visualW = bcr.width;
    const visualH = bcr.height;

    let left = rect.left + scrollX;
    let top = rect.bottom + scrollY + 10;
    const maxLeft = window.innerWidth + scrollX - visualW - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < scrollX + 8) left = scrollX + 8;

    const showAbove = rect.bottom + visualH + 16 > window.innerHeight;
    if (showAbove) {
      p.dataset.above = 'true';
      top = rect.top + scrollY - visualH - 10;
    }

    // Chrome multiplies style.left/top by the zoom factor, so divide to compensate
    p.style.left = (left / factor) + 'px';
    p.style.top = (top / factor) + 'px';
    p.style.visibility = 'visible';
  }

  const TONE_COLORS = ['', '#c0392b', '#27ae60', '#2980b9', '#8e44ad', '#888780'];
  const FUNCTION_CHARS = new Set(['的','了','和','是','在','也','都','就','与','或','但','而','对','于']);
  const CONNECTOR_CHARS = new Set(['的','了','和','是','在','也','都','就','与','或','但','而','对','于','把','被','让','给','从','到','着','过','吗','呢','吧','啊','嗯','呀']);

  function toneColor(t) {
    const n = Number(t);
    if (n === 1) return '#c0392b';
    if (n === 2) return '#27ae60';
    if (n === 3) return '#2980b9';
    if (n === 4) return '#8e44ad';
    return '#888780';
  }

  function coloredHanzi(hanzi, tones) {
    const t = Array.isArray(tones) ? tones : [];
    return (hanzi || '').split('').map((ch, i) =>
      `<span style="color:${toneColor(t[i])}">${esc(ch)}</span>`
    ).join('');
  }

  function splitPinyinSyllables(s) {
    const C = 'bpmfdtnlgkhjqxzcsryw';
    const V = 'aeiouüāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ';
    const patt = new RegExp(`^[${C}]{0,2}[${V}][${V}]*(?:ng?|n|r)?`);
    const parts = [];
    let rem = s.replace(/\s/g, '');
    while (rem.length > 0) {
      const m = rem.match(patt);
      if (m && m[0].length > 0) { parts.push(m[0]); rem = rem.slice(m[0].length); }
      else { parts.push(rem); break; }
    }
    return parts;
  }

  function coloredPinyin(pinyin, tones, hanziLen) {
    if (!pinyin) return '';
    const t = Array.isArray(tones) ? tones : [];
    const syllables = pinyin.normalize('NFC').split(' ').filter(Boolean);
    if (hanziLen != null && syllables.length !== hanziLen) {
      return `<span style="color:#888780">${esc(pinyin)}</span>`;
    }
    let syls = syllables.length ? syllables : pinyin.trim().split(/\s+/).filter(Boolean);
    if (t.length > 1 && (syls.length < 2 || syls.length !== t.length)) {
      const split = splitPinyinSyllables(pinyin);
      if (split.length === t.length || syls.length < 2) syls = split;
    }
    return syls.map((syl, i) =>
      `<span style="color:${toneColor(t[i])}">${esc(syl)}</span>`
    ).join('&nbsp;');
  }

  function buildPopupHTML(data, showHead = true) {
    const headChars = (data.words || []).map(w => esc(w.hanzi || '')).join('');
    const rows = (data.words || []).map(w => {
      const dim = (w.meaning && w.meaning.length < 5) || FUNCTION_CHARS.has(w.hanzi) ? ' cn-dim' : '';
      let tagHtml = '';
      if (w.tag === 'lost_in_translation') {
        tagHtml = `<span class="cn-tag cn-tag-lit">lost in translation</span>`;
      } else if (w.tag === 'cultural_context') {
        tagHtml = `<span class="cn-tag cn-tag-cx">cultural context</span>`;
      }
      const noteHtml = w.note
        ? `<div class="cn-note-wrap"><div class="cn-note-inner"><div class="cn-note">${esc(w.note)}</div></div></div>`
        : '';
      return `<div class="cn-row${dim}">
        <div class="cn-wl">
          <span class="cn-ch">${coloredHanzi(w.hanzi || '', w.tones)}</span>
          <span class="cn-pi">${coloredPinyin(w.pinyin, w.tones, (w.hanzi || '').length)}</span>
        </div>
        <div class="cn-gl">${esc(w.meaning || '')}${tagHtml}</div>
        ${noteHtml}
      </div>`;
    }).join('');
    const headHTML = showHead ? `<div class="cn-head">
      <span class="cn-head-chars">${headChars}</span>
      <span class="cn-head-tr">${esc(data.full_translation || '')}</span>
    </div>` : '';
    return `${headHTML}<div class="cn-rows">${rows}</div>`;
  }

  // ---------- Cache + DOM mutation helpers ----------
  function unwrapMarker(node) {
    if (!node || !node.isConnected || !node.parentNode) return;
    const parent = node.parentNode;
    parent.replaceChild(document.createTextNode(node.textContent), node);
    if (parent.normalize) parent.normalize();
  }

  // All cache writes go through the service worker (background.js).
  async function sendToWorker(message) {
    const resp = await chrome.runtime.sendMessage(message);
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'Longyan background worker did not respond');
    return resp;
  }

  // Adopt the worker's caches and unwrap any marker whose entry is gone.
  function applyCaches(resp, extraNodes = []) {
    wordCache = resp.wordCache || {};
    phraseCache = resp.phraseCache || {};
    for (const node of extraNodes) unwrapMarker(node);
    document.querySelectorAll('.cn-phrase').forEach(node => {
      if (!phraseCache[node.dataset.phraseKey]) unwrapMarker(node);
    });
    document.querySelectorAll('.cn-trans-known').forEach(node => {
      if (!wordCache[node.dataset.word]) unwrapMarker(node);
    });
    rebuildRegex();
    scannedNodes = new WeakSet();
  }

  async function deleteCachedEntry(key, type) {
    removePopup();
    if (!key) return;
    try {
      const resp = type === 'word'
        ? await sendToWorker({ type: 'deleteWord', key, alsoPhrase: true })
        : await sendToWorker({ type: 'deletePhrase', key });
      applyCaches(resp);
    } catch (err) {
      console.warn('Longyan: delete failed', err);
    }
  }

  // Which cached entries the selection overlaps. Read-only: the worker applies
  // the removal together with the new translation, and only if it succeeds.
  function collectOverlap(range) {
    const phraseKeys = new Set();
    const wordKeys = new Set();
    const nodes = [];
    for (const ph of document.querySelectorAll('.cn-phrase')) {
      try {
        if (range.intersectsNode(ph) && ph.dataset.phraseKey) { phraseKeys.add(ph.dataset.phraseKey); nodes.push(ph); }
      } catch (_) {}
    }
    for (const wu of document.querySelectorAll('.cn-trans-known')) {
      try {
        if (range.intersectsNode(wu) && wu.dataset.word) { wordKeys.add(wu.dataset.word); nodes.push(wu); }
      } catch (_) {}
    }
    return { phraseKeys: [...phraseKeys], wordKeys: [...wordKeys], nodes };
  }

  // ---------- API (runs in background.js) ----------
  async function translate(text, context, rect, anchor, overlap) {
    try {
      const resp = await sendToWorker({
        type: 'translate',
        text,
        context,
        overlap: { phraseKeys: overlap.phraseKeys, wordKeys: overlap.wordKeys }
      });

      // Unwrap the overlapped markers so the new phrase can be wrapped whole.
      applyCaches(resp, overlap.nodes);
      showPhrasePopup(rect, resp.parsed, false, text);

      // Wrap the newly-translated phrase wherever it appears in the source element
      if (anchor && anchor.isConnected) scanDeep(anchor);
    } catch (err) {
      showError(err.message);
    }
  }

  function showError(msg) {
    if (!popup) return;
    popup.innerHTML = `
      <button class="cn-trans-close" title="Close">×</button>
      <div class="cn-trans-error">${esc(msg)}</div>`;
    popup.querySelector('.cn-trans-close').addEventListener('click', removePopup);
  }

  function removePopup() {
    if (popup) { popup.remove(); popup = null; }
  }

  function esc(s) {
    const d = document.createElement('span');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
})();
