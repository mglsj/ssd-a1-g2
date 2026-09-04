# CS6.302 - Software System Development

Assignment 1 - Database Design

## Team and Project Details

**Group:** 2

**Project:** 3 StaySpot - Vacation Rental & Experiences

**Team Members:**
- Anirudh Bandi [2026201058]
- Dhruv Bhuva [2026201036]
- Lakshyajeet Singh Jalal [2026201063]
- Thejas Gowda [2026201023]

**Repository:** https://github.com/mglsj/ssd-a1-g2

**Final commit hash:** ``

---

## Repository Layout

```
docs/
  relational_erd.png                Entity-relationship diagram (PostgreSQL)
  mongo_schema_map.json             Document structure & validation models (MongoDB)
sql/
  01_schema_ddl.sql                 Tables, types, PK/FK, CHECK constraints
  02_indexes.sql                    Partial, covering and secondary indexes
  03_triggers_and_audit.sql         Wallet audit trigger + append-only enforcement
  04_stored_procedures.sql          Workflow 1: atomic booking (transaction control)
  05_materialized_views.sql         Property performance MV + concurrent refresh
  06_window_analytics.sql           Workflow 2: 7-day moving average, DENSE_RANK
  test_queries.sql                  10 verification tests for the engine logic
mongo/
  01_collections_and_indexes.js     Collections, $jsonSchema validators, 2dsphere + TTL
  02_workflow3_geonear.js           Workflow 3: trending search hotspots
  03_workflow4_facet.js             Workflow 4: multi-faceted review analytics
  types/                            TypeScript harness that type-checks the above
data_generation/
  postgres_seeder.py                10k guests, 2k properties, 50k bookings, 100k ledger rows
  mongo_seeder.py                   2k amenity docs, 150k reviews, 500k geospatial pings
performance/
  postgres_explain_analyzes.txt     EXPLAIN (ANALYZE, BUFFERS) for Workflow 2
  mongo_execution_stats*.json       explain("executionStats") for Workflows 3 and 4
```

## Postgres Schema

```mermaid
erDiagram
    guests     ||--o{ bookings           : "places (ON DELETE CASCADE)"
    properties ||--o{ bookings           : "is booked as (ON DELETE CASCADE)"
    guests     ||--o{ wallet_audit_logs  : "ledger of (ON DELETE RESTRICT)"

    guests {
        uuid         id             PK "DEFAULT gen_random_uuid()"
        varchar_200  name              "CHECK length(trim(name)) > 0"
        decimal_10_2 wallet_balance    "DEFAULT 0.00 -- CHECK >= 0 : rejects over-spend"
    }

    properties {
        uuid         id          PK "DEFAULT gen_random_uuid()"
        varchar_300  title
        decimal_10_2 base_price     "DEFAULT 0.00 -- CHECK >= 0"
        float8       latitude       "CHECK BETWEEN -90 AND 90"
        float8       longitude      "CHECK BETWEEN -180 AND 180"
    }

    bookings {
        uuid           id             PK "DEFAULT gen_random_uuid()"
        uuid           guest_id       FK "-- guests.id"
        uuid           property_id    FK "-- properties.id"
        decimal_10_2   total_cost        "CHECK > 0"
        booking_status status            "ENUM CONFIRMED, CHECKED_IN, COMPLETED"
        date           check_in_date
        date           check_out_date    "CHECK check_out_date > check_in_date"
        timestamptz    created_at        "DEFAULT NOW()"
    }

    wallet_audit_logs {
        uuid          id             PK "DEFAULT gen_random_uuid()"
        uuid          guest_id       FK "-- guests.id : RESTRICT, append-only"
        decimal_10_2  amount_changed    "CHECK > 0 -- magnitude, sign is in action_type"
        wallet_action action_type       "ENUM DEBIT, CREDIT"
        decimal_10_2  balance_after     "CHECK >= 0"
        timestamptz   timestamp         "DEFAULT NOW()"
    }
```

## Setup

