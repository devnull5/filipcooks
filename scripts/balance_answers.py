"""
Even out which option position holds the correct answer.

    python scripts/balance_answers.py study-content/<folder>

Writing questions one at a time produces a strong positional bias — the
first pass of the D426 bank had 56% of its correct answers in position B
and only 2% in position D. That makes a test gameable without knowing the
material, which defeats the point of practising on it.

This rewrites each question's `choices` in place and updates `answer`, by
swapping the correct option into whichever position is currently least
used. Swapping two options is safe for wording, with two exceptions the
script leaves alone:

  * Two-option questions. "True" then "False", or "Yes" then "No", read in
    a fixed order and shuffling them just makes them confusing.
  * Catch-all options such as "None of these" or "All of the above", which
    only make sense in their original position.

Deterministic: the same input always produces the same output, so it can be
re-run after adding tests without churning the ones already there.
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# An option that only makes sense where the author put it.
CATCH_ALL = re.compile(
    r"^\s*(none|all|neither|both|either|any)\b|of the (above|above\.)|of these|"
    r"^\s*(nothing is wrong|no rows|nobody|no one)\b",
    re.IGNORECASE,
)


def balance(folder: Path) -> int:
    files = sorted(p for p in folder.glob("*.json") if p.name != "class.json")
    if not files:
        sys.exit(f"No test files in {folder}")

    used: Counter[int] = Counter()
    moved = total = 0

    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        for q in data.get("questions", []):
            if q.get("kind") == "written":
                continue
            choices = q["choices"]
            n = len(choices)
            answer = q["answer"]

            # Two-option questions read in a fixed order; count and move on.
            if n < 3:
                used[answer] += 1
                continue

            total += 1
            pinned = {i for i, c in enumerate(choices) if CATCH_ALL.match(c)}
            candidates = [i for i in range(n) if i not in pinned]

            # If the correct answer is itself a catch-all, leave it put.
            if answer in pinned or not candidates:
                used[answer] += 1
                continue

            # Least-used position so far, breaking ties toward the lower index
            # for determinism.
            target = min(candidates, key=lambda i: (used[i], i))
            if target != answer:
                choices[answer], choices[target] = choices[target], choices[answer]
                q["answer"] = target
                moved += 1
            used[q["answer"]] += 1

        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )

    spread = ", ".join(f"{chr(65 + i)}={used[i]}" for i in sorted(used))
    print(f"Rebalanced {moved} of {total} multiple-choice questions.")
    print(f"Correct answer by position: {spread}")
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit("usage: python scripts/balance_answers.py <folder>")
    folder = Path(sys.argv[1])
    if not folder.is_absolute():
        folder = ROOT / folder
    if not folder.is_dir():
        sys.exit(f"No such folder: {folder}")
    return balance(folder)


if __name__ == "__main__":
    raise SystemExit(main())
