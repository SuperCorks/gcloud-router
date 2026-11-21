# GCloud Router Chrome Extension

Redirect browser navigations that match user-defined sets of regex patterns (ALL must match) to alternate destinations. Useful for internal environment routing (e.g., prod -> staging), vanity URL rewrites, etc. It can also open Slack links in the Slack app instead of on slack.com.

## Features
- Multiple regex patterns per rule (logical AND)
- Pattern negation via leading ! (e.g. !authUser= prohibits matches containing authUser=)
- Regex-based matching of main-frame navigation URLs
- Redirect to specified absolute URLs (with simple `$1` replacements from last pattern)
- Enable/disable individual rules
- Persist rules with `chrome.storage.sync`
- Lightweight service-worker evaluation (no DNR dependency)
- Slack links open in the Slack app, through [ProfileRouter](https://github.com/SuperCorks/profile-router) (on by default; toggle in Options)

## How It Works
Rules you define are stored and evaluated in the background service worker on `webNavigation.onBeforeNavigate`. If every regex in a rule matches the pending navigation URL, the first matching rule triggers a `tabs.update` redirect.

## Slack links in the Slack app
`slack://` links need the workspace's team ID, which only the Slack app knows. [ProfileRouter](https://github.com/SuperCorks/profile-router) already reads it, so the extension asks ProfileRouter through Chrome native messaging (host `com.supercorks.profilerouter`) before a `slack.com` link loads:
- ProfileRouter opens the link in Slack and replies `{ "handled": true }`. A tab opened for the link closes. When the link was clicked in an existing tab, the tab goes back to the page it was on.
- Links ProfileRouter can't convert (slack.com pages, workspaces the app isn't signed in to) load normally, then the regex rules run as usual.
- Without ProfileRouter, every link loads normally. The Options page shows whether the host is reachable.

Setup: run `scripts/install.sh` in profile-router. It installs the host and allows this extension's ID (`jhjbhohojgallohcifkfjeojmakiecdl`, the ID Chrome gives the unpacked extension at `~/gcloud-router`). For a different ID, set `PROFILE_ROUTER_EXTENSION_IDS` when running it. Keep the extension unpacked from the same folder: the ID comes from its path, and the saved rules belong to that ID.

## Install (Development)
1. `git clone` this repo (or ensure files exist locally).
2. Open Chrome (or any Chromium-based browser supporting MV3).
3. Navigate to `chrome://extensions`.
4. Enable "Developer mode".
5. Click "Load unpacked" and select this project folder.
6. Open the Options page from the extension card to configure rules.

## Rule Syntax & Tips
- Patterns are plain JavaScript RegExp (service worker evaluation) and are matched case-insensitively by default (an `i` flag is added if you omit it). All patterns in a rule must match.
- Prefix a pattern with ! to require that regex NOT match the URL.
- Captures from ONLY the last positive (non-negated) pattern are substituted into the destination as `$1`, `$2`, etc.
- Anchor with `^` to avoid overmatching when appropriate.
- Only main-frame (top-level) navigations are intercepted.

Example:
Pattern: `^https://example\\.com/app/(.*)`
Destination: `https://staging.example.com/app/$1`

## Development Notes
- Service worker logs appear in: chrome://extensions -> Inspect views (Service Worker).
- Background maintains an in-memory compiled regex cache refreshed on install/startup and whenever rules change.
- Destination substitution currently uses captures from the last regex only (simpler + predictable). Future enhancement could allow referencing pattern index.

## Roadmap / Ideas
- Export / import rules (JSON download & upload)
- Support test matching inside the options page
- Sync to local storage fallback if sync quota exceeded
- Icon assets automation
- Unit tests (e.g., with webextension-polyfill + jest)

## License
 MIT
