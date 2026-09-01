import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { attachNodeDisconnectHandlers } from "../src/services/web-server.js";
import {
  EXTERNAL_PROFILE_CLEANUP_TIMEOUT_MS,
  NODE_HTTP_IDLE_TIMEOUT_MS,
  OPENCODE_PROFILE_CLEANUP_TIMEOUT_MS,
} from "../src/services/request-timeouts.js";

class RequestStub extends EventEmitter {
  aborted = false;
  complete = false;
  socket = new EventEmitter();
}

class ResponseStub extends EventEmitter {
  writableEnded = false;
}

describe("Node web request lifecycle", () => {
  it("does not disconnect when a fully consumed request body emits close", () => {
    const req = new RequestStub();
    const res = new ResponseStub();
    let disconnects = 0;
    req.complete = true;

    attachNodeDisconnectHandlers(req, res, () => {
      disconnects += 1;
    });
    req.emit("close");

    expect(disconnects).toBe(0);
  });

  it("disconnects once when the client aborts before the response ends", () => {
    const req = new RequestStub();
    const res = new ResponseStub();
    let disconnects = 0;

    attachNodeDisconnectHandlers(req, res, () => {
      disconnects += 1;
    });
    req.aborted = true;
    req.emit("aborted");
    req.emit("close");
    res.emit("close");

    expect(disconnects).toBe(1);
  });

  it("ignores response close after a completed response", () => {
    const req = new RequestStub();
    const res = new ResponseStub();
    let disconnects = 0;
    res.writableEnded = true;

    attachNodeDisconnectHandlers(req, res, () => {
      disconnects += 1;
    });
    res.emit("close");
    req.socket.emit("close");

    expect(disconnects).toBe(0);
  });

  it("keeps the HTTP timeout above every cleanup deadline", () => {
    expect(NODE_HTTP_IDLE_TIMEOUT_MS).toBeGreaterThan(EXTERNAL_PROFILE_CLEANUP_TIMEOUT_MS);
    expect(NODE_HTTP_IDLE_TIMEOUT_MS).toBeGreaterThan(OPENCODE_PROFILE_CLEANUP_TIMEOUT_MS);
  });
});
