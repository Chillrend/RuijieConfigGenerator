#!/bin/sh
set -e

if [ -z "$GITHUB_TOKEN" ]; then
  echo "GITHUB_TOKEN secret not configured in Woodpecker; skipping auto-tag push."
  exit 0
fi

git config user.name "woodpecker-ci[bot]"
git config user.email "ci@pnj.ac.id"

# Ensure all tags are fetched from origin
git fetch --tags origin

LATEST_TAG=$(git tag -l "v*" --sort=-v:refname | head -n1)

if [ -z "$LATEST_TAG" ]; then
  NEXT_TAG="v0.5.0"
else
  # Strip leading 'v' using sed (avoids shell bracket interpolation issues)
  VERSION=$(echo "$LATEST_TAG" | sed 's/^v//')
  MAJOR=$(echo "$VERSION" | cut -d. -f1)
  MINOR=$(echo "$VERSION" | cut -d. -f2)
  PATCH=$(echo "$VERSION" | cut -d. -f3)

  MAJOR=${MAJOR:-0}
  MINOR=${MINOR:-0}
  PATCH=${PATCH:-0}

  NEXT_PATCH=$((PATCH + 1))
  NEXT_TAG="v${MAJOR}.${MINOR}.${NEXT_PATCH}"
fi

echo "Current tag: $LATEST_TAG"
echo "Automated Release: tagging $NEXT_TAG"

git tag "$NEXT_TAG"
git push "https://x-access-token:${GITHUB_TOKEN}@github.com/Chillrend/RuijieConfigGenerator.git" "$NEXT_TAG"
