// background.js - service worker implementing multi-pattern AND redirects
// Each rule: { enabled: bool, patterns: string[] (all must match), destination: string }

let cachedRules = [];
let loadingPromise = null; // track in-flight refresh to prevent duplicate loads

async function loadRules() {
  return new Promise(resolve => {
    chrome.storage.sync.get(['rules'], data => {
      const raw = Array.isArray(data.rules) ? data.rules : [];
      // Normalize legacy single-pattern rules: pattern -> patterns[pattern]
      const norm = raw.map(r => {
        if (!r) return null;
        if (r.pattern && !r.patterns) {
          r.patterns = [r.pattern];
          delete r.pattern;
        }
        r.patterns = (r.patterns || []).filter(p => typeof p === 'string' && p.trim());
        return r;
      }).filter(Boolean);
      resolve(norm);
    });
  });
}

function compileRule(rule) {
  if (rule.enabled === false) return null;
  if (!Array.isArray(rule.patterns) || !rule.patterns.length) return null;
  try {
    const regexes = rule.patterns.map(raw => {
      let negate = false;
      let pattern = raw;
      if (pattern.startsWith('!')) { // leading ! means logical NOT of the regex match
        negate = true;
        pattern = pattern.slice(1);
      }
      // Allow /pattern/flags style optionally
      let flags = '';
      const m = pattern.match(/^\/(.*)\/([a-z]*)$/);
      if (m) { pattern = m[1]; flags = m[2]; }
      // Force case-insensitive unless already specified
      if (!flags.includes('i')) flags += 'i';
      const rx = new RegExp(pattern, flags);
      return { rx, negate, raw };
    });
    return { regexes, destination: rule.destination, patterns: rule.patterns };
  } catch (e) {
    console.warn('Failed to compile rule', rule, e);
    return null;
  }
}

async function refreshCache() {
  const rules = await loadRules();
  cachedRules = rules.map(compileRule).filter(Boolean);
  console.log('Router: cached rules', cachedRules.length);
}

// Eagerly load rules every time the service worker spins up (cold start or after suspension)
loadingPromise = refreshCache().catch(e => console.warn('Initial rule load failed', e));

async function ensureRulesLoaded() {
  // If cache empty (e.g., very first event before async load completes or unexpected failure), wait for current or start new load
  if (cachedRules.length === 0) {
    if (!loadingPromise) loadingPromise = refreshCache().finally(() => { loadingPromise = null; });
    try { await loadingPromise; } catch { /* already logged */ }
  }
}

chrome.runtime.onInstalled.addListener(refreshCache);
chrome.runtime.onStartup?.addListener(refreshCache);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.rules) refreshCache();
});

// Listen for committed navigation then decide redirect early if possible
chrome.webNavigation.onBeforeNavigate.addListener(async details => {
  if (details.frameId !== 0) return; // only main frame
  await ensureRulesLoaded();
  const url = details.url;
  for (const rule of cachedRules) {
    // Compute individual results for debug (handle negation)
    const results = rule.regexes.map(obj => {
      const ok = obj.negate ? !obj.rx.test(url) : obj.rx.test(url);
      return { rx: obj.rx.source, negate: !!obj.negate, ok };
    });
    const all = results.every(r => r.ok);
    if (all) {
      // Choose last positive (non-negated) regex for capture expansion; fall back to any
      let captureRegex = null;
      for (let i = rule.regexes.length -1; i >=0; i--) {
        const obj = rule.regexes[i];
        if (!obj.negate) { captureRegex = obj.rx; break; }
      }
      if (!captureRegex) captureRegex = rule.regexes[rule.regexes.length -1].rx;
      let dest = rule.destination;
      const m = captureRegex.exec(url);
      if (m) {
        dest = dest.replace(/\$(\d+)/g, (_, g) => m[Number(g)] || '');
      }
      if (dest !== url) {
        try {
      console.log('[GCloudRouter] Redirect match', { url, dest, patterns: rule.patterns, results });
          await chrome.tabs.update(details.tabId, { url: dest });
          console.log('Redirected', url, '->', dest);
        } catch (e) {
          console.warn('Redirect failed', e);
        }
      }
      break;
    } else if (results.some(r => r.ok)) {
  // Partial match (some true but not all) - useful to debug unexpected behavior
  console.log('[GCloudRouter] Partial (NOT redirected) match state', { url, patterns: rule.patterns, results });
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'PING') {
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'SYNC_RULES') {
    refreshCache().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
