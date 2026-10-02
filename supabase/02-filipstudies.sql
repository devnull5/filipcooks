-- ---------------------------------------------------------------------
-- filipstudies: classes, practice tests, questions, attempt history.
--
-- Run this in the Supabase SQL Editor (Project → SQL Editor → New query),
-- paste the whole file, Run. It's additive and safe to run twice.
--
-- EVERYTHING HERE IS ADMIN-ONLY. The site is static and ships a publishable
-- key, so anyone can read assets/js/config.js and call the API directly.
-- The RLS policies below are what actually keeps these tables private — the
-- gate on studies.html is only a convenience for the browser.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

-- One row per class/subject being studied. Added one at a time.
create table if not exists public.study_classes (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  subtitle   text,
  -- lower sorts first; ties fall back to created_at
  sort_order integer not null default 0,
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.study_tests (
  id         uuid primary key default gen_random_uuid(),
  class_id   uuid not null references public.study_classes(id) on delete cascade,
  slug       text not null,
  title      text not null,
  intro      text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- slugs only have to be unique inside their class, so two classes can both
  -- have a "unit-1" test
  unique (class_id, slug)
);

-- Multiple choice today. 'written' is here because free-response questions
-- are coming: they keep the model answer in answer_text and leave choices
-- empty, and the check constraint below enforces the right shape for each.
create table if not exists public.study_questions (
  id           uuid primary key default gen_random_uuid(),
  test_id      uuid not null references public.study_tests(id) on delete cascade,
  -- display order within the test; not unique, so reordering needs no shuffle
  position     integer not null default 0,
  kind         text not null default 'choice',
  prompt       text not null,
  -- choice: a JSON array of option strings, e.g. ["Ribosome", "Mitochondrion"]
  -- written: empty
  choices      jsonb not null default '[]'::jsonb,
  -- choice: which index in `choices` is right. written: null
  answer_index smallint,
  -- written: the model answer to grade yourself against. choice: null
  answer_text  text,
  -- shown after answering, for both kinds
  explanation  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint study_questions_kind_known
    check (kind in ('choice', 'written')),

  -- A half-built question is worse than no question: a choice question with
  -- answer_index pointing past the end of its options would mark every
  -- answer wrong, silently. Reject it at write time instead.
  constraint study_questions_shape
    check (
      case kind
        when 'choice' then
          jsonb_typeof(choices) = 'array'
          and jsonb_array_length(choices) >= 2
          and answer_index is not null
          and answer_index >= 0
          and answer_index < jsonb_array_length(choices)
        when 'written' then
          answer_text is not null and length(btrim(answer_text)) > 0
        else false
      end
    )
);

-- One row per run through a test, so a test can show last score, best score
-- and whether it's going up.
create table if not exists public.study_attempts (
  id         uuid primary key default gen_random_uuid(),
  test_id    uuid not null references public.study_tests(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  score      integer not null check (score >= 0),
  total      integer not null check (total > 0),
  -- what was picked, per question: [{"q": "<uuid>", "picked": 2, "right": true}, …]
  answers    jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),

  constraint study_attempts_score_fits check (score <= total)
);

create index if not exists study_tests_class_idx
  on public.study_tests (class_id, sort_order, created_at);
create index if not exists study_questions_test_idx
  on public.study_questions (test_id, position, created_at);
create index if not exists study_attempts_test_idx
  on public.study_attempts (test_id, user_id, created_at desc);

drop trigger if exists study_classes_touch on public.study_classes;
create trigger study_classes_touch before update on public.study_classes
  for each row execute function public.touch_updated_at();

drop trigger if exists study_tests_touch on public.study_tests;
create trigger study_tests_touch before update on public.study_tests
  for each row execute function public.touch_updated_at();

drop trigger if exists study_questions_touch on public.study_questions;
create trigger study_questions_touch before update on public.study_questions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 2. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------

alter table public.study_classes   enable row level security;
alter table public.study_tests     enable row level security;
alter table public.study_questions enable row level security;
alter table public.study_attempts  enable row level security;

-- Belt and braces. RLS already blocks anon on every table below, because
-- every policy requires public.is_admin() and a signed-out caller can't be an
-- admin. Taking the grants away too means a mistake in a single policy can't
-- expose the whole section to the public key.
revoke all on public.study_classes   from anon;
revoke all on public.study_tests     from anon;
revoke all on public.study_questions from anon;
revoke all on public.study_attempts  from anon;

grant select, insert, update, delete
  on public.study_classes, public.study_tests, public.study_questions
  to authenticated;
-- Attempts are written and read, never edited: a practice score you can
-- rewrite isn't a record of anything.
grant select, insert, delete on public.study_attempts to authenticated;

-- study_classes -------------------------------------------------------
drop policy if exists "admin reads classes" on public.study_classes;
create policy "admin reads classes"
  on public.study_classes for select
  using (public.is_admin());

drop policy if exists "admin writes classes" on public.study_classes;
create policy "admin writes classes"
  on public.study_classes for insert
  with check (public.is_admin());

drop policy if exists "admin updates classes" on public.study_classes;
create policy "admin updates classes"
  on public.study_classes for update
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "admin deletes classes" on public.study_classes;
create policy "admin deletes classes"
  on public.study_classes for delete
  using (public.is_admin());

-- study_tests ---------------------------------------------------------
drop policy if exists "admin reads tests" on public.study_tests;
create policy "admin reads tests"
  on public.study_tests for select
  using (public.is_admin());

drop policy if exists "admin writes tests" on public.study_tests;
create policy "admin writes tests"
  on public.study_tests for insert
  with check (public.is_admin());

drop policy if exists "admin updates tests" on public.study_tests;
create policy "admin updates tests"
  on public.study_tests for update
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "admin deletes tests" on public.study_tests;
create policy "admin deletes tests"
  on public.study_tests for delete
  using (public.is_admin());

-- study_questions -----------------------------------------------------
-- The answers live here, so this is the table that most needs to stay shut.
drop policy if exists "admin reads questions" on public.study_questions;
create policy "admin reads questions"
  on public.study_questions for select
  using (public.is_admin());

drop policy if exists "admin writes questions" on public.study_questions;
create policy "admin writes questions"
  on public.study_questions for insert
  with check (public.is_admin());

drop policy if exists "admin updates questions" on public.study_questions;
create policy "admin updates questions"
  on public.study_questions for update
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "admin deletes questions" on public.study_questions;
create policy "admin deletes questions"
  on public.study_questions for delete
  using (public.is_admin());

-- study_attempts ------------------------------------------------------
-- Admin-only like the rest, and additionally scoped to your own rows, so
-- adding a second studier later doesn't mix up anyone's scores.
drop policy if exists "admin reads own attempts" on public.study_attempts;
create policy "admin reads own attempts"
  on public.study_attempts for select
  using (public.is_admin() and user_id = auth.uid());

drop policy if exists "admin records own attempt" on public.study_attempts;
create policy "admin records own attempt"
  on public.study_attempts for insert
  with check (public.is_admin() and user_id = auth.uid());

drop policy if exists "admin deletes own attempts" on public.study_attempts;
create policy "admin deletes own attempts"
  on public.study_attempts for delete
  using (public.is_admin() and user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 3. VERIFY
-- ---------------------------------------------------------------------
-- Both queries below should come back the way the comments say. If they
-- don't, the section is not private and something above didn't run.

-- Expect: four rows, all with rowsecurity = true.
select relname, relrowsecurity as rowsecurity
  from pg_class
 where relnamespace = 'public'::regnamespace
   and relname in ('study_classes', 'study_tests', 'study_questions', 'study_attempts')
 order by relname;

-- Expect: ZERO rows. Any row here is a privilege the public (signed-out) key
-- still holds on a filipstudies table.
select table_name, privilege_type
  from information_schema.role_table_grants
 where grantee = 'anon'
   and table_schema = 'public'
   and table_name like 'study\_%'
 order by table_name, privilege_type;
