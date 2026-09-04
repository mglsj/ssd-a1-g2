#!/usr/bin/env bash
#
# Build the Moodle submission archive.
#
# Usage:
#   bash zip.sh            build, refusing to continue if a deliverable is missing
#   bash zip.sh --draft    build anyway, downgrading missing deliverables to warnings
#   bash zip.sh --keep     leave the staging directory behind for inspection

set -euo pipefail
shopt -s nullglob

TEAM="2"
DIR="${TEAM}_a1"
ZIP="${DIR}.zip"
MAX_BYTES=$((20 * 1024 * 1024))

DRAFT=0
KEEP=0
for arg in "$@"; do
    case "$arg" in
        --draft) DRAFT=1 ;;
        --keep)  KEEP=1 ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

# Run from the repository root regardless of where the script was invoked.
cd "$(dirname "$0")"

# --- What goes in ----------------------------------------------------------

# Named explicitly by the assignment brief. Missing or empty is an error.
REQUIRED_FILES=(
    README.md
    docs/relational_erd.png
    docs/mongo_schema_map.json
    sql/01_schema_ddl.sql
    sql/02_indexes.sql
    sql/03_triggers_and_audit.sql
    sql/04_stored_procedures.sql
    sql/05_materialized_views.sql
    sql/06_window_analytics.sql
    mongo/01_collections_and_indexes.js
    mongo/02_workflow3_geonear.js
    mongo/03_workflow4_facet.js
    data_generation/postgres_seeder.py
    data_generation/mongo_seeder.py
    data_generation/requirements.txt
    performance/postgres_explain_analyzes.txt
)

# At least one file must match each of these. The brief names
# mongo_execution_stats.json; capturing Workflows 3 and 4 separately produces
# mongo_execution_stats_workflow3.json and _workflow4.json, so match either.
REQUIRED_GLOBS=(
    "performance/mongo_execution_stats*.json"
)

# Shipped because they make the submission reproducible, but not named by the
# brief. Absent is fine.
OPTIONAL_FILES=(
    sql/test_queries.sql
    data_generation/pyproject.toml
    data_generation/uv.lock
    devenv.nix
    devenv.yaml
    devenv.lock
    .devcontainer/devcontainer.json
    .devcontainer/docker-compose.yml
    .devcontainer/post-create.sh
    .gitattributes
    .gitignore
    mongo/package.json
    mongo/package-lock.json
    mongo/jsconfig.json
)

OPTIONAL_GLOBS=(
    "mongo/types/*.d.ts"
)

# --- Preflight -------------------------------------------------------------

problems=0
warnings=0

for f in "${REQUIRED_FILES[@]}"; do
    if [ ! -e "$f" ]; then
        echo "  MISSING  $f"
        problems=$((problems + 1))
    elif [ ! -s "$f" ]; then
        echo "  EMPTY    $f"
        problems=$((problems + 1))
    fi
done

for g in "${REQUIRED_GLOBS[@]}"; do
    matches=($g)
    if [ ${#matches[@]} -eq 0 ]; then
        echo "  MISSING  $g (no file matches)"
        problems=$((problems + 1))
    fi
done

# The brief requires the README to carry the final commit hash and the
# EXPLAIN output. Catch the placeholders this repo's README template uses.
if grep -qE '^\*\*Final commit hash:\*\*\s*`?\s*`?\s*$' README.md; then
    echo "  WARNING  README.md: 'Final commit hash' is still blank"
    warnings=$((warnings + 1))
fi
if grep -q 'FILL IN' README.md; then
    echo "  WARNING  README.md still contains $(grep -c 'FILL IN' README.md) 'FILL IN' placeholder(s)"
    warnings=$((warnings + 1))
fi
if grep -qE '^\- .*\[\]\s*$' README.md; then
    echo "  WARNING  README.md has a team member with an empty roll number"
    warnings=$((warnings + 1))
fi

if [ "$problems" -gt 0 ]; then
    if [ "$DRAFT" -eq 0 ]; then
        echo
        echo "$problems deliverable(s) missing or empty. Fix them, or re-run with --draft."
        exit 1
    fi
    echo
    echo "Continuing anyway (--draft): $problems deliverable(s) missing or empty."
fi

# --- Stage -----------------------------------------------------------------

rm -rf "$DIR" "$ZIP"
mkdir -p "$DIR"

stage() {
    local f="$1"
    [ -e "$f" ] || return 0
    mkdir -p "$DIR/$(dirname "$f")"
    cp -p "$f" "$DIR/$f"
}

for f in "${REQUIRED_FILES[@]}" "${OPTIONAL_FILES[@]}"; do
    stage "$f"
done
for g in "${REQUIRED_GLOBS[@]}" "${OPTIONAL_GLOBS[@]}"; do
    for f in $g; do
        stage "$f"
    done
done

# Belt and braces: the allowlist should make this impossible, but a wrong
# glob one day would not announce itself.
banned=$(find "$DIR" \( \
    -name '__pycache__' -o -name '.venv' -o -name 'node_modules' -o \
    -name '.devenv' -o -name '*.dump' -o -name '*.sql.gz' -o -name '*.csv' \
    \) -print)
if [ -n "$banned" ]; then
    echo "ERROR: banned artefacts staged:" >&2
    echo "$banned" >&2
    exit 1
fi

# --- Archive ---------------------------------------------------------------

# Find a Python that actually runs, not merely one that is on PATH: Windows
# ships a python3 shim in WindowsApps that exists, resolves, and then fails
# with a Microsoft Store advert.
PYBIN=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
        "$candidate" -c "import zipfile" >/dev/null 2>&1; then
        PYBIN="$candidate"
        break
    fi
done

if command -v zip >/dev/null 2>&1; then
    zip -qr "$ZIP" "$DIR"
elif [ -n "$PYBIN" ]; then
    # devenv.nix does not provide `zip`; Python is always present because the
    # seeders need it. Add pkgs.zip to devenv.nix to take the faster path.
    "$PYBIN" - "$ZIP" "$DIR" <<'PY'
import os
import sys
import zipfile

zip_path, root = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in sorted(filenames):
            archive.write(os.path.join(dirpath, name))
PY
else
    echo "ERROR: no working 'zip' or 'python3' found to build the archive." >&2
    echo "Run this inside the dev container (devenv shell), or add pkgs.zip" >&2
    echo "to devenv.nix." >&2
    rm -rf "$DIR"
    exit 1
fi

# --- Report ----------------------------------------------------------------

file_count=$(find "$DIR" -type f | wc -l)
bytes=$(wc -c < "$ZIP")

echo
echo "Staged files:"
find "$DIR" -type f | sort | sed "s|^$DIR/|  |"

echo
printf 'Archive : %s\n' "$ZIP"
printf 'Files   : %s\n' "$file_count"
printf 'Size    : %s bytes (%.2f MB, limit 20 MB)\n' \
    "$bytes" "$(echo "$bytes" | awk '{print $1/1048576}')"

if [ "$bytes" -gt "$MAX_BYTES" ]; then
    echo "ERROR: archive exceeds the 20 MB limit." >&2
    exit 1
fi

if [ "$KEEP" -eq 0 ]; then
    rm -rf "$DIR"
else
    echo "Staging directory kept at ./$DIR (--keep)."
fi

if [ "$warnings" -gt 0 ]; then
    echo
    echo "Built with $warnings warning(s) -- see above before submitting."
fi
