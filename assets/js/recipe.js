// Recipe detail page: the recipe itself plus the review thread.

import {
  sb, configured, $, esc, avgRating, starsHTML, totalTime, fmtDate,
  renderHeader, renderSetupNotice, getProfile, renderGoogleButton, toast,
} from './app.js';
import { scaleIngredient, formatQuantity, SCALE_OPTIONS } from './scale.js';
import {
  publicDb, RECIPE_FIELDS, withRetry, withTimeout, loadResilient,
  savedCopy, rememberRecipes, setOfflineBanner,
} from './data.js';

const root = $('#recipe-root');
$('#year').textContent = new Date().getFullYear();

const params = new URLSearchParams(location.search);
const slug = params.get('r');

// Current scale relative to the recipe as written. Set from the URL once the
// recipe (and so its base serving count) has loaded.
let scaleFactor = 1;
const MAX_SERVINGS = 100;

let recipe = null;
let reviews = [];
let profile = null;
let profileKnown = false;     // the sign-in check has finished (or given up)
let reviewsState = 'loading'; // 'loading' | 'ok' | 'error'
let currentSource = 'live';   // 'live', or a saved copy: 'browser' / 'snapshot'
let myReview = null;
let draftRating = 0;

// --- rendering -------------------------------------------------------

function notFound(message) {
  root.innerHTML = `
    <div class="empty" style="margin-top:4rem">
      <div class="empty-icon">🤷</div>
      <h3>Recipe not found</h3>
      <p>${esc(message || "That recipe either doesn't exist or isn't published yet.")}</p>
      <p><a href="index.html">← Back to all recipes</a></p>
    </div>`;
}

function asList(value) {
  if (Array.isArray(value)) return value.filter((x) => String(x).trim());
  return [];
}

function recipeHTML() {
  const rating = avgRating(recipe);
  const time = totalTime(recipe);
  const ingredients = asList(recipe.ingredients);
  const steps = asList(recipe.steps);

  const facts = [];
  if (recipe.prep_minutes) facts.push(['Prep', `${recipe.prep_minutes} min`]);
  if (recipe.cook_minutes) facts.push(['Cook', `${recipe.cook_minutes} min`]);
  if (time) facts.push(['Total', time]);
  if (recipe.servings) facts.push(['Serves', recipe.servings, 'serves']);

  return `
    <section class="recipe-head">
      ${!recipe.published ? '<span class="badge badge-draft">Draft — only you can see this</span>' : ''}
      ${recipe.category ? `<span class="badge">${esc(recipe.category)}</span>` : ''}
      <h1>${esc(recipe.title)}</h1>
      ${recipe.blurb ? `<p class="lede">${esc(recipe.blurb)}</p>` : ''}
      <div class="rating-summary">
        ${starsHTML(rating, 'stars-lg')}
        ${recipe.review_count
          ? `<span class="rating-value">${rating.toFixed(1)}</span>
             <span class="rating-count">from ${recipe.review_count} review${recipe.review_count === 1 ? '' : 's'}</span>`
          : '<span class="rating-count">Be the first to review this</span>'}
      </div>
    </section>

    ${recipe.hero_url
      ? `<img class="hero-photo" src="${esc(recipe.hero_url)}" alt="${esc(recipe.title)}" onerror="this.remove()">`
      : ''}

    ${facts.length ? `<div class="facts">${facts.map(([label, value, key]) => key === 'serves' ? `
      <div class="fact fact-serves">
        <label class="fact-label" for="servings-input">${esc(label)}</label>
        <div class="stepper">
          <button type="button" class="stepper-btn" data-step="-1" aria-label="Fewer servings">−</button>
          <input id="servings-input" class="stepper-input" type="number" inputmode="decimal"
            min="1" max="${MAX_SERVINGS}" step="1" value="${esc(value)}"
            aria-describedby="scale-note">
          <button type="button" class="stepper-btn" data-step="1" aria-label="More servings">+</button>
        </div>
      </div>` : `
      <div class="fact">
        <div class="fact-label">${esc(label)}</div>
        <div class="fact-value">${esc(value)}</div>
      </div>`).join('')}</div>` : ''}

    <div class="recipe-columns">
      <div>
        <div class="ingredients-head">
          <h2 class="section-title">Ingredients</h2>
          ${ingredients.length ? `
          <div class="scale-group" role="group" aria-label="Scale the recipe">
            ${SCALE_OPTIONS.map((o) => `
              <button type="button" class="scale-btn" data-factor="${o.factor}"
                aria-pressed="false" aria-label="${o.name}" title="${o.name}">${o.label}</button>`).join('')}
          </div>` : ''}
        </div>
        ${ingredients.length
          ? `<p class="scale-note" id="scale-note" hidden></p>
             <ul class="ingredients" id="ingredient-list"></ul>`
          : '<p class="muted">No ingredients listed.</p>'}
      </div>
      <div>
        <h2 class="section-title">Method</h2>
        ${steps.length
          ? `<ol class="steps">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`
          : '<p class="muted">No steps listed.</p>'}
      </div>
    </div>

    <section class="reviews-section">
      <h2 class="section-title">Reviews</h2>
      <div id="review-form-slot"></div>
      <div id="review-list" class="review-list"></div>
    </section>

    <a class="back-link" href="index.html">← All recipes</a>`;
}

