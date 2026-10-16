/* =====================================================================
 * app.js — Maasathi pregnancy tracker
 *  - Privacy-first: all data in localStorage, optional AES-GCM encryption
 *  - Multi-language: all strings via t() from js/i18n/*
 *  - Payments: Cashfree via backend (js/config.js -> backend/worker.js)
 * ===================================================================== */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const KEY = 'maasathi.data.v1';
const CONSENT_KEY = 'maasathi.consent.v1';

const SYMPTOM_KEYS = ['sym_nausea','sym_fatigue','sym_dizzy','sym_headache','sym_backpain',
  'sym_cramps','sym_breathless','sym_heartburn','sym_constipation','sym_swelling',
  'sym_mood','sym_nosleep','sym_lessappetite','sym_moreappetite','sym_discharge','sym_spotting'];
const MOOD_KEYS = [['mood_great','😊'],['mood_ok','🙂'],['mood_normal','😐'],['mood_worried','😟'],['mood_sad','😢']];

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => { try { return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return d; } };
const fmtDateTime = (d) => { try { return new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return d; } };

/* --------------------------- crypto layer -------------------------- */
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = {
  from: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  to: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
async function deriveKey(pin, saltB64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64.to(saltB64), iterations: 210000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptJSON(text, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { iv: b64.from(iv), ct: b64.from(ct) };
}
async function decryptJSON(ivB64, ctB64, key) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.to(ivB64) }, key, b64.to(ctB64));
  return dec.decode(pt);
}
const randomSalt = () => b64.from(crypto.getRandomValues(new Uint8Array(16)));

/* ---------------------------- app state ---------------------------- */
let state = null, sessionKey = null, pendingWrapper = null;

function emptyState() {
  return {
    profile: { name: '', dueDate: '', createdAt: new Date().toISOString() },
    symptoms: [], weights: [], bp: [], appointments: [], contractions: [],
    kickToday: { date: todayISO(), count: 0, start: null },
    notes: '', checklist: buildChecklist(),
    reminders: [], reminderLog: [],
    premium: { active: false, plan: null, validTill: null, checkedAt: null, source: null },
    settings: { pinEnabled: false, notif: false, consentAt: new Date().toISOString() },
  };
}
function buildChecklist() {
  const map = {};
  (window.DEFAULT_CHECKLIST || []).forEach((g) => g.items.forEach((it) => { map[g.group + '||' + it] = false; }));
  return map;
}

/* ---------------------------- persistence -------------------------- */
async function persist() {
  if (!state) return;
  const payload = JSON.stringify(state);
  if (state.settings.pinEnabled && sessionKey) {
    const { iv, ct } = await encryptJSON(payload, sessionKey);
    const w = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ v: 1, enc: true, salt: w.salt || randomSalt(), iv, ct }));
  } else {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, enc: false, data: payload }));
  }
}

/* ------------------------------ boot ------------------------------- */
async function boot() {
  bindStaticEvents();
  registerSW();
  populateLangSelects();
  await window.loadLang(window.CURRENT_LANG);
  window.applyI18n();
  applyConfig();

  const consent = localStorage.getItem(CONSENT_KEY);
  if (!consent) { $('#consentScreen').classList.remove('hidden'); return; }

  const raw = localStorage.getItem(KEY);
  if (!raw) { state = emptyState(); enterApp(); return; }

  const wrapper = JSON.parse(raw);
  if (wrapper.enc) {
    pendingWrapper = wrapper;
    $('#lockScreen').classList.remove('hidden');
    return;
  }
  state = Object.assign(emptyState(), JSON.parse(wrapper.data || '{}'));
  enterApp();
}

function applyConfig() {
  const cfg = window.APP_CONFIG || {};
  const m = $('#priceMonthly'), y = $('#priceYearly');
  if (m && cfg.PLANS) m.textContent = '₹' + cfg.PLANS.monthly.amount;
  if (y && cfg.PLANS) y.textContent = '₹' + cfg.PLANS.yearly.amount;
  const g = $('#grievanceLink');
  if (g && cfg.GRIEVANCE_EMAIL) { g.href = 'mailto:' + cfg.GRIEVANCE_EMAIL; g.textContent = cfg.GRIEVANCE_EMAIL; }
}

function enterApp() {
  $('#consentScreen').classList.add('hidden');
  $('#lockScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderAll();
  maybeVerifyReturn();
  syncEntitlement();          // server se premium status laao (background)
  startReminderEngine();      // reminders + acknowledgement engine
}

/* --------------------------- navigation ---------------------------- */
function showView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const v = $('#view-' + name);
  if (v) v.classList.remove('hidden');
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  window.scrollTo(0, 0);
  if (name === 'premium') syncEntitlement();
}

/* ---------------------------- rendering ---------------------------- */
function renderAll() {
  renderHome(); renderTrack(); renderTools(); renderRecords(); renderReminders(); renderPremium(); renderSettings();
}
window.renderAll = renderAll;

