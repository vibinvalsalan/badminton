// js/supabase-client.js
// Single shared Supabase client instance, imported by every page.
// SB_URL / SB_KEY are replaced at deploy time by your GitHub Actions workflow
// (see deploy-example.yml). Do not commit real values here.

const SB_URL = 'VITE_SUPABASE_URL';
const SB_KEY = 'VITE_SUPABASE_KEY';

// `supabase` is a global provided by the supabase-js CDN script tag,
// which must be loaded BEFORE this module in every page's <head> or <body>.
export const _supabase = supabase.createClient(SB_URL, SB_KEY);
