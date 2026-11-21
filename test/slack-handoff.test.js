// Event-ordering tests for the Slack handoff, with a fake `chrome` and a controllable host.
// Run with `npm test` (node --test, no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlackHandoff, isSlackURL, NATIVE_HOST } from '../src/slack-handoff.js';

const PERMALINK = 'https://acme.slack.com/archives/C024BE91L/p1700000000123456';

function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), fire: (...a) => listeners.forEach(fn => fn(...a)) };
}

function setup({ enabled = true, tabs = {}, ready = async () => {}, now } = {}) {
  const calls = { host: [], removed: [], back: [] };
  const replies = [];
  const chrome = {
    runtime: {
      lastError: null,
      sendNativeMessage(name, msg, cb) {
        assert.equal(name, NATIVE_HOST);
        calls.host.push(msg);
        replies.push(cb);
      },
    },
    tabs: {
      get: async id => tabs[id] ?? Promise.reject(new Error('no tab')),
      remove: async id => { calls.removed.push(id); },
      goBack: async id => { calls.back.push(id); },
      onCreated: event(),
      onRemoved: event(),
    },
    webNavigation: { onCommitted: event(), onErrorOccurred: event() },
  };
  const slack = createSlackHandoff({ chrome, isEnabled: () => enabled, ready, ...(now ? { now } : {}) });
  slack.register();
  const settle = () => new Promise(r => setTimeout(r, 0));
  return {
    slack, chrome, calls, settle,
    nav: (tabId, url) => slack.onBeforeNavigate({ tabId, url, frameId: 0 }),
    commit: (tabId, url, extra = {}) => chrome.webNavigation.onCommitted.fire({ tabId, url, frameId: 0, ...extra }),
    reply: async resp => { await settle(); replies.shift()(resp); await settle(); },
  };
}

const HANDLED = { handled: true, app: 'Slack', appURL: 'slack://channel?team=T1&id=C024BE91L' };

test('recognizes Slack links, including wrapped ones', () => {
  assert.ok(isSlackURL(PERMALINK));
  assert.ok(isSlackURL('https://app.slack.com/client/T1/C1'));
  assert.ok(isSlackURL('https://www.google.com/url?q=' + encodeURIComponent(PERMALINK)));
  assert.ok(isSlackURL('https://nam12.safelinks.protection.outlook.com/?url=' + encodeURIComponent(PERMALINK)));
  assert.ok(!isSlackURL('https://notslack.com/x'));
  assert.ok(!isSlackURL('https://www.google.com/url?q=https://github.com'));
  assert.ok(!isSlackURL('slack://channel?team=T1'));
  // A non-empty `q` wins and an empty one falls back to `url`, as in ProfileRouter's unwrapper.
  assert.ok(!isSlackURL('https://www.google.com/url?q=https://github.com&url=' + encodeURIComponent(PERMALINK)));
  assert.ok(isSlackURL('https://www.google.com/url?sa=t&q=&esrc=s&url=' + encodeURIComponent(PERMALINK)));
});

test('a tab opened for the link closes', async () => {
  const t = setup({ tabs: { 5: { id: 5, url: PERMALINK } } }); // Chrome reports the pending URL
  t.chrome.tabs.onCreated.fire({ id: 5 });
  const done = t.nav(5, PERMALINK);
  await t.reply(HANDLED);
  assert.equal(await done, true);
  assert.deepEqual(t.calls.removed, [5]);
  assert.deepEqual(t.calls.back, []);
});

test('in an existing tab, goes back once the Slack page commits after the reply', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const done = t.nav(7, PERMALINK);
  await t.reply(HANDLED);
  assert.equal(await done, true);
  assert.deepEqual(t.calls.back, []); // going back now would skip past the Linear page
  t.commit(7, PERMALINK);
  assert.deepEqual(t.calls.back, [7]);
  assert.equal(t.slack.records.size, 0);
});

test('in an existing tab, goes back right away when the Slack page already committed', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const done = t.nav(7, PERMALINK);
  await t.settle();
  t.commit(7, PERMALINK);
  await t.reply(HANDLED);
  assert.equal(await done, true);
  assert.deepEqual(t.calls.back, [7]);
});

