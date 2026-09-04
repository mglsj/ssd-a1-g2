"""
Seeds the MongoDB side of StaySpot (Project 3).

Run mongo/01_collections_and_indexes.js FIRST -- it creates the collections,
their validators, and the 2dsphere / TTL indexes this script's documents are
checked against.

    mongosh mongo/01_collections_and_indexes.js
    uv run mongo_seeder.py

Generates:
    PropertyAmenities  one document per property
    PropertyReviews    150,000 documents spread over the last year
    SearchSessions     500,000 geospatial pings (the brief's 500k+ requirement)

Two things about this script are not obvious:

1. Guest and property ids are READ FROM POSTGRES, not invented. The Mongo
   validators require a 16-byte binData for each, and a document store full of
   ids that match nothing in the relational store would make every cross-store
   workflow meaningless. Run postgres_seeder.py first.

2. SearchSessions.created_at is generated inside the last 110 minutes, NOT
   spread over a year like the reviews. The collection carries a TTL index with
   expireAfterSeconds=7200, so anything older than two hours is deleted by the
   TTL monitor within a minute of being written. Seeding a year of pings would
   produce a collection that empties itself while you watch.

   The corollary: this collection drains about two hours after seeding. Re-run
   this script immediately before capturing explain("executionStats") output.
"""

import math
import os
import random
import uuid
from datetime import datetime, timedelta, timezone

import psycopg2
from bson.binary import Binary, UuidRepresentation
from pymongo import MongoClient

# --- Configuration ---------------------------------------------------------

PG_HOST = os.getenv("POSTGRES_HOST", "localhost")
PG_PORT = os.getenv("POSTGRES_PORT", "5432")
PG_NAME = os.getenv("POSTGRES_DB", "app")
PG_USER = os.getenv("POSTGRES_USER", "postgres")
PG_PASSWORD = os.getenv("POSTGRES_PASSWORD", "postgres")

MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB = os.getenv("MONGO_DB", "app")

# --- Target volumes --------------------------------------------------------

NUM_SEARCH_SESSIONS = 500_000
NUM_REVIEWS = 150_000

# Documents per insert_many call. Large enough that round trips stop
# dominating, small enough that a batch stays well under the 16MB BSON limit
# and the process does not hold 500k dicts in memory at once.
BATCH_SIZE = 10_000

# --- Geospatial / temporal parameters --------------------------------------

# Sessions are scattered within this radius of a real property. Workflow 3
# searches a 5km radius, so clustering inside it is what makes that workflow
# return non-empty rings instead of looking broken.
SESSION_CLUSTER_RADIUS_KM = 4.5

# Kept below the TTL's 120 minutes with margin, so nothing is swept away mid-run.
SESSION_MAX_AGE_MINUTES = 110

REVIEW_MAX_AGE_DAYS = 365

# One degree of latitude, anywhere on the sphere.
KM_PER_DEGREE_LATITUDE = 111.32

# --- Vocabularies ----------------------------------------------------------

LOCATION_TAGS = [
    "beachfront", "city-centre", "quiet-street", "near-transit",
    "mountain-view", "walkable", "secluded", "near-nightlife",
    "family-friendly", "limited-parking", "steep-approach", "waterfront",
    "historic-district", "near-airport",
]

# Skewed so the $facet tag ranking has a clear, checkable order rather than
# fourteen tags all within noise of each other.
LOCATION_TAG_WEIGHTS = [
    18, 15, 13, 12, 10, 9, 7, 6, 5, 4, 3, 3, 2, 2,
]

AMENITY_CATALOGUE = {
    "Kitchen": ["Oven", "Dishwasher", "Coffee machine", "Microwave", "Freezer"],
    "Bathroom": ["Hair dryer", "Bathtub", "Heated floor", "Rain shower"],
    "Outdoor": ["Private pool", "BBQ grill", "Fire pit", "Terrace", "Garden"],
    "Connectivity": ["Wifi", "Dedicated workspace", "Smart TV", "Ethernet"],
    "Climate": ["Air conditioning", "Central heating", "Ceiling fan"],
}

HOUSE_RULES = [
    "No smoking", "No parties or events", "Quiet hours after 10 PM",
    "No pets", "Self check-in after 3 PM", "Check-out by 11 AM",
    "Remove shoes indoors",
]

ACCESSIBILITY_FEATURES = [
    "Step-free path to entrance", "Wide doorway", "Grab rails in bathroom",
    "Ground-floor bedroom", "Lift access", "Accessible parking space",
]

# Most stays are fine; the distribution should look like a real review corpus,
# not a uniform 1-5. This also makes the Workflow 4 percentages worth reading.
RATING_CHOICES = [1, 2, 3, 4, 5]
RATING_WEIGHTS = [4, 6, 13, 33, 44]

