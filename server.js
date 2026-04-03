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

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS rsvps (
      phone_number TEXT PRIMARY KEY,
      guest_name TEXT,
      email_or_phone TEXT,
      attendance_status TEXT NOT NULL CHECK(attendance_status IN ('Yes', 'Maybe', 'No')),
      host_message TEXT,
      invite_title TEXT DEFAULT 'Men only - invitation',
      guest_limit INTEGER DEFAULT 1,
      submitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function normalizePhone(input = '') {
  return input.replace(/\D/g, '').trim();
}

function writeExcelSnapshot() {
  db.all(
    `SELECT 
      phone_number,
      guest_name,
      email_or_phone,
      attendance_status,
      host_message,
      guest_limit,
      submitted_at,
      updated_at
     FROM rsvps
     ORDER BY updated_at DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Failed to export Excel:', err.message);
        return;
      }

      const worksheet = XLSX.utils.json_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'RSVPs');
      XLSX.writeFile(workbook, EXCEL_PATH);
    }
  );
}

app.get('/', (req, res) => {
  res.render('index', {
    success: req.query.success,
    error: req.query.error
  });
});

app.post('/rsvp', (req, res) => {
  const guestName = (req.body.name || '').trim();
  const emailOrPhone = (req.body.contact || '').trim();
  const attendanceStatus = (req.body.attendance || '').trim();
  const hostMessage = (req.body.message || '').trim();
  const phoneNumber = normalizePhone(req.body.contact || '');
  const now = new Date().toISOString();

  if (!guestName || !emailOrPhone || !attendanceStatus) {
    return res.redirect('/?error=Please fill in the required fields.');
  }

  if (!['Yes', 'Maybe', 'No'].includes(attendanceStatus)) {
    return res.redirect('/?error=Please select a valid RSVP option.');
  }

  if (!phoneNumber) {
    return res.redirect('/?error=Please enter a valid phone number.');
  }

  const insertOrUpdate = `
    INSERT INTO rsvps (
      phone_number,
      guest_name,
      email_or_phone,
      attendance_status,
      host_message,
      submitted_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone_number) DO UPDATE SET
      guest_name = excluded.guest_name,
      email_or_phone = excluded.email_or_phone,
      attendance_status = excluded.attendance_status,
      host_message = excluded.host_message,
      updated_at = excluded.updated_at
  `;

  db.run(
    insertOrUpdate,
    [
      phoneNumber,
      guestName,
      emailOrPhone,
      attendanceStatus,
      hostMessage,
      now,
      now
    ],
    function (err) {
      if (err) {
        console.error('Failed to save RSVP:', err.message);
        return res.redirect('/?error=Something went wrong while saving the RSVP.');
      }

      writeExcelSnapshot();
      return res.redirect('/?success=RSVP saved successfully.');
    }
  );
});

app.get('/admin/rsvps', (req, res) => {
  db.all('SELECT * FROM rsvps ORDER BY updated_at DESC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Could not load RSVP list.' });
    }

    res.json({
      total: rows.length,
      data: rows
    });
  });
});

app.get('/admin/export', (req, res) => {
  if (!fs.existsSync(EXCEL_PATH)) {
    writeExcelSnapshot();
  }

  setTimeout(() => {
    if (!fs.existsSync(EXCEL_PATH)) {
      return res.status(404).send('No export file available yet.');
    }

    res.download(EXCEL_PATH, 'rsvp-list.xlsx');
  }, 250);
});

app.listen(PORT, () => {
  writeExcelSnapshot();
  console.log(`RSVP app running on http://localhost:${PORT}`);
});
