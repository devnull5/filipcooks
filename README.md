# filipcooks.com

A recipe site. Filip posts recipes; signed-in visitors rate and review them.

No build step, no framework, no `npm install`. Three HTML pages, some CSS, and
ES modules that talk to Supabase over the CDN build of `supabase-js`. You can
open it with any static file server and deploy it by pushing to GitHub.

```
index.html            recipe grid — search, category filter, sort
recipe.html           one recipe + its review thread
admin.html            post/edit/publish recipes (admins only)
privacy.html          privacy policy (required to publish the Google OAuth app)
terms.html            terms of service (same)
404.html              GitHub Pages fallback
CNAME                 custom domain for GitHub Pages
assets/css/style.css  all styling, light + dark
assets/js/config.js   Supabase URL + publishable key (public; committed on purpose)
assets/js/app.js      shared client, auth, header, helpers
assets/js/home.js     index.html behaviour
assets/js/recipe.js   recipe.html behaviour
assets/js/admin.js    admin.html behaviour
supabase/setup-all.sql  ONE-SHOT: stale-table rename + full schema. Start here.
supabase/01-fix-column-grants.sql  security patch for instances set up before 2026-09-13
supabase/schema.sql   tables, triggers, RLS, storage (the schema on its own)
supabase/00-reset-stale-recipes.sql  only if a foreign `recipes` table is in the way
supabase/make-me-admin.sql   flips your own is_admin flag
```

## How the data works

Three tables, all with row level security on:

| Table | Who can read | Who can write |
| --- | --- | --- |
| `recipes` | anyone (published only); admins also see drafts | admins only |
| `reviews` | anyone | signed-in users, their own row only |
| `profiles` | anyone (so reviewer names render) | each user, their own row only |

A few details worth knowing:

- **One review per person per recipe**, enforced by a unique constraint. Posting
  again edits the existing review rather than adding a second one.
- **Ratings are denormalised.** A trigger keeps `recipes.review_count` and
  `recipes.rating_sum` current, so the grid shows averages without an aggregate
  query per card. Those two columns are revoked from clients — only the trigger
  writes them.
- **Nobody can promote themselves.** `public.profiles` has its table-wide
  UPDATE grant revoked, with UPDATE granted back on only `display_name` and
  `avatar_url`. `is_admin` is therefore unwritable by any client request; you
  flip it by hand in SQL.

  This has to be done as *revoke-table-then-grant-columns*. A bare
  `revoke update (is_admin) on profiles` silently does nothing, because a
  column-level revoke cannot subtract from a table-level grant and Supabase
  grants table-wide privileges by default. Getting this wrong leaves a
  one-request path from "signed-in visitor" to "admin".
- **Reviews only attach to published recipes**, checked inside the insert policy.

## Setup

### 1. Supabase project

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**.

   > If it stops with *"A different public.recipes table already exists"*, this
   > instance has a leftover `recipes` table from something else. Read
   > `supabase/00-reset-stale-recipes.sql`, deal with that table, then re-run.

   This creates the tables, triggers, policies and the `recipe-images` bucket.
3. **Project Settings → API Keys** → copy the **Project URL** and the
   **publishable** key (`sb_publishable_...`; older projects call this the
   **anon public** key) into `assets/js/config.js`.

> That key belongs in the repo — it's a public client key, and RLS is what
> actually protects the data. The dangerous one is `sb_secret_...` (formerly
> `service_role`); it isn't used anywhere in this site and must never be
> committed.

### 2. Google sign-in

1. In Supabase: **Authentication → Providers → Google** → enable it. The callback
   URL is `https://<project-ref>.supabase.co/auth/v1/callback`.
2. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
   create an **OAuth client ID** of type *Web application*.
   - *Authorised JavaScript origins*: `https://filipcooks.com`
     (add `http://localhost:5173` for local work)
   - *Authorised redirect URIs*: the Supabase callback URL from step 1
3. Paste the Google **client ID** and **client secret** back into Supabase and save.
4. In Supabase: **Authentication → URL Configuration** → set **Site URL** to
   `https://filipcooks.com` and add `https://filipcooks.com/**`,
   `https://www.filipcooks.com/**` and `http://localhost:5173/**` to
   **Redirect URLs**.
5. **Publish the Google app.** A new External OAuth app starts in *Testing*
   mode, where only email addresses you add as test users can sign in — every
   other visitor gets "access blocked". In Google Cloud Console go to
   **Google Auth Platform → Audience** and click **Publish app**. Because this
   site only requests the basic `email`/`profile` scopes, publishing needs no
   Google review.

### 3. Make yourself the admin

Sign in on the site once with Google — that creates your `profiles` row. Then run
`supabase/make-me-admin.sql` in the SQL Editor. It lists the accounts that have
signed in before you promote one; don't skip that, because an UPDATE matching no
rows succeeds silently and you'd be left wondering why **Admin** never appeared.

> Two Google accounts are in play on this project: `lipmj186@gmail.com` and
> `merditaj.filip@gmail.com` (the latter owns the Google Cloud OAuth app). The
> one you *sign in to the site with* is the one to promote.

### 4. Deploy

Push to GitHub, then **Settings → Pages** → *Deploy from a branch* → `main` / root.

For the custom domain: **Settings → Pages → Custom domain** → `filipcooks.com`.
Then at your DNS host (GoDaddy) point the apex at GitHub Pages:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `<your-github-username>.github.io` |

Delete GoDaddy's existing parking/builder records for `@` first, or they'll
conflict. Once it resolves, tick **Enforce HTTPS** in the Pages settings.

## Local development

ES modules won't load over `file://`, so use a server:

```bash
python -m http.server 5173
```

Then open <http://localhost:5173>. Add `http://localhost:5173/**` to the Supabase
redirect URLs (step 2 above) if you want Google sign-in to work locally.

## Posting a recipe

Go to `/admin.html`. Ingredients and method are one item per line — blank lines
are ignored. Photos upload straight to Supabase storage. Leave **Published**
unticked to keep something as a draft; drafts are visible only to you, and
reviews are closed on them.
