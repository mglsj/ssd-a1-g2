// ============================================================================
// Project 3: StaySpot - Vacation Rental & Experiences
// Script: 01_collections_and_indexes.js
// Step 1/2: collection creation, document validation, 2dsphere + TTL indexes.
//
// Run:  mongosh "$MONGO_URI" mongo/01_collections_and_indexes.js
//
// The database name matches the PostgreSQL side ("app"), which is what both
// the dev container and devenv provision. Every script in mongo/ and
// data_generation/mongo_seeder.py must agree on this name.
//
// Idempotent by drop-and-recreate, mirroring the DROP ... CASCADE at the top
// of sql/01_schema_ddl.sql. Re-running this file DISCARDS all seeded
// documents; re-run data_generation/mongo_seeder.py afterwards.
// ============================================================================

db = db.getSiblingDB("app");

// ---------------------------------------------------------------------------
// PropertyAmenities
//
// The deliberately flexible collection: a rental's amenity catalogue varies by
// property type (a cabin has no elevator, a city studio has no dock), so the
// validator pins identity and shape but opts into additionalProperties. This
// is the collection that justifies reaching for a document store at all --
// the other two are structured enough to have lived in PostgreSQL.
// ---------------------------------------------------------------------------

const PropertyAmenitiesSchema = /** @type {const} */ ({
  bsonType: "object",
  title: "PropertyAmenities validation",
  required: ["property_id", "updated_at"],
  // Opt in to extra keys: property-specific attributes that no fixed schema
  // anticipates are the entire point of this collection.
  additionalProperties: true,
  properties: {
    property_id: { bsonType: "binData" },
    // Nested catalogue: categories, each holding its own item list.
    amenity_categories: {
      bsonType: "array",
      items: {
        bsonType: "object",
        required: ["category", "items"],
        properties: {
          category: { bsonType: "string" },
          items: { bsonType: "array", items: { bsonType: "string" } }
        }
      }
    },
    house_rules: { bsonType: "array", items: { bsonType: "string" } },
    accessibility_features: { bsonType: "array", items: { bsonType: "string" } },
    updated_at: { bsonType: "date" }
  }
});

db.PropertyAmenities.drop();

db.createCollection("PropertyAmenities", {
  validator: {
    $and: [
      { $jsonSchema: PropertyAmenitiesSchema },
      // $jsonSchema cannot express "this binData is exactly a UUID", so the
      // 16-byte length is asserted alongside it.
      { $expr: { $eq: [{ $binarySize: "$property_id" }, 16] } }
    ]
  },
  validationLevel: "strict",
  validationAction: "error"
});

db.PropertyAmenities.createIndex(
  { property_id: 1 },
  { name: "idx_amenities_property", unique: true }
);

// ---------------------------------------------------------------------------
// SearchSessions
//
// Geospatial log of where guests are dropping pins while searching.
// Consumed by Workflow 3 (02_workflow3_geonear.js).
// ---------------------------------------------------------------------------

const SearchSessionsSchema = /** @type {const} */ ({
  bsonType: "object",
  title: "SearchSessions validation",
  required: ["guest_id", "session_id", "location", "created_at"],
  properties: {
    guest_id: { bsonType: "binData" },
    session_id: { bsonType: "binData" },
    location: {
      bsonType: "object",
      required: ["type", "coordinates"],
      properties: {
        type: { enum: ["Point"] },
        // GeoJSON order is [longitude, latitude] -- the reverse of how
        // coordinates are usually spoken, and the most common cause of a
        // $geoNear that silently returns nothing.
        coordinates: {
          bsonType: "array",
          minItems: 2,
          maxItems: 2,
          items: { bsonType: "number" }
        }
      }
    },
    // What the guest was filtering for when they dropped the pin. Workflow 3
    // aggregates these per distance ring; the pipeline read these fields
    // before this validator declared them, so every $avg over them returned
    // null.
    search_filters: {
      bsonType: "object",
      properties: {
        guests_count: { bsonType: "int", minimum: 1, maximum: 16 },
        max_price: { bsonType: "number", minimum: 0 },
        min_bedrooms: { bsonType: "int", minimum: 0 },
        requires_pool: { bsonType: "bool" }
      }
    },
    created_at: { bsonType: "date" }
  }
});