function pregnancyInfo() {
  const due = state.profile.dueDate;
  if (!due) return null;
  const dueMs = new Date(due + 'T00:00:00').getTime();
  const daysLeft = Math.max(0, Math.ceil((dueMs - Date.now()) / 86400000));
  const gestDays = 280 - Math.min(280, Math.max(0, Math.ceil((dueMs - Date.now()) / 86400000)));
  const week = Math.floor(gestDays / 7);
  const pct = Math.min(100, Math.round((gestDays / 280) * 100));
  return { week, daysLeft, pct };
}

function renderHome() {
  const p = pregnancyInfo();
  $('#topbarTitle').textContent = state.profile.name ? (window.t('namaste') + ', ' + state.profile.name) : window.t('namaste');
  $('#topbarSub').textContent = p ? (p.week + ' ' + window.t('home_weeks')) : window.t('home_set_due');

  if (!p) {
    $('#homeWeek').textContent = '—';
    $('#homeDaysLeft').textContent = '—';
    $('#homeTrimester').textContent = '';
    $('#homeDue').textContent = '—';
    $('#homeProgress').style.width = '0%';
    $('#homeWeekNum').textContent = '—';
    $('#homeSize').textContent = window.t('home_set_due');
    $('#homeNote').innerHTML = window.t('home_set_due_note') +
      ' <br><button class="quick" data-nav="settings">' + window.t('open_settings') + '</button>';
    return;
  }
  $('#homeWeek').textContent = p.week;
  $('#homeDaysLeft').textContent = p.daysLeft;
  $('#homeTrimester').textContent = '';
  $('#homeDue').textContent = fmtDate(state.profile.dueDate);
  $('#homeProgress').style.width = p.pct + '%';
  $('#homeWeekNum').textContent = p.week;
  const w = Math.min(42, Math.max(4, p.week));
  $('#homeSize').textContent = window.t('W' + w + '_SIZE');
  $('#homeNote').textContent = window.t('W' + w + '_NOTE');
}

function renderTrack() {
  const chips = $('#symptomChips');
  chips.innerHTML = SYMPTOM_KEYS.map((k) => `<span class="chip" data-sym="${k}">${window.t(k)}</span>`).join('');
  if (!chips.dataset.bound) {
    chips.dataset.bound = '1';
    chips.addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) c.classList.toggle('on'); });
  }
  renderLogList();
  renderWeightChart();
}

function renderLogList() {
  const list = $('#logList');
  const items = [];
  state.symptoms.slice(-8).reverse().forEach((s, i) => items.push(
    `<div class="log-item"><span>📝 ${fmtDate(s.date)} — ${(s.items || []).map(window.t).join(', ') || s.note || ''}</span><button class="del" data-del="symptom:${state.symptoms.length - 1 - i}">${window.t('delete')}</button></div>`));
  state.weights.slice(-8).reverse().forEach((w, i) => items.push(
    `<div class="log-item"><span>⚖️ ${fmtDate(w.date)} — ${w.kg} kg</span><button class="del" data-del="weight:${state.weights.length - 1 - i}">${window.t('delete')}</button></div>`));
  state.bp.slice(-8).reverse().forEach((b, i) => items.push(
    `<div class="log-item"><span>🩺 ${fmtDate(b.date)} — ${b.sys}/${b.dia}</span><button class="del" data-del="bp:${state.bp.length - 1 - i}">${window.t('delete')}</button></div>`));
  list.innerHTML = items.join('') || `<p class="tiny muted">${window.t('log_empty')}</p>`;
}

