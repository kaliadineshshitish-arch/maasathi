/* =====================================================================
 * Maasathi — Cashfree backend + KV entitlement (Cloudflare Worker)
 * ---------------------------------------------------------------------
 * Premium status ab SERVER par rehta hai (Cloudflare KV), app ke andar
 * nahi. Isliye koi user ise bypass nahi kar sakta.
 *
 * Environment variables (Cloudflare dashboard / wrangler secret) — NOT here:
 *   CF_APP_ID       Cashfree App ID      (TEST_... / PROD_...)
 *   CF_SECRET_KEY   Cashfree Secret Key
 *   CF_ENV          "sandbox" | "production"
 *   ALLOWED_ORIGIN  your app origin, e.g. https://maasathi.pages.dev
 *
 * KV binding (wrangler.toml):
 *   [[kv_namespaces]]
 *   binding = "MAASATHI_KV"
 *   id = "<your-namespace-id>"
 *
 * Routes:
 *   POST /api/create-order   { plan, user_id }        -> { order_id, payment_session_id }
 *   GET  /api/verify-order?order_id=&user_id=         -> { paid, premium, validTill }
 *   GET  /api/entitlement?user_id=                    -> { premium, plan, validTill }
 *   POST /api/webhook                                 -> Cashfree webhook (source of truth)
 * ===================================================================== */

const PRICES   = { monthly: 99, yearly: 799 };        // must match js/config.js
const DURATION = { monthly: 30, yearly: 365 };        // days
const API_VERSION = '2025-01-01';

/* Push notification ke localized message (app apni bhasha `lang` bhejti hai) */
const NOTIF = {
  en: { med: 'Time to take your medicine', appt: 'You have an appointment today' },
  hi: { med: 'अपनी दवा लेने का समय', appt: 'आज आपकी एक अपॉइंटमेंट है' },
  bn: { med: 'ওষুধ খাওয়ার সময় হয়েছে', appt: 'আজ আপনার একটা অ্যাপয়েন্টমেন্ট আছে' },
  mr: { med: 'औषध घेण्याची वेळ झाली आहे', appt: 'आज तुमची अपॉइंटमेंट आहे' },
  ta: { med: 'உங்க மாத்திரையை எடுத்துக்க வேண்டிய நேரம்', appt: 'இன்னைக்கு உங்களுக்கு ஒரு அப்பாயிண்ட்மெண்ட் இருக்கு' },
  te: { med: 'మీ మందులు వేసుకోవడానికి సమయం', appt: 'ఈరోజు మీకు ఒక అపాయింట్‌మెంట్ ఉంది' },
  gu: { med: 'દવા લેવાનો સમય થઈ ગયો છે', appt: 'આજે તમારી એપોઇન્ટમેન્ટ છે' },
  kn: { med: 'ನಿಮ್ಮ ಔಷಧಿ ತೆಗೆದುಕೊಳ್ಳುವ ಸಮಯ', appt: 'ಇಂದು ನಿಮಗೆ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಇದೆ' },
  ml: { med: 'മരുന്ന് കഴിക്കാനുള്ള സമയമായി', appt: 'ഇന്ന് നിങ്ങൾക്ക് ഒരു അപ്പോയിന്റ്മെന്റ് ഉണ്ട്' },
  pa: { med: 'ਆਪਣੀ ਦਵਾਈ ਲੈਣ ਦਾ ਸਮਾਂ', appt: 'ਅੱਜ ਤੁਹਾਡੀ ਇੱਕ ਅਪਾਇੰਟਮੈਂਟ ਹੈ' },
  or: { med: 'ଔଷଧ ଖାଇବାର ସମୟ', appt: 'ଆଜି ଆପଣଙ୍କର ଗୋଟିଏ ଆପଏଣ୍ଟମେଣ୍ଟ ଅଛି' },
  ur: { med: 'اپنی دوا لینے کا وقت ہو گیا ہے', appt: 'آج آپ کی ایک اپائنٹمنٹ ہے' },
};

