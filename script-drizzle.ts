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
if (col === undefined) {
  throw new Error("Column not found");
}
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
  SELECT id, json_typeof((value#>>'{}')::json) AS unwrapped_type
  FROM test_json
  ORDER BY id
`);
for (const row of unwrapped) {
  console.log(`  id=${row.id}  unwrapped_type=${row.unwrapped_type}`);
}

// --- cleanup ---
await db.execute(sql`DROP TABLE IF EXISTS test_json`);
await db.execute(sql`DROP TABLE IF EXISTS drizzle.__drizzle_migrations`);
console.log("\n[drizzle] tables dropped, done.");

client.close();
