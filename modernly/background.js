// Service worker: owns the API key, the Anthropic call, and every write to
// word_cache / phrase_cache. Pages and extension views send messages; writes
// run one at a time so two tabs can never overwrite each other's changes.

const CJK = /[一-鿿㐀-䶿]/;
const CONNECTOR_CHARS = new Set(['的','了','和','是','在','也','都','就','与','或','但','而','对','于','把','被','让','给','从','到','着','过','吗','呢','吧','啊','嗯','呀']);

const SYSTEM_PROMPT = `For each word, analyze whether the English translation loses meaningful nuance from the Chinese. Set tag to 'lost_in_translation' if the English word cannot carry the full meaning or register of the Chinese (e.g. 掠夺 → 'plunder' loses the implied organized violence). (e.g. 有识之士 The gap you actually want to show is that 有识之士 implies moral obligation, not just intelligence. A "visionary intellectual" in English is a compliment. 有识之士 is almost a calling — if you see clearly, you are duty-bound to speak.)Set tag to 'cultural_context' if understanding the word requires knowledge specific to Chinese history, politics, or culture (e.g. 农民起义 is a Marxist historiographic category, not a neutral descriptor). Set tag to null for everything else. Do not over-tag — most words should be null. When tag is non-null, write the note field as two parts: (1) a one-line dictionary definition of the word in plain English; (2) a 1 sentence scenario or feeling that shows what a native speaker actually experiences when they use this word — written in plain English, present tense, first or second person. If the word carries a physical or emotional sensation, lead with that, in a way that captures the semantic gap. Write like you're a knowledgeable friend whispering context, not a historian citing sources. Max 2 sentences. No words like 'historiographic,' 'invokes,' or 'refers to.' Don't explain what the word does — explain what it means to someone who grew up with it." The goal is something like: "This isn't just 'isolationism' — it's a word Chinese people use when they're still a little embarrassed about what that era cost them." That's the register you want.No em-dashes. Absolutely No meta-commentary about translation, language, or cultural gaps. Pinyin must always be returned with exactly one space between each syllable. Every syllable is one consonant cluster plus one vowel (with tone mark). Never concatenate syllables. Never omit spaces. Example: 铜钱 must be tóng qián not tóngqián. Example: 方孔 must be fāng kǒng not fāngkǒng. The number of space-separated syllables must exactly equal the number of characters in the hanzi string.`;

function buildPrompt(text, context) {
  return `You are translating Chinese text in context.

Highlighted text: ${text}
Surrounding context for comprehension: ${context.before}【${text}】${context.after}

Return JSON:
{
  "full_translation": "English translation of ONLY the highlighted text, not the surrounding context",
  "words": [
    {
      "hanzi": "word or phrase unit",
      "pinyin": "tone-marked pinyin",
      "tones": [4, 2],
      "meaning": "direct English equivalent",
      "tag": "lost_in_translation",
      "note": "dictionary definition + native-speaker scenario, non-null only when tag is non-null"
    }
  ]
}

tones is an array of integers (1–5), one per syllable, matching the syllable count of pinyin. Tone 5 means neutral/unstressed.

Break the highlighted text into meaningful word units, not character-by-character. Single characters that function as particles or grammatical markers should be separate units.

Use surrounding context to disambiguate meaning but do not translate the context itself.

Respond ONLY with JSON. No markdown, no backticks, no preamble.`;
}

// ---------- Serialized cache writes ----------
let writeChain = Promise.resolve();

// Runs mutate(wordCache, phraseCache) against fresh storage and writes the
// result back. Mutations queue behind each other, so none reads stale data.
function updateCaches(mutate) {
  const run = writeChain.then(async () => {
    const d = await chrome.storage.local.get(['word_cache', 'phrase_cache']);
    const wc = d.word_cache || {};
    const pc = d.phrase_cache || {};
    mutate(wc, pc);
    await chrome.storage.local.set({ word_cache: wc, phrase_cache: pc });
    return { wordCache: wc, phraseCache: pc };
  });
  writeChain = run.catch(() => {});
  return run;
}

function isWordInAnyPhrase(pc, word) {
  return Object.values(pc).some(p =>
    p && p.words && p.words.some(w => w && w.hanzi === word)
  );
}

// Drop each word that no remaining phrase still uses.
function dropOrphanWords(wc, pc, words) {
  for (const w of words) {
    if (!isWordInAnyPhrase(pc, w)) delete wc[w];
  }
}

// ---------- Cache operations ----------
const ops = {
  // Translate first; only a successful result touches the cache. The
  // overlapping entries are replaced and the new phrase saved in one write.
  async translate({ text, context, overlap }) {
    const parsed = await callClaude(text, context);
    return updateCaches((wc, pc) => {
      const phraseKeys = (overlap && overlap.phraseKeys) || [];
      const wordKeys = new Set((overlap && overlap.wordKeys) || []);
      for (const k of phraseKeys) {
        const ph = pc[k];
        delete pc[k];
        if (ph && ph.words) ph.words.forEach(w => w && w.hanzi && wordKeys.add(w.hanzi));
      }
      dropOrphanWords(wc, pc, wordKeys);

      const now = Date.now();
      pc[text] = {
        full_translation: parsed.full_translation,
        words: parsed.words || [],
        context,
        timestamp: now
      };
      for (const w of (parsed.words || [])) {
        if (w && w.hanzi && CJK.test(w.hanzi) && !CONNECTOR_CHARS.has(w.hanzi)) {
          wc[w.hanzi] = {
            hanzi: w.hanzi,
            pinyin: w.pinyin || '',
            tones: w.tones || [],
            meaning: w.meaning || '',
            tag: w.tag || null,
            note: w.note || null,
            context: text,
            timestamp: now
          };
        }
      }
    }).then(caches => ({ parsed, ...caches }));
  },

  deletePhrase({ key }) {
    return updateCaches((wc, pc) => {
      const ph = pc[key];
      delete pc[key];
      if (ph && ph.words) dropOrphanWords(wc, pc, ph.words.filter(w => w && w.hanzi).map(w => w.hanzi));
    });
  },

  // alsoPhrase: the on-page popup also removes a phrase cached under the same text.
  deleteWord({ key, alsoPhrase }) {
    return updateCaches((wc, pc) => {
      delete wc[key];
      if (alsoPhrase) delete pc[key];
    });
  },

  removeWordFromPhrase({ key, index }) {
    return updateCaches((wc, pc) => {
      const ph = pc[key];
      if (!ph) return;
      const words = ph.words || [];
      const removed = words[index];
      ph.words = words.filter((_, i) => i !== index);
      if (removed && removed.hanzi) dropOrphanWords(wc, pc, [removed.hanzi]);
    });
  },

  clearAll() {
    return updateCaches((wc, pc) => {
      for (const k of Object.keys(wc)) delete wc[k];
      for (const k of Object.keys(pc)) delete pc[k];
    });
  }
};

// ---------- API ----------
async function callClaude(text, context) {
  const { anthropic_key: key } = await chrome.storage.local.get(['anthropic_key']);
  if (!key) throw new Error('No API key set. Click the extension icon to add your Anthropic key.');

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
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildPrompt(text, context) }]
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `API ${resp.status}`);
  }

  const result = await resp.json();
  const raw = result.content.map(b => b.text || '').join('');
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ---------- Messaging ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const op = msg && ops[msg.type];
  if (!op) return false;
  Promise.resolve()
    .then(() => op(msg))
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
  return true; // keep the channel open for the async response
});
