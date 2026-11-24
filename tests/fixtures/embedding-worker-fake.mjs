/**
 * Fake embedding worker for subprocess IPC tests. Speaks the same JSON-line
 * protocol as src/services/embedding-worker.ts without loading ONNX.
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let warmed = false;

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (error) {
    send({ id: -1, ok: false, error: String(error) });
    continue;
  }
  if (request.type === "warmup") {
    warmed = true;
    send({ id: request.id, ok: true });
    continue;
  }
  if (request.type === "embed") {
    if (!warmed) {
      send({ id: request.id, ok: false, error: "not warmed up" });
      continue;
    }
    const n = Math.max(1, Number(request.text?.length ?? 1));
    send({ id: request.id, ok: true, vector: [n, n + 1, n + 2] });
    continue;
  }
  if (request.type === "dispose") {
    warmed = false;
    send({ id: request.id, ok: true });
    continue;
  }
  send({ id: request.id ?? -1, ok: false, error: "unknown type" });
}