1. Install [VS Code](https://code.visualstudio.com/) and [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Clone and open the repository:

   ```sh
   git clone https://github.com/mglsj/ssd-a1-g2.git && cd ssd-a1-g2 && code .
   ```

3. Install the **Dev Containers** extension (`ms-vscode-remote.remote-containers`).
4. `CTRL+SHIFT+P` / `CMD+SHIFT+P` → **Dev Containers: Rebuild and Reopen in Container**.
5. Wait for the build (5-10 minutes on first run). It provisions PostgreSQL 17, MongoDB 8,
   `psql`, `mongosh`, `uv`.
---

## Connection Details

|                | Inside the dev container                           | From the host                                       |
| -------------- | -------------------------------------------------- | --------------------------------------------------- |
| **PostgreSQL** | `postgresql://postgres:postgres@postgres:5432/app` | `postgresql://postgres:postgres@localhost:5432/app` |
| **MongoDB**    | `mongodb://mongo:27017/app`                        | `mongodb://localhost:27017/app`                     |

---

## Runbook

### Step 0 - Confirm the environment variables

Enable devenv environment

```sh
devenv shell
```

Confirm connection

```sh
psql "$DB" -c "SELECT version();" && mongosh --quiet "$MONGO_URI" --eval "db.runCommand({ping:1})"
```

### Step 1 - Build PostgreSQL schema

```sh
psql "$DB" -v ON_ERROR_STOP=1 \
    -f sql/01_schema_ddl.sql \
    -f sql/02_indexes.sql \
    -f sql/03_triggers_and_audit.sql \
    -f sql/04_stored_procedures.sql \
    -f sql/05_materialized_views.sql
```

### Step 2 - Seed PostgreSQL

10,000 guests, 2,000 properties, 50,000 bookings, 100,000 wallet audit rows.

```sh
uv run --project data_generation \
    data_generation/postgres_seeder.py
```

### Step 3 - Create the MongoDB collections and indexes

```sh
mongosh "$MONGO_URI" mongo/01_collections_and_indexes.js
```

### Step 4 - Seed MongoDB

```sh
uv run --project data_generation \
    data_generation/mongo_seeder.py
```

### Step 5 - Verify the engine logic (Workflow 1 and the constraints)

```sh
psql "$DB" -f sql/test_queries.sql
```

### Step 6 - Workflow 2: window analytics

```sh
psql "$DB" -f sql/06_window_analytics.sql
```

### Step 7 - Workflow 3: geospatial hotspots

```sh
mongosh "$MONGO_URI" mongo/02_workflow3_geonear.js
```

### Step 8 - Workflow 4: faceted review analytics

```sh
mongosh "$MONGO_URI" mongo/03_workflow4_facet.js
```

### Step 9 - Capture the performance evidence

The redirects below create files, not directories, so make the target first:

```sh
mkdir -p performance
```

```sh
{ echo "EXPLAIN (ANALYZE, BUFFERS)"; cat sql/06_window_analytics.sql; } \
    | psql "$DB" -f - \
    > performance/postgres_explain_analyzes.txt
```

```sh
mongosh --quiet "$MONGO_URI" --eval "EXPLAIN=true" -f mongo/02_workflow3_geonear.js \
    > performance/mongo_execution_stats_workflow3.json
```

```sh
mongosh --quiet "$MONGO_URI" --eval "EXPLAIN=true" -f mongo/03_workflow4_facet.js \
    > performance/mongo_execution_stats_workflow4.json
```

---

### Indexes

| Index                                         | Table / Collection  | Serves                                             |
| --------------------------------------------- | ------------------- | -------------------------------------------------- |
| `idx_active_stay` (partial, unique)           | `bookings`          | One `CHECKED_IN` stay per guest                    |
| `idx_bookings_created_at_property` (covering) | `bookings`          | Workflow 2 - Index Only Scan                       |
| `idx_bookings_completed_property` (partial)   | `bookings`          | Realised-revenue reads, materialized view          |
| `idx_bookings_property_created_at`            | `bookings`          | Per-property history; property `ON DELETE CASCADE` |
| `idx_bookings_guest_created_at`               | `bookings`          | Per-guest history; guest `ON DELETE CASCADE`       |
| `idx_wallet_audit_logs_guest_timestamp`       | `wallet_audit_logs` | Guest ledger; the FK `RESTRICT` check              |
| `idx_sessions_geo_recent` (2dsphere)          | `SearchSessions`    | Workflow 3 `$geoNear` + recency filter             |
| `ttl_sessions_created_at` (TTL 7200s)         | `SearchSessions`    | 2-hour expiry                                      |
| `idx_reviews_recent`                          | `PropertyReviews`   | Workflow 4's leading `$match`                      |
| `idx_amenities_property` (unique)             | `PropertyAmenities` | One amenity document per property                  |
