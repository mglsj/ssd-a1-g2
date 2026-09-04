## Design Assumptions

### Schema

1. **Surrogate keys are UUIDs**, generated server-side with `gen_random_uuid()`.
2. **`bookings` carries an explicit stay window** (`check_in_date`,
   `check_out_date`). The brief lists neither column, but its materialized view
   requires "total nights booked", which cannot be recovered from a single
   `created_at` timestamp. Nights are `check_out_date - check_in_date`.
3. **`wallet_audit_logs` is append-only.** Its rows must outlive the guest they
   describe, so the FK is `ON DELETE RESTRICT`, not `CASCADE` - an audit trail a
   `DELETE` can erase is not an audit trail. `UPDATE`, `DELETE` and `TRUNCATE`
   are all rejected by trigger.
4. **`amount_changed` is stored as a magnitude**; `action_type` carries the sign.
5. Coordinates are range-checked in PostgreSQL (`latitude` ±90, `longitude` ±180)
   because they feed MongoDB's 2dsphere index, which rejects out-of-range values.

### Workflow 1 - Atomic booking

6. **The procedure does not pre-check the balance.** It deducts and lets
   `guests_wallet_balance_check` decide, catching `check_violation`. A
   pre-flight `IF` would make the constraint unreachable dead weight.
7. **It performs its own transaction control**, so it must be `CALL`ed at the
   top level of a session. Invoking it inside an explicit transaction, a `DO`
   block or another function raises `2D000`.

### Workflow 2 - Window analytics

8. Revenue is attributed to the day a booking was **created**, not the nights stayed.
9. **All statuses count** toward revenue - a `CONFIRMED` booking is committed money.
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
15. **`PropertyAmenities` sets `additionalProperties: true`** deliberately - a
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
