'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./db');
const L = require('./lib');
const { HttpError } = L;

const PORT = Number(process.env.PORT || 3000);
const PAYMENT_MODE = process.env.PAYMENT_MODE === 'live' ? 'live' : 'mock';
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';
const HOLD_MINUTES = Number(process.env.HOLD_MINUTES || 10);
const BANKS = ['กสิกรไทย (K PLUS)', 'ไทยพาณิชย์ (SCB Easy)', 'กรุงไทย (Krungthai NEXT)', 'กรุงเทพ (Bualuang mBanking)', 'กรุงศรี (KMA)', 'ทีเอ็มบีธนชาต (ttb touch)', 'ออมสิน (MyMo)'];

if (PAYMENT_MODE === 'live' && !WEBHOOK_SECRET) {
  console.error('PAYMENT_MODE=live ต้องตั้ง PAYMENT_WEBHOOK_SECRET'); process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- ตัวช่วย ----------
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ } throw e; }
}
const nowIso = () => new Date().toISOString();

function notify(userId, title, body = '') {
  db.prepare('INSERT INTO notifications (user_id,title,body) VALUES (?,?,?)').run(userId, title, body);
  // จุดเชื่อมต่อ Email/SMS/LINE: ต่อบริการภายนอกที่นี่
  console.log(`[notify] user=${userId} | ${title} | ${body}`);
}

// หมดเวลาชำระเงิน → ยกเลิกการจองชั่วคราว (เรียกภายในทรานแซกชันเท่านั้น)
function sweepExpired() {
  const rows = db.prepare("SELECT id,user_id,code FROM bookings WHERE status='pending_payment' AND expires_at <= ?").all(nowIso());
  for (const b of rows) {
    db.prepare("UPDATE bookings SET status='expired', cancel_reason='หมดเวลาชำระเงิน' WHERE id=?").run(b.id);
    db.prepare("UPDATE payments SET status='expired' WHERE booking_id=? AND status='pending'").run(b.id);
    notify(b.user_id, 'การจองหมดเวลาชำระเงิน', `หมายเลข ${b.code} ถูกยกเลิกเนื่องจากไม่ได้ชำระเงินภายในเวลาที่กำหนด`);
  }
}
const sweep = () => tx(sweepExpired);
setInterval(() => { try { sweep(); } catch (e) { console.error('sweep error', e); } }, 15000).unref();

const BLOCKING = "(b.status='confirmed' OR (b.status='pending_payment' AND b.expires_at > ?))";
function tableBusy(tableId, date, start, end, excludeId = 0) {
  return !!db.prepare(`SELECT 1 FROM bookings b WHERE b.table_id=? AND b.date=? AND b.id<>? AND ${BLOCKING}
    AND b.start_time < ? AND b.end_time > ? LIMIT 1`).get(tableId, date, excludeId, nowIso(), end, start);
}

function slotsFor(r) {
  const out = []; const step = 60;
  for (let s = L.toMin(r.open_time); s + r.slot_minutes <= L.toMin(r.close_time); s += step)
    out.push({ start: L.fromMin(s), end: L.fromMin(s + r.slot_minutes) });
  return out;
}
const getRestaurant = (id) => {
  const r = db.prepare('SELECT * FROM restaurants WHERE id=? AND active=1').get(Number(id));
  if (!r) throw new HttpError(404, 'ไม่พบร้านอาหาร');
  return r;
};
const tableOut = (t) => ({ ...t, perks: JSON.parse(t.perks || '[]') });

const BOOKING_SQL = `
SELECT b.*, r.name AS restaurant_name, r.refund_full_hours, r.refund_half_hours,
  t.label AS table_label, t.seats AS table_seats, t.description AS table_desc,
  u.name AS user_name, u.phone AS user_phone, u.email AS user_email,
  p.id AS payment_id, CASE WHEN cr.id IS NOT NULL THEN 'cash' ELSE p.method END AS method, p.bank,
  CASE WHEN cr.id IS NOT NULL THEN 'paid' ELSE p.status END AS payment_status, COALESCE(p.reference, cr.receipt_no) AS reference,
  COALESCE(p.paid_at, cr.paid_at) AS paid_at, COALESCE(p.receipt_no, cr.receipt_no) AS receipt_no,
  CASE WHEN cr.id IS NOT NULL THEN cr.refund_amount ELSE COALESCE(p.refund_amount,0) END AS refund_amount, CASE WHEN cr.id IS NOT NULL THEN cr.refund_status ELSE COALESCE(p.refund_status,'none') END AS refund_status,
  CASE WHEN cr.id IS NOT NULL THEN cr.refunded_at ELSE p.refunded_at END AS refunded_at
FROM bookings b
JOIN restaurants r ON r.id=b.restaurant_id
JOIN dining_tables t ON t.id=b.table_id
JOIN users u ON u.id=b.user_id
LEFT JOIN payments p ON p.id = (SELECT id FROM payments WHERE booking_id=b.id ORDER BY (status='paid') DESC, id DESC LIMIT 1)
LEFT JOIN booking_cash_receipts cr ON cr.booking_id=b.id`; 

function loadBooking(id, userId = null) {
  const b = db.prepare(`${BOOKING_SQL} WHERE b.id=?`).get(Number(id));
  if (!b || (userId !== null && b.user_id !== userId)) throw new HttpError(404, 'ไม่พบรายการจอง');
  return b;
}

// ---------- ยืนยันผลการชำระเงิน (จุดเดียวที่เปลี่ยนสถานะเป็น "จองสำเร็จ") ----------
function settlePayment(reference, status, paidAmount, txn = '') {
  return tx(() => {
    sweepExpired();
    const pay = db.prepare('SELECT * FROM payments WHERE reference=?').get(reference);
    if (!pay) throw new HttpError(404, 'ไม่พบรายการชำระเงิน');
    if (pay.status === 'paid') return pay; // idempotent
    const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(pay.booking_id);

    if (status === 'failed') {
      if (pay.status === 'pending') db.prepare("UPDATE payments SET status='failed', gateway_txn=? WHERE id=?").run(txn, pay.id);
      notify(booking.user_id, 'ชำระเงินไม่สำเร็จ', `การจอง ${booking.code} ยังไม่ได้รับการยืนยัน กรุณาลองชำระเงินอีกครั้งภายในเวลาที่กำหนด`);
      return db.prepare('SELECT * FROM payments WHERE id=?').get(pay.id);
    }
    if (status !== 'paid') throw new HttpError(400, 'สถานะไม่ถูกต้อง');
    if (Math.abs(Number(paidAmount) - pay.amount) > 0.001)
      throw new HttpError(422, `ยอดเงินไม่ตรงกับรายการ (ต้องชำระ ${pay.amount})`);

    const receipt = `RC${new Date().toISOString().slice(2, 10).replace(/-/g, '')}${String(pay.id).padStart(5, '0')}`;
    const paidAt = nowIso();
    if (booking.status === 'pending_payment') {
      db.prepare("UPDATE payments SET status='paid', paid_at=?, receipt_no=?, gateway_txn=? WHERE id=?").run(paidAt, receipt, txn, pay.id);
      db.prepare("UPDATE bookings SET status='confirmed', expires_at=NULL WHERE id=?").run(booking.id);
      notify(booking.user_id, 'จองโต๊ะสำเร็จ', `หมายเลขการจอง ${booking.code} วันที่ ${booking.date} เวลา ${booking.start_time}–${booking.end_time}`);
    } else {
      // จ่ายเงินมาหลังการจองหมดเวลา/ถูกยกเลิกแล้ว → ไม่ยืนยันการจอง และคืนเงินเต็มจำนวน
      db.prepare(`UPDATE payments SET status='paid', paid_at=?, receipt_no=?, gateway_txn=?, refund_amount=amount, refund_status='pending' WHERE id=?`)
        .run(paidAt, receipt, txn, pay.id);
      notify(booking.user_id, 'ได้รับเงินแต่การจองไม่สำเร็จ', `การจอง ${booking.code} หมดเวลา/ถูกยกเลิกแล้ว ระบบจะคืนเงิน ${pay.amount} บาทให้คุณ`);
    }
    return db.prepare('SELECT * FROM payments WHERE id=?').get(pay.id);
  });
}

// ---------- นโยบายคืนเงิน ----------
function refundPlan(b, byAdmin = false) {
  if (b.payment_status !== 'paid') return { percent: 0, amount: 0 };
  const hoursLeft = (L.slotStartMs(b.date, b.start_time) - Date.now()) / 3600000;
  const percent = byAdmin ? 100 : hoursLeft >= b.refund_full_hours ? 100 : hoursLeft >= b.refund_half_hours ? 50 : 0;
  return { percent, amount: L.money(b.amount * percent / 100), hoursLeft };
}
function cancelBooking(id, userId, byAdmin = false) {
  return tx(() => {
    sweepExpired();
    const b = loadBooking(id, byAdmin ? null : userId);
    if (!['pending_payment', 'confirmed'].includes(b.status)) throw new HttpError(409, 'รายการนี้ไม่สามารถยกเลิกได้');
    if (!byAdmin && L.slotStartMs(b.date, b.start_time) <= Date.now()) throw new HttpError(409, 'ไม่สามารถยกเลิกหลังถึงเวลาจองแล้ว');
    const plan = refundPlan(b, byAdmin);
    db.prepare("UPDATE bookings SET status='cancelled', cancelled_at=?, cancel_reason=? WHERE id=?")
      .run(nowIso(), byAdmin ? 'ยกเลิกโดยผู้ดูแลระบบ' : 'ยกเลิกโดยลูกค้า', b.id);
    db.prepare("UPDATE payments SET status='cancelled' WHERE booking_id=? AND status='pending'").run(b.id);
    if (b.payment_status === 'paid') {
      if (b.method !== 'cash' && b.payment_id) {
        db.prepare('UPDATE payments SET refund_amount=?, refund_status=? WHERE id=?')
          .run(plan.amount, plan.amount > 0 ? 'pending' : 'none', b.payment_id);
      } else {
        db.prepare('UPDATE booking_cash_receipts SET refund_amount=?, refund_status=? WHERE booking_id=?')
          .run(plan.amount, plan.amount > 0 ? 'pending' : 'none', b.id);
      }
    }
    notify(b.user_id, 'ยกเลิกการจองแล้ว', plan.amount > 0
      ? `การจอง ${b.code} ถูกยกเลิก คืนเงิน ${plan.amount} บาท (${plan.percent}%) อยู่ระหว่างดำเนินการ`
      : `การจอง ${b.code} ถูกยกเลิก${b.payment_status === 'paid' ? ' (ไม่เข้าเงื่อนไขการคืนเงิน)' : ''}`);
    return loadBooking(b.id);
  });
}

