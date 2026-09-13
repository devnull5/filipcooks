// Admin page: post, edit, publish and delete recipes. Admins only.
// The gate below is a convenience, not the security boundary — the real
// enforcement is the `public.is_admin()` RLS policies in schema.sql.

import {
  sb, configured, $, esc, slugify, avgRating,
  renderHeader, renderSetupNotice, getProfile, renderGoogleButton, toast,
} from './app.js';

const root = $('#admin-root');
$('#year').textContent = new Date().getFullYear();

let profile = null;
let recipes = [];
let editingId = null;   // null = composing a new recipe
let heroUrl = null;
let slugTouched = false;

// --- gates -----------------------------------------------------------

function gateSignIn() {
  root.innerHTML = `
    <div class="gate">
      <h1>Admin</h1>
      <p>Sign in with the Google account that owns this site.</p>
      <div class="gsi-slot" id="signin-btn"></div>
    </div>`;
  renderGoogleButton($('#signin-btn'));
}

function gateDenied() {
  root.innerHTML = `
    <div class="gate">
      <div class="empty-icon">🔒</div>
      <h1>Not your kitchen</h1>
      <p>You're signed in as <strong>${esc(profile.display_name || 'someone')}</strong>,
         but that account isn't an admin on this site.</p>
      <p class="muted" style="font-size:.88rem">
        If this should be you: run <code>supabase/make-me-admin.sql</code> in the
        Supabase SQL Editor, then reload.</p>
      <a class="btn btn-ghost" href="index.html">← Back to recipes</a>
    </div>`;
}

// --- shell -----------------------------------------------------------

function shell() {
  root.innerHTML = `
    <section class="hero" style="padding:3rem 0 2rem;text-align:left">
      <p class="eyebrow">Admin</p>
      <h1 id="form-heading">New recipe</h1>
    </section>

    <div class="admin-layout">
      <form class="admin-panel" id="recipe-form" novalidate>
        <div class="field">
          <label for="f-title">Title</label>
          <input type="text" id="f-title" required placeholder="Sunday ragù">
        </div>

        <div class="field">
          <label for="f-blurb">Short description</label>
          <textarea id="f-blurb" style="min-height:4.5rem"
            placeholder="One or two lines that show up on the recipe card."></textarea>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="f-category">Category</label>
            <input type="text" id="f-category" list="category-list" placeholder="Dinner">
            <datalist id="category-list"></datalist>
          </div>
          <div class="field">
            <label for="f-slug">URL slug</label>
            <input type="text" id="f-slug" placeholder="sunday-ragu">
            <div class="field-hint">filipcooks.com/recipe.html?r=<span id="slug-echo">…</span></div>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="f-prep">Prep (minutes)</label>
            <input type="number" id="f-prep" min="0" step="5" placeholder="15">
          </div>
          <div class="field">
            <label for="f-cook">Cook (minutes)</label>
            <input type="number" id="f-cook" min="0" step="5" placeholder="45">
          </div>
          <div class="field">
            <label for="f-servings">Serves</label>
            <input type="number" id="f-servings" min="1" step="1" placeholder="4">
          </div>
        </div>

        <div class="field">
          <label for="f-photo">Photo</label>
          <img class="photo-preview" id="photo-preview" alt="" hidden>
          <input type="file" id="f-photo" accept="image/*">
          <div class="field-hint" id="upload-status">JPG or PNG. Uploaded straight to Supabase storage.</div>
        </div>

        <div class="field">
          <label for="f-ingredients">Ingredients — one per line</label>
          <textarea id="f-ingredients" style="min-height:9rem"
            placeholder="500g beef mince&#10;2 tbsp olive oil&#10;1 onion, finely diced"></textarea>
        </div>

        <div class="field">
          <label for="f-steps">Method — one step per line</label>
          <textarea id="f-steps" style="min-height:11rem"
            placeholder="Brown the mince in a heavy pot over high heat.&#10;Lower the heat, add the onion, and sweat until soft."></textarea>
          <div class="field-hint">Blank lines are ignored, so you can space things out.</div>
        </div>

        <div class="field checkbox-row">
          <input type="checkbox" id="f-published">
          <label for="f-published">Published — visible to everyone</label>
        </div>

        <div class="form-actions">
          <button class="btn" id="save-btn" type="submit">Save recipe</button>
          <button class="btn btn-ghost" id="reset-btn" type="button">Clear form</button>
          <a class="btn btn-ghost" id="view-link" href="#" hidden>View page ↗</a>
        </div>
      </form>

      <aside>
        <h2 class="section-title">Your recipes</h2>
        <div class="admin-list" id="admin-list"></div>
      </aside>
    </div>`;

  $('#recipe-form').addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $('#reset-btn').addEventListener('click', () => resetForm());
  $('#f-photo').addEventListener('change', uploadPhoto);

  $('#f-title').addEventListener('input', () => {
    if (!slugTouched) {
      $('#f-slug').value = slugify($('#f-title').value);
      echoSlug();
    }
  });
  $('#f-slug').addEventListener('input', () => { slugTouched = true; echoSlug(); });
}

