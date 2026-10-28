package site.delphi.nodes.core

import java.math.BigInteger

/** Message formats shared with delphi.site and the attestor. Any change here must change both of those too. */
object Protocol {
    const val CHAIN_ID = 46630
    const val BATCH_MS = 10 * 60 * 1000L
    const val HEARTBEAT_MS = 60 * 1000L
    const val ANCHOR_MAX_AGE_SEC = 15 * 60
    const val SESSION_MAX_SEC = 7 * 86400
    const val LOW_BATTERY_FRACTION = 0.3

    /** seed = first 4 bytes of keccak256(abi.encode(bytes32 blockHash, uint256 tokenId, address wallet)) */
    fun seedFromAnchor(blockHash: String, tokenId: Int, wallet: String): Int {
        val enc = Eth.unhex(blockHash).also { require(it.size == 32) } + Eth.word(BigInteger.valueOf(tokenId.toLong())) + Eth.word(wallet)
        val h = Eth.keccak256(enc)
        return ((h[0].toInt() and 0xff) shl 24) or ((h[1].toInt() and 0xff) shl 16) or ((h[2].toInt() and 0xff) shl 8) or (h[3].toInt() and 0xff)
    }

    fun batchMessage(tokenId: Int, resultHash: String, checks: Long, durationSec: Long, ts: Long, anchorBlock: Long, n: Int) =
        "delphi-node:v2:$CHAIN_ID:$tokenId:$resultHash:$checks:$durationSec:$ts:$anchorBlock:$n"

    fun sessionMessage(tokenId: Int, sessionAddress: String, expires: Long) =
        "delphi-node-session:v1:$CHAIN_ID:$tokenId:${sessionAddress.lowercase()}:$expires"

    fun liveMessage(tokenId: Int, wallet: String, running: Boolean, ts: Long, rate100: Long) =
        "delphi-node-live:v1:$CHAIN_ID:$tokenId:${wallet.lowercase()}:${if (running) 1 else 0}:$ts:$rate100"

    fun shouldPauseForBattery(level: Double, charging: Boolean, override: Boolean) =
        !override && level < LOW_BATTERY_FRACTION && !charging
}

/** The wallet's one-time approval of this phone's session key (made on delphi.site/node/link). */
data class Approval(val tokenId: Int, val wallet: String, val key: String, val expires: Long, val sig: String) {
    /** null if valid for this session key at time `now` (unix seconds), else the reason */
    fun problem(sessionAddress: String, now: Long): String? {
        if (!key.equals(sessionAddress, ignoreCase = true)) return "this approval is for a different phone (session key)"
        if (expires <= now) return "this approval has expired; link again"
        if (expires - now > Protocol.SESSION_MAX_SEC + 300) return "approval lasts longer than 7 days"
        val signer = Eth.recoverPersonal(Protocol.sessionMessage(tokenId, key, expires), sig) ?: return "bad signature"
        if (!signer.equals(wallet, ignoreCase = true)) return "not signed by ${wallet.take(6)}…"
        return null
    }
}
