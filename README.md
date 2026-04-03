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