test('a late reply does nothing once the tab moved on', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const done = t.nav(7, PERMALINK);
  await t.settle();
  t.commit(7, PERMALINK);
  assert.equal(await t.slack.onBeforeNavigate({ tabId: 7, url: 'https://github.com/', frameId: 0 }), false);
  await t.reply(HANDLED);
  assert.equal(await done, true);
  assert.deepEqual(t.calls.back, []);
  assert.deepEqual(t.calls.removed, []);
});

test('a late reply leaves a fresh tab alone once it navigated elsewhere', async () => {
  const t = setup({ tabs: { 5: { id: 5, url: '' } } });
  t.chrome.tabs.onCreated.fire({ id: 5 });
  const done = t.nav(5, PERMALINK);
  await t.settle();
  await t.slack.onBeforeNavigate({ tabId: 5, url: 'https://github.com/', frameId: 0 });
  await t.reply(HANDLED);
  assert.equal(await done, true);
  assert.deepEqual(t.calls.removed, []);
});

test('a second Slack navigation during a handoff asks once and leaves after the latest commit', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const first = t.nav(7, PERMALINK);
  await t.reply(HANDLED);
  assert.equal(await first, true);
  // Double click: the first navigation is aborted and a second one starts.
  t.chrome.webNavigation.onErrorOccurred.fire({ tabId: 7, frameId: 0, url: PERMALINK, error: 'net::ERR_ABORTED' });
  assert.equal(await t.nav(7, PERMALINK), true);
  assert.equal(t.calls.host.length, 1);
  t.commit(7, PERMALINK);
  assert.deepEqual(t.calls.back, [7]);
});

test('after leaving, the next Slack click is a new handoff', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const first = t.nav(7, PERMALINK);
  await t.reply(HANDLED);
  await first;
  t.commit(7, PERMALINK);
  const second = t.nav(7, 'https://acme.slack.com/archives/C999');
  await t.reply(HANDLED);
  assert.equal(await second, true);
  assert.equal(t.calls.host.length, 2);
});

test('links the host does not handle load normally', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const done = t.nav(7, 'https://slack.com/pricing');
  await t.reply({ handled: false });
  assert.equal(await done, false);
  assert.equal(t.slack.records.size, 0);
  assert.deepEqual([...t.calls.back, ...t.calls.removed], []);
});

test('a missing host loads normally', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const done = t.nav(7, PERMALINK);
  await t.settle();
  t.chrome.runtime.lastError = { message: 'Specified native messaging host not found.' };
  await t.reply(undefined);
  assert.equal(await done, false);
});

test('turned off: never asks the host', async () => {
  const t = setup({ enabled: false, tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  assert.equal(await t.nav(7, PERMALINK), false);
  assert.equal(t.calls.host.length, 0);
});

test("Slack's web client stays in Chrome", async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://app.slack.com/client/T1/C1' } } });
  assert.equal(await t.nav(7, 'https://app.slack.com/client/T1/C1'), false);
  assert.equal(t.calls.host.length, 0);
});

test('prerenders and subframes are ignored', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  assert.equal(await t.slack.onBeforeNavigate({ tabId: 7, url: PERMALINK, frameId: 0, documentLifecycle: 'prerender' }), false);
  assert.equal(await t.slack.onBeforeNavigate({ tabId: 7, url: PERMALINK, frameId: 3 }), false);
  assert.equal(t.calls.host.length, 0);
});

test('tells the host when the tab is private', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1', incognito: true } } });
  const done = t.nav(7, PERMALINK);
  await t.reply({ handled: false });
  await done;
  assert.deepEqual(t.calls.host, [{ url: PERMALINK, incognito: true }]);
});

test('a stuck handoff expires', async () => {
  let clock = 0;
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const slack = createSlackHandoff({ chrome: t.chrome, isEnabled: () => true, ready: async () => {}, now: () => clock });
  const first = slack.onBeforeNavigate({ tabId: 7, url: PERMALINK, frameId: 0 });
  await t.reply(HANDLED);
  await first; // leaving, but the Slack page never commits
  clock += 60000;
  const second = slack.onBeforeNavigate({ tabId: 7, url: PERMALINK, frameId: 0 });
  await t.reply(HANDLED);
  assert.equal(await second, true);
  assert.equal(t.calls.host.length, 2);
});

