import { oss } from "../oss/index.js";
import { postgres } from "../postgres/index.js";
import { CallRecorder } from "./call-recorder.js";
import { initSpanTable } from "./table.js";
import type { SpanSeed } from "./type.js";

class Tracer {
  private readonly pending = new Set<Promise<void>>();
  private alive = false;

  get ready(): boolean {
    return this.alive;
  }

  async init(): Promise<boolean> {
    this.alive = false;

    try {
      await oss.ping();
    } catch (err) {
      console.error("[trace] 链路不记：本地对象存储探不通", err);
      return false;
    }

    try {
      await postgres.connect();
      await initSpanTable();
    } catch (err) {
      console.error("[trace] 链路不记：PG 连不上", err);
      return false;
    }

    this.alive = true;
    return true;
  }


  begin(seed: SpanSeed): CallRecorder | null {
    if (!this.alive || !seed.ctx) return null;
    return new CallRecorder(seed, seed.ctx);
  }

  track(flushing: Promise<void>): void {
    const guarded = flushing.catch((err: unknown) => {
      console.error("[trace] flush 挂了", err);
    });
    this.pending.add(guarded);
    void guarded.finally(() => this.pending.delete(guarded));
  }

  async drain(): Promise<number> {
    const waiting = [...this.pending];
    await Promise.allSettled(waiting);
    return waiting.length;
  }
}

export const tracer = new Tracer();
