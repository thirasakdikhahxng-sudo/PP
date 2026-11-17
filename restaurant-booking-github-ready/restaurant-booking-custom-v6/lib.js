'use strict';
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- เวลา (Asia/Bangkok, UTC+7) ----------
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const slotStartMs = (date, time) => Date.parse(`${date}T${time}:00+07:00`);
const bangkokToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');

// ---------- รหัสผ่าน / token ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
const newToken = () => crypto.randomBytes(32).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- PromptPay (EMVCo / Thai QR Payment) ----------
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
const tlv = (id, val) => id + String(val.length).padStart(2, '0') + val;
function promptPayPayload(target, amount) {
  const t = String(target).replace(/\D/g, '');
  let sub, acct;
  if (t.length >= 15) { sub = '03'; acct = t; }            // e-wallet
  else if (t.length === 13) { sub = '02'; acct = t; }      // เลขบัตรประชาชน / เลขผู้เสียภาษี
  else { sub = '01'; acct = '0066' + t.replace(/^0/, ''); } // เบอร์โทรศัพท์
  const merchant = tlv('00', 'A000000677010111') + tlv(sub, acct);
  let p = tlv('00', '01') + tlv('01', amount ? '12' : '11') + tlv('29', merchant) + tlv('53', '764');
  if (amount) p += tlv('54', Number(amount).toFixed(2));
  p += tlv('58', 'TH') + '6304';
  return p + crc16(p);
}

// ---------- ตรวจข้อมูล ----------
const validEmail = (s) => typeof s === 'string' && s.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const normPhone = (s) => String(s || '').replace(/[\s-]/g, '');
const validPhone = (s) => /^0\d{8,9}$/.test(s);
const cleanStr = (s, max = 200) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const validUrl = (s) => s === '' || /^https?:\/\/\S+$/i.test(s) || /^\/[\w\-./]*$/.test(s);
const money = (n) => Math.round(Number(n) * 100) / 100;

module.exports = {
  HttpError, toMin, fromMin, slotStartMs, bangkokToday, addDays, isDate, isTime,
  hashPassword, verifyPassword, newToken, sha256, promptPayPayload,
  validEmail, normPhone, validPhone, cleanStr, validUrl, money,
};