/* ------------------------------- helpers ------------------------------- */
const cors = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});
const json = (data, status, env) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  });
const cfBase = (env) => (env.CF_ENV === 'production'
  ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg');

/* user_id must look like a UUID / short token — basic abuse guard */
const validUser = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);

/* -------------------------------- KV ops ------------------------------- */
async function getEntitlement(env, userId) {
  if (!env.MAASATHI_KV) return null;
  const raw = await env.MAASATHI_KV.get('ent:' + userId, 'json');
  if (!raw) return null;
  const active = raw.validTill && new Date(raw.validTill).getTime() > Date.now();
  return { ...raw, premium: !!active };
}

async function grantEntitlement(env, userId, plan, orderId) {
  if (!env.MAASATHI_KV) return null;
  const existing = await getEntitlement(env, userId);
  // renew: agar abhi active hai to uske validTill se aage badhao
  const startMs = existing && existing.premium && existing.validTill
    ? new Date(existing.validTill).getTime() : Date.now();
  const validTill = new Date(startMs + DURATION[plan] * 86400000).toISOString();
  const record = {
    premium: true, plan, orderId,
    activatedAt: new Date().toISOString(), validTill,
  };
  await env.MAASATHI_KV.put('ent:' + userId, JSON.stringify(record));
  return record;
}

/* --------------------------------- main -------------------------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    try {
      if (url.pathname === '/api/create-order'   && request.method === 'POST') return await createOrder(request, env, url);
      if (url.pathname === '/api/verify-order'   && request.method === 'GET')  return await verifyOrder(url, env);
      if (url.pathname === '/api/entitlement'    && request.method === 'GET')  return await entitlement(url, env);
      if (url.pathname === '/api/reminders'      && request.method === 'POST') return await saveReminders(request, env);
      if (url.pathname === '/api/push-subscribe' && request.method === 'POST') return await savePushSub(request, env);
      if (url.pathname === '/api/play-verify'    && request.method === 'POST') return await playVerify(request, env);
      if (url.pathname === '/api/webhook'        && request.method === 'POST') return await webhook(request, env);
      if (url.pathname === '/') return json({ ok: true, service: 'maasathi-api', kv: !!env.MAASATHI_KV }, 200, env);
      return json({ error: 'not_found' }, 404, env);
    } catch (e) {
      return json({ error: 'server_error', message: String((e && e.message) || e) }, 500, env);
    }
  },

  /* Cron (har minute) — app band hone par bhi reminder bhejo */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};

/* ----------------------------- create order ---------------------------- */
async function createOrder(request, env, url) {
  if (!env.CF_APP_ID || !env.CF_SECRET_KEY) return json({ error: 'not_configured' }, 500, env);
  let body = {};
  try { body = await request.json(); } catch (e) {}

  const plan = body.plan === 'yearly' ? 'yearly' : 'monthly';
  const userId = body.user_id;
  if (!validUser(userId)) return json({ error: 'invalid_user_id' }, 400, env);

  const orderId = 'maasathi_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const origin = env.ALLOWED_ORIGIN || url.origin;

  const payload = {
    order_id: orderId,
    order_amount: PRICES[plan],           // price server se — client se nahi
    order_currency: 'INR',
    customer_details: {
      customer_id: userId,
      customer_phone: body.phone || '9999999999',
      customer_email: body.email || 'user@example.com',
    },
    order_meta: { return_url: origin + '/?order_id={order_id}' },
    order_note: 'Maasathi Premium - ' + plan,
  };

  const res = await fetch(cfBase(env) + '/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-version': API_VERSION,
      'x-client-id': env.CF_APP_ID,
      'x-client-secret': env.CF_SECRET_KEY,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) return json({ error: 'cashfree_error', detail: data }, 502, env);

  // map order -> user, taaki verify/webhook user ko dhoondh sake (7 din TTL)
  if (env.MAASATHI_KV) {
    await env.MAASATHI_KV.put('order:' + orderId,
      JSON.stringify({ user_id: userId, plan, createdAt: new Date().toISOString() }),
      { expirationTtl: 7 * 86400 });
  }
  return json({ order_id: data.order_id, payment_session_id: data.payment_session_id, plan }, 200, env);
}

