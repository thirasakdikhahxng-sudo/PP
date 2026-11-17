'use strict';
/* ===== ตัวช่วยพื้นฐาน ===== */
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baht = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const fmtDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('th-TH', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDT = (iso) => iso ? new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }) : '-';
const todayBKK = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const safeUrl = (u) => (/^https?:\/\/\S+$/i.test(u || '') || /^\/[\w\-./]*$/.test(u || '')) ? u : '';

const S = { token: localStorage.getItem('token'), user: null, config: { banks: [] }, timers: [], actions: {}, forms: {}, changes: {} };
let adminRid = null;

function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = 'toast'; }, 3500);
}
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && S.token) setSession(null, null);
    const e = new Error((data && data.error) || 'เกิดข้อผิดพลาด'); e.status = res.status; throw e;
  }
  return data;
}
function setSession(token, user) {
  S.token = token; S.user = user; 
  if (token) localStorage.setItem('token', token); else localStorage.removeItem('token');
  renderNav();
}
const clearTimers = () => { S.timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); S.timers = []; };
const every = (fn, ms) => { const t = setInterval(fn, ms); S.timers.push(t); return t; };
function needLogin() {
  if (S.token) return false;
  sessionStorage.setItem('after', location.hash || '#/');
  location.hash = '#/login'; return true;
}
const on = (name, fn) => { S.actions[name] = fn; };
const onForm = (name, fn) => { S.forms[name] = fn; };
const onChange = (name, fn) => { S.changes[name] = fn; };
app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el || !S.actions[el.dataset.act]) return;
  if (el.tagName === 'A') e.preventDefault();
  if (el.disabled) return;
  try { await S.actions[el.dataset.act](el, e); } catch (err) { handleErr(err); }
});
app.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]'); if (!f || !S.forms[f.dataset.form]) return;
  e.preventDefault();
  const btn = f.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try { await S.forms[f.dataset.form](Object.fromEntries(new FormData(f)), f); } catch (err) { handleErr(err); }
  finally { if (btn) btn.disabled = false; }
});
app.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.tbl')) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
});
for (const ev of ['change', 'input']) app.addEventListener(ev, (e) => {
  const el = e.target.closest('[data-change]'); if (!el || !S.changes[el.dataset.change]) return;
  if (ev === 'input' && el.tagName === 'SELECT') return;
  try { S.changes[el.dataset.change](el, ev); } catch (err) { handleErr(err); }
});
function handleErr(err) {
  if (err.status === 401) { toast('กรุณาเข้าสู่ระบบ', true); needLogin(); return; }
  toast(err.message, true);
}

/* ===== ป้ายสถานะ ===== */
const BK = { pending_payment: ['รอชำระเงิน', 'b-warn'], confirmed: ['จองสำเร็จ', 'b-ok'], expired: ['หมดเวลาชำระเงิน', 'b-gray'], cancelled: ['ยกเลิกแล้ว', 'b-bad'] };
const PAYST = { pending: ['รอชำระ', 'b-warn'], paid: ['ชำระแล้ว', 'b-ok'], failed: ['ชำระไม่สำเร็จ', 'b-bad'], expired: ['หมดเวลา', 'b-gray'], cancelled: ['ยกเลิก', 'b-gray'] };
const REFUND = { none: ['-', 'b-gray'], pending: ['รอคืนเงิน', 'b-warn'], refunded: ['คืนเงินแล้ว', 'b-ok'] };
const badge = (map, k) => (map[k] ? `<span class="badge ${map[k][1]}">${map[k][0]}</span>` : '');
const typeBadge = (t) => t === 'vip' ? '<span class="badge b-vip">⭐ VIP</span>' : '<span class="badge b-gray">ธรรมดา</span>';
const methodLabel = (b) => !b.method ? '-' : b.method === 'cash' ? 'เงินสด (รับที่ร้าน)' : b.method === 'promptpay' ? 'PromptPay QR' : `Mobile Banking${b.bank ? ' (' + b.bank + ')' : ''}`;
const cover = (r) => `<div class="cover">${safeUrl(r.image_url) ? `<img src="${esc(r.image_url)}" alt="">` : esc(r.emoji)}</div>`;

/* ===== เมนูนำทาง + แจ้งเตือน ===== */
function renderNav() {
  const u = S.user; const n = $('#navlinks');
  n.innerHTML = `<a href="#/">ร้านอาหาร</a>` + (u ? `
    <a href="#/history">ประวัติการจอง</a>
    ${u.role === 'admin' ? '<a href="#/admin">จัดการระบบ</a>' : ''}
    ${u.is_staff ? '<a href="#/staff">พื้นที่พนักงาน</a>' : ''}
    <button class="bell" id="bell" aria-label="การแจ้งเตือน">🔔<span class="n hidden" id="bellN"></span></button>
    <a href="#/profile">👤 ${esc(u.name)}</a><button id="logout">ออกจากระบบ</button>`
    : `<a href="#/login">เข้าสู่ระบบ</a><a href="#/register" class="btn sm">สมัครสมาชิก</a>`);
  markNav();
  if (u) { $('#logout').onclick = logout; $('#bell').onclick = toggleNotif; refreshNotif(); }
}
function markNav() {
  const h = location.hash || '#/';
  document.querySelectorAll('#navlinks a:not(.btn)').forEach((a) => {
    const t = a.getAttribute('href');
    a.classList.toggle('on', t === '#/' ? (h === '#/' || h.startsWith('#/r/') || h.startsWith('#/book')) : h.startsWith(t));
  });
}
async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
  setSession(null, null); toast('ออกจากระบบแล้ว'); location.hash = '#/';
}
let lastUnread = null;
async function refreshNotif() {
  if (!S.token) return;
  try {
    const d = await api('/notifications');
    const n = $('#bellN'); if (!n) return;
    n.textContent = d.unread; n.classList.toggle('hidden', !d.unread);
    if (lastUnread !== null && d.unread > lastUnread) toast('🔔 ' + d.items[0].title);
    lastUnread = d.unread; S.notifs = d.items;
  } catch (_) { /* ignore */ }
}
async function toggleNotif(e) {
  e.stopPropagation();
  const old = $('.notif'); if (old) { old.remove(); return; }
  await refreshNotif();
  const box = document.createElement('div'); box.className = 'notif';
  box.innerHTML = (S.notifs || []).length ? S.notifs.map((x) => `<div><b>${esc(x.title)}</b>${x.is_read ? '' : ' 🔵'}<br><span class="muted">${esc(x.body)}</span><br><span class="muted small">${fmtDT(x.created_at)}</span></div>`).join('') : '<div class="muted">ยังไม่มีการแจ้งเตือน</div>';
  document.body.appendChild(box);
  api('/notifications/read', { method: 'POST' }).then(() => { lastUnread = 0; const n = $('#bellN'); if (n) n.classList.add('hidden'); }).catch(() => {});
}
document.addEventListener('click', (e) => { if (!e.target.closest('.notif') && !e.target.closest('#bell')) { const n = $('.notif'); if (n) n.remove(); } });
setInterval(refreshNotif, 20000);

/* ===== Router ===== */
window.addEventListener('hashchange', route);
async function route() {
  markNav();
  clearTimers(); S.actions = {}; S.forms = {}; S.changes = {};
  const n = $('.notif'); if (n) n.remove();
  const [path] = (location.hash.slice(1) || '/').split('?');
  const p = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    switch (p[0]) {
      case undefined: return await viewHome();
      case 'r': return await viewRestaurant(p[1]);
      case 'book': return await viewBook(p[1], p[2] === 'vip' ? 'vip' : 'normal');
      case 'pay': return await viewPay(p[1]);
      case 'done': return await viewDone(p[1]);
      case 'food': return await viewFoodOrder(p[1]);
      case 'history': return await viewHistory();
      case 'profile': return await viewProfile();
      case 'login': return viewAuth('login');
      case 'register': return viewAuth('register');
      case 'admin': return await viewAdmin(p[1] || 'dashboard');
      case 'staff': return await viewStaff();
      default: app.innerHTML = '<div class="alert warn">ไม่พบหน้าที่ต้องการ</div>';
    }
  } catch (e) {
    if (e.status === 401) { needLogin(); return; }
    app.innerHTML = `<div class="alert bad">${esc(e.message)}</div><p><a href="#/">กลับหน้าแรก</a></p>`;
  }
}

/* ===== สมัคร / เข้าสู่ระบบ ===== */
function viewAuth(mode) {
  const reg = mode === 'register';
  app.innerHTML = `<div class="card form"><h1>${reg ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ'}</h1>
  <form data-form="auth">
    ${reg ? `<label>ชื่อ-นามสกุล</label><input name="name" required minlength="2" maxlength="100" autocomplete="name">
    <label>เบอร์โทรศัพท์</label><input name="phone" required inputmode="tel" placeholder="0812345678" autocomplete="tel">` : ''}
    <label>อีเมล</label><input name="email" type="email" required autocomplete="email">
    <label>รหัสผ่าน${reg ? ' (อย่างน้อย 8 ตัวอักษร)' : ''}</label><input name="password" type="password" required ${reg ? 'minlength="8"' : ''} autocomplete="${reg ? 'new-password' : 'current-password'}">
    <p><button class="btn" type="submit" style="width:100%">${reg ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ'}</button></p>
  </form>
  <p class="center small">${reg ? 'มีบัญชีแล้ว? <a href="#/login">เข้าสู่ระบบ</a>' : 'ยังไม่มีบัญชี? <a href="#/register">สมัครสมาชิก</a>'}</p></div>`;
  onForm('auth', async (d) => {
    const r = await api(reg ? '/auth/register' : '/auth/login', { method: 'POST', body: d });
    setSession(r.token, r.user); toast(reg ? 'สมัครสมาชิกสำเร็จ' : 'เข้าสู่ระบบสำเร็จ');
    const after = sessionStorage.getItem('after'); sessionStorage.removeItem('after');
    location.hash = after || '#/';
  });
}

/* ===== หน้าแรก / ร้านอาหาร ===== */
async function viewHome() {
  app.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  const list = await api('/restaurants');
  app.innerHTML = `<section class="hero"><span class="eyebrow">Online Table Reservation</span>
    <h1>จองโต๊ะที่ใช่ ให้มื้อพิเศษของคุณ</h1>
    <p>เลือกร้านโปรด ดูแผนผังโต๊ะแบบเรียลไทม์ จองโต๊ะธรรมดาหรือห้อง VIP แล้วชำระเงินผ่าน PromptPay ได้ทันที</p>
    <a class="btn" href="#restaurants" data-act="scrollto">เลือกร้านอาหาร ↓</a><span class="emoji" aria-hidden="true">🍽️</span></section>
  <div class="steps"><div class="step"><i>1</i><div><b>เลือกร้าน</b><span>ดูเมนู โปรโมชั่น และโต๊ะ</span></div></div>
    <div class="step"><i>2</i><div><b>เลือกวัน-เวลา-โต๊ะ</b><span>จากแผนผังโต๊ะที่ว่างจริง</span></div></div>
    <div class="step"><i>3</i><div><b>ชำระเงิน</b><span>สแกน QR ภายในเวลาที่กำหนด</span></div></div>
    <div class="step"><i>4</i><div><b>รับการยืนยัน</b><span>แสดงหมายเลขจองเมื่อถึงร้าน</span></div></div></div>
  <h2 id="restaurants" style="margin-top:0">ร้านอาหารแนะนำ</h2><div class="grid">${list.map((r) => `
    <a class="card link" href="#/r/${r.id}">${cover(r)}<h3>${esc(r.name)}</h3>
    <p class="muted small" style="margin:2px 0 8px">${esc(r.description)}</p>
    <div class="pills"><span class="pill">🕒 ${esc(r.open_time)}–${esc(r.close_time)} น.</span>
    <span class="pill">🪑 ${r.normal.n} โต๊ะ${r.normal.n ? ` · ${baht(r.normal.minp)}+` : ''}</span>
    <span class="pill vip">⭐ VIP ${r.vip.n} ห้อง${r.vip.n ? ` · ${baht(r.vip.minp)}+` : ''}</span></div></a>`).join('')}</div>`;
  on('scrollto', () => $('#restaurants').scrollIntoView({ behavior: 'smooth' }));
}

