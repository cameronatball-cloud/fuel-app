// Cloud settings. Leave the two Supabase values empty and the app runs entirely on the phone (no accounts, everything unlocked).
// Fill them in and the app gains sign-in, sync between devices, and the free/paid tiers.
export const CONFIG = {
  SUPABASE_URL: 'https://htdmdthyrehhvzflajuk.supabase.co',        // e.g. https://abcdefgh.supabase.co
  SUPABASE_ANON_KEY: 'sb_publishable_ghYVovG_UYVNy6fxnUFd8w_Au3Tryvm',   // the "anon public" key from Supabase → Project Settings → API
  CHECKOUT_URL: '',        // your Lemon Squeezy or Stripe payment link; leave empty to hide the Upgrade button
  APP_NAME: 'Fuel',
};
