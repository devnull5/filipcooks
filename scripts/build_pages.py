"""
Build a real, crawlable page for every published recipe, plus sitemap.xml.

    python scripts/build_pages.py

Reads data/recipes.json (written by scripts/snapshot.py) and writes:

  recipes/<slug>/index.html   one page per published recipe
  sitemap.xml                 every recipe page, for Google

Why: recipe.html?r=<slug> fills itself in with JavaScript after loading.
Google renders JavaScript eventually and unreliably, and link previews
(iMessage, WhatsApp, Facebook, Slack) don't run it at all. These pages ship
the finished recipe in the HTML, with schema.org Recipe markup for Google's
recipe results and Open Graph tags for previews. The same recipe.js then
loads on top, so reviews, sign-in and serving scaling work exactly as on
recipe.html.

The recipes/ folder is rebuilt from scratch each run, so an unpublished or
deleted recipe's page disappears. Output is deterministic (no timestamps), so
an unchanged site produces no commit.
"""

import html
import json
import re
import shutil
from pathlib import Path

SITE = "https://filipcooks.com"
ADSENSE_CLIENT = "ca-pub-4108944496579681"  # keep in sync with assets/js/config.js
AUTHOR = "Filip"
ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / "data" / "recipes.json"
PAGES = ROOT / "recipes"
SITEMAP = ROOT / "sitemap.xml"

SAFE_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
STEP_NUMBER = re.compile(r"^\s*\d+\s*[.)]\s+")

FAVICON = (
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>"
    "<text y='.9em' font-size='90'>🍳</text></svg>"
)


def esc(value) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def clean_step(text: str) -> str:
    """Steps are often typed as "1. Do this"; the page numbers them already."""
    return STEP_NUMBER.sub("", str(text)).strip()


STEP_TITLE = re.compile(r"^([^:.!?\n]{3,60}):\s+(\S.*)$", re.S)


def step_parts(text: str) -> tuple[str | None, str]:
    """Steps written "Brown the chicken: In a large skillet…" carry their own
    short name, which Google shows as the step heading. Anything else has none."""
    m = STEP_TITLE.match(text)
    return (m.group(1).strip(), m.group(2).strip()) if m else (None, text)


def how_to_step(text: str, url: str) -> dict:
    name, body = step_parts(clean_step(text))
    step = {"@type": "HowToStep", "text": body, "url": url}
    if name:
        step = {"@type": "HowToStep", "name": name, "text": body, "url": url}
    return step


def as_list(value) -> list[str]:
    return [str(x).strip() for x in (value or []) if str(x).strip()]


def iso_duration(minutes) -> str | None:
    if not minutes:
        return None
    h, m = divmod(int(minutes), 60)
    return "PT" + (f"{h}H" if h else "") + (f"{m}M" if m or not h else "")


def human_duration(minutes) -> str | None:
    """Matches totalTime() in assets/js/app.js."""
    if not minutes:
        return None
    if minutes < 60:
        return f"{minutes} min"
    h, m = divmod(int(minutes), 60)
    return f"{h} hr {m} min" if m else f"{h} hr"


def page_title(title: str) -> str:
    suffix = "" if title.strip().lower().endswith("recipe") else " Recipe"
    return f"{title}{suffix} | Filip Cooks"


def meta_description(r: dict) -> str:
    text = (r.get("blurb") or "").strip()
    if not text:
        n = len(as_list(r.get("ingredients")))
        serves = f", serves {r['servings']}" if r.get("servings") else ""
        text = f"{r['title']}: a home-cooked recipe from Filip Cooks with {n} ingredients{serves}."
    text = re.sub(r"\s+", " ", text)
    if len(text) <= 155:
        return text
    cut = text[:155].rsplit(" ", 1)[0].rstrip(",.;:")
    return cut + "…"


