// filipstudies: take practice tests and keep the scores. Admins only.
//
// The gate below is a convenience, not the security boundary — the real
// enforcement is the admin-only RLS policies in supabase/02-filipstudies.sql.
// Signed out, every query here comes back empty no matter what the page does.

import {
  sb, configured, $, $$, esc, fmtDate,
  renderHeader, renderSetupNotice, getProfile, renderGoogleButton, toast,
} from './app.js';

const root = $('#studies-root');
$('#year').textContent = new Date().getFullYear();

let profile = null;
let classes = [];

// Set while a test is open.
let test = null;        // the study_tests row
let questions = [];     // in the order they're shown (possibly shuffled)
let picked = new Map(); // question id -> choice index, or 'right'/'wrong' when written
let revealed = new Set(); // written question ids whose model answer is showing
let submitted = null;   // the scored result once finished

// --- gates -----------------------------------------------------------

function gateSignIn() {
  root.innerHTML = `
    <div class="gate">
      <div class="empty-icon">📚</div>
      <h1>filipstudies</h1>
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
      <p>You're signed in as <strong>${esc(profile.display_name || 'someone')}</strong>,
         but this section is private.</p>
      <a class="btn" href="/">Go to the recipes</a>
    </div>`;
}

// --- routing ---------------------------------------------------------

const params = () => new URLSearchParams(location.search);