test('a navigation away while settings load never reaches the host', async () => {
  let release;
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } }, ready: () => new Promise(r => { release = r; }) });
  const done = t.nav(7, PERMALINK);
  assert.equal(await t.slack.onBeforeNavigate({ tabId: 7, url: 'https://github.com/', frameId: 0 }), false);
  release();
  assert.equal(await done, true); // superseded: no handoff, and no redirect rules on the old URL
  assert.equal(t.calls.host.length, 0);
});

test('a reload of a Slack page stays in Chrome, even when it commits before the tab lookup', async () => {
  let release;
  const t = setup({ tabs: { 7: { id: 7, url: 'https://app.slack.com/client/T1/C1' } }, ready: () => new Promise(r => { release = r; }) });
  const done = t.nav(7, 'https://app.slack.com/client/T1/C1');
  t.commit(7, 'https://app.slack.com/client/T1/C1', { transitionType: 'reload' });
  release();
  await done;
  assert.equal(t.calls.host.length, 0);
  assert.deepEqual([...t.calls.back, ...t.calls.removed], []);
});

test('going back to a Slack page stays in Chrome', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const done = t.nav(7, PERMALINK);
  t.commit(7, PERMALINK, { transitionType: 'link', transitionQualifiers: ['forward_back'] });
  assert.equal(await done, true);
  assert.equal(t.calls.host.length, 0);
});

test('a different Slack link while one is leaving gets its own decision', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const first = t.nav(7, PERMALINK);
  await t.reply(HANDLED);
  await first; // leaving, waiting for the commit
  t.chrome.webNavigation.onErrorOccurred.fire({ tabId: 7, frameId: 0, url: PERMALINK, error: 'net::ERR_ABORTED' });
  const second = t.nav(7, 'https://slack.com/pricing');
  await t.reply({ handled: false });
  assert.equal(await second, false);
  assert.equal(t.calls.host.length, 2);
  t.commit(7, 'https://slack.com/pricing');
  assert.deepEqual(t.calls.back, []); // the pricing page stays
});

test('a redirect hop from the committed Slack page joins the handoff', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const done = t.nav(7, PERMALINK);
  await t.settle();
  t.commit(7, PERMALINK);
  assert.equal(await t.nav(7, 'https://app.slack.com/client/T1/C024BE91L'), true);
  await t.reply(HANDLED);
  await done;
  assert.equal(t.calls.host.length, 1);
  t.commit(7, 'https://app.slack.com/client/T1/C024BE91L');
  assert.deepEqual(t.calls.back, [7]);
});

test('a reply after the record expired does nothing', async () => {
  let clock = 0;
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } }, now: () => clock });
  const done = t.nav(7, PERMALINK);
  await t.settle();
  t.commit(7, PERMALINK);
  clock += 60000;
  await t.reply(HANDLED);
  assert.equal(await done, true);
  assert.deepEqual(t.calls.back, []);
});

test('a redirect well after the Slack page committed is a new navigation', async () => {
  let clock = 0;
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } }, now: () => clock });
  const done = t.nav(7, PERMALINK);
  await t.settle();
  clock = 2500; // Slack took a while to commit; the window counts from the commit
  t.commit(7, PERMALINK);
  clock = 2600;
  assert.equal(await t.nav(7, 'https://app.slack.com/client/T1/C024BE91L'), true); // joined
  clock = 6000;
  t.commit(7, 'https://app.slack.com/client/T1/C024BE91L');
  await t.reply(HANDLED);
  await done;
  assert.equal(t.calls.host.length, 1);
  assert.deepEqual(t.calls.back, [7]);
});

test('Back onto a Slack page after the host was asked keeps the tab', async () => {
  const t = setup({ tabs: { 7: { id: 7, url: 'https://linear.app/issue/1' } } });
  const done = t.nav(7, PERMALINK);
  await t.settle(); // the host is already asked; Chrome can only tell us at commit
  t.commit(7, PERMALINK, { transitionType: 'link', transitionQualifiers: ['forward_back'] });
  await t.reply(HANDLED);
  assert.equal(await done, true);
  assert.deepEqual([...t.calls.back, ...t.calls.removed], []);
});

