db = db.getSiblingDB("app");

/// Radius of search
const MAX_DISTANCE_METERS = 5000; // 5km

// TTL duration
const RECENCY_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * @param {number} longitude
 * @param {number} latitude 
 * @returns {MongoQuery[]}
 */
function buildHotspotPipeline(longitude, latitude) {
  return [
    // geospatial proximity
    {
      $geoNear: {
        near: {
          type: "Point",
          coordinates: [longitude, latitude] // GeoJSON order
        },
        distanceField: "distance_meters",
        maxDistance: MAX_DISTANCE_METERS,
        spherical: true,
        key: "location",
        query: {
          created_at: { $gte: new Date(Date.now() - RECENCY_WINDOW_MS) }
        }
      }
    },

    // strip down fields
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

    // custer into 1 km rings
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

    // add guest count to ring
    {
      $set: {
        ring_km: "$_id",
        unique_guest_count: { $size: "$unique_guests" }
      }
    },
    { $unset: ["unique_guests", "_id"] },

    // sort by distance
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

// Centre the search on a random session's coordinates
const randomSession = db.SearchSessions.findOne();

if (randomSession === null) {
  throw new Error(
    "SearchSessions is empty."
  );
}

const centreLongitude = randomSession.location.coordinates[0];
const centreLatitude = randomSession.location.coordinates[1];

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