// ---------- Auth ----------
const attempts = new Map(); // จำกัดการเดารหัสผ่านอย่างง่าย
function throttle(key) {
  const now = Date.now(); const a = (attempts.get(key) || []).filter((t) => now - t < 15 * 60000);
  if (a.length >= 10) throw new HttpError(429, 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่');
  a.push(now); attempts.set(key, a);
}
function issueSession(userId) {
  const token = L.newToken();
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)')
    .run(L.sha256(token), userId, new Date(Date.now() + 7 * 86400000).toISOString());
  return token;
}
const pubUser = (u) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email, role: u.role, is_staff: !!db.prepare('SELECT 1 FROM staff_members WHERE user_id=? AND active=1').get(u.id) });

function auth(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at > ?`)
    .get(L.sha256(token), nowIso());
  if (!row) throw new HttpError(401, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  if (row.blocked) throw new HttpError(403, 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อร้าน');
  req.user = row; req.token = token;
  req.staff = db.prepare('SELECT * FROM staff_members WHERE user_id=? AND active=1').get(row.id) || null;
  if (req.staff) { try { req.staff.permissions = JSON.parse(req.staff.permissions || '[]'); } catch (_) { req.staff.permissions = []; } }
  next();
}
const adminOnly = (req, _res, next) => { if (req.user.role !== 'admin') throw new HttpError(403, 'ต้องเป็นผู้ดูแลระบบ'); next(); };
const staffOnly = (permission) => (req, _res, next) => { if (req.user.role === 'admin') return next(); if (!req.staff || !req.staff.permissions.includes(permission)) throw new HttpError(403, 'ไม่มีสิทธิ์ใช้งานส่วนนี้'); next(); };

function validateProfile(b, { needPassword }) {
  const name = L.cleanStr(b.name, 100), phone = L.normPhone(b.phone), email = L.cleanStr(b.email, 120).toLowerCase();
  if (name.length < 2) throw new HttpError(400, 'กรุณากรอกชื่ออย่างน้อย 2 ตัวอักษร');
  if (!L.validPhone(phone)) throw new HttpError(400, 'เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 0812345678)');
  if (!L.validEmail(email)) throw new HttpError(400, 'อีเมลไม่ถูกต้อง');
  if (needPassword && (typeof b.password !== 'string' || b.password.length < 8)) throw new HttpError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  return { name, phone, email };
}

app.post('/api/auth/register', (req, res) => {
  const p = validateProfile(req.body, { needPassword: true });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(p.email)) throw new HttpError(409, 'อีเมลนี้ถูกใช้งานแล้ว');
  const id = Number(db.prepare("INSERT INTO users (name,phone,email,password_hash) VALUES (?,?,?,?)")
    .run(p.name, p.phone, p.email, L.hashPassword(req.body.password)).lastInsertRowid);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  res.status(201).json({ token: issueSession(id), user: pubUser(user) });
});
app.post('/api/auth/login', (req, res) => {
  const email = L.cleanStr(req.body.email, 120).toLowerCase();
  throttle(`${req.ip}|${email}`);
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || typeof req.body.password !== 'string' || !L.verifyPassword(req.body.password, u.password_hash))
    throw new HttpError(401, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  if (u.blocked) throw new HttpError(403, 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อร้าน');
  res.json({ token: issueSession(u.id), user: pubUser(u) });
});
app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(L.sha256(req.token));
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json({ user: pubUser(req.user) }));
app.put('/api/me', auth, (req, res) => {
  const p = validateProfile(req.body, { needPassword: false });
  if (db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(p.email, req.user.id)) throw new HttpError(409, 'อีเมลนี้ถูกใช้งานแล้ว');
  if (req.body.new_password) {
    if (!L.verifyPassword(String(req.body.current_password || ''), req.user.password_hash)) throw new HttpError(400, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    if (String(req.body.new_password).length < 8) throw new HttpError(400, 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(L.hashPassword(req.body.new_password), req.user.id);
  }
  db.prepare('UPDATE users SET name=?, phone=?, email=? WHERE id=?').run(p.name, p.phone, p.email, req.user.id);
  res.json({ user: pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
});

// ---------- ข้อมูลร้าน / โต๊ะ ----------
app.get('/api/config', (_req, res) => res.json({ holdMinutes: HOLD_MINUTES, banks: BANKS }));

app.get('/api/restaurants', (_req, res) => {
  const rows = db.prepare('SELECT * FROM restaurants WHERE active=1 ORDER BY id').all();
  res.json(rows.map((r) => {
    const s = (type) => db.prepare("SELECT COUNT(*) n, MIN(price+service_fee) minp FROM dining_tables WHERE restaurant_id=? AND type=? AND status<>'inactive'").get(r.id, type);
    return { id: r.id, name: r.name, description: r.description, emoji: r.emoji, image_url: r.image_url, open_time: r.open_time, close_time: r.close_time,
      normal: s('normal'), vip: s('vip') };
  }));
});
app.get('/api/restaurants/:id', (req, res) => {
  const r = getRestaurant(req.params.id);
  const { promptpay_id, ...pub } = r;
  res.json({
    ...pub,
    menu: db.prepare('SELECT * FROM menu_items WHERE restaurant_id=? ORDER BY id').all(r.id),
    promotions: db.prepare("SELECT * FROM promotions WHERE restaurant_id=? AND (valid_until='' OR valid_until >= ?) ORDER BY id").all(r.id, L.bangkokToday()),
    tables: db.prepare("SELECT * FROM dining_tables WHERE restaurant_id=? AND status<>'inactive' ORDER BY type, id").all(r.id).map(tableOut),
    holdMinutes: HOLD_MINUTES,
  });
});

function checkDate(date) {
  if (!L.isDate(date)) throw new HttpError(400, 'วันที่ไม่ถูกต้อง');
  const today = L.bangkokToday();
  if (date < today) throw new HttpError(400, 'ไม่สามารถจองย้อนหลังได้');
  if (date > L.addDays(today, 60)) throw new HttpError(400, 'จองล่วงหน้าได้ไม่เกิน 60 วัน');
}
const checkType = (t) => { if (!['normal', 'vip'].includes(t)) throw new HttpError(400, 'ประเภทโต๊ะไม่ถูกต้อง'); return t; };

app.get('/api/restaurants/:id/slots', (req, res) => {
  const r = getRestaurant(req.params.id); const type = checkType(req.query.type || 'normal'); const date = req.query.date;
  checkDate(date); sweep();
  const tables = db.prepare("SELECT id FROM dining_tables WHERE restaurant_id=? AND type=? AND status='active'").all(r.id, type);
  res.json(slotsFor(r).map((s) => {
    const busy = tables.filter((t) => tableBusy(t.id, date, s.start, s.end)).length;
    return { ...s, total: tables.length, free: tables.length - busy, past: L.slotStartMs(date, s.start) <= Date.now() };
  }));
});
app.get('/api/restaurants/:id/availability', (req, res) => {
  const r = getRestaurant(req.params.id); const type = checkType(req.query.type || 'normal');
  const { date, start } = req.query; checkDate(date);
  const slot = slotsFor(r).find((s) => s.start === start);
  if (!slot) throw new HttpError(400, 'ช่วงเวลาไม่ถูกต้อง');
  sweep();
  const past = L.slotStartMs(date, start) <= Date.now();
  const rows = db.prepare("SELECT * FROM dining_tables WHERE restaurant_id=? AND type=? AND status<>'inactive' ORDER BY id").all(r.id, type);
  res.json({ slot, tables: rows.map((t) => ({ ...tableOut(t),
    state: t.status !== 'active' || past ? 'unavailable' : tableBusy(t.id, date, slot.start, slot.end) ? 'booked' : 'available' })) });
});

// ---------- การจอง ----------
app.post('/api/bookings', auth, (req, res) => {
  const b = req.body || {};
  const date = b.date, start = b.start_time, party = Number(b.party_size);
  checkDate(date);
  const id = tx(() => {
    sweepExpired();
    const r = getRestaurant(b.restaurant_id);
    const t = db.prepare("SELECT * FROM dining_tables WHERE id=? AND restaurant_id=?").get(Number(b.table_id), r.id);
    if (!t || t.status === 'inactive') throw new HttpError(404, 'ไม่พบโต๊ะ');
    if (t.status !== 'active') throw new HttpError(409, 'โต๊ะนี้ไม่เปิดให้จองในขณะนี้');
    const slot = slotsFor(r).find((s) => s.start === start);
    if (!slot) throw new HttpError(400, 'ช่วงเวลาไม่ถูกต้อง');
    if (L.slotStartMs(date, start) <= Date.now()) throw new HttpError(400, 'ช่วงเวลานี้ผ่านไปแล้ว');
    if (!Number.isInteger(party) || party < 1) throw new HttpError(400, 'กรุณาระบุจำนวนคน');
    if (party > t.seats) throw new HttpError(400, `จำนวนคนเกินความจุของโต๊ะ (โต๊ะ ${t.label} รองรับสูงสุด ${t.seats} ที่นั่ง)`);
    const holding = db.prepare("SELECT COUNT(*) c FROM bookings WHERE user_id=? AND status='pending_payment'").get(req.user.id).c;
    if (holding >= 3) throw new HttpError(429, 'มีรายการที่รอชำระเงินหลายรายการแล้ว กรุณาชำระหรือยกเลิกก่อน');
    if (tableBusy(t.id, date, slot.start, slot.end)) throw new HttpError(409, 'โต๊ะนี้ถูกจองแล้วในช่วงเวลาดังกล่าว');
    const ymd = date.slice(2).replace(/-/g, '');
    let code;
    do { code = `${t.type === 'vip' ? 'VIP' : 'BK'}-${ymd}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`; }
    while (db.prepare('SELECT 1 FROM bookings WHERE code=?').get(code));
    try {
      return Number(db.prepare(`INSERT INTO bookings (code,user_id,restaurant_id,table_id,table_type,party_size,date,start_time,end_time,status,amount,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,'pending_payment',?,?)`).run(code, req.user.id, r.id, t.id, t.type, party, date, slot.start, slot.end,
        L.money(t.price + t.service_fee), new Date(Date.now() + HOLD_MINUTES * 60000).toISOString()).lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(String(e.message))) throw new HttpError(409, 'โต๊ะนี้ถูกจองแล้วในช่วงเวลาดังกล่าว');
      throw e;
    }
  });
  res.status(201).json(loadBooking(id));
});

app.get('/api/bookings', auth, (req, res) => {
  sweep();
  const type = req.query.type;
  const rows = db.prepare(`${BOOKING_SQL} WHERE b.user_id=? ${['normal', 'vip'].includes(type) ? 'AND b.table_type=?' : ''} ORDER BY b.id DESC LIMIT 200`)
    .all(...(['normal', 'vip'].includes(type) ? [req.user.id, type] : [req.user.id]));
  res.json(rows);
});
app.get('/api/bookings/:id', auth, (req, res) => { sweep(); res.json(loadBooking(req.params.id, req.user.id)); });
app.get('/api/bookings/:id/cancel-preview', auth, (req, res) => {
  const b = loadBooking(req.params.id, req.user.id);
  res.json({ paid: b.payment_status === 'paid', ...refundPlan(b), full_hours: b.refund_full_hours, half_hours: b.refund_half_hours });
});
app.post('/api/bookings/:id/cancel', auth, (req, res) => res.json(cancelBooking(req.params.id, req.user.id)));

// ---------- ชำระเงิน ----------
app.post('/api/bookings/:id/pay', auth, async (req, res) => {
  const method = req.body.method, bank = L.cleanStr(req.body.bank, 60);
  if (!['promptpay', 'mobile_banking'].includes(method)) throw new HttpError(400, 'วิธีชำระเงินไม่ถูกต้อง');
  if (method === 'mobile_banking' && !BANKS.includes(bank)) throw new HttpError(400, 'กรุณาเลือกธนาคาร');
  const { pay, booking } = tx(() => {
    sweepExpired();
    const b = loadBooking(req.params.id, req.user.id);
    if (b.status !== 'pending_payment') throw new HttpError(409, b.status === 'expired' ? 'หมดเวลาชำระเงินแล้ว กรุณาจองใหม่' : 'รายการนี้ไม่อยู่ในสถานะรอชำระเงิน');
    db.prepare("UPDATE payments SET status='cancelled' WHERE booking_id=? AND status IN ('pending','failed')").run(b.id);
    const reference = `PAY${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const id = Number(db.prepare('INSERT INTO payments (booking_id,method,bank,amount,reference) VALUES (?,?,?,?,?)')
      .run(b.id, method, method === 'mobile_banking' ? bank : '', b.amount, reference).lastInsertRowid);
    return { pay: db.prepare('SELECT * FROM payments WHERE id=?').get(id), booking: b };
  });
  const rest = db.prepare('SELECT promptpay_id FROM restaurants WHERE id=?').get(booking.restaurant_id);
  const payload = L.promptPayPayload(rest.promptpay_id, pay.amount);
  const qr = await QRCode.toDataURL(payload, { margin: 1, width: 320 });
  res.status(201).json({ payment: pay, qr, expires_at: booking.expires_at });
});
function ownPayment(req) {
  const p = db.prepare(`SELECT p.*, b.user_id, b.expires_at, b.status AS booking_status, b.restaurant_id, b.code
    FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE p.reference=?`).get(req.params.reference);
  if (!p || p.user_id !== req.user.id) throw new HttpError(404, 'ไม่พบรายการชำระเงิน');
  return p;
}
app.get('/api/payments/:reference', auth, async (req, res) => {
  sweep();
  const p = ownPayment(req);
  const out = { status: p.status, booking_status: p.booking_status, booking_id: p.booking_id, expires_at: p.expires_at };
  if (req.query.qr === '1' && p.status === 'pending') {
    const rest = db.prepare('SELECT promptpay_id FROM restaurants WHERE id=?').get(p.restaurant_id);
    out.qr = await QRCode.toDataURL(L.promptPayPayload(rest.promptpay_id, p.amount), { margin: 1, width: 320 });
    out.payment = { reference: p.reference, amount: p.amount, method: p.method, bank: p.bank };
  }
  res.json(out);
});
// โหมดทดสอบเท่านั้น: จำลองการแจ้งผลจากผู้ให้บริการชำระเงิน
app.post('/api/payments/:reference/mock', auth, (req, res) => {
  if (PAYMENT_MODE !== 'mock' || req.user.role !== 'admin') throw new HttpError(404, 'Not found');
  const p = db.prepare('SELECT * FROM payments WHERE reference=?').get(req.params.reference);
  if (!p) throw new HttpError(404, 'ไม่พบรายการชำระเงิน');
  const ok = req.body.result === 'success';
  const r = settlePayment(p.reference, ok ? 'paid' : 'failed', p.amount, ok ? 'MOCK-TXN' : 'MOCK-FAIL');
  res.json({ status: r.status });
});
// Webhook จริงจากผู้ให้บริการ (ยืนยันลายเซ็น HMAC-SHA256 ของ raw body ใน header x-signature)
app.post('/api/payments/webhook', (req, res) => {
  if (!WEBHOOK_SECRET) throw new HttpError(503, 'ยังไม่ได้ตั้งค่า webhook');
  const sig = String(req.headers['x-signature'] || '');
  const expect = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'ลายเซ็นไม่ถูกต้อง');
  const { reference, status, amount, transaction_id: txn } = req.body || {};
  const r = settlePayment(String(reference), status, amount, String(txn || ''));
  res.json({ ok: true, status: r.status });
});

