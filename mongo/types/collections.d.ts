/**
 * Binds collection names to document types for the StaySpot database.
 *
 * Nothing here restates a schema. Each entry points at the `const ...Schema`
 * declared next to its `createCollection` call in `mongo/`, and
 * `CollectionDocumentOf` derives the document type from it. Change a
 * validator and the type `insertOne` is checked against changes with it -
 * there is no generated file to refresh and no second copy to keep in sync.
 *
 * Adding a collection takes three steps:
 *   1. In `mongo/`, hoist its `$jsonSchema` into
 *      `const NameSchema = /** @type {const} *\/ ({ ... })` and reference that
 *      constant from `createCollection`.
 *   2. Add one line to `CollectionSchemas` below.
 *   3. Add one line to `SchemaKeywordChecks` below.
 *
 * The schema constants are visible here because the files in `mongo/` are
 * scripts, not modules - no import/export, so their top-level `const`s land in
 * the global scope, which is also how mongosh itself runs them.
 */
interface CollectionSchemas {
  PropertyAmenities: CollectionDocumentOf<typeof PropertyAmenitiesSchema>;
  SearchSessions: CollectionDocumentOf<typeof SearchSessionsSchema>;
  PropertyReviews: CollectionDocumentOf<typeof PropertyReviewsSchema>;
}

/**
 * Spell-checks the schema keywords, one entry per collection above.
 *
 * This is a separate list rather than something folded into `CollectionSchemas`
 * because the constraint has to be checked against a concrete schema type.
 *
 * It exists because `/** @type {const} *\/` costs excess-property checking:
 * a const-asserted object handed to `createCollection` is no longer a *fresh*
 * object literal, so TypeScript stops reporting unknown keys at that call. A
 * misspelled `requred` would otherwise be ignored, quietly making every field
 * optional in the derived type. Here it fails the build instead:
 *
 *     Type '"requred"' does not satisfy the constraint 'never'.
 *
 * Value-level mistakes - `bsonType: "strng"`, `validationAction: "explode"` -
 * are caught separately, at the `createCollection` call itself.
 */
type SchemaKeywordChecks = [
  ExpectNever<UnknownSchemaKeywords<typeof PropertyAmenitiesSchema>>,
  ExpectNever<UnknownSchemaKeywords<typeof SearchSessionsSchema>>,
  ExpectNever<UnknownSchemaKeywords<typeof PropertyReviewsSchema>>
];
