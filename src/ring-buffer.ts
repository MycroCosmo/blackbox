/** In-memory ring buffer for recent log lines (spec 4.2).
 *  Evicts by line count, age, and total memory so unbounded child output
 *  can never grow recorder memory without limit. */

export interface BufferedLine {
  text: string;
  at: number; // epoch ms
  stream: "stdout" | "stderr";
}

export interface RingBufferOptions {
  maxLines: number;
  maxAgeSeconds: number;
  maxMemoryMB: number;
}

export class RingBuffer {
  private lines: BufferedLine[] = [];
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(private readonly opts: RingBufferOptions) {
    this.maxBytes = Math.max(1, opts.maxMemoryMB) * 1024 * 1024;
  }

  push(text: string, stream: "stdout" | "stderr", at = Date.now()): void {
    this.lines.push({ text, at, stream });
    this.bytes += text.length + 16;
    this.evict(at);
  }

  private evict(now: number): void {
    const minAt = now - this.opts.maxAgeSeconds * 1000;
    while (
      this.lines.length > 0 &&
      (this.lines.length > this.opts.maxLines ||
        this.bytes > this.maxBytes ||
        this.lines[0]!.at < minAt)
    ) {
      const dropped = this.lines.shift()!;
      this.bytes -= dropped.text.length + 16;
    }
  }

  /** Freeze the buffer contents (spec: called when an error occurs). */
  snapshot(): BufferedLine[] {
    return [...this.lines];
  }

  get size(): number {
    return this.lines.length;
  }
}
