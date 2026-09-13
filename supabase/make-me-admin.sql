-- =====================================================================
-- Make yourself the admin.
--
-- Run this AFTER you have signed in to the site with Google at least once.
-- Signing in is what creates your row in public.profiles; this flips the
-- admin bit so /admin.html lets you post recipes.
--
-- Run STEP 1 first. Don't guess your own address — the Google account you
-- sign in with may not be the one you expect. This project has at least two
-- in play: lipmj186@gmail.com and merditaj.filip@gmail.com.
-- =====================================================================

-- ---------------------------------------------------------------------
-- STEP 1: who has actually signed in? Run this on its own and read it.
-- ---------------------------------------------------------------------

select u.email,
       p.display_name,
       p.is_admin,
       p.created_at
  from public.profiles p
  join auth.users u on u.id = p.id
 order by p.created_at;

-- Empty result? Then nobody has signed in yet. Go to the site, sign in
-- with Google, then come back and run STEP 1 again.


-- ---------------------------------------------------------------------
-- STEP 2: promote that address.
--
-- Replace the email below with the one STEP 1 showed you, then run it.
-- ---------------------------------------------------------------------

update public.profiles p
   set is_admin = true
  from auth.users u
 where u.id = p.id
   and lower(u.email) = lower('PASTE_THE_EMAIL_FROM_STEP_1_HERE');


-- ---------------------------------------------------------------------
-- STEP 3: confirm. The row you promoted should show is_admin = true.
--
-- If every row still says false, the email in STEP 2 didn't match any
-- account — check STEP 1's output for the exact spelling. An UPDATE that
-- matches no rows succeeds silently, which is why this check matters.
-- ---------------------------------------------------------------------

select u.email, p.display_name, p.is_admin
  from public.profiles p
  join auth.users u on u.id = p.id
 order by p.is_admin desc, p.created_at;
