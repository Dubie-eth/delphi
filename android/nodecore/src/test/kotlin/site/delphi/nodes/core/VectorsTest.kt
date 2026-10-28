package site.delphi.nodes.core

import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** vectors.json was produced by delphi.site's own TypeScript (freivaldsCore.ts, nodeBatchAnchor.ts) and viem. */
class VectorsTest {
    private val v = JSONObject(javaClass.getResource("/vectors.json")!!.readText())

    @Test fun mulberry32() {
        val rng = Mulberry32(12345)
        val want = v.getJSONArray("prng")
        for (i in 0 until want.length()) assertEquals(want.getDouble(i), rng.next(), 0.0)
    }

    @Test fun seedFromAnchor() {
        val seed = Protocol.seedFromAnchor(v.getString("blockHash"), 1, v.getString("wallet"))
        assertEquals(v.getLong("seed"), seed.toLong() and 0xffffffffL)
    }

    @Test fun resultHashes() {
        val seed = v.getLong("seed").toInt()
        val h = v.getJSONObject("hashes")
        for (n in listOf(64, 512, 1024)) assertEquals(h.getString("$n"), Freivalds.build(seed, n).resultHash, "n=$n")
    }

    @Test fun checksSameOutcomes() {
        val seed = v.getLong("seed").toInt()
        for ((key, fault) in listOf("honestChecks" to false, "faultChecks" to true)) {
            val m = Freivalds.build(seed, 64, fault)
            val rng = Freivalds.checkRng(seed)
            val want = v.getJSONArray(key)
            for (i in 0 until want.length()) assertEquals(want.getBoolean(i), Freivalds.check(m, rng), "$key[$i]")
        }
    }

    @Test fun addressAndSignatures() {
        val pk = Eth.unhex(v.getString("pk"))
        assertEquals(v.getString("address"), Eth.address(pk))
        val msgs = v.getJSONObject("msgs"); val sigs = v.getJSONObject("sigs")
        for (k in msgs.keys()) {
            assertEquals(sigs.getString(k), Eth.signPersonal(pk, msgs.getString(k)), "sig $k (byte-identical to viem)")
            assertEquals(v.getString("address"), Eth.recoverPersonal(msgs.getString(k), sigs.getString(k)))
        }
    }

    @Test fun messageFormats() {
        val m = v.getJSONObject("msgs")
        val seed = v.getLong("seed").toInt()
        assertEquals(m.getString("batch"), Protocol.batchMessage(1, Freivalds.build(seed, 512).resultHash, 18517, 600, 1793206372, 137000123, 512))
        assertEquals(m.getString("session"), Protocol.sessionMessage(1, v.getString("address"), 1793800000))
        assertEquals(m.getString("live"), Protocol.liveMessage(1, v.getString("wallet"), true, 1793206372, 29143))
    }

    @Test fun approval() {
        val wallet = Eth.newPrivateKey(); val phone = Eth.newPrivateKey()
        val w = Eth.address(wallet); val key = Eth.address(phone)
        val now = 1_800_000_000L; val exp = now + 7 * 86400
        val a = Approval(5, w, key, exp, Eth.signPersonal(wallet, Protocol.sessionMessage(5, key, exp)))
        assertNull(a.problem(key, now))
        assertTrue(a.problem(Eth.address(Eth.newPrivateKey()), now)!!.contains("different phone"))
        assertTrue(a.problem(key, exp + 1)!!.contains("expired"))
        assertTrue(a.copy(tokenId = 6).problem(key, now)!!.contains("not signed"))
        assertTrue(a.copy(expires = now + 30 * 86400).problem(key, now)!!.contains("7 days"))
    }
}
