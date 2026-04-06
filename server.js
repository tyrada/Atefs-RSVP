const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const admin = require('firebase-admin');
const ADMIN_KEY = process.env.ADMIN_KEY;;


const app = express();
const PORT = process.env.PORT || 3000;

// =====================
// FIREBASE SETUP
// =====================

const serviceAccount = requireJSON.parse(process.env.FIREBASE_KEY);


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// =====================
// PATHS
// =====================

const DATA_DIR = path.join(__dirname, 'data');
const EXCEL_PATH = path.join(DATA_DIR, 'rsvp-list.xlsx');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// =====================
// EXPRESS SETUP
// =====================

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =====================
// HELPERS
// =====================

function normalizePhone(input = '') {
  return input.replace(/\D/g, '').trim();
}

// =====================
// SEED GUEST LIST
// =====================

async function seedGuests() {
  const guests = [
    { phone: '6131111111', name: 'Ahmed' },
    { phone: '6132222222', name: 'Omar' },
    { phone: '6133333333', name: 'Yusuf' },
    { phone: '6134444444', name: 'Hassan' }
  ];

  for (const g of guests) {
    await db.collection('guest_list').doc(g.phone).set({
      name: g.name
    }, { merge: true });
  }
}

seedGuests();

// =====================
// EXCEL EXPORT
// =====================

