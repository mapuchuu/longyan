const keyInput = document.getElementById('apiKey');
const saveBtn = document.getElementById('saveBtn');
const status = document.getElementById('status');
const activeToggle = document.getElementById('activeToggle');

// Load saved values
chrome.storage.local.get(['anthropic_key', 'ext_active'], (data) => {
  if (data.anthropic_key) {
    keyInput.value = data.anthropic_key;
    status.textContent = 'Key saved ✓';
    status.className = 'status success';
  }
  if (data.ext_active === false) {
    activeToggle.checked = false;
  }
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
