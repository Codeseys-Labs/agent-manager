#!/bin/sh
# Bump version, commit, tag, and push to trigger release workflow.
#
# Usage:
#   ./scripts/bump-version.sh 0.2.0
#   ./scripts/bump-version.sh 0.2.0 --dry-run

set -eu

# --- Args ---

VERSION=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      printf "Usage: %s <version> [--dry-run]\n" "$0"
      printf "\nExample: %s 0.2.0\n" "$0"
      exit 0
      ;;
    -*)
      printf "Unknown option: %s\n" "$1" >&2
      exit 1
      ;;
    *)
      if [ -z "$VERSION" ]; then
        VERSION="$1"
      else
        printf "Unexpected argument: %s\n" "$1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  printf "Error: version argument required\n" >&2
  printf "Usage: %s <version> [--dry-run]\n" "$0" >&2
  exit 1
fi

# Validate version format (semver: X.Y.Z with optional pre-release)
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *)
    printf "Error: invalid version format '%s' (expected X.Y.Z)\n" "$VERSION" >&2
    exit 1
    ;;
esac

TAG="v${VERSION}"

# --- Check for clean working tree ---

if [ -n "$(git status --porcelain)" ]; then
  printf "Error: working tree is not clean. Commit or stash changes first.\n" >&2
  exit 1
fi

# --- Check tag doesn't already exist ---

if git rev-parse "$TAG" >/dev/null 2>&1; then
  printf "Error: tag %s already exists\n" "$TAG" >&2
  exit 1
fi

# --- Update version ---

printf "Bumping version to %s\n" "$VERSION"

if [ "$DRY_RUN" = "1" ]; then
  printf "[dry-run] Would update package.json version to %s\n" "$VERSION"
  printf "[dry-run] Would commit: chore: bump version to %s\n" "$VERSION"
  printf "[dry-run] Would create tag: %s\n" "$TAG"
  printf "[dry-run] Would push commit and tag to origin\n"
  exit 0
fi

# Use bun if available, fall back to node
if command -v bun >/dev/null 2>&1; then
  RUNNER="bun"
  bun -e "
    const pkg = await Bun.file('package.json').json();
    pkg.version = '${VERSION}';
    await Bun.write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
elif command -v node >/dev/null 2>&1; then
  RUNNER="node"
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.version = '${VERSION}';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
else
  printf "Error: bun or node is required\n" >&2
  exit 1
fi

printf "Updated package.json\n"

# --- Git commit and tag ---

git add package.json
git commit -m "chore: bump version to ${VERSION}"
printf "Created commit\n"

git tag -a "$TAG" -m "Release ${TAG}"
printf "Created tag %s\n" "$TAG"

# --- Push ---

git push origin HEAD
git push origin "$TAG"
printf "\nPushed to origin. Release workflow will run for %s.\n" "$TAG"
