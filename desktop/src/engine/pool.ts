import type { WorkerIn, WorkerOut } from "./freivalds.worker";

export type PoolCallbacks = {
  onReady: (resultHash: string) => void;
  onCheck: (ok: boolean, ms: number) => void;
};

export class FreivaldsPool {
  private workers: Worker[] = [];
  private readyCount = 0;
  private resultHash = "";

  constructor(
    private readonly tileSize: number,
    private readonly plantFault: boolean,
    private readonly callbacks: PoolCallbacks,
    private readonly seed: number
  ) {}

  start() {
    const cores = Math.max(1, navigator.hardwareConcurrency || 1);
    this.workers = [];
    this.readyCount = 0;
    for (let i = 0; i < cores; i++) {
      const w = new Worker(new URL("./freivalds.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<WorkerOut>) => this.handleMessage(ev.data);
      w.postMessage({
        type: "start",
        seed: this.seed,
        n: this.tileSize,
        plantFault: this.plantFault,
      } satisfies WorkerIn);
      this.workers.push(w);
    }
  }

  stop() {
    for (const w of this.workers) {
      w.postMessage({ type: "stop" } satisfies WorkerIn);
      w.terminate();
    }
    this.workers = [];
  }

  restart(seed: number) {
    for (const w of this.workers) {
      w.postMessage({
        type: "start",
        seed,
        n: this.tileSize,
        plantFault: this.plantFault,
      } satisfies WorkerIn);
    }
  }

  private handleMessage(msg: WorkerOut) {
    if (msg.type === "ready") {
      this.readyCount++;
      if (msg.resultHash) this.resultHash = msg.resultHash;
      if (this.readyCount === 1) {
        this.callbacks.onReady(this.resultHash);
      }
    } else if (msg.type === "check") {
      this.callbacks.onCheck(msg.ok, msg.ms);
    }
  }
}
