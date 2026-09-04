FROM mcr.microsoft.com/devcontainers/base:ubuntu

# PostgreSQL client + MongoDB Shell (mongosh), installed directly via apt
# instead of devcontainer features (avoids the mongosh-homebrew feature,
# which builds Homebrew from source and can hang/take 10+ minutes).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        postgresql-client \
    && curl -fsSL https://pgp.mongodb.com/server-8.0.asc | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor \
    && echo "deb [ arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/8.0 multiverse" \
        | tee /etc/apt/sources.list.d/mongodb-org-8.0.list \
    && apt-get update && apt-get install -y --no-install-recommends mongodb-mongosh \
    && rm -rf /var/lib/apt/lists/*

# uv: fast Python package manager, installed directly via the official
# installer (avoids the uv devcontainer feature's GitHub Releases lookup,
# which can stall or hit GitHub's API rate limit on repeated builds).
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Python comes from uv, never from apt.
#
# This base image carries Ubuntu's python3-minimal as a transitive dependency
# of other packages. That is a PARTIAL standard library: `os` and `random`
# import fine, but modules living in libpython3.x-stdlib -- `uuid` among them
# -- are absent. A venv built on it fails at `import uuid` with a
# ModuleNotFoundError that reads like a missing third-party package.
#
# only-managed forbids uv from selecting that interpreter at all, so the
# failure cannot come back via a stray `uv venv` or a wider requires-python.
# The install dir is shared rather than per-user because `uv python install`
# runs here as root while the container runs as vscode.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_PREFERENCE=only-managed

# Bake the interpreter into the image so container creation does not depend on
# a download. 3.12 rather than latest: psycopg2-binary and pymongo wheels lag
# new CPython releases, and a seeder that cannot build psycopg2 is no better
# than one that cannot import uuid.
# Owned by vscode, not root, so that bumping data_generation/.python-version
# to a version that is not baked in here still works at runtime instead of
# failing on a read-only install directory.
RUN uv python install 3.12 \
    && chown -R vscode:vscode /opt/uv \
    && chmod -R a+rX /opt/uv