function echoSlug() {
  $('#slug-echo').textContent = $('#f-slug').value || '…';
}

// --- form state ------------------------------------------------------

function resetForm() {
  editingId = null;
  heroUrl = null;
  slugTouched = false;

  $('#recipe-form').reset();
  $('#form-heading').textContent = 'New recipe';
  $('#save-btn').textContent = 'Save recipe';
  $('#photo-preview').hidden = true;
  $('#photo-preview').removeAttribute('src');
  $('#upload-status').textContent = 'JPG or PNG. Uploaded straight to Supabase storage.';
  $('#view-link').hidden = true;
  echoSlug();
  renderList();
}

function fillForm(recipe) {
  editingId = recipe.id;
  heroUrl = recipe.hero_url ?? null;
  slugTouched = true;

  $('#f-title').value = recipe.title ?? '';
  $('#f-blurb').value = recipe.blurb ?? '';
  $('#f-category').value = recipe.category ?? '';
  $('#f-slug').value = recipe.slug ?? '';
  $('#f-prep').value = recipe.prep_minutes ?? '';
  $('#f-cook').value = recipe.cook_minutes ?? '';
  $('#f-servings').value = recipe.servings ?? '';
  $('#f-ingredients').value = (recipe.ingredients ?? []).join('\n');
  $('#f-steps').value = (recipe.steps ?? []).join('\n');
  $('#f-published').checked = !!recipe.published;

  const preview = $('#photo-preview');
  if (heroUrl) { preview.src = heroUrl; preview.hidden = false; }
  else { preview.hidden = true; preview.removeAttribute('src'); }

  $('#form-heading').textContent = `Editing: ${recipe.title}`;
  $('#save-btn').textContent = 'Save changes';

  const view = $('#view-link');
  view.href = `recipe.html?r=${encodeURIComponent(recipe.slug)}`;
  view.hidden = false;

  echoSlug();
  renderList();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const lines = (value) =>
  value.split('\n').map((l) => l.trim()).filter(Boolean);

const intOrNull = (value) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};

// --- photo upload ----------------------------------------------------

