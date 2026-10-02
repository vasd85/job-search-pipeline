#!/usr/bin/env bash
# cv-builder/build.sh - one-command content preflight, DOCX build, temporary
# PDF/PNG visual QA, structural QA, and page-budget gate for /generate-cv.
#
# Usage:
#   tools/cv-builder/build.sh <cv.json> [--brief <application-brief.json> | --general]
#                               [--qa-dir <directory>]
#                               [--docx-renderer <render_docx.py> --python <python>]
#                               [--pipeline-staging-dir <directory> --workspace-root <directory>]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$DIR/check-dependencies.mjs" >/dev/null

exec node "$DIR/build.mjs" "$@"
