let worker = null;
let currentEntry = null;
let timerInterval = null;
let deferredPrompt = null;
let allLocations = [];

const RING_C = 2 * Math.PI * 54; // 339.3

// PWA install prompt (Android/Chrome)
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  if (!isInStandaloneMode()) show('install-banner');
});
window.addEventListener('appinstalled', () => hide('install-banner'));

async function installApp() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  hide('install-banner');
}

// Offline detection
window.addEventListener('online',  () => hide('offline-banner'));
window.addEventListener('offline', () => show('offline-banner'));

function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function isInStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('gt_worker');
  if (saved) { worker = JSON.parse(saved); showApp(); }
  document.getElementById('inp-pin').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  document.getElementById('inp-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('inp-pin').focus(); });
  if (isIOS() && !isInStandaloneMode()) show('ios-banner');
  if (!navigator.onLine) show('offline-banner');
});

// ── Tab navigation ──
function showWorkerTab(tab) {
  ['home','hours','history'].forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('section-hidden', t !== tab);
    document.getElementById('nav-' + t).classList.toggle('active', t === tab);
  });
}

// ── Haptic feedback ──
function haptic() {
  try { if (navigator.vibrate) navigator.vibrate(50); } catch {}
}

// ── Clock-in overlay ──
function showClockInOverlay(locName) {
  const el = document.getElementById('clockin-overlay');
  document.getElementById('overlay-loc').textContent = locName || '';
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2200);
}

// ── Progress ring ──
function updateProgressRing(elapsedMs) {
  const ring = document.getElementById('ring-fill');
  if (!ring) return;
  const mins = elapsedMs / 60000;
  const maxMins = 600; // 10 hours = full ring
  const pct = Math.min(mins / maxMins, 1);
  const offset = RING_C * (1 - pct);
  ring.style.strokeDasharray = RING_C;
  ring.style.strokeDashoffset = offset;
  if (mins >= 600) {
    ring.style.stroke = '#ef4444'; // red
  } else if (mins >= 420) {
    ring.style.stroke = '#f59e0b'; // amber
  } else {
    ring.style.stroke = '#16a34a'; // green
  }
}

// ── Location color (hash-based) ──
const LOC_COLORS = ['#16a34a','#2563eb','#9333ea','#ea580c','#0891b2','#be185d','#65a30d','#d97706'];
function locationColor(id) {
  return LOC_COLORS[Math.abs(parseInt(id) || 0) % LOC_COLORS.length];
}

// ── Swipe right to clock out ──
function initSwipeClockOut() {
  const card = document.getElementById('form-out');
  if (!card) return;
  let startX = null;
  card.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  card.addEventListener('touchend', e => {
    if (startX === null) return;
    const delta = e.changedTouches[0].clientX - startX;
    startX = null;
    if (delta > 80) { haptic(); clockOut(); }
  }, { passive: true });
}

// ── Auto-select most recent location ──
async function autoSelectRecentLocation() {
  try {
    const entries = await get(`/api/entries/worker/${worker.id}?endDate=${today()}`);
    if (entries && entries.length) {
      const last = entries[0];
      const sel = document.getElementById('loc-select');
      if (last.location_id && sel) {
        sel.value = String(last.location_id);
        updateLocPreview();
      }
    }
  } catch {}
}

async function login() {
  const name = document.getElementById('inp-name').value.trim();
  const pin  = document.getElementById('inp-pin').value.trim();
  if (!name || !pin) { showLoginErr('Enter your name and PIN.'); return; }
  try {
    const r = await post('/api/auth/login', { name, pin });
    if (r.success) {
      worker = r.worker;
      localStorage.setItem('gt_worker', JSON.stringify(worker));
      showApp();
    } else {
      showLoginErr(r.message || 'Invalid name or PIN.');
    }
  } catch { showLoginErr('Connection error. Please try again.'); }
}

function signOut() {
  localStorage.removeItem('gt_worker');
  worker = null; currentEntry = null;
  clearInterval(timerInterval);
  show('login-section'); hide('app-section');
  document.getElementById('inp-name').value = '';
  document.getElementById('inp-pin').value = '';
}

async function showApp() {
  hide('login-section'); show('app-section');
  document.getElementById('hdr-name').textContent = worker.name;
  await loadLocations();
  await refreshStatus();
  await loadHistory();
  await loadWeekHours();
  initSwipeClockOut();
  if (!currentEntry) autoSelectRecentLocation();
}

async function loadLocations() {
  const locs = await get('/api/locations');
  allLocations = locs;
  const sel = document.getElementById('loc-select');
  sel.innerHTML = '<option value="">— Choose a location —</option>';
  locs.forEach(l => sel.insertAdjacentHTML('beforeend',
    `<option value="${l.id}">${esc(l.name)}${l.address ? ' — ' + esc(l.address) : ''}</option>`));
  sel.addEventListener('change', updateLocPreview);
}