async function writeExcelSnapshot() {
  const guestsSnap = await db.collection('guest_list').get();
  const rsvpSnap = await db.collection('rsvps').get();

  const rsvpMap = {};
  rsvpSnap.forEach(doc => {
    rsvpMap[doc.id] = doc.data();
  });

  const rows = [];

  guestsSnap.forEach(doc => {
    const guest = doc.data();
    const rsvp = rsvpMap[doc.id];

    rows.push({
      Phone: doc.id,
      Invited_Name: guest.name,
      RSVP_Status: rsvp ? rsvp.attendance_status : 'No Response',
      Message: rsvp ? rsvp.host_message : ''
    });
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'RSVP List');

  XLSX.writeFile(workbook, EXCEL_PATH);
}

// =====================
// ROUTES
// =====================

app.get('/', (req, res) => {
  res.render('index', {
    success: req.query.success || null,
    error: req.query.error || null
  });
});

app.get('/thank-you', (req, res) => {
  res.render('thank-you', {type: 'new'});
});

// =====================
// RSVP SUBMISSION
// =====================

app.post('/rsvp', async (req, res) => {
  try {
    const attendanceStatus = (req.body.attendance || '').trim();
    const hostMessage = (req.body.message || '').trim();
    const phoneNumber = normalizePhone(req.body.contact || '');
    const userName = (req.body.name || '').trim();
    const now = new Date().toISOString();

    if(!phoneNumber || !attendanceStatus) {
      return res.redirect('/');
    }
    // 🔒 WHITELIST CHECK
    const guestDoc = await db.collection('guest_list').doc(phoneNumber).get();

    if (!guestDoc.exists) {
      return res.redirect('/?error=1');
    }

    const guestName = guestDoc.data().name;

    // SAVE RSVP
    
    await db.collection('rsvps').doc(phoneNumber).set({
      phone: phoneNumber,
      guest_name_host: guestName,
      guest_name_user: userName, // ✅ NEW
      attendance_status: attendanceStatus,
      host_message: hostMessage,
      updated_at: now
    });

    await writeExcelSnapshot();

    return res.redirect('/thank-you');

  } catch (err) {
    console.error(err);
    return res.redirect('/?error=1');
  }
});

// =====================
// ADMIN DASHBOARD
// =====================

app.get('/admin/full', async (req, res) => {
  
  const key = req.query.key;
  
  if (key !== ADMIN_KEY) {
    return res.send('Unauthorized');
  }
  const guestsSnap = await db.collection('guest_list').get();
  const rsvpSnap = await db.collection('rsvps').get();

  const rsvpMap = {};
  rsvpSnap.forEach(doc => {
    rsvpMap[doc.id] = doc.data();
  });

  const rows = [];

  guestsSnap.forEach(doc => {
    const guest = doc.data();
    const rsvp = rsvpMap[doc.id];

    rows.push({
      phone: doc.id,
      guest_name_host: guest.name || '-',
      guest_name_user: rsvp ? rsvp.guest_name_user || '-' : '-',
      attendance_status: rsvp ? rsvp.attendance_status : null
    });
  });

  res.render('admin', { rows,key });
});


// =====================
// ADD GUEST ROUTE
// =====================

app.post('/admin/add-guest', async (req, res) => {
  try {
    const { guest_name_host, phone, notes } = req.body;

    const normalizedPhone = normalizePhone(phone);

    if (!guest_name_host || !normalizedPhone) {
      return res.redirect('/admin/full');
    }

    await db.collection('guest_list').doc(normalizedPhone).set({
      name: guest_name_host,
      notes: notes || ''
    }, { merge: true });

    res.redirect('/admin/full');

  } catch (err) {
    console.error(err);
    res.redirect('/admin/full');
  }
});

// =====================
// UPDATE GUEST ROUTE
// =====================
app.post('/admin/update-guest', async (req, res) => {
  try {
    const { original_phone, guest_name_host, phone, notes, attendance_status } = req.body;
    const now = new Date().toISOString();
    const oldPhone = normalizePhone(original_phone);
    const newPhone = normalizePhone(phone);
    
    if (!guest_name_host || !newPhone) {
      return res.redirect('/admin/full');
    }

    // If phone changed → move doc
    if (oldPhone !== newPhone) {
      const oldDoc = await db.collection('guest_list').doc(oldPhone).get();

      if (oldDoc.exists) {
        await db.collection('guest_list').doc(newPhone).set({
          ...oldDoc.data(),
          name: guest_name_host,
          notes: notes || ''
        });

        await db.collection('guest_list').doc(oldPhone).delete();
      }
    } else {
      await db.collection('guest_list').doc(oldPhone).update({
        name: guest_name_host,
        notes: notes || ''
      });
    }
    if (attendance_status === '') {
      await db.collection('rsvps').doc(newPhone).delete();
    } else {
      await db.collection('rsvps').doc(newPhone).set({
        attendance_status,
        updated_at: now
      }, { merge: true });
    }
    res.redirect('/admin/full');

  } catch (err) {
    console.error(err);
    res.redirect('/admin/full');
  }
});

// =====================
// DELETE GUEST ROUTE
// =====================
app.post('/admin/delete-guest', async (req, res) => {
  try {
    const { phone } = req.body;
    const normalizedPhone = normalizePhone(phone);

    // delete guest
    await db.collection('guest_list').doc(normalizedPhone).delete();

    // delete RSVP too (important)
    await db.collection('rsvps').doc(normalizedPhone).delete();

    res.redirect('/admin/full');

  } catch (err) {
    console.error(err);
    res.redirect('/admin/full');
  }
});

// =====================
// UPDATE RSVP ROUTE
// =====================

app.post('/admin/update-rsvp', async (req, res) => {
  try {
    const { phone, attendance_status } = req.body;
    const normalizedPhone = normalizePhone(phone);
    const now = new Date().toISOString();

    if (!normalizedPhone) {
      return res.redirect('/admin/full');
    }

    // If cleared → delete RSVP (back to "No Response")
    if (!attendance_status) {
      await db.collection('rsvps').doc(normalizedPhone).delete();
    } else {
      await db.collection('rsvps').doc(normalizedPhone).set({
        attendance_status,
        updated_at: now
      }, { merge: true });
    }

    res.redirect('/admin/full');

  } catch (err) {
    console.error(err);
    res.redirect('/admin/full');
  }
});
// =====================
// EXPORT ROUTE
// =====================

app.get('/admin/export', async (req, res) => {
  await writeExcelSnapshot();

  setTimeout(() => {
    if (!fs.existsSync(EXCEL_PATH)) {
      return res.status(404).send('No file available');
    }

    res.download(EXCEL_PATH);
  }, 200);
});

// =====================
// START SERVER
// =====================

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});