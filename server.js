const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Worker auth ──
app.post('/api/auth/login', async (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ success: false, message: 'Name and PIN required.' });
  const worker = await db.getWorkerByCredentials(name.trim(), pin.trim());
  if (worker) {
    res.json({ success: true, worker: { id: worker.id, name: worker.name, payRate: worker.pay_rate } });
  } else {
    res.status(401).json({ success: false, message: 'Invalid name or PIN.' });
  }
});

// ── Admin auth ──
app.post('/api/admin/auth', async (req, res) => {
  const { password } = req.body;
  if (await db.checkAdminPassword(password)) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid password.' });
  }
});

// ── Locations ──
app.get('/api/locations', async (req, res) => res.json(await db.getLocations()));

// ── Clock in/out ──
app.post('/api/entries/clock-in', async (req, res) => {
  const { workerId, locationId, latitude, longitude, notes } = req.body;
  if (!workerId || !locationId) return res.status(400).json({ success: false, message: 'Missing required fields.' });
  if (await db.getCurrentEntry(workerId)) return res.status(400).json({ success: false, message: 'Already clocked in.' });
  const entry = await db.clockIn(workerId, locationId, latitude, longitude, notes);
  res.json({ success: true, entry });
});

app.post('/api/entries/clock-out', async (req, res) => {
  const { workerId, latitude, longitude, notes } = req.body;
  const current = await db.getCurrentEntry(workerId);
  if (!current) return res.status(400).json({ success: false, message: 'Not currently clocked in.' });
  const entry = await db.clockOut(current.id, latitude, longitude, notes);
  res.json({ success: true, entry });
});

app.get('/api/entries/current/:workerId', async (req, res) => {
  res.json({ entry: await db.getCurrentEntry(req.params.workerId) });
});

app.get('/api/entries/worker/:workerId', async (req, res) => {
  const { startDate, endDate } = req.query;
  res.json(await db.getWorkerEntries(req.params.workerId, startDate, endDate));
});

// ── Admin: stats & active ──
app.get('/api/admin/stats', async (req, res) => res.json(await db.getStats()));
app.get('/api/admin/active', async (req, res) => res.json(await db.getActiveEntries()));

// ── Admin: charts ──
app.get('/api/admin/charts', async (req, res) => res.json(await db.getChartData()));

// ── Admin: payroll ──
app.get('/api/admin/payroll', async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ success: false, message: 'startDate and endDate required.' });
  res.json(await db.getPayrollReport(startDate, endDate));
});

// ── Admin: entries ──
app.get('/api/admin/entries', async (req, res) => {
  const { workerId, locationId, startDate, endDate } = req.query;
  res.json(await db.getAllEntries({ workerId, locationId, startDate, endDate }));
});

app.put('/api/admin/entries/:id', async (req, res) => {
  const { workerId, locationId, clockIn, clockOut, notes } = req.body;
  const entry = await db.updateEntry(req.params.id, { workerId, locationId, clockIn, clockOut, notes });
  res.json({ success: true, entry });
});

app.post('/api/admin/entries/:id/clock-out', async (req, res) => {
  const entry = await db.clockOut(req.params.id, null, null, 'Clocked out by admin');
  res.json({ success: true, entry });
});

// ── Admin: workers ──
app.get('/api/admin/workers', async (req, res) => res.json(await db.getWorkers()));

app.post('/api/admin/workers', async (req, res) => {
  const { name, pin, payRate } = req.body;
  if (!name || !pin) return res.status(400).json({ success: false, message: 'Name and PIN required.' });
  try {
    res.json({ success: true, worker: await db.addWorker(name.trim(), pin.trim(), payRate) });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

app.put('/api/admin/workers/:id', async (req, res) => {
  const { name, pin, payRate } = req.body;
  await db.updateWorker(req.params.id, name, pin || null, payRate);
  res.json({ success: true });
});

app.delete('/api/admin/workers/:id', async (req, res) => {
  await db.deleteWorker(req.params.id);
  res.json({ success: true });
});

// ── Admin: locations ──
app.post('/api/admin/locations', async (req, res) => {
  const { name, address } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Name required.' });
  res.json({ success: true, location: await db.addLocation(name.trim(), address) });
});

app.delete('/api/admin/locations/:id', async (req, res) => {
  await db.deleteLocation(req.params.id);
  res.json({ success: true });
});

// ── Admin: password ──
app.put('/api/admin/settings/password', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ success: false, message: 'Password required.' });
  await db.updateAdminPassword(password);
  res.json({ success: true });
});

// ── Spray: clients ──
app.get('/api/spray/clients', async (req, res) => res.json(await db.getSprayClients()));

app.post('/api/spray/clients', async (req, res) => {
  const { name, phone, address } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Client name required.' });
  res.json({ success: true, client: await db.addSprayClient(name.trim(), phone, address) });
});

app.put('/api/spray/clients/:id', async (req, res) => {
  const { name, phone, address } = req.body;
  await db.updateSprayClient(req.params.id, name, phone, address);
  res.json({ success: true });
});

app.delete('/api/spray/clients/:id', async (req, res) => {
  await db.deleteSprayClient(req.params.id);
  res.json({ success: true });
});

// ── Spray: products ──
app.get('/api/spray/products', async (req, res) => res.json(await db.getSprayProducts()));

app.post('/api/spray/products', async (req, res) => {
  const { name, type, reapplyWindow, notes } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Product name required.' });
  res.json({ success: true, product: await db.addSprayProduct(name.trim(), type, reapplyWindow, notes) });
});

app.put('/api/spray/products/:id', async (req, res) => {
  const { name, type, reapplyWindow, notes } = req.body;
  await db.updateSprayProduct(req.params.id, name, type, reapplyWindow, notes);
  res.json({ success: true });
});

app.delete('/api/spray/products/:id', async (req, res) => {
  await db.deleteSprayProduct(req.params.id);
  res.json({ success: true });
});

// ── Spray: jobs ──
app.get('/api/spray/jobs', async (req, res) => {
  const { startDate, endDate, client, serviceType, employeeId } = req.query;
  res.json(await db.getSprayJobs({ startDate, endDate, client, serviceType, employeeId }));
});

app.post('/api/spray/jobs', async (req, res) => {
  const job = req.body;
  if (!job.clientName) return res.status(400).json({ success: false, message: 'Client name required.' });
  res.json({ success: true, job: await db.addSprayJob(job) });
});

app.put('/api/spray/jobs/:id', async (req, res) => {
  await db.updateSprayJob(req.params.id, req.body);
  res.json({ success: true });
});

app.delete('/api/spray/jobs/:id', async (req, res) => {
  await db.deleteSprayJob(req.params.id);
  res.json({ success: true });
});

// ── Spray: follow-ups ──
app.get('/api/spray/followups', async (req, res) => res.json(await db.getSprayFollowups()));

const PORT = process.env.PORT || 3000;
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Legacy Landscape Management running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to connect to database:', err.message);
  process.exit(1);
});
