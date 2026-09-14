// ---------------------------------------------------------------------
// Recipe data that survives Supabase having a bad day.
//
// On 2026-09-14 the project's Auth service went unhealthy and API requests
// started failing (502/504) or taking 10-18s. Pages waited on sign-in before
// loading anything, so the whole site looked dead. This module keeps reading
// recipes independent of all that:
//
//  1. Public reads go through a client that never touches Auth, so a stuck
//     session refresh can't block them.
//  2. Every request has a timeout and quick retries — during that outage
//     roughly half of requests still succeeded, and failures came back fast.
//  3. If the database still can't be reached, the page shows the freshest
//     saved copy it has: this browser's copy from its last good load, or
//     data/recipes.json, a snapshot GitHub Actions refreshes every hour and
//     GitHub Pages serves with no dependency on Supabase at all.
// ---------------------------------------------------------------------

import { configured } from './app.js';

const cfg = window.FILIPCOOKS_CONFIG || {};

export const RECIPE_FIELDS =
  'id, slug, title, blurb, hero_url, category, ingredients, steps, prep_minutes, ' +
  'cook_minutes, servings, published, review_count, rating_sum, created_at, updated_at';

/** Reads published data only; no session, so Auth outages can't stall it. */
export const publicDb = configured
  ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: 'filipcooks-public-reads',
      },
    })
  : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a Supabase query with a per-attempt timeout and retries on anything
 * that looks transient. `makeQuery(signal)` must build a fresh query each time.
 */
export async function withRetry(makeQuery, { attempts = 3, timeoutMs = 5000 } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await Promise.race([
        makeQuery(controller.signal),
        // Belt and braces: resolve even if something upstream ignores abort.
        sleep(timeoutMs + 500).then(() => ({ error: new Error('Request timed out'), status: 0 })),
      ]);
      if (!result.error) return result.data;
      lastError = result.error;
      const status = result.status ?? 0;
      // A real 4xx (bad query, forbidden) won't fix itself by retrying.
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) break;
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts - 1) await sleep(400 * 2 ** i);
  }
  throw lastError ?? new Error('Request failed');
}

/** Resolve with `fallback` if `promise` takes longer than `ms`. */
export function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, sleep(ms).then(() => fallback)]);
}

// --- saved copies ----------------------------------------------------

const CACHE_KEY = 'filipcooks:published-recipes:v1';

function readLocalCopy() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return parsed && Array.isArray(parsed.recipes) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLocalCopy(recipes) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), recipes }));
  } catch {
    // Private mode or storage full: the site still works, just without this.
  }
}

/** Remember every published recipe we've successfully loaded. */
export function rememberRecipes(recipes, { replaceAll = false } = {}) {
  const published = recipes.filter((r) => r.published);
  if (replaceAll) return writeLocalCopy(published);
  const bySlug = new Map((readLocalCopy()?.recipes ?? []).map((r) => [r.slug, r]));
  for (const r of published) bySlug.set(r.slug, r);
  writeLocalCopy([...bySlug.values()]);
}

let snapshotPromise = null;
function readSnapshot() {
  snapshotPromise ??= fetch('data/recipes.json', { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => (json && Array.isArray(json.recipes) && json.generated_at ? json : null))
    .catch(() => null);
  return snapshotPromise;
}

/**
 * The freshest saved copy that contains what we need.
 * `pick(recipes)` returns the wanted data from a recipe list, or null.
 */
export async function savedCopy(pick) {
  const candidates = [];
  const local = readLocalCopy();
  if (local) {
    const data = pick(local.recipes);
    if (data) candidates.push({ data, asOf: local.savedAt, source: 'browser' });
  }
  const snap = await readSnapshot();
  if (snap) {
    const data = pick(snap.recipes);
    if (data) candidates.push({ data, asOf: snap.generated_at, source: 'snapshot' });
  }
  candidates.sort((a, b) => new Date(b.asOf) - new Date(a.asOf));
  return candidates[0] ?? null;
}

// --- loading with a fallback ----------------------------------------

/**
 * Load live data, but don't leave the visitor staring at a spinner.
 *
 * If live data isn't back within `graceMs`, render the saved copy instead,
 * then swap in live data if it arrives after all. If live loading fails
 * outright and there's no saved copy, the returned promise rejects.
 *
 * `render(data, { source, asOf })` — source is 'live', 'browser' or 'snapshot'.
 */
export async function loadResilient({ live, fallback, render, graceMs = 2500 }) {
  let liveDone = false;
  let liveSucceeded = false;

  // Shared, so the grace timer and a live failure can't both render it.
  let fallbackAttempt = null;
  const showFallback = () => (fallbackAttempt ??= (async () => {
    const saved = await fallback();
    if (!saved || liveSucceeded) return false;
    render(saved.data, { source: saved.source, asOf: saved.asOf });
    return true;
  })());

  const liveAttempt = live().then(
    (data) => { liveDone = true; liveSucceeded = true; render(data, { source: 'live' }); return { ok: true }; },
    (error) => { liveDone = true; return { ok: false, error }; },
  );

  // Slow database: show the saved copy after the grace period, keep waiting.
  sleep(graceMs).then(() => { if (!liveDone) showFallback(); });

  const outcome = await liveAttempt;
  if (outcome.ok) return;

  // Failed database: show the saved copy now, without sitting out the grace period.
  if (await showFallback()) return;
  throw outcome.error;
}

// --- banner ------------------------------------------------------------

function formatAsOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'earlier';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Show or clear the "saved copy" notice at the top of the page. */
export function setOfflineBanner(meta) {
  let banner = document.getElementById('offline-banner');
  if (!meta || meta.source === 'live') {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.className = 'offline-banner';
    banner.setAttribute('role', 'status');
    // Outside <main>: pages re-render <main> wholesale and would wipe it.
    document.querySelector('main')?.before(banner);
  }
  banner.textContent =
    `The recipe database isn't responding right now, so you're seeing a saved copy from ` +
    `${formatAsOf(meta.asOf)}. Sign-in and reviews may not work until it's back.`;
}
