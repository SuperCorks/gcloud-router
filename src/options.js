// options.js - manage multi-regex (AND) redirect rules

const tbody = document.getElementById('rulesBody');
const statusEl = document.getElementById('status');

function createRow(rule = { enabled: true, patterns: [''], destination: '' }) {
  if (!Array.isArray(rule.patterns) || !rule.patterns.length) rule.patterns = [''];
  const tr = document.createElement('tr');
  if (rule.enabled === false) tr.classList.add('disabled');
  tr.innerHTML = `
    <td><input type="checkbox" class="enabled" ${rule.enabled !== false ? 'checked' : ''}></td>
    <td class="patterns-cell">
      <div class="patterns-list"></div>
      <div class="pattern-input-row">
        <input type="text" class="pattern-input regex" placeholder="Add regex and press Enter" />
        <button class="add-pattern" type="button">Add</button>
      </div>
    </td>
    <td><input type="text" class="destination" placeholder="https://new.example.com/$1" value="${rule.destination || ''}"></td>
    <td class="row-actions">
      <button class="remove" type="button">Delete</button>
    </td>
  `;
  tbody.appendChild(tr);
  const listEl = tr.querySelector('.patterns-list');
  function renderPatterns() {
    listEl.innerHTML = '';
    rule.patterns.forEach((p, idx) => {
      const chip = document.createElement('span');
      chip.className = 'pattern-chip';
      chip.textContent = p;
      chip.setAttribute('draggable','true');
      chip.dataset.index = idx;
      // store the original pattern explicitly (safer than relying on textContent)
      chip.dataset.pattern = p;
      const del = document.createElement('button');
      del.textContent = '\u00d7';
      del.title = 'Remove pattern';
      del.className = 'chip-del';
      del.addEventListener('click', e => { e.stopPropagation(); rule.patterns.splice(idx,1); renderPatterns(); });
      // Prevent double-click on the delete button from bubbling to the chip (which would copy)
      del.addEventListener('dblclick', e => e.stopPropagation());
      chip.appendChild(del);
      // Double-click the chip to copy its pattern to clipboard
      chip.addEventListener('dblclick', async e => {
        e.stopPropagation();
        // don't copy if the dblclick originated on the delete button
        if (e.target && e.target.classList && e.target.classList.contains('chip-del')) return;
        const text = chip.dataset.pattern || p;
        try {
          await navigator.clipboard.writeText(text);
          showStatus('Pattern copied to clipboard');
        } catch (err) {
          // Fallback copy method for older contexts
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); showStatus('Pattern copied to clipboard'); } catch { showStatus('Copy failed', false); }
          ta.remove();
        }
      });
      chip.addEventListener('dragstart', e => {
        chip.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', idx.toString());
      });
      chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
      listEl.appendChild(chip);
    });
  }
  renderPatterns();
  // Drag over patterns list to reorder
  listEl.addEventListener('dragover', e => {
    e.preventDefault();
    const after = Array.from(listEl.querySelectorAll('.pattern-chip:not(.dragging)'))
      .find(el => {
        const box = el.getBoundingClientRect();
        return e.clientX < box.left + box.width / 2; // insert before midpoint
      });
    const dragging = listEl.querySelector('.pattern-chip.dragging');
    if (!dragging) return;
    if (after) listEl.insertBefore(dragging, after); else listEl.appendChild(dragging);
  });
  listEl.addEventListener('drop', () => {
    // Recompute rule.patterns from DOM order (use dataset.pattern to avoid DOM text nuances)
    rule.patterns = Array.from(listEl.querySelectorAll('.pattern-chip')).map(c => c.dataset.pattern || c.textContent || '');
    renderPatterns();
  });
  const input = tr.querySelector('.pattern-input');
  function addPattern() {
    const val = input.value.trim();
    if (val) { rule.patterns.push(val); input.value=''; renderPatterns(); }
  }
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addPattern(); } });
  tr.querySelector('.add-pattern').addEventListener('click', addPattern);
  const enabledBox = tr.querySelector('.enabled');
  enabledBox.addEventListener('change', () => {
    tr.classList.toggle('disabled', !enabledBox.checked);
  });
  tr.querySelector('.remove').addEventListener('click', () => tr.remove());
  // Enable row drag for reordering rules
  tr.setAttribute('draggable','true');
  tr.addEventListener('dragstart', e => {
    tr.classList.add('dragging');
    e.dataTransfer.setData('text/plain','row');
  });
  tr.addEventListener('dragend', () => tr.classList.remove('dragging'));
  tr._getRule = () => ({
    enabled: enabledBox.checked,
    patterns: rule.patterns.filter(p => p.trim()),
    destination: tr.querySelector('.destination').value.trim()
  });
}

