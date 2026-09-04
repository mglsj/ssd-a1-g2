import os
import random
import uuid
from datetime import date, datetime, timedelta

import psycopg2
from faker import Faker
from psycopg2.extensions import connection as PgConnection
from psycopg2.extras import execute_values

# --- Types -----------------------------------------------------------------
GuestRow = tuple[str, str, float]
PropertyRow = tuple[str, str, float, float, float]
BookingRow = tuple[str, str, str, float, str, date, date, datetime]
AuditRow = tuple[str, str, float, str, float, datetime]

# Configuration
DB_HOST = os.getenv("POSTGRES_HOST", "localhost")
DB_PORT = os.getenv("POSTGRES_PORT", "5432")
DB_NAME = os.getenv("POSTGRES_DB", "postgres")
DB_USER = os.getenv("POSTGRES_USER", "postgres")
DB_PASSWORD = os.getenv("POSTGRES_PASSWORD", "postgres")

# Target row counts
NUM_GUESTS = 10_000
NUM_PROPERTIES = 2_000
NUM_BOOKINGS = 50_000
NUM_AUDIT_LOGS = 100_000

fake = Faker()

def get_connection() -> PgConnection:
    return psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD
    )

def seed_postgres() -> None:
    conn = get_connection()
    cursor = conn.cursor()
    print("Connected to PostgreSQL. Starting data seeding...")

    try:
        # 1. Seed Guests
        print(f"Generating {NUM_GUESTS:,} guests...")
        guest_ids: list[str] = [str(uuid.uuid4()) for _ in range(NUM_GUESTS)]
        guests_data: list[GuestRow] = [
            (gid, fake.name(), round(random.uniform(10.0, 5000.0), 2))
            for gid in guest_ids
        ]
        execute_values(
            cursor,
            "INSERT INTO guests (id, name, wallet_balance) VALUES %s",
            guests_data,
            page_size=5000
        )
        conn.commit()

        # 2. Seed Properties
        print(f"Generating {NUM_PROPERTIES:,} properties...")
        property_ids: list[str] = [str(uuid.uuid4()) for _ in range(NUM_PROPERTIES)]
        properties_data: list[PropertyRow] = [
            (
                pid,
                f"{fake.city()} {random.choice(['Villa', 'Apartment', 'Cabin', 'Studio'])}",
                round(random.uniform(50.0, 800.0), 2),
                float(fake.latitude()),
                float(fake.longitude())
            )
            for pid in property_ids
        ]
        execute_values(
            cursor,
            "INSERT INTO properties (id, title, base_price, latitude, longitude) VALUES %s",
            properties_data,
            page_size=5000
        )
        conn.commit()

        property_prices: dict[str, float] = {row[0]: row[2] for row in properties_data}

        # 3. Seed Bookings (50,000 required)
        print(f"Generating {NUM_BOOKINGS:,} bookings...")
        checked_in_guests: set[str] = set()
        bookings_data: list[BookingRow] = []

        statuses: list[str] = ['CONFIRMED', 'CHECKED_IN', 'COMPLETED']
        status_weights: list[float] = [0.4, 0.1, 0.5]  #

        for _ in range(NUM_BOOKINGS):
            guest_id = random.choice(guest_ids)
            property_id = random.choice(property_ids)
            created_at = fake.date_time_between(start_date='-1y', end_date='now')

            nights = random.randint(1, 14)
            check_in_date = created_at.date() + timedelta(days=random.randint(1, 60))
            check_out_date = check_in_date + timedelta(days=nights)

            total_cost = max(
                round(nights * property_prices[property_id] * random.uniform(0.85, 1.35), 2),
                0.01
            )

            selected_status = random.choices(statuses, weights=status_weights)[0]
            if selected_status == 'CHECKED_IN':
                if guest_id in checked_in_guests:
                    selected_status = 'COMPLETED'
                else:
                    checked_in_guests.add(guest_id)

            bookings_data.append((
                str(uuid.uuid4()),
                guest_id,
                property_id,
                total_cost,
                selected_status,
                check_in_date,
                check_out_date,
                created_at
            ))

        execute_values(
            cursor,
            """
            INSERT INTO bookings (id, guest_id, property_id, total_cost, status,
                                  check_in_date, check_out_date, created_at)
            VALUES %s
            """,
            bookings_data,
            page_size=10000
        )
        conn.commit()

        # 4. Seed Wallet Audit Logs (100,000 required)
        print(f"Generating {NUM_AUDIT_LOGS:,} wallet audit logs...")
        audit_data: list[AuditRow] = []
        for _ in range(NUM_AUDIT_LOGS):
            guest_id = random.choice(guest_ids)
            amount_changed = round(random.uniform(5.0, 500.0), 2)
            action_type = random.choice(['DEBIT', 'CREDIT'])
            balance_after = round(random.uniform(0.0, 10000.0), 2)
            timestamp = fake.date_time_between(start_date='-1y', end_date='now')

            audit_data.append((
                str(uuid.uuid4()),
                guest_id,
                amount_changed,
                action_type,
                balance_after,
                timestamp
            ))

        execute_values(
            cursor,
            """
            INSERT INTO wallet_audit_logs (id, guest_id, amount_changed, action_type, balance_after, timestamp)
            VALUES %s
            """,
            audit_data,
            page_size=10000
        )
        conn.commit()

        # 5. Refresh Materialized View after populating data
        print("Refreshing Materialized View (mv_property_performance)...")
        cursor.execute("SELECT refresh_property_performance_mv();")
        conn.commit()

        print("Data seeding successfully completed!")

    except Exception as e:
        conn.rollback()
        print(f"Error during seeding: {e}")
        raise e
    finally:
        cursor.close()
        conn.close()

if __name__ == "__main__":
    seed_postgres()