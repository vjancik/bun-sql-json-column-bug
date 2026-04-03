import { SQL } from "bun";

const sql = new SQL("postgresql://repro:repro@localhost:5499/repro");

// --- setup ---
await sql`
  CREATE TABLE IF NOT EXISTS test_jsonb_raw (
    id serial PRIMARY KEY,
    value jsonb NOT NULL
  )
`;

// --- assert column type ---
const [col] = await sql`
  SELECT data_type
  FROM information_schema.columns
  WHERE table_name = 'test_jsonb_raw' AND column_name = 'value'
`;
if (col === undefined) {
  throw new Error("Column not found");
}
console.log("[raw/jsonb] column data_type:", col.data_type);
console.assert(col.data_type === "jsonb", "Expected column type to be 'jsonb'");

// --- insert via literal SQL values (no JS serialization) ---
await sql`INSERT INTO test_jsonb_raw (value) VALUES ('{"hello":"world"}'::jsonb)`;
await sql`INSERT INTO test_jsonb_raw (value) VALUES ('[1,2,3]'::jsonb)`;
await sql`INSERT INTO test_jsonb_raw (value) VALUES ('42'::jsonb)`;

// --- query literal rows ---
const literalRows = await sql`
  SELECT id, value, jsonb_typeof(value) AS type
  FROM test_jsonb_raw
  ORDER BY id
`;

console.log("\n[raw/jsonb/literal] stored rows (inserted as SQL literals, no JS stringify):");
for (const row of literalRows) {
  console.log(`  id=${row.id}  type=${row.type}  raw value:`, row.value);
}

// --- cleanup literal rows ---
await sql`DELETE FROM test_jsonb_raw`;

// --- insert via JS object params (JSON.stringify'd by caller) ---
await sql`INSERT INTO test_jsonb_raw (value) VALUES (${JSON.stringify({ hello: "world" })}::jsonb)`;
await sql`INSERT INTO test_jsonb_raw (value) VALUES (${JSON.stringify([1, 2, 3])}::jsonb)`;
await sql`INSERT INTO test_jsonb_raw (value) VALUES (${JSON.stringify(42)}::jsonb)`;

// --- query ---
const rows = await sql`
  SELECT id, value, jsonb_typeof(value) AS type
  FROM test_jsonb_raw
  ORDER BY id
`;

console.log("\n[raw/jsonb/params] stored rows (inserted via JSON.stringify params):");
for (const row of rows) {
  console.log(`  id=${row.id}  type=${row.type}  raw value:`, row.value);
}

// --- show the bug: unwrap double-encoding ---
console.log("\n[raw/jsonb] unwrapped (stripping one layer of encoding):");
const unwrapped = await sql`
  SELECT id, jsonb_typeof((value#>>'{}')::jsonb) AS unwrapped_type
  FROM test_jsonb_raw
  ORDER BY id
`;
for (const row of unwrapped) {
  console.log(`  id=${row.id}  unwrapped_type=${row.unwrapped_type}`);
}

// --- cleanup ---
await sql`DROP TABLE test_jsonb_raw`;
console.log("\n[raw/jsonb] table dropped, done.");

await sql.close();
