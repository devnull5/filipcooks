-- =====================================================================
-- filipcooks.com — database schema
-- Run this ONCE in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: everything is idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. PREFLIGHT
--
-- The table definitions below use `create table if not exists`, which means
-- an UNRELATED public.recipes table would be silently left in place and then
-- every trigger and policy after it would fail on missing columns. Catch that
-- here with one clear message instead.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'recipes'
  ) and not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'recipes' and column_name = 'slug'
  ) then
    raise exception
      'A different public.recipes table already exists (it has no "slug" column). Run supabase/00-reset-stale-recipes.sql first, or rename that table out of the way.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

-- One row per signed-in viewer. Auto-created on signup by a trigger below.
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text,
  avatar_url   text,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists public.recipes (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  title         text not null,
  blurb         text,
  hero_url      text,
  category      text,
  -- both stored as JSON arrays of strings, e.g. ["2 cups flour", "1 tsp salt"]
  ingredients   jsonb not null default '[]'::jsonb,
  steps         jsonb not null default '[]'::jsonb,
  prep_minutes  integer check (prep_minutes >= 0),
  cook_minutes  integer check (cook_minutes >= 0),
  servings      integer check (servings > 0),
  published     boolean not null default false,
  author_id     uuid references public.profiles(id) on delete set null,
  -- maintained automatically by the trigger in section 3
  review_count  integer not null default 0,
  rating_sum    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.reviews (
  id         uuid primary key default gen_random_uuid(),
  recipe_id  uuid not null references public.recipes(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  rating     smallint not null check (rating between 1 and 5),
  body       text check (char_length(body) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- one review per person per recipe; re-reviewing edits the existing one
  unique (recipe_id, user_id)
);

create index if not exists reviews_recipe_id_idx  on public.reviews (recipe_id, created_at desc);
create index if not exists recipes_published_idx  on public.recipes (published, created_at desc);
create index if not exists recipes_category_idx   on public.recipes (category);

-- ---------------------------------------------------------------------
-- 2. HELPERS
-- ---------------------------------------------------------------------

-- SECURITY DEFINER so that checking "am I an admin?" inside a policy on
-- profiles does not re-trigger RLS on profiles (infinite recursion).
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. TRIGGERS
-- ---------------------------------------------------------------------

-- Give every new auth user a profile row, pulling name/avatar from Google.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(coalesce(new.email, 'cook'), '@', 1)
    ),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep recipes.review_count / rating_sum in sync so the recipe grid can show
-- an average rating without an aggregate query per card.
-- SECURITY DEFINER because a normal viewer is not allowed to UPDATE recipes.
create or replace function public.sync_recipe_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.recipes
       set review_count = review_count + 1,
           rating_sum   = rating_sum + new.rating
     where id = new.recipe_id;
    return new;

  elsif tg_op = 'UPDATE' then
    if new.recipe_id = old.recipe_id then
      update public.recipes
         set rating_sum = rating_sum - old.rating + new.rating
       where id = new.recipe_id;
    else
      update public.recipes
         set review_count = review_count - 1, rating_sum = rating_sum - old.rating
       where id = old.recipe_id;
      update public.recipes
         set review_count = review_count + 1, rating_sum = rating_sum + new.rating
       where id = new.recipe_id;
    end if;
    return new;

  else -- DELETE
    update public.recipes
       set review_count = greatest(review_count - 1, 0),
           rating_sum   = greatest(rating_sum - old.rating, 0)
     where id = old.recipe_id;
    return old;
  end if;
end;
$$;

drop trigger if exists reviews_sync_rating on public.reviews;
create trigger reviews_sync_rating
  after insert or update or delete on public.reviews
  for each row execute function public.sync_recipe_rating();

drop trigger if exists recipes_touch on public.recipes;
create trigger recipes_touch before update on public.recipes
  for each row execute function public.touch_updated_at();

drop trigger if exists reviews_touch on public.reviews;
create trigger reviews_touch before update on public.reviews
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.recipes  enable row level security;
alter table public.reviews  enable row level security;

-- Nobody may promote themselves to admin, or fiddle with the counters that
-- the trigger owns. Column-level grants sit *on top of* the RLS policies.
revoke update (is_admin, id, created_at) on public.profiles from anon, authenticated;
revoke update (review_count, rating_sum) on public.recipes  from anon, authenticated;

-- profiles ------------------------------------------------------------
drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public"
  on public.profiles for select
  using (true);

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- recipes -------------------------------------------------------------
drop policy if exists "published recipes are public" on public.recipes;
create policy "published recipes are public"
  on public.recipes for select
  using (published or public.is_admin());

drop policy if exists "admin writes recipes" on public.recipes;
create policy "admin writes recipes"
  on public.recipes for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "admin updates recipes" on public.recipes;
create policy "admin updates recipes"
  on public.recipes for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "admin deletes recipes" on public.recipes;
create policy "admin deletes recipes"
  on public.recipes for delete
  to authenticated
  using (public.is_admin());

-- reviews -------------------------------------------------------------
drop policy if exists "reviews are public" on public.reviews;
create policy "reviews are public"
  on public.reviews for select
  using (true);

-- You may only post a review as yourself, and only on a live recipe.
drop policy if exists "users post own review" on public.reviews;
create policy "users post own review"
  on public.reviews for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.recipes r where r.id = recipe_id and r.published)
  );

drop policy if exists "users edit own review" on public.reviews;
create policy "users edit own review"
  on public.reviews for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Reviewers can delete their own; the admin can remove abuse.
drop policy if exists "users or admin delete review" on public.reviews;
create policy "users or admin delete review"
  on public.reviews for delete
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

-- ---------------------------------------------------------------------
-- 5. IMAGE STORAGE
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('recipe-images', 'recipe-images', true)
on conflict (id) do update set public = true;

drop policy if exists "recipe images are public" on storage.objects;
create policy "recipe images are public"
  on storage.objects for select
  using (bucket_id = 'recipe-images');

drop policy if exists "admin uploads recipe images" on storage.objects;
create policy "admin uploads recipe images"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'recipe-images' and public.is_admin());

drop policy if exists "admin updates recipe images" on storage.objects;
create policy "admin updates recipe images"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'recipe-images' and public.is_admin());

drop policy if exists "admin deletes recipe images" on storage.objects;
create policy "admin deletes recipe images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'recipe-images' and public.is_admin());