/** The star picker + comment box, or a sign-in nudge. */
function renderReviewForm() {
  const slot = $('#review-form-slot');
  if (!slot) return;

  // Don't flash a sign-in prompt at someone who is signed in but whose
  // session check is still on its way back.
  if (!profileKnown) { slot.innerHTML = ''; return; }

  if (currentSource !== 'live') {
    slot.innerHTML = '<p class="muted">Posting reviews is paused while the recipe database is unavailable.</p>';
    return;
  }

  if (!profile) {
    slot.innerHTML = `
      <div class="signin-prompt">
        <p><strong>Made this?</strong> Sign in to leave a rating and tell everyone how it went.</p>
        <div class="gsi-slot" id="signin-btn"></div>
      </div>`;
    renderGoogleButton($('#signin-btn'));
    return;
  }

  if (!recipe.published) {
    slot.innerHTML = '<p class="muted">Reviews open once this recipe is published.</p>';
    return;
  }

  draftRating = myReview?.rating ?? 0;

  slot.innerHTML = `
    <div class="review-form">
      <h3>${myReview ? 'Update your review' : 'Leave a review'}</h3>
      <div class="field">
        <label for="rating-stars">Your rating</label>
        <div class="rating-input" id="rating-stars" role="group" aria-label="Rating out of 5">
          ${[1, 2, 3, 4, 5].map((n) => `
            <button type="button" data-value="${n}" aria-label="${n} star${n === 1 ? '' : 's'}">★</button>`).join('')}
          <span class="rating-label" id="rating-label"></span>
        </div>
      </div>
      <div class="field">
        <label for="review-body">Your notes <span class="field-hint" style="display:inline">(optional)</span></label>
        <textarea id="review-body" maxlength="4000"
          placeholder="How did it turn out? Anything you'd change?">${esc(myReview?.body ?? '')}</textarea>
      </div>
      <div class="form-actions">
        <button class="btn" id="submit-review">${myReview ? 'Save changes' : 'Post review'}</button>
        ${myReview ? '<button class="btn btn-danger" id="delete-review">Delete my review</button>' : ''}
      </div>
    </div>`;

  paintStars();
  $$stars().forEach((btn) => {
    btn.addEventListener('click', () => { draftRating = Number(btn.dataset.value); paintStars(); });
  });
  $('#submit-review').addEventListener('click', submitReview);
  $('#delete-review')?.addEventListener('click', deleteReview);
}

const $$stars = () => [...document.querySelectorAll('#rating-stars button')];

function paintStars() {
  $$stars().forEach((btn) => {
    btn.classList.toggle('on', Number(btn.dataset.value) <= draftRating);
  });
  const words = ['', 'Would not make again', 'Needs work', 'Solid', 'Really good', 'Making this weekly'];
  $('#rating-label').textContent = draftRating ? words[draftRating] : 'Tap a star';
}

