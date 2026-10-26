#!/usr/bin/env bash
# Regression test for .gitleaks.toml (PIN-19, from Cursor Bugbot on PR #1).
#
# Asserts the scanner (a) CATCHES secret-shaped values in docs/, in
# .env.example and in code files — no path gets a free pass — and
# (b) ALLOWS empty/placeholder assignments.
#
# Cases run in `gitleaks git` mode against throwaway temp repos, matching
# CI's full-history scan exactly (path allowlists behave differently in
# filesystem mode — that mismatch hid the original bug). Fake tokens are
# generated at runtime; nothing secret-shaped is committed in this repo.
#
# Usage:  GITLEAKS=./gitleaks scripts/test-secret-scan.sh
#         (falls back to ./gitleaks, then gitleaks on PATH)
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/.gitleaks.toml"
GITLEAKS="${GITLEAKS:-}"
[ -z "$GITLEAKS" ] && [ -x "$ROOT/gitleaks" ] && GITLEAKS="$ROOT/gitleaks"
[ -z "$GITLEAKS" ] && GITLEAKS="gitleaks"
command -v "$GITLEAKS" >/dev/null 2>&1 || [ -x "$GITLEAKS" ] || {
  echo "FAIL: gitleaks binary not found (set GITLEAKS=/path/to/gitleaks)"; exit 2;
}
command -v git >/dev/null 2>&1 || { echo "FAIL: git not found"; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Assemble the token prefix in pieces so this script itself stays clean
# under the scanner; the full fake only ever exists inside $TMP.
FAKE="gh"'p_'"$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 36)"

failures=0

make_case() { # $1 case dir, $2 relative file, $3 content -> committed temp repo
  mkdir -p "$(dirname "$1/$2")"
  printf '%s\n' "$3" > "$1/$2"
  git -C "$1" init -q
  git -C "$1" config user.email "scan-test@example.invalid"
  git -C "$1" config user.name "scan-test"
  git -C "$1" add -A
  git -C "$1" commit -qm "fixture"
}

scan() { # $1 case dir -> gitleaks exit code (1 = leaks found)
  "$GITLEAKS" git "$1" --config "$CONFIG" --redact --exit-code 1 >/dev/null 2>&1
}

expect_caught() { # $1 label, $2 relative file
  local dir="$TMP/caught-$1"
  make_case "$dir" "$2" "FAKE_TEST_TOKEN=$FAKE"
  if scan "$dir"; then
    echo "FAIL [$1]: secret-shaped value in $2 was NOT caught"
    failures=$((failures + 1))
  else
    echo "PASS [$1]: secret-shaped value in $2 caught"
  fi
}

expect_clean() { # $1 label, $2 relative file, $3 content
  local dir="$TMP/clean-$1"
  make_case "$dir" "$2" "$3"
  if scan "$dir"; then
    echo "PASS [$1]: placeholders in $2 allowed"
  else
    echo "FAIL [$1]: placeholders in $2 were flagged as leaks"
    failures=$((failures + 1))
  fi
}

expect_caught docs "docs/fixture.md"
expect_caught envexample ".env.example"
expect_caught code "src/app.ts"

expect_clean placeholders ".env.example" "META_API_KEY=
SESSION_SECRET=changeme
BASETEN_API_KEY=your-key-here"
expect_clean docsprose "docs/notes.md" "Set META_API_KEY= in your .env (see .env.example)."

if [ "$failures" -ne 0 ]; then
  echo "RESULT: FAIL ($failures case(s)) — .gitleaks.toml regressed; see PIN-19"
  exit 1
fi
echo "RESULT: PASS — scanner catches leaks everywhere, placeholders clean"
