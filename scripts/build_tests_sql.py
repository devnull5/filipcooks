"""
Turn a folder of practice-test JSON files into one SQL file to paste into
the Supabase SQL Editor.

    python scripts/build_tests_sql.py study-content/sql-databases

The web importer on /studies-admin.html is fine for one test. For thirty it
is thirty trips through a form, so this does the same validation and emits
SQL instead. The SQL Editor runs as the table owner, so it also works when
the browser isn't signed in.

Input: a folder with a class.json and any number of test JSON files.

  class.json   {"slug": "...", "name": "...", "subtitle": "..."}
  <test>.json  {"slug": "...", "title": "...", "intro": "...",
                "sort_order": 1, "questions": [...]}

  question     {"prompt": "...", "choices": [...], "answer": 1,
                "explanation": "..."}
               {"prompt": "...", "kind": "written",
                "answer_text": "...", "explanation": "..."}

`answer` may be the index, the option letter, or the exact text of the right
choice. Every question in every file is checked before a line of SQL is
written: a test that is half right is worse than one that refuses to build.

Re-running the generated SQL replaces the questions in each test it names
and leaves recorded attempts alone.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def q(value) -> str:
    """A single-quoted SQL string literal, or NULL."""
    if value is None:
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def jsonb(value) -> str:
    return f"{q(json.dumps(value, ensure_ascii=False))}::jsonb"


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return re.sub(r"-{2,}", "-", s)


def check_question(raw: dict, where: str, errors: list) -> dict | None:
    prompt = str(raw.get("prompt", "")).strip()
    if not prompt:
        errors.append(f"{where}: missing 'prompt'.")

    kind = "written" if raw.get("kind") == "written" else "choice"
    explanation = str(raw.get("explanation", "")).strip() or None

    if kind == "written":
        answer_text = str(raw.get("answer_text") or raw.get("answer") or "").strip()
        if not answer_text:
            errors.append(f"{where}: written questions need 'answer_text'.")
        return {"kind": kind, "prompt": prompt, "choices": [],
                "answer_index": None, "answer_text": answer_text,
                "explanation": explanation}

    choices = [str(c).strip() for c in (raw.get("choices") or [])]
    if len(choices) < 2:
        errors.append(f"{where}: needs at least 2 'choices'.")
    if any(not c for c in choices):
        errors.append(f"{where}: has a blank choice.")
    if len(set(c.lower() for c in choices)) != len(choices):
        errors.append(f"{where}: has two identical choices.")

    answer = raw.get("answer")
    idx = None
    if isinstance(answer, bool):
        pass  # a bool is not an index; fall through to the error below
    elif isinstance(answer, int):
        idx = answer
    elif isinstance(answer, str):
        s = answer.strip()
        if re.fullmatch(r"[A-Za-z]", s):
            idx = ord(s.upper()) - 65
        else:
            match = [i for i, c in enumerate(choices) if c.lower() == s.lower()]
            idx = match[0] if match else None

    if idx is None:
        errors.append(f"{where}: 'answer' must be the index, letter, or exact text of a choice.")
    elif not 0 <= idx < len(choices):
        errors.append(f"{where}: 'answer' {answer!r} is outside its {len(choices)} choices.")

    return {"kind": kind, "prompt": prompt, "choices": choices,
            "answer_index": idx, "answer_text": None, "explanation": explanation}


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit("usage: python scripts/build_tests_sql.py <folder>")

    folder = Path(sys.argv[1])
    if not folder.is_absolute():
        folder = ROOT / folder
    if not folder.is_dir():
        sys.exit(f"No such folder: {folder}")

    class_file = folder / "class.json"
    if not class_file.exists():
        sys.exit(f"Missing {class_file} — it needs a slug and a name.")

    meta = json.loads(class_file.read_text(encoding="utf-8"))
    class_slug = slugify(meta.get("slug") or meta.get("name", ""))
    class_name = str(meta.get("name", "")).strip()
    if not class_slug or not class_name:
        sys.exit("class.json needs both a name and a usable slug.")

    errors: list[str] = []
    tests = []
    for path in sorted(folder.glob("*.json")):
        if path.name == "class.json":
            continue
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            errors.append(f"{path.name}: invalid JSON — {e}")
            continue

        title = str(body.get("title", "")).strip() or path.stem
        slug = slugify(body.get("slug") or title)
        questions = [
            check_question(raw, f"{path.name} q{i + 1}", errors)
            for i, raw in enumerate(body.get("questions") or [])
        ]
        if not questions:
            errors.append(f"{path.name}: no questions.")
        tests.append({
            "slug": slug,
            "title": title,
            "intro": str(body.get("intro", "")).strip() or None,
            "sort_order": int(body.get("sort_order", len(tests))),
            "questions": questions,
            "file": path.name,
        })

    slugs = [t["slug"] for t in tests]
    for s in sorted(set(slugs)):
        if slugs.count(s) > 1:
            errors.append(f"Two tests share the slug '{s}'.")

    if errors:
        print(f"{len(errors)} problem(s); nothing written:\n", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    lines = [
        "-- Generated by scripts/build_tests_sql.py. Paste into the Supabase",
        "-- SQL Editor and Run. Safe to re-run: each test's questions are",
        "-- replaced, and recorded attempts are left alone.",
        "--",
        f"-- Class: {class_name}",
        f"-- Tests: {len(tests)}   Questions: {sum(len(t['questions']) for t in tests)}",
        "",
        "begin;",
        "",
        "insert into public.study_classes (slug, name, subtitle)",
        f"values ({q(class_slug)}, {q(class_name)}, {q(meta.get('subtitle'))})",
        "on conflict (slug) do update set name = excluded.name, subtitle = excluded.subtitle;",
        "",
    ]

    # Three plain statements per test rather than one statement with
    # data-modifying CTEs: Postgres doesn't define the order those run in
    # relative to each other, and "delete the old questions, then insert the
    # new ones" is exactly an ordering that matters.
    for t in tests:
        total = len(t["questions"])
        test_id = (
            "(select t.id from public.study_tests t"
            " join public.study_classes c on c.id = t.class_id"
            f" where c.slug = {q(class_slug)} and t.slug = {q(t['slug'])})"
        )
        lines += [
            f"-- {t['title']}  ({total} question{'' if total == 1 else 's'}, from {t['file']})",
            "insert into public.study_tests (class_id, slug, title, intro, sort_order)",
            f"select c.id, {q(t['slug'])}, {q(t['title'])}, {q(t['intro'])}, {t['sort_order']}",
            f"  from public.study_classes c where c.slug = {q(class_slug)}",
            "on conflict (class_id, slug) do update",
            "  set title = excluded.title, intro = excluded.intro,",
            "      sort_order = excluded.sort_order;",
            "",
            f"delete from public.study_questions where test_id = {test_id};",
            "",
            "insert into public.study_questions",
            "  (test_id, position, kind, prompt, choices, answer_index, answer_text, explanation)",
            "values",
        ]
        rows = []
        for i, qu in enumerate(t["questions"]):
            rows.append(
                f"  ({test_id}, {i}, {q(qu['kind'])}, {q(qu['prompt'])}, "
                f"{jsonb(qu['choices'])}, "
                f"{'null' if qu['answer_index'] is None else qu['answer_index']}, "
                f"{q(qu['answer_text'])}, {q(qu['explanation'])})"
            )
        lines.append(",\n".join(rows) + ";")
        lines.append("")

    lines += [
        "commit;",
        "",
        "-- What landed:",
        "select t.sort_order, t.title, count(sq.id) as questions",
        "  from public.study_tests t",
        "  join public.study_classes c on c.id = t.class_id",
        "  left join public.study_questions sq on sq.test_id = t.id",
        f" where c.slug = {q(class_slug)}",
        " group by t.sort_order, t.title",
        " order by t.sort_order;",
        "",
    ]

    out = folder / "load.sql"
    out.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"{len(tests)} tests, {sum(len(t['questions']) for t in tests)} questions -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
