#!/usr/bin/env bash
# Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
# Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
# Modified by samschultzponsys, 2026-11-13: two-part MAJOR.MINOR versions that roll over after .9;
# the release version now comes from package.json instead of a manual bump.
#
# Release versions are MAJOR.MINOR (no "v"): 1.0, 1.1, ... 1.9, 2.0, ... The minor part never
# goes past 9; the release after X.9 is (X+1).0. package.json holds the version as MAJOR.MINOR.0
# because npm requires three parts. Used by the Release workflow.
#
#   release-version.sh current        the version in package.json, as MAJOR.MINOR
#   release-version.sh next [X.Y]     the version after X.Y (default: the one in package.json)
#   release-version.sh tag vX.Y       a tag's version, checked
#
# Fails when a version isn't MAJOR.MINOR with MINOR 0-9.
set -euo pipefail

fail() {
  echo "$*" >&2
  exit 1
}

check() {
  [[ "$1" =~ ^[0-9]+\.[0-9]$ ]] || fail "'$1' is not a MAJOR.MINOR version (MINOR 0-9)"
}

current() {
  local pkg="${PACKAGE_JSON:-package.json}"
  local v
  v="$(node -p "require(require('path').resolve(process.argv[1])).version" "$pkg")" || fail "can't read $pkg"
  [[ "$v" =~ ^([0-9]+\.[0-9])\.0$ ]] || fail "package.json version '$v' must be MAJOR.MINOR.0 with MINOR 0-9"
  echo "${BASH_REMATCH[1]}"
}

case "${1:-}" in
  current)
    version="$(current)"
    ;;
  next)
    base="${2:-$(current)}"
    base="${base#v}"
    check "$base"
    IFS='.' read -r major minor <<< "$base"
    if [ "$minor" -ge 9 ]; then
      major=$((major + 1))
      minor=0
    else
      minor=$((minor + 1))
    fi
    version="${major}.${minor}"
    ;;
  tag)
    version="${2:-}"
    version="${version#v}"
    ;;
  *)
    fail "usage: $0 current | $0 next [X.Y] | $0 tag vX.Y"
    ;;
esac

check "$version"
echo "$version"
