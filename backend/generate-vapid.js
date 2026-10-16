/* =====================================================================
 * VAPID keys banayein — ek hi baar chalana hai.
 *   node generate-vapid.js
 *
 * Jo output mile, use Cloudflare Worker ke secrets mein daalein:
 *   wrangler secret put VAPID_PUBLIC_KEY
 *   wrangler secret put VAPID_PRIVATE_JWK
 *   wrangler secret put VAPID_SUBJECT        (jaise mailto:you@example.com)
 *
 * Aur VAPID_PUBLIC_KEY (public wali) ko js/config.js mein bhi paste karein.
 * PRIVATE key kabhi frontend mein na daalein.
 * ===================================================================== */
const { webcrypto } = require('crypto');

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

(async () => {
  const kp = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  );
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));

  console.log('\n================ VAPID KEYS ================\n');
  console.log('VAPID_PUBLIC_KEY=' + b64u(raw));
  console.log('');
  console.log('VAPID_PRIVATE_JWK=' + JSON.stringify(jwk));
  console.log('\n============================================\n');
  console.log('Ab yeh karein:');
  console.log('  1) wrangler secret put VAPID_PUBLIC_KEY      <- public key paste');
  console.log('  2) wrangler secret put VAPID_PRIVATE_JWK     <- private JWK paste');
  console.log('  3) wrangler secret put VAPID_SUBJECT         <- mailto:you@example.com');
  console.log('  4) js/config.js mein VAPID_PUBLIC_KEY daalein (public wali)\n');
})();
