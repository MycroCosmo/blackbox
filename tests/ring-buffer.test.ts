import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/ring-buffer.js";

describe("RingBuffer", () => {
  it("caps by line count", () => {
    const buf = new RingBuffer({ maxLines: 3, maxAgeSeconds: 3600, maxMemoryMB: 10 });
    for (let i = 0; i < 10; i++) buf.push(`line ${i}`, "stdout");
    const lines = buf.snapshot().map((l) => l.text);
    expect(lines).toEqual(["line 7", "line 8", "line 9"]);
  });

  it("drops lines older than maxAgeSeconds", () => {
    const buf = new RingBuffer({ maxLines: 100, maxAgeSeconds: 300, maxMemoryMB: 10 });
    const now = Date.now();
    buf.push("old", "stdout", now - 301_000);
    buf.push("fresh", "stdout", now);
    expect(buf.snapshot().map((l) => l.text)).toEqual(["fresh"]);
  });

  it("caps by memory so huge output cannot grow unbounded (spec 14)", () => {
    const buf = new RingBuffer({ maxLines: 1_000_000, maxAgeSeconds: 3600, maxMemoryMB: 1 });
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 100; i++) buf.push(big, "stdout");
    expect(buf.size).toBeLessThan(20);
  });
});
