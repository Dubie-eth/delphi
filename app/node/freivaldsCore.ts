/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt8(rng: () => number): number {
  return (Math.floor(rng() * 256) & 0xff) - 128;
}

export function randBit01(rng: () => number): number {
  return rng() < 0.5 ? 0 : 1;
}

export const iadd = (a: number, b: number): number => (a + b) | 0;

export function matmulInt8(A: Int8Array, B: Int8Array, n: number): Int32Array {
  const C = new Int32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const a = A[i * n + k];
      for (let j = 0; j < n; j++) {
        C[i * n + j] = iadd(C[i * n + j], Math.imul(a, B[k * n + j]));
      }
    }
  }
  return C;
}

export function fnv1a32(data: Int32Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i] & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (data[i] >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (data[i] >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (data[i] >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export type FreivaldsRng = () => number;

/**
 * Freivalds: verify C ≈ A×B using random r ∈ {0,1}^n.
 * Uses Float64 accumulators (exact for these magnitudes) and Math.imul for products.
 */
export function freivaldsCheck(
  A: Int8Array,
  B: Int8Array,
  C: Int32Array,
  n: number,
  rng: FreivaldsRng,
  rOverride?: Uint8Array
): boolean {
  const r = rOverride ?? new Uint8Array(n);
  if (!rOverride) {
    for (let i = 0; i < n; i++) r[i] = randBit01(rng);
  }

  const br = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      sum += Math.imul(B[j * n + k], r[k]);
    }
    br[j] = sum;
  }

  for (let i = 0; i < n; i++) {
    let left = 0;
    let right = 0;
    for (let j = 0; j < n; j++) {
      left += Math.imul(A[i * n + j], br[j]);
      right += Math.imul(C[i * n + j], r[j]);
    }
    if (left !== right) return false;
  }
  return true;
}

export function buildMatrices(seed: number, n: number, plantFault: boolean) {
  const rng = mulberry32(seed);
  const A = new Int8Array(n * n);
  const B = new Int8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    A[i] = randInt8(rng);
    B[i] = randInt8(rng);
  }
  const C = matmulInt8(A, B, n);
  if (plantFault) C[0] = iadd(C[0], 1);
  const resultHash = fnv1a32(C);
  return { A, B, C, resultHash };
}

export { LOW_BATTERY_FRACTION, shouldPauseForBattery } from "./batteryGate";