/* ----------------------------- verify order ---------------------------- */
async function verifyOrder(url, env) {
  const orderId = url.searchParams.get('order_id');
  let userId = url.searchParams.get('user_id');
  if (!orderId) return json({ error: 'missing_order_id' }, 400, env);

  const res = await fetch(cfBase(env) + '/orders/' + encodeURIComponent(orderId), {
    headers: {
      'x-api-version': API_VERSION,
      'x-client-id': env.CF_APP_ID,
      'x-client-secret': env.CF_SECRET_KEY,
    },
  });
  const data = await res.json();
  if (!res.ok) return json({ error: 'cashfree_error', detail: data }, 502, env);

  let ent = null;
  const paid = data.order_status === 'PAID';
  if (paid && env.MAASATHI_KV) {
    // user_id: pehle KV mapping se, warna request param se
    const map = await env.MAASATHI_KV.get('order:' + orderId, 'json');
    if (map && map.user_id) userId = map.user_id;
    if (!validUser(userId)) return json({ error: 'invalid_user_id' }, 400, env);
    ent = await grantEntitlement(env, userId, (map && map.plan) || 'monthly', orderId);
  } else if (validUser(userId)) {
    ent = await getEntitlement(env, userId);
  }

  return json({
    order_id: orderId,
    status: data.order_status,
    paid,
    premium: !!(ent && ent.premium),
    plan: ent ? ent.plan : null,
    validTill: ent ? ent.validTill : null,
  }, 200, env);
}

/* ---------------------------- read entitlement ------------------------- */
async function entitlement(url, env) {
  const userId = url.searchParams.get('user_id');
  if (!validUser(userId)) return json({ error: 'invalid_user_id' }, 400, env);
  const ent = await getEntitlement(env, userId);
  return json({
    premium: !!(ent && ent.premium),
    plan: ent ? ent.plan : null,
    validTill: ent ? ent.validTill : null,
  }, 200, env);
}

/* ---------------------------- save reminders --------------------------- */
/* App apne reminders server par rakh deti hai — taaki aage web push (cron)
 * se app band hone par bhi reminder bheja ja sake. */
async function saveReminders(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const userId = body.user_id;
  if (!validUser(userId)) return json({ error: 'invalid_user_id' }, 400, env);
  if (!env.MAASATHI_KV) return json({ ok: true, stored: false }, 200, env);
  const rec = {
    reminders: Array.isArray(body.reminders) ? body.reminders.slice(0, 50) : [],
    tz: body.tz || 'Asia/Kolkata',
    lang: (typeof body.lang === 'string' && NOTIF[body.lang]) ? body.lang : 'en',
    updatedAt: new Date().toISOString(),
  };
  await env.MAASATHI_KV.put('rem:' + userId, JSON.stringify(rec));
  // Index key maintain karein — taaki cron KV list() (free tier 1,000/din) na kare
  try {
    const idx = (await env.MAASATHI_KV.get('remidx', 'json')) || [];
    if (Array.isArray(idx) && idx.indexOf(userId) < 0) {
      idx.push(userId);
      await env.MAASATHI_KV.put('remidx', JSON.stringify(idx.slice(-5000)));
    }
  } catch (e) {}
  return json({ ok: true, stored: true, count: rec.reminders.length }, 200, env);
}