function go(search, { replace = false } = {}) {
  const url = search ? `${location.pathname}?${search}` : location.pathname;
  if (replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  render();
}

window.addEventListener('popstate', () => render());

// --- data ------------------------------------------------------------

async function loadClasses() {
  const { data, error } = await sb
    .from('study_classes')
    .select('*')
    .eq('archived', false)
    .order('sort_order')
    .order('created_at');

  if (error) { toast(error.message, 'err'); return []; }
  return data ?? [];
}

/** Tests in a class, each with its attempt history folded in. */
async function loadTests(classId) {
  const { data, error } = await sb
    .from('study_tests')
    .select('*, study_questions(id, kind), study_attempts(score, total, created_at)')
    .eq('class_id', classId)
    .order('sort_order')
    .order('created_at');

  if (error) { toast(error.message, 'err'); return []; }

  return (data ?? []).map((t) => {
    // Newest first, so [0] is the last attempt.
    const runs = [...(t.study_attempts ?? [])]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const best = runs.reduce(
      (acc, r) => (acc && acc.score / acc.total >= r.score / r.total ? acc : r), null);
    return {
      ...t,
      question_count: (t.study_questions ?? []).length,
      attempts: runs,
      last: runs[0] ?? null,
      best,
    };
  });
}

async function loadQuestions(testId) {
  const { data, error } = await sb
    .from('study_questions')
    .select('*')
    .eq('test_id', testId)
    .order('position')
    .order('created_at');

  if (error) { toast(error.message, 'err'); return []; }
  return data ?? [];
}

// --- helpers ---------------------------------------------------------

const pct = (score, total) => (total ? Math.round((score / total) * 100) : 0);

function scoreClass(score, total) {
  const p = pct(score, total);
  return p >= 80 ? 'score-good' : p >= 60 ? 'score-ok' : 'score-bad';
}

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A tiny bar chart of recent attempts, oldest to newest. */
function sparkHTML(attempts) {
  if (attempts.length < 2) return '';
  const recent = [...attempts].slice(0, 8).reverse();
  return `<span class="spark" aria-hidden="true">${recent.map((a) => {
    const h = Math.max(12, pct(a.score, a.total));
    return `<i style="height:${h}%"></i>`;
  }).join('')}</span>`;
}

function scoreLineHTML(t) {
  if (!t.last) {
    return t.question_count
      ? '<span class="muted">Not attempted yet</span>'
      : '<span class="muted">No questions yet</span>';
  }
  const bestBit = t.best && t.best !== t.last
    ? ` · best ${t.best.score}/${t.best.total} (${pct(t.best.score, t.best.total)}%)`
    : '';
  const n = t.attempts.length;
  return `<span class="${scoreClass(t.last.score, t.last.total)}">
            ${t.last.score}/${t.last.total} (${pct(t.last.score, t.last.total)}%)
          </span>
          <span class="muted">last attempt ${esc(fmtDate(t.last.created_at))}${bestBit}
            · ${n} attempt${n === 1 ? '' : 's'}</span>
          ${sparkHTML(t.attempts)}`;
}

// --- views: class list -----------------------------------------------

async function viewClasses() {
  root.innerHTML = '<p class="muted" style="padding:3rem 0">Loading…</p>';
  classes = await loadClasses();

  if (!classes.length) {
    root.innerHTML = `
      <section class="studies-head">
        <h1>filipstudies</h1>
        <p class="lede">Practice tests, one class at a time.</p>
      </section>
      <div class="gate">
        <div class="empty-icon">📘</div>
        <h2>No classes yet</h2>
        <p>Add the first one and it'll show up here.</p>
        <a class="btn" href="/studies-admin.html">Manage classes</a>
      </div>`;
    return;
  }

  root.innerHTML = `
    <section class="studies-head">
      <h1>filipstudies</h1>
      <p class="lede">Practice tests, one class at a time.</p>
    </section>
    <div class="class-list">
      ${classes.map((c) => `
        <a class="class-row" href="/studies.html?c=${encodeURIComponent(c.slug)}">
          <div>
            <h2 class="class-name">${esc(c.name)}</h2>
            ${c.subtitle ? `<p class="muted">${esc(c.subtitle)}</p>` : ''}
          </div>
          <span class="class-go" aria-hidden="true">→</span>
        </a>`).join('')}
    </div>
    <a class="back-link" href="/studies-admin.html">Manage classes and tests</a>`;
}

// --- views: one class ------------------------------------------------

async function viewClass(slug) {
  root.innerHTML = '<p class="muted" style="padding:3rem 0">Loading…</p>';

  if (!classes.length) classes = await loadClasses();
  const cls = classes.find((c) => c.slug === slug);
  if (!cls) {
    root.innerHTML = `
      <div class="gate">
        <div class="empty-icon">🤔</div>
        <h1>No such class</h1>
        <a class="btn" href="/studies.html">All classes</a>
      </div>`;
    return;
  }

  const tests = await loadTests(cls.id);

  root.innerHTML = `
    <section class="studies-head">
      <a class="back-link" href="/studies.html" style="margin:0 0 .75rem">← All classes</a>
      <h1>${esc(cls.name)}</h1>
      ${cls.subtitle ? `<p class="lede">${esc(cls.subtitle)}</p>` : ''}
    </section>

    ${tests.length ? `
    <div class="test-list">
      ${tests.map((t) => `
        <div class="test-row">
          <div class="test-main">
            <h2 class="test-title">${esc(t.title)}</h2>
            ${t.intro ? `<p class="muted test-intro">${esc(t.intro)}</p>` : ''}
            <p class="test-score">${scoreLineHTML(t)}</p>
          </div>
          <div class="test-actions">
            <span class="badge">${t.question_count} question${t.question_count === 1 ? '' : 's'}</span>
            ${t.question_count ? `
              <button class="btn btn-sm" data-start="${esc(t.slug)}">
                ${t.last ? 'Retake' : 'Start'}
              </button>
              <label class="shuffle-toggle">
                <input type="checkbox" data-shuffle="${esc(t.slug)}"> Shuffle
              </label>` : ''}
          </div>
        </div>`).join('')}
    </div>` : `
    <div class="gate">
      <div class="empty-icon">📝</div>
      <h2>No practice tests in this class yet</h2>
      <a class="btn" href="/studies-admin.html?c=${encodeURIComponent(cls.slug)}">Add one</a>
    </div>`}

    <a class="back-link" href="/studies-admin.html?c=${encodeURIComponent(cls.slug)}">Manage this class</a>`;

  $$('[data-start]').forEach((b) => b.addEventListener('click', () => {
    const shuffle = $(`[data-shuffle="${b.dataset.start}"]`)?.checked ? '&shuffle=1' : '';
    go(`c=${encodeURIComponent(slug)}&t=${encodeURIComponent(b.dataset.start)}${shuffle}`);
  }));
}

// --- views: taking a test --------------------------------------------

async function viewTest(classSlug, testSlug, shuffle) {
  root.innerHTML = '<p class="muted" style="padding:3rem 0">Loading…</p>';

  if (!classes.length) classes = await loadClasses();
  const cls = classes.find((c) => c.slug === classSlug);
  if (!cls) return go('');

  const { data, error } = await sb
    .from('study_tests')
    .select('*')
    .eq('class_id', cls.id)
    .eq('slug', testSlug)
    .maybeSingle();

  if (error) { toast(error.message, 'err'); return; }
  if (!data) {
    root.innerHTML = `
      <div class="gate">
        <div class="empty-icon">🤔</div>
        <h1>No such test</h1>
        <a class="btn" href="/studies.html?c=${encodeURIComponent(classSlug)}">Back to ${esc(cls.name)}</a>
      </div>`;
    return;
  }

  test = data;
  const loaded = await loadQuestions(test.id);
  questions = shuffle ? shuffled(loaded) : loaded;
  picked = new Map();
  revealed = new Set();
  submitted = null;

  if (!questions.length) {
    root.innerHTML = `
      <div class="gate">
        <div class="empty-icon">📝</div>
        <h1>${esc(test.title)}</h1>
        <p>This test has no questions yet.</p>
        <a class="btn" href="/studies-admin.html?c=${encodeURIComponent(classSlug)}">Add some</a>
      </div>`;
    return;
  }

  renderTest(cls);
}

function questionHTML(q, i) {
  const n = i + 1;
  const mine = picked.get(q.id);

  if (q.kind === 'written') {
    const open = revealed.has(q.id);
    return `
      <li class="question" id="q-${n}" data-qid="${esc(q.id)}">
        <p class="q-prompt"><span class="q-num">${n}.</span> ${esc(q.prompt)}</p>
        <textarea class="q-written" rows="4" data-written="${esc(q.id)}"
          placeholder="Write your answer, then reveal the model answer below."></textarea>
        ${open ? `
          <div class="q-model">
            <h3>Model answer</h3>
            <p>${esc(q.answer_text)}</p>
            ${q.explanation ? `<p class="muted">${esc(q.explanation)}</p>` : ''}
          </div>
          <div class="q-selfmark">
            <span class="muted">Mark yourself:</span>
            <button type="button" class="btn btn-sm ${mine === 'right' ? '' : 'btn-ghost'}"
              data-mark="right" data-qid="${esc(q.id)}">I got it right</button>
            <button type="button" class="btn btn-sm ${mine === 'wrong' ? '' : 'btn-ghost'}"
              data-mark="wrong" data-qid="${esc(q.id)}">I got it wrong</button>
          </div>` : `
          <button type="button" class="btn btn-ghost btn-sm" data-reveal="${esc(q.id)}">
            Reveal model answer
          </button>`}
      </li>`;
  }

  const choices = Array.isArray(q.choices) ? q.choices : [];
  return `
    <li class="question" id="q-${n}" data-qid="${esc(q.id)}">
      <p class="q-prompt"><span class="q-num">${n}.</span> ${esc(q.prompt)}</p>
      <div class="q-choices">
        ${choices.map((c, ci) => `
          <label class="q-choice${mine === ci ? ' is-picked' : ''}">
            <input type="radio" name="q-${esc(q.id)}" value="${ci}"
              ${mine === ci ? 'checked' : ''}>
            <span class="q-letter">${String.fromCharCode(65 + ci)}</span>
            <span>${esc(c)}</span>
          </label>`).join('')}
      </div>
    </li>`;
}

function answeredCount() {
  return questions.filter((q) => picked.has(q.id)).length;
}

function renderTest(cls) {
  root.innerHTML = `
    <section class="studies-head">
      <a class="back-link" href="/studies.html?c=${encodeURIComponent(cls.slug)}"
         style="margin:0 0 .75rem">← ${esc(cls.name)}</a>
      <h1>${esc(test.title)}</h1>
      ${test.intro ? `<p class="lede">${esc(test.intro)}</p>` : ''}
    </section>

    <div class="test-progress" id="progress" aria-live="polite"></div>

    <ol class="question-list">
      ${questions.map(questionHTML).join('')}
    </ol>

    <div class="test-submit">
      <button class="btn" id="finish-btn">Finish and score</button>
      <p class="muted" id="submit-note"></p>
    </div>`;

  updateProgress();
  wireTest(cls);
}

function updateProgress() {
  const done = answeredCount();
  const el = $('#progress');
  if (el) {
    el.innerHTML = `
      <div class="progress-bar"><i style="width:${(done / questions.length) * 100}%"></i></div>
      <span class="muted">${done} of ${questions.length} answered</span>`;
  }
}

// One delegated listener per concern, attached to the list rather than to
// each control. Questions get re-rendered in place as you reveal and mark
// them, and re-binding per element meant the finish button collected a new
// listener on every redraw and scored the test twice.
function wireTest(cls) {
  const list = $('.question-list');

  list.addEventListener('change', (e) => {
    const input = e.target.closest('.q-choices input[type="radio"]');
    if (!input) return;
    const li = input.closest('.question');
    picked.set(li.dataset.qid, Number(input.value));
    $$('.q-choice', li).forEach((l) => l.classList.remove('is-picked'));
    input.closest('.q-choice').classList.add('is-picked');
    updateProgress();
  });

  // Written: reveal the model answer, then mark yourself.
  list.addEventListener('click', (e) => {
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) {
      revealed.add(reveal.dataset.reveal);
      return redrawQuestion(reveal.dataset.reveal);
    }
    const mark = e.target.closest('[data-mark]');
    if (mark) {
      picked.set(mark.dataset.qid, mark.dataset.mark);
      redrawQuestion(mark.dataset.qid);
      updateProgress();
    }
  });

  $('#finish-btn').addEventListener('click', () => finish(cls));
}

