# CS6.302 - Software System Development

Assignment 1 - Database Design

## Team and Project Details

**Group:** 2

**Project:** 3 StaySpot - Vacation Rental & Experiences

**Team Members:**
- Anirudh Bandi [2026201058]
- Dhruv Bhuva []
- Lakshyajeet Singh Jalal [2026201063]
- Thejas Gowda [2026201023]

**Repository:** https://github.com/mglsj/ssd-a1-g2

**Final commit hash:** `<FILL IN AFTER THE FINAL COMMIT>`

---

## Repository Layout

```
docs/
  relational_erd.png            Entity-relationship diagram (PostgreSQL)
  mongo_schema_map.json         Document structure & validation models (MongoDB)
sql/
  01_schema_ddl.sql             Tables, types, PK/FK, CHECK constraints
  02_indexes.sql                Partial, covering and secondary indexes
  03_triggers_and_audit.sql     Wallet audit trigger + append-only enforcement
  04_stored_procedures.sql      Workflow 1: atomic booking (transaction control)
  05_materialized_views.sql     Property performance MV + concurrent refresh
  06_window_analytics.sql       Workflow 2: 7-day moving average, DENSE_RANK
  test_queries.sql              10 verification tests for the engine logic
mongo/
  01_collections_and_indexes.js Collections, $jsonSchema validators, 2dsphere + TTL
  02_workflow3_geonear.js       Workflow 3: trending search hotspots
  03_workflow4_facet.js         Workflow 4: multi-faceted review analytics
  types/                        TypeScript harness that type-checks the above
data_generation/
  postgres_seeder.py            10k guests, 2k properties, 50k bookings, 100k ledger rows
  mongo_seeder.py               2k amenity docs, 150k reviews, 500k geospatial pings
performance/
  postgres_explain_analyzes.txt EXPLAIN (ANALYZE, BUFFERS) for Workflow 2
  mongo_execution_stats*.json   explain("executionStats") for Workflows 3 and 4
```

---

## Setup