def structured_data(r: dict, url: str) -> dict:
    """schema.org Recipe, per Google's recipe structured-data guidelines."""
    total = (r.get("prep_minutes") or 0) + (r.get("cook_minutes") or 0)
    data = {
        "@context": "https://schema.org",
        "@type": "Recipe",
        "name": r["title"],
        "url": url,
        "mainEntityOfPage": url,
        "author": {"@type": "Person", "name": AUTHOR},
        "datePublished": (r.get("created_at") or "")[:10] or None,
        "dateModified": (r.get("updated_at") or "")[:10] or None,
        "description": (r.get("blurb") or "").strip() or None,
        "image": [r["hero_url"]] if r.get("hero_url") else None,
        "recipeCategory": (r.get("category") or "").strip().title() or None,
        "keywords": ", ".join(filter(None, [r["title"], (r.get("category") or "").strip()])) or None,
        "recipeYield": f"{r['servings']} servings" if r.get("servings") else None,
        "prepTime": iso_duration(r.get("prep_minutes")),
        "cookTime": iso_duration(r.get("cook_minutes")),
        "totalTime": iso_duration(total),
        "recipeIngredient": as_list(r.get("ingredients")),
        "recipeInstructions": [
            how_to_step(s, f"{url}#step-{i}")
            for i, s in enumerate(as_list(r.get("steps")), start=1)
        ],
    }
    # Only real reviews, and only when there are some: Google rejects a
    # rating block with zero ratings, and ratings must match what's shown.
    if r.get("review_count"):
        data["aggregateRating"] = {
            "@type": "AggregateRating",
            "ratingValue": round(r["rating_sum"] / r["review_count"], 1),
            "ratingCount": r["review_count"],
            "bestRating": 5,
            "worstRating": 1,
        }
    return {k: v for k, v in data.items() if v not in (None, [], "")}


def json_ld(data: dict) -> str:
    # "</" inside a <script> would end it early; JSON allows "<\/".
    return json.dumps(data, ensure_ascii=False, indent=2).replace("</", "<\\/")


def body_html(r: dict) -> str:
    """The recipe as plain HTML, for crawlers and for the first paint.
    recipe.js replaces it with the interactive version once it loads."""
    ingredients = as_list(r.get("ingredients"))
    steps = [clean_step(s) for s in as_list(r.get("steps"))]
    total = (r.get("prep_minutes") or 0) + (r.get("cook_minutes") or 0)

    facts = []
    if r.get("prep_minutes"):
        facts.append(("Prep", human_duration(r["prep_minutes"])))
    if r.get("cook_minutes"):
        facts.append(("Cook", human_duration(r["cook_minutes"])))
    if total:
        facts.append(("Total", human_duration(total)))
    if r.get("servings"):
        facts.append(("Serves", r["servings"]))

    rating = ""
    if r.get("review_count"):
        avg = r["rating_sum"] / r["review_count"]
        plural = "" if r["review_count"] == 1 else "s"
        rating = (f'\n        <div class="rating-summary"><span class="rating-value">{avg:.1f}</span>'
                  f'<span class="rating-count">from {r["review_count"]} review{plural}</span></div>')

    parts = [
        '      <section class="recipe-head">',
        f'        <span class="badge">{esc(r["category"])}</span>' if r.get("category") else "",
        f'        <h1>{esc(r["title"])}</h1>',
        f'        <p class="lede">{esc(r["blurb"])}</p>' if r.get("blurb") else "",
        rating,
        "      </section>",
    ]
    if r.get("hero_url"):
        parts.append(f'      <img class="hero-photo" src="{esc(r["hero_url"])}" alt="{esc(r["title"])}">')
    if facts:
        parts.append('      <div class="facts">' + "".join(
            f'<div class="fact"><div class="fact-label">{esc(k)}</div><div class="fact-value">{esc(v)}</div></div>'
            for k, v in facts) + "</div>")
    parts += [
        '      <div class="recipe-columns">',
        '        <div>',
        '          <h2 class="section-title">Ingredients</h2>',
        '          <ul class="ingredients">',
        *[f"            <li>{esc(i)}</li>" for i in ingredients],
        "          </ul>",
        "        </div>",
        "        <div>",
        '          <h2 class="section-title">Method</h2>',
        '          <ol class="steps">',
        *[f'            <li id="step-{n}">{esc(s)}</li>' for n, s in enumerate(steps, start=1)],
        "          </ol>",
        "        </div>",
        "      </div>",
        '      <a class="back-link" href="/">← All recipes</a>',
    ]
    return "\n".join(p for p in parts if p)


