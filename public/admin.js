let allEntries = [];
let allEntriesFiltered = [];
let activeWorkers = [];
let allSprayJobs = [];
let allWorkers = [];
let allLocations = [];
let allPayroll = [];
let chartWorkers = null;
let chartTrend = null;

document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('gt_admin') === 'true') showAdminApp();
  document.getElementById('admin-pw').addEventListener('keydown', e => { if (e.key === 'Enter') adminLogin(); });
  const now = new Date();
  document.getElementById('f-end').value = now.toISOString().split('T')[0];
  now.setDate(now.getDate() - 6);
  document.getElementById('f-start').value = now.toISOString().split('T')[0];
  document.getElementById('app-url').value = window.location.origin;
  setSeasonalTips();
  initPayrollDates();
});

function initPayrollDates() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  document.getElementById('pr-start').value = new Date(y, m, 1).toISOString().split('T')[0];
  document.getElementById('pr-end').value = new Date(y, m + 1, 0).toISOString().split('T')[0];
}

function copyAppUrl() {
  const url = window.location.origin;
  navigator.clipboard.writeText(url)
    .then(() => showAlert('Link copied to clipboard!', 'success'))
    .catch(() => showAlert('Copy this link: ' + url, 'success'));
}

async function adminLogin() {
  const password = document.getElementById('admin-pw').value;
  const r = await post('/api/admin/auth', { password });
  if (r.success) {
    localStorage.setItem('gt_admin', 'true');
    showAdminApp();
  } else {
    const el = document.getElementById('admin-login-err');
    el.textContent = r.message || 'Invalid password.';
    show('admin-login-err');
  }
}

function adminSignOut() {
  localStorage.removeItem('gt_admin');
  hide('admin-app'); show('admin-login');
  document.getElementById('admin-pw').value = '';
}

async function showAdminApp() {
  hide('admin-login'); show('admin-app');
  await Promise.all([loadStats(), loadActive(), loadWorkers(), loadLocations()]);
  loadCharts();
  setInterval(updateTimers, 1000);
  setInterval(() => {
    if (!document.getElementById('tab-dashboard').classList.contains('section-hidden')) {
      loadStats(); loadActive(); loadCharts();
    }
  }, 30000);
}

function showTab(btn, tab) {
  ['dashboard','entries','workers','locations','spraying','payroll','settings'].forEach(t => {
    document.getElementById('tab-' + t).classList.add('section-hidden');
  });
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.remove('section-hidden');
  btn.classList.add('active');
  if (tab === 'entries')  loadEntries();
  if (tab === 'spraying') loadSprayingTab();
}

// ── Charts ──
async function loadCharts() {
  try {
    const data = await get('/api/admin/charts');
    renderWorkerChart(data.workerHours);
    renderTrendChart(data.weeklyTrend);
  } catch {}
}

function renderWorkerChart(rows) {
  const ctx = document.getElementById('chart-workers')?.getContext('2d');
  if (!ctx) return;
  if (chartWorkers) chartWorkers.destroy();
  chartWorkers = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.length ? rows.map(r => r.name) : ['No data'],
      datasets: [{
        data: rows.length ? rows.map(r => +(r.total_minutes / 60).toFixed(1)) : [0],
        backgroundColor: rows.map(r => workerColor(r.name)),
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.parsed.y + ' hrs' } } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => v + 'h' } } }
    }
  });
}

function renderTrendChart(rows) {
  const ctx = document.getElementById('chart-trend')?.getContext('2d');
  if (!ctx) return;
  if (chartTrend) chartTrend.destroy();
  chartTrend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(r => { const d = new Date(r.week_start); return d.toLocaleDateString([],{month:'short',day:'numeric'}); }),
      datasets: [{
        label: 'Total Hours',
        data: rows.map(r => +(r.total_minutes / 60).toFixed(1)),
        borderColor: '#1f8f3a',
        backgroundColor: 'rgba(31,143,58,.12)',
        fill: true,
        tension: 0.35,
        pointBackgroundColor: '#1f8f3a',
        pointRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.parsed.y + ' hrs' } } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => v + 'h' } } }
    }
  });
}

// ── Dashboard ──
async function loadStats() {
  const s = await get('/api/admin/stats');
  document.getElementById('st-workers').textContent = s.totalWorkers;
  document.getElementById('st-active').textContent  = s.clockedIn;
  document.getElementById('st-today').textContent   = s.todayHours + 'h';
  document.getElementById('st-week').textContent    = s.weekHours + 'h';
}

