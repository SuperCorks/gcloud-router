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
  const { slackHandoff: setting } = await chrome.storage.sync.get('slackHandoff');
  slackHandoff = setting !== false;
  console.log('Router: cached rules', cachedRules.length, 'slack handoff', slackHandoff);
}

// --- Slack links -> Slack app, through ProfileRouter's native messaging host ---
// ProfileRouter (github.com/SuperCorks/profile-router) knows each Slack workspace's team ID, which
// `slack://` links need. Its host opens the app and replies { handled: true } when it could.
const NATIVE_HOST = 'com.supercorks.profilerouter';
const HANDOFF_DEDUPE_MS = 3000;
const LEAVE_AFTER_COMMIT_MS = 15000;
const SKIP = 'skip';
let slackHandoff = true; // chrome.storage.sync `slackHandoff`; on unless turned off in options
const recentHandoffs = new Map(); // tabId -> time a link in it went to Slack (skips redirect hops)
const slackNavs = new Map(); // tabId -> { fresh, committed, leaveBy } for a Slack link in flight
const newTabs = new Set(); // tabs that haven't committed a page yet

function isSlackURL(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === 'https:' || protocol === 'http:') && /(^|\.)slack\.com$/i.test(hostname);
  } catch {
    return false;
  }
}

// A tab showing nothing yet or only the new-tab page.
function isFreshTab(tab) {
  const url = tab?.url || '';
  return !url || url === 'about:blank' || /^chrome:\/\/(newtab|new-tab-page)\b/.test(url);
}

function askProfileRouter(url) {
  return new Promise(resolve => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { url }, resp => {
      if (chrome.runtime.lastError) {
        console.warn('[GCloudRouter] ProfileRouter host unavailable:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(resp);
      }
    });
  });
}

function closeTab(tabId) {
  return chrome.tabs.remove(tabId).catch(e => console.warn('Closing Slack tab failed', e));
}

// Back to the page the Slack link was clicked on, or close the tab when there's no history.
function leaveSlackPage(tabId) {
  return chrome.tabs.goBack(tabId).catch(() => closeTab(tabId));
}

function forgetSlackNav(tabId, nav) {
  if (slackNavs.get(tabId) === nav) slackNavs.delete(tabId);
}

// Runs synchronously in onBeforeNavigate, before any await, so a fast commit isn't missed.
// Returns the tracked navigation, SKIP for a redirect hop of a link already sent to Slack, or null.
function trackSlackNav(details) {
  const { tabId, url } = details;
  if (tabId < 0 || details.documentLifecycle === 'prerender' || !isSlackURL(url)) return null;
  const last = recentHandoffs.get(tabId);
  if ((last && Date.now() - last < HANDOFF_DEDUPE_MS) || slackNavs.get(tabId)?.leaveBy) return SKIP;
  const nav = { fresh: newTabs.has(tabId), committed: false, leaveBy: 0 };
  slackNavs.set(tabId, nav);
  return nav;
}

// Returns true when the link went to the Slack app, so the tab shouldn't be touched further.
async function tryHandoff(details, nav) {
  const { tabId, url } = details;
  if (!slackHandoff) {
    forgetSlackNav(tabId, nav);
    return false;
  }
  const before = await chrome.tabs.get(tabId).catch(() => null);
  const resp = await askProfileRouter(url);
  if (!resp?.handled) {
    forgetSlackNav(tabId, nav);
    if (resp?.error) console.warn('[GCloudRouter] ProfileRouter could not open', url, resp.error);
    return false;
  }
  recentHandoffs.set(tabId, Date.now());
  console.log('[GCloudRouter] Opened in', resp.app, { url, appURL: resp.appURL });
  if (nav.fresh || isFreshTab(before)) {
    forgetSlackNav(tabId, nav);
    await closeTab(tabId);
  } else if (nav.committed) {
    forgetSlackNav(tabId, nav);
    await leaveSlackPage(tabId);
  } else {
    // Going back before the Slack page commits would skip past the page the link was on.
    nav.leaveBy = Date.now() + LEAVE_AFTER_COMMIT_MS;
  }
  return true;
}

chrome.tabs.onCreated.addListener(tab => newTabs.add(tab.id));

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  const { tabId } = details;
  newTabs.delete(tabId);
  const nav = slackNavs.get(tabId);
  if (!nav) return;
  if (!isSlackURL(details.url)) {
    slackNavs.delete(tabId); // something else replaced the Slack page
    return;
  }
  nav.committed = true;
  if (nav.leaveBy) {
    slackNavs.delete(tabId);
    if (Date.now() < nav.leaveBy) leaveSlackPage(tabId);
  }
});

chrome.webNavigation.onErrorOccurred.addListener(details => {
  if (details.frameId === 0 && isSlackURL(details.url)) slackNavs.delete(details.tabId);
});

chrome.tabs.onRemoved.addListener(tabId => {
  newTabs.delete(tabId);
  slackNavs.delete(tabId);
  recentHandoffs.delete(tabId);
});

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
  if (area === 'sync' && (changes.rules || changes.slackHandoff)) refreshCache();
});

// Listen for committed navigation then decide redirect early if possible
chrome.webNavigation.onBeforeNavigate.addListener(async details => {
  if (details.frameId !== 0) return; // only main frame
  const slackNav = trackSlackNav(details);
  await ensureRulesLoaded();
  if (slackNav === SKIP) return;
  if (slackNav && await tryHandoff(details, slackNav)) return;
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