async function uploadPhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const status = $('#upload-status');

  if (!file.type.startsWith('image/')) {
    status.textContent = 'That file is not an image.';
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    status.textContent = 'That image is over 10 MB — please shrink it first.';
    return;
  }

  status.textContent = 'Uploading…';

  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${Date.now()}-${slugify(file.name.replace(/\.[^.]+$/, '')) || 'photo'}.${ext}`;

  const { error } = await sb.storage
    .from('recipe-images')
    .upload(path, file, { cacheControl: '31536000', upsert: false });

  if (error) {
    status.textContent = `Upload failed: ${error.message}`;
    return;
  }

  const { data } = sb.storage.from('recipe-images').getPublicUrl(path);
  heroUrl = data.publicUrl;

  const preview = $('#photo-preview');
  preview.src = heroUrl;
  preview.hidden = false;
  status.textContent = 'Uploaded.';
}

// --- save ------------------------------------------------------------

async function save() {
  const title = $('#f-title').value.trim();
  if (!title) return toast('A recipe needs a title.', 'err');

  let slug = slugify($('#f-slug').value || title);
  if (!slug) return toast('Could not build a URL slug from that title.', 'err');

  const payload = {
    title,
    slug,
    blurb: $('#f-blurb').value.trim() || null,
    category: $('#f-category').value.trim() || null,
    hero_url: heroUrl,
    prep_minutes: intOrNull($('#f-prep').value),
    cook_minutes: intOrNull($('#f-cook').value),
    servings: intOrNull($('#f-servings').value),
    ingredients: lines($('#f-ingredients').value),
    steps: lines($('#f-steps').value),
    published: $('#f-published').checked,
    author_id: profile.id,
  };

  const btn = $('#save-btn');
  btn.disabled = true;

  const result = editingId
    ? await sb.from('recipes').update(payload).eq('id', editingId).select().maybeSingle()
    : await sb.from('recipes').insert(payload).select().maybeSingle();

  btn.disabled = false;

  if (result.error) {
    const msg = result.error.code === '23505'
      ? `The slug "${slug}" is already used by another recipe — pick a different one.`
      : result.error.message;
    return toast(msg, 'err');
  }

  toast(editingId ? 'Recipe updated.' : 'Recipe saved.', 'ok');
  await loadRecipes();
  fillForm(result.data);
}

async function togglePublished(recipe) {
  const { error } = await sb
    .from('recipes')
    .update({ published: !recipe.published })
    .eq('id', recipe.id);

  if (error) return toast(error.message, 'err');

  toast(recipe.published ? 'Moved back to draft.' : 'Published — it’s live.', 'ok');
  await loadRecipes();
  if (editingId === recipe.id) $('#f-published').checked = !recipe.published;
  renderList();
}

async function remove(recipe) {
  if (!confirm(`Delete "${recipe.title}" for good? Its reviews go too.`)) return;

  const { error } = await sb.from('recipes').delete().eq('id', recipe.id);
  if (error) return toast(error.message, 'err');

  toast('Recipe deleted.', 'ok');
  if (editingId === recipe.id) resetForm();
  await loadRecipes();
  renderList();
}

// --- recipe list -----------------------------------------------------

function renderList() {
  const host = $('#admin-list');
  if (!host) return;

  if (!recipes.length) {
    host.innerHTML = '<p class="muted" style="font-size:.9rem">Nothing posted yet.</p>';
    return;
  }

  host.innerHTML = recipes.map((r) => {
    const rating = avgRating(r);
    return `
      <div class="admin-row ${editingId === r.id ? 'is-editing' : ''}">
        <div style="min-width:0;flex:1">
          <div class="admin-row-title">${esc(r.title)}</div>
          <div style="font-size:.78rem;color:var(--ink-faint)">
            ${r.published ? 'Live' : 'Draft'}
            ${r.review_count ? ` · ${rating.toFixed(1)}★ (${r.review_count})` : ' · no reviews'}
          </div>
        </div>
        <div class="admin-row-actions">
          <button class="btn btn-ghost btn-sm" data-edit="${esc(r.id)}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-toggle="${esc(r.id)}">${r.published ? 'Unpublish' : 'Publish'}</button>
          <button class="btn btn-danger btn-sm" data-delete="${esc(r.id)}">Delete</button>
        </div>
      </div>`;
  }).join('');

  const byId = (id) => recipes.find((r) => r.id === id);
  host.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => fillForm(byId(b.dataset.edit))));
  host.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => togglePublished(byId(b.dataset.toggle))));
  host.querySelectorAll('[data-delete]').forEach((b) =>
    b.addEventListener('click', () => remove(byId(b.dataset.delete))));
}

function renderCategoryOptions() {
  const cats = [...new Set(recipes.map((r) => r.category).filter(Boolean))].sort();
  const list = $('#category-list');
  if (list) list.innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join('');
}

async function loadRecipes() {
  const { data, error } = await sb
    .from('recipes')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) { toast(`Couldn't load recipes: ${error.message}`, 'err'); return; }

  recipes = data ?? [];
  renderCategoryOptions();
}

// --- boot ------------------------------------------------------------

async function load() {
  if (!configured) return renderSetupNotice(root);

  renderHeader();

  profile = await getProfile();
  if (!profile) return gateSignIn();
  if (!profile.is_admin) return gateDenied();

  shell();
  await loadRecipes();
  renderList();
  echoSlug();
}

load();