// ---------- แจ้งเตือน ----------
app.get('/api/notifications', auth, (req, res) => {
  sweep();
  res.json({
    unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0').get(req.user.id).c,
    items: db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30').all(req.user.id),
  });
});
app.post('/api/notifications/read', auth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.user.id); res.json({ ok: true });
});

// ---------- Food ordering (ผูกออเดอร์กับการจองโต๊ะเดิม) ----------
function foodBooking(id, user) {
  const b = db.prepare("SELECT * FROM bookings WHERE id=? AND status='confirmed'").get(Number(id));
  if (!b) throw new HttpError(404, 'ไม่พบการจองที่ยืนยันแล้ว หรือการจองยังไม่พร้อมใช้งาน');
  if (user && user.role !== 'admin' && b.user_id !== user.id) throw new HttpError(403, 'ไม่มีสิทธิ์ใช้งานรายการจองนี้');
  return b;
}
function foodOrderOut(id) {
  const o = db.prepare(`SELECT fo.*, b.code AS booking_code, t.label AS table_label, r.name AS restaurant_name
    FROM food_orders fo JOIN bookings b ON b.id=fo.booking_id JOIN dining_tables t ON t.id=b.table_id
    JOIN restaurants r ON r.id=fo.restaurant_id WHERE fo.id=?`).get(id);
  const items = db.prepare('SELECT * FROM food_order_items WHERE order_id=? ORDER BY id').all(id);
  return { ...o, items, total: L.money(items.reduce((n, x) => n + x.unit_price*x.quantity, 0)) };
}
function foodBill(bookingId) {
  const orders = db.prepare("SELECT id FROM food_orders WHERE booking_id=? AND status<>'cancelled' ORDER BY id").all(bookingId).map(x=>foodOrderOut(x.id));
  const paid = db.prepare("SELECT COALESCE(SUM(amount),0) n FROM food_payments WHERE booking_id=? AND status='paid'").get(bookingId).n;
  const total = L.money(orders.reduce((n,o)=>n+o.total,0));
  return { orders, total, paid: L.money(paid), balance: L.money(Math.max(0,total-paid)), payments: db.prepare('SELECT * FROM food_payments WHERE booking_id=? ORDER BY id DESC').all(bookingId) };
}
function createFoodOrder(bookingId, items, source, userId, note='') {
  const b = foodBooking(bookingId, source === 'staff' ? null : {id:userId,role:'customer'});
  if (!Array.isArray(items) || !items.length || items.length > 50) throw new HttpError(400,'กรุณาเลือกรายการอาหาร');
  const id = tx(() => {
    const oid = Number(db.prepare('INSERT INTO food_orders (booking_id,restaurant_id,created_by,source,note) VALUES (?,?,?,?,?)').run(b.id,b.restaurant_id,userId,source,L.cleanStr(note,300)).lastInsertRowid);
    for (const item of items) {
      const menu = db.prepare('SELECT * FROM menu_items WHERE id=? AND restaurant_id=?').get(Number(item.menu_item_id),b.restaurant_id);
      const qty = Number(item.quantity);
      if (!menu || !Number.isInteger(qty) || qty < 1 || qty > 99) throw new HttpError(400,'รายการอาหารหรือจำนวนไม่ถูกต้อง');
      db.prepare('INSERT INTO food_order_items (order_id,menu_item_id,item_name,unit_price,quantity,note) VALUES (?,?,?,?,?,?)').run(oid,menu.id,menu.name,menu.price,qty,L.cleanStr(item.note,200));
    }
    db.prepare("UPDATE food_orders SET status='submitted',updated_at=? WHERE id=?").run(nowIso(),oid);
    return oid;
  });
  return foodOrderOut(id);
}
app.get('/api/bookings/:id/food', auth, (req,res) => {
  foodBooking(req.params.id,req.user);
  const b = db.prepare('SELECT restaurant_id FROM bookings WHERE id=?').get(Number(req.params.id));
  res.json({ menu:db.prepare('SELECT id,name,price,description,emoji,image_url FROM menu_items WHERE restaurant_id=? ORDER BY id').all(b.restaurant_id), ...foodBill(Number(req.params.id)) });
});
app.post('/api/bookings/:id/food/orders', auth, (req,res) => res.status(201).json(createFoodOrder(req.params.id,req.body.items,'customer',req.user.id,req.body.note)));
app.post('/api/bookings/:id/food/checkout', auth, async (req,res) => {
  const b=foodBooking(req.params.id,req.user);
  const method=['promptpay','cash','mobile_banking'].includes(req.body.method)?req.body.method:'promptpay';
  if (method==='cash') throw new HttpError(400,'กรุณาแจ้งพนักงานเพื่อชำระเงินสด');
  const pay=tx(()=>{
    const freshBill=foodBill(b.id);
    if(freshBill.balance<=0) throw new HttpError(409,'ไม่มียอดค้างชำระ');
    const existing=db.prepare("SELECT * FROM food_payments WHERE booking_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(b.id);
    if(existing && Math.abs(Number(existing.amount)-freshBill.balance)<0.001 && existing.method===method) return existing;
    if(existing) db.prepare("UPDATE food_payments SET status='failed' WHERE id=? AND status='pending'").run(existing.id);
    const ref='FD'+crypto.randomBytes(8).toString('hex').toUpperCase();
    const id=Number(db.prepare('INSERT INTO food_payments (booking_id,amount,method,reference) VALUES (?,?,?,?)').run(b.id,freshBill.balance,method,ref).lastInsertRowid);
    return db.prepare('SELECT * FROM food_payments WHERE id=?').get(id);
  });
  const rest=db.prepare('SELECT promptpay_id FROM restaurants WHERE id=?').get(b.restaurant_id);
  const qr=pay.method==='promptpay' && rest.promptpay_id ? await QRCode.toDataURL(L.promptPayPayload(rest.promptpay_id,pay.amount),{margin:1,width:320}) : null;
  res.status(201).json({payment:pay,qr});
});
app.post('/api/food-payments/:id/mock', auth, (req,res) => {
  if (PAYMENT_MODE!=='mock' || req.user.role!=='admin') throw new HttpError(404,'Not found');
  const p=db.prepare('SELECT fp.*,b.user_id FROM food_payments fp JOIN bookings b ON b.id=fp.booking_id WHERE fp.id=?').get(Number(req.params.id));
  if (!p || (req.user.role!=='admin' && p.user_id!==req.user.id)) throw new HttpError(404,'ไม่พบรายการชำระเงิน');
  if (p.status!=='pending') throw new HttpError(409,'รายการนี้ดำเนินการแล้ว');
  const receipt='FRC'+Date.now().toString().slice(-10);
  db.prepare("UPDATE food_payments SET status='paid',paid_at=?,receipt_no=? WHERE id=?").run(nowIso(),receipt,p.id);
  notify(p.user_id,'ชำระค่าอาหารสำเร็จ',`ชำระ ${p.amount} บาท ใบเสร็จ ${receipt}`);
  res.json({ok:true,receipt_no:receipt,bill:foodBill(p.booking_id)});
});


// รับชำระเงินสดสำหรับค่าจอง: บันทึกเป็นหลักฐานแยกจากการโอนผ่าน gateway
function receiveBookingCash(bookingId, userId) {
  return tx(() => {
    sweepExpired();
    const b=loadBooking(bookingId);
    if (!['pending_payment','confirmed'].includes(b.status)) throw new HttpError(409,'สถานะการจองไม่รองรับการรับชำระ');
    const prior=db.prepare('SELECT * FROM booking_cash_receipts WHERE booking_id=?').get(b.id);
    if (prior) return prior;
    const paid=db.prepare("SELECT 1 FROM payments WHERE booking_id=? AND status='paid'").get(b.id);
    if (paid) throw new HttpError(409,'รายการนี้ชำระเงินแล้ว');
    const receipt='BCR'+new Date().toISOString().slice(2,10).replace(/-/g,'')+String(b.id).padStart(6,'0');
    const id=Number(db.prepare('INSERT INTO booking_cash_receipts (booking_id,amount,receipt_no,received_by) VALUES (?,?,?,?)').run(b.id,b.amount,receipt,userId).lastInsertRowid);
    db.prepare("UPDATE payments SET status='cancelled' WHERE booking_id=? AND status IN ('pending','failed')").run(b.id);
    db.prepare("UPDATE bookings SET status='confirmed',expires_at=NULL WHERE id=?").run(b.id);
    notify(b.user_id,'ยืนยันการจองและรับชำระเงินแล้ว',`รับเงินสด ${b.amount} บาท ใบเสร็จ ${receipt}`);
    return db.prepare('SELECT * FROM booking_cash_receipts WHERE id=?').get(id);
  });
}

// ---------- Admin ----------
const admin = express.Router();
admin.use(auth, adminOnly);
admin.get('/food/orders', (req,res) => {
  const rows=db.prepare(`SELECT id FROM food_orders ${req.query.status? 'WHERE status=?':''} ORDER BY id DESC LIMIT 300`).all(...(req.query.status?[req.query.status]:[]));
  res.json(rows.map(x=>foodOrderOut(x.id)));
});
admin.post('/food/orders', (req,res) => res.status(201).json(createFoodOrder(req.body.booking_id,req.body.items,'staff',req.user.id,req.body.note)));
admin.patch('/food/orders/:id/status', (req,res) => {
  const status=req.body.status, id=Number(req.params.id);
  if (!['preparing','served','cancelled'].includes(status)) throw new HttpError(400,'สถานะออเดอร์ไม่ถูกต้อง');
  const current=db.prepare('SELECT * FROM food_orders WHERE id=?').get(id);
  if (!current) throw new HttpError(404,'ไม่พบออเดอร์');
  if (current.status==='served' && status!=='served') throw new HttpError(409,'ออเดอร์ที่เสิร์ฟแล้วไม่สามารถย้อนสถานะได้');
  if (current.status==='cancelled' && status!=='cancelled') throw new HttpError(409,'ออเดอร์ที่ยกเลิกแล้วไม่สามารถเปิดใหม่ได้');
  tx(() => {
    if (status==='served' && current.status!=='served') {
      const lines=db.prepare(`SELECT mr.ingredient_id,mr.quantity*foi.quantity AS qty FROM food_order_items foi
        JOIN menu_recipes mr ON mr.menu_item_id=foi.menu_item_id WHERE foi.order_id=?`).all(id);
      for (const line of lines) {
        const ing=db.prepare('SELECT * FROM ingredients WHERE id=?').get(line.ingredient_id);
        if (!ing || ing.stock < line.qty) throw new HttpError(409,`วัตถุดิบ ${ing?.name || line.ingredient_id} ไม่เพียงพอ`);
        db.prepare('UPDATE ingredients SET stock=stock-?,updated_at=? WHERE id=?').run(line.qty,nowIso(),ing.id);
        db.prepare("INSERT INTO stock_movements (ingredient_id,user_id,movement,quantity,note) VALUES (?,?,'out',?,?)").run(ing.id,req.user.id,line.qty,`ตัดสต็อกจากออเดอร์ #${id}`);
      }
    }
    db.prepare('UPDATE food_orders SET status=?,updated_at=? WHERE id=?').run(status,nowIso(),id);
  });
  res.json(foodOrderOut(id));
});
admin.get('/food/bookings/:id/bill', (req,res) => { foodBooking(req.params.id,null); res.json(foodBill(Number(req.params.id))); });
admin.post('/food/bookings/:id/pay-cash',(req,res)=>{
 const result=tx(()=>{const b=foodBooking(req.params.id,null),bill=foodBill(b.id);if(bill.balance<=0)throw new HttpError(409,'ไม่มียอดค้างชำระ');const ref='FC'+crypto.randomBytes(8).toString('hex').toUpperCase(),receipt='FRC'+Date.now().toString().slice(-10);const id=Number(db.prepare("INSERT INTO food_payments (booking_id,amount,method,status,reference,receipt_no,paid_at) VALUES (?,?, 'cash','paid',?,?,?)").run(b.id,bill.balance,ref,receipt,nowIso()).lastInsertRowid);return {b,bill,payment:db.prepare('SELECT * FROM food_payments WHERE id=?').get(id)};});
 notify(result.b.user_id,'ชำระค่าอาหารสำเร็จ',`รับชำระเงินสด ${result.bill.balance} บาท ใบเสร็จ ${result.payment.receipt_no}`);
 res.status(201).json({payment:result.payment,bill:foodBill(result.b.id)});
});

// Kitchen, inventory, recipe, expense and consolidated operations APIs.
admin.get('/kitchen/orders', (req,res) => {
  const statuses=['submitted','preparing'];
  const rows=db.prepare(`SELECT id FROM food_orders WHERE status IN (?,?) ORDER BY created_at ASC`).all(...statuses);
  res.json(rows.map(x=>foodOrderOut(x.id)));
});
admin.get('/inventory', (req,res) => {
  const rid=Number(req.query.restaurant_id||0);
  if(!rid) throw new HttpError(400,'กรุณาระบุร้านอาหาร');
  res.json(db.prepare(`SELECT i.*, CASE WHEN i.stock<=i.min_stock THEN 1 ELSE 0 END AS low_stock,
    (SELECT COUNT(*) FROM menu_recipes mr WHERE mr.ingredient_id=i.id) AS recipe_count
    FROM ingredients i WHERE restaurant_id=? ORDER BY low_stock DESC,name`).all(rid));
});
admin.post('/inventory', (req,res) => {
  const rid=Number(req.body.restaurant_id),name=L.cleanStr(req.body.name,120),unit=L.cleanStr(req.body.unit,30)||'หน่วย';
  const stock=Number(req.body.stock||0),min=Number(req.body.min_stock||0),cost=Number(req.body.cost_per_unit||0);
  if(!db.prepare('SELECT 1 FROM restaurants WHERE id=?').get(rid)||!name||![stock,min,cost].every(Number.isFinite)||stock<0||min<0||cost<0) throw new HttpError(400,'ข้อมูลวัตถุดิบไม่ถูกต้อง');
  const id=Number(db.prepare('INSERT INTO ingredients (restaurant_id,name,unit,stock,min_stock,cost_per_unit) VALUES (?,?,?,?,?,?)').run(rid,name,unit,stock,min,cost).lastInsertRowid);
  if(stock>0) db.prepare("INSERT INTO stock_movements (ingredient_id,user_id,movement,quantity,note) VALUES (?,?,'in',?,'ยอดตั้งต้น')").run(id,req.user.id,stock);
  res.status(201).json(db.prepare('SELECT * FROM ingredients WHERE id=?').get(id));
});
admin.post('/inventory/:id/movements', (req,res) => {
  const id=Number(req.params.id),ing=db.prepare('SELECT * FROM ingredients WHERE id=?').get(id),movement=req.body.movement,qty=Number(req.body.quantity);
  if(!ing) throw new HttpError(404,'ไม่พบวัตถุดิบ');
  if(!['in','out','adjust'].includes(movement)||!Number.isFinite(qty)||qty<=0) throw new HttpError(400,'ข้อมูลเคลื่อนไหวสต็อกไม่ถูกต้อง');
  tx(()=>{
    const next=movement==='in'?ing.stock+qty:movement==='out'?ing.stock-qty:qty;
    if(next<0) throw new HttpError(409,'สต็อกไม่เพียงพอ');
    db.prepare('UPDATE ingredients SET stock=?,updated_at=? WHERE id=?').run(next,nowIso(),id);
    db.prepare('INSERT INTO stock_movements (ingredient_id,user_id,movement,quantity,note) VALUES (?,?,?,?,?)').run(id,req.user.id,movement,qty,L.cleanStr(req.body.note,200));
  });
  res.json(db.prepare('SELECT * FROM ingredients WHERE id=?').get(id));
});
admin.get('/inventory/:id/movements',(req,res)=>res.json(db.prepare('SELECT sm.*,u.name AS user_name FROM stock_movements sm LEFT JOIN users u ON u.id=sm.user_id WHERE ingredient_id=? ORDER BY id DESC LIMIT 100').all(Number(req.params.id))));
admin.post('/recipes', (req,res) => {
  const menuId=Number(req.body.menu_item_id),ingredientId=Number(req.body.ingredient_id),qty=Number(req.body.quantity);
  const menu=db.prepare('SELECT * FROM menu_items WHERE id=?').get(menuId),ing=db.prepare('SELECT * FROM ingredients WHERE id=?').get(ingredientId);
  if(!menu||!ing||menu.restaurant_id!==ing.restaurant_id||!Number.isFinite(qty)||qty<=0) throw new HttpError(400,'สูตรวัตถุดิบไม่ถูกต้องหรืออยู่คนละร้าน');
  db.prepare('INSERT INTO menu_recipes (menu_item_id,ingredient_id,quantity) VALUES (?,?,?) ON CONFLICT(menu_item_id,ingredient_id) DO UPDATE SET quantity=excluded.quantity').run(menuId,ingredientId,qty);
  res.status(201).json({ok:true});
});
admin.get('/recipes/:menuId',(req,res)=>res.json(db.prepare(`SELECT mr.*,i.name,i.unit,i.stock FROM menu_recipes mr JOIN ingredients i ON i.id=mr.ingredient_id WHERE mr.menu_item_id=?`).all(Number(req.params.menuId))));
admin.delete('/recipes/:id',(req,res)=>{db.prepare('DELETE FROM menu_recipes WHERE id=?').run(Number(req.params.id));res.json({ok:true});});
admin.get('/expenses',(req,res)=>{const rid=Number(req.query.restaurant_id||0);res.json(db.prepare('SELECT * FROM restaurant_expenses WHERE restaurant_id=? ORDER BY expense_date DESC,id DESC LIMIT 500').all(rid));});
admin.post('/expenses',(req,res)=>{const rid=Number(req.body.restaurant_id),category=L.cleanStr(req.body.category,80),description=L.cleanStr(req.body.description,300),amount=Number(req.body.amount),date=L.cleanStr(req.body.expense_date,10);if(!db.prepare('SELECT 1 FROM restaurants WHERE id=?').get(rid)||!category||!Number.isFinite(amount)||amount<=0||!L.isDate(date))throw new HttpError(400,'ข้อมูลค่าใช้จ่ายไม่ถูกต้อง');const id=Number(db.prepare('INSERT INTO restaurant_expenses (restaurant_id,category,description,amount,expense_date,created_by) VALUES (?,?,?,?,?,?)').run(rid,category,description,amount,date,req.user.id).lastInsertRowid);res.status(201).json(db.prepare('SELECT * FROM restaurant_expenses WHERE id=?').get(id));});
admin.delete('/expenses/:id',(req,res)=>{db.prepare('DELETE FROM restaurant_expenses WHERE id=?').run(Number(req.params.id));res.json({ok:true});});
admin.get('/dashboard',(req,res)=>{const rid=Number(req.query.restaurant_id||0);const filter=rid?'AND b.restaurant_id=?':'';const args=rid?[rid]:[];const bookings=db.prepare(`SELECT COUNT(*) total,SUM(status='confirmed') confirmed FROM bookings b WHERE date=? ${filter}`).get(L.bangkokToday(),...args);const food=db.prepare(`SELECT COUNT(DISTINCT fo.id) orders,COALESCE(SUM(foi.unit_price*foi.quantity),0) total FROM food_orders fo JOIN bookings b ON b.id=fo.booking_id JOIN food_order_items foi ON foi.order_id=fo.id WHERE date(b.created_at)=? AND fo.status<>'cancelled' ${filter}`).get(L.bangkokToday(),...args);const paid=db.prepare(`SELECT COALESCE(SUM(fp.amount),0) total FROM food_payments fp JOIN bookings b ON b.id=fp.booking_id WHERE fp.status='paid' AND date(fp.paid_at)=? ${filter}`).get(L.bangkokToday(),...args);const bookingPaid=db.prepare(`SELECT COALESCE(SUM(x.amount-x.refund_amount),0) total FROM (SELECT booking_id,amount,refund_amount FROM payments WHERE status='paid' UNION ALL SELECT booking_id,amount,refund_amount FROM booking_cash_receipts) x JOIN bookings b ON b.id=x.booking_id WHERE date(b.date)=? ${filter}`).get(L.bangkokToday(),...args);const low=db.prepare(`SELECT COUNT(*) n FROM ingredients WHERE stock<=min_stock ${rid?'AND restaurant_id=?':''}`).get(...args).n;res.json({date:L.bangkokToday(),bookings,food,booking_paid:bookingPaid.total,food_paid:paid.total,low_stock:low});});
admin.get('/sales-summary',(req,res)=>{const rid=Number(req.query.restaurant_id||0),from=L.isDate(req.query.from)?req.query.from:L.addDays(L.bangkokToday(),-29),to=L.isDate(req.query.to)?req.query.to:L.bangkokToday();const where=rid?'AND b.restaurant_id=?':'';const args=rid?[from,to,rid]:[from,to];const booking=db.prepare(`SELECT COALESCE(SUM(x.amount-x.refund_amount),0) total FROM (SELECT booking_id,amount,refund_amount FROM payments WHERE status='paid' UNION ALL SELECT booking_id,amount,refund_amount FROM booking_cash_receipts) x JOIN bookings b ON b.id=x.booking_id WHERE b.date BETWEEN ? AND ? ${where}`).get(...args).total;const meals=db.prepare(`SELECT COALESCE(SUM(fp.amount),0) total FROM food_payments fp JOIN bookings b ON b.id=fp.booking_id WHERE fp.status='paid' AND date(fp.paid_at) BETWEEN ? AND ? ${where}`).get(...args).total;const expenses=db.prepare(`SELECT COALESCE(SUM(amount),0) total FROM restaurant_expenses WHERE expense_date BETWEEN ? AND ? ${rid?'AND restaurant_id=?':''}`).get(...args).total;res.json({from,to,booking_revenue:booking,food_revenue:meals,expenses,net:booking+meals-expenses});});

admin.get('/restaurants', (_req, res) => res.json(db.prepare('SELECT * FROM restaurants ORDER BY id').all()));
function restaurantFields(b) {
  const f = {
    name: L.cleanStr(b.name, 120), description: L.cleanStr(b.description, 1000), address: L.cleanStr(b.address, 300),
    phone: L.cleanStr(b.phone, 30), open_time: L.cleanStr(b.open_time, 5), close_time: L.cleanStr(b.close_time, 5),
    slot_minutes: Number(b.slot_minutes || 120), emoji: L.cleanStr(b.emoji, 8) || '🍽️', image_url: L.cleanStr(b.image_url, 500),
    promptpay_id: L.cleanStr(b.promptpay_id, 20).replace(/\D/g, ''),
    refund_full_hours: Number(b.refund_full_hours ?? 24), refund_half_hours: Number(b.refund_half_hours ?? 6),
  };
  if (!f.name) throw new HttpError(400, 'กรุณากรอกชื่อร้าน');
  if (!L.isTime(f.open_time) || !L.isTime(f.close_time) || L.toMin(f.open_time) >= L.toMin(f.close_time)) throw new HttpError(400, 'เวลาเปิด-ปิดไม่ถูกต้อง');
  if (!Number.isInteger(f.slot_minutes) || f.slot_minutes < 30 || f.slot_minutes > 480) throw new HttpError(400, 'ระยะเวลาต่อรอบต้อง 30–480 นาที');
  if (!L.validUrl(f.image_url)) throw new HttpError(400, 'URL รูปภาพไม่ถูกต้อง');
  if (!/^\d{9,15}$/.test(f.promptpay_id)) throw new HttpError(400, 'หมายเลข PromptPay ต้องเป็นเบอร์โทร/เลขบัตร 9–15 หลัก');
  if (!(f.refund_full_hours >= f.refund_half_hours && f.refund_half_hours >= 0)) throw new HttpError(400, 'เงื่อนไขคืนเงินไม่ถูกต้อง');
  return f;
}
const RCOLS = ['name', 'description', 'address', 'phone', 'open_time', 'close_time', 'slot_minutes', 'emoji', 'image_url', 'promptpay_id', 'refund_full_hours', 'refund_half_hours'];
admin.post('/restaurants', (req, res) => {
  const f = restaurantFields(req.body);
  const id = Number(db.prepare(`INSERT INTO restaurants (${RCOLS.join(',')}) VALUES (${RCOLS.map(() => '?').join(',')})`).run(...RCOLS.map((c) => f[c])).lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM restaurants WHERE id=?').get(id));
});
admin.put('/restaurants/:id', (req, res) => {
  const f = restaurantFields(req.body); const active = req.body.active === 0 || req.body.active === false ? 0 : 1;
  const r = db.prepare(`UPDATE restaurants SET ${RCOLS.map((c) => `${c}=?`).join(',')}, active=? WHERE id=?`).run(...RCOLS.map((c) => f[c]), active, Number(req.params.id));
  if (!r.changes) throw new HttpError(404, 'ไม่พบร้านอาหาร');
  res.json(db.prepare('SELECT * FROM restaurants WHERE id=?').get(Number(req.params.id)));
});
admin.get('/restaurants/:id/details', (req, res) => {
  const id = Number(req.params.id);
  res.json({
    menu: db.prepare('SELECT * FROM menu_items WHERE restaurant_id=? ORDER BY id').all(id),
    promotions: db.prepare('SELECT * FROM promotions WHERE restaurant_id=? ORDER BY id').all(id),
    tables: db.prepare('SELECT * FROM dining_tables WHERE restaurant_id=? ORDER BY type, id').all(id).map(tableOut),
  });
});
admin.post('/restaurants/:id/menu', (req, res) => {
  const name = L.cleanStr(req.body.name, 120), price = Number(req.body.price), img = L.cleanStr(req.body.image_url, 500);
  if (!name || !(price >= 0)) throw new HttpError(400, 'กรอกชื่อและราคาให้ถูกต้อง');
  if (!L.validUrl(img)) throw new HttpError(400, 'URL รูปภาพไม่ถูกต้อง');
  db.prepare('INSERT INTO menu_items (restaurant_id,name,price,description,emoji,image_url) VALUES (?,?,?,?,?,?)')
    .run(Number(req.params.id), name, price, L.cleanStr(req.body.description, 300), L.cleanStr(req.body.emoji, 8) || '🍲', img);
  res.status(201).json({ ok: true });
});
admin.delete('/menu/:id', (req, res) => { db.prepare('DELETE FROM menu_items WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });
admin.post('/restaurants/:id/promotions', (req, res) => {
  const title = L.cleanStr(req.body.title, 150), until = L.cleanStr(req.body.valid_until, 10);
  if (!title) throw new HttpError(400, 'กรุณากรอกชื่อโปรโมชั่น');
  if (until && !L.isDate(until)) throw new HttpError(400, 'วันที่สิ้นสุดไม่ถูกต้อง');
  db.prepare('INSERT INTO promotions (restaurant_id,title,description,valid_until) VALUES (?,?,?,?)')
    .run(Number(req.params.id), title, L.cleanStr(req.body.description, 500), until);
  res.status(201).json({ ok: true });
});
admin.delete('/promotions/:id', (req, res) => { db.prepare('DELETE FROM promotions WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });

function tableFields(b) {
  const perks = Array.isArray(b.perks) ? b.perks : String(b.perks || '').split(',');
  const f = {
    label: L.cleanStr(b.label, 20), type: b.type, seats: Number(b.seats), price: Number(b.price), service_fee: Number(b.service_fee || 0),
    x: Number(b.x ?? 20), y: Number(b.y ?? 20), w: Number(b.w ?? 70), h: Number(b.h ?? 70), shape: b.shape || 'rect',
    image_url: L.cleanStr(b.image_url, 500), description: L.cleanStr(b.description, 300),
    perks: JSON.stringify(perks.map((p) => L.cleanStr(p, 60)).filter(Boolean).slice(0, 12)), status: b.status || 'active',
  };
  if (!f.label) throw new HttpError(400, 'กรุณากรอกหมายเลขโต๊ะ');
  if (!['normal', 'vip'].includes(f.type)) throw new HttpError(400, 'ประเภทโต๊ะไม่ถูกต้อง');
  if (!Number.isInteger(f.seats) || f.seats < 1 || f.seats > 100) throw new HttpError(400, 'จำนวนที่นั่งต้อง 1–100');
  if (!(f.price >= 0) || !(f.service_fee >= 0)) throw new HttpError(400, 'ราคา/ค่าบริการไม่ถูกต้อง');
  if ([f.x, f.y, f.w, f.h].some((n) => !Number.isFinite(n) || n < 0 || n > 1000) || f.w < 20 || f.h < 20) throw new HttpError(400, 'ตำแหน่ง/ขนาดโต๊ะไม่ถูกต้อง');
  if (!['rect', 'round'].includes(f.shape)) throw new HttpError(400, 'รูปทรงโต๊ะไม่ถูกต้อง');
  if (!['active', 'maintenance', 'inactive'].includes(f.status)) throw new HttpError(400, 'สถานะโต๊ะไม่ถูกต้อง');
  if (!L.validUrl(f.image_url)) throw new HttpError(400, 'URL รูปภาพไม่ถูกต้อง');
  return f;
}
const TCOLS = ['label', 'type', 'seats', 'price', 'service_fee', 'x', 'y', 'w', 'h', 'shape', 'image_url', 'description', 'perks', 'status'];
const dupMsg = (e) => { if (/UNIQUE/.test(String(e.message))) throw new HttpError(409, 'หมายเลขโต๊ะซ้ำในร้านเดียวกัน'); throw e; };
admin.post('/restaurants/:id/tables', (req, res) => {
  const f = tableFields(req.body);
  try {
    const id = Number(db.prepare(`INSERT INTO dining_tables (restaurant_id,${TCOLS.join(',')}) VALUES (?,${TCOLS.map(() => '?').join(',')})`)
      .run(Number(req.params.id), ...TCOLS.map((c) => f[c])).lastInsertRowid);
    res.status(201).json({ id });
  } catch (e) { dupMsg(e); }
});
admin.put('/tables/:id', (req, res) => {
  const f = tableFields(req.body);
  try {
    const r = db.prepare(`UPDATE dining_tables SET ${TCOLS.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...TCOLS.map((c) => f[c]), Number(req.params.id));
    if (!r.changes) throw new HttpError(404, 'ไม่พบโต๊ะ');
    res.json({ ok: true });
  } catch (e) { if (e instanceof HttpError) throw e; dupMsg(e); }
});
admin.patch('/tables/:id/status', (req, res) => {
  if (!['active', 'maintenance', 'inactive'].includes(req.body.status)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
  const r = db.prepare('UPDATE dining_tables SET status=? WHERE id=?').run(req.body.status, Number(req.params.id));
  if (!r.changes) throw new HttpError(404, 'ไม่พบโต๊ะ');
  res.json({ ok: true });
});
admin.delete('/tables/:id', (req, res) => {
  const id = Number(req.params.id);
  sweep();
  if (db.prepare("SELECT 1 FROM bookings WHERE table_id=? AND status IN ('pending_payment','confirmed') AND date >= ?").get(id, L.bangkokToday()))
    throw new HttpError(409, 'โต๊ะนี้มีการจองที่ยังไม่สิ้นสุด กรุณายกเลิกการจองก่อน หรือเปลี่ยนสถานะเป็นปิดใช้งาน');
  if (db.prepare('SELECT 1 FROM bookings WHERE table_id=?').get(id)) {
    db.prepare("UPDATE dining_tables SET status='inactive' WHERE id=?").run(id);
    return res.json({ ok: true, softDeleted: true });
  }
  db.prepare('DELETE FROM dining_tables WHERE id=?').run(id);
  res.json({ ok: true });
});

admin.get('/bookings', (req, res) => {
  sweep();
  const q = req.query, where = [], args = [];
  if (['pending_payment', 'confirmed', 'expired', 'cancelled'].includes(q.status)) { where.push('b.status=?'); args.push(q.status); }
  if (['normal', 'vip'].includes(q.type)) { where.push('b.table_type=?'); args.push(q.type); }
  if (L.isDate(q.date)) { where.push('b.date=?'); args.push(q.date); }
  if (q.restaurant_id) { where.push('b.restaurant_id=?'); args.push(Number(q.restaurant_id)); }
  res.json(db.prepare(`${BOOKING_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.id DESC LIMIT 300`).all(...args));
});
admin.post('/bookings/:id/cancel', (req, res) => res.json(cancelBooking(req.params.id, null, true)));
admin.post('/bookings/:id/pay-cash', (req,res) => res.status(201).json({receipt:receiveBookingCash(req.params.id,req.user.id)}));
admin.get('/cash-receipts', (req,res) => res.json(db.prepare('SELECT cr.*,b.code,u.name AS customer_name,staff.name AS received_by_name FROM booking_cash_receipts cr JOIN bookings b ON b.id=cr.booking_id JOIN users u ON u.id=b.user_id LEFT JOIN users staff ON staff.id=cr.received_by ORDER BY cr.id DESC LIMIT 300').all()));
admin.post('/cash-receipts/:id/refund-done',(req,res)=>{const r=db.prepare('SELECT cr.*,b.user_id,b.code FROM booking_cash_receipts cr JOIN bookings b ON b.id=cr.booking_id WHERE cr.id=?').get(Number(req.params.id));if(!r)throw new HttpError(404,'ไม่พบรายการ');if(r.refund_status!=='pending')throw new HttpError(409,'รายการนี้ไม่ได้รอคืนเงิน');db.prepare("UPDATE booking_cash_receipts SET refund_status='refunded',refunded_at=? WHERE id=?").run(nowIso(),r.id);notify(r.user_id,'คืนเงินสดเรียบร้อย',`คืนเงิน ${r.refund_amount} บาท สำหรับการจอง ${r.code} แล้ว`);res.json({ok:true});});
admin.get('/payments', (req, res) => {
  const q = req.query, where = [], args = [];
  if (['pending', 'paid', 'failed', 'expired', 'cancelled'].includes(q.status)) { where.push('p.status=?'); args.push(q.status); }
  if (['pending', 'refunded'].includes(q.refund)) { where.push('p.refund_status=?'); args.push(q.refund); }
  res.json(db.prepare(`SELECT p.*, b.code, b.table_type, b.date, b.start_time, u.name AS user_name, r.name AS restaurant_name
    FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN users u ON u.id=b.user_id JOIN restaurants r ON r.id=b.restaurant_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT 300`).all(...args));
});
admin.post('/payments/:id/refund-done', (req, res) => {
  const p = db.prepare('SELECT p.*, b.user_id, b.code FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE p.id=?').get(Number(req.params.id));
  if (!p) throw new HttpError(404, 'ไม่พบรายการ');
  if (p.refund_status !== 'pending') throw new HttpError(409, 'รายการนี้ไม่ได้รอคืนเงิน');
  db.prepare("UPDATE payments SET refund_status='refunded', refunded_at=? WHERE id=?").run(nowIso(), p.id);
  notify(p.user_id, 'คืนเงินเรียบร้อย', `คืนเงิน ${p.refund_amount} บาท สำหรับการจอง ${p.code} แล้ว`);
  res.json({ ok: true });
});
admin.get('/reports', (req, res) => {
  sweep();
  const today = L.bangkokToday();
  const from = L.isDate(req.query.from) ? req.query.from : L.addDays(today, -29);
  const to = L.isDate(req.query.to) ? req.query.to : L.addDays(today, 60);
  const rid = req.query.restaurant_id ? Number(req.query.restaurant_id) : null;
  const rf = rid ? 'AND b.restaurant_id=?' : '';
  const base = rid ? [from, to, rid] : [from, to];
  const byType = db.prepare(`SELECT b.table_type AS type,
      SUM(b.status='confirmed') AS confirmed, SUM(b.status='cancelled') AS cancelled, SUM(b.status='expired') AS expired, COUNT(*) AS total
      FROM bookings b WHERE b.date BETWEEN ? AND ? ${rf} GROUP BY b.table_type`).all(...base);
  const rev = db.prepare(`SELECT b.table_type AS type, COUNT(*) AS paid_count, SUM(x.amount) AS gross, SUM(x.refund_amount) AS refunds, SUM(x.amount-x.refund_amount) AS net
      FROM (SELECT booking_id,amount,refund_amount FROM payments WHERE status='paid' UNION ALL SELECT booking_id,amount,refund_amount FROM booking_cash_receipts) x JOIN bookings b ON b.id=x.booking_id WHERE b.date BETWEEN ? AND ? ${rf} GROUP BY b.table_type`).all(...base);
  const daily = db.prepare(`SELECT b.date, b.table_type AS type, COUNT(*) AS bookings, SUM(x.amount-x.refund_amount) AS net
      FROM (SELECT booking_id,amount,refund_amount FROM payments WHERE status='paid' UNION ALL SELECT booking_id,amount,refund_amount FROM booking_cash_receipts) x JOIN bookings b ON b.id=x.booking_id WHERE b.date BETWEEN ? AND ? ${rf} GROUP BY b.date, b.table_type ORDER BY b.date`).all(...base);
  const pendingRefunds = db.prepare("SELECT (SELECT COUNT(*) FROM payments WHERE refund_status='pending')+(SELECT COUNT(*) FROM booking_cash_receipts WHERE refund_status='pending') n, (SELECT COALESCE(SUM(refund_amount),0) FROM payments WHERE refund_status='pending')+(SELECT COALESCE(SUM(refund_amount),0) FROM booking_cash_receipts WHERE refund_status='pending') amt").get();
  res.json({ from, to, byType, revenue: rev, daily, pendingRefunds, note: 'รายได้สุทธิ = ยอดชำระ − ยอดคืนเงิน นับตามวันที่จอง' });
});

// ---------- Admin: จัดการข้อมูลลูกค้า ----------
function audit(req, action, target, detail = '') {
  db.prepare('INSERT INTO audit_logs (admin_id,admin_name,action,target_user_id,target_name,detail) VALUES (?,?,?,?,?,?)')
    .run(req.user.id, req.user.name, action, target ? target.id : null, target ? target.name : '', detail);
}
const CUSTOMER_SQL = `SELECT u.id,u.name,u.phone,u.email,u.role,u.blocked,u.note,u.created_at,u.updated_at,
  (SELECT COUNT(*) FROM bookings b WHERE b.user_id=u.id) AS bookings_total,
  (SELECT COUNT(*) FROM bookings b WHERE b.user_id=u.id AND b.status='confirmed') AS bookings_confirmed,
  ((SELECT COALESCE(SUM(p.amount-p.refund_amount),0) FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.user_id=u.id AND p.status='paid')+(SELECT COALESCE(SUM(cr.amount-cr.refund_amount),0) FROM booking_cash_receipts cr JOIN bookings b ON b.id=cr.booking_id WHERE b.user_id=u.id)) AS spent,
  (SELECT MAX(b.created_at) FROM bookings b WHERE b.user_id=u.id) AS last_booking_at
  FROM users u`;
const getCustomer = (id) => {
  const u = db.prepare(`${CUSTOMER_SQL} WHERE u.id=?`).get(Number(id));
  if (!u) throw new HttpError(404, 'ไม่พบลูกค้า');
  return u;
};
const activeAdmins = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND blocked=0").get().c;

admin.get('/customers', (req, res) => {
  const where = [], args = [];
  const q = L.cleanStr(req.query.q, 100);
  if (q) { where.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\')"); const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`; args.push(like, like, like); }
  if (['customer', 'admin'].includes(req.query.role)) { where.push('u.role=?'); args.push(req.query.role); }
  if (req.query.blocked === '1' || req.query.blocked === '0') { where.push('u.blocked=?'); args.push(Number(req.query.blocked)); }
  const rows = db.prepare(`${CUSTOMER_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.id DESC LIMIT 300`).all(...args);
  res.json(rows);
});
admin.get('/customers/:id', (req, res) => {
  const u = getCustomer(req.params.id);
  sweep();
  res.json({
    customer: u,
    bookings: db.prepare(`${BOOKING_SQL} WHERE b.user_id=? ORDER BY b.id DESC LIMIT 50`).all(u.id),
    logs: db.prepare('SELECT * FROM audit_logs WHERE target_user_id=? ORDER BY id DESC LIMIT 30').all(u.id),
  });
});
admin.post('/customers', (req, res) => {
  const p = validateProfile(req.body, { needPassword: true });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(p.email)) throw new HttpError(409, 'อีเมลนี้ถูกใช้งานแล้ว');
  const role = req.body.role === 'admin' ? 'admin' : 'customer';
  const id = Number(db.prepare('INSERT INTO users (name,phone,email,password_hash,role,note) VALUES (?,?,?,?,?,?)')
    .run(p.name, p.phone, p.email, L.hashPassword(req.body.password), role, L.cleanStr(req.body.note, 500)).lastInsertRowid);
  audit(req, 'create', { id, name: p.name }, `สร้างบัญชี (${role})`);
  res.status(201).json(getCustomer(id));
});
admin.put('/customers/:id', (req, res) => {
  const old = getCustomer(req.params.id);
  const p = validateProfile(req.body, { needPassword: false });
  if (db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(p.email, old.id)) throw new HttpError(409, 'อีเมลนี้ถูกใช้งานแล้ว');
  const note = L.cleanStr(req.body.note, 500);
  const role = req.body.role === 'admin' ? 'admin' : 'customer';
  if (role !== old.role) {
    if (old.id === req.user.id) throw new HttpError(400, 'ไม่สามารถเปลี่ยนสิทธิ์ของบัญชีตัวเองได้');
    if (old.role === 'admin' && activeAdmins() <= 1) throw new HttpError(400, 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
  }
  db.prepare("UPDATE users SET name=?, phone=?, email=?, note=?, role=?, updated_at=? WHERE id=?").run(p.name, p.phone, p.email, note, role, nowIso(), old.id);
  if (role !== old.role) db.prepare('DELETE FROM sessions WHERE user_id=?').run(old.id);
  const diff = [['ชื่อ', old.name, p.name], ['เบอร์โทร', old.phone, p.phone], ['อีเมล', old.email, p.email], ['หมายเหตุ', old.note, note], ['สิทธิ์', old.role, role]]
    .filter(([, a, b]) => a !== b).map(([k, a, b]) => k === 'หมายเหตุ' ? 'แก้ไขหมายเหตุ' : `${k}: ${a} → ${b}`);
  if (diff.length) audit(req, 'update', old, diff.join(' | '));
  res.json(getCustomer(old.id));
});
admin.patch('/customers/:id/block', (req, res) => {
  const u = getCustomer(req.params.id); const blocked = req.body.blocked ? 1 : 0;
  if (blocked) {
    if (u.id === req.user.id) throw new HttpError(400, 'ไม่สามารถระงับบัญชีของตัวเองได้');
    if (u.role === 'admin' && activeAdmins() <= 1) throw new HttpError(400, 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
  }
  db.prepare('UPDATE users SET blocked=?, updated_at=? WHERE id=?').run(blocked, nowIso(), u.id);
  if (blocked) db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  audit(req, blocked ? 'block' : 'unblock', u, blocked ? 'ระงับบัญชี' : 'ปลดระงับบัญชี');
  res.json(getCustomer(u.id));
});
admin.post('/customers/:id/reset-password', (req, res) => {
  const u = getCustomer(req.params.id);
  const pw = req.body.password;
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 100) throw new HttpError(400, 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
  db.prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?').run(L.hashPassword(pw), nowIso(), u.id);
  if (u.id !== req.user.id) db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  audit(req, 'reset_password', u, 'ตั้งรหัสผ่านใหม่ให้ลูกค้า');
  res.json({ ok: true });
});
admin.delete('/customers/:id', (req, res) => {
  const u = getCustomer(req.params.id);
  if (u.id === req.user.id) throw new HttpError(400, 'ไม่สามารถลบบัญชีของตัวเองได้');
  if (u.role === 'admin' && activeAdmins() <= 1) throw new HttpError(400, 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
  if (u.bookings_total > 0) throw new HttpError(409, 'ลูกค้ารายนี้มีประวัติการจอง ไม่สามารถลบได้ (เพื่อเก็บหลักฐานทางการเงิน) กรุณาใช้ "ระงับบัญชี" แทน');
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  audit(req, 'delete', u, 'ลบบัญชี');
  res.json({ ok: true });
});
admin.get('/audit-logs', (_req, res) => res.json(db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all()));

// พื้นที่พนักงาน: สิทธิ์แยกจากแอดมินและจำกัดตาม permission ที่กำหนด
const staff = express.Router();
staff.use(auth);
staff.get('/me',(req,res)=>{if(req.user.role!=='admin'&&!req.staff)throw new HttpError(403,'บัญชีนี้ไม่ได้รับสิทธิ์พนักงาน');res.json({user:pubUser(req.user),permissions:req.staff?.permissions||['all']});});
staff.get('/orders',(req,res)=>{if(req.user.role!=='admin'&&(!req.staff||!req.staff.permissions.includes('orders')&&!req.staff.permissions.includes('kitchen')))throw new HttpError(403,'ไม่มีสิทธิ์ดูออเดอร์');const rows=db.prepare("SELECT id FROM food_orders WHERE status IN ('submitted','preparing') ORDER BY created_at ASC LIMIT 200").all();res.json(rows.map(x=>foodOrderOut(x.id)));});
staff.post('/orders',staffOnly('orders'),(req,res)=>res.status(201).json(createFoodOrder(req.body.booking_id,req.body.items,'staff',req.user.id,req.body.note))); 
staff.patch('/orders/:id/status',staffOnly('kitchen'),(req,res)=>{const status=req.body.status,id=Number(req.params.id);if(!['preparing','served'].includes(status))throw new HttpError(400,'สถานะไม่ถูกต้อง');const current=db.prepare('SELECT * FROM food_orders WHERE id=?').get(id);if(!current)throw new HttpError(404,'ไม่พบออเดอร์');if(current.status==='served')throw new HttpError(409,'ออเดอร์นี้เสิร์ฟแล้ว');tx(()=>{if(status==='served'){const lines=db.prepare('SELECT mr.ingredient_id,mr.quantity*foi.quantity AS qty FROM food_order_items foi JOIN menu_recipes mr ON mr.menu_item_id=foi.menu_item_id WHERE foi.order_id=?').all(id);for(const line of lines){const ing=db.prepare('SELECT * FROM ingredients WHERE id=?').get(line.ingredient_id);if(!ing||ing.stock<line.qty)throw new HttpError(409,`วัตถุดิบ ${ing?.name||line.ingredient_id} ไม่เพียงพอ`);db.prepare('UPDATE ingredients SET stock=stock-?,updated_at=? WHERE id=?').run(line.qty,nowIso(),ing.id);db.prepare("INSERT INTO stock_movements (ingredient_id,user_id,movement,quantity,note) VALUES (?,?,'out',?,?)").run(ing.id,req.user.id,line.qty,`ตัดสต็อกจากออเดอร์ #${id}`);}}db.prepare('UPDATE food_orders SET status=?,updated_at=? WHERE id=?').run(status,nowIso(),id);});res.json(foodOrderOut(id));});
staff.post('/bookings/:id/pay-cash',staffOnly('booking_cash'),(req,res)=>res.status(201).json({receipt:receiveBookingCash(req.params.id,req.user.id)}));
staff.post('/bookings/:id/food/pay-cash',staffOnly('food_cash'),(req,res)=>{const result=tx(()=>{const b=foodBooking(req.params.id,null),bill=foodBill(b.id);if(bill.balance<=0)throw new HttpError(409,'ไม่มียอดค้างชำระ');const receipt='FRC'+Date.now().toString().slice(-10);const id=Number(db.prepare("INSERT INTO food_payments (booking_id,amount,method,status,reference,receipt_no,paid_at) VALUES (?,?, 'cash','paid',?,?,?)").run(b.id,bill.balance,'FS'+crypto.randomBytes(6).toString('hex').toUpperCase(),receipt,nowIso()).lastInsertRowid);return {b,bill,payment:db.prepare('SELECT * FROM food_payments WHERE id=?').get(id)};});notify(result.b.user_id,'ชำระค่าอาหารสำเร็จ',`รับชำระเงินสด ${result.bill.balance} บาท ใบเสร็จ ${result.payment.receipt_no}`);res.status(201).json({payment:result.payment});});
app.use('/api/staff',staff);

// จัดการบัญชีพนักงานโดยแอดมิน
admin.get('/staff',(req,res)=>res.json(db.prepare('SELECT u.id,u.name,u.phone,u.email,u.blocked,sm.permissions,sm.active,sm.created_at FROM staff_members sm JOIN users u ON u.id=sm.user_id ORDER BY u.name').all().map(x=>({...x,permissions:JSON.parse(x.permissions||'[]')}))));
admin.post('/staff',(req,res)=>{const p=validateProfile(req.body,{needPassword:true});if(db.prepare('SELECT 1 FROM users WHERE email=?').get(p.email))throw new HttpError(409,'อีเมลนี้ถูกใช้งานแล้ว');const perms=Array.isArray(req.body.permissions)?req.body.permissions.filter(x=>['orders','kitchen','booking_cash','food_cash'].includes(x)):['orders','kitchen'];if(!perms.length)throw new HttpError(400,'กรุณาเลือกสิทธิ์พนักงานอย่างน้อย 1 รายการ');const id=Number(tx(()=>{const uid=Number(db.prepare("INSERT INTO users (name,phone,email,password_hash,role) VALUES (?,?,?,?,'customer')").run(p.name,p.phone,p.email,L.hashPassword(req.body.password)).lastInsertRowid);db.prepare('INSERT INTO staff_members (user_id,permissions) VALUES (?,?)').run(uid,JSON.stringify(perms));return uid;}));res.status(201).json({id,...p,permissions:perms});});
admin.put('/staff/:id',(req,res)=>{const id=Number(req.params.id),perms=Array.isArray(req.body.permissions)?req.body.permissions.filter(x=>['orders','kitchen','booking_cash','food_cash'].includes(x)):[];if(!db.prepare('SELECT 1 FROM staff_members WHERE user_id=?').get(id))throw new HttpError(404,'ไม่พบพนักงาน');if(!perms.length)throw new HttpError(400,'กรุณาเลือกสิทธิ์อย่างน้อย 1 รายการ');db.prepare('UPDATE staff_members SET permissions=?,active=? WHERE user_id=?').run(JSON.stringify(perms),req.body.active===false?0:1,id);if(req.body.password){if(String(req.body.password).length<8)throw new HttpError(400,'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(L.hashPassword(req.body.password),id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);}res.json({ok:true});});
admin.delete('/staff/:id',(req,res)=>{const id=Number(req.params.id);if(!db.prepare('SELECT 1 FROM staff_members WHERE user_id=?').get(id))throw new HttpError(404,'ไม่พบพนักงาน');db.prepare('DELETE FROM staff_members WHERE user_id=?').run(id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);res.json({ok:true});});

app.use('/api/admin', admin);

// ---------- error handling ----------
app.use('/api', (_req, res) => res.status(404).json({ error: 'ไม่พบ API ที่ร้องขอ' }));
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' });
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Restaurant booking running at http://localhost:${PORT} (payment mode: ${PAYMENT_MODE})`));
}
module.exports = app;
