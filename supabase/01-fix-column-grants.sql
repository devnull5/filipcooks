-- =====================================================================
-- SECURITY FIX — run this in the Supabase SQL Editor. Not optional.
--
-- THE BUG
-- schema.sql tried to protect sensitive columns like this:
--
--     revoke update (is_admin, id, created_at) on public.profiles
--       from anon, authenticated;
--
-- That does nothing. In PostgreSQL a column-level REVOKE cannot subtract
-- from a TABLE-level grant, and Supabase grants table-wide privileges to
-- `anon` and `authenticated` when a project is created. The column list is
-- silently ignored, no error is raised, and the column stays writable.
--
-- THE CONSEQUENCE
-- The "users update own profile" RLS policy lets a signed-in visitor update
-- their own profiles row. With the revoke being a no-op, that included
-- `is_admin`. So any visitor who signed in could promote themselves to admin
-- with a single PATCH, and then create, edit and delete recipes.
--
-- THE FIX
-- Drop the table-wide UPDATE grant, then hand back only the columns that are
-- actually safe to write. Now the column list is the whole grant, so it is
-- enforced. RLS still applies on top; this is the layer underneath it.
-- =====================================================================

-- --- profiles --------------------------------------------------------
-- Writable: your own display name and avatar. Nothing else, ever.

revoke update on public.profiles from anon, authenticated;
grant  update (display_name, avatar_url) on public.profiles to authenticated;

-- withheld: is_admin (escalation), id (identity), created_at


-- --- recipes ---------------------------------------------------------
-- RLS already limits writes to admins. This is defence in depth: even an
-- admin cannot hand-edit the rating counters, which only the
-- sync_recipe_rating() trigger owns (it is SECURITY DEFINER, so it is
-- unaffected by these grants).

revoke update on public.recipes from anon, authenticated;
grant  update (
         slug, title, blurb, hero_url, category,
         ingredients, steps,
         prep_minutes, cook_minutes, servings,
         published, author_id
       ) on public.recipes to authenticated;

-- withheld: review_count, rating_sum (trigger-owned), id, created_at,
--           updated_at (set by the touch_updated_at BEFORE trigger, which
--           modifies NEW in memory and so needs no column privilege)


-- =====================================================================
-- VERIFY
--
-- 1. Confirm the grants are now column-scoped. `profiles` should list
--    exactly display_name and avatar_url for `authenticated`, and
--    is_admin must NOT appear.
-- =====================================================================

select table_name, column_name, grantee, privilege_type
  from information_schema.column_privileges
 where table_schema = 'public'
   and table_name in ('profiles', 'recipes')
   and grantee in ('anon', 'authenticated')
   and privilege_type = 'UPDATE'
 order by table_name, grantee, column_name;

-- 2. Confirm no table-wide UPDATE grant survives. This should return
--    ZERO rows. If it returns anything, the revoke above did not apply.

select grantee, privilege_type, table_name
  from information_schema.table_privileges
 where table_schema = 'public'
   and table_name in ('profiles', 'recipes')
   and grantee in ('anon', 'authenticated')
   and privilege_type = 'UPDATE';
