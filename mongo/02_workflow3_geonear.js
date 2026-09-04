// ============================================================================
// Project 3: StaySpot - Vacation Rental & Experiences
// Script: 02_workflow3_geonear.js
// Workflow 3: Trending Search Hotspots
//
// Clusters recent SearchSessions within a 5 km radius of a given coordinate,
// bucketed into 1 km concentric rings, using $geoNear against the 2dsphere
// index idx_sessions_geo_recent.
//
// Run:      mongosh "$MONGO_URI" mongo/02_workflow3_geonear.js
// Explain:  mongosh "$MONGO_URI" --eval "EXPLAIN=true" -f mongo/02_workflow3_geonear.js
//
// To capture the executionStats the README needs:
//   mongosh --quiet "$MONGO_URI" --eval "EXPLAIN=true" -f mongo/02_workflow3_geonear.js \
//     > performance/mongo_execution_stats.json
// ============================================================================

db = db.getSiblingDB("app");

/** Radius of the search, in metres. The brief specifies 5 km. */
const MAX_DISTANCE_METERS = 5000;

/** Only sessions from the last 2 hours count as "recent" -- matches the TTL. */
const RECENCY_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Builds the aggregation pipeline. Kept separate from execution so that the
 * run path and the explain path are provably the same pipeline -- an explain
 * of a slightly different pipeline proves nothing.
 *
 * @param {number} longitude - Longitude in decimal degrees.
 * @param {number} latitude  - Latitude in decimal degrees.
 * @returns {MongoQuery[]}
 */
function buildHotspotPipeline(longitude, latitude) {
  return [
    // ------------------------------------------------------------------
    // Stage 1: geospatial proximity.
    //
    // $geoNear MUST be the first stage of the pipeline -- it is the only
    // stage that can open an index cursor, and it is what makes this whole
    // pipeline an IXSCAN rather than a COLLSCAN.
    //
    // The `query` predicate is applied by the same index scan (the index is
    // compound on { location: "2dsphere", created_at: -1 }), so recency
    // filtering costs no extra document fetches.
    // ------------------------------------------------------------------
    {
      $geoNear: {
        near: {
          type: "Point",
          // GeoJSON order: [longitude, latitude].
          coordinates: [longitude, latitude]
        },
        distanceField: "distance_meters",
        maxDistance: MAX_DISTANCE_METERS,
        // spherical: true is required for 2dsphere indexes and for
        // distanceField to come back in metres rather than radians.
        spherical: true,
        key: "location",
        query: {
          created_at: { $gte: new Date(Date.now() - RECENCY_WINDOW_MS) }
        }
      }
    },

    // ------------------------------------------------------------------
    // Stage 2: narrow to the fields the rings are built from. Dropping
    // review text and ids here keeps the documents flowing into $bucket
    // small.
    // ------------------------------------------------------------------
    {
      $project: {
        _id: 0,
        guest_id: 1,
        distance_km: { $divide: ["$distance_meters", 1000] },
        "search_filters.guests_count": 1,
        "search_filters.max_price": 1,
        "search_filters.requires_pool": 1
      }
    },

    // ------------------------------------------------------------------
    // Stage 3: cluster into 1 km concentric rings.
    //
    // boundaries are left-inclusive / right-exclusive, so ring `n` holds
    // [n, n+1) km. A session at exactly 5.000 km falls outside the last
    // boundary and lands in `default` -- which is why a default is
    // mandatory here rather than optional: $bucket errors out on any
    // document it cannot place.
    // ------------------------------------------------------------------
    {
      $bucket: {
        groupBy: "$distance_km",
        boundaries: [0, 1, 2, 3, 4, 5],
        default: "at_5km_boundary",
        output: {
          total_searches: { $sum: 1 },
          unique_guests: { $addToSet: "$guest_id" },
          average_requested_guests: { $avg: "$search_filters.guests_count" },
          average_budget_limit: { $avg: "$search_filters.max_price" },
          pool_requested_count: {
            $sum: {
              $cond: [{ $eq: ["$search_filters.requires_pool", true] }, 1, 0]
            }
          }
        }
      }
    },

    // ------------------------------------------------------------------
    // Stage 4: turn the de-duplicated guest set into a count. $addToSet
    // has to materialise the set before it can be sized, so the $size is a
    // separate stage.
    // ------------------------------------------------------------------
    {
      $set: {
        ring_km: "$_id",
        unique_guest_count: { $size: "$unique_guests" }
      }
    },
    { $unset: ["unique_guests", "_id"] },

    // ------------------------------------------------------------------
    // Stage 5: closest ring first. Numeric ring labels sort before the
    // string `at_5km_boundary` under BSON type ordering, so the overflow
    // bucket lands last without special-casing.
    // ------------------------------------------------------------------
    { $sort: { ring_km: 1 } }
  ];
}

/**
 * @param {number} longitude
 * @param {number} latitude
 * @returns {MongoDocument[]}
 */
function getTrendingSearchHotspots(longitude, latitude) {
  return db.SearchSessions.aggregate(
    buildHotspotPipeline(longitude, latitude)
  ).toArray();
}

/**
 * @param {number} longitude
 * @param {number} latitude
 * @returns {MongoDocument}
 */
function explainHotspotPipeline(longitude, latitude) {
  return db.SearchSessions.explain("executionStats").aggregate(
    buildHotspotPipeline(longitude, latitude)
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Centre the search on a real session's coordinates. A hard-coded landmark
// would return an empty result set against seeded data unless the seeder
// happened to cluster there, which makes the workflow look broken when it is
// not. Sessions are seeded in clusters around property locations, so any
// existing session is by construction inside a populated neighbourhood.
const seedSession = db.SearchSessions.findOne();

if (seedSession === null) {
  throw new Error(
    "SearchSessions is empty. Run mongo/01_collections_and_indexes.js then " +
      "data_generation/mongo_seeder.py, and note that the 2-hour TTL index " +
      "empties this collection again two hours after seeding."
  );
}

const centreLongitude = seedSession.location.coordinates[0];
const centreLatitude = seedSession.location.coordinates[1];

// `EXPLAIN` is injected by `mongosh --eval "EXPLAIN=true"`. The typeof guard
// is load-bearing: on the normal invocation the identifier was never declared
// at all, and reading an undeclared identifier is a ReferenceError. `typeof`
// is the one operator that tolerates it.
const hotspotExplainRequested = typeof EXPLAIN !== "undefined" && EXPLAIN === true;

if (hotspotExplainRequested) {
  printjson(explainHotspotPipeline(centreLongitude, centreLatitude));
} else {
  print(
    "Workflow 3: search hotspots within " +
      MAX_DISTANCE_METERS / 1000 +
      " km of [" +
      centreLongitude +
      ", " +
      centreLatitude +
      "]"
  );
  printjson(getTrendingSearchHotspots(centreLongitude, centreLatitude));
}
