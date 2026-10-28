#!/bin/bash
set -euo pipefail

# Print only when there is work to do: whatever this prints joins the
# session's context on every start, resume and compaction.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# npm ci wipes node_modules first, so skip it while the installed tree
# matches the lockfile.
if [ -f package-lock.json ]; then
  SENTINEL="node_modules/.lockfile-sha1"
  LOCK_SHA=$(sha1sum package-lock.json | cut -d' ' -f1)
  if [ "$(cat "$SENTINEL" 2>/dev/null)" != "$LOCK_SHA" ]; then
    echo "Installing npm dependencies..."
    npm ci
    echo "$LOCK_SHA" > "$SENTINEL"
  fi
fi