db.SearchSessions.drop();

db.createCollection("SearchSessions", {
  validator: {
    $and: [
      { $jsonSchema: SearchSessionsSchema },
      { $expr: { $eq: [{ $binarySize: "$guest_id" }, 16] } },
      { $expr: { $eq: [{ $binarySize: "$session_id" }, 16] } }
    ]
  },
  validationLevel: "strict",
  validationAction: "error"
});

// 2dsphere, compound with created_at. The brief asks for a 2dsphere index on
// location; making it compound additionally lets $geoNear's recency filter be
// served from the same index rather than re-checked per candidate document.
db.SearchSessions.createIndex(
  { location: "2dsphere", created_at: -1 },
  { name: "idx_sessions_geo_recent" }
);

// TTL: 2 hours, per the brief.
//
// NOTE, and this one bites during the demo: the TTL monitor wakes every 60
// seconds and deletes any document whose created_at is older than 7200s.
// Seeded pings must therefore be timestamped INSIDE that window or they are
// swept away before an explain can be run against them. mongo_seeder.py
// generates created_at across the trailing 110 minutes for exactly this
// reason -- which also means the collection drains itself roughly two hours
// after seeding. Re-seed immediately before capturing performance numbers.
db.SearchSessions.createIndex(
  { created_at: 1 },
  { name: "ttl_sessions_created_at", expireAfterSeconds: 7200 }
);

// ---------------------------------------------------------------------------
// PropertyReviews
//
// Consumed by Workflow 4 (03_workflow4_facet.js).
// ---------------------------------------------------------------------------

const PropertyReviewsSchema = /** @type {const} */ ({
  bsonType: "object",
  title: "PropertyReviews validation",
  required: ["property_id", "guest_id", "rating", "created_at"],
  properties: {
    property_id: { bsonType: "binData" },
    guest_id: { bsonType: "binData" },
    // Integer 1-5. A fractional rating such as 4.8 is rejected: bsonType
    // "int" is a 32-bit integer, not "any number".
    rating: { bsonType: "int", minimum: 1, maximum: 5 },
    review_text: { bsonType: "string" },
    location_tags: { bsonType: "array", items: { bsonType: "string" } },
    created_at: { bsonType: "date" }
  }
});

db.PropertyReviews.drop();

db.createCollection("PropertyReviews", {
  validator: {
    $and: [
      { $jsonSchema: PropertyReviewsSchema },
      { $expr: { $eq: [{ $binarySize: "$property_id" }, 16] } },
      { $expr: { $eq: [{ $binarySize: "$guest_id" }, 16] } }
    ]
  },
  validationLevel: "strict",
  validationAction: "error"
});

// Per-property review history, newest first.
db.PropertyReviews.createIndex(
  { property_id: 1, created_at: -1 },
  { name: "idx_reviews_property_recent" }
);

// Serves the $match that fronts the Workflow 4 $facet. A $facet's sub-pipelines
// cannot use an index -- they operate on whatever the preceding stages hand
// them -- so the only way that pipeline avoids a COLLSCAN is for the stage
// BEFORE the $facet to be index-served. This is that index.
db.PropertyReviews.createIndex(
  { created_at: -1 },
  { name: "idx_reviews_recent" }
);

// Supports rating-scoped reads, and lets the distribution facet be fed from an
// index when a caller narrows by rating.
db.PropertyReviews.createIndex(
  { rating: 1, created_at: -1 },
  { name: "idx_reviews_rating_recent" }
);

print("Collections and indexes created on database: " + db.getName());