function renderWeightChart() {
  const cv = $('#weightChart'); if (!cv) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const data = state.weights.slice(-20);
  if (data.length < 2) {
    ctx.fillStyle = '#a99ec4'; ctx.font = '16px sans-serif';
    ctx.fillText(window.t('chart_hint'), 16, cv.height / 2);
    return;
  }
  const kgs = data.map((d) => Number(d.kg));
  const min = Math.min(...kgs) - 1, max = Math.max(...kgs) + 1;
  const pad = 24, w = cv.width - pad * 2, h = cv.height - pad * 2;
  ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 3; ctx.beginPath();
  data.forEach((d, i) => {
    const x = pad + (i / (data.length - 1)) * w;
    const y = pad + h - ((Number(d.kg) - min) / (max - min)) * h;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#6b6880'; ctx.font = '12px sans-serif';
  ctx.fillText(kgs[0] + ' kg', pad, cv.height - 6);
  ctx.fillText(kgs[kgs.length - 1] + ' kg', cv.width - 60, cv.height - 6);
}

function renderTools() {
  $('#kickCount').textContent = state.kickToday.count || 0;
  $('#kickTimer').textContent = state.kickToday.start
    ? window.t('kick_session_start') + ': ' + fmtDateTime(state.kickToday.start) : window.t('kick_no_session');
  $('#contractionStatus').textContent = $('#contractionStatus').textContent || window.t('contraction_ready');
  if (!$('#contractionInfo').textContent) $('#contractionInfo').textContent = window.t('contraction_start_info');
  $('#contractionList').innerHTML = state.contractions.slice(-6).reverse().map((c) =>
    `<div class="log-item"><span>${fmtDateTime(c.start)} — ${c.secs}s</span></div>`).join('')
    || `<p class="tiny muted">${window.t('contraction_empty')}</p>`;
}

function renderRecords() {
  $('#apptList').innerHTML = state.appointments.slice().sort((a, b) => a.when < b.when ? -1 : 1).map((a) =>
    `<div class="log-item"><span>📅 ${a.title} — ${fmtDateTime(a.when)}</span><button class="del" data-del="appt:${a.id}">${window.t('delete')}</button></div>`).join('')
    || `<p class="tiny muted">${window.t('appt_empty')}</p>`;

  $('#checklistArea').innerHTML = (window.DEFAULT_CHECKLIST || []).map((g) => `
    <div class="field-label">${g.group}</div>
    ${g.items.map((it) => {
      const k = g.group + '||' + it;
      return `<label class="check-row"><input type="checkbox" data-chk="${k}" ${state.checklist[k] ? 'checked' : ''}/><span>${it}</span></label>`;
    }).join('')}`).join('');
  $('#notesArea').value = state.notes || '';
}

function renderPremium() {
  const active = isPremiumActive();
  const p = state.premium || {};
  $('#buyBtn').classList.toggle('hidden', active);
  const rb = $('#restoreBtn'); if (rb) rb.classList.toggle('hidden', active);
  const st = $('#premiumStatus');
  if (st) {
    if (active) {
      st.innerHTML = '<b>✓ ' + window.t('premium_active') + '</b>' +
        (p.validTill ? '<br><span class="tiny muted">' + window.t('premium_valid_till') + ' ' + fmtDate(p.validTill) + '</span>' : '');
    } else {
      st.innerHTML = '<span class="tiny muted">' + window.t('premium_not_active') + '</span>';
    }
  }
}

/* Premium active hai? (server entitlement, offline ke liye cached) */
function isPremiumActive() {
  const p = state.premium || {};
  if (!p.active) return false;
  if (p.validTill && new Date(p.validTill).getTime() < Date.now()) return false;
  return true;
}

function renderSettings() {
  $('#setName').value = state.profile.name || '';
  $('#setDue').value = state.profile.dueDate || '';
  $('#setPin').value = '';
  $('#setLang').value = window.CURRENT_LANG;
  const rc = $('#restoreCode'); if (rc) rc.textContent = getUserId();
}

/* ------------------------------ events ----------------------------- */
function populateLangSelects() {
  const opts = window.I18N.langs.map((l) => `<option value="${l.code}">${l.native}</option>`).join('');
  ['#consentLang', '#setLang'].forEach((sel) => { const el = $(sel); if (el) el.innerHTML = opts; });
  const c = $('#consentLang'); if (c) c.value = window.CURRENT_LANG;
}

function bindStaticEvents() {
  const cl = $('#consentLang');
  if (cl) cl.addEventListener('change', (e) => window.setLang(e.target.value));
  const sl = $('#setLang');
  if (sl) sl.addEventListener('change', (e) => window.setLang(e.target.value));

  $('#consentCheck').addEventListener('change', (e) => { $('#consentBtn').disabled = !e.target.checked; });
  $('#consentBtn').addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, new Date().toISOString());
    if (!state) state = emptyState();
    persist().then(enterApp);
  });

  $('#unlockBtn').addEventListener('click', unlock);
  $('#unlockPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });

  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]'); if (nav) showView(nav.dataset.nav);
    const q = e.target.closest('[data-quick]'); if (q) openQuick(q.dataset.quick);
  });

  $('#saveSymptomBtn').addEventListener('click', () => {
    const items = $$('.chip.on').map((c) => c.dataset.sym);
    const note = $('#symptomNote').value.trim();
    if (!items.length && !note) return;
    state.symptoms.push({ date: todayISO(), items, note });
    $$('.chip.on').forEach((c) => c.classList.remove('on'));
    $('#symptomNote').value = '';
    persist(); renderLogList();
  });
  $('#saveWeightBtn').addEventListener('click', () => {
    const kg = parseFloat($('#weightInput').value); if (!kg) return;
    state.weights.push({ date: todayISO(), kg }); $('#weightInput').value = ''; persist(); renderTrack();
  });
  $('#saveBpBtn').addEventListener('click', () => {
    const sys = parseInt($('#bpSys').value, 10), dia = parseInt($('#bpDia').value, 10);
    if (!sys || !dia) return;
    state.bp.push({ date: todayISO(), sys, dia });
    $('#bpSys').value = ''; $('#bpDia').value = ''; persist(); renderLogList();
  });
  $('#logList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    const [type, idx] = b.dataset.del.split(':');
    if (type === 'symptom') state.symptoms.splice(Number(idx), 1);
    if (type === 'weight') state.weights.splice(Number(idx), 1);
    if (type === 'bp') state.bp.splice(Number(idx), 1);
    persist(); renderTrack();
  });

  $('#kickAddBtn').addEventListener('click', () => {
    if (state.kickToday.date !== todayISO()) state.kickToday = { date: todayISO(), count: 0, start: null };
    state.kickToday.count = (state.kickToday.count || 0) + 1;
    if (!state.kickToday.start) state.kickToday.start = new Date().toISOString();
    persist(); renderTools();
  });
  $('#kickStartBtn').addEventListener('click', () => {
    state.kickToday = { date: todayISO(), count: 0, start: new Date().toISOString() }; persist(); renderTools();
  });
  $('#kickResetBtn').addEventListener('click', () => {
    state.kickToday = { date: todayISO(), count: 0, start: null }; persist(); renderTools();
  });

  let contractionStart = null;
  $('#contractionBtn').addEventListener('click', () => {
    if (!contractionStart) {
      contractionStart = Date.now();
      $('#contractionStatus').textContent = window.t('contraction_running');
      $('#contractionInfo').textContent = window.t('contraction_stop_info');
    } else {
      const secs = Math.round((Date.now() - contractionStart) / 1000);
      state.contractions.push({ start: new Date(contractionStart).toISOString(), secs });
      contractionStart = null;
      $('#contractionStatus').textContent = window.t('contraction_ready');
      $('#contractionInfo').textContent = window.t('contraction_start_info');
      persist(); renderTools();
    }
  });
  $('#contractionResetBtn').addEventListener('click', () => {
    contractionStart = null;
    $('#contractionStatus').textContent = window.t('contraction_ready');
    $('#contractionInfo').textContent = window.t('contraction_start_info');
  });

  $('#eddCalcBtn').addEventListener('click', () => {
    const lmp = $('#eddLmp').value; if (!lmp) return;
    const d = new Date(lmp + 'T00:00:00'); d.setDate(d.getDate() + 280);
    $('#eddResult').textContent = window.t('edd_result') + ' ' + fmtDate(d.toISOString());
  });

  $('#saveApptBtn').addEventListener('click', () => {
    const title = $('#apptTitle').value.trim(), when = $('#apptDate').value;
    if (!title || !when) return;
    state.appointments.push({ id: Date.now().toString(), title, when });
    // appointment reminder (ek baar) — agar checkbox on hai
    const cb = $('#apptRemind');
    if ((!cb || cb.checked) && when.length >= 16) {
      state.reminders.push({ id: 'r' + Date.now(), type: 'appointment', title, dose: '',
        time: when.slice(11, 16), repeat: 'once', date: when.slice(0, 10), enabled: true });
    }
    $('#apptTitle').value = ''; $('#apptDate').value = '';
    persist(); renderRecords(); renderReminders(); syncReminders();
  });
  $('#notifBtn').addEventListener('click', requestNotif);
  $('#addRemBtn').addEventListener('click', addMedicineReminder);
  $('#reminderList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-delrem]'); if (b) deleteReminder(b.dataset.delrem);
  });
  $('#alarmTakenBtn').addEventListener('click', () => acknowledge('taken'));
  $('#alarmSkipBtn').addEventListener('click', () => acknowledge('skipped'));
  $('#alarmSnoozeBtn').addEventListener('click', () => acknowledge('snooze'));
  $('#apptList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    const [, id] = b.dataset.del.split(':');
    state.appointments = state.appointments.filter((a) => a.id !== id); persist(); renderRecords();
  });
  $('#checklistArea').addEventListener('change', (e) => {
    const c = e.target.closest('[data-chk]'); if (!c) return;
    state.checklist[c.dataset.chk] = c.checked; persist();
  });
  $('#saveNotesBtn').addEventListener('click', () => {
    state.notes = $('#notesArea').value; persist();
    $('#saveNotesBtn').textContent = window.t('saved') + ' ✓';
    setTimeout(() => { $('#saveNotesBtn').textContent = window.t('notes_save'); }, 1200);
  });

  $('#saveProfileBtn').addEventListener('click', saveProfile);
  $('#exportBtn').addEventListener('click', exportData);
  $('#deleteBtn').addEventListener('click', deleteAll);
  $('#lockNowBtn').addEventListener('click', () => {
    if (!state.settings.pinEnabled) return;
    sessionKey = null; state = null;
    $('#app').classList.add('hidden'); $('#lockScreen').classList.remove('hidden');
    $('#unlockPin').value = ''; $('#lockError').textContent = '';
  });

  $('#buyBtn').addEventListener('click', startPayment);
  const rb = $('#restoreBtn');
  if (rb) rb.addEventListener('click', async () => {
    setPremiumMsg(window.t('premium_checking'));
    if (await restorePlay()) { setPremiumMsg(window.t('premium_success')); return; }
    await syncEntitlement();
    setPremiumMsg(isPremiumActive() ? window.t('premium_active') : window.t('premium_not_active'));
  });
  const rcb = $('#restoreCodeBtn');
  if (rcb) rcb.addEventListener('click', restoreFromCode);
  const ccb = $('#copyCodeBtn');
  if (ccb) ccb.addEventListener('click', copyRestoreCode);
  const rep = $('#reportBtn');
  if (rep) rep.addEventListener('click', downloadReport);
  $('#modalClose').addEventListener('click', () => $('#modal').classList.add('hidden'));
}