1. Install [VS Code](https://code.visualstudio.com/) and [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Clone and open the repository:

   ```sh
   git clone https://github.com/mglsj/ssd-a1-g2.git && cd ssd-a1-g2 && code .
   ```

3. Install the **Dev Containers** extension (`ms-vscode-remote.remote-containers`).
4. `CTRL+SHIFT+P` / `CMD+SHIFT+P` → **Dev Containers: Rebuild and Reopen in Container**.
5. Wait for the build (5-10 minutes on first run). It provisions PostgreSQL 17, MongoDB 8,
   `psql`, `mongosh`, `uv`, and a managed CPython 3.12.

> **Why CPython comes from uv, not apt:** the base image carries Ubuntu's
> `python3-minimal` as a transitive dependency. That is a *partial* standard
> library — `os` and `random` import, but `uuid` does not. The Dockerfile sets
> `UV_PYTHON_PREFERENCE=only-managed` so uv can never select it.

---

## Runbook

Every command below is run **from `/workspace` inside the dev container
terminal**, in this order. Steps 1-4 build and populate both databases; steps
5-8 demonstrate the four workflows; step 9 captures the performance evidence.

### Step 0 — Set the PostgreSQL connection string

`MONGO_URI` is already exported by the container; `DB` is not. This is
per-shell, so re-run it in any new terminal.

```sh
cd /workspace && export DB="postgresql://postgres:postgres@postgres:5432/app"
```

Confirm both servers are reachable before going further:

```sh
psql "$DB" -c "SELECT version();" && mongosh --quiet "$MONGO_URI" --eval "db.runCommand({ping:1})"
```

### Step 1 — Build the PostgreSQL schema

Each file drops its own objects first, so this is safe to re-run. `ON_ERROR_STOP=1`
aborts on the first failure rather than running later files against a half-built schema.

```sh
psql "$DB" -v ON_ERROR_STOP=1 -f sql/01_schema_ddl.sql -f sql/02_indexes.sql -f sql/03_triggers_and_audit.sql -f sql/04_stored_procedures.sql -f sql/05_materialized_views.sql
```

`NOTICE: ... does not exist, skipping` on a clean database is expected — that is
the idempotent `DROP ... IF EXISTS` guards.

### Step 2 — Seed PostgreSQL

10,000 guests, 2,000 properties, 50,000 bookings, 100,000 wallet audit rows.

```sh
uv run --project data_generation data_generation/postgres_seeder.py
```

### Step 3 — Create the MongoDB collections and indexes

Drops and recreates all three collections with their validators, the 2dsphere
index and the 2-hour TTL index.

```sh
mongosh "$MONGO_URI" mongo/01_collections_and_indexes.js
```

### Step 4 — Seed MongoDB

Must run **after** step 2: this seeder reads guest and property UUIDs out of
PostgreSQL so that every `binData` id resolves against the relational store.

```sh
uv run --project data_generation data_generation/mongo_seeder.py
```

> ⏱ **Time-sensitive.** `SearchSessions` carries a TTL index of 7200s, so its
> 500,000 pings are timestamped inside the trailing 110 minutes and the
> collection drains itself roughly two hours after seeding. Run steps 7 and 9
> soon after this, or re-run this step first.

### Step 5 — Verify the engine logic (Workflow 1 and the constraints)

Ten tests: the happy-path booking, insufficient funds, a negative charge, an
unknown guest, the partial unique index in both directions, all three
audit-immutability paths, the FK `RESTRICT`, two CHECK constraints, and the
concurrent MV refresh.

```sh
psql "$DB" -f sql/test_queries.sql
```

Expected: Test 1 a `NOTICE ... committed`; Tests 2-4 a `WARNING ... rejected`
with the balance unchanged; Tests 5 and 7-9 deliberate `ERROR`s.

### Step 6 — Workflow 2: window analytics

7-day moving average of booking revenue per property, ranked with `DENSE_RANK()`.

```sh
psql "$DB" -f sql/06_window_analytics.sql
```

### Step 7 — Workflow 3: geospatial hotspots

Clusters recent search sessions within 5 km into 1 km concentric rings via `$geoNear`.

```sh
mongosh "$MONGO_URI" mongo/02_workflow3_geonear.js
```

### Step 8 — Workflow 4: faceted review analytics

Rating distribution, top tags via `$unwind`, and the overall average — in one `$facet`.

```sh
mongosh "$MONGO_URI" mongo/03_workflow4_facet.js
```

### Step 9 — Capture the performance evidence

```sh
mkdir -p performance && { echo "EXPLAIN (ANALYZE, BUFFERS)"; cat sql/06_window_analytics.sql; } | psql "$DB" -f - > performance/postgres_explain_analyzes.txt
```

```sh
mongosh --quiet "$MONGO_URI" --eval "EXPLAIN=true" -f mongo/02_workflow3_geonear.js > performance/mongo_execution_stats_workflow3.json
```

```sh
mongosh --quiet "$MONGO_URI" --eval "EXPLAIN=true" -f mongo/03_workflow4_facet.js > performance/mongo_execution_stats_workflow4.json
```

### Optional — Type-check the mongosh scripts

The `.js` files under `mongo/` are checked against the `$jsonSchema` validators
themselves; editing a validator changes the document type `insertOne` is
checked against, with no generated file to refresh.

```sh
cd mongo && npm run typecheck
```

---

## Connection Details

|                | Inside the dev container                          | From the host                                       |
| -------------- | ------------------------------------------------- | --------------------------------------------------- |
| **PostgreSQL** | `postgresql://postgres:postgres@postgres:5432/app` | `postgresql://postgres:postgres@localhost:5432/app` |
| **MongoDB**    | `mongodb://mongo:27017/app`                        | `mongodb://localhost:27017/app`                     |

---

## Design Assumptions

The brief leaves the following open. Each choice is also documented at the point
in the code where it applies.

### Schema

1. **Surrogate keys are UUIDs**, generated server-side with `gen_random_uuid()`
   (core since PostgreSQL 13; no `pgcrypto` needed).
2. **`bookings` carries an explicit stay window** (`check_in_date`,
   `check_out_date`). The brief lists neither column, but its materialized view
   requires "total nights booked", which cannot be recovered from a single
   `created_at` timestamp. Nights are `check_out_date - check_in_date`.
3. **`wallet_audit_logs` is append-only.** Its rows must outlive the guest they
   describe, so the FK is `ON DELETE RESTRICT`, not `CASCADE` — an audit trail a
   `DELETE` can erase is not an audit trail. `UPDATE`, `DELETE` and `TRUNCATE`
   are all rejected by trigger.
4. **`amount_changed` is stored as a magnitude**; `action_type` carries the sign.
5. Coordinates are range-checked in PostgreSQL (`latitude` ±90, `longitude` ±180)
   because they feed MongoDB's 2dsphere index, which rejects out-of-range values.

### Workflow 1 — Atomic booking

6. **The procedure does not pre-check the balance.** It deducts and lets
   `guests_wallet_balance_check` decide, catching `check_violation`. A
   pre-flight `IF` would make the constraint unreachable dead weight.
7. **It performs its own transaction control**, so it must be `CALL`ed at the
   top level of a session. Invoking it inside an explicit transaction, a `DO`
   block or another function raises `2D000`.

### Workflow 2 — Window analytics

8. Revenue is attributed to the day a booking was **created**, not the nights stayed.
9. **All statuses count** toward revenue — a `CONFIRMED` booking is committed money.
10. Day boundaries are pinned to **UTC**. `DATE(created_at)` on a `TIMESTAMPTZ`
    resolves against the client session's `TimeZone`, so two sessions would
    otherwise bucket the same data differently.
11. The report covers the trailing **30 days**, scanning 36 so the earliest
    reported day has a full 7-day lead-in instead of a truncated average. The
    bound is also what keeps the query index-served.

### Materialized view

12. `gross_revenue` counts every booking; `realised_*` is the `COMPLETED`-only
    subset. Properties with no bookings are retained with zeroes, so the view is
    a complete roster rather than only the booked properties.

### MongoDB

13. **Database name is `app`**, matching the PostgreSQL side.
14. `guest_id` and `property_id` are the PostgreSQL UUIDs stored as **binData
    subtype 4**. `$jsonSchema` cannot assert a byte length, so each validator
    pairs the schema with `$expr: { $binarySize: ... } == 16`.
15. **`PropertyAmenities` sets `additionalProperties: true`** deliberately — a
    flexible catalogue is the reason to reach for a document store here. The
    other two collections are closed.
16. **The 2-hour TTL means `SearchSessions` is ephemeral by design.** Seeded
    pings are timestamped within the trailing 110 minutes; the collection drains
    itself two hours later.
17. Workflow 3 centres its search on an **existing session's coordinates** rather
    than a hard-coded landmark, which against seeded data would return empty rings.
18. Workflow 4 uses a **30-day window** so its leading `$match` is selective
    enough to be index-served. A `$facet`'s sub-pipelines cannot use an index,
    so that `$match` is the only stage that can avoid a collection scan.

---

## Performance Evidence

Full plans are in `performance/`. Key results:

### Workflow 2 — `EXPLAIN (ANALYZE, BUFFERS)`

<!-- PASTE the plan from performance/postgres_explain_analyzes.txt here.
     Include at minimum the scan node, Planning Time and Execution Time. -->

```
<FILL IN>
```

### Workflow 3 — `explain("executionStats")`

<!-- PASTE the winningPlan / executionStats summary from
     performance/mongo_execution_stats_workflow3.json here. -->

```
<FILL IN>
```

### Workflow 4 — `explain("executionStats")`

<!-- PASTE the winningPlan / executionStats summary from
     performance/mongo_execution_stats_workflow4.json here. -->

```
<FILL IN>
```

### Indexes and what they serve

| Index                                   | Table / Collection  | Serves                                            |
| --------------------------------------- | ------------------- | ------------------------------------------------- |
| `idx_active_stay` (partial, unique)      | `bookings`          | One `CHECKED_IN` stay per guest                    |
| `idx_bookings_created_at_property` (covering) | `bookings`     | Workflow 2 — Index Only Scan                       |
| `idx_bookings_completed_property` (partial)   | `bookings`     | Realised-revenue reads, materialized view          |
| `idx_bookings_property_created_at`      | `bookings`          | Per-property history; property `ON DELETE CASCADE` |
| `idx_bookings_guest_created_at`         | `bookings`          | Per-guest history; guest `ON DELETE CASCADE`       |
| `idx_wallet_audit_logs_guest_timestamp` | `wallet_audit_logs` | Guest ledger; the FK `RESTRICT` check              |
| `idx_sessions_geo_recent` (2dsphere)    | `SearchSessions`    | Workflow 3 `$geoNear` + recency filter             |
| `ttl_sessions_created_at` (TTL 7200s)   | `SearchSessions`    | 2-hour expiry                                      |
| `idx_reviews_recent`                    | `PropertyReviews`   | Workflow 4's leading `$match`                      |
| `idx_amenities_property` (unique)       | `PropertyAmenities` | One amenity document per property                  |

---

## Building the Submission Archive

`git archive` includes only committed, non-ignored files, which keeps
`node_modules/`, `.venv/`, `__pycache__/` and `.devenv/` out of the zip.

```sh
cd /workspace && git archive --format=zip HEAD -o 2_a1.zip && ls -lh 2_a1.zip
```