async function viewRestaurant(id) {
  const r = await api('/restaurants/' + id);
  const normal = r.tables.filter((t) => t.type === 'normal'), vip = r.tables.filter((t) => t.type === 'vip');
  app.innerHTML = `<p><a href="#/">← ร้านอาหารทั้งหมด</a></p>
  <div class="split"><div class="rest-head">${cover(r)}<h1>${esc(r.name)}</h1><p>${esc(r.description)}</p>
    <p class="small">📍 ${esc(r.address)}<br>📞 ${esc(r.phone)}<br>🕒 เปิด ${esc(r.open_time)}–${esc(r.close_time)} น. (รอบละ ${r.slot_minutes / 60} ชม.)</p></div>
  <div class="card"><h3>จองโต๊ะ</h3>
    <p class="small muted">ต้องชำระเงินก่อนเพื่อยืนยันการจอง (ค้างโต๊ะไว้ ${r.holdMinutes} นาทีระหว่างชำระเงิน)<br>ยกเลิกคืนเงินเต็ม ก่อนเวลา ${r.refund_full_hours} ชม. · คืน 50% ก่อนเวลา ${r.refund_half_hours} ชม.</p>
    <p><a class="btn" href="#/book/${r.id}/normal" style="width:100%;text-align:center">🪑 จองโต๊ะธรรมดา${normal.length ? ` (เริ่ม ${baht(Math.min(...normal.map((t) => t.price + t.service_fee)))})` : ''}</a></p>
    <p><a class="btn vip" href="#/book/${r.id}/vip" style="width:100%;text-align:center">⭐ จองโต๊ะ VIP${vip.length ? ` (เริ่ม ${baht(Math.min(...vip.map((t) => t.price + t.service_fee)))})` : ''}</a></p></div></div>
  ${r.promotions.length ? `<h2>🎁 โปรโมชั่น</h2><div class="grid">${r.promotions.map((p) => `<div class="card"><h3>${esc(p.title)}</h3><p class="small muted">${esc(p.description)}</p>${p.valid_until ? `<p class="small">ถึง ${fmtDate(p.valid_until)}</p>` : ''}</div>`).join('')}</div>` : ''}
  <h2>🍽️ เมนูแนะนำ</h2>${r.menu.length ? `<div class="grid">${r.menu.map((m) => `<div class="card menu"><div class="e">${safeUrl(m.image_url) ? `<img src="${esc(m.image_url)}" alt="">` : esc(m.emoji)}</div><div><b>${esc(m.name)}</b> · ${baht(m.price)}<br><span class="muted small">${esc(m.description)}</span></div></div>`).join('')}</div>` : '<p class="muted">ยังไม่มีเมนู</p>'}
  ${vip.length ? `<h2>⭐ โต๊ะ VIP</h2><div class="grid">${vip.map(vipCard).join('')}</div>` : ''}`;
}
function vipCard(t) {
  return `<div class="card">${safeUrl(t.image_url) ? `<img class="photo" src="${esc(t.image_url)}" alt="">` : ''}
  <h3>${esc(t.label)} · ${esc(t.description)}</h3><p class="small">👥 ${t.seats} ที่นั่ง · ${baht(t.price)} + ค่าบริการ ${baht(t.service_fee)} = <b>${baht(t.price + t.service_fee)}</b></p>
  <ul class="perks">${t.perks.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
}

/* ===== แผนผังโต๊ะ (SVG) ===== */
function planSvg(tables, { selectedId = null, party = 0, vip = false } = {}) {
  const W = Math.max(640, ...tables.map((t) => t.x + t.w + 30)), H = Math.max(360, ...tables.map((t) => t.y + t.h + 30));
  const body = tables.map((t) => {
    const cls = ['tbl', t.state || 'available', t.id === selectedId ? 'selected' : '', party && t.seats < party && (t.state || 'available') === 'available' ? 'toosmall' : ''].join(' ');
    const shape = t.shape === 'round'
      ? `<ellipse class="shape" cx="${t.x + t.w / 2}" cy="${t.y + t.h / 2}" rx="${t.w / 2}" ry="${t.h / 2}"/>`
      : `<rect class="shape" x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" rx="${vip ? 16 : 10}"/>`;
    const state = t.state === 'booked' ? 'ถูกจองแล้ว' : t.state === 'unavailable' ? 'ไม่เปิดให้จอง' : `${t.seats} ที่นั่ง`;
    return `<g class="${cls}" data-act="pick" data-id="${t.id}" tabindex="0" role="button" aria-label="โต๊ะ ${esc(t.label)} ${state}">${shape}
      <text class="t1" x="${t.x + t.w / 2}" y="${t.y + t.h / 2 - 2}" text-anchor="middle">${esc(t.label)}</text>
      <text class="t2" x="${t.x + t.w / 2}" y="${t.y + t.h / 2 + 14}" text-anchor="middle">${t.state && t.state !== 'available' ? state : '👥 ' + t.seats}</text></g>`;
  }).join('');
  return `<svg class="plan ${vip ? 'vipplan' : ''}" viewBox="0 0 ${W} ${H}" role="group" aria-label="แผนผังโต๊ะ">${body}</svg>`;
}
const legendHtml = '<div class="legend"><span><i style="background:#dcfce7;border-color:#16a34a"></i>ว่าง</span><span><i style="background:#e5e7eb;border-color:#9ca3af"></i>ถูกจองแล้ว</span><span><i style="background:#f3f4f6;border-color:#d1d5db;border-style:dashed"></i>ไม่เปิดให้จอง</span><span><i style="background:#bfdbfe;border-color:#1d4ed8"></i>ที่เลือก</span><span><i style="background:#dcfce7;border-color:#d97706"></i>ที่นั่งไม่พอ</span></div>';