async function unlock() {
  const pin = $('#unlockPin').value;
  if (pin.length < 4) { $('#lockError').textContent = '4+'; return; }
  try {
    const key = await deriveKey(pin, pendingWrapper.salt);
    const json = await decryptJSON(pendingWrapper.iv, pendingWrapper.ct, key);
    sessionKey = key;
    state = Object.assign(emptyState(), JSON.parse(json));
    enterApp();
  } catch (err) { $('#lockError').textContent = window.t('lock_error'); }
}

async function saveProfile() {
  state.profile.name = $('#setName').value.trim();
  state.profile.dueDate = $('#setDue').value;
  const pin = $('#setPin').value;
  const wasPin = state.settings.pinEnabled;

  if (pin && pin.length >= 4) {
    const salt = randomSalt();
    sessionKey = await deriveKey(pin, salt);
    state.settings.pinEnabled = true;
    const { iv, ct } = await encryptJSON(JSON.stringify(state), sessionKey);
    localStorage.setItem(KEY, JSON.stringify({ v: 1, enc: true, salt, iv, ct }));
  } else if (!pin && wasPin) {
    state.settings.pinEnabled = false; sessionKey = null; await persist();
  } else { await persist(); }

  $('#setPin').value = '';
  $('#saveProfileBtn').textContent = window.t('saved') + ' ✓';
  setTimeout(() => { $('#saveProfileBtn').textContent = window.t('set_save'); }, 1200);
  renderAll();
}

