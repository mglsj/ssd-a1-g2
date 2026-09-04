// ============================================================================
// Project 3: StaySpot - Vacation Rental & Experiences
// Script: 03_workflow4_facet.js
// Workflow 4: Multi-Faceted Review Analytics
//
// One pass over PropertyReviews producing, in a single $facet:
//   1. rating_distribution - counts and percentages for all 5 star levels
//   2. top_tags            - most frequent location tags, via $unwind
//   3. overall             - average rating across the window
//
// Run:      mongosh "$MONGO_URI" mongo/03_workflow4_facet.js
// Explain:  mongosh "$MONGO_URI" --eval "EXPLAIN=true" -f mongo/03_workflow4_facet.js
// ============================================================================

db = db.getSiblingDB("app");

/**
 * How far back the report looks.
 *
 * This bound is what lets the pipeline be index-served. A $facet's
 * sub-pipelines never use an index -- they consume whatever the preceding
 * stage streams to them -- so the ONLY stage that can hit an index here is the
 * $match in front, against idx_reviews_recent.
 *
 * The window has to be selective for that to be worth it. At 30 days over a
 * year of seeded reviews this scans roughly 8% of the collection and the
 * planner picks an IXSCAN. Widen it to cover the whole collection and the
 * planner will correctly switch back to a COLLSCAN -- reading most of an index
 * and then fetching most of the documents is slower than just reading the
 * documents. That is the planner being right, not the index failing.
 */
const REVIEW_WINDOW_DAYS = 30;

/** How many tags the frequency facet returns. */
const TOP_TAG_LIMIT = 10;

/** The star levels every distribution must report, present in the data or not. */
const STAR_LEVELS = [1, 2, 3, 4, 5];

/**
 * @param {number} windowDays
 * @returns {MongoQuery[]}
 */
function buildReviewAnalyticsPipeline(windowDays) {
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  return [
    // ------------------------------------------------------------------
    // Stage 1: the only index-servable stage. See REVIEW_WINDOW_DAYS.
    // ------------------------------------------------------------------
    { $match: { created_at: { $gte: windowStart } } },

    // ------------------------------------------------------------------
    // Stage 2: three independent aggregations over the same input stream.
    //
    // This is what $facet buys: without it, the tag frequencies would need
    // their own pass over the collection (an $unwind multiplies the
    // document count, so it cannot share a pipeline with the rating
    // aggregations), and the overall average a third. One $match feeds all
    // three.
    // ------------------------------------------------------------------
    {
      $facet: {
        // --- 1. Rating distribution -----------------------------------
        // Produces only the star levels actually present; the gaps are
        // filled in after the $facet, where the total is known.
        rating_distribution: [
          { $group: { _id: "$rating", count: { $sum: 1 } } },
          { $sort: { _id: 1 } }
        ],

        // --- 2. Most frequent tags ------------------------------------
        // $unwind turns each review into one document per tag, so a review
        // tagged ["beachfront", "quiet"] contributes to both counts.
        // Reviews with no location_tags array drop out here, which is the
        // intended behaviour: they have no tags to count.
        top_tags: [
          { $unwind: "$location_tags" },
          { $group: { _id: "$location_tags", count: { $sum: 1 } } },
          // _id is the tie-breaker so the ordering is deterministic and the
          // output is diffable between runs.
          { $sort: { count: -1, _id: 1 } },
          { $limit: TOP_TAG_LIMIT },
          { $project: { _id: 0, tag: "$_id", count: 1 } }
        ],

        // --- 3. Overall rating ----------------------------------------
        overall: [
          {
            $group: {
              _id: null,
              total_reviews: { $sum: 1 },
              average_rating: { $avg: "$rating" },
              lowest_rating: { $min: "$rating" },
              highest_rating: { $max: "$rating" }
            }
          },
          {
            $project: {
              _id: 0,
              total_reviews: 1,
              average_rating: { $round: ["$average_rating", 3] },
              lowest_rating: 1,
              highest_rating: 1
            }
          }
        ]
      }
    },

    // ------------------------------------------------------------------
    // Stage 3: flatten `overall`.
    //
    // Every $facet output is an array, even a single-document one. The
    // $ifNull matters: if the window contains no reviews at all, the
    // sub-pipeline yields an empty array and $first returns missing, which
    // would make every downstream percentage null rather than zero.
    // ------------------------------------------------------------------
    {
      $set: {
        overall: {
          $ifNull: [
            { $first: "$overall" },
            {
              total_reviews: 0,
              average_rating: null,
              lowest_rating: null,
              highest_rating: null
            }
          ]
        }
      }
    },

    // ------------------------------------------------------------------
    // Stage 4: densify the distribution to all 5 stars and add percentages.
    //
    // $group can only report levels that occur. A distribution missing its
    // 1-star row reads as "no data" when it means "no 1-star reviews", so
    // the levels are mapped over explicitly.
    // ------------------------------------------------------------------
    {
      $set: {
        rating_distribution: {
          $let: {
            vars: {
              buckets: "$rating_distribution",
              total: "$overall.total_reviews"
            },
            in: {
              $map: {
                input: STAR_LEVELS,
                as: "star",
                in: {
                  $let: {
                    vars: {
                      hit: {
                        $first: {
                          $filter: {
                            input: "$$buckets",
                            as: "bucket",
                            cond: { $eq: ["$$bucket._id", "$$star"] }
                          }
                        }
                      }
                    },
                    in: {
                      rating: "$$star",
                      count: { $ifNull: ["$$hit.count", 0] },
                      percentage: {
                        $cond: [
                          { $gt: ["$$total", 0] },
                          {
                            $round: [
                              {
                                $multiply: [
                                  {
                                    $divide: [
                                      { $ifNull: ["$$hit.count", 0] },
                                      "$$total"
                                    ]
                                  },
                                  100
                                ]
                              },
                              2
                            ]
                          },
                          0
                        ]
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    // ------------------------------------------------------------------
    // Stage 5: label the window so a captured result is self-describing.
    // ------------------------------------------------------------------
    {
      $set: {
        window: {
          days: windowDays,
          from: windowStart,
          to: "$$NOW"
        }
      }
    }
  ];
}

/**
 * @param {number} windowDays
 * @returns {MongoDocument[]}
 */
function getReviewAnalytics(windowDays) {
  return db.PropertyReviews.aggregate(
    buildReviewAnalyticsPipeline(windowDays),
    // The $unwind facet can outgrow the 100MB per-stage memory limit on a
    // large collection; spilling is cheaper than failing.
    { allowDiskUse: true }
  ).toArray();
}

/**
 * @param {number} windowDays
 * @returns {MongoDocument}
 */
function explainReviewAnalytics(windowDays) {
  return db.PropertyReviews.explain("executionStats").aggregate(
    buildReviewAnalyticsPipeline(windowDays),
    { allowDiskUse: true }
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (db.PropertyReviews.estimatedDocumentCount() === 0) {
  throw new Error(
    "PropertyReviews is empty. Run mongo/01_collections_and_indexes.js then " +
      "data_generation/mongo_seeder.py."
  );
}

// See the note in 02_workflow3_geonear.js: `typeof` is required because on the
// normal invocation this identifier was never declared.
const reviewExplainRequested = typeof EXPLAIN !== "undefined" && EXPLAIN === true;

if (reviewExplainRequested) {
  printjson(explainReviewAnalytics(REVIEW_WINDOW_DAYS));
} else {
  print(
    "Workflow 4: review analytics over the last " +
      REVIEW_WINDOW_DAYS +
      " days"
  );
  printjson(getReviewAnalytics(REVIEW_WINDOW_DAYS));
}