/* ===== จองโต๊ะ (เลือกประเภท → วัน/เวลา → จำนวนคน → โต๊ะ → สรุป) ===== */
async function viewBook(rid, type) {
  const r = await api('/restaurants/' + rid);
  const isVip = type === 'vip';
  const s = { date: todayBKK(), start: null, party: 2, tableId: null, slots: [], tables: [], slot: null };
  app.innerHTML = `<p><a href="#/r/${r.id}">← ${esc(r.name)}</a></p><h1>จองโต๊ะ ${esc(r.name)}</h1>
  <div class="tabs"><a class="tab ${!isVip ? 'on' : ''}" href="#/book/${r.id}/normal">🪑 โต๊ะธรรมดา</a><a class="tab vip ${isVip ? 'on' : ''}" href="#/book/${r.id}/vip">⭐ โต๊ะ VIP</a></div>
  <div class="split"><div>
    <div class="card"><div class="row"><div><label for="d">วันที่</label><input id="d" type="date" data-change="date" min="${s.date}" max="${addDays(s.date, 60)}" value="${s.date}"></div>
      <div><label for="p">จำนวนคน</label><input id="p" type="number" data-change="party" min="1" max="100" value="${s.party}"></div></div>
      <label>ช่วงเวลา</label><div class="chips" id="slots"></div></div>
    <div class="card" style="margin-top:14px"><h3>แผนผังโต๊ะ${isVip ? ' VIP' : 'ธรรมดา'}</h3>${legendHtml}<div id="plan"><p class="muted">เลือกวันที่และช่วงเวลาเพื่อดูแผนผัง</p></div></div>
  </div><div id="side"></div></div>`;

  async function loadSlots() {
    $('#slots').innerHTML = '<span class="spin"></span>';
    s.slots = await api(`/restaurants/${r.id}/slots?date=${s.date}&type=${type}`);
    $('#slots').innerHTML = s.slots.map((x) => `<button type="button" class="chip ${x.start === s.start ? 'on' : ''}" data-act="slot" data-start="${x.start}" ${x.past || !x.free ? 'disabled' : ''}>${x.start}–${x.end}<small>${x.past ? 'ผ่านไปแล้ว' : x.free ? `ว่าง ${x.free}/${x.total}` : 'เต็ม'}</small></button>`).join('') || '<span class="muted">ไม่มีรอบเวลา</span>';
  }
  async function loadTables() {
    if (!s.start) { $('#plan').innerHTML = '<p class="muted">เลือกช่วงเวลาเพื่อดูแผนผัง</p>'; drawSide(); return; }
    const d = await api(`/restaurants/${r.id}/availability?date=${s.date}&start=${s.start}&type=${type}`);
    s.tables = d.tables; s.slot = d.slot;
    const sel = s.tables.find((t) => t.id === s.tableId);
    if (!sel || sel.state !== 'available') s.tableId = null;
    drawPlan(); drawSide();
  }
  function drawPlan() {
    $('#plan').innerHTML = s.tables.length ? planSvg(s.tables, { selectedId: s.tableId, party: s.party, vip: isVip }) : '<p class="muted">ยังไม่มีโต๊ะประเภทนี้</p>';
  }
  function drawSide() {
    const t = s.tables.find((x) => x.id === s.tableId);
    if (!t) {
      $('#side').innerHTML = `<div class="card"><h3>สรุปรายการจอง</h3><p class="muted">เลือกวัน เวลา และโต๊ะที่ต้องการจากแผนผัง</p>
        ${isVip ? '<p class="small">สิทธิพิเศษโต๊ะ VIP: ห้องส่วนตัว · โซฟา · พนักงานบริการส่วนตัว · เครื่องดื่มต้อนรับ</p>' : ''}
        ${s.tables.length && s.party > Math.max(...s.tables.map((x) => x.seats)) ? '<div class="alert warn">จำนวนคนมากกว่าความจุของโต๊ะทุกตัว</div>' : ''}</div>`;
      return;
    }
    const over = s.party > t.seats; const total = t.price + t.service_fee;
    $('#side').innerHTML = `<div class="card" style="position:sticky;top:70px">
      ${safeUrl(t.image_url) ? `<img class="photo" src="${esc(t.image_url)}" alt="">` : ''}
      <h3>${isVip ? '⭐ ' : ''}โต๊ะ ${esc(t.label)} ${isVip ? '<span class="badge b-vip">VIP</span>' : ''}</h3>
      <p class="muted small">${esc(t.description)} · 👥 ${t.seats} ที่นั่ง</p>
      ${isVip ? `<ul class="perks">${t.perks.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      <h3 style="margin-top:12px">สรุปรายการจอง</h3>
      <dl class="sum"><dt>ร้านอาหาร</dt><dd>${esc(r.name)}</dd><dt>หมายเลขโต๊ะ</dt><dd>${esc(t.label)} (${isVip ? 'VIP' : 'ธรรมดา'})</dd>
      <dt>จำนวนคน</dt><dd>${s.party} คน</dd><dt>วันที่และเวลา</dt><dd>${fmtDate(s.date)} · ${s.slot.start}–${s.slot.end} น.</dd>
      <dt>ค่าโต๊ะ${t.service_fee ? ' + ค่าบริการ' : ''}</dt><dd>${baht(t.price)}${t.service_fee ? ' + ' + baht(t.service_fee) : ''}</dd></dl>
      <p>ยอดที่ต้องชำระ<br><span class="total">${baht(total)}</span></p>
      ${over ? `<div class="alert bad">จำนวนคน (${s.party}) เกินความจุของโต๊ะนี้ (${t.seats} ที่นั่ง) กรุณาเลือกโต๊ะอื่นหรือลดจำนวนคน</div>` : ''}
      <button class="btn ${isVip ? 'vip' : ''}" style="width:100%" data-act="go" ${over ? 'disabled' : ''}>ไปชำระเงินเพื่อยืนยันการจอง</button>
      <p class="small muted">การจองจะยืนยันเมื่อชำระเงินสำเร็จเท่านั้น</p></div>`;
  }
  onChange('date', async (el) => {
    if (!el.value) return;
    if (el.value < todayBKK()) el.value = todayBKK();
    if (el.value === s.date) return;
    s.date = el.value; s.start = null; s.tableId = null; s.tables = [];
    await loadSlots(); await loadTables();
  });
  onChange('party', (el) => {
    const v = Math.max(1, Math.min(100, parseInt(el.value, 10) || 1));
    if (v === s.party) return; // กัน change ตอน blur ทำให้แผนผังถูกวาดใหม่แล้วคลิกโต๊ะไม่ติด
    s.party = v;
    const t = s.tables.find((x) => x.id === s.tableId);
    if (t && s.party > t.seats) toast(`จำนวนคนเกินความจุของโต๊ะ ${t.label} (สูงสุด ${t.seats} ที่นั่ง)`, true);
    drawPlan(); drawSide();
  });
  on('slot', async (el) => { s.start = el.dataset.start; s.tableId = null; await loadSlots(); await loadTables(); });
  on('pick', (el) => {
    const t = s.tables.find((x) => x.id === Number(el.dataset.id)); if (!t) return;
    if (t.state === 'booked') return toast(`โต๊ะ ${t.label} ถูกจองแล้วในช่วงเวลานี้`, true);
    if (t.state !== 'available') return toast(`โต๊ะ ${t.label} ไม่เปิดให้จองในขณะนี้`, true);
    if (s.party > t.seats) return toast(`จำนวนคนเกินความจุของโต๊ะ ${t.label} (สูงสุด ${t.seats} ที่นั่ง)`, true);
    s.tableId = t.id; drawPlan(); drawSide();
  });
  on('go', async () => {
    if (needLogin()) return toast('กรุณาเข้าสู่ระบบก่อนจอง');
    try {
      const b = await api('/bookings', { method: 'POST', body: { restaurant_id: r.id, table_id: s.tableId, party_size: s.party, date: s.date, start_time: s.start } });
      location.hash = '#/pay/' + b.id;
    } catch (e) { if (e.status === 409) { await loadSlots(); await loadTables(); } throw e; }
  });
  await loadSlots();
}

/* ===== ชำระเงิน ===== */
const summaryHtml = (b) => `<dl class="sum"><dt>หมายเลขการจอง</dt><dd>${esc(b.code)} ${typeBadge(b.table_type)}</dd><dt>ร้านอาหาร</dt><dd>${esc(b.restaurant_name)}</dd>
  <dt>โต๊ะ</dt><dd>${esc(b.table_label)} · ${b.party_size} คน</dd><dt>วันที่และเวลา</dt><dd>${fmtDate(b.date)} · ${b.start_time}–${b.end_time} น.</dd></dl>`;

async function viewPay(id) {
  if (needLogin()) return;
  let b = await api('/bookings/' + id);
  if (b.status === 'confirmed') { location.hash = '#/done/' + id; return; }
  if (b.status !== 'pending_payment') {
    app.innerHTML = `<div class="card form center"><h1>${b.status === 'expired' ? '⏰ หมดเวลาชำระเงิน' : 'รายการถูกยกเลิก'}</h1><p class="muted">การจอง ${esc(b.code)} ไม่ได้รับการยืนยัน โต๊ะถูกปล่อยกลับเข้าระบบแล้ว</p><a class="btn" href="#/book/${b.restaurant_id}/${b.table_type}">จองใหม่</a></div>`;
    return;
  }
  const holder = { ref: null, qr: null, pay: null, failed: b.payment_status === 'failed', method: 'promptpay' };
  const total = b.amount;
  app.innerHTML = `<h1>ชำระเงินเพื่อยืนยันการจอง</h1>
  <div class="split"><div class="card"><h3>รายการจอง</h3>${summaryHtml(b)}<p>ยอดที่ต้องชำระ<br><span class="total">${baht(total)}</span></p>
    <p class="alert warn" style="margin-top:8px">⏳ เหลือเวลาชำระเงิน <span class="timer" id="timer">--:--</span><br><span class="small">หากหมดเวลา ระบบจะยกเลิกการจองชั่วคราวและปล่อยโต๊ะ</span></p>
    <button class="btn ghost sm" data-act="cancel">ยกเลิกรายการนี้</button></div>
  <div class="card" id="paybox"></div></div>`;

  const left = () => Math.max(0, Math.floor((new Date(b.expires_at).getTime() - Date.now()) / 1000));
  const tick = () => { const l = left(); const el = $('#timer'); if (el) el.textContent = `${String(Math.floor(l / 60)).padStart(2, '0')}:${String(l % 60).padStart(2, '0')}`; if (l === 0) { clearTimers(); setTimeout(() => viewPay(id), 800); } };
  tick(); every(tick, 1000);

  function drawChooser() {
    const mb = holder.method === 'mobile_banking';
    $('#paybox').innerHTML = `<h3>เลือกวิธีชำระเงิน</h3>
      ${holder.failed ? '<div class="alert bad">ชำระเงินไม่สำเร็จ จึงยังไม่สามารถยืนยันการจองได้ กรุณาลองชำระเงินอีกครั้งภายในเวลาที่กำหนด</div>' : ''}
      <div class="tabs"><button class="tab ${!mb ? 'on' : ''}" data-act="method" data-m="promptpay">📱 QR PromptPay</button><button class="tab ${mb ? 'on' : ''}" data-act="method" data-m="mobile_banking">🏦 Mobile Banking</button></div>
      ${mb ? `<label for="bank">ธนาคาร</label><select id="bank">${S.config.banks.map((x) => `<option>${esc(x)}</option>`).join('')}</select>` : '<p class="muted small">สแกน QR ด้วยแอปธนาคารใดก็ได้ที่รองรับ PromptPay</p>'}
      <p><button class="btn" style="width:100%" data-act="createpay">ชำระเงิน ${baht(total)}</button></p>`;
  }
  function drawQr() {
    const p = holder.pay;
    $('#paybox').innerHTML = `<h3>${p.method === 'promptpay' ? 'สแกน QR Code PromptPay' : 'ชำระผ่าน Mobile Banking' + (p.bank ? ' · ' + esc(p.bank) : '')}</h3>
      <img class="qr" src="${holder.qr}" alt="QR Code PromptPay">
      <p class="center">ยอดชำระ <span class="total">${baht(p.amount)}</span><br><span class="muted small">รหัสอ้างอิง ${esc(p.reference)}</span></p>
      ${p.method === 'mobile_banking' ? '<p class="small muted">เปิดแอปธนาคาร → เลือก “สแกนจ่าย/อัปโหลด QR” แล้วเลือกภาพ QR นี้ (กดค้างที่ภาพเพื่อบันทึก) ยอดเงินจะถูกกรอกให้อัตโนมัติ</p>' : ''}
      <p class="center muted"><span class="spin"></span> กำลังตรวจสอบสถานะการชำระเงิน...</p>
      <p><button class="btn ghost sm" data-act="back">← เปลี่ยนวิธีชำระเงิน</button></p>`;
  }
  async function poll() {
    if (!holder.ref) return;
    const d = await api('/payments/' + holder.ref);
    if (d.status === 'paid') { clearTimers(); toast('ชำระเงินสำเร็จ'); location.hash = '#/done/' + id; }
    else if (d.status === 'failed') { holder.ref = null; holder.failed = true; drawChooser(); }
    else if (d.booking_status !== 'pending_payment') { clearTimers(); viewPay(id); }
  }
  every(() => poll().catch(() => {}), 3000);

  on('method', (el) => { holder.method = el.dataset.m; drawChooser(); });
  on('back', () => { holder.ref = null; drawChooser(); });
  on('createpay', async () => {
    const bank = holder.method === 'mobile_banking' ? $('#bank').value : '';
    const d = await api(`/bookings/${id}/pay`, { method: 'POST', body: { method: holder.method, bank } });
    holder.ref = d.payment.reference; holder.pay = d.payment; holder.qr = d.qr; holder.failed = false; drawQr();
  });
  on('cancel', async () => {
    if (!confirm('ยกเลิกรายการจองนี้?')) return;
    await api(`/bookings/${id}/cancel`, { method: 'POST' }); toast('ยกเลิกรายการแล้ว'); location.hash = '#/history';
  });

  // กลับเข้าหน้าเดิมระหว่างรอชำระ → แสดง QR เดิมต่อ
  if (b.payment_status === 'pending' && b.reference) {
    const d = await api(`/payments/${b.reference}?qr=1`);
    if (d.qr) { holder.ref = b.reference; holder.pay = d.payment; holder.qr = d.qr; drawQr(); return; }
  }
  drawChooser();
}

/* ===== ยืนยันการจอง ===== */
async function viewDone(id) {
  if (needLogin()) return;
  const b = await api('/bookings/' + id);
  if (b.status === 'pending_payment') { location.hash = '#/pay/' + id; return; }
  if (b.status !== 'confirmed') { location.hash = '#/history'; return; }
  const vip = b.table_type === 'vip';
  app.innerHTML = `<div class="card form" style="max-width:560px"><div class="center"><div style="font-size:3rem">✅</div><h1>${vip ? 'จองโต๊ะ VIP สำเร็จ' : 'จองโต๊ะสำเร็จ'}</h1>
    <p class="muted">ระบบได้รับการชำระเงินและยืนยันการจองของคุณแล้ว</p>
    <p class="muted small">หมายเลขการจอง${vip ? ' VIP' : ''}</p><p class="total" style="letter-spacing:1px">${esc(b.code)}</p></div>
    ${summaryHtml(b)}
    <h3 style="margin-top:16px">หลักฐานการชำระเงิน</h3>
    <dl class="sum"><dt>เลขที่ใบเสร็จ</dt><dd>${esc(b.receipt_no)}</dd><dt>วิธีชำระเงิน</dt><dd>${esc(methodLabel(b))}</dd>
    <dt>ชำระเมื่อ</dt><dd>${fmtDT(b.paid_at)}</dd><dt>ยอดชำระ</dt><dd>${baht(b.amount)}</dd><dt>รหัสอ้างอิง</dt><dd>${esc(b.reference)}</dd></dl>
    <p class="alert info small">ส่งการแจ้งเตือนการจองไปที่ 🔔 ของคุณแล้ว กรุณาแสดงหมายเลขการจองเมื่อถึงร้าน</p>
    <p class="center"><a class="btn" href="#/food/${b.id}">🍽️ สั่งอาหาร / ดูบิล</a> <a class="btn ghost" href="#/history">ดูประวัติการจอง</a> <button class="btn ghost" onclick="window.print()">🖨️ พิมพ์</button></p></div>`;
}

/* ===== ประวัติการจอง ===== */
async function viewHistory() {
  if (needLogin()) return;
  const q = (location.hash.split('?')[1] || '').match(/type=(normal|vip)/);
  const type = q ? q[1] : '';
  app.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  const list = await api('/bookings' + (type ? '?type=' + type : ''));
  app.innerHTML = `<h1>ประวัติการจอง</h1><div class="tabs"><a class="tab ${!type ? 'on' : ''}" href="#/history">ทั้งหมด</a><a class="tab ${type === 'normal' ? 'on' : ''}" href="#/history?type=normal">โต๊ะธรรมดา</a><a class="tab vip ${type === 'vip' ? 'on' : ''}" href="#/history?type=vip">⭐ VIP</a></div>
  ${list.length ? list.map((b) => `<div class="card" style="margin-bottom:12px"><div class="row" style="align-items:center"><div style="flex:2"><b>${esc(b.code)}</b> ${typeBadge(b.table_type)} ${badge(BK, b.status)}<br>
    ${esc(b.restaurant_name)} · โต๊ะ ${esc(b.table_label)} · ${b.party_size} คน<br><span class="muted small">${fmtDate(b.date)} ${b.start_time}–${b.end_time} น.</span></div>
    <div class="right"><b>${baht(b.amount)}</b><br>    <button class="btn ghost sm" data-act="detail" data-id="${b.id}">รายละเอียด</button></div></div>
    <div class="hidden" id="d${b.id}" style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">
      <div class="row"><dl class="sum"><dt>การชำระเงิน</dt><dd>${badge(PAYST, b.payment_status) || '-'} ${esc(methodLabel(b))}</dd><dt>เลขที่ใบเสร็จ</dt><dd>${esc(b.receipt_no || '-')}</dd><dt>ชำระเมื่อ</dt><dd>${fmtDT(b.paid_at)}</dd></dl>
      <dl class="sum"><dt>สถานะการคืนเงิน</dt><dd>${badge(REFUND, b.refund_status || 'none')} ${b.refund_amount > 0 ? baht(b.refund_amount) : ''}</dd>${b.refunded_at ? `<dt>คืนเงินเมื่อ</dt><dd>${fmtDT(b.refunded_at)}</dd>` : ''}${b.cancel_reason ? `<dt>เหตุผล</dt><dd>${esc(b.cancel_reason)}</dd>` : ''}</dl></div>
      <p>${b.status === 'pending_payment' ? `<a class="btn sm" href="#/pay/${b.id}">ชำระเงินต่อ</a> ` : ''}${b.status === 'confirmed' ? `<a class="btn ghost sm" href="#/done/${b.id}">ดูหลักฐาน</a> <a class="btn sm" href="#/food/${b.id}">🍽️ สั่งอาหาร / บิล</a> ` : ''}
      ${['pending_payment', 'confirmed'].includes(b.status) ? `<button class="btn danger sm" data-act="cancel" data-id="${b.id}">ยกเลิกการจอง</button>` : ''}</p></div></div>`).join('') : '<div class="card muted center">ยังไม่มีรายการจอง</div>'}`;
  on('detail', (el) => $('#d' + el.dataset.id).classList.toggle('hidden'));
  on('cancel', async (el) => {
    const id = el.dataset.id; const p = await api(`/bookings/${id}/cancel-preview`);
    const msg = !p.paid ? 'ยืนยันการยกเลิกรายการนี้?'
      : p.amount > 0 ? `ยกเลิกการจองนี้?\nเงื่อนไขร้าน: คืนเงิน ${p.percent}% = ${baht(p.amount)} (ดำเนินการคืนเงินภายหลัง)`
        : `ยกเลิกการจองนี้?\nเกินกำหนดคืนเงิน (ต้องยกเลิกก่อนเวลาจอง ${p.half_hours} ชม.) จะไม่ได้รับเงินคืน`;
    if (!confirm(msg)) return;
    await api(`/bookings/${id}/cancel`, { method: 'POST' }); toast('ยกเลิกการจองแล้ว'); await viewHistory();
  });
}

/* ===== สั่งอาหารและบิลประจำโต๊ะ ===== */
async function viewFoodOrder(id) {
  if (needLogin()) return;
  const d=await api(`/bookings/${id}/food`); const cart={};
  const draw=()=>{
    const total=d.menu.reduce((n,m)=>n+(cart[m.id]||0)*m.price,0);
    app.innerHTML=`<p><a href="#/history">← ประวัติการจอง</a></p><h1>🍽️ สั่งอาหาร / บิลโต๊ะ</h1>
      <div class="card"><h3>เมนูอาหาร</h3><div class="grid">${d.menu.map(m=>`<div class="card menu"><div class="e">${safeUrl(m.image_url)?`<img src="${esc(m.image_url)}">`:esc(m.emoji)}</div><div style="flex:1"><b>${esc(m.name)}</b><br>${baht(m.price)}<br><span class="muted small">${esc(m.description)}</span><div class="row"><button class="btn ghost sm" data-act="minus" data-id="${m.id}">−</button><b>${cart[m.id]||0}</b><button class="btn sm" data-act="plus" data-id="${m.id}">+</button></div></div></div>`).join('')}</div>
      <p><label>หมายเหตุถึงครัว</label><input id="foodNote" maxlength="300" placeholder="เช่น ไม่เผ็ด / แยกน้ำแข็ง"></p><button class="btn" id="sendFood" ${total<=0?'disabled':''}>ส่งออเดอร์ · ${baht(total)}</button></div>
      <h2>รายการที่สั่งแล้ว</h2>${d.orders.map(o=>`<div class="card" style="margin-bottom:8px"><b>ออเดอร์ #${o.id}</b> · ${esc(o.status)} · ${o.source==='staff'?'พนักงาน':'ลูกค้า'}<ul>${o.items.map(i=>`<li>${esc(i.item_name)} × ${i.quantity} — ${baht(i.unit_price*i.quantity)}</li>`).join('')}</ul><b>${baht(o.total)}</b></div>`).join('')||'<p class="muted">ยังไม่มีรายการอาหาร</p>'}
      <div class="card"><h2>สรุปบิล</h2><p>ค่าอาหารทั้งหมด <b>${baht(d.total)}</b></p><p>ชำระแล้ว <b>${baht(d.paid)}</b></p><p>ยอดค้างชำระ <b class="total">${baht(d.balance)}</b></p>${d.balance>0?'<button class="btn" id="checkoutFood">ชำระค่าอาหารด้วย PromptPay</button>':'<span class="badge b-ok">ชำระครบแล้ว</span>'}</div>`;
    $('#sendFood')?.addEventListener('click',async()=>{const items=Object.entries(cart).filter(([,q])=>q>0).map(([menu_item_id,quantity])=>({menu_item_id:Number(menu_item_id),quantity}));if(!items.length)return;await api(`/bookings/${id}/food/orders`,{method:'POST',body:{items,note:$('#foodNote').value}});toast('ส่งออเดอร์เข้าครัวแล้ว');await viewFoodOrder(id);});
    $('#checkoutFood')?.addEventListener('click',async()=>{const p=await api(`/bookings/${id}/food/checkout`,{method:'POST',body:{method:'promptpay'}});app.innerHTML=`<div class="card form center"><h2>ชำระค่าอาหาร</h2><h1>${baht(p.payment.amount)}</h1>${p.qr?`<img style="max-width:280px;margin:auto" src="${p.qr}">`:'<p>รอการชำระเงินผ่านระบบธนาคาร</p>'}<p class="small muted">กรุณาชำระผ่านแอปธนาคาร ระบบจะอัปเดตสถานะเมื่อได้รับการยืนยัน</p><p><a href="#/food/${id}">กลับไปยังบิล</a></p></div>`;toast('สร้างรายการชำระเงินแล้ว');});
  }; draw();
  on('plus',el=>{const k=el.dataset.id;cart[k]=(cart[k]||0)+1;draw();});
  on('minus',el=>{const k=el.dataset.id;cart[k]=Math.max(0,(cart[k]||0)-1);draw();});
}

/* ===== โปรไฟล์ ===== */
async function viewProfile() {
  if (needLogin()) return;
  const { user } = await api('/me'); S.user = user;
  app.innerHTML = `<div class="card form"><h1>ข้อมูลส่วนตัว</h1><form data-form="profile">
    <label>ชื่อ-นามสกุล</label><input name="name" required minlength="2" value="${esc(user.name)}">
    <label>เบอร์โทรศัพท์</label><input name="phone" required value="${esc(user.phone)}">
    <label>อีเมล</label><input name="email" type="email" required value="${esc(user.email)}">
    <h3 style="margin-top:18px">เปลี่ยนรหัสผ่าน (ไม่บังคับ)</h3>
    <label>รหัสผ่านปัจจุบัน</label><input name="current_password" type="password" autocomplete="current-password">
    <label>รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</label><input name="new_password" type="password" minlength="8" autocomplete="new-password">
    <p><button class="btn" type="submit">บันทึก</button></p></form></div>`;
  onForm('profile', async (d) => {
    const r = await api('/me', { method: 'PUT', body: d }); S.user = r.user; renderNav(); toast('บันทึกข้อมูลแล้ว'); await viewProfile();
  });
}

/* ===== Admin ===== */
const ADMIN_TABS = [['dashboard', '🏠 ภาพรวม'], ['report', '📊 รายงาน'], ['bookings', '📋 การจอง'], ['payments', '💳 การชำระเงิน'], ['tables', '🪑 โต๊ะ'], ['customers', '👥 ลูกค้า'], ['food', '🍽️ ออเดอร์อาหาร'], ['kitchen', '👨‍🍳 ครัว'], ['inventory', '📦 สต็อก'], ['expenses', '🧾 ค่าใช้จ่าย'], ['staff', '🧑‍💼 พนักงาน'], ['restaurants', '🏪 ร้านอาหาร']];
async function viewAdmin(tab) {
  if (needLogin()) return;
  if (!S.user || S.user.role !== 'admin') { app.innerHTML = '<div class="alert bad">ต้องเป็นผู้ดูแลระบบ</div>'; return; }
  const rests = await api('/admin/restaurants');
  if (!adminRid || !rests.find((r) => r.id === adminRid)) adminRid = rests[0] && rests[0].id;
  app.innerHTML = `<h1>จัดการระบบ</h1><div class="tabs">${ADMIN_TABS.map(([k, l]) => `<a class="tab ${k === tab ? 'on' : ''}" href="#/admin/${k}">${l}</a>`).join('')}</div><div id="adm"></div>`;
  const box = $('#adm');
  const restSelect = (extra = '') => `<select data-change="rid" style="max-width:300px" ${extra}>${rests.map((r) => `<option value="${r.id}" ${r.id === adminRid ? 'selected' : ''}>${esc(r.name)}${r.active ? '' : ' (ปิด)'}</option>`).join('')}</select>`;
  onChange('rid', async (el) => { adminRid = Number(el.value); await viewAdmin(tab); });
  if (tab === 'dashboard') return adminDashboard(box);
  if (tab === 'report') return adminReport(box, rests);
  if (tab === 'bookings') return adminBookings(box);
  if (tab === 'payments') return adminPayments(box);
  if (tab === 'tables') return adminTables(box, restSelect);
  if (tab === 'customers') return adminCustomers(box);
  if (tab === 'food') return adminFoodOrders(box);
  if (tab === 'kitchen') return adminKitchen(box);
  if (tab === 'inventory') return adminInventory(box);
  if (tab === 'expenses') return adminExpenses(box);
  if (tab === 'staff') return adminStaff(box);
  if (tab === 'restaurants') return adminRestaurants(box, rests, restSelect);
}

async function adminFoodOrders(box) {
  const list=await api('/admin/food/orders');
  box.innerHTML=`<h2>ออเดอร์อาหาร</h2>
  <div class="card">
    <h3>เพิ่มออเดอร์โดยพนักงาน</h3>
    <p class="muted small">ใช้ ID การจองที่ยืนยันแล้ว เพื่อผูกออเดอร์กับโต๊ะเดิม</p>
    <form id="staffFood">
      <label>ID การจอง</label><input name="booking_id" type="number" min="1" required>
      <label>รายการอาหาร (รหัสเมนู:จำนวน คั่นด้วยจุลภาค)</label><input name="items" placeholder="1:2, 3:1" required>
      <label>หมายเหตุ</label><input name="note">
      <button class="btn">บันทึกออเดอร์โดยพนักงาน</button>
    </form>
  </div>
  <div class="card" style="margin-top:12px">
    <h3>รับชำระค่าอาหารแทนลูกค้า</h3>
    <p class="muted small">ระบบจะดึงยอดค้างชำระจากบิลของการจอง และบันทึกเป็นเงินสดโดยไม่เปลี่ยนช่องทางชำระเงินของลูกค้า</p>
    <form id="adminFoodBill">
      <label>ID การจอง</label><input name="booking_id" type="number" min="1" required>
      <button class="btn ghost" type="submit">ตรวจสอบบิล</button>
    </form>
    <div id="adminFoodBillResult"></div>
  </div>
  <h3>รายการออเดอร์</h3>
  ${list.map(o=>`<div class="card" style="margin:8px 0"><b>ออเดอร์ #${o.id}</b> · ${esc(o.booking_code)} · โต๊ะ ${esc(o.table_label)} · ${o.source==='staff'?'พนักงาน':'ลูกค้า'}<p>${o.items.map(i=>`${esc(i.item_name)} × ${i.quantity}`).join(' / ')}</p><b>${baht(o.total)}</b> · ${esc(o.status)}<div class="row"><select data-change="foodstatus" data-id="${o.id}"><option value="submitted" ${o.status==='submitted'?'selected':''}>รอครัว</option><option value="preparing" ${o.status==='preparing'?'selected':''}>กำลังทำ</option><option value="served" ${o.status==='served'?'selected':''}>เสิร์ฟแล้ว</option><option value="cancelled" ${o.status==='cancelled'?'selected':''}>ยกเลิก</option></select></div></div>`).join('')||'<p class="muted">ยังไม่มีออเดอร์</p>'}`;
  $('#staffFood').onsubmit=async e=>{
    e.preventDefault();const f=new FormData(e.target);
    const items=String(f.get('items')).split(',').map(x=>{const [menu_item_id,quantity]=x.trim().split(':').map(Number);return {menu_item_id,quantity};});
    await api('/admin/food/orders',{method:'POST',body:{booking_id:Number(f.get('booking_id')),items,note:f.get('note')}});
    toast('เพิ่มออเดอร์แล้ว');await adminFoodOrders(box);
  };
  $('#adminFoodBill').onsubmit=async e=>{
    e.preventDefault();const id=Number(new FormData(e.target).get('booking_id'));
    const bill=await api(`/admin/food/bookings/${id}/bill`);
    const target=$('#adminFoodBillResult');
    target.innerHTML=`<hr><p>ยอดอาหารทั้งหมด <b>${baht(bill.total)}</b></p>
      <p>ชำระแล้ว <b>${baht(bill.paid)}</b></p>
      <p>ยอดค้างชำระ <b class="total">${baht(bill.balance)}</b></p>
      ${bill.balance>0?`<button class="btn" id="adminPayFoodCash" data-id="${id}">ยืนยันรับชำระเงินสด ${baht(bill.balance)}</button>`:'<span class="badge b-ok">ชำระครบแล้ว</span>'}
      ${bill.payments?.length?`<p class="small muted">ประวัติ: ${bill.payments.map(p=>`${esc(p.method)} ${baht(p.amount)} (${esc(p.status)})`).join(' · ')}</p>`:''}`;
    $('#adminPayFoodCash')?.addEventListener('click',async()=>{
      if(!confirm(`ยืนยันรับชำระค่าอาหาร ${baht(bill.balance)} จากลูกค้าใช่หรือไม่?`)) return;
      const result=await api(`/admin/food/bookings/${id}/pay-cash`,{method:'POST'});
      toast(`รับชำระเงินแล้ว ใบเสร็จ ${result.payment.receipt_no}`);
      await $('#adminFoodBill').requestSubmit();
    });
  };
  onChange('foodstatus',async el=>{await api(`/admin/food/orders/${el.dataset.id}/status`,{method:'PATCH',body:{status:el.value}});toast('อัปเดตสถานะแล้ว');await adminFoodOrders(box);});
}

async function adminDashboard(box) {
 const d=await api(`/admin/dashboard?restaurant_id=${adminRid}`);
 box.innerHTML=`<h2>ภาพรวมวันนี้ · ${d.date}</h2><div class="grid cards"><div class="card"><span class="muted">การจองวันนี้</span><h2>${d.bookings.total||0}</h2><small>ยืนยันแล้ว ${d.bookings.confirmed||0}</small></div><div class="card"><span class="muted">ออเดอร์อาหารวันนี้</span><h2>${d.food.orders||0}</h2><small>มูลค่า ${baht(d.food.total)}</small></div><div class="card"><span class="muted">รับชำระค่าจอง</span><h2>${baht(d.booking_paid)}</h2></div><div class="card"><span class="muted">รับชำระค่าอาหาร</span><h2>${baht(d.food_paid)}</h2></div><div class="card"><span class="muted">วัตถุดิบใกล้หมด</span><h2>${d.low_stock}</h2></div></div><p class="muted small">ตัวเลขรายได้แยกค่าจองและค่าอาหาร เพื่อป้องกันการนับซ้ำ</p>`;
}

async function adminKitchen(box) {
  const list=await api('/admin/kitchen/orders');
  box.innerHTML=`<h2>หน้าจอครัว</h2><p class="muted">รายการที่รอทำและกำลังทำ เรียงตามเวลาที่รับออเดอร์</p>${list.map(o=>`<div class="card" style="margin:8px 0"><b>โต๊ะ ${esc(o.table_label)} · #${o.id}</b><p>${o.items.map(i=>`${esc(i.item_name)} × ${i.quantity}${i.note?' ('+esc(i.note)+')':''}`).join('<br>')}</p><button class="btn sm" data-act="kitchenStart" data-id="${o.id}">รับออเดอร์ / กำลังทำ</button> <button class="btn sm" data-act="kitchenDone" data-id="${o.id}">ทำเสร็จ / เสิร์ฟแล้ว</button></div>`).join('')||'<p class="muted">ไม่มีออเดอร์ในครัว</p>'}`;
  on('kitchenStart',async el=>{await api(`/admin/food/orders/${el.dataset.id}/status`,{method:'PATCH',body:{status:'preparing'}});await adminKitchen(box);});
  on('kitchenDone',async el=>{await api(`/admin/food/orders/${el.dataset.id}/status`,{method:'PATCH',body:{status:'served'}});toast('อัปเดตเสิร์ฟแล้วและตัดสต็อกตามสูตร');await adminKitchen(box);});
}
async function adminInventory(box) {
  const list=await api(`/admin/inventory?restaurant_id=${adminRid}`);
  box.innerHTML=`<h2>คลังวัตถุดิบ</h2><form id="ingredientAdd" class="card"><div class="row"><div><label>ชื่อวัตถุดิบ</label><input name="name" required></div><div><label>หน่วย</label><input name="unit" value="กิโลกรัม"></div></div><div class="row"><div><label>จำนวนตั้งต้น</label><input name="stock" type="number" min="0" step="0.01" value="0"></div><div><label>แจ้งเตือนเมื่อเหลือ</label><input name="min_stock" type="number" min="0" step="0.01" value="0"></div><div><label>ต้นทุน/หน่วย</label><input name="cost_per_unit" type="number" min="0" step="0.01" value="0"></div></div><button class="btn">เพิ่มวัตถุดิบ</button></form><div class="card">${list.map(i=>`<div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)"><div><b>${esc(i.name)}</b><div class="muted small">คงเหลือ ${i.stock} ${esc(i.unit)} · ขั้นต่ำ ${i.min_stock} ${i.low_stock?' · ⚠️ ใกล้หมด':''}</div></div><button class="btn sm ghost" data-act="stockIn" data-id="${i.id}">รับเข้า</button> <button class="btn sm ghost" data-act="stockOut" data-id="${i.id}">เบิกออก</button></div>`).join('')||'ยังไม่มีวัตถุดิบ'}</div>`;
  $('#ingredientAdd').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));d.restaurant_id=adminRid;await api('/admin/inventory',{method:'POST',body:d});toast('เพิ่มวัตถุดิบแล้ว');await adminInventory(box);};
  on('stockIn',async el=>{const q=prompt('จำนวนรับเข้า');if(q===null)return;await api(`/admin/inventory/${el.dataset.id}/movements`,{method:'POST',body:{movement:'in',quantity:Number(q),note:'รับเข้าจากหน้าสต็อก'}});await adminInventory(box);});
  on('stockOut',async el=>{const q=prompt('จำนวนเบิกออก');if(q===null)return;await api(`/admin/inventory/${el.dataset.id}/movements`,{method:'POST',body:{movement:'out',quantity:Number(q),note:'เบิกออกจากหน้าสต็อก'}});await adminInventory(box);});
}
async function adminExpenses(box) {
  const list=await api(`/admin/expenses?restaurant_id=${adminRid}`);
  box.innerHTML=`<h2>บันทึกค่าใช้จ่ายร้าน</h2><form id="expenseAdd" class="card"><div class="row"><div><label>หมวดหมู่</label><input name="category" placeholder="วัตถุดิบ / ค่าไฟ / ค่าแรง" required></div><div><label>จำนวนเงิน (บาท)</label><input name="amount" type="number" min="0.01" step="0.01" required></div><div><label>วันที่</label><input name="expense_date" type="date" value="${todayBKK()}" required></div></div><label>รายละเอียด</label><input name="description"><button class="btn">บันทึกค่าใช้จ่าย</button></form><div class="card">${list.map(x=>`<p><b>${esc(x.category)}</b> · ${esc(x.description)} <span class="muted">${x.expense_date}</span><strong style="float:right">${baht(x.amount)}</strong></p>`).join('')||'ยังไม่มีค่าใช้จ่าย'}</div><button class="btn ghost" id="salesSummary">ดูสรุปรายรับ-รายจ่าย 30 วัน</button><div id="salesResult"></div>`;
  $('#expenseAdd').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));d.restaurant_id=adminRid;await api('/admin/expenses',{method:'POST',body:d});toast('บันทึกค่าใช้จ่ายแล้ว');await adminExpenses(box);};
  $('#salesSummary').onclick=async()=>{const d=await api(`/admin/sales-summary?restaurant_id=${adminRid}`);$('#salesResult').innerHTML=`<div class="card"><p>รายได้จองโต๊ะ: <b>${baht(d.booking_revenue)}</b></p><p>รายได้อาหาร: <b>${baht(d.food_revenue)}</b></p><p>ค่าใช้จ่าย: <b>${baht(d.expenses)}</b></p><h3>ยอดสุทธิ: ${baht(d.net)}</h3></div>`;};
}

async function adminReport(box, rests) {
  const f = { from: addDays(todayBKK(), -29), to: addDays(todayBKK(), 60), rid: '' };
  const load = async () => {
    const d = await api(`/admin/reports?from=${f.from}&to=${f.to}${f.rid ? '&restaurant_id=' + f.rid : ''}`);
    const t = (a, type) => a.find((x) => x.type === type) || {};
    const bn = t(d.byType, 'normal'), bv = t(d.byType, 'vip'), rn = t(d.revenue, 'normal'), rv = t(d.revenue, 'vip');
    const net = (r) => Number(r.net || 0);
    const days = {}; d.daily.forEach((x) => { (days[x.date] ||= { normal: 0, vip: 0, n: 0 })[x.type] += Number(x.net || 0); days[x.date].n += x.bookings; });
    const max = Math.max(1, ...Object.values(days).map((x) => x.normal + x.vip));
    $('#rep').innerHTML = `<div class="kpi">
      <div class="card"><span class="muted small">จองสำเร็จ (โต๊ะธรรมดา)</span><b>${bn.confirmed || 0}</b><span class="muted small">ยกเลิก ${bn.cancelled || 0} · หมดเวลา ${bn.expired || 0}</span></div>
      <div class="card"><span class="muted small">จองสำเร็จ (VIP)</span><b>${bv.confirmed || 0}</b><span class="muted small">ยกเลิก ${bv.cancelled || 0} · หมดเวลา ${bv.expired || 0}</span></div>
      <div class="card"><span class="muted small">รายได้สุทธิ โต๊ะธรรมดา</span><b>${baht(net(rn))}</b><span class="muted small">ยอดรับ ${baht(rn.gross)} − คืน ${baht(rn.refunds)}</span></div>
      <div class="card" style="border-color:#f1d98a;background:var(--vip-bg)"><span class="muted small">รายได้สุทธิ VIP</span><b>${baht(net(rv))}</b><span class="muted small">ยอดรับ ${baht(rv.gross)} − คืน ${baht(rv.refunds)}</span></div>
      <div class="card"><span class="muted small">รายได้สุทธิรวม</span><b>${baht(net(rn) + net(rv))}</b></div>
      <div class="card"><span class="muted small">รอคืนเงิน</span><b>${d.pendingRefunds.n} รายการ</b><span class="muted small">${baht(d.pendingRefunds.amt)}</span></div></div>
    <h3>รายได้รายวัน (ตามวันที่จอง)</h3><div class="scroll"><table class="t"><tr><th>วันที่</th><th>จำนวนการจอง</th><th>โต๊ะธรรมดา</th><th>VIP</th><th style="width:40%">กราฟ</th></tr>
    ${Object.entries(days).map(([dt, x]) => `<tr><td>${fmtDate(dt)}</td><td>${x.n}</td><td>${baht(x.normal)}</td><td>${baht(x.vip)}</td><td><div style="display:flex;height:12px"><div style="background:#16a34a;width:${x.normal / max * 100}%"></div><div style="background:var(--vip);width:${x.vip / max * 100}%"></div></div></td></tr>`).join('') || '<tr><td colspan="5" class="muted center">ไม่มีข้อมูลในช่วงนี้</td></tr>'}</table></div>
    <p class="small muted">${esc(d.note)} · <span style="color:#16a34a">■</span> ธรรมดา <span style="color:var(--vip)">■</span> VIP</p>`;
  };
  box.innerHTML = `<div class="row"><div><label>ตั้งแต่</label><input type="date" data-change="rf" value="${f.from}"></div><div><label>ถึง (วันที่จอง)</label><input type="date" data-change="rt" value="${f.to}"></div>
    <div><label>ร้าน</label><select data-change="rr"><option value="">ทั้งหมด</option>${rests.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div></div><div id="rep"></div>`;
  onChange('rf', (el) => { f.from = el.value; load(); }); onChange('rt', (el) => { f.to = el.value; load(); }); onChange('rr', (el) => { f.rid = el.value; load(); });
  await load();
}

async function adminBookings(box) {
  const f = { status: '', type: '', date: '' };
  const load = async () => {
    const qs = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('&');
    const list = await api('/admin/bookings' + (qs ? '?' + qs : ''));
    $('#bl').innerHTML = `<div class="scroll"><table class="t"><tr><th>หมายเลข</th><th>ลูกค้า</th><th>ร้าน / โต๊ะ</th><th>วัน-เวลา</th><th>ยอด</th><th>สถานะ</th><th>ชำระเงิน</th><th></th></tr>
    ${list.map((b) => `<tr><td>${esc(b.code)}<br>${typeBadge(b.table_type)}</td><td>${esc(b.user_name)}<br><span class="muted small">${esc(b.user_phone)}</span></td>
      <td>${esc(b.restaurant_name)}<br>โต๊ะ ${esc(b.table_label)} · ${b.party_size} คน</td><td>${b.date}<br>${b.start_time}–${b.end_time}</td><td>${baht(b.amount)}</td>
      <td>${badge(BK, b.status)}</td><td>${badge(PAYST, b.payment_status)}<br>${b.refund_status && b.refund_status !== 'none' ? badge(REFUND, b.refund_status) : ''}</td>
      <td>${['pending_payment', 'confirmed'].includes(b.status) ? `${b.payment_status!=='paid'?`<button class="btn sm" data-act="bookingCash" data-id="${b.id}">รับเงินสด</button> `:''}<button class="btn danger sm" data-act="acancel" data-id="${b.id}">ยกเลิก</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="center muted">ไม่พบรายการ</td></tr>'}</table></div>`;
  };
  box.innerHTML = `<div class="row"><div><label>สถานะ</label><select data-change="bf" data-k="status"><option value="">ทั้งหมด</option><option value="pending_payment">รอชำระเงิน</option><option value="confirmed">จองสำเร็จ</option><option value="expired">หมดเวลา</option><option value="cancelled">ยกเลิก</option></select></div>
    <div><label>ประเภทโต๊ะ</label><select data-change="bf" data-k="type"><option value="">ทั้งหมด</option><option value="normal">ธรรมดา</option><option value="vip">VIP</option></select></div>
    <div><label>วันที่จอง</label><input type="date" data-change="bf" data-k="date"></div></div><div id="bl" style="margin-top:12px"></div>`;
  onChange('bf', (el) => { f[el.dataset.k] = el.value; load(); });
  on('bookingCash', async (el) => {
    if(!confirm('ยืนยันรับชำระค่าจองเป็นเงินสดเต็มจำนวนจากลูกค้าใช่หรือไม่?')) return;
    const r=await api(`/admin/bookings/${el.dataset.id}/pay-cash`,{method:'POST'});toast(`รับชำระแล้ว ใบเสร็จ ${r.receipt.receipt_no}`);await load();
  });
  on('acancel', async (el) => {
    if (!confirm('ยกเลิกการจองนี้โดยผู้ดูแลระบบ? (หากชำระแล้วจะคืนเงินเต็มจำนวน)')) return;
    await api(`/admin/bookings/${el.dataset.id}/cancel`, { method: 'POST' }); toast('ยกเลิกแล้ว'); await load();
  });
  await load();
}

async function adminPayments(box) {
  const f = { status: '', refund: '' };
  const load = async () => {
    const qs = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('&');
    const list = await api('/admin/payments' + (qs ? '?' + qs : ''));
    const cash = await api('/admin/cash-receipts');
    const sum = list.filter((p) => p.status === 'paid').reduce((a, p) => a + p.amount - p.refund_amount, 0) + cash.reduce((a,r)=>a+r.amount-r.refund_amount,0);
    $('#pl').innerHTML = `<p class="muted small">ยอดสุทธิรวมค่าจองที่รับผ่าน Gateway และเงินสด: <b>${baht(sum)}</b></p><div class="scroll"><table class="t"><tr><th>อ้างอิง</th><th>การจอง</th><th>ลูกค้า</th><th>วิธี</th><th>ยอด</th><th>สถานะ</th><th>คืนเงิน</th><th></th></tr>
    ${list.map((p) => `<tr><td>${esc(p.reference)}<br><span class="muted small">${fmtDT(p.created_at)}</span></td><td>${esc(p.code)}<br>${typeBadge(p.table_type)}</td><td>${esc(p.user_name)}</td>
      <td>${p.method === 'promptpay' ? 'PromptPay' : 'Mobile Banking<br><span class="small muted">' + esc(p.bank) + '</span>'}</td><td>${baht(p.amount)}</td><td>${badge(PAYST, p.status)}<br><span class="small muted">${p.paid_at ? fmtDT(p.paid_at) : ''}</span></td>
      <td>${badge(REFUND, p.refund_status)} ${p.refund_amount > 0 ? baht(p.refund_amount) : ''}</td>
      <td>${p.refund_status === 'pending' ? `<button class="btn sm" data-act="refund" data-id="${p.id}">บันทึกว่าคืนเงินแล้ว</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="center muted">ไม่พบรายการ</td></tr>'}</table></div>
      <h3>รายการรับเงินสดค่าจอง</h3><div class="scroll"><table class="t"><tr><th>ใบเสร็จ</th><th>การจอง</th><th>ลูกค้า</th><th>ยอดรับ</th><th>รับโดย</th><th>คืนเงิน</th><th></th></tr>${cash.map(r=>`<tr><td>${esc(r.receipt_no)}<br><span class="small muted">${fmtDT(r.paid_at)}</span></td><td>${esc(r.code)}</td><td>${esc(r.customer_name)}</td><td>${baht(r.amount)}</td><td>${esc(r.received_by_name||'-')}</td><td>${badge(REFUND,r.refund_status)} ${r.refund_amount?baht(r.refund_amount):''}</td><td>${r.refund_status==='pending'?`<button class="btn sm" data-act="cashRefund" data-id="${r.id}">บันทึกคืนเงินแล้ว</button>`:''}</td></tr>`).join('')||'<tr><td colspan="7" class="center muted">ยังไม่มีรายการรับเงินสด</td></tr>'}</table></div>`;
  };
  box.innerHTML = `<div class="row"><div><label>สถานะการชำระ</label><select data-change="pf" data-k="status"><option value="">ทั้งหมด</option><option value="paid">ชำระแล้ว</option><option value="pending">รอชำระ</option><option value="failed">ไม่สำเร็จ</option><option value="expired">หมดเวลา</option><option value="cancelled">ยกเลิก</option></select></div>
    <div><label>การคืนเงิน</label><select data-change="pf" data-k="refund"><option value="">ทั้งหมด</option><option value="pending">รอคืนเงิน</option><option value="refunded">คืนเงินแล้ว</option></select></div></div><div id="pl" style="margin-top:12px"></div>`;
  onChange('pf', (el) => { f[el.dataset.k] = el.value; load(); });
  on('cashRefund', async (el) => { if(!confirm('ยืนยันว่าได้คืนเงินสดให้ลูกค้าแล้ว?'))return;await api(`/admin/cash-receipts/${el.dataset.id}/refund-done`,{method:'POST'});toast('บันทึกคืนเงินแล้ว');await load(); });
  on('refund', async (el) => {
    if (!confirm('ยืนยันว่าโอนเงินคืนลูกค้าเรียบร้อยแล้ว? (ระบบนี้ไม่ได้โอนเงินให้อัตโนมัติ)')) return;
    await api(`/admin/payments/${el.dataset.id}/refund-done`, { method: 'POST' }); toast('บันทึกแล้ว'); await load();
  });
  await load();
}

const fld = (label, name, val = '', type = 'text', extra = '') => `<div><label>${label}</label><input name="${name}" type="${type}" value="${esc(val)}" ${extra}></div>`;
async function adminTables(box, restSelect) {
  if (!adminRid) { box.innerHTML = '<p class="muted">ยังไม่มีร้านอาหาร</p>'; return; }
  const det = await api(`/admin/restaurants/${adminRid}/details`);
  const draw = (type) => {
    const ts = det.tables.filter((t) => t.type === type);
    return `<h3>${type === 'vip' ? '⭐ โต๊ะ VIP' : '🪑 โต๊ะธรรมดา'} (${ts.length})</h3>
    <div class="card">${ts.length ? planSvg(ts.map((t) => ({ ...t, state: t.status === 'active' ? 'available' : 'unavailable' })), { vip: type === 'vip' }) : '<p class="muted">ยังไม่มีโต๊ะ</p>'}</div>
    <div class="scroll" style="margin-top:8px"><table class="t"><tr><th>โต๊ะ</th><th>ที่นั่ง</th><th>ราคา</th><th>ค่าบริการ</th>${type === 'vip' ? '<th>สิทธิพิเศษ</th>' : ''}<th>สถานะ</th><th></th></tr>
    ${ts.map((t) => `<tr><td><b>${esc(t.label)}</b><br><span class="muted small">${esc(t.description)}</span></td><td>${t.seats}</td><td>${baht(t.price)}</td><td>${baht(t.service_fee)}</td>
      ${type === 'vip' ? `<td class="small">${esc(t.perks.join(', '))}</td>` : ''}
      <td><select data-change="tstatus" data-id="${t.id}"><option value="active" ${t.status === 'active' ? 'selected' : ''}>เปิดจอง</option><option value="maintenance" ${t.status === 'maintenance' ? 'selected' : ''}>ปิดชั่วคราว</option><option value="inactive" ${t.status === 'inactive' ? 'selected' : ''}>ปิดใช้งาน</option></select></td>
      <td style="white-space:nowrap"><button class="btn ghost sm" data-act="tedit" data-id="${t.id}">แก้ไข</button> <button class="btn danger sm" data-act="tdel" data-id="${t.id}">ลบ</button></td></tr>`).join('')}</table></div>`;
  };
  box.innerHTML = `<div class="row" style="align-items:end"><div>${restSelect()}</div><div class="right"><button class="btn" data-act="tnew" data-type="normal">+ เพิ่มโต๊ะธรรมดา</button> <button class="btn vip" data-act="tnew" data-type="vip">+ เพิ่มโต๊ะ VIP</button></div></div>
    <div id="tform"></div>${draw('normal')}${draw('vip')}`;
  const form = (t, type) => {
    const vip = (t ? t.type : type) === 'vip'; t = t || { type, seats: vip ? 8 : 4, price: vip ? 1000 : 100, service_fee: 0, x: 30, y: vip ? 90 : 40, w: vip ? 170 : 70, h: vip ? 160 : 64, shape: 'rect', status: 'active', perks: [], image_url: '', description: '', label: '' };
    $('#tform').innerHTML = `<div class="card" style="margin:14px 0;border-color:${vip ? '#f1d98a' : 'var(--line)'}"><h3>${t.id ? 'แก้ไขโต๊ะ ' + esc(t.label) : 'เพิ่ม' + (vip ? 'โต๊ะ VIP' : 'โต๊ะธรรมดา')}</h3>
      <form data-form="tsave" data-id="${t.id || ''}"><input type="hidden" name="type" value="${t.type}">
      <div class="row">${fld('หมายเลขโต๊ะ', 'label', t.label, 'text', 'required maxlength="20"')}${fld('จำนวนที่นั่ง', 'seats', t.seats, 'number', 'required min="1" max="100"')}${fld('ราคา (บาท)', 'price', t.price, 'number', 'required min="0" step="0.01"')}${fld('ค่าบริการ (บาท)', 'service_fee', t.service_fee, 'number', 'min="0" step="0.01"')}</div>
      <div class="row">${fld('ตำแหน่ง X', 'x', t.x, 'number', 'min="0" max="1000"')}${fld('ตำแหน่ง Y', 'y', t.y, 'number', 'min="0" max="1000"')}${fld('กว้าง', 'w', t.w, 'number', 'min="20" max="1000"')}${fld('สูง', 'h', t.h, 'number', 'min="20" max="1000"')}
        <div><label>รูปทรง</label><select name="shape"><option value="rect" ${t.shape === 'rect' ? 'selected' : ''}>สี่เหลี่ยม</option><option value="round" ${t.shape === 'round' ? 'selected' : ''}>วงกลม/วงรี</option></select></div></div>
      <div class="row">${fld('คำอธิบาย', 'description', t.description)}${fld('URL รูปภาพ', 'image_url', t.image_url, 'text', 'placeholder="https://..."')}</div>
      ${vip ? fld('สิทธิพิเศษ (คั่นด้วย ,)', 'perks', (t.perks || []).join(', '), 'text', 'placeholder="ห้องส่วนตัว, โซฟา, พนักงานบริการส่วนตัว, เครื่องดื่มต้อนรับ"') : ''}
      <div><label>สถานะ</label><select name="status"><option value="active" ${t.status === 'active' ? 'selected' : ''}>เปิดจอง</option><option value="maintenance" ${t.status === 'maintenance' ? 'selected' : ''}>ปิดชั่วคราว</option><option value="inactive" ${t.status === 'inactive' ? 'selected' : ''}>ปิดใช้งาน</option></select></div>
      <p><button class="btn" type="submit">บันทึก</button> <button class="btn ghost" type="button" data-act="tcancel">ยกเลิก</button></p></form></div>`;
    $('#tform').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  on('tnew', (el) => form(null, el.dataset.type));
  on('tedit', (el) => form(det.tables.find((t) => t.id === Number(el.dataset.id))));
  on('tcancel', () => { $('#tform').innerHTML = ''; });
  onForm('tsave', async (d, f) => {
    const id = f.dataset.id;
    await api(id ? '/admin/tables/' + id : `/admin/restaurants/${adminRid}/tables`, { method: id ? 'PUT' : 'POST', body: d });
    toast('บันทึกโต๊ะแล้ว'); await viewAdmin('tables');
  });
  on('tdel', async (el) => {
    if (!confirm('ลบโต๊ะนี้? (หากเคยมีประวัติการจอง ระบบจะปิดใช้งานแทนเพื่อเก็บประวัติ)')) return;
    const r = await api('/admin/tables/' + el.dataset.id, { method: 'DELETE' });
    toast(r.softDeleted ? 'ปิดใช้งานโต๊ะแล้ว (มีประวัติการจอง)' : 'ลบโต๊ะแล้ว'); await viewAdmin('tables');
  });
  onChange('tstatus', async (el) => { await api(`/admin/tables/${el.dataset.id}/status`, { method: 'PATCH', body: { status: el.value } }); toast('อัปเดตสถานะโต๊ะแล้ว'); await viewAdmin('tables'); });
}

/* ===== Admin: จัดการข้อมูลลูกค้า ===== */
const initial = (n) => esc((String(n || '?').trim()[0] || '?').toUpperCase());
const ACTION_LABEL = { create: 'สร้างบัญชี', update: 'แก้ไขข้อมูล', block: 'ระงับบัญชี', unblock: 'ปลดระงับ', reset_password: 'ตั้งรหัสผ่านใหม่', delete: 'ลบบัญชี' };
async function adminCustomers(box) {
  const f = { q: '', role: '', blocked: '' };
  const load = async () => {
    const qs = Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const list = await api('/admin/customers' + (qs ? '?' + qs : ''));
    $('#cl').innerHTML = `<p class="muted small">พบ ${list.length} บัญชี</p><div class="scroll"><table class="t"><tr><th>ลูกค้า</th><th>ติดต่อ</th><th>การจอง</th><th>ยอดใช้จ่ายสุทธิ</th><th>สมัครเมื่อ</th><th>สถานะ</th><th></th></tr>
    ${list.map((u) => `<tr><td><div class="person"><span class="avatar ${u.blocked ? 'off' : ''}">${initial(u.name)}</span><div><b>${esc(u.name)}</b>${u.role === 'admin' ? ' <span class="badge b-info">แอดมิน</span>' : ''}${u.note ? `<br><span class="muted small">📝 ${esc(u.note.slice(0, 40))}${u.note.length > 40 ? '…' : ''}</span>` : ''}</div></div></td>
      <td>${esc(u.phone)}<br><span class="muted small">${esc(u.email)}</span></td><td>${u.bookings_total} <span class="muted small">(สำเร็จ ${u.bookings_confirmed})</span></td><td>${baht(u.spent)}</td><td class="small">${fmtDT(u.created_at)}</td>
      <td>${u.blocked ? '<span class="badge b-bad">ถูกระงับ</span>' : '<span class="badge b-ok">ใช้งานปกติ</span>'}</td>
      <td><button class="btn sm" data-act="copen" data-id="${u.id}">ดู / แก้ไข</button></td></tr>`).join('') || '<tr><td colspan="7" class="center muted">ไม่พบลูกค้า</td></tr>'}</table></div>`;
  };
  box.innerHTML = `<div class="toolbar"><div class="grow"><label>ค้นหา (ชื่อ / เบอร์ / อีเมล)</label><input type="search" data-change="cq" placeholder="พิมพ์เพื่อค้นหา..."></div>
    <div><label>สิทธิ์</label><select data-change="cf" data-k="role"><option value="">ทั้งหมด</option><option value="customer">ลูกค้า</option><option value="admin">แอดมิน</option></select></div>
    <div><label>สถานะ</label><select data-change="cf" data-k="blocked"><option value="">ทั้งหมด</option><option value="0">ใช้งานปกติ</option><option value="1">ถูกระงับ</option></select></div>
    <div><button class="btn" data-act="cnew">+ เพิ่มลูกค้า</button></div></div><div id="cl"></div><div id="modal"></div>`;
  let timer;
  onChange('cq', (el) => { clearTimeout(timer); timer = setTimeout(() => { f.q = el.value.trim(); load().catch(handleErr); }, 250); S.timers.push(timer); });
  onChange('cf', (el) => { f[el.dataset.k] = el.value; load(); });

  const close = () => { $('#modal').innerHTML = ''; document.removeEventListener('keydown', esc_); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  const open = (html) => { $('#modal').innerHTML = `<div class="overlay" data-act="mbg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`; document.addEventListener('keydown', esc_); };
  on('mbg', (el, e) => { if (e.target === el) close(); });
  on('mclose', close);

  async function show(id) {
    const d = await api('/admin/customers/' + id); const u = d.customer; const me = S.user.id === u.id;
    open(`<div class="modal-head"><span class="avatar lg ${u.blocked ? 'off' : ''}">${initial(u.name)}</span><div><h1 style="margin:0;font-size:1.4rem">${esc(u.name)}</h1>
      <span class="muted small">รหัสลูกค้า #${u.id} · สมัครเมื่อ ${fmtDT(u.created_at)}${u.updated_at ? ' · แก้ไขล่าสุด ' + fmtDT(u.updated_at) : ''}</span><br>
      ${u.blocked ? '<span class="badge b-bad">ถูกระงับ</span>' : '<span class="badge b-ok">ใช้งานปกติ</span>'} ${u.role === 'admin' ? '<span class="badge b-info">แอดมิน</span>' : ''}</div>
      <button class="x" data-act="mclose" aria-label="ปิด">×</button></div>
    <div class="kpi"><div class="card"><span class="muted small">การจองทั้งหมด</span><b>${u.bookings_total}</b></div><div class="card"><span class="muted small">จองสำเร็จ</span><b>${u.bookings_confirmed}</b></div><div class="card"><span class="muted small">ยอดใช้จ่ายสุทธิ</span><b>${baht(u.spent)}</b></div></div>
    <h3 class="sec">ข้อมูลลูกค้า</h3>
    <form data-form="cedit" data-id="${u.id}"><div class="row">${fld('ชื่อ-นามสกุล', 'name', u.name, 'text', 'required minlength="2" maxlength="100"')}${fld('เบอร์โทรศัพท์', 'phone', u.phone, 'text', 'required inputmode="tel"')}</div>
      <div class="row">${fld('อีเมล', 'email', u.email, 'email', 'required')}<div><label>สิทธิ์การใช้งาน</label><select name="role" ${me ? 'disabled' : ''}><option value="customer" ${u.role === 'customer' ? 'selected' : ''}>ลูกค้า</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>ผู้ดูแลระบบ</option></select>${me ? `<input type="hidden" name="role" value="${u.role}">` : ''}</div></div>
      <label>หมายเหตุภายใน (ลูกค้าไม่เห็น)</label><textarea name="note" maxlength="500" placeholder="เช่น ลูกค้าประจำ แพ้อาหารทะเล ชอบโซนริมน้ำ">${esc(u.note)}</textarea>
      <p><button class="btn" type="submit">💾 บันทึกการแก้ไข</button></p></form>
    <h3 class="sec">ประวัติการจอง (ล่าสุด ${d.bookings.length} รายการ)</h3>
    ${d.bookings.length ? `<div class="scroll"><table class="t"><tr><th>หมายเลข</th><th>ร้าน / โต๊ะ</th><th>วัน-เวลา</th><th>ยอด</th><th>สถานะ</th></tr>${d.bookings.map((b) => `<tr><td>${esc(b.code)}</td><td>${esc(b.restaurant_name)}<br><span class="muted small">โต๊ะ ${esc(b.table_label)} · ${b.party_size} คน</span></td><td>${b.date}<br><span class="muted small">${b.start_time}–${b.end_time}</span></td><td>${baht(b.amount)}</td><td>${badge(BK, b.status)}</td></tr>`).join('')}</table></div>` : '<p class="muted small">ยังไม่มีประวัติการจอง</p>'}
    <h3 class="sec">ประวัติการแก้ไขโดยแอดมิน</h3>
    ${d.logs.length ? `<ul class="small" style="padding-left:18px;margin:0">${d.logs.map((l) => `<li><b>${esc(ACTION_LABEL[l.action] || l.action)}</b> — ${esc(l.detail)} <span class="muted">· ${esc(l.admin_name)} · ${fmtDT(l.created_at)}</span></li>`).join('')}</ul>` : '<p class="muted small">ยังไม่มีประวัติ</p>'}
    <div class="danger-zone"><h3 style="margin-bottom:6px">การจัดการบัญชี</h3>
      <form data-form="cpw" data-id="${u.id}" class="row" style="align-items:end"><div><label>ตั้งรหัสผ่านใหม่ให้ลูกค้า</label><input name="password" type="text" minlength="8" autocomplete="off" placeholder="อย่างน้อย 8 ตัวอักษร" required></div><div style="flex:none"><button class="btn ghost" type="submit">ตั้งรหัสผ่าน</button></div></form>
      <p class="small muted" style="margin:4px 0 10px">การตั้งรหัสผ่านใหม่จะออกจากระบบทุกอุปกรณ์ของลูกค้า</p>
      <button class="btn ${u.blocked ? '' : 'ghost'}" data-act="cblock" data-id="${u.id}" data-v="${u.blocked ? 0 : 1}" ${me ? 'disabled' : ''}>${u.blocked ? '✅ ปลดระงับบัญชี' : '⛔ ระงับบัญชี'}</button>
      <button class="btn danger" data-act="cdel" data-id="${u.id}" ${me ? 'disabled' : ''}>🗑️ ลบบัญชี</button>
      <p class="small muted" style="margin:8px 0 0">ลูกค้าที่มีประวัติการจองจะลบไม่ได้ (เก็บหลักฐานการเงิน) ให้ใช้ “ระงับบัญชี” แทน</p></div>`);
  }
  on('copen', (el) => show(el.dataset.id));
  on('cnew', () => open(`<div class="modal-head"><h1 style="margin:0;font-size:1.4rem">เพิ่มลูกค้าใหม่</h1><button class="x" data-act="mclose" aria-label="ปิด">×</button></div>
    <form data-form="cadd"><div class="row">${fld('ชื่อ-นามสกุล', 'name', '', 'text', 'required minlength="2"')}${fld('เบอร์โทรศัพท์', 'phone', '', 'text', 'required inputmode="tel" placeholder="0812345678"')}</div>
    <div class="row">${fld('อีเมล', 'email', '', 'email', 'required')}${fld('รหัสผ่านเริ่มต้น', 'password', '', 'text', 'required minlength="8" autocomplete="off"')}</div>
    <div class="row"><div><label>สิทธิ์</label><select name="role"><option value="customer">ลูกค้า</option><option value="admin">ผู้ดูแลระบบ</option></select></div></div>
    <label>หมายเหตุภายใน</label><textarea name="note" maxlength="500"></textarea><p><button class="btn" type="submit">สร้างบัญชี</button></p></form>`));
  onForm('cadd', async (d) => { const u = await api('/admin/customers', { method: 'POST', body: d }); toast('สร้างบัญชีลูกค้าแล้ว'); await load(); await show(u.id); });
  onForm('cedit', async (d, form) => { await api('/admin/customers/' + form.dataset.id, { method: 'PUT', body: d }); toast('บันทึกข้อมูลลูกค้าแล้ว'); if (Number(form.dataset.id) === S.user.id) { S.user = (await api('/me')).user; renderNav(); } await load(); await show(form.dataset.id); });
  onForm('cpw', async (d, form) => { await api(`/admin/customers/${form.dataset.id}/reset-password`, { method: 'POST', body: d }); toast('ตั้งรหัสผ่านใหม่แล้ว'); form.reset(); await show(form.dataset.id); });
  on('cblock', async (el) => {
    const v = el.dataset.v === '1';
    if (!confirm(v ? 'ระงับบัญชีนี้? ลูกค้าจะเข้าสู่ระบบไม่ได้และถูกออกจากระบบทันที (การจองที่มีอยู่ไม่ถูกยกเลิก)' : 'ปลดระงับบัญชีนี้?')) return;
    await api(`/admin/customers/${el.dataset.id}/block`, { method: 'PATCH', body: { blocked: v } }); toast(v ? 'ระงับบัญชีแล้ว' : 'ปลดระงับแล้ว'); await load(); await show(el.dataset.id);
  });
  on('cdel', async (el) => {
    if (!confirm('ลบบัญชีลูกค้านี้อย่างถาวร? การกระทำนี้ย้อนกลับไม่ได้')) return;
    await api('/admin/customers/' + el.dataset.id, { method: 'DELETE' }); close(); toast('ลบบัญชีแล้ว'); await load();
  });
  await load();
}

async function adminRestaurants(box, rests, restSelect) {
  const r = rests.find((x) => x.id === adminRid);
  const det = r ? await api(`/admin/restaurants/${r.id}/details`) : { menu: [], promotions: [] };
  const R = r || { name: '', description: '', address: '', phone: '', open_time: '10:00', close_time: '22:00', slot_minutes: 120, emoji: '🍽️', image_url: '', promptpay_id: '', refund_full_hours: 24, refund_half_hours: 6, active: 1 };
  box.innerHTML = `<div class="row" style="align-items:end"><div>${restSelect()}</div><div class="right"><button class="btn" data-act="rnew">+ เพิ่มร้านใหม่</button></div></div>
  <div class="card" style="margin-top:14px"><h3 id="rtitle">${r ? 'ข้อมูลร้าน' : 'เพิ่มร้านใหม่'}</h3><form data-form="rsave" id="rform">
    <div class="row">${fld('ชื่อร้าน', 'name', R.name, 'text', 'required')}${fld('อีโมจิ', 'emoji', R.emoji, 'text', 'maxlength="8"')}${fld('URL รูปปก', 'image_url', R.image_url)}</div>
    ${fld('คำอธิบาย', 'description', R.description)}<div class="row">${fld('ที่อยู่', 'address', R.address)}${fld('โทรศัพท์', 'phone', R.phone)}</div>
    <div class="row">${fld('เวลาเปิด', 'open_time', R.open_time, 'time', 'required')}${fld('เวลาปิด', 'close_time', R.close_time, 'time', 'required')}${fld('นาทีต่อรอบ', 'slot_minutes', R.slot_minutes, 'number', 'min="30" max="480" step="30"')}</div>
    <div class="row">${fld('PromptPay (เบอร์โทร/เลขบัตร)', 'promptpay_id', R.promptpay_id, 'text', 'required inputmode="numeric"')}${fld('คืนเต็มจำนวนก่อน (ชม.)', 'refund_full_hours', R.refund_full_hours, 'number', 'min="0"')}${fld('คืน 50% ก่อน (ชม.)', 'refund_half_hours', R.refund_half_hours, 'number', 'min="0"')}
      <div><label>สถานะร้าน</label><select name="active"><option value="1" ${R.active ? 'selected' : ''}>เปิด</option><option value="0" ${R.active ? '' : 'selected'}>ปิด</option></select></div></div>
    <p><button class="btn" type="submit">บันทึก</button></p></form></div>
  ${r ? `<div class="split"><div><h3>เมนูอาหาร</h3>${det.menu.map((m) => `<div class="card menu" style="margin-bottom:8px"><div class="e">${safeUrl(m.image_url) ? `<img src="${esc(m.image_url)}" alt="">` : esc(m.emoji)}</div><div style="flex:1"><b>${esc(m.name)}</b> · ${baht(m.price)}<br><span class="muted small">${esc(m.description)}</span></div><button class="btn danger sm" data-act="mdel" data-id="${m.id}">ลบ</button></div>`).join('') || '<p class="muted">ยังไม่มีเมนู</p>'}
    <form class="card" data-form="madd"><b>เพิ่มเมนู</b><div class="row">${fld('ชื่อ', 'name', '', 'text', 'required')}${fld('ราคา', 'price', '', 'number', 'required min="0" step="0.01"')}</div><div class="row">${fld('อีโมจิ', 'emoji', '🍲', 'text', 'maxlength="8"')}${fld('URL รูป', 'image_url')}</div>${fld('คำอธิบาย', 'description')}<p><button class="btn sm" type="submit">เพิ่ม</button></p></form></div>
  <div><h3>โปรโมชั่น</h3>${det.promotions.map((p) => `<div class="card" style="margin-bottom:8px;display:flex;gap:8px;align-items:center"><div style="flex:1"><b>${esc(p.title)}</b><br><span class="muted small">${esc(p.description)}${p.valid_until ? ' · ถึง ' + p.valid_until : ''}</span></div><button class="btn danger sm" data-act="pdel" data-id="${p.id}">ลบ</button></div>`).join('') || '<p class="muted">ยังไม่มีโปรโมชั่น</p>'}
    <form class="card" data-form="padd"><b>เพิ่มโปรโมชั่น</b>${fld('หัวข้อ', 'title', '', 'text', 'required')}${fld('รายละเอียด', 'description')}${fld('ใช้ได้ถึง', 'valid_until', '', 'date')}<p><button class="btn sm" type="submit">เพิ่ม</button></p></form></div></div>` : ''}`;
  let creating = !r;
  on('rnew', () => { creating = true; $('#rtitle').textContent = 'เพิ่มร้านใหม่'; $('#rform').reset(); $('#rform').scrollIntoView({ behavior: 'smooth' }); for (const n of ['name', 'description', 'address', 'phone', 'image_url', 'promptpay_id']) $('#rform')[n].value = ''; });
  onForm('rsave', async (d) => {
    d.active = Number(d.active);
    if (creating) { const n = await api('/admin/restaurants', { method: 'POST', body: d }); adminRid = n.id; }
    else await api('/admin/restaurants/' + r.id, { method: 'PUT', body: d });
    toast('บันทึกข้อมูลร้านแล้ว'); await viewAdmin('restaurants');
  });
  onForm('madd', async (d) => { await api(`/admin/restaurants/${r.id}/menu`, { method: 'POST', body: d }); toast('เพิ่มเมนูแล้ว'); await viewAdmin('restaurants'); });
  onForm('padd', async (d) => { await api(`/admin/restaurants/${r.id}/promotions`, { method: 'POST', body: d }); toast('เพิ่มโปรโมชั่นแล้ว'); await viewAdmin('restaurants'); });
  on('mdel', async (el) => { await api('/admin/menu/' + el.dataset.id, { method: 'DELETE' }); await viewAdmin('restaurants'); });
  on('pdel', async (el) => { await api('/admin/promotions/' + el.dataset.id, { method: 'DELETE' }); await viewAdmin('restaurants'); });
}

async function adminStaff(box){
 const list=await api('/admin/staff');
 const permLabels={orders:'รับ/ดูออเดอร์',kitchen:'จัดการครัว',booking_cash:'รับชำระค่าจอง',food_cash:'รับชำระค่าอาหาร'};
 box.innerHTML=`<h2>บัญชีพนักงานและสิทธิ์</h2><form id="staffAdd" class="card"><h3>เพิ่มพนักงาน</h3><div class="row"><div><label>ชื่อ</label><input name="name" required minlength="2"></div><div><label>เบอร์โทร</label><input name="phone" required></div></div><div class="row"><div><label>อีเมลเข้าสู่ระบบ</label><input name="email" type="email" required></div><div><label>รหัสผ่านเริ่มต้น</label><input name="password" type="password" minlength="8" required></div></div><label>สิทธิ์</label><div class="chips">${Object.entries(permLabels).map(([k,v])=>`<label class="chip"><input type="checkbox" name="permissions" value="${k}" ${k==='orders'||k==='kitchen'?'checked':''}> ${v}</label>`).join('')}</div><button class="btn">สร้างบัญชีพนักงาน</button></form><div class="grid">${list.map(x=>`<div class="card"><div class="person"><span class="avatar">${esc(initial(x.name))}</span><div><b>${esc(x.name)}</b><div class="small muted">${esc(x.email)} · ${esc(x.phone)}</div></div></div><p class="small">${x.permissions.map(p=>permLabels[p]||p).join(' · ')}</p><label>แก้ไขสิทธิ์</label><div class="chips">${Object.entries(permLabels).map(([k,v])=>`<label class="chip"><input type="checkbox" data-staff-perm="${x.id}" value="${k}" ${x.permissions.includes(k)?'checked':''}> ${v}</label>`).join('')}</div><label><input type="checkbox" data-staff-active="${x.id}" ${x.active?'checked':''}> เปิดใช้งาน</label><button class="btn sm" data-act="staffSave" data-id="${x.id}">บันทึกสิทธิ์</button> <button class="btn danger sm" data-act="staffDelete" data-id="${x.id}">ลบสิทธิ์พนักงาน</button></div>`).join('')||'<p class="muted">ยังไม่มีบัญชีพนักงาน</p>'}</div>`;
 $('#staffAdd').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const permissions=f.getAll('permissions');await api('/admin/staff',{method:'POST',body:{name:f.get('name'),phone:f.get('phone'),email:f.get('email'),password:f.get('password'),permissions}});toast('สร้างบัญชีพนักงานแล้ว');await adminStaff(box);};
 on('staffSave',async el=>{const id=el.dataset.id,permissions=[...document.querySelectorAll(`[data-staff-perm="${id}"]:checked`)].map(x=>x.value),active=!!$(`[data-staff-active="${id}"]`)?.checked;await api(`/admin/staff/${id}`,{method:'PUT',body:{permissions,active}});toast('บันทึกสิทธิ์แล้ว');await adminStaff(box);});
 on('staffDelete',async el=>{if(!confirm('ยกเลิกสิทธิ์พนักงานบัญชีนี้?'))return;await api(`/admin/staff/${el.dataset.id}`,{method:'DELETE'});toast('ยกเลิกสิทธิ์แล้ว');await adminStaff(box);});
}
async function viewStaff(){
 if(needLogin())return;const me=await api('/staff/me');
 app.innerHTML=`<div class="eyebrow">STAFF WORKSPACE</div><h1>พื้นที่ปฏิบัติงาน</h1><p class="muted">เข้าสู่ระบบในชื่อ ${esc(me.user.name)} · สิทธิ์: ${me.permissions.join(', ')}</p>
 ${me.permissions.includes('booking_cash')?`<div class="card"><h3>รับชำระค่าจองเป็นเงินสด</h3><form id="staffBookingCash"><label>ID การจอง</label><input name="id" type="number" min="1" required><button class="btn">ตรวจสอบและรับเงินสด</button></form></div>`:''}
 ${me.permissions.includes('food_cash')?`<div class="card"><h3>รับชำระค่าอาหารเป็นเงินสด</h3><form id="staffFoodCash"><label>ID การจอง</label><input name="id" type="number" min="1" required><button class="btn">รับชำระค่าอาหาร</button></form></div>`:''}
 ${me.permissions.includes('orders')?`<div class="card"><h3>รับออเดอร์แทนลูกค้า</h3><form id="staffOrderAdd"><div class="row"><div><label>ID การจอง</label><input name="booking_id" type="number" min="1" required></div><div><label>เมนู (รหัสเมนู:จำนวน คั่นด้วยจุลภาค)</label><input name="items" placeholder="1:2, 3:1" required></div></div><label>หมายเหตุ</label><input name="note"><button class="btn">ส่งออเดอร์เข้าครัว</button></form></div>`:''}
 <div class="tabs"><button class="tab on" id="staffRefresh">ออเดอร์ครัว</button></div><div id="staffOrders"></div>`;
 const load=async()=>{if(!me.permissions.includes('orders')&&!me.permissions.includes('kitchen')&&!me.permissions.includes('all')){$('#staffOrders').innerHTML='<div class="card muted">บัญชีนี้ไม่มีสิทธิ์ดูออเดอร์ ใช้แบบฟอร์มรับชำระด้านบนได้</div>';return;}const list=await api('/staff/orders');$('#staffOrders').innerHTML=list.map(o=>`<div class="card" style="margin:10px 0"><div class="row"><div><b>ออเดอร์ #${o.id}</b> · ${esc(o.booking_code)} · โต๊ะ ${esc(o.table_label)}</div><span class="badge b-warn">${o.status==='submitted'?'รอครัว':'กำลังทำ'}</span></div><p>${o.items.map(i=>`${esc(i.item_name)} × ${i.quantity}`).join(' · ')}</p><div class="row">${me.permissions.includes('kitchen')||me.permissions.includes('all')?`${o.status==='submitted'?`<button class="btn" data-act="staffStart" data-id="${o.id}">เริ่มทำอาหาร</button>`:''}<button class="btn ghost" data-act="staffServe" data-id="${o.id}">ทำเสร็จ / เสิร์ฟ</button>`:''}</div></div>`).join('')||'<div class="card muted">ไม่มีออเดอร์ที่รอดำเนินการ</div>';};
 on('staffStart',async el=>{await api(`/staff/orders/${el.dataset.id}/status`,{method:'PATCH',body:{status:'preparing'}});await load();});
 on('staffServe',async el=>{await api(`/staff/orders/${el.dataset.id}/status`,{method:'PATCH',body:{status:'served'}});toast('อัปเดตเป็นเสิร์ฟแล้ว');await load();});
 $('#staffRefresh').onclick=load;
 $('#staffBookingCash')?.addEventListener('submit',async e=>{e.preventDefault();const id=Number(new FormData(e.target).get('id'));if(!confirm('ยืนยันรับเงินสดค่าจองเต็มจำนวน?'))return;const r=await api(`/staff/bookings/${id}/pay-cash`,{method:'POST'});toast(`รับเงินแล้ว ใบเสร็จ ${r.receipt.receipt_no}`);e.target.reset();});
 $('#staffFoodCash')?.addEventListener('submit',async e=>{e.preventDefault();const id=Number(new FormData(e.target).get('id'));if(!confirm('ยืนยันรับชำระค่าอาหารตามยอดค้าง?'))return;const r=await api(`/staff/bookings/${id}/food/pay-cash`,{method:'POST'});toast(`รับเงินแล้ว ใบเสร็จ ${r.payment.receipt_no}`);e.target.reset();});
 $('#staffOrderAdd')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target),items=String(f.get('items')).split(',').map(x=>{const [menu_item_id,quantity]=x.trim().split(':').map(Number);return {menu_item_id,quantity};});await api('/staff/orders',{method:'POST',body:{booking_id:Number(f.get('booking_id')),items,note:f.get('note')}});toast('ส่งออเดอร์เข้าครัวแล้ว');e.target.reset();await load();});
 await load();
}

/* ===== เริ่มระบบ ===== */
(async function init() {
  try { S.config = await api('/config'); } catch (_) { /* ignore */ }
  if (S.token) { try { const me = await api('/me'); S.user = me.user; } catch (_) { setSession(null, null); } }
  renderNav();
  await route();
})();
