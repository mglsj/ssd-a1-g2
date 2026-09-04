/**
 * Ambient declarations for the globals mongosh injects into every script it
 * evaluates (`mongosh mongo/01_collections_and_indexes.js`).
 *
 * These are NOT the `mongodb` Node driver types and NOT mongoose: the shell's
 * API is its own surface (`db` is reassignable, `db.<name>` resolves a
 * collection, BSON constructors are bare globals, calls are synchronous with
 * no Promise layer).
 *
 * Scope, deliberately: enough of the shell to catch typos, wrong arities and
 * malformed validators in the scripts under `mongo/`. It is not an exhaustive
 * mongosh reference - add members here as the scripts start using them.
 *
 * Global by design - no top-level import/export, so mongosh scripts see these
 * without a module system mongosh cannot run.
 */

/** Any BSON document. Intentionally open: shell scripts build documents inline. */
type MongoDocument = Record<string, any>;

/**
 * A query filter / update / sort expression. Left open on purpose - modelling
 * `$gt`/`$in`/dotted paths precisely produces more false errors than caught
 * bugs in shell scripts.
 */
type MongoQuery = Record<string, any>;

// ---------------------------------------------------------------------------
// BSON value types
// ---------------------------------------------------------------------------

// Each BSON constructor is declared as an interface plus a `var` holding a
// callable-and-newable type, because mongosh accepts both `ObjectId()` and
// `new ObjectId()`. A `declare class` would only permit the `new` form.

interface ObjectId {
  toString(): string;
  getTimestamp(): Date;
  readonly str: string;
}
interface ObjectIdConstructor {
  (id?: string | ObjectId): ObjectId;
  new (id?: string | ObjectId): ObjectId;
}
declare var ObjectId: ObjectIdConstructor;

interface UUID {
  toString(): string;
  hex(): string;
}
interface UUIDConstructor {
  /** `hex` is a 32-character hex string; dashes are permitted. Omit it to generate a v4. */
  (hex?: string): UUID;
  new (hex?: string): UUID;
}
declare var UUID: UUIDConstructor;

interface BinData {
  toString(): string;
  readonly base64: string;
  readonly subtype: number;
}
interface BinDataConstructor {
  (subtype: number, base64: string): BinData;
  new (subtype: number, base64: string): BinData;
}
declare var BinData: BinDataConstructor;

interface Timestamp {
  toString(): string;
}
interface TimestampConstructor {
  (low?: number, high?: number): Timestamp;
  new (low?: number, high?: number): Timestamp;
}
declare var Timestamp: TimestampConstructor;

interface MinKey {}
interface MinKeyConstructor {
  (): MinKey;
  new (): MinKey;
}
declare var MinKey: MinKeyConstructor;

interface MaxKey {}
interface MaxKeyConstructor {
  (): MaxKey;
  new (): MaxKey;
}
declare var MaxKey: MaxKeyConstructor;

/** mongosh numeric wrappers. A plain JS number becomes a BSON double. */
declare function NumberInt(value: string | number): number;
declare function NumberLong(value: string | number): number;
declare function NumberDecimal(value: string | number): number;

/** Parses an ISO-8601 string into a `Date`. */
declare function ISODate(date?: string): Date;

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

interface FindCursor<TSchema = MongoDocument> {
  sort(spec: MongoQuery): FindCursor<TSchema>;
  limit(n: number): FindCursor<TSchema>;
  skip(n: number): FindCursor<TSchema>;
  projection(spec: MongoQuery): FindCursor<TSchema>;
  hint(index: string | MongoQuery): FindCursor<TSchema>;
  collation(spec: MongoQuery): FindCursor<TSchema>;
  batchSize(n: number): FindCursor<TSchema>;
  pretty(): FindCursor<TSchema>;

  toArray(): TSchema[];
  forEach(callback: (doc: TSchema) => void): void;
  map<U>(callback: (doc: TSchema) => U): U[];
  hasNext(): boolean;
  next(): TSchema;
  count(): number;
  itcount(): number;
  size(): number;
  explain(verbosity?: ExplainVerbosity): MongoDocument;
  close(): void;
}

interface AggregationCursor<TSchema = MongoDocument> {
  toArray(): TSchema[];
  forEach(callback: (doc: TSchema) => void): void;
  map<U>(callback: (doc: TSchema) => U): U[];
  hasNext(): boolean;
  next(): TSchema;
  itcount(): number;
  explain(verbosity?: ExplainVerbosity): MongoDocument;
  close(): void;
}

