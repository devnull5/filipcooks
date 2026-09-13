-- =====================================================================
-- Run this AFTER you have signed in to the site with Google at least once.
-- Signing in creates your row in public.profiles; this flips the admin bit
-- so that /admin.html lets you post recipes.
--
-- Change the email below if you sign in with a different Google account.
-- =====================================================================

update public.profiles p
   set is_admin = true
  from auth.users u
 where u.id = p.id
   and lower(u.email) = lower('lipmj186@gmail.com');

-- Verify: should print one row with is_admin = true
select u.email, p.display_name, p.is_admin
  from public.profiles p
  join auth.users u on u.id = p.id
 order by p.created_at;
