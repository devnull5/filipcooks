// ---------------------------------------------------------------------
// Shared layer: Supabase client, auth, header rendering, small helpers.
// Loaded by every page before that page's own script.
// ---------------------------------------------------------------------

const cfg = window.FILIPCOOKS_CONFIG || {};
const CONFIGURED =
  cfg.SUPABASE_URL &&
  cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.startsWith('PASTE_');

export const configured = CONFIGURED;

export const sb = CONFIGURED
  ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// --- tiny DOM helpers ------------------------------------------------

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape text destined for innerHTML. Everything user-authored goes through this. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

export function totalTime(recipe) {
  const total = (recipe.prep_minutes || 0) + (recipe.cook_minutes || 0);
  if (!total) return null;
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export function avgRating(recipe) {
  if (!recipe.review_count) return 0;
  return recipe.rating_sum / recipe.review_count;
}

/** Read-only star display. `value` may be fractional. */
export function starsHTML(value, extraClass = '') {
  const pct = Math.max(0, Math.min(100, (Number(value) / 5) * 100));
  return `<span class="stars ${extraClass}" role="img" aria-label="${
    value ? Number(value).toFixed(1) : 'No'
  } out of 5 stars">
    <span class="stars-empty">★★★★★</span>
    <span class="stars-full" style="width:${pct}%">★★★★★</span>
  </span>`;
}

/** Transient message banner. `kind` is 'ok' | 'err' | 'info'. */
export function toast(message, kind = 'info') {
  let host = $('#toast-host');
  if (!host) {
    host = el('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const node = el('div', `toast toast-${kind}`, message);
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 300);
  }, 4200);
}

// --- auth ------------------------------------------------------------

let cachedProfile = null;

export async function getSession() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session ?? null;
}

/** The signed-in user's profile row (incl. is_admin), or null. */
export async function getProfile({ refresh = false } = {}) {
  if (!sb) return null;
  if (cachedProfile && !refresh) return cachedProfile;

  const session = await getSession();
  if (!session) { cachedProfile = null; return null; }

  const { data, error } = await sb
    .from('profiles')
    .select('id, display_name, avatar_url, is_admin')
    .eq('id', session.user.id)
    .maybeSingle();

  if (error) { console.warn('profile load failed', error); return null; }

  // The signup trigger normally creates this row; if it somehow hasn't
  // landed yet, fall back to the identity data Google gave us.
  cachedProfile = data ?? {
    id: session.user.id,
    display_name:
      session.user.user_metadata?.full_name ||
      session.user.user_metadata?.name ||
      session.user.email?.split('@')[0],
    avatar_url: session.user.user_metadata?.avatar_url ?? null,
    is_admin: false,
  };
  return cachedProfile;
}

/**
 * Redirect-based sign-in. Google's prompt names the redirect target, which
 * is the Supabase project domain, so this is only the fallback for when the
 * Google Identity Services button below can't be used.
 */
export async function signInWithGoogle() {
  if (!sb) return toast('Supabase is not configured yet.', 'err');
  // Come back to whatever page the visitor was reading.
  const redirectTo = window.location.href.split('#')[0];
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  });
  if (error) toast(error.message, 'err');
}

// --- Google Identity Services ----------------------------------------
//
// Google's own button gets a signed ID token on this origin and we hand it
// to Supabase with signInWithIdToken. Nothing redirects through supabase.co,
// so Google's prompt says "filipcooks.com". Supabase checks the token's
// audience against the client ID(s) configured on its Google provider.

const GOOGLE_CLIENT_ID = cfg.GOOGLE_CLIENT_ID;

let gsiScript = null;          // promise for the loaded google.accounts.id API
let gsiInit = null;            // promise for an initialize() armed with a nonce
let rawNonce = null;           // the unhashed half of the current nonce
let fallbackToRedirect = false;
const googleButtons = new Map(); // container -> render options, for re-rendering

function loadGsiScript() {
  gsiScript ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google.accounts.id);
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (window.google?.accounts?.id
      ? resolve(window.google.accounts.id)
      : reject(new Error('Google sign-in script loaded without its API')));
    s.onerror = () => reject(new Error('Google sign-in script failed to load'));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('Google sign-in script timed out')), 8000);
  });
  return gsiScript;
}

/**
 * A nonce ties the ID token to this one sign-in attempt so a captured token
 * can't be replayed. Google gets the SHA-256 hex digest; Supabase gets the
 * raw value, hashes it itself, and compares against the token's claim.
 */
