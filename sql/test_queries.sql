-- Verification script for the PostgreSQL engine logic.
--
-- Run with psql, from a session in autocommit (no surrounding BEGIN):
--     psql postgresql://postgres:postgres@localhost:5432/app -f sql/test_queries.sql
--
-- process_booking_payment performs its own transaction control, so every CALL
-- below sits at the top level. Wrapping one in a DO block or an explicit
-- transaction raises 2D000 -- that is a property of the procedure, not a bug
-- in it. The failing-case tests further down use explicit transactions
-- precisely because they do NOT call the procedure.
\set ON_ERROR_STOP off
\timing off

\echo '== Setup: pick a guest and a property, seed a known balance =='

SELECT
    id AS guest_id
FROM
    guests
ORDER BY
    id
LIMIT
    1 \gset

SELECT
    id AS property_id
FROM
    properties
ORDER BY
    id
LIMIT
    1 \gset

-- This UPDATE itself fires trg_guest_wallet_audit, so the ledger already has
-- a row before the first booking.
UPDATE guests
SET
    wallet_balance = 500.00
WHERE
    id = :'guest_id'::uuid;

SELECT
    :'guest_id'::uuid AS guest_id,
    wallet_balance AS balance_before
FROM
    guests
WHERE
    id = :'guest_id'::uuid;

\echo
\echo '== Test 1: happy path -- 150.00 for a 3-night stay. Expect NOTICE. =='

CALL process_booking_payment (
    :'guest_id'::uuid,
    :'property_id'::uuid,
    150.00,
    CURRENT_DATE,
    3
);

-- Expect balance 350.00, a CONFIRMED booking of 3 nights, and a DEBIT of
-- 150.00 written by the trigger (not by the procedure).
SELECT
    wallet_balance AS balance_after
FROM
    guests
WHERE
    id = :'guest_id'::uuid;

SELECT
    id,
    total_cost,
    status,
    check_in_date,
    check_out_date,
    check_out_date - check_in_date AS nights
FROM
    bookings
WHERE
    guest_id = :'guest_id'::uuid
ORDER BY
    created_at DESC
LIMIT
    1;

SELECT
    amount_changed,
    action_type,
    balance_after
FROM
    wallet_audit_logs
WHERE
    guest_id = :'guest_id'::uuid
ORDER BY
    "timestamp" DESC
LIMIT
    2;

\echo
\echo '== Test 2: insufficient funds. Expect WARNING [23514] and a rollback. =='
\echo '   This is guests_wallet_balance_check firing -- the procedure does not'
\echo '   pre-check the balance, it lets the constraint decide.'

CALL process_booking_payment (
    :'guest_id'::uuid,
    :'property_id'::uuid,
    9999999.00,
    CURRENT_DATE,
    1
);

-- Expect 350.00, unchanged: the deduction, the booking and the audit row were
-- all discarded together.
SELECT
    wallet_balance AS balance_unchanged
FROM
    guests
WHERE
    id = :'guest_id'::uuid;

SELECT
    COUNT(*) AS bookings_for_guest
FROM
    bookings
WHERE
    guest_id = :'guest_id'::uuid;

\echo
\echo '== Test 3: negative charge. Expect WARNING, and no credit to the wallet. =='

CALL process_booking_payment (
    :'guest_id'::uuid,
    :'property_id'::uuid,
    -50.00,
    CURRENT_DATE,
    1
);

SELECT
    wallet_balance AS balance_still_unchanged
FROM
    guests
WHERE
    id = :'guest_id'::uuid;

\echo
\echo '== Test 4: unknown guest. Expect WARNING [23503]. =='

CALL process_booking_payment (
    '00000000-0000-0000-0000-000000000000'::uuid,
    :'property_id'::uuid,
    10.00,
    CURRENT_DATE,
    1
);

\echo
\echo '== Test 5: partial unique index -- one CHECKED_IN stay per guest. =='
\echo '   The FIRST insert must succeed, the SECOND must fail with 23505.'

SELECT
    g.id AS t5_guest_id
FROM
    guests g
