import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";

const dbPath = join(tmpdir(), `opencode-mem-libsql-smoke-${process.pid}-${Date.now()}.db`);
const client = createClient({ url: `file:${dbPath}` });

try {
  await client.batch(
    [
      "CREATE TABLE vectors (id INTEGER PRIMARY KEY, vector F32_BLOB(4) NOT NULL)",
      "CREATE INDEX vectors_idx ON vectors (libsql_vector_idx(vector, 'metric=cosine'))",
      "INSERT INTO vectors (vector) VALUES (vector32('[1,0,0,0]'))",
    ],
    "write"
  );
  const result = await client.execute(
    "SELECT id FROM vector_top_k('vectors_idx', vector32('[1,0,0,0]'), 1)"
  );
  assert.equal(result.rows.length, 1, "vector_top_k must return the inserted vector");
  assert.equal(Number(result.rows[0]?.id), 1, "vector_top_k must return the expected row");
  console.log("libSQL vector smoke test passed");
} finally {
  client.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}
