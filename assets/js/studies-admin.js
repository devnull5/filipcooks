// filipstudies admin: add classes, add practice tests, load questions.
// Admins only — enforced by RLS in supabase/02-filipstudies.sql, not here.

import {
  sb, configured, $, $$, esc, slugify,
  renderHeader, renderSetupNotice, getProfile, renderGoogleButton, toast,
} from './app.js';

const root = $('#studies-admin-root');
$('#year').textContent = new Date().getFullYear();

let profile = null;
let classes = [];
let current = null;   // the class being worked on, or null for the class list
let tests = [];

// The shape the JSON importer accepts. Shown on the page so it's never a
// guess, and used as the example in the textarea.
const SAMPLE = {
  title: 'Unit 1 — Cell Structure',
  intro: 'Organelles and what they do.',
  questions: [
    {
      prompt: 'Which organelle produces most of a cell’s ATP?',
      choices: ['Ribosome', 'Mitochondrion', 'Golgi body', 'Nucleus'],
      answer: 1,
      explanation: 'Oxidative phosphorylation happens on the inner mitochondrial membrane.',
    },
    {
      prompt: 'Define osmosis in one sentence.',
      kind: 'written',
      answer_text: 'The net movement of water across a semipermeable membrane down its water-potential gradient.',
    },
  ],
};

// --- gates -----------------------------------------------------------

function gateSignIn() {
  root.innerHTML = `
    <div class="gate">
      <div class="empty-icon">📚</div>
      <h1>filipstudies admin</h1>
      <p>Sign in with the account that owns this site.</p>
      <div class="gsi-slot" id="signin-btn"></div>
    </div>`;
  renderGoogleButton($('#signin-btn'));
}

function gateDenied() {
  root.innerHTML = `
    <div class="gate">
      <div class="empty-icon">🔒</div>
      <h1>Not for you</h1>
      <p>That account isn't an admin on this site.</p>
      <a class="btn" href="/">Go to the recipes</a>
    </div>`;
}

// --- data ------------------------------------------------------------

async function loadClasses() {
  const { data, error } = await sb
    .from('study_classes')
    .select('*')
    .order('sort_order')
    .order('created_at');
  if (error) { toast(error.message, 'err'); return []; }
  return data ?? [];
}

async function loadTests(classId) {
  const { data, error } = await sb
    .from('study_tests')
    .select('*, study_questions(id)')
    .eq('class_id', classId)
    .order('sort_order')
    .order('created_at');
  if (error) { toast(error.message, 'err'); return []; }
  return (data ?? []).map((t) => ({ ...t, question_count: (t.study_questions ?? []).length }));
}

// --- import ----------------------------------------------------------

/**
 * Turn pasted JSON into rows, or into a list of complaints.
 * Nothing is written until every question passes: a test that's half
 * imported is harder to notice than one that refused to import.
 */
function parseImport(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { errors: [`That isn't valid JSON: ${e.message}`] };
  }

  // Accept either a whole test object or a bare array of questions.
  const body = Array.isArray(raw) ? { questions: raw } : raw;
  const errors = [];

  if (!body || typeof body !== 'object') return { errors: ['Expected a JSON object or array.'] };
  const list = body.questions;
  if (!Array.isArray(list) || !list.length) {
    errors.push('No "questions" array, or it\'s empty.');
    return { errors };
  }

  const questions = list.map((q, i) => {
    const at = `Question ${i + 1}`;
    if (!q || typeof q !== 'object') { errors.push(`${at}: not an object.`); return null; }

    const prompt = String(q.prompt ?? '').trim();
    if (!prompt) errors.push(`${at}: missing "prompt".`);

    const kind = q.kind === 'written' ? 'written' : 'choice';
    const explanation = String(q.explanation ?? '').trim() || null;

    if (kind === 'written') {
      const answerText = String(q.answer_text ?? q.answer ?? '').trim();
      if (!answerText) errors.push(`${at}: written questions need "answer_text".`);
      return {
        position: i, kind, prompt, choices: [],
        answer_index: null, answer_text: answerText, explanation,
      };
    }

    const choices = Array.isArray(q.choices) ? q.choices.map((c) => String(c).trim()) : [];
    if (choices.length < 2) errors.push(`${at}: needs at least 2 "choices".`);
    if (choices.some((c) => !c)) errors.push(`${at}: has a blank choice.`);

    // "answer" may be an index (1) or the option's letter ("B") or its text.
    let idx = null;
    if (typeof q.answer === 'number') idx = q.answer;
    else if (typeof q.answer === 'string') {
      const s = q.answer.trim();
      if (/^[A-Za-z]$/.test(s)) idx = s.toUpperCase().charCodeAt(0) - 65;
      else {
        const found = choices.findIndex((c) => c.toLowerCase() === s.toLowerCase());
        idx = found >= 0 ? found : null;
      }
    }
    if (idx === null || !Number.isInteger(idx)) {
      errors.push(`${at}: "answer" must be the index, letter, or exact text of the right choice.`);
    } else if (idx < 0 || idx >= choices.length) {
      errors.push(`${at}: "answer" ${q.answer} is outside its ${choices.length} choices.`);
    }

    return {
      position: i, kind, prompt, choices,
      answer_index: idx, answer_text: null, explanation,
    };
  });

  if (errors.length) return { errors };
  return {
    errors: [],
    title: String(body.title ?? '').trim(),
    slug: String(body.slug ?? '').trim(),
    intro: String(body.intro ?? '').trim() || null,
    questions,
  };
}