type ExplainVerbosity = "queryPlanner" | "executionStats" | "allPlansExecution";

/**
 * The handle returned by `collection.explain(verbosity)`.
 *
 * It mirrors the collection's read/write surface, but every method runs the
 * operation in explain mode and returns the plan document instead of results.
 * Modelling it as its own interface is what stops
 * `db.c.explain("executionStats").aggregate(p)` from degrading to `any` --
 * which would silently accept `.toArray()` on the end of it, a call that does
 * not exist on an explain result.
 */
interface ExplainableCollection {
  find(filter?: MongoQuery, projection?: MongoQuery): MongoDocument;
  aggregate(pipeline: MongoQuery[], options?: MongoQuery): MongoDocument;
  count(filter?: MongoQuery): MongoDocument;
  distinct(field: string, filter?: MongoQuery): MongoDocument;
  findAndModify(options: MongoQuery): MongoDocument;
  update(filter: MongoQuery, update: MongoQuery, options?: UpdateOptions): MongoDocument;
  remove(filter: MongoQuery, options?: MongoQuery): MongoDocument;
}

// ---------------------------------------------------------------------------
// Write and index results
// ---------------------------------------------------------------------------

interface InsertOneResult {
  acknowledged: boolean;
  insertedId: any;
}

interface InsertManyResult {
  acknowledged: boolean;
  insertedIds: Record<number, any>;
}

interface UpdateResult {
  acknowledged: boolean;
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
  upsertedId: any;
}

interface DeleteResult {
  acknowledged: boolean;
  deletedCount: number;
}

interface BulkWriteResult {
  acknowledged: boolean;
  insertedCount: number;
  matchedCount: number;
  modifiedCount: number;
  deletedCount: number;
  upsertedCount: number;
  upsertedIds: Record<number, any>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface CreateCollectionOptions {
  capped?: boolean;
  size?: number;
  max?: number;
  validator?: MongoValidator;
  validationLevel?: "off" | "strict" | "moderate";
  validationAction?: "error" | "warn";
  collation?: MongoQuery;
  timeseries?: {
    timeField: string;
    metaField?: string;
    granularity?: "seconds" | "minutes" | "hours";
  };
  expireAfterSeconds?: number;
  clusteredIndex?: MongoQuery;
  changeStreamPreAndPostImages?: { enabled: boolean };
}

/** 1 / -1 for ascending / descending, or a named index type. */
type IndexDirection = 1 | -1 | "2d" | "2dsphere" | "text" | "hashed";

type IndexSpec = Record<string, IndexDirection>;

interface CreateIndexOptions {
  name?: string;
  unique?: boolean;
  sparse?: boolean;
  background?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: MongoQuery;
  collation?: MongoQuery;
  hidden?: boolean;
  /** `text` index tuning. */
  weights?: Record<string, number>;
  default_language?: string;
  language_override?: string;
}

interface FindOptions {
  projection?: MongoQuery;
  sort?: MongoQuery;
  limit?: number;
  skip?: number;
  collation?: MongoQuery;
  hint?: string | MongoQuery;
}

interface UpdateOptions {
  upsert?: boolean;
  arrayFilters?: MongoQuery[];
  collation?: MongoQuery;
  hint?: string | MongoQuery;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

interface Collection<TSchema = MongoDocument> {
  // --- Reads ---
  find(filter?: MongoQuery, projection?: MongoQuery): FindCursor<TSchema>;
  findOne(filter?: MongoQuery, options?: FindOptions): TSchema | null;
  aggregate(pipeline: MongoQuery[], options?: MongoQuery): AggregationCursor;
  countDocuments(filter?: MongoQuery, options?: MongoQuery): number;
  estimatedDocumentCount(options?: MongoQuery): number;
  distinct(field: string, filter?: MongoQuery, options?: MongoQuery): any[];

  // --- Writes ---
  insertOne(doc: TSchema, options?: MongoQuery): InsertOneResult;
  insertMany(docs: TSchema[], options?: MongoQuery): InsertManyResult;
  updateOne(filter: MongoQuery, update: MongoQuery | MongoQuery[], options?: UpdateOptions): UpdateResult;
  updateMany(filter: MongoQuery, update: MongoQuery | MongoQuery[], options?: UpdateOptions): UpdateResult;
  replaceOne(filter: MongoQuery, replacement: TSchema, options?: UpdateOptions): UpdateResult;
  deleteOne(filter: MongoQuery, options?: MongoQuery): DeleteResult;
  deleteMany(filter: MongoQuery, options?: MongoQuery): DeleteResult;
  bulkWrite(operations: MongoQuery[], options?: MongoQuery): BulkWriteResult;
  findOneAndUpdate(filter: MongoQuery, update: MongoQuery, options?: MongoQuery): TSchema | null;
  findOneAndReplace(filter: MongoQuery, replacement: TSchema, options?: MongoQuery): TSchema | null;
  findOneAndDelete(filter: MongoQuery, options?: MongoQuery): TSchema | null;