function updateLocPreview() {
  const locId = document.getElementById('loc-select').value;
  const loc = allLocations.find(l => String(l.id) === locId);
  const preview = document.getElementById('loc-preview');
  if (loc) {
    document.getElementById('loc-preview-name').textContent = loc.name;
    document.getElementById('loc-preview-addr').textContent = loc.address || '';
    const iconEl = document.getElementById('loc-preview-icon');
    iconEl.textContent = '📍';
    iconEl.style.background = locationColor(loc.id);
    iconEl.style.width = '42px';
    iconEl.style.height = '42px';
    iconEl.style.borderRadius = '50%';
    iconEl.style.flexShrink = '0';
    if (loc.address) {
      document.getElementById('maps-link').href = `https://maps.google.com/?q=${encodeURIComponent(loc.address)}`;
      document.getElementById('maps-link').style.display = '';
    } else {
      document.getElementById('maps-link').style.display = 'none';
    }
    preview.classList.remove('section-hidden');
  } else {
    preview.classList.add('section-hidden');
  }
}

// Keep old updateMapsLink name in case anything calls it
function updateMapsLink() { updateLocPreview(); }

async function refreshStatus() {
  const data = await get(`/api/entries/current/${worker.id}`);
  currentEntry = data.entry;
  renderStatus();
}

function renderStatus() {
  clearInterval(timerInterval);
  hide('ot-warning');

  // Greeting
  const greetEl = document.getElementById('worker-greeting');
  if (worker) {
    const hr = new Date().getHours();
    const g = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    greetEl.textContent = `${g}, ${worker.name} 👋`;
    greetEl.classList.remove('section-hidden');
  }

  if (currentEntry) {
    hide('s-out'); show('s-in');
    hide('form-in'); show('form-out');
    document.getElementById('s-loc').textContent = '📍 ' + currentEntry.location_name;
    document.getElementById('s-since').textContent = 'Since ' + fmtTime(currentEntry.clock_in);
    const start = new Date(currentEntry.clock_in).getTime();
    const tick = () => {
      const elapsed = Date.now() - start;
      document.getElementById('s-timer').textContent = fmtElapsed(elapsed);
      updateProgressRing(elapsed);
      if (elapsed > 10 * 60 * 60 * 1000) show('ot-warning');
    };
    tick(); timerInterval = setInterval(tick, 1000);
  } else {
    show('s-out'); hide('s-in');
    show('form-in'); hide('form-out');
    updateProgressRing(0);
  }
}

async function clockIn() {
  const locationId = document.getElementById('loc-select').value;
  if (!locationId) { showAlert('Please select a location.', 'error'); return; }
  if (!navigator.onLine) { showAlert('No internet connection. Please reconnect to clock in.', 'error'); return; }
  const notes = document.getElementById('in-notes').value.trim();
  let lat = null, lng = null;
  try { const p = await getGPS(); lat = p.coords.latitude; lng = p.coords.longitude; } catch {}
  const r = await post('/api/entries/clock-in', { workerId: worker.id, locationId, latitude: lat, longitude: lng, notes });
  if (r.success) {
    const locName = allLocations.find(l => String(l.id) === locationId)?.name || '';
    document.getElementById('in-notes').value = '';
    document.getElementById('loc-select').value = '';
    document.getElementById('loc-preview').classList.add('section-hidden');
    showClockInOverlay(locName);
    await refreshStatus(); await loadHistory();
  } else {
    showAlert(r.message || 'Failed to clock in.', 'error');
  }
}

async function clockOut() {
  if (!navigator.onLine) { showAlert('No internet connection. Please reconnect to clock out.', 'error'); return; }
  let lat = null, lng = null;
  try { const p = await getGPS(); lat = p.coords.latitude; lng = p.coords.longitude; } catch {}
  const notes = document.getElementById('out-notes').value.trim();
  const r = await post('/api/entries/clock-out', { workerId: worker.id, latitude: lat, longitude: lng, notes });
  if (r.success) {
    haptic();
    document.getElementById('out-notes').value = '';
    await refreshStatus(); await loadHistory(); await loadWeekHours();
    showAlert(`Clocked out! Worked ${fmtDur(r.entry.duration_minutes)}.`, 'success');
    autoSelectRecentLocation();
  } else {
    showAlert(r.message || 'Failed.', 'error');
  }
}