function reviewHTML(review) {
  const who = review.profiles ?? {};
  const mine = profile && review.user_id === profile.id;
  const canDelete = mine || profile?.is_admin;

  return `
    <article class="review ${mine ? 'review-mine' : ''}">
      <div class="review-top">
        ${who.avatar_url
          ? `<img class="avatar" src="${esc(who.avatar_url)}" alt="" referrerpolicy="no-referrer">`
          : '<div class="avatar" aria-hidden="true"></div>'}
        <span class="review-who">${esc(who.display_name || 'A cook')}${mine ? ' (you)' : ''}</span>
        ${starsHTML(review.rating)}
        <span class="review-when">${esc(fmtDate(review.created_at))}</span>
      </div>
      ${review.body ? `<div class="review-body">${esc(review.body)}</div>` : ''}
      ${canDelete && !mine
        ? `<div class="review-actions">
             <button class="btn btn-danger btn-sm" data-remove="${esc(review.id)}">Remove</button>
           </div>`
        : ''}
    </article>`;
}

function renderReviews() {
  const list = $('#review-list');
  if (!list) return;

  if (reviewsState === 'loading') {
    list.innerHTML = '<p class="muted">Loading reviews…</p>';
    return;
  }
  if (reviewsState === 'error') {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">💬</div>
        <h3>Reviews can't be loaded right now</h3>
        <p>The recipe is all here. Reviews should be back shortly.</p>
      </div>`;
    return;
  }
  myReview = profile ? reviews.find((r) => r.user_id === profile.id) ?? null : null;
  const others = reviews.filter((r) => !(profile && r.user_id === profile.id));
  const ordered = myReview ? [myReview, ...others] : others;

  if (!ordered.length) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">💬</div>
        <h3>No reviews yet</h3>
        <p>Cook it and let us know how it went.</p>
      </div>`;
    return;
  }

  list.innerHTML = ordered.map(reviewHTML).join('');

  list.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => adminRemoveReview(btn.dataset.remove));
  });
}

// --- actions ---------------------------------------------------------

async function submitReview() {
  if (!draftRating) return toast('Pick a star rating first.', 'err');

  const btn = $('#submit-review');
  btn.disabled = true;

  const body = $('#review-body').value.trim() || null;

  // The unique (recipe_id, user_id) constraint makes this an upsert:
  // posting again simply edits your existing review.
  const { error } = await sb
    .from('reviews')
    .upsert(
      { recipe_id: recipe.id, user_id: profile.id, rating: draftRating, body },
      { onConflict: 'recipe_id,user_id' },
    );

  btn.disabled = false;

  if (error) return toast(error.message, 'err');

  toast(myReview ? 'Review updated. Thanks!' : 'Review posted. Thanks!', 'ok');
  await loadReviews();
  renderReviewForm();
  renderReviews();
  await refreshRatingSummary();
}

async function deleteReview() {
  if (!confirm('Delete your review of this recipe?')) return;

  const { error } = await sb.from('reviews').delete().eq('id', myReview.id);
  if (error) return toast(error.message, 'err');

  toast('Review deleted.', 'ok');
  await loadReviews();
  renderReviewForm();
  renderReviews();
  await refreshRatingSummary();
}

async function adminRemoveReview(id) {
  if (!confirm('Remove this review?')) return;

  const { error } = await sb.from('reviews').delete().eq('id', id);
  if (error) return toast(error.message, 'err');

  toast('Review removed.', 'ok');
  await loadReviews();
  renderReviews();
  await refreshRatingSummary();
}