/* --------------------------- DPDP actions -------------------------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'maasathi-my-data.json';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function deleteAll() {
  if (!confirm(window.t('delete_confirm'))) return;
  localStorage.removeItem(KEY); localStorage.removeItem(CONSENT_KEY);
  sessionKey = null; state = null; location.reload();
}

/* --------------------------- Cashfree pay -------------------------- */
function setPremiumMsg(msg) { $('#premiumMsg').textContent = msg; }

/* Device ka stable user id (server entitlement isi se bandha hota hai).
 * NOTE: yeh random UUID hai — practical taur par unguessable. Zyada suraksha
 * ke liye aage phone OTP wala login jod sakte hain. */
function getUserId() {
  let id = localStorage.getItem('maasathi.uid');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID()
      : 'u' + Date.now() + Math.random().toString(36).slice(2, 10)).replace(/[^A-Za-z0-9_-]/g, '');
    localStorage.setItem('maasathi.uid', id);
  }
  return id;
}

/* Server se premium status laao (Cloudflare KV = source of truth) */
async function syncEntitlement() {
  const cfg = window.APP_CONFIG || {};
  if (!navigator.onLine || !cfg.API_BASE) return;
  try {
    const baseUrl = cfg.API_BASE.replace(/\/$/, '');
    const r = await fetch(baseUrl + '/api/entitlement?user_id=' + encodeURIComponent(getUserId()));
    const d = await r.json();
    state.premium = {
      active: !!d.premium, plan: d.plan || null, validTill: d.validTill || null,
      checkedAt: new Date().toISOString(), source: 'server',
    };
    await persist(); renderPremium();
  } catch (e) { /* offline: cached status hi rehne do */ }
}

/* Restore code copy */
async function copyRestoreCode() {
  const btn = $('#copyCodeBtn');
  try { await navigator.clipboard.writeText(getUserId()); btn.textContent = window.t('copied'); }
  catch (e) { btn.textContent = getUserId(); }
  setTimeout(() => { btn.textContent = window.t('copy'); }, 1500);
}

/* Naye phone par restore code se premium wapas laao */
async function restoreFromCode() {
  const raw = ($('#restoreCodeInput').value || '').trim();
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '');
  if (clean.length < 8) { setPremiumMsg(window.t('premium_not_active')); return; }
  localStorage.setItem('maasathi.uid', clean);
  setPremiumMsg(window.t('premium_checking'));
  await syncEntitlement();
  setPremiumMsg(isPremiumActive() ? window.t('premium_active') : window.t('premium_not_active'));
  renderSettings();
}

/* ---- Doctor report (Premium) — print/save-as-PDF, koi library nahi ---- */
function buildDoctorReport() {
  const p = pregnancyInfo();
  const out = [];
  out.push('<h1>Maasathi — ' + window.t('report_title') + '</h1>');
  out.push('<p class="who">' + (state.profile.name ? state.profile.name + '<br>' : '') +
    window.t('home_due') + ': ' + (state.profile.dueDate ? fmtDate(state.profile.dueDate) : '—') +
    (p ? ' &nbsp;|&nbsp; ' + window.t('home_week') + ' ' + p.week : '') + '</p>');
  if (state.weights.length) {
    out.push('<h2>' + window.t('track_weight_title') + '</h2><table><tr><th>Date</th><th>kg</th></tr>' +
      state.weights.slice(-40).map((w) => '<tr><td>' + fmtDate(w.date) + '</td><td>' + w.kg + '</td></tr>').join('') + '</table>');
  }
  if (state.bp.length) {
    out.push('<h2>' + window.t('track_bp_title') + '</h2><table><tr><th>Date</th><th>SYS/DIA</th></tr>' +
      state.bp.slice(-40).map((b) => '<tr><td>' + fmtDate(b.date) + '</td><td>' + b.sys + '/' + b.dia + '</td></tr>').join('') + '</table>');
  }
  if (state.symptoms.length) {
    out.push('<h2>' + window.t('report_symptoms') + '</h2><table><tr><th>Date</th><th></th></tr>' +
      state.symptoms.slice(-40).map((s) => '<tr><td>' + fmtDate(s.date) + '</td><td>' +
        ((s.items || []).map(window.t).join(', ') || s.note || '') + '</td></tr>').join('') + '</table>');
  }
  if (state.appointments.length) {
    out.push('<h2>' + window.t('records_appt_title') + '</h2><table><tr><th>Date</th><th></th></tr>' +
      state.appointments.slice().sort((a, b) => a.when < b.when ? -1 : 1)
        .map((a) => '<tr><td>' + fmtDateTime(a.when) + '</td><td>' + a.title + '</td></tr>').join('') + '</table>');
  }
  if (!state.weights.length && !state.bp.length && !state.symptoms.length) {
    out.push('<p>' + window.t('log_empty') + '</p>');
  }
  out.push('<p class="disc">' + window.t('set_medical_note') + '</p>');
  out.push('<p class="disc">' + window.t('report_generated') + ' ' + fmtDateTime(new Date().toISOString()) + '</p>');
  $('#printArea').innerHTML = out.join('');
}