def page_html(r: dict) -> str:
    url = f"{SITE}/recipes/{r['slug']}/"
    title = page_title(r["title"])
    desc = meta_description(r)
    image_tags = ""
    if r.get("hero_url"):
        image_tags = (f'\n  <meta property="og:image" content="{esc(r["hero_url"])}">'
                      f'\n  <meta name="twitter:image" content="{esc(r["hero_url"])}">')
    card = "summary_large_image" if r.get("hero_url") else "summary"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(desc)}">
  <link rel="canonical" href="{url}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Filip Cooks">
  <meta property="og:title" content="{esc(r['title'])}">
  <meta property="og:description" content="{esc(desc)}">
  <meta property="og:url" content="{url}">{image_tags}
  <meta name="twitter:card" content="{card}">
  <meta name="twitter:title" content="{esc(r['title'])}">
  <meta name="twitter:description" content="{esc(desc)}">
  <link rel="icon" href="{FAVICON}">
  <link rel="stylesheet" href="/assets/css/style.css">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={ADSENSE_CLIENT}"
     crossorigin="anonymous"></script>
  <script type="application/ld+json">
{json_ld(structured_data(r, url))}
  </script>
</head>
<body>

  <header class="site-header">
    <div class="wrap">
      <a class="brand" href="/">
        <span class="brand-mark">🍳</span> Filip Cooks
      </a>
      <nav class="site-nav">
        <a href="/">Recipes</a>
        <div id="auth-slot"></div>
      </nav>
    </div>
  </header>

  <!-- Generated by scripts/build_pages.py from data/recipes.json. Don't edit by hand. -->
  <main class="wrap-narrow" id="recipe-root" data-slug="{esc(r['slug'])}" data-prerendered>
{body_html(r)}
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <span>© <span id="year"></span> Filip Cooks</span>
      <span><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · Built with Supabase</span>
    </div>
  </footer>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js"></script>
  <script src="/assets/js/config.js"></script>
  <script type="module" src="/assets/js/recipe.js"></script>
</body>
</html>
"""


def sitemap_xml(recipes: list[dict]) -> str:
    def entry(loc, lastmod):
        mod = f"<lastmod>{lastmod}</lastmod>" if lastmod else ""
        return f"  <url><loc>{esc(loc)}</loc>{mod}</url>"

    newest = max(((r.get("updated_at") or "")[:10] for r in recipes), default="")
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
             entry(f"{SITE}/", newest)]
    lines += [entry(f"{SITE}/recipes/{r['slug']}/", (r.get("updated_at") or "")[:10]) for r in recipes]
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"


def main() -> int:
    snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    recipes = [r for r in snapshot.get("recipes", []) if r.get("published")]

    # A placeholder or failed snapshot must not wipe pages Google has indexed.
    if not recipes and PAGES.exists():
        print("::warning::Snapshot has no recipes; leaving existing pages alone.")
        return 0

    usable = []
    for r in recipes:
        if not SAFE_SLUG.match(r.get("slug") or ""):
            print(f"::warning::Skipping recipe with unsafe slug {r.get('slug')!r}.")
            continue
        usable.append(r)

    if PAGES.exists():
        shutil.rmtree(PAGES)
    for r in usable:
        folder = PAGES / r["slug"]
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "index.html").write_text(page_html(r), encoding="utf-8", newline="\n")

    SITEMAP.write_text(sitemap_xml(usable), encoding="utf-8", newline="\n")
    print(f"Built {len(usable)} recipe page(s) and sitemap.xml.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
