// SPDX-License-Identifier: MIT
/**
 * `ignoreClosedOutput` (src/cli/closed-output.ts): the rule that a write error meaning "the reader is gone" is ignored and
 * any other write error is not. The behaviour through the product entry — `egr index` with its pipes closed, and an
 * orphaned run after `egr watch` is killed — is proven in `egr-watch.test.ts`; this file pins the rule itself in-process.
 */
import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";

import { ignoreClosedOutput, isReaderGone } from "../src/cli/closed-output.js";

const withCode = (code: string): Error => Object.assign(new Error(`write ${code}`), { code });
const sink = (): NodeJS.WriteStream => new Writable({ write: (_c, _e, cb) => cb() }) as unknown as NodeJS.WriteStream;

describe("ignoreClosedOutput", () => {
  it("says a reader is gone for EPIPE, ECONNRESET and a destroyed stream, and for nothing else", () => {
    expect(isReaderGone(withCode("EPIPE"))).toBe(true);
    expect(isReaderGone(withCode("ECONNRESET"))).toBe(true);
    expect(isReaderGone(withCode("ERR_STREAM_DESTROYED"))).toBe(true);
    expect(isReaderGone(withCode("ENOSPC"))).toBe(false);
    expect(isReaderGone(new Error("no code"))).toBe(false);
    expect(isReaderGone(undefined)).toBe(false);
    expect(isReaderGone(null)).toBe(false);
  });

  it("an EPIPE on a stream it watches is swallowed (an unwatched stream would throw), while a full disk is still an error", () => {
    const a = sink();
    const b = sink();
    const unwatched = sink();
    expect(() => unwatched.emit("error", withCode("EPIPE"))).toThrow(/EPIPE/); // the default it replaces
    const onError = ignoreClosedOutput([a, b]);
    expect(() => a.emit("error", withCode("EPIPE"))).not.toThrow();
    expect(() => b.emit("error", withCode("ECONNRESET"))).not.toThrow();
    expect(() => a.emit("error", withCode("ENOSPC"))).toThrow(/ENOSPC/);
    expect(() => onError(withCode("EPIPE"))).not.toThrow();
  });
});
