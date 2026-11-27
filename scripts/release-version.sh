#!/usr/bin/env bash
# Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
# Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
# Modified by samschultzponsys, 2026-11-13: two-part MAJOR.MINOR versions that roll over after .9;
# the release version now comes from package.json instead of a manual bump.
# Modified by samschultzponsys, 2026-11-27: calendar versions YY.M.N (year, month, count from 0 each month).
#
# Release versions are YY.M.N (no "v"): the year's last two digits, the month (1-12) and a count
# that starts at 0 every month: 26.11.0, 26.11.1, 26.11.2, ... 26.12.0, ... 27.1.0. package.json
# holds the version exactly so (npm's three parts). Used by the Release workflow.
#
#   release-version.sh current        the version in package.json
#   release-version.sh next [V]       the version to release after V (default: the one in
#                                     package.json) today: this month's next count, or .0 in a new
#                                     month. RELEASE_DATE=YYYY-MM-DD stands in for today (tests).
#   release-version.sh tag vV         a tag's version, checked
#
# Fails when a version isn't YY.M.N.
set -euo pipefail

fail() {
  echo "$*" >&2
  exit 1
}

check() {
  [[ "$1" =~ ^[0-9]{2}\.([1-9]|1[0-2])\.(0|[1-9][0-9]*)$ ]] || fail "'$1' is not a YY.M.N version (e.g. 26.11.0)"
}

package_version() {
  local pkg="${PACKAGE_JSON:-package.json}"
  node -p "require(require('path').resolve(process.argv[1])).version" "$pkg" || fail "can't read $pkg"
}

case "${1:-}" in
  current)
    version="$(package_version)"
    ;;
  next)
    base="${2:-$(package_version)}"
    base="${base#v}"
    # Any earlier version (also the MAJOR.MINOR ones before 26.11) is a starting point.
    [[ "$base" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || fail "'$base' is not a version"
    if [ -n "${RELEASE_DATE:-}" ]; then
      year="$(date -u -d "$RELEASE_DATE" +%y)" || fail "RELEASE_DATE '$RELEASE_DATE' is not a date"
      month="$(date -u -d "$RELEASE_DATE" +%-m)"
    else
      year="$(date -u +%y)"
      month="$(date -u +%-m)"
    fi
    IFS='.' read -r b_year b_month b_count <<< "$base"
    if [ "$b_year" = "$year" ] && [ "$b_month" = "$month" ] && [ -n "${b_count:-}" ]; then
      version="${year}.${month}.$((b_count + 1))"
    else
      version="${year}.${month}.0"
    fi
    ;;
  tag)
    version="${2:-}"
    version="${version#v}"
    ;;
  *)
    fail "usage: release-version.sh current | next [VERSION] | tag vVERSION"
    ;;
esac

check "$version"
echo "$version"
