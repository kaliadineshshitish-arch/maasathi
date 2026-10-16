/* =====================================================================
 * config.js — THE ONLY FILE YOU NEED TO EDIT AFTER DEPLOY
 * ---------------------------------------------------------------------
 * NEVER put API keys or secrets in this file. It runs in the browser.
 * Your Cashfree secret key goes in the BACKEND environment variables
 * (see backend/worker.js and DEPLOY.md).
 * ===================================================================== */
window.APP_CONFIG = {
  /* Your backend URL (Cloudflare Worker). Example:
     "https://maasathi-api.yourname.workers.dev"
     Leave "" until your backend is deployed — Premium tab will show a
     friendly message until then. */
  API_BASE: "",

  /* "sandbox" for testing, "production" when your Cashfree account is live. */
  CASHFREE_MODE: "sandbox",

  /* Web Push (reminders jab app band ho).
     `node backend/generate-vapid.js` chalayein aur PUBLIC key yahan paste karein.
     PRIVATE key sirf backend secret mein jaati hai — yahan NAHI. */
  VAPID_PUBLIC_KEY: "",

  /* Prices in rupees (integers). Change as you like. */
  PLANS: {
    monthly: { amount: 99,  key: "premium_plan_monthly" },
    yearly:  { amount: 799, key: "premium_plan_yearly"  }
  },

  /* Billing provider:
     "auto"     = TWA (Play app) mein Google Play Billing, warna Cashfree  <-- recommended
     "cashfree" = hamesha Cashfree (website/PWA)
     "play"     = hamesha Google Play Billing */
  BILLING: "auto",

  /* Google Play subscription IDs — Play Console mein banayein (exact same naam). */
  PLAY_SKUS: { monthly: "maasathi_monthly", yearly: "maasathi_yearly" },

  /* Shown in Settings and the privacy policy. */
  GRIEVANCE_EMAIL: "kaliadineshshitish@gmail.com",

  /* Support / contact shown to users. */
  SUPPORT_EMAIL: "kaliadineshshitish@gmail.com"
};