async function loadActive() {
  activeWorkers = await get('/api/admin/active');
  const el = document.getElementById('active-list');
  if (!activeWorkers.length) {
    el.innerHTML = '<div class="table-empty">No workers currently clocked in</div>'; return;
  }
  el.innerHTML = activeWorkers.map(w => `
    <div class="active-row">
      <div style="display:flex;align-items:center;gap:.65rem">
        ${workerAvatar(w.worker_name, 'worker-avatar-lg')}
        <div>
          <div class="active-name">${esc(w.worker_name)}</div>
          <div class="active-detail">📍 ${esc(w.location_name)} · Since ${fmtTime(w.clock_in)}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:.6rem">
        <div class="active-timer" id="atimer-${w.id}">${fmtElapsed(Date.now()-new Date(w.clock_in).getTime())}</div>
        <button class="btn btn-warning btn-sm" onclick="forceClockOut(${w.id},'${esc(w.worker_name)}')">Clock Out</button>
      </div>
    </div>`).join('');
}

function updateTimers() {
  activeWorkers.forEach(w => {
    const el = document.getElementById('atimer-' + w.id);
    if (el) el.textContent = fmtElapsed(Date.now() - new Date(w.clock_in).getTime());
  });
}

async function forceClockOut(id, name) {
  if (!confirm(`Clock out ${name}?`)) return;
  const r = await post(`/api/admin/entries/${id}/clock-out`, {});
  if (r.success) { showAlert(`${name} clocked out.`, 'success'); loadActive(); loadStats(); }
}

// ── Workers ──
async function loadWorkers() {
  const workers = await get('/api/admin/workers');
  allWorkers = workers;
  const fSel = document.getElementById('f-worker');
  fSel.innerHTML = '<option value="">All Workers</option>' +
    workers.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
  ['sf-employee','sj-employee','esj-employee'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = '<option value="">— Select —</option>' +
      workers.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
  });
  const tbody = document.getElementById('workers-tbody');
  if (!workers.length) { tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No workers yet</td></tr>'; return; }
  tbody.innerHTML = workers.map(w => `
    <tr>
      <td style="display:flex;align-items:center;gap:.6rem">${workerAvatar(w.name)}<strong>${esc(w.name)}</strong></td>
      <td><span class="badge badge-gray">Hidden</span></td>
      <td>${w.pay_rate ? '<strong>$' + parseFloat(w.pay_rate).toFixed(2) + '/hr</strong>' : '<span class="text-muted">—</span>'}</td>
      <td>${fmtDate(w.created_at)}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="openEditWorker(${w.id},'${esc(w.name)}',${w.pay_rate||''})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="removeWorker(${w.id},'${esc(w.name)}')">Remove</button>
      </td>
    </tr>`).join('');
}

