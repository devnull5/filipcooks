// Home page: recipe grid with search, category filter and sort.

import {
  sb, configured, $, esc, avgRating, starsHTML, totalTime,
  renderHeader, renderSetupNotice, getProfile,
} from './app.js';
import {
  publicDb, RECIPE_FIELDS, withRetry, withTimeout, loadResilient,
  savedCopy, rememberRecipes, setOfflineBanner,
} from './data.js';

const grid = $('#recipe-grid');
const toolbar = $('#toolbar');
$('#year').textContent = new Date().getFullYear();

let recipes = [];     // published, from live data or a saved copy
let drafts = [];      // admin-only, merged in once we know who's signed in
let activeCategory = 'all';
let listenersWired = false;

const allRecipes = () => [...drafts, ...recipes.filter((r) => !drafts.some((d) => d.id === r.id))];

function skeletons(n = 6) {
  grid.innerHTML = Array.from({ length: n }, () => `
    <div class="skeleton-card">
      <div class="skeleton-block skeleton-photo"></div>
      <div class="skeleton-block skeleton-line" style="width:70%"></div>
      <div class="skeleton-block skeleton-line" style="width:90%"></div>
      <div class="skeleton-block skeleton-line" style="width:40%;margin-bottom:1.2rem"></div>
    </div>`).join('');
}

function cardHTML(recipe) {
  const rating = avgRating(recipe);
  const time = totalTime(recipe);

  const photo = recipe.hero_url
    ? `<img class="card-photo" src="${esc(recipe.hero_url)}" alt="${esc(recipe.title)}" loading="lazy"
         onerror="this.outerHTML='<div class=&quot;card-photo-empty&quot; aria-hidden=&quot;true&quot;>🍽️</div>'">`
    : `<div class="card-photo-empty" aria-hidden="true">🍽️</div>`;

  const badges = [];
  if (!recipe.published) badges.push('<span class="badge badge-draft">Draft</span>');
  if (recipe.category) badges.push(`<span class="badge">${esc(recipe.category)}</span>`);

  const meta = [];
  if (recipe.review_count) {
    meta.push(`${starsHTML(rating)} <span>${rating.toFixed(1)}</span>
               <span class="dot">${recipe.review_count} review${recipe.review_count === 1 ? '' : 's'}</span>`);
  } else {
    meta.push('<span>No reviews yet</span>');
  }
  if (time) meta.push(`<span class="dot">${esc(time)}</span>`);

  return `
    <article class="card">
      <a class="card-link" href="recipe.html?r=${encodeURIComponent(recipe.slug)}">
        ${photo}
        <div class="card-body">
          ${badges.length ? `<div class="card-badges">${badges.join('')}</div>` : ''}
          <h2 class="card-title">${esc(recipe.title)}</h2>
          ${recipe.blurb ? `<p class="card-blurb">${esc(recipe.blurb)}</p>` : ''}
          <div class="card-meta">${meta.join('')}</div>
        </div>
      </a>
    </article>`;
}

function renderChips() {
  const cats = [...new Set(allRecipes().map((r) => r.category).filter(Boolean))].sort();
  const host = $('#category-chips');
  if (!cats.length) { host.innerHTML = ''; return; }

  host.innerHTML = [
    `<button class="chip" data-cat="all" aria-pressed="${activeCategory === 'all'}">All</button>`,
    ...cats.map((c) =>
      `<button class="chip" data-cat="${esc(c)}" aria-pressed="${activeCategory === c}">${esc(c)}</button>`),
  ].join('');

  host.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      activeCategory = chip.dataset.cat;
      renderChips();
      render();
    });
  });
}

function render() {
  const query = $('#search').value.trim().toLowerCase();
  const sort = $('#sort').value;

  let rows = allRecipes();

  if (activeCategory !== 'all') {
    rows = rows.filter((r) => r.category === activeCategory);
  }

  if (query) {
    rows = rows.filter((r) => {
      const haystack = [
        r.title, r.blurb, r.category,
        ...(Array.isArray(r.ingredients) ? r.ingredients : []),
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  rows.sort((a, b) => {
    switch (sort) {
      case 'top':      return avgRating(b) - avgRating(a) || b.review_count - a.review_count;
      case 'reviewed': return b.review_count - a.review_count;
      case 'quick': {
        const at = (a.prep_minutes || 0) + (a.cook_minutes || 0) || Infinity;
        const bt = (b.prep_minutes || 0) + (b.cook_minutes || 0) || Infinity;
        return at - bt;
      }
      default: return new Date(b.created_at) - new Date(a.created_at);
    }
  });

  if (!rows.length) {
    grid.innerHTML = `
      <div class="empty" style="grid-column:1/-1">
        <div class="empty-icon">🔍</div>
        <h3>Nothing matches that</h3>
        <p>Try a different search or clear the filters.</p>
      </div>`;
    return;
  }

  grid.innerHTML = rows.map(cardHTML).join('');
}

function showRecipes() {
  if (!allRecipes().length) {
    toolbar.hidden = true;
    grid.innerHTML = `
      <div class="empty" style="grid-column:1/-1">
        <div class="empty-icon">🥘</div>
        <h3>No recipes yet</h3>
        <p>Filip hasn't posted anything yet. Check back soon.</p>
      </div>`;
    return;
  }

  toolbar.hidden = false;
  renderChips();
  render();

  if (!listenersWired) {
    listenersWired = true;
    $('#search').addEventListener('input', render);
    $('#sort').addEventListener('change', render);
  }
}

async function load() {
  if (!configured) {
    renderSetupNotice($('#setup-slot'));
    grid.innerHTML = '';
    return;
  }

  renderHeader();
  skeletons();

  try {
    await loadResilient({
      live: () => withRetry((signal) => publicDb
        .from('recipes')
        .select(RECIPE_FIELDS)
        .eq('published', true)
        .order('created_at', { ascending: false })
        .abortSignal(signal)),
      fallback: () => savedCopy((list) => (list.length ? list : null)),
      render: (rows, meta) => {
        recipes = rows ?? [];
        if (meta.source === 'live') rememberRecipes(recipes, { replaceAll: true });
        setOfflineBanner(meta);
        showRecipes();
      },
    });
  } catch (error) {
    grid.innerHTML = `
      <div class="empty" style="grid-column:1/-1">
        <div class="empty-icon">⚠️</div>
        <h3>Couldn't load recipes</h3>
        <p>The recipe database isn't responding. Please try again in a few minutes.</p>
      </div>`;
    console.warn('recipes failed to load', error);
  }

  // Drafts are only for the admin. Look them up separately so a slow or
  // failing sign-in check never holds up the recipes everyone else sees.
  const profile = await withTimeout(getProfile(), 6000, null);
  if (!profile?.is_admin) return;
  try {
    const rows = await withRetry((signal) => sb
      .from('recipes').select(RECIPE_FIELDS).eq('published', false)
      .order('created_at', { ascending: false }).abortSignal(signal));
    drafts = rows ?? [];
    if (drafts.length) showRecipes();
  } catch (error) {
    console.warn('drafts failed to load', error);
  }
}

load();