REVIEW_SENTENCES = [
    "Exactly as described, would stay again.",
    "Great location, a little noisy at night.",
    "Host was responsive and check-in was painless.",
    "Clean and comfortable, though smaller than expected.",
    "Beautiful views but the walk up the hill is steep.",
    "Good value for the area.",
    "Photos do not do the place justice.",
    "Parking was harder to find than we hoped.",
]


def as_binary_uuid(value):
    """
    Encode a UUID as the 16-byte binData subtype 4 the validators require.

    pymongo 4 refuses to encode a bare uuid.UUID unless a UUID representation
    is configured on the client, and the collection validators assert
    $binarySize == 16, so the conversion is made explicit here rather than
    left to codec options set somewhere else.
    """
    if not isinstance(value, uuid.UUID):
        value = uuid.UUID(str(value))
    return Binary.from_uuid(value, UuidRepresentation.STANDARD)


def fetch_reference_ids():
    """
    Read guest ids and property ids/coordinates from PostgreSQL.

    Returns (guest_ids, properties) where properties is a list of
    (binary_uuid, latitude, longitude).
    """
    conn = psycopg2.connect(
        host=PG_HOST,
        port=PG_PORT,
        dbname=PG_NAME,
        user=PG_USER,
        password=PG_PASSWORD,
    )
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM guests")
            guest_ids = [as_binary_uuid(row[0]) for row in cursor.fetchall()]

            cursor.execute("SELECT id, latitude, longitude FROM properties")
            properties = [
                (as_binary_uuid(row[0]), float(row[1]), float(row[2]))
                for row in cursor.fetchall()
            ]
    finally:
        conn.close()

    if not guest_ids or not properties:
        raise SystemExit(
            "PostgreSQL has no guests or properties. Run postgres_seeder.py "
            "first -- the Mongo documents reference its ids."
        )

    return guest_ids, properties


def jitter_coordinates(latitude, longitude, radius_km):
    """
    Return a random point uniformly distributed within `radius_km` of the input.

    sqrt() on the radius is what makes it uniform over the disc: without it,
    points bunch toward the centre, because the area of a ring grows with its
    radius while a uniform random radius does not.
    """
    distance_km = radius_km * math.sqrt(random.random())
    bearing = random.uniform(0.0, 2.0 * math.pi)

    delta_lat = (distance_km * math.cos(bearing)) / KM_PER_DEGREE_LATITUDE

    # Lines of longitude converge toward the poles, so a degree of longitude is
    # worth less distance the further from the equator you are. Near the poles
    # the divisor approaches zero, so it is floored to stop a small offset in
    # kilometres becoming an enormous one in degrees.
    longitude_scale = max(math.cos(math.radians(latitude)), 0.01)
    delta_lon = (distance_km * math.sin(bearing)) / (
        KM_PER_DEGREE_LATITUDE * longitude_scale
    )

    # A 2dsphere index rejects out-of-range coordinates outright, so clamp
    # latitude and wrap longitude rather than letting the insert fail.
    new_lat = max(-90.0, min(90.0, latitude + delta_lat))
    new_lon = ((longitude + delta_lon + 180.0) % 360.0) - 180.0

    return new_lat, new_lon


def insert_in_batches(collection, generator, total, label):
    """Insert `total` documents from `generator`, one BATCH_SIZE chunk at a time."""
    inserted = 0
    batch = []

    for document in generator:
        batch.append(document)
        if len(batch) >= BATCH_SIZE:
            # ordered=False lets the server keep going past a rejected
            # document instead of abandoning the rest of the batch.
            collection.insert_many(batch, ordered=False)
            inserted += len(batch)
            batch = []
            print(f"  {label}: {inserted:,} / {total:,}", flush=True)

    if batch:
        collection.insert_many(batch, ordered=False)
        inserted += len(batch)

    print(f"  {label}: {inserted:,} / {total:,} done", flush=True)
    return inserted


def generate_amenities(properties, now):
    for property_id, _latitude, _longitude in properties:
        categories = random.sample(
            sorted(AMENITY_CATALOGUE), random.randint(2, len(AMENITY_CATALOGUE))
        )
        document = {
            "property_id": property_id,
            "amenity_categories": [
                {
                    "category": category,
                    "items": random.sample(
                        AMENITY_CATALOGUE[category],
                        random.randint(1, len(AMENITY_CATALOGUE[category])),
                    ),
                }
                for category in categories
            ],
            "house_rules": random.sample(HOUSE_RULES, random.randint(2, 5)),
            "accessibility_features": random.sample(
                ACCESSIBILITY_FEATURES, random.randint(0, 4)
            ),
            "updated_at": now - timedelta(days=random.randint(0, 180)),
        }

        # PropertyAmenities sets additionalProperties: true precisely so that
        # listing-specific attributes no fixed schema anticipated can be
        # stored. Exercise that on a subset, so the flexibility is visible in
        # the data and not only in the validator.
        if random.random() < 0.35:
            document["seasonal_notes"] = {
                "winter": random.choice(
                    ["Snow tyres advised", "Road may close", "Firewood included"]
                ),
                "summer": random.choice(
                    ["Pool opens in June", "Insect screens fitted", "AC serviced"]
                ),
            }
        if random.random() < 0.20:
            document["licence"] = {
                "registration_number": f"STR-{random.randint(100000, 999999)}",
                "expires_at": now + timedelta(days=random.randint(30, 900)),
            }

        yield document


