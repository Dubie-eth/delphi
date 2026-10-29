/// <reference lib="webworker" />
import { buildMatrices, freivaldsCheck, matmulInt8, mulberry32, randInt8 } from "@delphi/node/freivaldsCore";

export type WorkerIn =
  | { type: "start"; seed: number; n: number; plantFault: boolean }
  | { type: "stop" };

export type WorkerOut =
  | { type: "ready"; resultHash: string; multiplyMs: number; n: number }
  | { type: "check"; ok: boolean; ms: number }
  | { type: "stopped" };

let running = false;

function benchMultiply(seed: number, n: number): number {
  const rng = mulberry32(seed ^ n);
  const A = new Int8Array(n * n);
  const B = new Int8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    A[i] = randInt8(rng);
    B[i] = randInt8(rng);
  }
  const t0 = performance.now();
  matmulInt8(A, B, n);
  return performance.now() - t0;
}

async function runLoop(msg: Extract<WorkerIn, { type: "start" }>) {
  running = true;
  const { seed, n, plantFault } = msg;
  const { A, B, C, resultHash } = buildMatrices(seed, n, plantFault);
  const multiplyMs = benchMultiply(seed, n);
  postMessage({ type: "ready", resultHash, multiplyMs, n } satisfies WorkerOut);

  const rng = mulberry32(seed ^ 0x9e3779b9);
  while (running) {
    const t0 = performance.now();
    const ok = freivaldsCheck(A, B, C, n, rng);
    const ms = performance.now() - t0;
    postMessage({ type: "check", ok, ms } satisfies WorkerOut);
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  postMessage({ type: "stopped" } satisfies WorkerOut);
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === "stop") {
    running = false;
    return;
  }
  if (msg.type === "start") {
    running = false;
    void runLoop(msg);
  }
};