/* --------------------------- push subscription ------------------------- */
async function savePushSub(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const userId = body.user_id;
  if (!validUser(userId)) return json({ error: 'invalid_user_id' }, 400, env);
  const sub = body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return json({ error: 'bad_subscription' }, 400, env);
  }
  if (!env.MAASATHI_KV) return json({ ok: true, stored: false }, 200, env);
  await env.MAASATHI_KV.put('sub:' + userId, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }));
  return json({ ok: true, stored: true }, 200, env);
}

/* ----------------------- Play Billing verification ---------------------- */
/* TWA mein Google Play Billing se kharida gaya subscription verify karta hai.
 * env: PLAY_SERVICE_ACCOUNT (service account JSON), PLAY_PACKAGE_NAME */
let _gToken = null, _gExp = 0;
async function getGoogleToken(env) {
  if (_gToken && Date.now() < _gExp) return _gToken;
  const sa = JSON.parse(env.PLAY_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64u(enc.encode(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })));
  const input = header + '.' + claims;
  const der = pemToDer(sa.private_key);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input)));
  const jwt = input + '.' + b64u(sig);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('google_token_failed');
  _gToken = data.access_token;
  _gExp = Date.now() + ((data.expires_in ? data.expires_in - 60 : 3000) * 1000);
  return _gToken;
}
function pemToDer(pem) {
  const b64 = String(pem)
    .replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function playVerify(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const userId = body.user_id;
  if (!validUser(userId)) return json({ error: 'invalid_user_id' }, 400, env);
  if (!env.PLAY_SERVICE_ACCOUNT || !env.PLAY_PACKAGE_NAME) return json({ error: 'play_not_configured' }, 500, env);
  const token = body.purchase_token, sku = body.sku;
  if (!token || !sku) return json({ error: 'missing_params' }, 400, env);

  const at = await getGoogleToken(env);
  const url = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
    encodeURIComponent(env.PLAY_PACKAGE_NAME) + '/purchases/subscriptions/' +
    encodeURIComponent(sku) + '/tokens/' + encodeURIComponent(token);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + at } });
  const data = await res.json();
  if (!res.ok) return json({ error: 'google_error', detail: data }, 502, env);

  const expiry = Number(data.expiryTimeMillis || 0);
  const valid = (data.paymentState === 1 || data.paymentState === 2) && expiry > Date.now();
  if (!valid) return json({ premium: false, status: 'not_active' }, 200, env);

  const plan = body.plan === 'yearly' ? 'yearly' : 'monthly';
  const ent = await grantEntitlement(env, userId, plan, 'play_' + token.slice(0, 12));
  if (ent && env.MAASATHI_KV) {
    ent.validTill = new Date(expiry).toISOString();   // Google ka asli expiry
    await env.MAASATHI_KV.put('ent:' + userId, JSON.stringify(ent));
  }
  return json({ premium: true, plan, validTill: new Date(expiry).toISOString() }, 200, env);
}

