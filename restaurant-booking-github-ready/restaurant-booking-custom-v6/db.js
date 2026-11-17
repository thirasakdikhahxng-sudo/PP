'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const L = require('./lib');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, process.env.DB_FILE || 'booking.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  open_time TEXT NOT NULL DEFAULT '10:00',
  close_time TEXT NOT NULL DEFAULT '22:00',
  slot_minutes INTEGER NOT NULL DEFAULT 120,
  emoji TEXT NOT NULL DEFAULT '🍽️',
  image_url TEXT NOT NULL DEFAULT '',
  promptpay_id TEXT NOT NULL DEFAULT '',
  refund_full_hours INTEGER NOT NULL DEFAULT 24,
  refund_half_hours INTEGER NOT NULL DEFAULT 6,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '🍲',
  image_url TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  valid_until TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS dining_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'normal' CHECK (type IN ('normal','vip')),
  seats INTEGER NOT NULL CHECK (seats > 0),
  price REAL NOT NULL DEFAULT 0,
  service_fee REAL NOT NULL DEFAULT 0,
  x REAL NOT NULL DEFAULT 20, y REAL NOT NULL DEFAULT 20,
  w REAL NOT NULL DEFAULT 70, h REAL NOT NULL DEFAULT 70,
  shape TEXT NOT NULL DEFAULT 'rect' CHECK (shape IN ('rect','round')),
  image_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  perks TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','inactive')),
  UNIQUE (restaurant_id, label)
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  table_id INTEGER NOT NULL REFERENCES dining_tables(id),
  table_type TEXT NOT NULL,
  party_size INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_payment','confirmed','expired','cancelled')),
  amount REAL NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cancelled_at TEXT,
  cancel_reason TEXT
);
-- กันการจองซ้ำระดับฐานข้อมูล (โต๊ะ+วัน+เวลาเริ่มเดียวกัน) นอกเหนือจากการตรวจช่วงเวลาซ้อนในโค้ด
CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_active_slot
  ON bookings(table_id, date, start_time) WHERE status IN ('pending_payment','confirmed');
CREATE INDEX IF NOT EXISTS ix_booking_lookup ON bookings(table_id, date, status);
CREATE INDEX IF NOT EXISTS ix_booking_user ON bookings(user_id, id);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  method TEXT NOT NULL CHECK (method IN ('promptpay','mobile_banking')),
  bank TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired','cancelled')),
  gateway_txn TEXT NOT NULL DEFAULT '',
  paid_at TEXT,
  receipt_no TEXT,
  refund_amount REAL NOT NULL DEFAULT 0,
  refund_status TEXT NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none','pending','refunded')),
  refunded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_payment_booking ON payments(booking_id);