/** Re-render one question in place, so typing in the others isn't lost. */
function redrawQuestion(qid) {
  const i = questions.findIndex((q) => q.id === qid);
  const li = $(`.question[data-qid="${qid}"]`);
  if (i < 0 || !li) return;
  const typed = $(`[data-written="${qid}"]`)?.value ?? '';
  li.outerHTML = questionHTML(questions[i], i);
  const box = $(`[data-written="${qid}"]`);
  if (box) box.value = typed;
}

// --- scoring ---------------------------------------------------------

function isRight(q) {
  const mine = picked.get(q.id);
  if (mine === undefined) return false;
  return q.kind === 'written' ? mine === 'right' : mine === q.answer_index;
}

async function finish(cls) {
  const missing = questions.length - answeredCount();
  if (missing) {
    const note = $('#submit-note');
    const firstUnanswered = questions.findIndex((q) => !picked.has(q.id));
    note.innerHTML = `${missing} question${missing === 1 ? ' is' : 's are'} unanswered.
      <button class="btn btn-ghost btn-sm" id="jump-btn">Go to it</button>
      <button class="btn btn-ghost btn-sm" id="anyway-btn">Score it anyway</button>`;
    $('#jump-btn').addEventListener('click', () =>
      $(`#q-${firstUnanswered + 1}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    $('#anyway-btn').addEventListener('click', () => score(cls));
    return;
  }
  score(cls);
}

async function score(cls) {
  const answers = questions.map((q) => ({
    q: q.id,
    picked: picked.has(q.id) ? picked.get(q.id) : null,
    right: isRight(q),
  }));
  const got = answers.filter((a) => a.right).length;
  submitted = { score: got, total: questions.length, answers };

  // Record it before rendering, but never lose the result to a failed write.
  const { error } = await sb.from('study_attempts').insert({
    test_id: test.id,
    user_id: profile.id,
    score: got,
    total: questions.length,
    answers,
  });
  if (error) toast(`Scored, but saving the attempt failed: ${error.message}`, 'err');

  renderResults(cls);
}

function reviewHTML(q, i) {
  const n = i + 1;
  const mine = picked.get(q.id);
  const right = isRight(q);
  const unanswered = mine === undefined;

  let yours;
  let correct = '';
  if (q.kind === 'written') {
    yours = unanswered ? 'Not marked' : (mine === 'right' ? 'Marked right' : 'Marked wrong');
    correct = `<p class="r-correct"><strong>Model answer:</strong> ${esc(q.answer_text)}</p>`;
  } else {
    const choices = Array.isArray(q.choices) ? q.choices : [];
    const letter = (idx) => `${String.fromCharCode(65 + idx)}. ${choices[idx] ?? ''}`;
    yours = unanswered ? 'Not answered' : letter(mine);
    if (!right) correct = `<p class="r-correct"><strong>Answer:</strong> ${esc(letter(q.answer_index))}</p>`;
  }

  return `
    <li class="review ${right ? 'is-right' : 'is-wrong'}">
      <p class="q-prompt"><span class="q-num">${n}.</span> ${esc(q.prompt)}</p>
      <p class="r-yours">
        <span class="r-mark">${right ? '✓' : '✗'}</span>
        <span>${esc(yours)}</span>
      </p>
      ${correct}
      ${q.explanation ? `<p class="r-why">${esc(q.explanation)}</p>` : ''}
    </li>`;
}

function renderResults(cls) {
  const { score: got, total } = submitted;
  const wrong = questions.filter((q) => !isRight(q));

  root.innerHTML = `
    <section class="studies-head">
      <a class="back-link" href="/studies.html?c=${encodeURIComponent(cls.slug)}"
         style="margin:0 0 .75rem">← ${esc(cls.name)}</a>
      <h1>${esc(test.title)}</h1>
    </section>

    <div class="result-card ${scoreClass(got, total)}">
      <div class="result-score">${got}<span>/${total}</span></div>
      <div class="result-pct">${pct(got, total)}%</div>
      <p class="muted">${wrong.length
        ? `${wrong.length} to go back over.`
        : 'Everything right. Nothing to review.'}</p>
      <div class="result-actions">
        <button class="btn" id="retake-btn">Retake</button>
        <button class="btn btn-ghost" id="retake-shuffle-btn">Retake shuffled</button>
        <a class="btn btn-ghost" href="/studies.html?c=${encodeURIComponent(cls.slug)}">Done</a>
      </div>
    </div>

    <h2 class="section-title">Review</h2>
    <ol class="review-list">
      ${questions.map(reviewHTML).join('')}
    </ol>`;

  const again = (shuffle) => go(
    `c=${encodeURIComponent(cls.slug)}&t=${encodeURIComponent(test.slug)}${shuffle ? '&shuffle=1' : ''}`);
  $('#retake-btn').addEventListener('click', () => again(false));
  $('#retake-shuffle-btn').addEventListener('click', () => again(true));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- boot ------------------------------------------------------------

function render() {
  const p = params();
  const c = p.get('c');
  const t = p.get('t');
  if (c && t) return viewTest(c, t, p.get('shuffle') === '1');
  if (c) return viewClass(c);
  return viewClasses();
}

async function load() {
  if (!configured) return renderSetupNotice(root);

  renderHeader();
  root.innerHTML = '<p class="muted" style="padding:3rem 0">Loading…</p>';

  profile = await getProfile();
  if (!profile) return gateSignIn();
  if (!profile.is_admin) return gateDenied();

  render();
}

load();