/* --------------------------- cron: send reminders ----------------------- */
async function runReminders(env) {
  if (!env.MAASATHI_KV || !env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return;
  const now = new Date();

  // KV list() free tier mein sirf 1,000/din — isliye index key se users nikaalte hain
  let idx = await env.MAASATHI_KV.get('remidx', 'json');
  if (!Array.isArray(idx)) {
    // pehli baar (ya purana data): ek hi list() chala kar index bana lein
    idx = [];
    let cursor;
    do {
      const page = await env.MAASATHI_KV.list({ prefix: 'rem:', cursor });
      for (const k of page.keys) idx.push(k.name.slice(4));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    try { await env.MAASATHI_KV.put('remidx', JSON.stringify(idx.slice(-5000))); } catch (e) {}
  }

  for (const userId of idx) {
    const rec = await env.MAASATHI_KV.get('rem:' + userId, 'json');
    if (!rec || !Array.isArray(rec.reminders) || !rec.reminders.length) continue;
    const tz = rec.tz || 'Asia/Kolkata';
    const N = NOTIF[rec.lang] || NOTIF.en;
    const hhmm = localHHMM(tz, now), date = localDate(tz, now);
    const due = rec.reminders.filter((r) => {
      if (!r || r.enabled === false || !r.time) return false;
      if (r.repeat === 'once') return r.date === date && r.time === hhmm;
      return r.time === hhmm;
    });
    if (!due.length) continue;
    const sub = await env.MAASATHI_KV.get('sub:' + userId, 'json');
    if (!sub) continue;
    for (const r of due) {
      const sentKey = 'sent:' + userId + '|' + r.id + '|' + date + '|' + r.time;
      if (await env.MAASATHI_KV.get(sentKey)) continue;
      const isAppt = r.type === 'appointment';
      const payload = {
        title: isAppt ? N.appt : N.med,
        body: (r.title || '') + (isAppt
          ? (r.time ? ' \u00b7 ' + r.time : '')
          : (r.dose ? ' \u2014 ' + r.dose : '')),
        tag: 'maasathi-' + r.id,
      };
      const res = await sendPush(env, sub, payload);
      if (res === 404 || res === 410) { await env.MAASATHI_KV.delete('sub:' + userId); break; }
      if (res >= 200 && res < 300) await env.MAASATHI_KV.put(sentKey, '1', { expirationTtl: 172800 });
    }
  }
}

function localHHMM(tz, d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return g('hour') + ':' + g('minute');
}
function localDate(tz, d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}

/* ------------------------------ web push ------------------------------- */
async function sendPush(env, sub, payload) {
  const jwt = await vapidJwt(env, sub.endpoint);
  const body = await encryptPush(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '3600',
      'Authorization': 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC_KEY,
    },
    body,
  });
  return res.status;
}

async function vapidJwt(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:support@example.com' };
  const enc = new TextEncoder();
  const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const input = b64u(enc.encode(JSON.stringify(header))) + '.' + b64u(enc.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input));
  return input + '.' + b64u(new Uint8Array(sig));
}

const u8 = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

/* RFC 8291 aes128gcm encryption */
async function encryptPush(plaintext, p256dhB64, authB64) {
  const enc = new TextEncoder();
  const uaPublic = u8(p256dhB64);            // 65 bytes
  const authSecret = u8(authB64);            // 16 bytes
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\x00'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\x00'), 12);

  const data = concat(enc.encode(plaintext), new Uint8Array([2]));  // padding delimiter
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, data));

  const rs = new Uint8Array([0, 0, 16, 0]);  // record size 4096
  const idlen = new Uint8Array([asPublic.length]);
  return concat(salt, rs, idlen, asPublic, ct);
}

/* -------------------------------- webhook ------------------------------ */
/* Cashfree webhook = source of truth. Browser band ho jaye to bhi premium
 * grant ho jaata hai. Signature: HMAC-SHA256(secret, timestamp + rawBody). */
async function webhook(request, env) {
  const raw = await request.text();
  const ts = request.headers.get('x-webhook-timestamp') || '';
  const sig = request.headers.get('x-webhook-signature') || '';
  const expected = await hmacSha256B64(env.CF_SECRET_KEY || '', ts + raw);
  if (sig !== expected) return json({ error: 'bad_signature' }, 401, env);

  const evt = JSON.parse(raw || '{}');
  const order = evt && evt.data && evt.data.order;
  if (order && order.order_id && env.MAASATHI_KV) {
    const map = await env.MAASATHI_KV.get('order:' + order.order_id, 'json');
    const userId = (map && map.user_id) || (order.customer_details && order.customer_details.customer_id);
    const ok = evt.type === 'PAYMENT_SUCCESS_WEBHOOK' || order.order_status === 'PAID';
    if (ok && validUser(userId)) {
      await grantEntitlement(env, userId, (map && map.plan) || 'monthly', order.order_id);
    }
  }
  return json({ received: true }, 200, env);
}

async function hmacSha256B64(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
