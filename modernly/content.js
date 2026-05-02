(() => {
  const CJK = /[一-鿿㐀-䶿]/;

  let popup = null;
  let active = true;
  let debounceTimer = null;
  let scannedNodes = new WeakSet();
  let wordCache = {};
  let phraseCache = {};
  let combinedRegex = null;
  let phraseSet = new Set();

  // ---------- Init ----------
  chrome.storage.local.get(['ext_active', 'word_cache', 'phrase_cache'], (d) => {
    if (d.ext_active === false) active = false;
    wordCache = d.word_cache || {};
    phraseCache = d.phrase_cache || {};
    rebuildRegex();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.ext_active) active = changes.ext_active.newValue !== false;
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
    if (isInteractiveMarker(e.target)) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => handleSelection(), 150);
  });

  document.addEventListener('mousedown', (e) => {
    if (popup && !popup.contains(e.target) && !isInteractiveMarker(e.target)) removePopup();
  });

  document.addEventListener('click', (e) => {
    if (!active) return;
    const tab = e.target.closest && e.target.closest('.cn-trans-phrase-tab');
    if (tab) {
      e.preventDefault();
      e.stopPropagation();
      const phraseSpan = tab.closest('.cn-trans-phrase');
      if (!phraseSpan) return;
      const key = phraseSpan.dataset.phraseKey;
      const data = phraseCache[key];
      if (data) {
        showPhrasePopup(phraseSpan.getBoundingClientRect(), data, true, key);
      }
      return;
    }
    const word = e.target.closest && e.target.closest('.cn-trans-word-unit');
    if (word) {
      e.preventDefault();
      e.stopPropagation();
      const w = word.dataset.word;
      const data = wordCache[w];
      if (data) showWordPopup(word.getBoundingClientRect(), data);
    }
  }, true);

  function isInteractiveMarker(el) {
    return el && el.closest && el.closest('.cn-trans-phrase-tab, .cn-trans-word-unit');
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
      return;
    }

    // Capture anchor before any DOM mutation from overlap clearance
    let anchor = range.commonAncestorContainer;
    if (anchor && anchor.nodeType !== 1) anchor = anchor.parentElement;

    clearOverlappingCaches(range);

    showLoadingPopup(rect);
    translate(text, context, rect, anchor);
  }

  function extractContext(range, selectedText) {
    let node = range.startContainer;
    while (node && node.nodeType !== 1) node = node.parentNode;
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
    if (el.closest && (el.closest('#cn-trans-popup') || el.closest('.cn-trans-phrase') || el.closest('.cn-trans-word-unit'))) return;
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
      } else if (wordCache[matched]) {
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
    span.className = 'cn-trans-phrase';
    span.dataset.phraseKey = phraseText;

    const tab = document.createElement('span');
    tab.className = 'cn-trans-phrase-tab';
    tab.title = 'Phrase translation';
    const tabVisual = document.createElement('span');
    tabVisual.className = 'cn-trans-phrase-tab-visual';
    tab.appendChild(tabVisual);
    span.appendChild(tab);

    const words = (phraseData && phraseData.words) || [];
    let cursor = 0;
    for (const w of words) {
      if (!w || !w.chinese) continue;
      const idx = phraseText.indexOf(w.chinese, cursor);
      if (idx < 0) continue;
      if (idx > cursor) {
        span.appendChild(document.createTextNode(phraseText.slice(cursor, idx)));
      }
      span.appendChild(buildWordNode(w.chinese));
      cursor = idx + w.chinese.length;
    }
    if (cursor < phraseText.length) {
      span.appendChild(document.createTextNode(phraseText.slice(cursor)));
    }
    return span;
  }

  function buildWordNode(word) {
    const span = document.createElement('span');
    span.className = 'cn-trans-word-unit';
    span.dataset.word = word;
    span.textContent = word;
    return span;
  }

  // ---------- Popups ----------
  function showLoadingPopup(rect) {
    const p = createPopup(rect);
    p.innerHTML = `
      <button class="cn-trans-close" title="Close">×</button>
      <div class="cn-trans-loading">
        <span class="cn-trans-loading-dot"></span>
        <span class="cn-trans-loading-dot"></span>
        <span class="cn-trans-loading-dot"></span>
      </div>`;
    p.querySelector('.cn-trans-close').addEventListener('click', removePopup);
    finalizePopupPosition(p, rect);
  }

  const TRASH_SVG = '<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h10"/><path d="M5 4V2.5h4V4"/><path d="M3.5 4l.5 8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8"/></svg>';

  function showPhrasePopup(rect, data, fromCache, key) {
    const p = createPopup(rect);
    const words = data.words || [];
    const isSingle = words.length <= 1;

    if (isSingle) {
      p.classList.add('cn-trans-popup--single');
      p.innerHTML = `
        <button class="cn-trans-close" title="Close">×</button>
        <button class="cn-trans-trash" title="Delete translation">${TRASH_SVG}</button>
        <div class="cn-trans-words">${words[0] ? renderWordCard(words[0]) : ''}</div>`;
    } else {
      p.classList.add('cn-trans-popup--phrase');
      const wordsHtml = words.map(renderWordCard).join('');
      p.innerHTML = `
        <button class="cn-trans-close" title="Close">×</button>
        <button class="cn-trans-trash" title="Delete translation">${TRASH_SVG}</button>
        <div class="cn-trans-full">${esc(data.phraseTranslation || '')}</div>
        <div class="cn-trans-words">${wordsHtml}</div>`;
    }
    p.querySelector('.cn-trans-close').addEventListener('click', removePopup);
    p.querySelector('.cn-trans-trash').addEventListener('click', () => deleteCachedEntry(key, 'phrase'));
    bindExpandHandlers(p);
    finalizePopupPosition(p, rect);
  }

  function showWordPopup(rect, wordData) {
    const p = createPopup(rect);
    p.classList.add('cn-trans-popup--single');
    const key = wordData && wordData.chinese;
    p.innerHTML = `
      <button class="cn-trans-close" title="Close">×</button>
      <button class="cn-trans-trash" title="Delete translation">${TRASH_SVG}</button>
      <div class="cn-trans-words">${renderWordCard(wordData)}</div>`;
    p.querySelector('.cn-trans-close').addEventListener('click', removePopup);
    p.querySelector('.cn-trans-trash').addEventListener('click', () => deleteCachedEntry(key, 'word'));
    bindExpandHandlers(p);
    finalizePopupPosition(p, rect);
  }

  function bindExpandHandlers(p) {
    p.querySelectorAll('.cn-trans-word-expandable').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.cn-trans-close, .cn-trans-trash')) return;
        card.classList.toggle('expanded');
      });
    });
  }

  function createPopup(rect) {
    removePopup();
    popup = document.createElement('div');
    popup.id = 'cn-trans-popup';
    popup.style.visibility = 'hidden';
    popup.style.left = '0px';
    popup.style.top = '0px';
    document.body.appendChild(popup);
    return popup;
  }

  function finalizePopupPosition(p, rect) {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    let left = rect.left + scrollX;
    let top = rect.bottom + scrollY + 10;
    const maxLeft = window.innerWidth + scrollX - p.offsetWidth - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < scrollX + 8) left = scrollX + 8;

    const showAbove = rect.bottom + p.offsetHeight + 16 > window.innerHeight;
    if (showAbove) {
      p.dataset.above = 'true';
      top = rect.top + scrollY - p.offsetHeight - 10;
    }

    p.style.left = left + 'px';
    p.style.top = top + 'px';
    p.style.visibility = 'visible';
  }

  function renderWordCard(w) {
    if (!w) return '';
    const severity = typeof w.gapSeverity === 'number' ? w.gapSeverity : 0;
    const tone = severity >= 7 ? 'red' : severity >= 4 ? 'amber' : 'green';
    const expandable = severity >= 4 && w.gapExplanation;
    return `
      <div class="cn-trans-word${expandable ? ' cn-trans-word-expandable' : ''}" data-severity="${severity}">
        <div class="cn-trans-hanzi-row">
          <span class="cn-trans-hanzi">${esc(w.chinese || '')}</span>
          <span class="cn-trans-status">
            <span class="cn-trans-dot cn-trans-dot-${tone}"></span>
            ${expandable ? '<span class="cn-trans-chevron">▾</span>' : ''}
          </span>
        </div>
        <span class="cn-trans-pinyin">${esc(w.pinyin || '')}</span>
        <span class="cn-trans-meaning">${esc(w.translation || '')}</span>
        ${expandable ? `<div class="cn-trans-gap-wrap"><div class="cn-trans-gap-divider"></div><div class="cn-trans-gap-explanation">${esc(w.gapExplanation)}</div></div>` : ''}
      </div>`;
  }

  // ---------- Cache + DOM mutation helpers ----------
  function unwrapMarker(node) {
    if (!node || !node.isConnected || !node.parentNode) return;
    node.parentNode.replaceChild(document.createTextNode(node.textContent), node);
  }

  function isWordInAnyPhrase(word) {
    for (const phData of Object.values(phraseCache)) {
      if (!phData || !phData.words) continue;
      for (const w of phData.words) {
        if (w && w.chinese === word) return true;
      }
    }
    return false;
  }

  function deleteCachedEntry(key, type) {
    if (!key) { removePopup(); return; }
    if (type === 'word') {
      delete wordCache[key];
      document.querySelectorAll('.cn-trans-word-unit').forEach(node => {
        if (node.dataset.word === key) unwrapMarker(node);
      });
    } else if (type === 'phrase') {
      const phraseData = phraseCache[key];
      delete phraseCache[key];
      if (phraseData && phraseData.words) {
        for (const w of phraseData.words) {
          if (w && w.chinese && !isWordInAnyPhrase(w.chinese)) {
            delete wordCache[w.chinese];
          }
        }
      }
      document.querySelectorAll('.cn-trans-phrase').forEach(node => {
        if (node.dataset.phraseKey === key) unwrapMarker(node);
      });
      document.querySelectorAll('.cn-trans-word-unit').forEach(node => {
        if (!wordCache[node.dataset.word]) unwrapMarker(node);
      });
    }
    chrome.storage.local.set({ word_cache: wordCache, phrase_cache: phraseCache });
    rebuildRegex();
    scannedNodes = new WeakSet();
    removePopup();
  }

  function clearOverlappingCaches(range) {
    const phrases = document.querySelectorAll('.cn-trans-phrase');
    const wordUnits = document.querySelectorAll('.cn-trans-word-unit');

    const phraseKeys = new Set();
    const wordKeys = new Set();

    for (const ph of phrases) {
      try { if (range.intersectsNode(ph) && ph.dataset.phraseKey) phraseKeys.add(ph.dataset.phraseKey); } catch (_) {}
    }
    for (const wu of wordUnits) {
      try { if (range.intersectsNode(wu) && wu.dataset.word) wordKeys.add(wu.dataset.word); } catch (_) {}
    }
    if (phraseKeys.size === 0 && wordKeys.size === 0) return;

    for (const k of phraseKeys) {
      const phData = phraseCache[k];
      delete phraseCache[k];
      if (phData && phData.words) {
        for (const w of phData.words) {
          if (w && w.chinese) wordKeys.add(w.chinese);
        }
      }
    }
    for (const k of wordKeys) {
      if (!isWordInAnyPhrase(k)) delete wordCache[k];
    }

    for (const ph of phrases) {
      if (phraseKeys.has(ph.dataset.phraseKey)) unwrapMarker(ph);
    }
    for (const wu of wordUnits) {
      if (!wordCache[wu.dataset.word]) unwrapMarker(wu);
    }

    chrome.storage.local.set({ word_cache: wordCache, phrase_cache: phraseCache });
    rebuildRegex();
    scannedNodes = new WeakSet();
  }

  // ---------- API ----------
  async function translate(text, context, rect, anchor) {
    try {
      const stored = await chrome.storage.local.get(['anthropic_key']);
      const key = stored.anthropic_key;
      if (!key) {
        showError('No API key set. Click the extension icon to add your Anthropic key.');
        return;
      }

      const prompt = `You are translating Chinese text in context.

Highlighted text: ${text}
Surrounding context for comprehension: ${context.before}【${text}】${context.after}

Return JSON:
{
  "phraseTranslation": "English translation of ONLY the highlighted text, not the surrounding context",
  "words": [
    {
      "chinese": "word or phrase unit",
      "pinyin": "tone-marked pinyin",
      "translation": "direct English equivalent",
      "gapSeverity": integer 0-10,
      "gapExplanation": "if gapSeverity >= 4, one sentence under 100 characters. Otherwise null"
    }
  ]
}

Break the highlighted text into meaningful word units, not character-by-character. Single characters that function as particles or grammatical markers should be separate units.

Use surrounding context to disambiguate meaning but do not translate the context itself.

Respond ONLY with JSON. No markdown, no backticks, no preamble.`;

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `API ${resp.status}`);
      }

      const result = await resp.json();
      const raw = result.content.map(b => b.text || '').join('');
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      await saveToCache(text, context, parsed);
      showPhrasePopup(rect, parsed, false, text);

      // Wrap the newly-translated phrase wherever it appears in the source element
      if (anchor && anchor.isConnected) scanDeep(anchor);
    } catch (err) {
      showError(err.message);
    }
  }

  async function saveToCache(phrase, context, parsed) {
    const stored = await chrome.storage.local.get(['word_cache', 'phrase_cache']);
    const wc = stored.word_cache || {};
    const pc = stored.phrase_cache || {};

    pc[phrase] = {
      phraseTranslation: parsed.phraseTranslation,
      words: parsed.words || [],
      context,
      timestamp: Date.now()
    };

    for (const w of (parsed.words || [])) {
      if (w && w.chinese && CJK.test(w.chinese)) {
        wc[w.chinese] = {
          chinese: w.chinese,
          pinyin: w.pinyin,
          translation: w.translation,
          gapSeverity: typeof w.gapSeverity === 'number' ? w.gapSeverity : 0,
          gapExplanation: w.gapExplanation || null,
          context: phrase,
          timestamp: Date.now()
        };
      }
    }

    await chrome.storage.local.set({ word_cache: wc, phrase_cache: pc });
    wordCache = wc;
    phraseCache = pc;
    rebuildRegex();
    scannedNodes = new WeakSet();
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
