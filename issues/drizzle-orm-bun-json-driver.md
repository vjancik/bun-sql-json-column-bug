# [BUG] bun-sql (PostgreSQL): `json`/`jsonb` values are double-encoded, or throw for numbers and booleans

## Summary

Values written to `json`/`jsonb` columns with the `bun-sql` PostgreSQL driver don't survive the round trip:

- **drizzle-orm `0.45.4` (latest) and `1.0.0-beta.22` (latest beta):** every value is stored as a JSON **string**. `{ hello: "world" }` becomes `"{\"hello\":\"world\"}"`, and `42` becomes `"42"`.
- **`beta` branch at `5d71fc4`:** objects, arrays and strings are stored correctly, but numbers and booleans throw `column "value" is of type json but expression is of type integer`. With `prepare: false`, strings fail too.

Bun 1.4.4 added `sql.json(value)`, which binds any JS value as JSON. Below is a small patch to the bun-sql codecs that uses `sql.json` when the client has it and falls back to a `::text::json(b)` cast on older Bun. With the patch, all value types are stored correctly on Bun 1.4.4, 1.4.3 and 1.3.11, with `prepare` on and off.

## Reproduction

```ts
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";
import { pgTable, serial, jsonb } from "drizzle-orm/pg-core";

const client = new SQL("postgresql://user:pass@localhost:5432/db");
const db = drizzle({ client });
const t = pgTable("t", { id: serial("id").primaryKey(), value: jsonb("value") });

await db.execute(sql`CREATE TABLE IF NOT EXISTS t (id serial PRIMARY KEY, value jsonb)`);
await db.insert(t).values([{ value: { hello: "world" } }, { value: [1, 2, 3] }, { value: 42 }, { value: true }]);
console.log(await db.execute(sql`SELECT value, jsonb_typeof(value) AS type FROM t ORDER BY id`));
```

**Expected:** `object`, `array`, `number`, `boolean`.

**Actual on 0.45.4 and 1.0.0-beta.22:** `string`, `string`, `string`, `string`.

**Actual on the `beta` branch:** the insert throws `column "value" is of type jsonb but expression is of type integer`.

## Cause