CREATE TABLE IF NOT EXISTS food_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  created_by INTEGER REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'customer' CHECK(source IN ('customer','staff')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('draft','submitted','preparing','served','cancelled')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS food_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES food_orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  item_name TEXT NOT NULL,
  unit_price REAL NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS booking_cash_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
  amount REAL NOT NULL CHECK(amount > 0),
  receipt_no TEXT NOT NULL UNIQUE,
  received_by INTEGER REFERENCES users(id),
  refund_amount REAL NOT NULL DEFAULT 0,
  refund_status TEXT NOT NULL DEFAULT 'none' CHECK(refund_status IN ('none','pending','refunded')),
  refunded_at TEXT,
  paid_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_booking_cash_booking ON booking_cash_receipts(booking_id);
CREATE TABLE IF NOT EXISTS staff_members (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  permissions TEXT NOT NULL DEFAULT '["orders","kitchen","booking_cash","food_cash"]',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS food_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  amount REAL NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('promptpay','cash','mobile_banking')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed')),
  reference TEXT NOT NULL UNIQUE,
  receipt_no TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_food_orders_booking ON food_orders(booking_id,id);
CREATE INDEX IF NOT EXISTS ix_food_payments_booking ON food_payments(booking_id,id);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

// ---------- ย้ายฐานข้อมูลเดิม (เพิ่มคอลัมน์สำหรับการจัดการลูกค้า) ----------
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('note')) db.exec("ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT ''");
if (!userCols.includes('blocked')) db.exec('ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('updated_at')) db.exec('ALTER TABLE users ADD COLUMN updated_at TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  admin_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_user_id INTEGER,
  target_name TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_target ON audit_logs(target_user_id, id);
CREATE TABLE IF NOT EXISTS ingredients (
 id INTEGER PRIMARY KEY AUTOINCREMENT, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
 name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'หน่วย', stock REAL NOT NULL DEFAULT 0 CHECK(stock>=0),
 min_stock REAL NOT NULL DEFAULT 0 CHECK(min_stock>=0), cost_per_unit REAL NOT NULL DEFAULT 0 CHECK(cost_per_unit>=0),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(restaurant_id,name)
);
CREATE TABLE IF NOT EXISTS menu_recipes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
 ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE, quantity REAL NOT NULL CHECK(quantity>0),
 UNIQUE(menu_item_id,ingredient_id)
);
CREATE TABLE IF NOT EXISTS stock_movements (
 id INTEGER PRIMARY KEY AUTOINCREMENT, ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
 user_id INTEGER REFERENCES users(id), movement TEXT NOT NULL CHECK(movement IN ('in','out','adjust')),
 quantity REAL NOT NULL CHECK(quantity>0), note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS restaurant_expenses (
 id INTEGER PRIMARY KEY AUTOINCREMENT, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
 category TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', amount REAL NOT NULL CHECK(amount>0), expense_date TEXT NOT NULL,
 created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_ingredients_restaurant ON ingredients(restaurant_id,name);
CREATE INDEX IF NOT EXISTS ix_stock_movements_ingredient ON stock_movements(ingredient_id,id);
CREATE INDEX IF NOT EXISTS ix_expenses_restaurant_date ON restaurant_expenses(restaurant_id,expense_date);
`);

// ---------- ข้อมูลตั้งต้น ----------
function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
    const pw = process.env.ADMIN_PASSWORD || 'admin1234';
    db.prepare("INSERT INTO users (name,phone,email,password_hash,role) VALUES (?,?,?,?,'admin')")
      .run('ผู้ดูแลระบบ', '0800000000', process.env.ADMIN_EMAIL || 'admin@example.com', L.hashPassword(pw));
    if (!process.env.ADMIN_PASSWORD) console.warn('[seed] สร้างแอดมิน admin@example.com / admin1234 — กรุณาเปลี่ยนรหัสผ่านก่อนใช้งานจริง (ตั้ง ADMIN_PASSWORD)');
  }
  if (db.prepare('SELECT COUNT(*) c FROM restaurants').get().c > 0) return;

  const insR = db.prepare(`INSERT INTO restaurants
    (name,description,address,phone,open_time,close_time,slot_minutes,emoji,promptpay_id,refund_full_hours,refund_half_hours)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insT = db.prepare(`INSERT INTO dining_tables
    (restaurant_id,label,type,seats,price,service_fee,x,y,w,h,shape,description,perks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insM = db.prepare('INSERT INTO menu_items (restaurant_id,name,price,description,emoji) VALUES (?,?,?,?,?)');
  const insP = db.prepare('INSERT INTO promotions (restaurant_id,title,description,valid_until) VALUES (?,?,?,?)');
  const pp = process.env.PROMPTPAY_ID || '0812345678';

  const r1 = Number(insR.run('ครัวบ้านสวน', 'อาหารไทยรสจัดจ้านในบรรยากาศสวนร่มรื่น เหมาะกับครอบครัวและงานเลี้ยงสังสรรค์',
    '123 ถ.มิตรภาพ ต.ในเมือง อ.เมือง จ.ขอนแก่น', '043-000-111', '10:00', '22:00', 120, '🌿', pp, 24, 6).lastInsertRowid);
  const r2 = Number(insR.run('Sakura Dining', 'ร้านอาหารญี่ปุ่นสไตล์โอมากาเสะ ซูชิและเทปันยากิสดใหม่ทุกวัน',
    '45 ถ.กลางเมือง ต.ในเมือง อ.เมือง จ.ขอนแก่น', '043-000-222', '11:00', '23:00', 120, '🍣', pp, 24, 6).lastInsertRowid);

  const normal = (rid, seatsList, prefix) => seatsList.forEach((s, i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const shape = s <= 2 ? 'round' : 'rect';
    const w = shape === 'round' ? 64 : 60 + s * 8, h = shape === 'round' ? 64 : 64;
    insT.run(rid, `${prefix}${i + 1}`, 'normal', s, s <= 2 ? 100 : s <= 4 ? 150 : 250, 0,
      30 + col * 150, 40 + row * 140, w, h, shape, `โต๊ะสำหรับ ${s} ที่นั่ง`, '[]');
  });
  normal(r1, [2, 2, 4, 4, 4, 6, 6, 8], 'A');
  normal(r2, [2, 2, 2, 4, 4, 6], 'B');

  const vip = (rid, list, prefix) => list.forEach(([s, price, fee, name, perks], i) => {
    insT.run(rid, `${prefix}${i + 1}`, 'vip', s, price, fee, 30 + i * 200, 90, 170, 160, 'rect', name, JSON.stringify(perks));
  });
  const perks = ['ห้องส่วนตัว', 'โซฟาหนังนุ่ม', 'พนักงานบริการส่วนตัว', 'เครื่องดื่มต้อนรับ'];
  vip(r1, [[6, 800, 80, 'ห้อง VIP สวนไผ่ (6 ที่นั่ง)', perks], [10, 1500, 150, 'ห้อง VIP ศาลาไทย (10 ที่นั่ง)', perks],
    [16, 2500, 250, 'ห้อง VIP ริมน้ำ (16 ที่นั่ง) พร้อมคาราโอเกะ', [...perks, 'ระบบเสียงคาราโอเกะ']]], 'V');
  vip(r2, [[4, 1000, 100, 'ห้อง VIP เทปันยากิ (4 ที่นั่ง)', perks], [8, 2000, 200, 'ห้อง VIP ทาทามิ (8 ที่นั่ง)', [...perks, 'เชฟส่วนตัวหน้าโต๊ะ']]], 'V');

  [['ต้มยำกุ้งน้ำข้น', 220, 'กุ้งแม่น้ำตัวโต น้ำซุปเข้มข้น', '🍤'], ['ลาบหมูทอด', 120, 'ลาบสูตรอีสาน หอมข้าวคั่ว', '🥗'],
    ['ปลากะพงทอดน้ำปลา', 380, 'ปลากะพงสดทอดกรอบ', '🐟'], ['ส้มตำปูปลาร้า', 80, 'เผ็ดจัดจ้าน', '🥭']]
    .forEach(([n, p, d, e]) => insM.run(r1, n, p, d, e));
  [['ซูชิเซ็ตพรีเมียม', 590, 'ปลาสดนำเข้า 12 คำ', '🍣'], ['เทปันยากิเนื้อวากิว', 890, 'ย่างสดหน้าโต๊ะ', '🥩'],
    ['ราเมนทงคตสึ', 220, 'น้ำซุปกระดูกหมูเคี่ยว 12 ชม.', '🍜']].forEach(([n, p, d, e]) => insM.run(r2, n, p, d, e));

  const until = L.addDays(L.bangkokToday(), 60);
  insP.run(r1, 'มาครบ 6 คน ฟรีน้ำเปล่าทั้งโต๊ะ', 'สำหรับการจองโต๊ะตั้งแต่ 6 ที่นั่งขึ้นไป', until);
  insP.run(r1, 'วันธรรมดาลด 10% ค่าอาหาร', 'จันทร์–พฤหัสบดี แสดงหมายเลขการจองที่ร้าน', until);
  insP.run(r2, 'เซ็ตซูชิคู่รัก ลด 15%', 'ทุกวันพุธ เมื่อจองโต๊ะ 2 ที่นั่ง', until);
}
seed();

db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))); INSERT OR IGNORE INTO schema_migrations(version) VALUES (6);`);

module.exports = db;
