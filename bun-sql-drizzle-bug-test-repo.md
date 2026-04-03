# Bug: Drizzle ORM double-encodes JSON column values with Bun SQL driver

## Summary

When using `drizzle-orm` with the `bun-sql` driver (`drizzle-orm/bun-sql`), values inserted into
`json` columns are double-encoded — i.e. the value is `JSON.stringify`'d by Drizzle before being
handed to Bun's SQL driver, which then stringifies it again. The result is a JSON string value
stored in the column instead of the raw JSON object/array/number.

Raw `bun:sql` does **not** exhibit this behaviour — it correctly stores the unencoded value.

## Reproduction

### Prerequisites

- [Bun](https://bun.sh) >= 1.x
- Docker + Docker Compose

### Project structure

```
.
├── docker-compose.yml
├── drizzle.config.ts
├── drizzle/
│   └── 0000_create_test_table.sql
├── schema.ts
├── script-raw.ts
└── script-drizzle.ts
```

---

### `docker-compose.yml`

```yaml
name: json-bug-repro

services:
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: repro
      POSTGRES_PASSWORD: repro
      POSTGRES_DB: repro
    ports:
      - "5499:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U repro -d repro"]
      interval: 5s
      timeout: 5s
      retries: 10
```

Start with:

```sh
docker compose up -d
```

---

### `schema.ts`

```ts
import { pgTable, serial, json } from "drizzle-orm/pg-core";

export const testTable = pgTable("test_json", {
  id: serial("id").primaryKey(),
  value: json("value").notNull(),
});
```

---

### `drizzle.config.ts`

```ts
import type { Config } from "drizzle-kit";

export default {
  schema: "./schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: "postgresql://repro:repro@localhost:5499/repro",
  },
} satisfies Config;
```

---

### `drizzle/0000_create_test_table.sql`

```sql
CREATE TABLE IF NOT EXISTS "test_json" (
  "id" serial PRIMARY KEY NOT NULL,
  "value" json NOT NULL
);
```

---

### Script 1 — `script-raw.ts` (raw `bun:sql`)

Uses `bun:sql` directly. Creates the table, asserts the column type, inserts an object, an array,
and a number, queries the raw stored values and their `json_typeof`, then drops the table.

```ts
import { SQL } from "bun";

const sql = new SQL("postgresql://repro:repro@localhost:5499/repro");

// --- setup ---
await sql`
  CREATE TABLE IF NOT EXISTS test_json_raw (
    id serial PRIMARY KEY,
    value json NOT NULL
  )
`;

// --- assert column type ---
const [col] = await sql`
  SELECT data_type
  FROM information_schema.columns
  WHERE table_name = 'test_json_raw' AND column_name = 'value'
`;
console.log("[raw] column data_type:", col.data_type);
console.assert(col.data_type === "json", "Expected column type to be 'json'");

// --- insert ---
await sql`INSERT INTO test_json_raw (value) VALUES (${JSON.stringify({ hello: "world" })}::json)`;
await sql`INSERT INTO test_json_raw (value) VALUES (${JSON.stringify([1, 2, 3])}::json)`;
await sql`INSERT INTO test_json_raw (value) VALUES (${JSON.stringify(42)}::json)`;

// --- query ---
const rows = await sql`
  SELECT id, value, json_typeof(value) AS type
  FROM test_json_raw
  ORDER BY id
`;

console.log("\n[raw] stored rows:");
for (const row of rows) {
  console.log(`  id=${row.id}  type=${row.type}  raw value:`, row.value);
}

// --- cleanup ---
await sql`DROP TABLE test_json_raw`;
console.log("\n[raw] table dropped, done.");

await sql.close();
```

**Expected output:**

```
[raw] column data_type: json
[raw] stored rows:
  id=1  type=object  raw value: { hello: 'world' }
  id=2  type=array   raw value: [ 1, 2, 3 ]
  id=3  type=number  raw value: 42
[raw] table dropped, done.
```

---

### Script 2 — `script-drizzle.ts` (Drizzle ORM + `bun-sql` driver)

Uses `drizzle-orm/bun-sql`. Runs the migration via `drizzle-orm/bun-sql/migrator`, asserts the
column type, inserts the same three rows, selects them with `json_typeof` via a raw SQL expression,
then drops all tables.

```ts
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { sql } from "drizzle-orm";
import { testTable } from "./schema";

const client = new SQL("postgresql://repro:repro@localhost:5499/repro");
const db = drizzle(client, { schema: { testTable } });

// --- migrate ---
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("[drizzle] migration complete");

// --- assert column type ---
const [col] = await db.execute(sql`
  SELECT data_type
  FROM information_schema.columns
  WHERE table_name = 'test_json' AND column_name = 'value'
`);
console.log("[drizzle] column data_type:", col.data_type);
console.assert(col.data_type === "json", "Expected column type to be 'json'");

// --- insert ---
await db.insert(testTable).values([
  { value: { hello: "world" } },
  { value: [1, 2, 3] },
  { value: 42 },
]);

// --- query ---
const rows = await db.execute(sql`
  SELECT id, value, json_typeof(value) AS type
  FROM test_json
  ORDER BY id
`);

console.log("\n[drizzle] stored rows:");
for (const row of rows) {
  console.log(`  id=${row.id}  type=${row.type}  raw value:`, row.value);
}

// --- show the bug: unwrap double-encoding ---
console.log("\n[drizzle] unwrapped (stripping one layer of encoding):");
const unwrapped = await db.execute(sql`
  SELECT id, json_typeof((value#>>'{}')::jsonb) AS unwrapped_type
  FROM test_json
  ORDER BY id
`);
for (const row of unwrapped) {
  console.log(`  id=${row.id}  unwrapped_type=${row.unwrapped_type}`);
}

// --- cleanup ---
await db.execute(sql`DROP TABLE IF EXISTS test_json`);
await db.execute(sql`DROP TABLE IF EXISTS drizzle_migrations`);
console.log("\n[drizzle] tables dropped, done.");

client.close();
```

**Expected output (no bug):**

```
[drizzle] migration complete
[drizzle] column data_type: json
[drizzle] stored rows:
  id=1  type=object  raw value: { hello: 'world' }
  id=2  type=array   raw value: [ 1, 2, 3 ]
  id=3  type=number  raw value: 42
```

**Actual output (bug):**

```
[drizzle] migration complete
[drizzle] column data_type: json
[drizzle] stored rows:
  id=1  type=string  raw value: '{"hello":"world"}'
  id=2  type=string  raw value: '[1,2,3]'
  id=3  type=string  raw value: '42'

[drizzle] unwrapped (stripping one layer of encoding):
  id=1  unwrapped_type=object
  id=2  unwrapped_type=array
  id=3  unwrapped_type=number
```

The `unwrapped` query confirms the values are double-encoded: `value#>>'{}'` strips the outer JSON
string quotes, and re-parsing as `jsonb` yields the correct type.

## Workaround

Until fixed, serialize manually before passing to Drizzle and store the column as `text`, or
deserialize on read with `(value#>>'{}')::jsonb`.

## Environment

- `bun`: (fill in version — `bun --version`)
- `drizzle-orm`: (fill in version)
- `drizzle-kit`: (fill in version)
- PostgreSQL: 18