WHERE
    NOT EXISTS (
        SELECT
            1
        FROM
            bookings b
        WHERE
            b.guest_id = g.id
            AND b.status = 'CHECKED_IN'
    )
ORDER BY
    g.id
LIMIT
    1 \gset

BEGIN;

INSERT INTO
    bookings (
        guest_id,
        property_id,
        total_cost,
        status,
        check_in_date,
        check_out_date
    )
VALUES
    (
        :'t5_guest_id'::uuid,
        :'property_id'::uuid,
        100.00,
        'CHECKED_IN',
        CURRENT_DATE,
        CURRENT_DATE + 2
    );

INSERT INTO
    bookings (
        guest_id,
        property_id,
        total_cost,
        status,
        check_in_date,
        check_out_date
    )
VALUES
    (
        :'t5_guest_id'::uuid,
        :'property_id'::uuid,
        200.00,
        'CHECKED_IN',
        CURRENT_DATE + 5,
        CURRENT_DATE + 7
    );

ROLLBACK;

\echo
\echo '== Test 6: the same guest may hold many CONFIRMED bookings. =='
\echo '   The index is PARTIAL, so non-CHECKED_IN rows are not indexed at all.'

-- Baseline first: this guest already owns seeded CONFIRMED bookings, so an
-- absolute count after the insert says nothing. The delta is the assertion.
SELECT
    COUNT(*) AS t6_before
FROM
    bookings
WHERE
    guest_id = :'t5_guest_id'::uuid
    AND status = 'CONFIRMED' \gset

BEGIN;

INSERT INTO
    bookings (
        guest_id,
        property_id,
        total_cost,
        status,
        check_in_date,
        check_out_date
    )
SELECT
    :'t5_guest_id'::uuid,
    :'property_id'::uuid,
    100.00,
    'CONFIRMED',
    CURRENT_DATE + n,
    CURRENT_DATE + n + 1
FROM
    generate_series(1, 3) AS g (n);

-- Expect exactly 3.
SELECT
    COUNT(*) - :t6_before AS confirmed_rows_added
FROM
    bookings
WHERE
    guest_id = :'t5_guest_id'::uuid
    AND status = 'CONFIRMED';

ROLLBACK;

\echo
\echo '== Test 7: audit immutability. All three must fail with 42501. =='

UPDATE wallet_audit_logs
SET
    balance_after = 0.00
WHERE
    id = (
        SELECT
            id
        FROM
            wallet_audit_logs
        LIMIT
            1
    );

DELETE FROM wallet_audit_logs
WHERE
    id = (
        SELECT
            id
        FROM
            wallet_audit_logs
        LIMIT
            1
    );

TRUNCATE wallet_audit_logs;

\echo
\echo '== Test 8: the audit FK is RESTRICT -- deleting a guest with ledger =='
\echo '   history must fail with 23503, not silently erase the trail.'

DELETE FROM guests
WHERE
    id = :'guest_id'::uuid;

\echo
\echo '== Test 9: CHECK constraints reject bad rows directly. =='

BEGIN;

-- 23514: check_out_date must be after check_in_date.
INSERT INTO
    bookings (
        guest_id,
        property_id,
        total_cost,
        status,
        check_in_date,
        check_out_date
    )
VALUES
    (
        :'guest_id'::uuid,
        :'property_id'::uuid,
        100.00,
        'CONFIRMED',
        CURRENT_DATE,
        CURRENT_DATE
    );

ROLLBACK;

BEGIN;

-- 23514: latitude out of range.
INSERT INTO
    properties (title, base_price, latitude, longitude)
VALUES
    ('Impossible Villa', 100.00, 91.0, 0.0);

ROLLBACK;

\echo
\echo '== Test 10: concurrent refresh of the materialized view. =='

SELECT
    refresh_property_performance_mv ();

SELECT
    property_id,
    title,
    total_bookings,
    total_nights_booked,
    gross_revenue,
    realised_revenue
FROM
    mv_property_performance
ORDER BY
    gross_revenue DESC
LIMIT
    5;
