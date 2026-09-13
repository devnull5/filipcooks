-- =====================================================================
-- ⚠️  DESTRUCTIVE — read this before running it.
--
-- This project's Supabase instance already had an unrelated `recipes`
-- table on it when the site was wired up, shaped like:
--
--     recipes(id, name, description, instructions, created_at, cuisine)
--
-- That is NOT this site's schema (which uses title/slug/ingredients/steps/
-- published/...). It looks like a leftover from an earlier experiment or a
-- quickstart template. It read as empty — zero rows — at the time of writing.
--
-- Because schema.sql uses `create table if not exists`, that stale table
-- would block the real one from being created. This drops it.
--
-- BEFORE YOU RUN THIS: confirm you don't want what's in that table.
-- The SELECT below shows you. If it returns rows you care about, stop and
-- rename the table instead (the ALTER at the bottom), don't drop it.
-- =====================================================================

-- 1. Look first. Run this on its own and read the output.
select * from public.recipes limit 50;

-- 2. Only if the above is empty / disposable, run this:
drop table if exists public.recipes cascade;

-- 3. Now run supabase/schema.sql.


-- --- Alternative: keep the old table, just move it aside -------------
-- Use this INSTEAD of the drop above if you want to preserve the data.
--
-- alter table public.recipes rename to recipes_old_backup;