async function loadHistory(all = false) {
  const entries = await get(`/api/entries/worker/${worker.id}${all ? '' : '?endDate=' + today()}`);
  const el = document.getElementById('entries-list');
  if (!entries.length) { el.innerHTML = '<div class="table-empty">No entries yet</div>'; return; }
  const shown = all ? entries : entries.slice(0, 10);
  el.innerHTML = shown.map(e => `
    <div class="entry-row" style="border-left:4px solid ${locationColor(e.location_id)}">
      <div class="entry-main">
        <div class="entry-loc">${esc(e.location_name)}</div>
        <div class="entry-dur">${e.duration_minutes ? fmtDur(e.duration_minutes) : (e.clock_out ? '0m' : '<span class="badge badge-success">Active</span>')}</div>
      </div>
      <div class="entry-meta">
        <span>${fmtDate(e.clock_in)}</span>
        <span>${fmtTime(e.clock_in)} → ${e.clock_out ? fmtTime(e.clock_out) : 'now'}</span>
        ${e.notes ? `<span>📝 ${esc(e.notes)}</span>` : ''}
      </div>
    </div>`).join('');
}

async function loadWeekHours() {
  const now = new Date();
  const todayStr = toLocalDateStr(now);

  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekStartStr = toLocalDateStr(weekStart);

  const monthStartStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const entries = await get(`/api/entries/worker/${worker.id}?startDate=${monthStartStr}`);

  const weekEntries = entries.filter(e => toLocalDateStr(new Date(e.clock_in)) >= weekStartStr);
  const weekMins  = weekEntries.reduce((s, e) => s + (e.duration_minutes || 0), 0);
  const todayMins = entries.filter(e => toLocalDateStr(new Date(e.clock_in)) === todayStr)
                           .reduce((s, e) => s + (e.duration_minutes || 0), 0);
  const monthMins = entries.reduce((s, e) => s + (e.duration_minutes || 0), 0);

  // Main hour displays
  document.getElementById('today-hours').textContent = fmtDur(todayMins) || '0m';
  document.getElementById('week-hours').textContent  = fmtDur(weekMins)  || '0m';
  document.getElementById('month-hours').textContent = fmtDur(monthMins) || '0m';

  // Sticky hours bar
  document.getElementById('bar-today').textContent = fmtDur(todayMins) || '0m';
  document.getElementById('bar-week').textContent  = fmtDur(weekMins)  || '0m';
  document.getElementById('bar-month').textContent = fmtDur(monthMins) || '0m';

  // Daily breakdown
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const todayDay = now.getDay();
  const byDay = {};
  weekEntries.forEach(e => {
    const d = new Date(e.clock_in).getDay();
    byDay[d] = (byDay[d] || 0) + (e.duration_minutes || 0);
  });
  document.getElementById('daily-breakdown').innerHTML = days.map((day, i) => {
    const m = byDay[i] || 0;
    const isToday = i === todayDay;
    return `<div style="text-align:center">
      <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${isToday ? 'var(--brand-dark)' : 'var(--gray-400)'};margin-bottom:.2rem">${day}</div>
      <div style="font-size:.8rem;font-weight:${isToday ? '800' : '600'};color:${m ? (isToday ? 'var(--brand-dark)' : 'var(--gray-700)') : 'var(--gray-300)'}">${m ? fmtDur(m) : '—'}</div>
    </div>`;
  }).join('');

  // Estimated earnings
  if (worker.payRate) {
    const pay = (weekMins / 60) * parseFloat(worker.payRate);
    document.getElementById('week-pay').textContent = '$' + pay.toFixed(2);
    document.getElementById('week-pay-row').classList.remove('section-hidden');
    document.getElementById('week-pay-row').style.display = 'flex';
  }
}

// Helpers
function toLocalDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function getGPS() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) { rej(); return; }
    navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 });
  });
}
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s/3600)}:${pad(Math.floor((s%3600)/60))}:${pad(s%60)}`;
}
function fmtDur(m) {
  if (!m) return null;
  const h = Math.floor(m/60), min = m%60;
  return h === 0 ? `${min}m` : min === 0 ? `${h}h` : `${h}h ${min}m`;
}
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}) : ''; }
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'}) : ''; }
function today() { return new Date().toISOString().split('T')[0]; }
function pad(n) { return String(n).padStart(2,'0'); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function show(id) { document.getElementById(id).classList.remove('section-hidden'); }
function hide(id) { document.getElementById(id).classList.add('section-hidden'); }
function showLoginErr(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg; show('login-error');
  setTimeout(() => hide('login-error'), 5000);
}
function showAlert(msg, type) {
  const el = document.getElementById('app-alert');
  el.className = `alert alert-${type === 'error' ? 'error' : 'success'}`;
  el.textContent = msg; show('app-alert');
  setTimeout(() => hide('app-alert'), 5000);
}
async function get(url) { const r = await fetch(url); return r.json(); }
async function post(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  return r.json();
}
