// ---------------------------------------------------------------------
// Supabase connection details.
//
// Both values below are SAFE to commit to a public repo. The publishable
// key is a public client key — it only ever grants what the Row Level
// Security policies in supabase/schema.sql allow. The key you must never
// commit is the `sb_secret_...` one; it is not used anywhere in this site.
//
// Find these at: Supabase Dashboard → Project Settings → API Keys.
// ---------------------------------------------------------------------

window.FILIPCOOKS_CONFIG = {
  SUPABASE_URL: 'https://zxgnupoprrhhwyufcjkk.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_dzQJAqsFrcHiSHYd48hVcQ_xVJ2DTfF',

  // Google OAuth *client ID* (public — it appears in every sign-in request).
  // Must also be listed under Supabase → Auth → Providers → Google → Client IDs.
  // The client *secret* never goes here.
  GOOGLE_CLIENT_ID: '560087932543-j62865rhlf6b3roe0vq0k6h08a16u8t1.apps.googleusercontent.com',
};