function downloadReport() {
  if (!isPremiumActive()) {
    $('#reportMsg').textContent = window.t('report_premium_only');
    showView('premium');
    return;
  }
  $('#reportMsg').textContent = '';
  buildDoctorReport();
  window.print();
}

/* ============ Reminders (medicine + appointment) + acknowledgement ============ */
const SNOOZE_MIN = 10, MISS_AFTER_MIN = 60;

function reminderOccurrence(r, ref) {
  if (!r.time) return null;
  const [h, m] = r.time.split(':').map(Number);
  if (r.repeat === 'daily') { const d = new Date(ref); d.setHours(h, m, 0, 0); return d; }
  if (r.repeat === 'once' && r.date) { const d = new Date(r.date + 'T00:00:00'); d.setHours(h, m, 0, 0); return d; }
  return null;
}

function renderReminders() {
  const list = $('#reminderList');
  if (list) {
    list.innerHTML = state.reminders.map((r) => {
      const when = r.repeat === 'daily' ? window.t('reminder_daily') + ' ' + r.time : fmtDateTime(r.date + 'T' + r.time);
      return '<div class="log-item"><span>' + (r.type === 'medicine' ? '💊' : '📅') + ' ' + r.title +
        (r.dose ? ' — ' + r.dose : '') + '<br><span class="tiny muted">' + when + '</span></span>' +
        '<button class="del" data-delrem="' + r.id + '">' + window.t('delete') + '</button></div>';
    }).join('') || '<p class="tiny muted">' + window.t('reminder_empty') + '</p>';
  }
  const statusKey = { taken: 'st_taken', skipped: 'st_skipped', missed: 'st_missed', pending: 'st_waiting' };
  const rl = $('#reminderLog');
  if (rl) {
    rl.innerHTML = state.reminderLog.slice(-30).reverse().map((l) =>
      '<div class="log-item"><span>' + l.title + '<br><span class="tiny muted">' + fmtDateTime(l.dueAt) + '</span></span>' +
      '<span class="status status-' + l.status + '">' + window.t(statusKey[l.status] || 'st_waiting') + '</span></div>'
    ).join('') || '<p class="tiny muted">' + window.t('reminder_empty') + '</p>';
  }
  const on = ('Notification' in window) && Notification.permission === 'granted';
  if ($('#notifStatus')) $('#notifStatus').textContent = on ? window.t('notif_on') : window.t('notif_off');
  if ($('#notifBtn')) $('#notifBtn').classList.toggle('hidden', on);
}

function addMedicineReminder() {
  const title = $('#remName').value.trim(), dose = $('#remDose').value.trim(), time = $('#remTime').value;
  if (!title || !time) return;
  state.reminders.push({ id: 'r' + Date.now(), type: 'medicine', title, dose, time, repeat: 'daily', enabled: true });
  $('#remName').value = ''; $('#remDose').value = ''; $('#remTime').value = '';
  persist(); renderReminders(); syncReminders();
}

function deleteReminder(id) {
  state.reminders = state.reminders.filter((r) => r.id !== id);
  persist(); renderReminders(); syncReminders();
}

function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const s = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function requestNotif() {
  if (!('Notification' in window)) return;
  try { await Notification.requestPermission(); } catch (e) {}
  await subscribePush();
  renderReminders();
}

/* Web Push subscribe — isse app BAND hone par bhi reminder aata hai */
async function subscribePush() {
  const cfg = window.APP_CONFIG || {};
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if (!cfg.VAPID_PUBLIC_KEY || !cfg.API_BASE) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8(cfg.VAPID_PUBLIC_KEY),
      });
    }
    await fetch(cfg.API_BASE.replace(/\/$/, '') + '/api/push-subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: getUserId(), subscription: sub.toJSON() }),
    });
    return true;
  } catch (e) { return false; }
}

function showNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, icon: 'icons/icon-192.png', tag: 'maasathi-rem' };
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(() => {});
  } else { try { new Notification(title, opts); } catch (e) {} }
}

