package site.delphi.nodes

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object Net {
    const val TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com"

    fun post(url: String, body: JSONObject): Pair<Int, JSONObject> {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.doOutput = true
        c.connectTimeout = 15_000
        c.readTimeout = 20_000
        c.setRequestProperty("Content-Type", "application/json")
        c.setRequestProperty("User-Agent", "DelphiNodes-Android/${BuildConfig.VERSION_NAME}")
        try {
            c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return code to (runCatching { JSONObject(text) }.getOrElse { JSONObject().put("error", text.take(120)) })
        } finally {
            c.disconnect()
        }
    }

    data class Block(val number: Long, val hash: String, val timestamp: Long)

    /** latest block of the side chain: the batch's anchor (its hash seeds the challenge) */
    fun latestBlock(): Block {
        val (code, j) = post(TESTNET_RPC, JSONObject().put("jsonrpc", "2.0").put("id", 1).put("method", "eth_getBlockByNumber").put("params", JSONArray().put("latest").put(false)))
        if (code !in 200..299 || !j.has("result")) throw IllegalStateException("RPC ${j.optJSONObject("error")?.optString("message") ?: code}")
        val r = j.getJSONObject("result")
        return Block(r.getString("number").removePrefix("0x").toLong(16), r.getString("hash"), r.getString("timestamp").removePrefix("0x").toLong(16))
    }
}
