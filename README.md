# Bug Report: `json`/`jsonb` column values are double-encoded with `bun:sql`

## What steps can reproduce the bug?

1. Create a table with a `json` (or `jsonb`) column
2. Insert a JS object, array, or number via a `bun:sql` template literal with a `::json` cast, passing the value through `JSON.stringify`
3. Query the raw stored value and its `json_typeof`

```ts
await sql`INSERT INTO test_json (value) VALUES (${JSON.stringify({ hello: "world" })}::json)`;
```

Then inspect:

```sql
SELECT id, value, json_typeof(value) FROM test_json ORDER BY id;
```

## Explain the bug

When passing `JSON.stringify(value)` into a `bun:sql` template literal, Bun binds it as a `text` parameter. Postgres receives a quoted string literal — e.g. `'{"hello":"world"}'` — and with the `::json` cast, stores it as a JSON string value rather than a JSON object. The value ends up encoded twice: once by `JSON.stringify`, once by Bun's text binding.

The double-encoding can be confirmed by stripping one layer with `value#>>'{}'` and re-parsing:

```sql
SELECT id, json_typeof((value#>>'{}')::json) AS unwrapped_type FROM test_json ORDER BY id;
```

This yields the correct types (`object`, `array`, `number`), proving the values are wrapped in an extra string layer.

## What is the expected behavior?

```
stored rows:
  id=1  type=object  raw value: { hello: 'world' }
  id=2  type=array   raw value: [ 1, 2, 3 ]
  id=3  type=number  raw value: 42
```

The `json_typeof` of each stored value should match the JS type of the value that was inserted.

## What do you see instead?

```
stored rows:
  id=1  type=string  raw value: '{"hello":"world"}'
  id=2  type=string  raw value: '[1,2,3]'
  id=3  type=string  raw value: '42'

unwrapped (stripping one layer of encoding):
  id=1  unwrapped_type=object
  id=2  unwrapped_type=array
  id=3  unwrapped_type=number
```

All three rows are stored as JSON strings. The unwrap query confirms a second layer of encoding is present.

## Additional information

- The bug affects both `json` and `jsonb` column types.
- Passing a raw JS number (e.g. `${42}`) directly without `JSON.stringify` fails with `integer cannot be cast to json`, because Bun preserves the native integer type and Postgres has no direct `integer → json` cast. This confirms Bun does not automatically serialize JS values to JSON — the caller must stringify explicitly, but doing so causes the double-encoding described above.
- Inserting via SQL string literals (no JS parameter binding) works correctly: `INSERT INTO test_json (value) VALUES ('{"hello":"world"}'::json)`.

## Update: Bun 1.4.4 and `sql.json()`

Bun 1.4.4 adds `sql.json(value)`, which binds any JS value as JSON. This changes how the report above should be read:

- **Raw `bun:sql` is working as documented.** The [Bun SQL docs](https://bun.sh/docs/runtime/sql) say that PostgreSQL stores a string passed to a `json`/`jsonb` parameter as a JSON string, and that you should pass the object itself instead of `JSON.stringify(object)`. So the double-encoding in `script-raw.ts` and `script-raw-jsonb.ts` comes from calling `JSON.stringify` first. Bun is behaving as designed.
- **Bun does serialize objects and arrays.** This corrects the "Additional information" bullet above: passing `${{ hello: "world" }}` or `${[1, 2, 3]}` stores an object or an array. Numbers and booleans still fail, because Bun binds them as `integer`/`boolean` and PostgreSQL won't assign those to `json`. That case is what `sql.json` is for.
- **Drizzle is still affected.** Its `json()`/`jsonb()` columns call `JSON.stringify` before handing the value to Bun. The repro still double-encodes on drizzle-orm `0.45.4` (latest stable) and `1.0.0-beta.22` (latest beta). The unreleased `beta` branch no longer stringifies, but numbers and booleans then throw (see [issues/drizzle-orm-bun-json-driver.md](issues/drizzle-orm-bun-json-driver.md)).
- **`sql.json` is new in 1.4.4.** It isn't in Bun 1.4.3 or earlier, at runtime or in `bun-types`.

### How Bun 1.4.4 binds a value to a `json`/`jsonb` parameter

With the default `prepare: true`:

| JS value | `${value}` | `${JSON.stringify(value)}` | `${sql.json(value)}` |
|---|---|---|---|
| object / array | ✅ object / array | ❌ JSON string | ✅ object / array |
| string | ✅ JSON string | ❌ JSON string of the JSON text | ✅ JSON string |
| number / boolean | ❌ error (`integer` → `json`) | ❌ JSON string | ✅ number / boolean |
| `null` | SQL `NULL` | ❌ JSON string `"null"` | JSON `null` |

With `prepare: false`, Bun sends a string unchanged, so the string must already be JSON text:

| JS value | `${value}` | `${JSON.stringify(value)}` | `${sql.json(value)}` |
|---|---|---|---|
| object / array | ✅ (❌ invalid JSON on Bun ≤ 1.4.3) | ✅ | ✅ |
| string | ❌ invalid JSON | ✅ | ✅ |
| number / boolean | ❌ error (`integer` → `json`) | ✅ | ✅ |
| `null` | SQL `NULL` | JSON `null` | JSON `null` |

`sql.json` is the only option that is correct in every row of both tables. A `SQLJSONParameter` from one `SQL` instance also works on another, and `Bun.sql.json()` works without a `DATABASE_URL`.

### When `sql.json` isn't needed

With the default `prepare: true`, pass the value directly when it is:

- **an object or array:** `${{ theme: "dark" }}`, `${[1, 2, 3]}`
- **a string you want stored as a JSON string:** `${"dark"}` stores `"dark"`
- **`null` meant as SQL `NULL`:** `${null}`

Use `sql.json` for:

- **numbers and booleans:** `${sql.json(42)}`, `${sql.json(true)}`
- **JSON `null`:** `${sql.json(null)}`
- **strings and objects under `prepare: false`**, or any value whose type you don't know in advance

SQL literals (`'{"hello":"world"}'::json`) don't bind a parameter, so they never need it. Never pass `JSON.stringify(value)` with `prepare: true`, because that is what double-encodes.

### Drizzle override

Until Drizzle's bun-sql driver handles this, replace `json()`/`jsonb()` with a custom column type that hands the value to `sql.json`. Drizzle passes the returned `SQLJSONParameter` to Bun unchanged:

```ts
import { SQL } from "bun";
import { customType } from "drizzle-orm/pg-core";

export const client = new SQL("postgresql://repro:repro@localhost:5499/repro");

// Bun >= 1.4.4
export const bunJsonb = <T>(name: string) =>
  customType<{ data: T; driverData: unknown }>({
    dataType: () => "jsonb", // or "json"
    toDriver: (value) => client.json(value),
    fromDriver: (value) => value as T, // Bun already parses json/jsonb on read
  })(name);
```

To support Bun older than 1.4.4 as well, return SQL that casts JSON text instead. A `text` parameter is sent unchanged, and PostgreSQL parses it on the cast:

```ts
import { sql } from "drizzle-orm";

// any Bun version
toDriver: (value) => sql`${JSON.stringify(value)}::text::jsonb`,
```

Both versions were tested on drizzle-orm `0.45.4` and `1.0.0-beta.22`:

- `insert`, `select`, `update`, `where` on the column, and relational queries (`findMany`, including nested `with`) all keep the six value types correct: object, array, number, boolean, string and `null`.
- Drizzle never calls `toDriver` for `null`, so a JS `null` is stored as SQL `NULL`.
- On 1.x, create the db with `drizzle({ client })`. The beta treats a bare `drizzle(client)` as connection options and silently connects to `localhost:5432` instead.

### Tested with

- Bun 1.4.4, 1.4.3, 1.3.11
- drizzle-orm 0.45.4, 1.0.0-beta.22, and the `beta` branch at `5d71fc4`
- drizzle-kit 0.31.11
- PostgreSQL 18 (`postgres:18-alpine`)