With prepared statements (Bun's default), Bun asks the server for each parameter's type. When the type is `json`/`jsonb`, Bun JSON-encodes the JS value itself:

- An object or array becomes JSON.
- A **string becomes a JSON string.** This is documented in the [Bun SQL docs](https://bun.sh/docs/runtime/sql): "PostgreSQL stores a string in a `json` or `jsonb` column as a JSON string. Pass the object itself, not `JSON.stringify(object)`."
- A number or boolean is bound as `integer`/`boolean`, which PostgreSQL won't assign to `json`.

With `prepare: false`, Bun sends a string unchanged, so the string has to be JSON text already.

This explains each version:

- **0.45.x and 1.0.0-beta.22:** `PgJson`/`PgJsonb.mapToDriverValue` returns `JSON.stringify(value)`. Bun then encodes that string as a JSON string, so every value is double-encoded.
- **`beta` branch:** the columns no longer map values. `bunSqlPgCodecs` defines only `normalizeParamArray` for `json`/`jsonb`, so a single value goes to Bun as the raw JS value. Objects, arrays and strings work. Numbers and booleans throw. With `prepare: false`, strings fail as invalid JSON, and on Bun ≤ 1.4.3 objects and arrays do too.

## Bun binding results

I ran each approach through `client.unsafe(query, [param])`, the same path `BunSQLSession` uses, into a `jsonb` column. "✗" means the stored value differs from the JS value.

| Approach | Bun 1.4.4 | Bun 1.4.3 / 1.3.11 |
|---|---|---|
| raw value, `$1` (`beta` branch today) | `prepare: true`: number and boolean throw. `prepare: false`: number, boolean and string throw | same, plus object and array throw with `prepare: false` |
| `JSON.stringify(v)`, `$1` (0.45.x / beta.22) | `prepare: true`: all ✗ (JSON string). `prepare: false`: ✅ | same |
| `JSON.stringify(v)`, `$1::text::jsonb` | ✅ all, both modes | ✅ all, both modes |
| `sql.json(v)`, `$1` | ✅ all, both modes | ❌ `sql.json is not a function` |

The values tested were object, array, number, boolean, string and `null`. `null` never reaches the codec: `collectBoundValue` skips `normalizeParam` for `null`, so it stays SQL `NULL` in every row.

Two more things I checked on 1.4.4:

- A `SQLJSONParameter` made by one `SQL` instance works on another.
- `json` is an own property of each instance, not of `SQL.prototype`, so feature detection has to check the instance.

## Proposed fix (`beta` branch)

The base `bunSqlPgCodecs` gets the cast, which works on every Bun version. When the client has `sql.json` (Bun ≥ 1.4.4), the driver uses a variant that binds through `sql.json` and drops the cast. The same code therefore runs on Bun before and after 1.4.4, and never calls a missing `sql.json`.

```diff
--- a/drizzle-orm/src/bun-sql/postgres/codecs.ts
+++ b/drizzle-orm/src/bun-sql/postgres/codecs.ts
@@ -1,5 +1,10 @@
+/// <reference types="bun-types" />
+
+import type { SQL } from 'bun';
+import { refineCodecs } from '~/codecs.ts';
 import { makePgArray, parsePgArray } from '~/pg-core/array.ts';
 import {
+	type PgCodecs,
 	arrayCompatNormalize,
 	arrayCompatNormalizeInput,
 	castToText,
@@ -164,10 +169,16 @@
 		castArray: castToTextArr,
 		normalizeParamArray: (v) => makePgArray(v),
 	},
+	// Bun binds a string to a `json`/`jsonb` parameter as a JSON string, and has no JSON encoding
+	// for a number or boolean. Sending JSON text as `text` and casting it works on every Bun version
 	json: {
+		castParam: (name) => `${name}::text::json`,
+		normalizeParam: (v) => JSON.stringify(v),
 		normalizeParamArray: arrayCompatNormalizeInput((v) => JSON.stringify(v), true),
 	},
 	jsonb: {
+		castParam: (name) => `${name}::text::jsonb`,
+		normalizeParam: (v) => JSON.stringify(v),
 		normalizeParamArray: arrayCompatNormalizeInput((v) => JSON.stringify(v), true),
 	},
 	'geometry(point)': {
@@ -248,3 +259,10 @@
 		normalizeParamArray: (v) => makePgArray(v),
 	},
 });
+
+/** Bun >= 1.4.4: `sql.json()` binds any value as JSON, so no cast is needed */
+export const bunSqlJsonPgCodecs = (client: SQL): PgCodecs =>
+	refineCodecs(bunSqlPgCodecs, {
+		json: { castParam: undefined, normalizeParam: (v) => client.json(v) },
+		jsonb: { castParam: undefined, normalizeParam: (v) => client.json(v) },
+	});
--- a/drizzle-orm/src/bun-sql/postgres/driver.ts
+++ b/drizzle-orm/src/bun-sql/postgres/driver.ts
@@ -8,7 +8,7 @@
 import type { DrizzlePgConfig } from '~/pg-core/utils.ts';
 import type { AnyRelations, EmptyRelations } from '~/relations.ts';
 import { jitCompatCheck } from '~/utils.ts';
-import { bunSqlPgCodecs } from './codecs.ts';
+import { bunSqlJsonPgCodecs, bunSqlPgCodecs } from './codecs.ts';
 import type { BunSQLQueryResultHKT } from './session.ts';
 import { BunSQLSession } from './session.ts';
 
@@ -29,7 +29,8 @@
 	client.options.bigint = true;
 	const dialect = new PgDialect({
 		useJitMappers: jitCompatCheck(config.jit),
-		codecs: config.codecs ?? bunSqlPgCodecs,
+		// `sql.json()` was added in Bun 1.4.4
+		codecs: config.codecs ?? (typeof client.json === 'function' ? bunSqlJsonPgCodecs(client) : bunSqlPgCodecs),
 	});
 	let logger;
 	if (config.logger === true) {
```

Generated SQL for an insert into a `jsonb` column:

- **Bun 1.4.4:** `values (default, $1, $2)`, with `$2` bound through `sql.json`
- **Bun 1.4.3:** `values (default, $1, $2::text::jsonb)`

`castParam` only applies to single values. `json[]`/`jsonb[]` columns resolve to `castArrayParam` and `normalizeParamArray`, which this patch doesn't change.

### Results with the patch

I ran the patched `beta` branch source directly with Bun, using its `tsconfig` paths, against PostgreSQL 18. Each run inserted the six values into `json()` and `jsonb()` columns, then read them back with `select`, ran `update().set({ value: 7 })`, and ran `where(eq(t.value, "dark"))` on `jsonb`:

| Bun | `prepare: true` | `prepare: false` |
|---|---|---|
| 1.4.4 (`sql.json` path) | ✅ all | ✅ all |
| 1.4.3 (cast path) | ✅ all | ✅ all |
| 1.3.11 (cast path) | ✅ all | ✅ all |

The unpatched branch fails as described above on all three versions.

What I haven't checked:

- I ran the patch with Bun, but haven't type-checked it with `tsc` or run it through the repo's test suite. `client.json` needs `bun-types` ≥ 1.4.4, which is the first version that declares it.
- I didn't test `json[]`/`jsonb[]` columns.

### Alternatives

- **Cast only.** Keep just the `bunSqlPgCodecs` change and drop `bunSqlJsonPgCodecs` and the detection. It is correct on every Bun version I tested, in both `prepare` modes. The cost is a `::text::json(b)` cast in the SQL and a text round trip. `sql.json` is Bun's documented API for this and leaves the SQL unchanged, which is why the patch prefers it when it's available.
- **Change `normalizeParam` only, without the cast.** Using `client.json` when it exists and `JSON.stringify` otherwise wouldn't throw on older Bun. But with `prepare: true` (the default) every value would still be double-encoded there. The cast fallback fixes older Bun completely, so I don't recommend this option.

## 0.45.x

0.45.x has no codec layer. `PgJson`/`PgJsonb.mapToDriverValue` stringifies regardless of the driver, so the patch above doesn't apply there. Users on 0.45.x can work around it with a custom type. Both variants below work on 0.45.4 and 1.0.0-beta.22, and Drizzle never calls `toDriver` for `null`, so `null` stays SQL `NULL`:

```ts
const bunJsonb = <T>(name: string) =>
  customType<{ data: T; driverData: unknown }>({
    dataType: () => "jsonb",
    toDriver: (value) => client.json(value), // Bun >= 1.4.4
    // toDriver: (value) => sql`${JSON.stringify(value)}::text::jsonb`, // any Bun version
    fromDriver: (value) => value as T,
  })(name);
```

## Environment

- drizzle-orm: `0.45.4`, `1.0.0-beta.22`, and the `beta` branch at `5d71fc4`
- drizzle-kit: `0.31.11`
- Bun: 1.4.4, 1.4.3, 1.3.11 (Linux x64)
- PostgreSQL 18 (`postgres:18-alpine`)