async function runImport() {
  const text = $('#import-json').value.trim();
  const note = $('#import-note');
  if (!text) { note.innerHTML = '<span class="err-text">Paste some JSON first.</span>'; return; }

  const parsed = parseImport(text);
  if (parsed.errors.length) {
    note.innerHTML = `<span class="err-text">Nothing was imported:</span><ul>${
      parsed.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
    return;
  }

  const intoId = $('#import-target').value;
  const btn = $('#import-btn');
  btn.disabled = true;
  note.textContent = 'Importing…';

  try {
    let testId = intoId;

    if (!testId) {
      const title = parsed.title || 'Untitled test';
      const slug = slugify(parsed.slug || title);
      const { data, error } = await sb.from('study_tests').insert({
        class_id: current.id,
        slug,
        title,
        intro: parsed.intro,
        sort_order: tests.length,
      }).select().maybeSingle();
      if (error) throw error;
      testId = data.id;
    } else if ($('#import-replace').checked) {
      const { error } = await sb.from('study_questions').delete().eq('test_id', testId);
      if (error) throw error;
    }

    const rows = parsed.questions.map((q) => ({ ...q, test_id: testId }));
    const { error } = await sb.from('study_questions').insert(rows);
    if (error) throw error;

    toast(`Imported ${rows.length} question${rows.length === 1 ? '' : 's'}.`, 'ok');
    $('#import-json').value = '';
    await renderClass();
  } catch (e) {
    const hint = e.code === '23505'
      ? ' A test with that slug already exists in this class — change "slug" or import into it.'
      : '';
    note.innerHTML = `<span class="err-text">${esc(e.message || String(e))}${hint}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// --- views: classes --------------------------------------------------

async function renderClassList() {
  current = null;
  classes = await loadClasses();

  root.innerHTML = `
    <section class="studies-head">
      <span class="badge">ADMIN</span>
      <h1>filipstudies</h1>
      <p class="lede">Classes, and the practice tests inside them.</p>
    </section>

    <section class="panel">
      <h2 class="section-title">New class</h2>
      <div class="field-row">
        <div class="field">
          <label for="c-name">Name</label>
          <input id="c-name" type="text" placeholder="Cell Biology" autocomplete="off">
        </div>
        <div class="field">
          <label for="c-subtitle">Subtitle (optional)</label>
          <input id="c-subtitle" type="text" placeholder="BIOL 210, autumn term" autocomplete="off">
        </div>
      </div>
      <button class="btn" id="c-add">Add class</button>
    </section>

    <h2 class="section-title">Your classes</h2>
    ${classes.length ? `
      <div class="admin-list">
        ${classes.map((c) => `
          <div class="admin-row">
            <div>
              <strong>${esc(c.name)}</strong>
              ${c.archived ? '<span class="badge">archived</span>' : ''}
              ${c.subtitle ? `<div class="muted">${esc(c.subtitle)}</div>` : ''}
              <div class="muted mono">/studies.html?c=${esc(c.slug)}</div>
            </div>
            <div class="admin-row-actions">
              <button class="btn btn-ghost btn-sm" data-open="${esc(c.id)}">Open</button>
              <button class="btn btn-ghost btn-sm" data-rename="${esc(c.id)}">Rename</button>
              <button class="btn btn-ghost btn-sm" data-archive="${esc(c.id)}">
                ${c.archived ? 'Unarchive' : 'Archive'}</button>
              <button class="btn btn-ghost btn-sm" data-del-class="${esc(c.id)}">Delete</button>
            </div>
          </div>`).join('')}
      </div>` : '<p class="muted">None yet. Add the first one above.</p>'}

    <a class="back-link" href="/studies.html">← Back to filipstudies</a>`;

  $('#c-add').addEventListener('click', addClass);
  $('#c-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addClass(); });

  $$('[data-open]').forEach((b) => b.addEventListener('click', () => {
    const c = classes.find((x) => x.id === b.dataset.open);
    history.pushState({}, '', `?c=${encodeURIComponent(c.slug)}`);
    renderClass(c);
  }));
  $$('[data-rename]').forEach((b) => b.addEventListener('click', () => renameClass(b.dataset.rename)));
  $$('[data-archive]').forEach((b) => b.addEventListener('click', () => toggleArchive(b.dataset.archive)));
  $$('[data-del-class]').forEach((b) => b.addEventListener('click', () => deleteClass(b.dataset.delClass)));
}

async function addClass() {
  const name = $('#c-name').value.trim();
  if (!name) return toast('A class needs a name.', 'err');
  const { error } = await sb.from('study_classes').insert({
    name,
    slug: slugify(name),
    subtitle: $('#c-subtitle').value.trim() || null,
    sort_order: classes.length,
  });
  if (error) {
    return toast(error.code === '23505'
      ? `There's already a class with the URL "${slugify(name)}".`
      : error.message, 'err');
  }
  toast('Class added.', 'ok');
  renderClassList();
}

async function renameClass(id) {
  const c = classes.find((x) => x.id === id);
  const name = prompt('New name for this class:', c.name);
  if (name === null) return;
  if (!name.trim()) return toast('A class needs a name.', 'err');
  // Deliberately not changing the slug: the URL is already in use.
  const { error } = await sb.from('study_classes').update({ name: name.trim() }).eq('id', id);
  if (error) return toast(error.message, 'err');
  renderClassList();
}

async function toggleArchive(id) {
  const c = classes.find((x) => x.id === id);
  const { error } = await sb.from('study_classes')
    .update({ archived: !c.archived }).eq('id', id);
  if (error) return toast(error.message, 'err');
  renderClassList();
}

async function deleteClass(id) {
  const c = classes.find((x) => x.id === id);
  const list = await loadTests(id);
  const count = list.reduce((n, t) => n + t.question_count, 0);
  const warning = list.length
    ? `\n\nThis also deletes ${list.length} test${list.length === 1 ? '' : 's'}, `
      + `${count} question${count === 1 ? '' : 's'}, and every score recorded against them.`
    : '';
  if (!confirm(`Delete the class "${c.name}"?${warning}\n\nThis cannot be undone.`)) return;

  const { error } = await sb.from('study_classes').delete().eq('id', id);
  if (error) return toast(error.message, 'err');
  toast('Class deleted.', 'ok');
  renderClassList();
}

// --- views: one class ------------------------------------------------

async function renderClass(cls = current) {
  current = cls;
  tests = await loadTests(cls.id);

  root.innerHTML = `
    <section class="studies-head">
      <a class="back-link" href="#" id="to-classes" style="margin:0 0 .75rem">← All classes</a>
      <span class="badge">ADMIN</span>
      <h1>${esc(cls.name)}</h1>
      ${cls.subtitle ? `<p class="lede">${esc(cls.subtitle)}</p>` : ''}
    </section>

    <h2 class="section-title">Practice tests</h2>
    ${tests.length ? `
      <div class="admin-list">
        ${tests.map((t) => `
          <div class="admin-row">
            <div>
              <strong>${esc(t.title)}</strong>
              <span class="badge">${t.question_count} question${t.question_count === 1 ? '' : 's'}</span>
              ${t.intro ? `<div class="muted">${esc(t.intro)}</div>` : ''}
              <div class="muted mono">?c=${esc(cls.slug)}&amp;t=${esc(t.slug)}</div>
            </div>
            <div class="admin-row-actions">
              <a class="btn btn-ghost btn-sm"
                 href="/studies.html?c=${encodeURIComponent(cls.slug)}&t=${encodeURIComponent(t.slug)}">Take</a>
              <button class="btn btn-ghost btn-sm" data-clear="${esc(t.id)}">Clear questions</button>
              <button class="btn btn-ghost btn-sm" data-del-test="${esc(t.id)}">Delete</button>
            </div>
          </div>`).join('')}
      </div>` : '<p class="muted">No tests yet. Load one below.</p>'}

    <section class="panel">
      <h2 class="section-title">Load a test from JSON</h2>
      <p class="muted">Paste a test and its questions. Nothing is written unless
         every question checks out, so a bad paste can't half-import.</p>

      <div class="field">
        <label for="import-target">Import into</label>
        <select id="import-target">
          <option value="">— a new test in ${esc(cls.name)} —</option>
          ${tests.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}
        </select>
      </div>

      <label class="shuffle-toggle" id="replace-wrap" hidden>
        <input type="checkbox" id="import-replace">
        Replace the questions already in that test
      </label>

      <div class="field">
        <label for="import-json">JSON</label>
        <textarea id="import-json" rows="14" spellcheck="false"
          placeholder="${esc(JSON.stringify(SAMPLE, null, 2))}"></textarea>
        <p class="field-hint">
          <code>answer</code> can be the index (<code>1</code>), the letter
          (<code>"B"</code>), or the exact text of the right choice. Add
          <code>"kind": "written"</code> with an <code>answer_text</code> for a
          free-response question.
        </p>
      </div>

      <button class="btn" id="import-btn">Import</button>
      <button class="btn btn-ghost" id="sample-btn">Fill in the example</button>
      <div class="import-note" id="import-note"></div>
    </section>`;

  $('#to-classes').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState({}, '', location.pathname);
    renderClassList();
  });

  const target = $('#import-target');
  const syncReplace = () => { $('#replace-wrap').hidden = !target.value; };
  target.addEventListener('change', syncReplace);
  syncReplace();

  $('#import-btn').addEventListener('click', runImport);
  $('#sample-btn').addEventListener('click', () => {
    $('#import-json').value = JSON.stringify(SAMPLE, null, 2);
  });

  $$('[data-clear]').forEach((b) => b.addEventListener('click', () => clearQuestions(b.dataset.clear)));
  $$('[data-del-test]').forEach((b) => b.addEventListener('click', () => deleteTest(b.dataset.delTest)));
}

async function clearQuestions(testId) {
  const t = tests.find((x) => x.id === testId);
  if (!t.question_count) return toast('That test has no questions.', 'info');
  if (!confirm(`Delete all ${t.question_count} questions from "${t.title}"?\n\n`
    + 'The test itself and its recorded scores stay.')) return;
  const { error } = await sb.from('study_questions').delete().eq('test_id', testId);
  if (error) return toast(error.message, 'err');
  toast('Questions cleared.', 'ok');
  renderClass();
}

async function deleteTest(testId) {
  const t = tests.find((x) => x.id === testId);
  if (!confirm(`Delete the test "${t.title}"?\n\nIts ${t.question_count} question(s) `
    + 'and every score recorded against it go too. This cannot be undone.')) return;
  const { error } = await sb.from('study_tests').delete().eq('id', testId);
  if (error) return toast(error.message, 'err');
  toast('Test deleted.', 'ok');
  renderClass();
}

// --- boot ------------------------------------------------------------

async function route() {
  const slug = new URLSearchParams(location.search).get('c');
  if (!classes.length) classes = await loadClasses();
  const cls = slug ? classes.find((c) => c.slug === slug) : null;
  if (cls) return renderClass(cls);
  return renderClassList();
}

window.addEventListener('popstate', route);

async function load() {
  if (!configured) return renderSetupNotice(root);

  renderHeader();
  root.innerHTML = '<p class="muted" style="padding:3rem 0">Loading…</p>';

  profile = await getProfile();
  if (!profile) return gateSignIn();
  if (!profile.is_admin) return gateDenied();

  route();
}

load();
