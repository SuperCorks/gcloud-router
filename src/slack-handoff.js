// slack-handoff.js - open Slack links in the Slack app through ProfileRouter's native messaging host.
//
// `slack://` links need the workspace's team ID, which only the Slack app knows. ProfileRouter
// (github.com/SuperCorks/profile-router) already reads it, so its host converts the link, opens the
// app, and replies { handled: true }. The tab the link was loading in then closes (a tab opened for
// the link) or goes back to the page the link was clicked on. Links the host can't convert load as
// usual.
//
// Each tab has at most one handoff record:
//   asking  - waiting for the host's reply
//   leaving - handed off; go back once the Slack page commits (going back earlier would skip past
//             the page the link was on)
// The record is dropped once the tab is left, a different page starts loading, the Slack page
// commits as a reload or a back/forward visit (Slack kept in Chrome on purpose), or it expires.
// The native host only ever opens Slack, and only for workspaces the Slack app is signed in to.

export const NATIVE_HOST = 'com.supercorks.profilerouter';
const RECORD_TTL_MS = 15000;
// A Slack page that already committed may redirect itself (for example to app.slack.com) right
// away. Such a hop joins the handoff instead of asking the host again.
const HOP_MS = 2000;

// Redirect wrappers whose target is in a query parameter, as ProfileRouter's URLUnwrapper knows them.
function wrappedTarget(u) {
  const host = u.hostname.toLowerCase();
  if ((host === 'google.com' || host.endsWith('.google.com')) && u.pathname === '/url') {
    return u.searchParams.get('q') || (u.searchParams.has('q') ? null : u.searchParams.get('url'));
  }
  if (host.endsWith('safelinks.protection.outlook.com') || host === 'slack-redir.net') {
    return u.searchParams.get('url');
  }
  return null;
}

export function isSlackURL(url, depth = 0) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (/(^|\.)slack\.com$/i.test(u.hostname)) return true;
  const target = depth < 3 ? wrappedTarget(u) : null;
  return !!target && isSlackURL(target, depth + 1);
}

// A tab showing nothing yet or only the new-tab page.
function isBlankURL(url) {
  return !url || url === 'about:blank' || /^chrome:\/\/(newtab|new-tab-page)\b/.test(url);
}

function isActiveMainFrame(details) {
  return details.frameId === 0 && details.tabId >= 0 && details.documentLifecycle !== 'prerender';
}

/**
 * @param {object} deps
 * @param {object} deps.chrome     the `chrome` extension API (injected for tests)
 * @param {() => boolean} deps.isEnabled   the `slackHandoff` setting
 * @param {() => Promise<void>} deps.ready resolves once settings are loaded
 * @param {() => number} [deps.now]
 */
export function createSlackHandoff({ chrome, isEnabled, ready, now = Date.now }) {
  const records = new Map(); // tabId -> { phase, url, fresh, committed, started, expires }
  const newTabs = new Set(); // tabs that haven't committed a real page yet

  function current(tabId) {
    const rec = records.get(tabId);
    if (rec && rec.expires < now()) {
      records.delete(tabId);
      return null;
    }
    return rec || null;
  }

  function askHost(url, incognito) {
    return new Promise(resolve => {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { url, incognito }, resp => {
        // Read lastError even when unused, or Chrome logs it as unchecked.
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
  function leave(tabId) {
    records.delete(tabId);
    return chrome.tabs.goBack(tabId).catch(() => closeTab(tabId));
  }

  /**
   * Call from webNavigation.onBeforeNavigate before anything else awaits, so a fast commit is
   * never missed. Resolves true when the navigation belongs to a handoff and must not be touched
   * further (no redirect rules), false otherwise.
   */
  async function onBeforeNavigate(details) {
    if (!isActiveMainFrame(details)) return false;
    const { tabId, url } = details;
    const rec = current(tabId);

    if (!isSlackURL(url)) {
      records.delete(tabId); // a different page replaces whatever was being handed off
      return false;
    }
    if (rec) {
      // The same link again (a double click), or the committed Slack page redirecting itself:
      // part of this handoff, so leave once this navigation commits. Any other Slack link gets its
      // own decision.
      const hop = rec.committed && now() - rec.started < HOP_MS;
      if (url === rec.url || hop) {
        rec.url = url;
        rec.committed = false;
        rec.expires = now() + RECORD_TTL_MS;
        return true;
      }
      records.delete(tabId);
    }

    const mine = { phase: 'asking', url, fresh: newTabs.has(tabId), committed: false, started: now(), expires: now() + RECORD_TTL_MS };
    records.set(tabId, mine);
    const [, tab] = await Promise.all([ready(), chrome.tabs.get(tabId).catch(() => null)]);
    // Expired, or replaced by another navigation: whatever happens next isn't this handoff's call.
    const stillMine = () => current(tabId) === mine;
    if (!stillMine()) return true;

    // Slack's own web client (navigating within it) stays in Chrome.
    const onSlackAlready = !mine.fresh && !mine.committed && isSlackURL(tab?.url);
    if (!isEnabled() || !tab || onSlackAlready) {
      records.delete(tabId);
      return false;
    }

    const resp = await askHost(url, !!tab.incognito);
    if (!stillMine()) return true;
    // Private windows: never put their URLs in the extension's console either.
    const shown = tab.incognito ? '(private window)' : url;
    if (!resp?.handled) {
      records.delete(tabId);
      if (resp?.error) console.warn('[GCloudRouter] ProfileRouter could not open', shown, resp.error);
      return false;
    }

    console.log('[GCloudRouter] Opened in', resp.app, tab.incognito ? shown : { url, appURL: resp.appURL });
    if (mine.fresh || isBlankURL(tab.url)) {
      records.delete(tabId);
      await closeTab(tabId);
    } else if (mine.committed) {
      await leave(tabId);
    } else {
      mine.phase = 'leaving';
    }
    return true;
  }

  function onCommitted(details) {
    if (!isActiveMainFrame(details)) return;
    const { tabId } = details;
    if (!isBlankURL(details.url)) newTabs.delete(tabId);
    const rec = current(tabId);
    if (!rec) return;
    if (details.transitionType === 'reload' || details.transitionQualifiers?.includes('forward_back')) {
      records.delete(tabId); // a Slack page you came back to or reloaded stays
      return;
    }
    rec.committed = true;
    if (rec.phase === 'leaving') leave(tabId);
  }

  function onErrorOccurred(details) {
    if (!isActiveMainFrame(details)) return;
    // ERR_ABORTED: superseded by a newer navigation, which onBeforeNavigate already handled.
    if (details.error !== 'net::ERR_ABORTED') records.delete(details.tabId);
  }

  function register() {
    chrome.tabs.onCreated.addListener(tab => newTabs.add(tab.id));
    chrome.tabs.onRemoved.addListener(tabId => {
      newTabs.delete(tabId);
      records.delete(tabId);
    });
    chrome.webNavigation.onCommitted.addListener(onCommitted);
    chrome.webNavigation.onErrorOccurred.addListener(onErrorOccurred);
  }

  return { onBeforeNavigate, onCommitted, onErrorOccurred, register, records, newTabs };
}