/** Re-read the trigger-maintained counters and repaint the header stars. */
async function refreshRatingSummary() {
  const { data } = await sb
    .from('recipes')
    .select('review_count, rating_sum')
    .eq('id', recipe.id)
    .maybeSingle();

  if (!data) return;
  Object.assign(recipe, data);

  const rating = avgRating(recipe);
  const summary = $('.rating-summary');
  if (!summary) return;
  summary.innerHTML = recipe.review_count
    ? `${starsHTML(rating, 'stars-lg')}
       <span class="rating-value">${rating.toFixed(1)}</span>
       <span class="rating-count">from ${recipe.review_count} review${recipe.review_count === 1 ? '' : 's'}</span>`
    : `${starsHTML(0, 'stars-lg')}<span class="rating-count">Be the first to review this</span>`;
}

async function loadReviews() {
  if (!recipe) return;
  reviewsState = 'loading';
  try {
    const data = await withRetry((signal) => publicDb
      .from('reviews')
      .select('id, rating, body, created_at, user_id, profiles ( display_name, avatar_url )')
      .eq('recipe_id', recipe.id)
      .order('created_at', { ascending: false })
      .abortSignal(signal));
    reviews = data ?? [];
    reviewsState = 'ok';
  } catch (error) {
    console.warn('reviews load failed', error);
    reviews = [];
    reviewsState = 'error';
  }
  myReview = profile ? reviews.find((r) => r.user_id === profile.id) ?? null : null;
}

// --- boot ------------------------------------------------------------

/** Put a recipe on the page — first render, or a live copy replacing a saved one. */
function showRecipe(data, meta) {
  const firstRender = !recipe;
  recipe = data;
  currentSource = meta.source;
  document.title = `${recipe.title} — Filip Cooks`;
  if (meta.source === 'live') rememberRecipes([recipe]);
  setOfflineBanner(meta);

  if (firstRender) scaleFactor = initialScale();
  root.innerHTML = recipeHTML();
  wireScaling();
  renderIngredients();
  renderReviewForm();
  renderReviews();

  loadReviews().then(() => {
    renderReviews(); // works out which review is yours first
    // Don't wipe out a review someone has already started writing.
    const typing = $('#review-body')?.value.trim() || $('#review-form-slot')?.contains(document.activeElement);
    if (!typing) renderReviewForm();
  });
}

async function load() {
  if (!configured) return renderSetupNotice(root);
  if (!slug) return notFound('No recipe was specified.');

  renderHeader();
  root.innerHTML = '<p class="muted" style="padding:4rem 0">Loading…</p>';

  // Start the sign-in check now, but never let it hold up the recipe — and
  // don't make the review area wait on a slow database either.
  const profilePromise = withTimeout(getProfile(), 6000, null);
  profilePromise.then((p) => {
    profile = p;
    profileKnown = true;
    if (recipe) { renderReviews(); renderReviewForm(); }
  });

  let shown = false;
  let unreachable = false;
  try {
    await loadResilient({
      live: () => withRetry((signal) => publicDb
        .from('recipes')
        .select(RECIPE_FIELDS)
        .eq('slug', slug)
        .eq('published', true)
        .abortSignal(signal)
        .maybeSingle()),
      fallback: () => savedCopy((list) => list.find((r) => r.slug === slug) ?? null),
      render: (data, meta) => {
        if (!data) return; // not published, or no such recipe
        shown = true;
        showRecipe(data, meta);
      },
    });
  } catch (error) {
    unreachable = true;
    console.warn('recipe failed to load', error);
  }

  profile = await profilePromise;
  profileKnown = true;

  // Unpublished recipes are only visible to the admin, as a draft preview.
  if (!shown && profile?.is_admin) {
    try {
      const draft = await withRetry((signal) => sb
        .from('recipes').select(RECIPE_FIELDS).eq('slug', slug).abortSignal(signal).maybeSingle());
      if (draft) { shown = true; showRecipe(draft, { source: 'live' }); }
    } catch (error) {
      console.warn('draft lookup failed', error);
    }
  }

  if (!shown) {
    return notFound(unreachable
      ? "The recipe database isn't responding right now, and there's no saved copy of this recipe yet. Please try again in a few minutes."
      : undefined);
  }

  renderReviews();
  renderReviewForm();
}

// --- scaling ---------------------------------------------------------
//
// Visitors can type a serving count, step it with − / +, or use the ¼×–3×
// shortcuts. All three set one scale factor relative to the recipe as
// written, and the ingredient list follows it live.