  // --- Indexes ---
  createIndex(keys: IndexSpec, options?: CreateIndexOptions): string;
  createIndexes(keyPatterns: IndexSpec[], options?: CreateIndexOptions): MongoDocument;
  dropIndex(index: string | IndexSpec): MongoDocument;
  dropIndexes(indexes?: string | string[]): MongoDocument;
  getIndexes(): MongoDocument[];
  hideIndex(index: string | IndexSpec): MongoDocument;
  unhideIndex(index: string | IndexSpec): MongoDocument;

  // --- Admin ---
  drop(options?: MongoQuery): boolean;
  stats(options?: MongoQuery): MongoDocument;
  getName(): string;
  explain(verbosity?: ExplainVerbosity): ExplainableCollection;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

interface DatabaseMethods {
  /** Switches to another database on the same connection. */
  getSiblingDB(name: string): Database;
  getCollection<TSchema = MongoDocument>(name: string): Collection<TSchema>;
  getCollectionNames(): string[];
  getCollectionInfos(filter?: MongoQuery): MongoDocument[];
  getName(): string;

  createCollection(name: string, options?: CreateCollectionOptions): MongoDocument;
  createView(name: string, source: string, pipeline: MongoQuery[], options?: MongoQuery): MongoDocument;

  runCommand(command: MongoQuery): MongoDocument;
  adminCommand(command: MongoQuery): MongoDocument;
  aggregate(pipeline: MongoQuery[], options?: MongoQuery): AggregationCursor;
  dropDatabase(): MongoDocument;
  stats(scale?: number): MongoDocument;
}

/**
 * Maps a collection name to its document type, so that `db.<name>` is typed.
 *
 * Empty here on purpose: this file describes mongosh, not StaySpot. The
 * project's collections are merged into this interface from
 * types/collections.d.ts. A collection left out of it still resolves, just
 * with an unchecked document type.
 */
interface CollectionSchemas {}

/**
 * The shell's database handle.
 *
 * The intersection is what makes `db.SearchSessions.insertOne(...)` resolve.
 * A single interface cannot declare both `getSiblingDB()` and a
 * `[name: string]: Collection` index signature - every declared member would
 * have to be assignable to the index signature - but an intersection can.
 *
 * Resolution order is what makes this useful: a name declared in
 * `CollectionSchemas` gets its precise document type, anything else falls
 * through to the index signature. The flip side is that declared members win
 * outright, so a collection literally named `stats` or `find` collides with a
 * `DatabaseMethods` member and has to be reached through
 * `db.getCollection("stats")`.
 */
type Database = DatabaseMethods & {
  [K in keyof CollectionSchemas]: Collection<CollectionSchemas[K]>;
} & { [collectionName: string]: Collection };

// ---------------------------------------------------------------------------
// Shell globals
// ---------------------------------------------------------------------------

/**
 * The current database. Declared with `var`, not `const`, because the standard
 * shell-script idiom reassigns it: `db = db.getSiblingDB("StaySpot")`.
 */
declare var db: Database;

/** Switches the active database, as the bare `use <name>` shell command does. */
declare function use(name: string): void;

/**
 * Opt-in flag for the workflow scripts, injected from the command line:
 *
 *     mongosh --eval "EXPLAIN=true" -f mongo/02_workflow3_geonear.js
 *
 * When set, a workflow prints its `explain("executionStats")` plan instead of
 * its results, which is how performance/mongo_execution_stats.json is produced.
 *
 * Declared as possibly-undefined because the usual invocation does NOT set it.
 * Guard every read with `typeof EXPLAIN !== "undefined"`: reading an
 * identifier that was never declared is a ReferenceError in JavaScript
 * whether or not the script is in strict mode, and this declaration only
 * silences the type checker, not the runtime.
 */
declare var EXPLAIN: boolean | undefined;

declare function print(...args: any[]): void;
declare function printjson(value: any): void;
declare function sleep(milliseconds: number): void;
declare function quit(exitCode?: number): void;
/** Evaluates another script file in the current shell session. */
declare function load(path: string): boolean;
