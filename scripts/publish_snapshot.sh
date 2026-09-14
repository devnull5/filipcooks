#!/usr/bin/env bash
# ---------------------------------------------------------------------
# Regenerate data/recipes.json on top of the newest main and push it.
# Run by .github/workflows/snapshot.yml.
#
# Why the loop: the first version checked out once, committed, and pushed.
# If main moved during the run — a push landing mid-run, or a re-run, which
# always starts from the run's original commit — the push was rejected and
# the job failed (2026-09-14). Now every attempt starts from the latest
# main, so a rejected push just means: fetch, rebuild, try again.
#
# This hard-resets the working tree, so it refuses to run outside CI unless
# SNAPSHOT_ALLOW_RESET=1 is set. Never point that at a checkout with work in it.
# ---------------------------------------------------------------------
set -euo pipefail

if [ -z "${CI:-}" ] && [ -z "${SNAPSHOT_ALLOW_RESET:-}" ]; then
  echo "Refusing to run: this resets the working tree. Set SNAPSHOT_ALLOW_RESET=1 in a throwaway clone."
  exit 1
fi

BRANCH="${SNAPSHOT_BRANCH:-main}"
REMOTE="${SNAPSHOT_REMOTE:-origin}"
PYTHON="${PYTHON:-python3}"
ATTEMPTS=3

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in $(seq 1 "$ATTEMPTS"); do
  git fetch --quiet "$REMOTE" "$BRANCH"
  git reset --quiet --hard "$REMOTE/$BRANCH"

  "$PYTHON" scripts/snapshot.py

  if git diff --quiet -- data/recipes.json; then
    echo "Snapshot unchanged; nothing to commit."
    exit 0
  fi

  git add data/recipes.json
  git commit --quiet -m "Refresh recipe snapshot"

  if git push --quiet "$REMOTE" "HEAD:$BRANCH"; then
    echo "Snapshot pushed on attempt $attempt."
    # Pushes made with the workflow token may not trigger a Pages build on
    # their own, so ask for one. Harmless if redundant.
    if [ -n "${GH_TOKEN:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
      gh api -X POST "repos/$GITHUB_REPOSITORY/pages/builds" > /dev/null \
        || echo "Pages build request failed; the next push will rebuild."
    fi
    exit 0
  fi

  echo "Push rejected because $BRANCH moved during the run; rebuilding on the latest $BRANCH ($attempt/$ATTEMPTS)."
  sleep $((attempt * 3))
done

echo "::error::Could not push the snapshot after $ATTEMPTS attempts."
exit 1