def generate_reviews(guest_ids, properties, now):
    property_ids = [property_id for property_id, _lat, _lon in properties]

    for _ in range(NUM_REVIEWS):
        # Tags are built from weighted draws and then de-duplicated.
        # random.sample cannot do this: it samples without replacement but
        # ignores weights, and the skew is what gives the Workflow 4 $unwind
        # ranking a clear order instead of fourteen tags tied within noise.
        tags = set()
        for _ in range(random.randint(1, 4)):
            tags.add(random.choices(LOCATION_TAGS, weights=LOCATION_TAG_WEIGHTS)[0])

        document = {
            "property_id": random.choice(property_ids),
            "guest_id": random.choice(guest_ids),
            # int() is deliberate: the validator declares bsonType "int", so a
            # float here would be rejected as a BSON double.
            "rating": int(random.choices(RATING_CHOICES, weights=RATING_WEIGHTS)[0]),
            "location_tags": sorted(tags),
            "created_at": now
            - timedelta(seconds=random.randint(0, REVIEW_MAX_AGE_DAYS * 86400)),
        }

        if random.random() < 0.7:
            document["review_text"] = random.choice(REVIEW_SENTENCES)

        yield document


def generate_search_sessions(guest_ids, properties, now):
    max_age_seconds = SESSION_MAX_AGE_MINUTES * 60

    for _ in range(NUM_SEARCH_SESSIONS):
        _property_id, latitude, longitude = random.choice(properties)
        session_lat, session_lon = jitter_coordinates(
            latitude, longitude, SESSION_CLUSTER_RADIUS_KM
        )

        yield {
            "guest_id": random.choice(guest_ids),
            "session_id": as_binary_uuid(uuid.uuid4()),
            "location": {
                "type": "Point",
                # GeoJSON is [longitude, latitude]. Reversing these is the
                # classic way to get a $geoNear that returns nothing.
                "coordinates": [session_lon, session_lat],
            },
            "search_filters": {
                "guests_count": int(random.randint(1, 16)),
                "max_price": round(random.uniform(60.0, 1200.0), 2),
                "min_bedrooms": int(random.randint(0, 5)),
                "requires_pool": random.random() < 0.25,
            },
            "created_at": now - timedelta(seconds=random.randint(0, max_age_seconds)),
        }


def seed_mongo():
    print("Reading guest and property ids from PostgreSQL...", flush=True)
    guest_ids, properties = fetch_reference_ids()
    print(f"  {len(guest_ids):,} guests, {len(properties):,} properties", flush=True)

    client = MongoClient(MONGO_URI)
    try:
        database = client[MONGO_DB]

        existing = set(database.list_collection_names())
        missing = {"PropertyAmenities", "PropertyReviews", "SearchSessions"} - existing
        if missing:
            raise SystemExit(
                "Missing collections: "
                + ", ".join(sorted(missing))
                + ". Run 'mongosh mongo/01_collections_and_indexes.js' first -- it "
                "creates the validators and the 2dsphere/TTL indexes."
            )

        # Idempotency. The collections are not dropped here: dropping would
        # take their validators and indexes with them, which is
        # 01_collections_and_indexes.js's job, not this script's.
        print("Clearing existing documents...", flush=True)
        for name in ("PropertyAmenities", "PropertyReviews", "SearchSessions"):
            database[name].delete_many({})

        # One `now` for the whole run, so the TTL and recency windows are
        # measured from a single instant rather than drifting across a seed
        # that takes minutes.
        now = datetime.now(timezone.utc)

        print(f"Seeding PropertyAmenities ({len(properties):,})...", flush=True)
        insert_in_batches(
            database.PropertyAmenities,
            generate_amenities(properties, now),
            len(properties),
            "amenities",
        )

        print(f"Seeding PropertyReviews ({NUM_REVIEWS:,})...", flush=True)
        insert_in_batches(
            database.PropertyReviews,
            generate_reviews(guest_ids, properties, now),
            NUM_REVIEWS,
            "reviews",
        )

        print(
            f"Seeding SearchSessions ({NUM_SEARCH_SESSIONS:,})... "
            "this is the slow one: every insert also updates the 2dsphere index.",
            flush=True,
        )
        insert_in_batches(
            database.SearchSessions,
            generate_search_sessions(guest_ids, properties, now),
            NUM_SEARCH_SESSIONS,
            "sessions",
        )

        print("Mongo seeding complete.")
        print(
            f"NOTE: SearchSessions expires 2 hours after {now.isoformat()}. "
            "Capture explain output before then, or re-run this script."
        )
    finally:
        client.close()


if __name__ == "__main__":
    seed_mongo()