function readRules() {
  const rows = Array.from(tbody.querySelectorAll('tr'));
  return rows.map(tr => tr._getRule && tr._getRule())
    .filter(r => r && r.patterns.length && r.destination);
}

function showStatus(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.style.color = ok ? 'green' : 'crimson';
  if (msg) setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

async function load() {
  chrome.storage.sync.get(['rules'], data => {
    const rules = Array.isArray(data.rules) ? data.rules : [];
    tbody.innerHTML = '';
    rules.forEach(r => {
      if (r.pattern && !r.patterns) r.patterns = [r.pattern];
      createRow(r);
    });
    if (!rules.length) createRow();
  });
}

async function save() {
  const rows = Array.from(tbody.querySelectorAll('tr'));
  let hasError = false;
  const rules = [];
  rows.forEach(tr => {
    if (!tr._getRule) return;
    const rule = tr._getRule();
    const destInput = tr.querySelector('.destination');
    destInput.classList.remove('invalid');
    // Validate destination URL
    let urlOk = true;
    try {
      if (!/^https?:\/\//i.test(rule.destination)) urlOk = false;
      else new URL(rule.destination);
    } catch { urlOk = false; }
    if (!urlOk) {
      destInput.classList.add('invalid');
      hasError = true;
      return; // skip storing invalid rule
    }
    // Validate capture refs ($1 etc) against last pattern group count
    const lastPattern = rule.patterns[rule.patterns.length - 1];
    let groupCount = 0;
    try {
      const dummy = new RegExp(lastPattern);
      // Estimate group count: count '(' not followed by '?' (naive but ok)
      groupCount = (lastPattern.match(/\((?!\?)/g) || []).length;
    } catch { /* ignore */ }
    const refs = rule.destination.match(/\$(\d+)/g) || [];
    for (const ref of refs) {
      const num = Number(ref.slice(1));
      if (!(num >=0 && num <= groupCount)) {
        destInput.classList.add('invalid');
        hasError = true;
        break;
      }
    }
    if (!hasError && rule.patterns.length && rule.destination) rules.push(rule);
  });
  if (hasError) {
    showStatus('Validation error: fix highlighted destinations', false);
    return;
  }
  await new Promise(res => chrome.storage.sync.set({ rules }, res));
  chrome.runtime.sendMessage({ type: 'SYNC_RULES' }, resp => {
    if (resp?.ok) showStatus('Saved & synced');
    else showStatus('Save error: ' + resp?.error, false);
  });
}

// --- Slack links -> Slack app (handled in background.js through ProfileRouter) ---
const slackBox = document.getElementById('slackHandoff');
const hostStatusEl = document.getElementById('slackHostStatus');

function setHostStatus(msg, ok) {
  hostStatusEl.textContent = msg;
  hostStatusEl.classList.toggle('error', !ok);
}

// A non-web URL gets { handled: false } without opening anything, so it's a safe connection check.
function checkProfileRouterHost() {
  if (!slackBox.checked) return setHostStatus('', true);
  chrome.runtime.sendNativeMessage('com.supercorks.profilerouter', { url: 'about:blank' }, () => {
    if (chrome.runtime.lastError) {
      setHostStatus('ProfileRouter isn\'t reachable (' + chrome.runtime.lastError.message + '). Run scripts/install.sh in profile-router. Until then, Slack links open on the web.', false);
    } else {
      setHostStatus('Uses ProfileRouter on this Mac. Links it can\'t open in Slack load on the web as usual.', true);
    }
  });
}

chrome.storage.sync.get('slackHandoff', ({ slackHandoff }) => {
  slackBox.checked = slackHandoff !== false;
  checkProfileRouterHost();
});
slackBox.addEventListener('change', () => {
  chrome.storage.sync.set({ slackHandoff: slackBox.checked }, () => {
    showStatus(slackBox.checked ? 'Slack links will open in the Slack app' : 'Slack links will open on the web');
    checkProfileRouterHost();
  });
});

document.getElementById('addRow').addEventListener('click', () => createRow());
document.getElementById('save').addEventListener('click', save);

// Table-level drag to reorder rule rows
tbody.addEventListener('dragover', e => {
  const dragging = tbody.querySelector('tr.dragging');
  if (!dragging) return;
  e.preventDefault();
  const after = Array.from(tbody.querySelectorAll('tr:not(.dragging)'))
    .find(row => e.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
  if (after) tbody.insertBefore(dragging, after); else tbody.appendChild(dragging);
});
// Re-save order implicitly on manual save; order in DOM defines order

load();
