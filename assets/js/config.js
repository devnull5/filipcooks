// ---------------------------------------------------------------------
// Supabase connection details.
//
// Both values below are SAFE to commit to a public repo. The anon key is a
// public client key — it only ever grants what the Row Level Security
// policies in supabase/schema.sql allow. The key you must never commit is
// the `service_role` key; it is not used anywhere in this site.
//
// Find these at: Supabase Dashboard → your project → Project Settings →
// Data API. Copy "Project URL" and the "anon public" key.
// ---------------------------------------------------------------------

window.FILIPCOOKS_CONFIG = {
  SUPABASE_URL: 'PASTE_YOUR_PROJECT_URL_HERE',
  SUPABASE_ANON_KEY: 'PASTE_YOUR_ANON_PUBLIC_KEY_HERE',
};