async function loadLocations() {
  const locs = await get('/api/locations');
  allLocations = locs;
  const fSel = document.getElementById('f-location');
  fSel.innerHTML = '<option value="">All Locations</option>' +
    locs.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  const tbody = document.getElementById('locations-tbody');
  if (!locs.length) { tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No locations yet</td></tr>'; return; }
  tbody.innerHTML = locs.map(l => `
    <tr>
      <td><strong>${esc(l.name)}</strong></td>
      <td>${l.address ? esc(l.address) : '<span class="text-muted">—</span>'}</td>
      <td>${fmtDate(l.created_at)}</td>
      <td><button class="btn btn-danger btn-sm" onclick="removeLocation(${l.id},'${esc(l.name)}')">Remove</button></td>
    </tr>`).join('');
}

// ── Entries ──
async function loadEntries() {
  const params = new URLSearchParams();
  const w = document.getElementById('f-worker').value;
  const l = document.getElementById('f-location').value;
  const s = document.getElementById('f-start').value;
  const e = document.getElementById('f-end').value;
  if (w) params.set('workerId', w);
  if (l) params.set('locationId', l);
  if (s) params.set('startDate', s);
  if (e) params.set('endDate', e);
  allEntries = await get('/api/admin/entries?' + params);
  allEntriesFiltered = allEntries;
  filterEntries();
}

function filterEntries() {
  const q = (document.getElementById('f-search')?.value || '').toLowerCase();
  allEntriesFiltered = q
    ? allEntries.filter(e => e.worker_name.toLowerCase().includes(q) || e.location_name.toLowerCase().includes(q))
    : allEntries;
  renderEntries();
}

function renderEntries() {
  const tbody = document.getElementById('entries-tbody');
  if (!allEntriesFiltered.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No entries found</td></tr>'; return;
  }
  tbody.innerHTML = allEntriesFiltered.map(entry => {
    const hasGPS = entry.clock_in_lat && entry.clock_in_lng;
    const gps = hasGPS
      ? `<a href="https://maps.google.com/?q=${entry.clock_in_lat},${entry.clock_in_lng}" target="_blank" class="badge badge-success">📍 Map</a>`
      : '<span class="text-muted">—</span>';
    const active = !entry.clock_out;
    const overtime = entry.duration_minutes > 480;
    return `<tr class="${overtime ? 'row-overtime' : ''}">
      <td>${fmtDate(entry.clock_in)}</td>
      <td style="display:flex;align-items:center;gap:.5rem">${workerAvatar(entry.worker_name)}<strong>${esc(entry.worker_name)}</strong></td>
      <td>${esc(entry.location_name)}</td>
      <td>${fmtTime(entry.clock_in)}</td>
      <td>${entry.clock_out ? fmtTime(entry.clock_out) : '<span class="badge badge-success">Active</span>'}</td>
      <td>
        ${entry.duration_minutes ? '<strong>' + fmtDur(entry.duration_minutes) + '</strong>' : '<span class="text-muted">—</span>'}
        ${overtime ? '<span class="overtime-flag">⚠ OT</span>' : ''}
      </td>
      <td>${gps}</td>
      <td>${entry.notes ? esc(entry.notes) : '<span class="text-muted">—</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-outline btn-sm" onclick="openEditEntry(${entry.id})">Edit</button>
        ${active ? `<button class="btn btn-warning btn-sm" onclick="forceClockOut(${entry.id},'${esc(entry.worker_name)}')">Clock Out</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

function exportCSV() {
  if (!allEntriesFiltered.length) { showAlert('No entries to export.', 'warning'); return; }
  const hdr = ['Date','Worker','Location','Clock In','Clock Out','Duration (min)','Duration (hrs)','Overtime','GPS Lat','GPS Lng','Notes'];
  const rows = allEntriesFiltered.map(e => [
    fmtDate(e.clock_in), e.worker_name, e.location_name,
    fmtDateTime(e.clock_in), e.clock_out ? fmtDateTime(e.clock_out) : '',
    e.duration_minutes || '', e.duration_minutes ? (e.duration_minutes/60).toFixed(2) : '',
    e.duration_minutes > 480 ? 'Yes' : 'No',
    e.clock_in_lat || '', e.clock_in_lng || '', e.notes || ''
  ]);
  dlCSV([hdr,...rows], `legacy-lm-${new Date().toISOString().split('T')[0]}.csv`);
}

// ── Edit Entry ──
function openEditEntry(id) {
  const entry = allEntries.find(e => e.id === id);
  if (!entry) return;
  document.getElementById('ee-id').value = id;
  document.getElementById('ee-worker').innerHTML =
    allWorkers.map(w => `<option value="${w.id}" ${w.id == entry.worker_id ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  document.getElementById('ee-location').innerHTML =
    allLocations.map(l => `<option value="${l.id}" ${l.id == entry.location_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  document.getElementById('ee-clock-in').value  = toDatetimeLocal(entry.clock_in);
  document.getElementById('ee-clock-out').value = toDatetimeLocal(entry.clock_out);
  document.getElementById('ee-notes').value = entry.notes || '';
  openModal('m-edit-entry');
}

async function saveEntry() {
  const id         = document.getElementById('ee-id').value;
  const clockInVal = document.getElementById('ee-clock-in').value;
  const clockOutVal= document.getElementById('ee-clock-out').value;
  if (!clockInVal) { showAlert('Clock-in time is required.', 'error'); return; }
  const body = {
    workerId:   document.getElementById('ee-worker').value,
    locationId: document.getElementById('ee-location').value,
    clockIn:    new Date(clockInVal).toISOString(),
    clockOut:   clockOutVal ? new Date(clockOutVal).toISOString() : null,
    notes:      document.getElementById('ee-notes').value.trim(),
  };
  const r = await put(`/api/admin/entries/${id}`, body);
  if (r.success) { closeModal('m-edit-entry'); loadEntries(); loadStats(); showAlert('Entry updated.', 'success'); }
}

// ── Worker CRUD ──
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
});

async function addWorker() {
  const name    = document.getElementById('nw-name').value.trim();
  const pin     = document.getElementById('nw-pin').value.trim();
  const payRate = document.getElementById('nw-rate').value;
  if (!name || !pin) { showModalErr('add-worker-err','Name and PIN required.'); return; }
  const r = await post('/api/admin/workers', { name, pin, payRate: payRate || null });
  if (r.success) {
    closeModal('m-add-worker');
    ['nw-name','nw-pin','nw-rate'].forEach(id => document.getElementById(id).value = '');
    loadWorkers(); loadStats();
    showAlert(`Worker "${name}" added.`, 'success');
  } else {
    showModalErr('add-worker-err', r.message || 'Failed.');
  }
}

function openEditWorker(id, name, payRate) {
  document.getElementById('ew-id').value = id;
  document.getElementById('ew-name').value = name;
  document.getElementById('ew-pin').value = '';
  document.getElementById('ew-rate').value = payRate || '';
  openModal('m-edit-worker');
}

async function saveWorker() {
  const id      = document.getElementById('ew-id').value;
  const name    = document.getElementById('ew-name').value.trim();
  const pin     = document.getElementById('ew-pin').value.trim();
  const payRate = document.getElementById('ew-rate').value;
  await put(`/api/admin/workers/${id}`, { name, pin, payRate: payRate || null });
  closeModal('m-edit-worker');
  loadWorkers();
  showAlert('Worker updated.', 'success');
}

async function removeWorker(id, name) {
  if (!confirm(`Remove worker "${name}"? Their time history is kept.`)) return;
  await del(`/api/admin/workers/${id}`);
  loadWorkers(); loadStats();
  showAlert(`Worker "${name}" removed.`, 'success');
}

// ── Location CRUD ──
async function addLocation() {
  const name = document.getElementById('nl-name').value.trim();
  const addr = document.getElementById('nl-addr').value.trim();
  if (!name) return;
  await post('/api/admin/locations', { name, address: addr });
  closeModal('m-add-location');
  document.getElementById('nl-name').value = '';
  document.getElementById('nl-addr').value = '';
  loadLocations();
  showAlert(`Location "${name}" added.`, 'success');
}

async function removeLocation(id, name) {
  if (!confirm(`Remove location "${name}"?`)) return;
  await del(`/api/admin/locations/${id}`);
  loadLocations();
  showAlert(`Location "${name}" removed.`, 'success');
}

// ── Settings ──
async function changePassword() {
  const np = document.getElementById('new-pw').value;
  const cp = document.getElementById('confirm-pw').value;
  if (!np) { showAlert('Enter a new password.', 'error'); return; }
  if (np !== cp) { showAlert('Passwords do not match.', 'error'); return; }
  const r = await put('/api/admin/settings/password', { password: np });
  if (r.success) {
    document.getElementById('new-pw').value = '';
    document.getElementById('confirm-pw').value = '';
    showAlert('Password updated.', 'success');
  }
}

// ── Payroll ──
async function loadPayroll() {
  const start = document.getElementById('pr-start').value;
  const end   = document.getElementById('pr-end').value;
  if (!start || !end) { showAlert('Select start and end dates.', 'error'); return; }
  allPayroll = await get(`/api/admin/payroll?startDate=${start}&endDate=${end}`);
  hide('payroll-empty');
  show('payroll-results');
  const tbody = document.getElementById('payroll-tbody');
  if (!allPayroll.length) { tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No data</td></tr>'; return; }
  let totalMins = 0, totalPay = 0;
  tbody.innerHTML = allPayroll.map(w => {
    const hrs  = +(w.total_minutes / 60).toFixed(2);
    const rate = parseFloat(w.pay_rate) || 0;
    const pay  = hrs * rate;
    totalMins += parseInt(w.total_minutes);
    totalPay  += pay;
    return `<tr>
      <td style="display:flex;align-items:center;gap:.5rem">${workerAvatar(w.name)}<strong>${esc(w.name)}</strong></td>
      <td>${w.entry_count}</td>
      <td>${fmtDur(parseInt(w.total_minutes)) || '0m'} <span class="text-muted">(${hrs}h)</span></td>
      <td>${rate ? '$' + rate.toFixed(2) : '<span class="text-muted">—</span>'}</td>
      <td><strong>${rate ? '$' + pay.toFixed(2) : '—'}</strong></td>
    </tr>`;
  }).join('') + `<tr class="payroll-total">
    <td><strong>TOTAL</strong></td>
    <td></td>
    <td><strong>${fmtDur(totalMins) || '0m'}</strong></td>
    <td></td>
    <td><strong>$${totalPay.toFixed(2)}</strong></td>
  </tr>`;
}

function exportPayrollCSV() {
  if (!allPayroll.length) { showAlert('Run the report first.', 'warning'); return; }
  const hdr = ['Worker','Entries','Total Minutes','Total Hours','Rate/hr','Gross Pay'];
  const rows = allPayroll.map(w => {
    const hrs  = +(w.total_minutes / 60).toFixed(2);
    const rate = parseFloat(w.pay_rate) || 0;
    return [w.name, w.entry_count, w.total_minutes, hrs, rate ? rate.toFixed(2) : '', rate ? (hrs * rate).toFixed(2) : ''];
  });
  dlCSV([hdr,...rows], `payroll-${document.getElementById('pr-start').value}-to-${document.getElementById('pr-end').value}.csv`);
}

// ── Spraying Tab ──
function loadSprayingTab() {
  showSprayTab(document.querySelector('.spray-subnav.active') || document.querySelector('.spray-subnav'), 'spray-jobs');
  loadSprayJobs();
  loadClients();
  loadProducts();
  loadFollowups();
}

function showSprayTab(btn, tab) {
  ['spray-jobs','spray-add','spray-clients','spray-products','spray-followups'].forEach(t => {
    document.getElementById(t).classList.add('section-hidden');
  });
  document.querySelectorAll('.spray-subnav').forEach(b => {
    b.classList.remove('active','btn-primary');
    b.classList.add('btn-outline');
  });
  document.getElementById(tab).classList.remove('section-hidden');
  btn.classList.add('active','btn-primary');
  btn.classList.remove('btn-outline');
  if (tab === 'spray-jobs')     loadSprayJobs();
  if (tab === 'spray-clients')  loadClients();
  if (tab === 'spray-products') loadProducts();
  if (tab === 'spray-followups') loadFollowups();
}

function setSeasonalTips() {
  const month = new Date().getMonth();
  const tips = {
    spring: ['Pre-emergent weed control', 'Fertilizer application', 'Early pest prevention'],
    summer: ['Weed control treatments', 'Pest control', 'Heat-stress lawn care'],
    fall:   ['Fertilizer for root strengthening', 'Weed cleanup', 'Winter prep treatments'],
    winter: ['Client follow-up planning', 'Review upcoming service schedules', 'Equipment prep'],
  };
  let season, label;
  if (month >= 2 && month <= 4)       { season = 'spring'; label = '🌱 Spring'; }
  else if (month >= 5 && month <= 7)  { season = 'summer'; label = '☀️ Summer'; }
  else if (month >= 8 && month <= 10) { season = 'fall';   label = '🍂 Fall'; }
  else                                { season = 'winter'; label = '❄️ Winter'; }
  document.getElementById('seasonal-tips').innerHTML =
    `<strong style="color:var(--brand-dark)">${label} Recommendations:</strong><ul style="margin:.5rem 0 0 1.25rem">` +
    tips[season].map(t => `<li>${t}</li>`).join('') + '</ul>';
}

// ── Spray Jobs ──
async function loadSprayJobs() {
  const params = new URLSearchParams();
  const s   = document.getElementById('sf-start')?.value;
  const e   = document.getElementById('sf-end')?.value;
  const c   = document.getElementById('sf-client')?.value;
  const sv  = document.getElementById('sf-service')?.value;
  const emp = document.getElementById('sf-employee')?.value;
  if (s)   params.set('startDate', s);
  if (e)   params.set('endDate', e);
  if (c)   params.set('client', c);
  if (sv)  params.set('serviceType', sv);
  if (emp) params.set('employeeId', emp);
  allSprayJobs = await get('/api/spray/jobs?' + params);
  const tbody = document.getElementById('spray-jobs-tbody');
  if (!allSprayJobs.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="table-empty">No spray jobs found</td></tr>'; return;
  }
  tbody.innerHTML = allSprayJobs.map(j => {
    const total = calcDuration(j.start_time, j.end_time);
    return `<tr>
      <td>${j.job_date ? fmtDateStr(j.job_date) : '<span class="text-muted">—</span>'}</td>
      <td><strong>${esc(j.client_name || '')}</strong>${j.client_phone ? `<br><span style="font-size:.75rem;color:var(--gray-500)">${esc(j.client_phone)}</span>` : ''}</td>
      <td>${j.address ? esc(j.address) : '<span class="text-muted">—</span>'}</td>
      <td>${j.service_type ? `<span class="badge badge-success">${esc(j.service_type)}</span>` : '<span class="text-muted">—</span>'}</td>
      <td>${j.product_used ? esc(j.product_used) : '<span class="text-muted">—</span>'}</td>
      <td>${j.employee_name ? esc(j.employee_name) : '<span class="text-muted">—</span>'}</td>
      <td>${j.start_time || '<span class="text-muted">—</span>'}</td>
      <td>${j.end_time || '<span class="text-muted">—</span>'}</td>
      <td>${total || '<span class="text-muted">—</span>'}</td>
      <td>${j.next_service_date ? fmtDateStr(j.next_service_date) : '<span class="text-muted">—</span>'}</td>
      <td>${j.notes ? esc(j.notes) : '<span class="text-muted">—</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-outline btn-sm" onclick="openEditSprayJob(${j.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteSprayJob(${j.id})">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

async function addSprayJob() {
  const clientName = document.getElementById('sj-client').value.trim();
  if (!clientName) { showModalErr('spray-add-err', 'Client name required.'); return; }
  const empSel  = document.getElementById('sj-employee');
  const empName = empSel.options[empSel.selectedIndex]?.text || '';
  const body = {
    clientName,
    clientPhone:     document.getElementById('sj-phone').value.trim(),
    address:         document.getElementById('sj-address').value.trim(),
    serviceType:     document.getElementById('sj-service').value,
    productUsed:     document.getElementById('sj-product').value.trim(),
    employeeId:      empSel.value || null,
    employeeName:    empSel.value ? empName : '',
    jobDate:         document.getElementById('sj-date').value,
    startTime:       document.getElementById('sj-start').value,
    endTime:         document.getElementById('sj-end').value,
    notes:           document.getElementById('sj-notes').value.trim(),
    nextServiceDate: document.getElementById('sj-next').value,
    weatherNotes:    document.getElementById('sj-weather').value.trim(),
  };
  const r = await post('/api/spray/jobs', body);
  if (r.success) {
    ['sj-client','sj-phone','sj-address','sj-product','sj-date','sj-start','sj-end','sj-notes','sj-next','sj-weather'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('sj-service').value = '';
    document.getElementById('sj-employee').value = '';
    showAlert('Spray job saved.', 'success');
    loadSprayJobs(); loadClients(); loadFollowups();
  } else {
    showModalErr('spray-add-err', r.message || 'Failed to save.');
  }
}

function openEditSprayJob(id) {
  const j = allSprayJobs.find(j => j.id === id);
  if (!j) return;
  document.getElementById('esj-id').value      = id;
  document.getElementById('esj-client').value  = j.client_name || '';
  document.getElementById('esj-phone').value   = j.client_phone || '';
  document.getElementById('esj-address').value = j.address || '';
  document.getElementById('esj-service').value = j.service_type || '';
  document.getElementById('esj-product').value = j.product_used || '';
  document.getElementById('esj-date').value    = j.job_date ? j.job_date.split('T')[0] : '';
  document.getElementById('esj-start').value   = j.start_time || '';
  document.getElementById('esj-end').value     = j.end_time || '';
  document.getElementById('esj-next').value    = j.next_service_date ? j.next_service_date.split('T')[0] : '';
  document.getElementById('esj-weather').value = j.weather_notes || '';
  document.getElementById('esj-notes').value   = j.notes || '';
  // Populate employee dropdown and select current
  const empSel = document.getElementById('esj-employee');
  empSel.innerHTML = '<option value="">— Select —</option>' +
    allWorkers.map(w => `<option value="${w.id}" ${w.id == j.employee_id ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  openModal('m-edit-spray');
}

async function saveSprayJob() {
  const id      = document.getElementById('esj-id').value;
  const empSel  = document.getElementById('esj-employee');
  const empName = empSel.value ? (empSel.options[empSel.selectedIndex]?.text || '') : '';
  const body = {
    clientName:      document.getElementById('esj-client').value.trim(),
    clientPhone:     document.getElementById('esj-phone').value.trim(),
    address:         document.getElementById('esj-address').value.trim(),
    serviceType:     document.getElementById('esj-service').value,
    productUsed:     document.getElementById('esj-product').value.trim(),
    employeeId:      empSel.value || null,
    employeeName:    empName,
    jobDate:         document.getElementById('esj-date').value,
    startTime:       document.getElementById('esj-start').value,
    endTime:         document.getElementById('esj-end').value,
    nextServiceDate: document.getElementById('esj-next').value,
    weatherNotes:    document.getElementById('esj-weather').value.trim(),
    notes:           document.getElementById('esj-notes').value.trim(),
  };
  const r = await put(`/api/spray/jobs/${id}`, body);
  if (r.success) { closeModal('m-edit-spray'); loadSprayJobs(); loadFollowups(); showAlert('Spray job updated.', 'success'); }
}

async function deleteSprayJob(id) {
  if (!confirm('Delete this spray job?')) return;
  await del(`/api/spray/jobs/${id}`);
  showAlert('Spray job deleted.', 'success');
  loadSprayJobs(); loadFollowups();
}

function exportSprayCSV() {
  if (!allSprayJobs.length) { showAlert('No jobs to export. Apply filters first.', 'warning'); return; }
  const hdr = ['Date','Client','Phone','Address','Service Type','Product','Employee','Start','End','Total Time','Next Service','Weather','Notes'];
  const rows = allSprayJobs.map(j => [
    j.job_date || '', j.client_name || '', j.client_phone || '', j.address || '',
    j.service_type || '', j.product_used || '', j.employee_name || '',
    j.start_time || '', j.end_time || '', calcDuration(j.start_time, j.end_time) || '',
    j.next_service_date || '', j.weather_notes || '', j.notes || ''
  ]);
  dlCSV([hdr,...rows], `spray-jobs-${new Date().toISOString().split('T')[0]}.csv`);
}

// ── Clients ──
async function loadClients() {
  const clients = await get('/api/spray/clients');
  const tbody = document.getElementById('clients-tbody');
  if (!clients.length) { tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No clients yet</td></tr>'; return; }
  tbody.innerHTML = clients.map(c => `
    <tr>
      <td><strong>${esc(c.name)}</strong></td>
      <td>${c.phone ? esc(c.phone) : '<span class="text-muted">—</span>'}</td>
      <td>${c.address ? esc(c.address) : '<span class="text-muted">—</span>'}</td>
      <td>${c.last_service_date ? fmtDateStr(c.last_service_date) : '<span class="text-muted">—</span>'}</td>
      <td>${c.last_product ? esc(c.last_product) : '<span class="text-muted">—</span>'}</td>
      <td>${c.next_service_date ? fmtDateStr(c.next_service_date) : '<span class="text-muted">—</span>'}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="openEditClient(${c.id},'${esc(c.name)}','${esc(c.phone||'')}','${esc(c.address||'')}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteClient(${c.id},'${esc(c.name)}')">Delete</button>
      </td>
    </tr>`).join('');
}

async function addClient() {
  const name = document.getElementById('nc-name').value.trim();
  if (!name) { showModalErr('add-client-err', 'Client name required.'); return; }
  const r = await post('/api/spray/clients', {
    name,
    phone:   document.getElementById('nc-phone').value.trim(),
    address: document.getElementById('nc-address').value.trim(),
  });
  if (r.success) {
    closeModal('m-add-client');
    ['nc-name','nc-phone','nc-address'].forEach(id => document.getElementById(id).value = '');
    loadClients();
    showAlert(`Client "${name}" added.`, 'success');
  } else {
    showModalErr('add-client-err', r.message || 'Failed.');
  }
}

function openEditClient(id, name, phone, address) {
  document.getElementById('ec-id').value      = id;
  document.getElementById('ec-name').value    = name;
  document.getElementById('ec-phone').value   = phone;
  document.getElementById('ec-address').value = address;
  openModal('m-edit-client');
}

async function saveClient() {
  const id = document.getElementById('ec-id').value;
  await put(`/api/spray/clients/${id}`, {
    name:    document.getElementById('ec-name').value.trim(),
    phone:   document.getElementById('ec-phone').value.trim(),
    address: document.getElementById('ec-address').value.trim(),
  });
  closeModal('m-edit-client');
  loadClients();
  showAlert('Client updated.', 'success');
}

async function deleteClient(id, name) {
  if (!confirm(`Delete client "${name}"?`)) return;
  await del(`/api/spray/clients/${id}`);
  loadClients();
  showAlert(`Client "${name}" deleted.`, 'success');
}

// ── Products ──
async function loadProducts() {
  const products = await get('/api/spray/products');
  const tbody = document.getElementById('products-tbody');
  if (!products.length) { tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No products yet</td></tr>'; return; }
  tbody.innerHTML = products.map(p => `
    <tr>
      <td><strong>${esc(p.name)}</strong></td>
      <td>${p.type ? esc(p.type) : '<span class="text-muted">—</span>'}</td>
      <td>${p.reapply_window ? esc(p.reapply_window) : '<span class="text-muted">—</span>'}</td>
      <td>${p.notes ? esc(p.notes) : '<span class="text-muted">—</span>'}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="openEditProduct(${p.id},'${esc(p.name)}','${esc(p.type||'')}','${esc(p.reapply_window||'')}','${esc(p.notes||'')}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteProduct(${p.id},'${esc(p.name)}')">Delete</button>
      </td>
    </tr>`).join('');
}

async function addProduct() {
  const name = document.getElementById('np-name').value.trim();
  if (!name) { showModalErr('add-product-err', 'Product name required.'); return; }
  const r = await post('/api/spray/products', {
    name,
    type:          document.getElementById('np-type').value,
    reapplyWindow: document.getElementById('np-window').value.trim(),
    notes:         document.getElementById('np-notes').value.trim(),
  });
  if (r.success) {
    closeModal('m-add-product');
    ['np-name','np-window','np-notes'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('np-type').value = '';
    loadProducts();
    showAlert(`Product "${name}" added.`, 'success');
  } else {
    showModalErr('add-product-err', r.message || 'Failed.');
  }
}

function openEditProduct(id, name, type, reapplyWindow, notes) {
  document.getElementById('ep-id').value     = id;
  document.getElementById('ep-name').value   = name;
  document.getElementById('ep-type').value   = type;
  document.getElementById('ep-window').value = reapplyWindow;
  document.getElementById('ep-notes').value  = notes;
  openModal('m-edit-product');
}

async function saveProduct() {
  const id = document.getElementById('ep-id').value;
  await put(`/api/spray/products/${id}`, {
    name:          document.getElementById('ep-name').value.trim(),
    type:          document.getElementById('ep-type').value,
    reapplyWindow: document.getElementById('ep-window').value.trim(),
    notes:         document.getElementById('ep-notes').value.trim(),
  });
  closeModal('m-edit-product');
  loadProducts();
  showAlert('Product updated.', 'success');
}

async function deleteProduct(id, name) {
  if (!confirm(`Delete product "${name}"?`)) return;
  await del(`/api/spray/products/${id}`);
  loadProducts();
  showAlert(`Product "${name}" deleted.`, 'success');
}

// ── Follow-ups ──
async function loadFollowups() {
  const followups = await get('/api/spray/followups');
  const tbody = document.getElementById('followups-tbody');
  if (!followups.length) { tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No upcoming follow-ups</td></tr>'; return; }
  tbody.innerHTML = followups.map(f => {
    const statusClass = f.status === 'Overdue' ? 'badge-danger' : f.status === 'Due Soon' ? 'badge-amber' : 'badge-success';
    return `<tr>
      <td><strong>${esc(f.client_name || '')}</strong></td>
      <td>${f.address ? esc(f.address) : '<span class="text-muted">—</span>'}</td>
      <td>${f.service_type ? esc(f.service_type) : '<span class="text-muted">—</span>'}</td>
      <td>${f.next_service_date ? fmtDateStr(f.next_service_date) : '<span class="text-muted">—</span>'}</td>
      <td>${f.product_used ? esc(f.product_used) : '<span class="text-muted">—</span>'}</td>
      <td><span class="badge ${statusClass}">${f.status}</span></td>
      <td></td>
    </tr>`;
  }).join('');
}

// ── Helpers ──
function workerColor(name) {
  const colors = ['#1f8f3a','#2563eb','#7c3aed','#db2777','#d97706','#0891b2','#059669','#dc2626'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function workerAvatar(name, extraClass = '') {
  const initials = name.trim().split(/\s+/).map(n => n[0]).join('').slice(0, 2).toUpperCase();
  const color = workerColor(name);
  return `<span class="worker-avatar ${extraClass}" style="background:${color}">${initials}</span>`;
}

function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function calcDuration(start, end) {
  if (!start || !end) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) return null;
  const h = Math.floor(mins / 60), m = mins % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function dlCSV(rows, filename) {
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv],{type:'text/csv'})),
    download: filename
  });
  a.click();
}

function fmtElapsed(ms) {
  const s = Math.floor(ms/1000);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function fmtDur(m) {
  if (!m) return '—';
  const h = Math.floor(m/60), min = m%60;
  return h === 0 ? `${min}m` : min === 0 ? `${h}h` : `${h}h ${min}m`;
}
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}) : ''; }
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'}) : ''; }
function fmtDateStr(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});
}
function fmtDateTime(iso) { const d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString(); }
function pad(n) { return String(n).padStart(2,'0'); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function show(id) { document.getElementById(id).classList.remove('section-hidden'); }
function hide(id) { document.getElementById(id).classList.add('section-hidden'); }

function showAlert(msg, type) {
  const el = document.getElementById('admin-alert');
  el.className = `alert alert-${type==='error'?'error':type==='warning'?'warning':'success'}`;
  el.textContent = msg; show('admin-alert');
  setTimeout(() => hide('admin-alert'), 5000);
}
function showModalErr(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; show(id); }
}

async function get(url) { const r = await fetch(url); return r.json(); }
async function post(url, body) {
  const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return r.json();
}
async function put(url, body) {
  const r = await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return r.json();
}
async function del(url) {
  const r = await fetch(url,{method:'DELETE'});
  return r.json();
}
