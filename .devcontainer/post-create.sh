#!/usr/bin/env bash
set -e

# Python dependencies.
#
# The workspace is bind-mounted from the host, so data_generation/.venv may
# have been created by a different OS (a Windows host running `uv run`) or
# against the container's partial system Python. Either way it will not work
# in here, and uv will happily reuse a broken venv rather than replace it.
# Test it and rebuild if it cannot import the standard library.
if [ -f "data_generation/pyproject.toml" ]; then
  (
    cd data_generation

    if [ -x .venv/bin/python ] && ! .venv/bin/python -c "import uuid" >/dev/null 2>&1; then
      echo "Discarding unusable data_generation/.venv (stale or built elsewhere)."
      rm -rf .venv
    fi

    uv sync

    # Fail container creation loudly here rather than partway through a
    # 500k-document seed. Each of these has bitten this project at least once.
    uv run python -c "import uuid, psycopg2, pymongo, faker" \
      || { echo "Python environment is broken; see .devcontainer/Dockerfile."; exit 1; }
  )
fi

# Node dependencies. Only the mongosh type-checking harness needs these; the
# .js files are run by mongosh, not node.
if [ -f "mongo/package.json" ]; then
  (cd mongo && npm install)
fi

echo ""
echo "Dev container ready."
echo "PostgreSQL: postgresql://postgres:postgres@postgres:5432/app"
echo "MongoDB:    mongodb://mongo:27017/app"
