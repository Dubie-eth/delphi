package site.delphi.nodes.core

import kotlin.math.floor

/**
 * Port of delphi.site app/node/freivaldsCore.ts + freivalds.worker.ts. Must stay bit-identical: the attestor
 * recomputes resultHash(seed, n) and rejects a batch whose hash differs. JS's Math.imul / `| 0` / `>>> 0`
 * are Kotlin Int arithmetic (wrapping 32-bit), and JS doubles are exact for every sum used here.
 */
class Mulberry32(seed: Int) {
    private var t = seed
    fun next(): Double {
        t += 0x6d2b79f5
        var r = (t xor (t ushr 15)) * (1 or t)
        r = r xor (r + (r xor (r ushr 7)) * (61 or r))
        return ((r xor (r ushr 14)).toLong() and 0xffffffffL).toDouble() / 4294967296.0
    }
}

object Freivalds {
    const val CHECK_SEED_XOR = 0x9e3779b9.toInt()

    fun randInt8(rng: Mulberry32): Int = (floor(rng.next() * 256).toInt() and 0xff) - 128
    fun randBit01(rng: Mulberry32): Int = if (rng.next() < 0.5) 0 else 1

    fun matmul(a: ByteArray, b: ByteArray, n: Int): IntArray {
        val c = IntArray(n * n)
        for (i in 0 until n) {
            val row = i * n
            for (k in 0 until n) {
                val av = a[row + k].toInt()
                val bk = k * n
                for (j in 0 until n) c[row + j] += av * b[bk + j]
            }
        }
        return c
    }

    fun fnv1a32(data: IntArray): String {
        var h = 0x811c9dc5.toInt()
        val p = 0x01000193
        for (v in data) {
            h = (h xor (v and 0xff)) * p
            h = (h xor ((v ushr 8) and 0xff)) * p
            h = (h xor ((v ushr 16) and 0xff)) * p
            h = (h xor ((v ushr 24) and 0xff)) * p
        }
        return (h.toLong() and 0xffffffffL).toString(16).padStart(8, '0')
    }

    class Matrices(val a: ByteArray, val b: ByteArray, val c: IntArray, val n: Int, val resultHash: String)

    fun build(seed: Int, n: Int, plantFault: Boolean = false): Matrices {
        val rng = Mulberry32(seed)
        val a = ByteArray(n * n)
        val b = ByteArray(n * n)
        for (i in 0 until n * n) {
            a[i] = randInt8(rng).toByte()
            b[i] = randInt8(rng).toByte()
        }
        val c = matmul(a, b, n)
        if (plantFault) c[0] += 1
        return Matrices(a, b, c, n, fnv1a32(c))
    }

    /** One Freivalds check of C = A·B with a random r in {0,1}^n (same draw order as the web worker). */
    fun check(m: Matrices, rng: Mulberry32, r: IntArray = IntArray(m.n), br: LongArray = LongArray(m.n)): Boolean {
        val n = m.n
        for (i in 0 until n) r[i] = randBit01(rng)
        for (j in 0 until n) {
            var sum = 0L
            val row = j * n
            for (k in 0 until n) if (r[k] != 0) sum += m.b[row + k]
            br[j] = sum
        }
        for (i in 0 until n) {
            var left = 0L
            var right = 0L
            val row = i * n
            for (j in 0 until n) {
                left += m.a[row + j] * br[j]
                if (r[j] != 0) right += m.c[row + j]
            }
            if (left != right) return false
        }
        return true
    }

    /** checks use their own stream, seeded like the worker: mulberry32(seed ^ 0x9e3779b9) */
    fun checkRng(seed: Int) = Mulberry32(seed xor CHECK_SEED_XOR)
}
