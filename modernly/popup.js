const keyInput = document.getElementById('apiKey');
const saveBtn = document.getElementById('saveBtn');
const status = document.getElementById('status');
const activeToggle = document.getElementById('activeToggle');

chrome.storage.local.get(['anthropic_key', 'ext_active', 'popup_size'], (data) => {
  if (data.anthropic_key) {
    keyInput.value = data.anthropic_key;
    status.textContent = 'Key saved ✓';
    status.className = 'status success';
  }
  if (data.ext_active === false) activeToggle.checked = false;
  const size = data.popup_size || 'm';
  document.querySelectorAll('.size-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === size);
  });
});

saveBtn.addEventListener('click', () => {
  const key = keyInput.value.trim();
  if (!key) {
    status.textContent = 'Enter a key first';
    status.className = 'status info';
    return;
  }
  chrome.storage.local.set({ anthropic_key: key }, () => {
    status.textContent = 'Key saved ✓';
    status.className = 'status success';
  });
});

activeToggle.addEventListener('change', () => {
  chrome.storage.local.set({ ext_active: activeToggle.checked });
});

document.querySelectorAll('.size-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chrome.storage.local.set({ popup_size: btn.dataset.size });
  });
});

// Cache stats
const wordCountEl = document.getElementById('wordCount');
const phraseCountEl = document.getElementById('phraseCount');
const clearBtn = document.getElementById('clearBtn');

function refreshStats() {
  chrome.storage.local.get(['word_cache', 'phrase_cache'], (d) => {
    wordCountEl.textContent = Object.keys(d.word_cache || {}).length;
    phraseCountEl.textContent = Object.keys(d.phrase_cache || {}).length;
  });
}
refreshStats();

clearBtn.addEventListener('click', () => {
  if (confirm('Clear all cached words and phrases? This cannot be undone.')) {
    chrome.storage.local.set({ word_cache: {}, phrase_cache: {} }, refreshStats);
  }
});

// Open cache viewer as a separate popup to the left
document.getElementById('viewCacheBtn').addEventListener('click', () => {
  const cacheWidth = 680;
  const cacheHeight = 620;
  chrome.windows.getCurrent({}, (win) => {
    const left = Math.max(0, win.left - cacheWidth - 8);
    const top = win.top;
    chrome.windows.create({
      url: chrome.runtime.getURL('cache.html'),
      type: 'popup',
      width: cacheWidth,
      height: cacheHeight,
      left: left,
      top: top
    });
  });
});
