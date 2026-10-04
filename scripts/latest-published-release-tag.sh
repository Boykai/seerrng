#!/usr/bin/env bash
set -euo pipefail

repository="${GITHUB_REPOSITORY:-}"
if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo 'GITHUB_REPOSITORY must identify the repository whose releases are being prepared.' >&2
  exit 2
fi

if ! published_tags="$(
  gh api --paginate -X GET -f per_page=100 "repos/${repository}/releases" \
    --jq '.[] | select(.draft == false and .prerelease == false) | .tag_name'
  )"; then
  echo "Unable to query published releases for ${repository}." >&2
  exit 1
fi

# Draft releases can be published out of order after a recovery run. Choose the
# highest stable version, not the release that happened to publish most recently.
latest_published_tag="$(
  printf '%s\n' "$published_tags" |
    sed -nE '/^v[0-9]+\.[0-9]+\.[0-9]+$/p' |
    LC_ALL=C sort -V |
    tail -n 1
)"

if [[ ! "$latest_published_tag" =~ ^v[0-9][0-9A-Za-z._+-]{0,126}$ ]]; then
  echo "Unable to determine the latest published release tag for ${repository}." >&2
  exit 1
fi

if ! git rev-parse --verify --quiet "${latest_published_tag}^{commit}" >/dev/null; then
  echo "Latest published release tag ${latest_published_tag} is missing from the local checkout." >&2
  exit 1
fi

printf '%s\n' "$latest_published_tag"
