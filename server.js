const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'rsvps.db');
const EXCEL_PATH = path.join(DATA_DIR, 'rsvp-list.xlsx');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
// db setup and seeding

db.serialize(() => {

  // RSVP table
  db.run(`
    CREATE TABLE IF NOT EXISTS rsvps (
      phone_number TEXT PRIMARY KEY,
      guest_name TEXT,
      attendance_status TEXT NOT NULL CHECK(attendance_status IN ('Yes','Maybe','No')),
      host_message TEXT,
      submitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Guest whitelist
  db.run(`
    CREATE TABLE IF NOT EXISTS guest_list (
      phone TEXT PRIMARY KEY,
      guest_name TEXT
    )
  `);

  // Placeholder guests
  const guests = [
    ['6131111111', 'Ahmed'],
    ['6132222222', 'Omar'],
    ['6133333333', 'Yusuf'],
    ['6134444444', 'Hassan']
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO guest_list (phone, guest_name)
    VALUES (?, ?)
  `);

  guests.forEach(([phone, name]) => {
    stmt.run(phone, name);
  });

  stmt.finalize();
});



app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

//  Helper to clean phone numbers to digits only

function normalizePhone(input = '') {
  return input.replace(/\D/g, '').trim();
}

// Generates an Excel snapshot of the current RSVP data

function writeExcelSnapshot() {
  db.all(
    `
    SELECT 
      g.phone,
      g.guest_name AS invited_name,
      r.guest_name AS submitted_name,
      r.attendance_status,
      r.host_message,
      r.updated_at
    FROM guest_list g
    LEFT JOIN rsvps r 
      ON g.phone = r.phone_number
    ORDER BY g.guest_name ASC
    `,
    [],
    (err, rows) => {
      if (err) {
        console.error('Excel export failed:', err.message);
        return;
      }

      const formatted = rows.map(row => ({
        Phone: row.phone,
        Invited_Name: row.invited_name,
        Submitted_Name: row.submitted_name || '',
        RSVP_Status: row.attendance_status || 'No Response',
        Message: row.host_message || '',
        Updated_At: row.updated_at || ''
      }));

      const worksheet = XLSX.utils.json_to_sheet(formatted);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'RSVP List');

      XLSX.writeFile(workbook, EXCEL_PATH);
    }
  );
}

// route

app.get('/', (req, res) => {
  res.render('index', {
    success: req.query.success || null,
    error: req.query.error || null
  });
});
app.get('/thank-you', (req, res) => {
  res.render('thank-you');
});
app.get('/error', (req, res) => {
  res.redirect('/?error=1');
});
// RSVP submission route

app.post('/rsvp', (req, res) => {
  const attendanceStatus = (req.body.attendance || '').trim();
  const hostMessage = (req.body.message || '').trim();
  const phoneNumber = normalizePhone(req.body.contact || '');
  const now = new Date().toISOString();

  if (!attendanceStatus || !phoneNumber) {
    return res.redirect('/error');
  }

  if (!['Yes', 'Maybe', 'No'].includes(attendanceStatus)) {
    return res.redirect('/error');
  }

  if (phoneNumber.length < 10) {
    return res.redirect('/error');
  }
  if (hostMessage.length > 250) {
  return res.redirect('/?error=1');
}
  // 🔒 WHITELIST CHECK
  db.get(
    `SELECT * FROM guest_list WHERE phone = ?`,
    [phoneNumber],
    (err, guest) => {

      if (err) {
        console.error(err);
        return res.redirect('/error');
      }

      if (!guest) {
        return res.redirect('/error');
      }

      // ✅ Use trusted name from DB
      const guestName = guest.guest_name;

      const insertOrUpdate = `
        INSERT INTO rsvps (
          phone_number,
          guest_name,
          attendance_status,
          host_message,
          submitted_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(phone_number) DO UPDATE SET
          attendance_status = excluded.attendance_status,
          host_message = excluded.host_message,
          updated_at = excluded.updated_at
      `;

      db.run(
        insertOrUpdate,
        [
          phoneNumber,
          guestName,
          attendanceStatus,
          hostMessage,
          now,
          now
        ],
        function (err) {
          if (err) {
            console.error(err);
            return res.redirect('/error');
          }

          writeExcelSnapshot();
          return res.redirect('/thank-you');
        }
      );
    }
  );
});

//admin route

app.get('/admin/full', (req, res) => {
  db.all(
    `
    SELECT 
      g.phone,
      g.guest_name,
      r.attendance_status
    FROM guest_list g
    LEFT JOIN rsvps r 
      ON g.phone = r.phone_number
    ORDER BY g.guest_name
    `,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to load list' });
      }

      res.render('admin', { rows });
    }
  );
});

app.get('/admin/full', (req, res) => {
  const password = req.query.key;

  if (password !== ADMIN_PASSWORD) {
    return res.status(403).send('Unauthorized');
  }

  db.all(
    `
    SELECT 
      g.phone,
      g.guest_name,
      r.attendance_status
    FROM guest_list g
    LEFT JOIN rsvps r 
      ON g.phone = r.phone_number
    ORDER BY g.guest_name
    `,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).send('Failed to load list');
      }

      res.render('admin', { rows });
    }
  );
});



app.listen(PORT, () => {
  writeExcelSnapshot();
  console.log(`Server running on http://localhost:${PORT}`);
});