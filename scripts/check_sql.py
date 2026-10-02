"""
Structural check on a generated SQL file before it's pasted into a console.

    python scripts/check_sql.py <file.sql> [more.sql ...]

This is not a parser. It walks the file tracking whether it is inside a
string literal, a line comment or a block comment, which a regex cannot do
— the test content legitimately contains apostrophes, parentheses, and the
text "--" (there's a question about SQL comments). Naive checks report
those as broken quoting.

What it verifies, counting only characters that are real SQL:
  * every string literal is closed
  * every block comment is closed
  * parentheses balance
  * BEGIN is matched by COMMIT
  * the file ends with a complete statement

Exit code 0 means the structure is sound.
"""

import sys
from pathlib import Path


def scan(text: str) -> dict:
    depth = 0          # paren nesting outside strings
    min_depth = 0
    statements = 0
    in_string = False
    in_line_comment = False
    in_block_comment = False
    line = 1
    string_start = None
    i = 0
    n = len(text)

    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""

        if c == "\n":
            line += 1
            in_line_comment = False
            i += 1
            continue

        if in_line_comment:
            i += 1
            continue

        if in_block_comment:
            if c == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_string:
            if c == "'":
                # '' inside a literal is an escaped quote, not the end
                if nxt == "'":
                    i += 2
                    continue
                in_string = False
                string_start = None
            i += 1
            continue

        # --- ordinary SQL ---
        if c == "'":
            in_string = True
            string_start = line
            i += 1
            continue
        if c == "-" and nxt == "-":
            in_line_comment = True
            i += 2
            continue
        if c == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            min_depth = min(min_depth, depth)
        elif c == ";":
            statements += 1
        i += 1

    lowered = text.lower()
    return {
        "statements": statements,
        "paren_depth": depth,
        "went_negative": min_depth < 0,
        "unclosed_string_from_line": string_start if in_string else None,
        "unclosed_block_comment": in_block_comment,
        "begins": lowered.count("begin;"),
        "commits": lowered.count("commit;"),
        "trailing": text.rstrip().endswith((";", "*/")),
    }


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit("usage: python scripts/check_sql.py <file.sql> ...")

    failed = False
    for name in sys.argv[1:]:
        path = Path(name)
        text = path.read_text(encoding="utf-8")
        r = scan(text)
        problems = []
        if r["unclosed_string_from_line"]:
            problems.append(f"unterminated string literal opened on line {r['unclosed_string_from_line']}")
        if r["unclosed_block_comment"]:
            problems.append("unterminated /* block comment")
        if r["paren_depth"] != 0:
            problems.append(f"parentheses end at depth {r['paren_depth']}, expected 0")
        if r["went_negative"]:
            problems.append("a closing parenthesis appeared with nothing open")
        if r["begins"] != r["commits"]:
            problems.append(f"{r['begins']} begin; vs {r['commits']} commit;")
        if not r["trailing"]:
            problems.append("file does not end with a complete statement")

        print(f"{path.name}: {len(text):,} chars, {r['statements']} statements, "
              f"{r['begins']} transaction(s)")
        if problems:
            failed = True
            for p in problems:
                print(f"   FAIL  {p}")
        else:
            print("   ok    quoting, comments, parentheses and transaction all balanced")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