/* alarm sequence — user ko dikhta hai, aur acknowledge karna padta hai */
let activeAlarmId = null;
function fireAlarm(entry, notify) {
  activeAlarmId = entry.id;
  const brand = $('#alarmBrand');
  if (brand) brand.textContent = (entry.type === 'appointment') ? window.t('notif_appt') : window.t('notif_med');
  $('#alarmTitle').textContent = entry.title;
  $('#alarmDose').textContent = entry.dose || '';
  $('#alarmTime').textContent = fmtDateTime(entry.dueAt);
  $('#alarmScreen').classList.remove('hidden');
  if (notify !== false) showNotification(window.t('alarm_due'), entry.title + (entry.dose ? ' — ' + entry.dose : ''));
}

function acknowledge(status) {
  const l = state.reminderLog.find((x) => x.id === activeAlarmId);
  if (l) {
    l.status = (status === 'snooze') ? 'pending' : status;
    l.actedAt = new Date().toISOString();
    if (status === 'snooze') l.snoozeUntil = new Date(Date.now() + SNOOZE_MIN * 60000).toISOString();
  }
  activeAlarmId = null;
  $('#alarmScreen').classList.add('hidden');
  persist(); renderReminders(); syncReminders();
}

function checkDue() {
  const now = new Date();
  state.reminders.filter((r) => r.enabled).forEach((r) => {
    const due = reminderOccurrence(r, now);
    if (!due) return;
    const age = now - due;
    if (age < 0 || age > MISS_AFTER_MIN * 60000) return;   // future ya bahut purana
    const key = r.id + '|' + due.toISOString();
    let entry = state.reminderLog.find((l) => l.occKey === key);
    if (!entry) {
      entry = { id: 'l' + Date.now() + Math.random().toString(36).slice(2, 6), remId: r.id, type: r.type, title: r.title,
        dose: r.dose, occKey: key, dueAt: due.toISOString(), status: 'pending', actedAt: null, snoozeUntil: null };
      state.reminderLog.push(entry); persist();
    }
    if (entry.status !== 'pending') return;
    const ready = !entry.snoozeUntil || new Date(entry.snoozeUntil) <= now;
    // push aane ke baad app khule to bhi alarm dikhe (60 min tak), par late notification na jaaye
    if (ready && !activeAlarmId) fireAlarm(entry, age < 5 * 60000);
  });
}

/* app band thi to chhoote reminders ko "missed" mark karo (confirmation ke liye) */
function markMissedToday() {
  const now = new Date();
  state.reminders.filter((r) => r.enabled).forEach((r) => {
    const due = reminderOccurrence(r, now);
    if (!due) return;
    const key = r.id + '|' + due.toISOString();
    if (state.reminderLog.some((l) => l.occKey === key)) return;
    if (now - due > MISS_AFTER_MIN * 60000) {
      state.reminderLog.push({ id: 'l' + Date.now() + Math.random().toString(36).slice(2, 6), remId: r.id, type: r.type, title: r.title,
        dose: r.dose, occKey: key, dueAt: due.toISOString(), status: 'missed', actedAt: null, snoozeUntil: null });
    }
  });
  state.reminderLog.forEach((l) => {
    if (l.status === 'pending' && !l.snoozeUntil && (now - new Date(l.dueAt)) > MISS_AFTER_MIN * 60000) l.status = 'missed';
  });
  persist();
}

function startReminderEngine() {
  markMissedToday(); renderReminders(); checkDue();
  setInterval(() => { checkDue(); renderReminders(); }, 30000);
  syncReminders();
}

/* backend ko reminders bhejo (web push ke liye — optional) */
async function syncReminders() {
  const cfg = window.APP_CONFIG || {};
  if (!navigator.onLine || !cfg.API_BASE) return;
  try {
    const baseUrl = cfg.API_BASE.replace(/\/$/, '');
    await fetch(baseUrl + '/api/reminders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: getUserId(), reminders: state.reminders,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: window.CURRENT_LANG }),
    });
  } catch (e) { /* offline */ }
}
window.syncReminders = syncReminders;

function loadCashfreeSDK() {
  return new Promise((resolve, reject) => {
    if (window.Cashfree) return resolve();
    const s = document.createElement('script');
    s.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('sdk_load_failed'));
    document.head.appendChild(s);
  });
}

/* Play Billing available? (TWA ke andar hi hota hai) */
function playBillingAvailable() {
  const cfg = window.APP_CONFIG || {};
  if (cfg.BILLING === 'cashfree') return false;
  if (!('getDigitalGoodsService' in window)) return false;
  if (cfg.BILLING === 'play') return true;
  return /^android-app:\/\//i.test(document.referrer);   // auto: TWA detect
}

async function startPayment() {
  const cfg = window.APP_CONFIG || {};
  const plan = (document.querySelector('input[name=plan]:checked') || {}).value || 'monthly';
  if (!navigator.onLine) { setPremiumMsg(window.t('premium_offline')); return; }
  if (!cfg.API_BASE) { setPremiumMsg('Backend not set: fill API_BASE in js/config.js'); return; }
  setPremiumMsg(window.t('premium_processing'));
  try {
    if (playBillingAvailable()) await payWithPlay(plan);
    else await payWithCashfree(plan);
  } catch (e) {
    setPremiumMsg(window.t('premium_failed'));
  }
}