async function makeNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = btoa(String.fromCharCode(...bytes));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hashed = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { raw, hashed };
}

function ensureGsi() {
  gsiInit ??= (async () => {
    if (!GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is missing from config.js');
    const gsi = await loadGsiScript();
    const { raw, hashed } = await makeNonce();
    rawNonce = raw;
    gsi.initialize({
      client_id: GOOGLE_CLIENT_ID,
      nonce: hashed,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    return gsi;
  })();
  return gsiInit;
}

async function handleGoogleCredential(response) {
  const { error } = await sb.auth.signInWithIdToken({
    provider: 'google',
    token: response.credential,
    nonce: rawNonce,
  });

  if (error) {
    console.warn('ID-token sign-in failed, switching to redirect sign-in:', error);
    toast(`Sign-in didn't go through (${error.message}). Please try again.`, 'err');
    // Don't strand the visitor on a flow that just failed: swap every button
    // for the redirect flow, which is known to work.
    fallbackToRedirect = true;
    for (const [container, opts] of googleButtons) renderGoogleButton(container, opts);
    return;
  }

  cachedProfile = null;
  // Page-specific UI (review form, admin gate) depends on auth state, so
  // a reload is the simplest way to get every part of the page right.
  window.location.reload();
}

function renderRedirectButton(container) {
  container.innerHTML = '';
  const btn = el('button', 'btn btn-google', 'Sign in with Google');
  btn.addEventListener('click', signInWithGoogle);
  container.appendChild(btn);
}

/** Renders a "Sign in with Google" button into `container`. */
export async function renderGoogleButton(container, { size = 'large' } = {}) {
  if (!container) return;
  googleButtons.set(container, { size });
  if (!sb) return;

  if (fallbackToRedirect) return renderRedirectButton(container);

  try {
    const gsi = await ensureGsi();
    container.innerHTML = '';
    gsi.renderButton(container, {
      type: 'standard',
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'filled_black' : 'outline',
      size,
      text: 'signin_with',
      shape: 'pill',
      logo_alignment: 'left',
    });
  } catch (err) {
    // Blocked by an extension, offline, or misconfigured: still let people in.
    console.warn('Google Identity Services unavailable, using redirect sign-in:', err);
    fallbackToRedirect = true;
    renderRedirectButton(container);
  }
}

export async function signOut() {
  if (!sb) return;
  await sb.auth.signOut();
  window.google?.accounts?.id?.disableAutoSelect();
  cachedProfile = null;
  window.location.reload();
}

// --- header ----------------------------------------------------------

/** Fills in the auth corner of the site header on every page. */
export async function renderHeader() {
  const slot = $('#auth-slot');
  if (!slot) return;

  const profile = await getProfile();
  slot.innerHTML = '';

  if (!profile) {
    const holder = el('div', 'gsi-slot');
    slot.appendChild(holder);
    renderGoogleButton(holder, { size: 'medium' });
    return;
  }

  const wrap = el('div', 'user-chip');
  if (profile.avatar_url) {
    const img = el('img', 'avatar');
    img.src = profile.avatar_url;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    wrap.appendChild(img);
  }
  wrap.appendChild(el('span', 'user-name', profile.display_name || 'You'));

  // The admin page already links to itself in its nav; don't say it twice.
  if (profile.is_admin && !location.pathname.endsWith('admin.html')) {
    const link = el('a', 'btn btn-ghost btn-sm', 'Admin');
    link.href = '/admin.html';
    wrap.appendChild(link);
  }

  const out = el('button', 'btn btn-ghost btn-sm', 'Sign out');
  out.addEventListener('click', signOut);
  wrap.appendChild(out);

  slot.appendChild(wrap);
}

/** Big friendly warning shown when config.js still has placeholders. */
export function renderSetupNotice(container) {
  container.innerHTML = `
    <div class="setup-notice">
      <h2>Almost there — Supabase isn't connected yet</h2>
      <p>Open <code>assets/js/config.js</code> and paste in your Supabase
         <strong>Project URL</strong> and <strong>anon public key</strong>.
         You'll find both under <em>Project Settings → Data API</em> in the
         Supabase dashboard.</p>
      <p>Then make sure you've run <code>supabase/schema.sql</code> in the
         Supabase SQL Editor.</p>
    </div>`;
}

// Keep the header honest if auth state changes in another tab.
if (sb) {
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
      cachedProfile = null;
      renderHeader();
    }
  });
}