/** The recipe's own serving count, or null if the author didn't give one. */
function baseServings() {
  const n = Number(recipe.servings);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const sameFactor = (a, b) => Math.abs(a - b) < 1e-9;

/** Restore a shared scale: ?s=12 (servings), or the older ?x=2 (multiplier). */
function initialScale() {
  const base = baseServings();
  const s = Number(params.get('s'));
  if (base && Number.isFinite(s) && s > 0 && s <= MAX_SERVINGS) return s / base;
  const x = Number(params.get('x'));
  if (SCALE_OPTIONS.some((o) => sameFactor(o.factor, x))) return x;
  return 1;
}

function wireScaling() {
  root.querySelectorAll('.scale-btn').forEach((btn) => {
    btn.addEventListener('click', () => setScale(Number(btn.dataset.factor)));
  });

  const input = $('#servings-input');
  const base = baseServings();
  if (!input || !base) return;

  // Update as they type, but only on a usable number — never fight the
  // cursor by rewriting the box mid-edit.
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v) && v > 0 && v <= MAX_SERVINGS) setScale(v / base, { fromInput: true });
  });

  // On blur / Enter, tidy up: clamp out-of-range values, restore empty ones.
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v) || v <= 0) return setScale(scaleFactor);
    setScale(Math.min(MAX_SERVINGS, v) / base);
  });

  root.querySelectorAll('.stepper-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const current = base * scaleFactor;
      // Step to the next whole serving, so 1½ goes down to 1 and up to 2.
      const next = Number(btn.dataset.step) > 0
        ? Math.min(MAX_SERVINGS, Math.floor(current + 1e-9) + 1)
        : Math.max(1, Math.ceil(current - 1e-9) - 1);
      setScale(next / base);
    });
  });
}

function renderIngredients({ fromInput = false } = {}) {
  const list = $('#ingredient-list');
  if (!list) return;

  list.innerHTML = asList(recipe.ingredients)
    .map((line) => `<li>${esc(scaleIngredient(line, scaleFactor))}</li>`)
    .join('');

  root.querySelectorAll('.scale-btn').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(sameFactor(Number(btn.dataset.factor), scaleFactor)));
  });

  const base = baseServings();
  const servings = base ? base * scaleFactor : null;

  const input = $('#servings-input');
  if (input && servings != null) {
    if (!fromInput) input.value = String(Math.round(servings * 100) / 100);
    const [minus, plus] = root.querySelectorAll('.stepper-btn');
    minus.disabled = servings <= 1;
    plus.disabled = servings >= MAX_SERVINGS;
  }

  // The method is prose ("add 3 cups stock, divided"), and rewriting numbers
  // inside sentences would also hit temperatures, times and pan sizes. So
  // it stays as written, and the reader is told so.
  const note = $('#scale-note');
  const scaled = !sameFactor(scaleFactor, 1);
  note.hidden = !scaled;
  if (!scaled) return;
  if (servings != null) {
    const n = formatQuantity(servings);
    note.textContent = `Ingredients adjusted for ${n} serving${n === '1' ? '' : 's'} ` +
      `(the recipe makes ${base}). Amounts mentioned in the method are for the original recipe.`;
  } else {
    const option = SCALE_OPTIONS.find((o) => sameFactor(o.factor, scaleFactor));
    note.textContent = `Ingredients shown at ${option ? option.label : `${formatQuantity(scaleFactor)}×`}. ` +
      'Amounts mentioned in the method are for the original recipe.';
  }
}

function setScale(factor, { fromInput = false } = {}) {
  scaleFactor = factor;
  renderIngredients({ fromInput });

  const url = new URL(location.href);
  url.searchParams.delete('x');
  url.searchParams.delete('s');
  if (!sameFactor(factor, 1)) {
    const base = baseServings();
    if (base) url.searchParams.set('s', String(Math.round(base * factor * 100) / 100));
    else url.searchParams.set('x', String(factor));
  }
  history.replaceState(null, '', url);
}

load();
