"""
Prove that filipstudies is actually private.

    python scripts/check_studies_private.py

The site is static and ships a publishable key, so anyone can read
assets/js/config.js and call the Supabase API themselves. This script does
exactly that — signed out, with the public key, the way a stranger would —
and fails if any filipstudies table hands back a single row.

Run it after supabase/02-filipstudies.sql, and again any time the policies
on those tables change.

Exit code 0 = private. 1 = something is readable that shouldn't be.
"""

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "assets" / "js" / "config.js"
TABLES = ["study_classes", "study_tests", "study_questions", "study_attempts"]


def public_credentials() -> tuple[str, str]:
    """The same two values the browser gets, read from the committed config."""
    text = CONFIG.read_text(encoding="utf-8")
    url = re.search(r"SUPABASE_URL:\s*'([^']+)'", text)
    key = re.search(r"SUPABASE_ANON_KEY:\s*'([^']+)'", text)
    if not url or not key:
        sys.exit(f"Could not read the Supabase URL and key out of {CONFIG}.")
    return url.group(1).rstrip("/"), key.group(1)


def probe(base: str, key: str, table: str) -> tuple[str, str]:
    """Returns (verdict, detail) for one table."""
    req = urllib.request.Request(
        f"{base}/rest/v1/{table}?select=*&limit=1",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            rows = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        # 401/403, or PostgREST's "permission denied" — all mean shut.
        if e.code in (401, 403):
            return "private", f"HTTP {e.code}, access refused"
        if e.code == 404 or "does not exist" in body:
            return "missing", "table not found — has 02-filipstudies.sql been run?"
        if "permission denied" in body:
            return "private", "permission denied"
        return "error", f"HTTP {e.code}: {body[:120]}"
    except Exception as e:  # noqa: BLE001 - network shape varies
        return "error", str(e)

    if rows:
        return "EXPOSED", f"returned {len(rows)} row(s) to the public key"
    # An empty list is what RLS looks like from outside: the request is
    # allowed, every row is filtered out.
    return "private", "no rows visible"


def main() -> int:
    base, key = public_credentials()
    print(f"Querying {base} signed out, with the publishable key.\n")

    verdicts = {}
    for table in TABLES:
        verdict, detail = probe(base, key, table)
        verdicts[table] = verdict
        mark = {"private": "ok  ", "EXPOSED": "FAIL", "missing": "??  ", "error": "??  "}[verdict]
        print(f"  {mark} {table:<16} {detail}")

    print()
    if any(v == "EXPOSED" for v in verdicts.values()):
        print("FAIL: filipstudies data is readable by anyone with the public key.")
        return 1
    if any(v == "missing" for v in verdicts.values()):
        print("Migration not applied yet — run supabase/02-filipstudies.sql, then re-run this.")
        return 1
    if any(v == "error" for v in verdicts.values()):
        print("Could not check every table; see above.")
        return 1

    print("Private: none of the filipstudies tables return anything to a signed-out caller.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