async function payWithCashfree(plan) {
  const cfg = window.APP_CONFIG || {};
  const baseUrl = cfg.API_BASE.replace(/\/$/, '');
  const r = await fetch(baseUrl + '/api/create-order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, user_id: getUserId() }),
  });
  const d = await r.json();
  if (!d.payment_session_id) throw new Error(d.error || 'order_failed');
  await loadCashfreeSDK();
  const cashfree = window.Cashfree({ mode: cfg.CASHFREE_MODE || 'sandbox' });
  await cashfree.checkout({ paymentSessionId: d.payment_session_id, redirectTarget: '_modal' });
  await verifyOrder(d.order_id);
}

/* Google Play Billing — Digital Goods API + Payment Request (TWA ke andar) */
async function payWithPlay(plan) {
  const cfg = window.APP_CONFIG || {};
  const sku = (cfg.PLAY_SKUS || {})[plan];
  if (!sku) throw new Error('no_sku');
  const service = await window.getDigitalGoodsService('https://play.google.com/billing');
  let price = null;
  try { const det = await service.getDetails([sku]); price = det && det[0] && det[0].price; } catch (e) {}
  const request = new PaymentRequest(
    [{ supportedMethods: 'https://play.google.com/billing', data: { sku } }],
    { total: { label: 'Maasathi Premium', amount: {
        currency: (price && price.currency) || 'INR', value: (price && price.value) || '99' } } }
  );
  const response = await request.show();
  const token = response.details && response.details.purchaseToken;
  await response.complete('success');
  if (!token) throw new Error('no_token');
  const r = await fetch(cfg.API_BASE.replace(/\/$/, '') + '/api/play-verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: getUserId(), plan, sku, purchase_token: token }),
  });
  const d = await r.json();
  if (d.premium) {
    state.premium = { active: true, plan: d.plan || plan, validTill: d.validTill || null,
      checkedAt: new Date().toISOString(), source: 'play' };
    await persist(); renderPremium(); setPremiumMsg(window.t('premium_success'));
  } else { setPremiumMsg(window.t('premium_failed')); }
}

/* Play se purani kharid wapas laao */
async function restorePlay() {
  const cfg = window.APP_CONFIG || {};
  if (!playBillingAvailable()) return false;
  try {
    const service = await window.getDigitalGoodsService('https://play.google.com/billing');
    const purchases = await service.listPurchases();
    const skus = Object.values(cfg.PLAY_SKUS || {});
    const p = (purchases || []).find((x) => skus.indexOf(x.itemId) !== -1);
    if (!p) return false;
    const plan = Object.keys(cfg.PLAY_SKUS || {}).find((k) => cfg.PLAY_SKUS[k] === p.itemId) || 'monthly';
    const r = await fetch(cfg.API_BASE.replace(/\/$/, '') + '/api/play-verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: getUserId(), plan, sku: p.itemId, purchase_token: p.purchaseToken }),
    });
    const d = await r.json();
    return !!d.premium;
  } catch (e) { return false; }
}

async function verifyOrder(orderId) {
  const cfg = window.APP_CONFIG || {};
  if (!orderId || !cfg.API_BASE) return;
  try {
    const baseUrl = cfg.API_BASE.replace(/\/$/, '');
    const r = await fetch(baseUrl + '/api/verify-order?order_id=' + encodeURIComponent(orderId) +
      '&user_id=' + encodeURIComponent(getUserId()));
    const d = await r.json();
    if (d.paid) {
      state.premium = {
        active: true, plan: d.plan || 'monthly', validTill: d.validTill || null,
        checkedAt: new Date().toISOString(), source: 'server',
      };
      await persist(); renderPremium(); setPremiumMsg(window.t('premium_success'));
    } else { setPremiumMsg(window.t('premium_failed')); }
  } catch (e) { setPremiumMsg(window.t('premium_failed')); }
}

/* Cashfree redirects back with ?order_id=... — verify on return. */
function maybeVerifyReturn() {
  const u = new URL(location.href);
  const oid = u.searchParams.get('order_id');
  if (oid) { verifyOrder(oid); u.searchParams.delete('order_id'); history.replaceState({}, '', u.pathname + u.search); }
}

/* ------------------------------ modal ------------------------------ */
function openQuick(kind) {
  const m = $('#modal'), body = $('#modalBody');
  if (kind === 'symptom' || kind === 'weight') { showView('track'); return; }
  if (kind === 'mood') {
    $('#modalTitle').textContent = window.t('mood_title');
    body.innerHTML = MOOD_KEYS.map(([k, e]) => `<button class="quick" data-mood="${k}">${e} ${window.t(k)}</button>`).join(' ');
    m.classList.remove('hidden');
    body.onclick = (e) => {
      const b = e.target.closest('[data-mood]'); if (!b) return;
      state.symptoms.push({ date: todayISO(), items: [b.dataset.mood], note: '' });
      persist(); renderLogList(); m.classList.add('hidden');
    };
  }
}

/* --------------------------- service worker ------------------------ */
function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}

boot();
