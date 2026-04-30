const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      pin TEXT NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS time_entries (
      id SERIAL PRIMARY KEY,
      worker_id INTEGER REFERENCES workers(id),
      location_id INTEGER REFERENCES locations(id),
      clock_in TIMESTAMPTZ NOT NULL,
      clock_out TIMESTAMPTZ,
      clock_in_lat REAL,
      clock_in_lng REAL,
      clock_out_lat REAL,
      clock_out_lng REAL,
      duration_minutes INTEGER,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS spray_clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS spray_products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      reapply_window TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS spray_jobs (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES spray_clients(id) ON DELETE SET NULL,
      client_name TEXT,
      client_phone TEXT,
      address TEXT,
      service_type TEXT,
      product_used TEXT,
      employee_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
      employee_name TEXT,
      job_date DATE,
      start_time TEXT,
      end_time TEXT,
      notes TEXT,
      next_service_date DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO settings (key,value) VALUES ('admin_password','admin1234') ON CONFLICT DO NOTHING;
  `);

  // Safe migrations — add new columns only if they don't exist
  await pool.query(`
    ALTER TABLE workers ADD COLUMN IF NOT EXISTS pay_rate NUMERIC(10,2);
    ALTER TABLE spray_jobs ADD COLUMN IF NOT EXISTS weather_notes TEXT;
  `);
}

module.exports = {
  init,

  // ── Auth ──
  async getWorkerByCredentials(name, pin) {
    const r = await pool.query('SELECT * FROM workers WHERE name=$1 AND pin=$2 AND active=TRUE', [name, pin]);
    return r.rows[0] || null;
  },
  async checkAdminPassword(password) {
    const r = await pool.query("SELECT value FROM settings WHERE key='admin_password'");
    return r.rows[0]?.value === password;
  },
  async updateAdminPassword(password) {
    await pool.query("UPDATE settings SET value=$1 WHERE key='admin_password'", [password]);
  },

  // ── Workers ──
  async getWorkers() {
    const r = await pool.query('SELECT id,name,pay_rate,active,created_at FROM workers WHERE active=TRUE ORDER BY name');
    return r.rows;
  },
  async addWorker(name, pin, payRate) {
    try {
      const r = await pool.query(
        'INSERT INTO workers (name,pin,pay_rate) VALUES ($1,$2,$3) RETURNING id,name,pay_rate',
        [name, pin, payRate || null]
      );
      return r.rows[0];
    } catch {
      throw new Error('A worker with that name already exists.');
    }
  },
  async updateWorker(id, name, pin, payRate) {
    if (pin) {
      await pool.query('UPDATE workers SET name=$1,pin=$2,pay_rate=$3 WHERE id=$4', [name, pin, payRate || null, id]);
    } else {
      await pool.query('UPDATE workers SET name=$1,pay_rate=$2 WHERE id=$3', [name, payRate || null, id]);
    }
  },
  async deleteWorker(id) {
    await pool.query('UPDATE workers SET active=FALSE WHERE id=$1', [id]);
  },

  // ── Locations ──
  async getLocations() {
    const r = await pool.query('SELECT * FROM locations WHERE active=TRUE ORDER BY name');
    return r.rows;
  },
  async addLocation(name, address) {
    const r = await pool.query('INSERT INTO locations (name,address) VALUES ($1,$2) RETURNING *', [name, address || null]);
    return r.rows[0];
  },
  async deleteLocation(id) {
    await pool.query('UPDATE locations SET active=FALSE WHERE id=$1', [id]);
  },

  // ── Time Entries ──
  async clockIn(workerId, locationId, lat, lng, notes) {
    const r = await pool.query(
      'INSERT INTO time_entries (worker_id,location_id,clock_in,clock_in_lat,clock_in_lng,notes) VALUES ($1,$2,NOW(),$3,$4,$5) RETURNING id,clock_in',
      [workerId, locationId, lat || null, lng || null, notes || null]
    );
    return r.rows[0];
  },
  async updateEntry(id, { workerId, locationId, clockIn, clockOut, notes }) {
    const r = await pool.query(`
      UPDATE time_entries SET
        worker_id=$2,
        location_id=$3,
        clock_in=$4,
        clock_out=$5,
        duration_minutes=CASE WHEN $5::timestamptz IS NOT NULL
          THEN ROUND(EXTRACT(EPOCH FROM ($5::timestamptz - $4::timestamptz))/60)
          ELSE NULL END,
        notes=$6
      WHERE id=$1
      RETURNING *
    `, [id, workerId, locationId, clockIn, clockOut || null, notes || null]);
    return r.rows[0];
  },
  async clockOut(entryId, lat, lng, notes) {
    const r = await pool.query(`
      UPDATE time_entries SET
        clock_out=NOW(),
        clock_out_lat=$2,
        clock_out_lng=$3,
        duration_minutes=ROUND(EXTRACT(EPOCH FROM (NOW()-clock_in))/60),
        notes=$4
      WHERE id=$1
      RETURNING id,clock_out,duration_minutes
    `, [entryId, lat || null, lng || null, notes || null]);
    return r.rows[0];
  },
  async getCurrentEntry(workerId) {
    const r = await pool.query(`
      SELECT te.*,l.name as location_name
      FROM time_entries te
      JOIN locations l ON te.location_id=l.id
      WHERE te.worker_id=$1 AND te.clock_out IS NULL
    `, [workerId]);
    return r.rows[0] || null;
  },
  async getActiveEntries() {
    const r = await pool.query(`
      SELECT te.*,l.name as location_name,w.name as worker_name
      FROM time_entries te
      JOIN locations l ON te.location_id=l.id
      JOIN workers w ON te.worker_id=w.id
      WHERE te.clock_out IS NULL
      ORDER BY te.clock_in
    `);
    return r.rows;
  },
  async getWorkerEntries(workerId, startDate, endDate) {
    let q = `
      SELECT te.*,l.name as location_name
      FROM time_entries te
      JOIN locations l ON te.location_id=l.id
      WHERE te.worker_id=$1
    `;
    const p = [workerId]; let i = 2;
    if (startDate) { q += ` AND te.clock_in::date>=$${i++}`; p.push(startDate); }
    if (endDate)   { q += ` AND te.clock_in::date<=$${i++}`; p.push(endDate); }
    q += ' ORDER BY te.clock_in DESC LIMIT 100';
    const r = await pool.query(q, p);
    return r.rows;
  },
  async getAllEntries({ workerId, locationId, startDate, endDate }) {
    let q = `
      SELECT te.*,l.name as location_name,w.name as worker_name
      FROM time_entries te
      JOIN locations l ON te.location_id=l.id
      JOIN workers w ON te.worker_id=w.id
      WHERE 1=1
    `;
    const p = []; let i = 1;
    if (workerId)   { q += ` AND te.worker_id=$${i++}`;       p.push(workerId); }
    if (locationId) { q += ` AND te.location_id=$${i++}`;     p.push(locationId); }
    if (startDate)  { q += ` AND te.clock_in::date>=$${i++}`; p.push(startDate); }
    if (endDate)    { q += ` AND te.clock_in::date<=$${i++}`; p.push(endDate); }
    q += ' ORDER BY te.clock_in DESC';
    const r = await pool.query(q, p);
    return r.rows;
  },
  async getStats() {
    const [w, a, t, wk] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM workers WHERE active=TRUE'),
      pool.query('SELECT COUNT(*) FROM time_entries WHERE clock_out IS NULL'),
      pool.query("SELECT COALESCE(SUM(duration_minutes),0) as total FROM time_entries WHERE clock_in::date=CURRENT_DATE AND duration_minutes IS NOT NULL"),
      pool.query("SELECT COALESCE(SUM(duration_minutes),0) as total FROM time_entries WHERE clock_in::date>=CURRENT_DATE-6 AND duration_minutes IS NOT NULL"),
    ]);
    return {
      totalWorkers: parseInt(w.rows[0].count),
      clockedIn:    parseInt(a.rows[0].count),
      todayHours:   +(parseInt(t.rows[0].total)  / 60).toFixed(1),
      weekHours:    +(parseInt(wk.rows[0].total) / 60).toFixed(1),
    };
  },

  // ── Payroll ──
  async getPayrollReport(startDate, endDate) {
    const r = await pool.query(`
      SELECT
        w.id, w.name, w.pay_rate,
        COUNT(te.id) as entry_count,
        COALESCE(SUM(te.duration_minutes), 0) as total_minutes
      FROM workers w
      LEFT JOIN time_entries te ON te.worker_id = w.id
        AND te.clock_in::date >= $1
        AND te.clock_in::date <= $2
        AND te.duration_minutes IS NOT NULL
      WHERE w.active = TRUE
      GROUP BY w.id, w.name, w.pay_rate
      ORDER BY w.name
    `, [startDate, endDate]);
    return r.rows;
  },

  // ── Chart data ──
  async getChartData() {
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const [workerHours, trend] = await Promise.all([
      pool.query(`
        SELECT w.name, COALESCE(SUM(te.duration_minutes), 0) as total_minutes
        FROM workers w
        LEFT JOIN time_entries te ON te.worker_id = w.id
          AND te.clock_in::date >= $1
          AND te.duration_minutes IS NOT NULL
        WHERE w.active = TRUE
        GROUP BY w.id, w.name
        ORDER BY total_minutes DESC
      `, [weekStartStr]),
      pool.query(`
        SELECT
          DATE_TRUNC('week', clock_in)::date as week_start,
          COALESCE(SUM(duration_minutes), 0) as total_minutes
        FROM time_entries
        WHERE clock_in >= NOW() - INTERVAL '8 weeks'
          AND duration_minutes IS NOT NULL
        GROUP BY DATE_TRUNC('week', clock_in)
        ORDER BY week_start
      `),
    ]);

    return {
      workerHours: workerHours.rows,
      weeklyTrend: trend.rows,
    };
  },

  // ── Spray Clients ──
  async getSprayClients() {
    const r = await pool.query(`
      SELECT sc.*,
        (SELECT sj.job_date FROM spray_jobs sj WHERE sj.client_id=sc.id ORDER BY sj.job_date DESC LIMIT 1) as last_service_date,
        (SELECT sj.product_used FROM spray_jobs sj WHERE sj.client_id=sc.id ORDER BY sj.job_date DESC LIMIT 1) as last_product,
        (SELECT sj.next_service_date FROM spray_jobs sj WHERE sj.client_id=sc.id ORDER BY sj.job_date DESC LIMIT 1) as next_service_date
      FROM spray_clients sc ORDER BY sc.name
    `);
    return r.rows;
  },
  async addSprayClient(name, phone, address) {
    const r = await pool.query(
      'INSERT INTO spray_clients (name,phone,address) VALUES ($1,$2,$3) RETURNING *',
      [name, phone || null, address || null]
    );
    return r.rows[0];
  },
  async updateSprayClient(id, name, phone, address) {
    await pool.query('UPDATE spray_clients SET name=$1,phone=$2,address=$3 WHERE id=$4', [name, phone || null, address || null, id]);
  },
  async deleteSprayClient(id) {
    await pool.query('DELETE FROM spray_clients WHERE id=$1', [id]);
  },

  // ── Spray Products ──
  async getSprayProducts() {
    const r = await pool.query('SELECT * FROM spray_products ORDER BY name');
    return r.rows;
  },
  async addSprayProduct(name, type, reapplyWindow, notes) {
    const r = await pool.query(
      'INSERT INTO spray_products (name,type,reapply_window,notes) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, type || null, reapplyWindow || null, notes || null]
    );
    return r.rows[0];
  },
  async updateSprayProduct(id, name, type, reapplyWindow, notes) {
    await pool.query(
      'UPDATE spray_products SET name=$1,type=$2,reapply_window=$3,notes=$4 WHERE id=$5',
      [name, type || null, reapplyWindow || null, notes || null, id]
    );
  },
  async deleteSprayProduct(id) {
    await pool.query('DELETE FROM spray_products WHERE id=$1', [id]);
  },

  // ── Spray Jobs ──
  async getSprayJobs({ startDate, endDate, client, serviceType, employeeId } = {}) {
    let q = 'SELECT * FROM spray_jobs WHERE 1=1';
    const p = []; let i = 1;
    if (startDate)   { q += ` AND job_date>=$${i++}`;                       p.push(startDate); }
    if (endDate)     { q += ` AND job_date<=$${i++}`;                       p.push(endDate); }
    if (client)      { q += ` AND LOWER(client_name) LIKE LOWER($${i++})`; p.push(`%${client}%`); }
    if (serviceType) { q += ` AND service_type=$${i++}`;                   p.push(serviceType); }
    if (employeeId)  { q += ` AND employee_id=$${i++}`;                    p.push(employeeId); }
    q += ' ORDER BY job_date DESC, created_at DESC';
    const r = await pool.query(q, p);
    return r.rows;
  },
  async addSprayJob({ clientId, clientName, clientPhone, address, serviceType, productUsed, employeeId, employeeName, jobDate, startTime, endTime, notes, nextServiceDate, weatherNotes }) {
    const r = await pool.query(`
      INSERT INTO spray_jobs
        (client_id,client_name,client_phone,address,service_type,product_used,employee_id,employee_name,job_date,start_time,end_time,notes,next_service_date,weather_notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [clientId||null, clientName||null, clientPhone||null, address||null, serviceType||null, productUsed||null,
        employeeId||null, employeeName||null, jobDate||null, startTime||null, endTime||null, notes||null, nextServiceDate||null, weatherNotes||null]);
    return r.rows[0];
  },
  async updateSprayJob(id, { clientName, clientPhone, address, serviceType, productUsed, employeeId, employeeName, jobDate, startTime, endTime, notes, nextServiceDate, weatherNotes }) {
    await pool.query(`
      UPDATE spray_jobs SET
        client_name=$2, client_phone=$3, address=$4, service_type=$5,
        product_used=$6, employee_id=$7, employee_name=$8, job_date=$9,
        start_time=$10, end_time=$11, notes=$12, next_service_date=$13,
        weather_notes=$14
      WHERE id=$1
    `, [id, clientName||null, clientPhone||null, address||null, serviceType||null,
        productUsed||null, employeeId||null, employeeName||null, jobDate||null,
        startTime||null, endTime||null, notes||null, nextServiceDate||null, weatherNotes||null]);
  },
  async deleteSprayJob(id) {
    await pool.query('DELETE FROM spray_jobs WHERE id=$1', [id]);
  },

  // ── Follow-ups ──
  async getSprayFollowups() {
    const r = await pool.query(`
      SELECT DISTINCT ON (client_name, address)
        id, client_name, address, service_type, product_used, next_service_date,
        CASE
          WHEN next_service_date < CURRENT_DATE THEN 'Overdue'
          WHEN next_service_date <= CURRENT_DATE + 14 THEN 'Due Soon'
          ELSE 'Upcoming'
        END as status
      FROM spray_jobs
      WHERE next_service_date IS NOT NULL
      ORDER BY client_name, address, next_service_date ASC
    `);
    return r.rows;
  },
};
