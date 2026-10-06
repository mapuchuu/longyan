let currentTab = 'phrases';
const list = document.getElementById('list');
const headerCount = document.getElementById('headerCount');

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    render();
  });
});

// Cache writes go through the service worker (background.js); re-render after each.
function sendToWorker(message) {
  chrome.runtime.sendMessage(message, (resp) => {
    if (!resp || !resp.ok) console.warn('Longyan: cache update failed', resp && resp.error);
    render();
  });
}

function esc(s) {
  const d = document.createElement('span');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function render() {
  chrome.storage.local.get(['word_cache', 'phrase_cache'], (d) => {
    const wordCache = d.word_cache || {};
    const phraseCache = d.phrase_cache || {};

    list.innerHTML = '';

    const entries = currentTab === 'phrases'
      ? Object.entries(phraseCache)
      : Object.entries(wordCache);

    headerCount.textContent = `${entries.length} ${currentTab}`;

    if (entries.length === 0) {
      list.innerHTML = `<div class="empty">No ${currentTab} cached yet</div>`;
      return;
    }

    entries.sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));

    entries.forEach(([key, val]) => {
      const div = document.createElement('div');
      div.className = 'entry';

      if (currentTab === 'phrases') {
        const wordRowsHTML = (val.words || []).map((w, wi) => `
          <div class="word-row" data-wi="${wi}">
            <span class="word-hanzi">${esc(w.hanzi || '')}</span>
            <span class="word-pinyin">${esc(w.pinyin || '')}</span>
            <span class="word-gloss">${esc(w.meaning || '')}</span>
            <button class="word-del-btn" data-wi="${wi}" title="Delete word">×</button>
          </div>`).join('');

        div.innerHTML = `
          <div class="entry-top">
            <div class="entry-main">
              <div class="entry-headline">
                <span class="entry-hanzi">${esc(key)}</span>
                <span class="entry-tr">${esc(val.full_translation || '')}</span>
              </div>
              ${wordRowsHTML ? `<div class="word-rows">${wordRowsHTML}</div>` : ''}
            </div>
            <button class="del-btn" title="Delete">×</button>
          </div>`;

        div.querySelector('.del-btn').addEventListener('click', () => {
          sendToWorker({ type: 'deletePhrase', key });
        });

        div.querySelectorAll('.word-del-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            sendToWorker({ type: 'removeWordFromPhrase', key, index: parseInt(btn.dataset.wi) });
          });
        });

      } else {
        div.innerHTML = `
          <div class="entry-top">
            <div class="entry-main">
              <div class="entry-headline">
                <span class="entry-hanzi">${esc(key)}</span>
                <span class="word-pinyin">${esc(val.pinyin || '')}</span>
                <span class="word-gloss">${esc(val.meaning || '')}</span>
              </div>
            </div>
            <button class="del-btn" title="Delete">×</button>
          </div>`;

        div.querySelector('.del-btn').addEventListener('click', () => {
          sendToWorker({ type: 'deleteWord', key, alsoPhrase: false });
        });
      }

      list.appendChild(div);
    });
  });
}

function exportCSV() {
  chrome.storage.local.get(['word_cache', 'phrase_cache'], (d) => {
    const wordCache = d.word_cache || {};
    const phraseCache = d.phrase_cache || {};

    const rows = [['Type', 'Hanzi', 'Pinyin', 'Translation']];

    Object.entries(phraseCache).forEach(([key, val]) => {
      rows.push(['phrase', key, '', val.full_translation || '']);
      (val.words || []).forEach(w => {
        rows.push(['word', w.hanzi || '', w.pinyin || '', w.meaning || '']);
      });
    });

    Object.entries(wordCache).forEach(([key, val]) => {
      rows.push(['word', key, val.pinyin || '', val.meaning || '']);
    });

    const csv = rows.map(r =>
      r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'longyan_cache.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
}

document.getElementById('exportBtn').addEventListener('click', exportCSV);

render();
