// Recipe detail page: the recipe itself plus the review thread.

import {
  sb, configured, $, esc, avgRating, starsHTML, totalTime, fmtDate,
  renderHeader, renderSetupNotice, getProfile, renderGoogleButton, toast,
} from './app.js';

const root = $('#recipe-root');
$('#year').textContent = new Date().getFullYear();

const slug = new URLSearchParams(location.search).get('r');

let recipe = null;
let reviews = [];
let profile = null;
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
  if (recipe.servings) facts.push(['Serves', recipe.servings]);

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
      ? `<img class="hero-photo" src="${esc(recipe.hero_url)}" alt="${esc(recipe.title)}">`
      : ''}

    ${facts.length ? `<div class="facts">${facts.map(([label, value]) => `
      <div class="fact">
        <div class="fact-label">${esc(label)}</div>
        <div class="fact-value">${esc(value)}</div>
      </div>`).join('')}</div>` : ''}

    <div class="recipe-columns">
      <div>
        <h2 class="section-title">Ingredients</h2>
        ${ingredients.length
          ? `<ul class="ingredients">${ingredients.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
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
  const { data, error } = await sb
    .from('reviews')
    .select('id, rating, body, created_at, user_id, profiles ( display_name, avatar_url )')
    .eq('recipe_id', recipe.id)
    .order('created_at', { ascending: false });

  if (error) { console.warn('reviews load failed', error); reviews = []; myReview = null; return; }

  reviews = data ?? [];
  myReview = profile ? reviews.find((r) => r.user_id === profile.id) ?? null : null;
}

// --- boot ------------------------------------------------------------

async function load() {
  if (!configured) return renderSetupNotice(root);
  if (!slug) return notFound('No recipe was specified.');

  renderHeader();
  root.innerHTML = '<p class="muted" style="padding:4rem 0">Loading…</p>';

  profile = await getProfile();

  const { data, error } = await sb
    .from('recipes')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (error) return notFound(error.message);
  if (!data) return notFound();

  recipe = data;
  document.title = `${recipe.title} — Filip Cooks`;

  await loadReviews();

  root.innerHTML = recipeHTML();
  renderReviewForm();
  renderReviews();
}

load();
