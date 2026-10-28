package site.delphi.nodes.core

import org.bouncycastle.asn1.x9.X9IntegerConverter
import org.bouncycastle.crypto.digests.KeccakDigest
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.ec.CustomNamedCurves
import org.bouncycastle.crypto.params.ECDomainParameters
import org.bouncycastle.crypto.params.ECPrivateKeyParameters
import org.bouncycastle.crypto.signers.ECDSASigner
import org.bouncycastle.crypto.signers.HMacDSAKCalculator
import org.bouncycastle.math.ec.ECAlgorithms
import org.bouncycastle.math.ec.ECPoint
import java.math.BigInteger
import java.security.SecureRandom

/** Minimal Ethereum crypto: keccak256, secp256k1 keys, EIP-191 personal_sign (RFC 6979, low-s, v = 27/28). */
object Eth {
    private val CURVE_PARAMS = CustomNamedCurves.getByName("secp256k1")
    private val CURVE = ECDomainParameters(CURVE_PARAMS.curve, CURVE_PARAMS.g, CURVE_PARAMS.n, CURVE_PARAMS.h)
    private val HALF_N: BigInteger = CURVE.n.shiftRight(1)

    fun keccak256(data: ByteArray): ByteArray {
        val d = KeccakDigest(256)
        d.update(data, 0, data.size)
        return ByteArray(32).also { d.doFinal(it, 0) }
    }

    fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    fun unhex(s: String): ByteArray {
        val h = s.removePrefix("0x")
        require(h.length % 2 == 0) { "odd hex" }
        return ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    fun newPrivateKey(rnd: SecureRandom = SecureRandom()): ByteArray {
        while (true) {
            val k = ByteArray(32).also { rnd.nextBytes(it) }
            val v = BigInteger(1, k)
            if (v.signum() > 0 && v < CURVE.n) return k
        }
    }

    private fun publicPoint(priv: ByteArray): ECPoint = CURVE.g.multiply(BigInteger(1, priv)).normalize()

    private fun addressOfPoint(p: ECPoint): String {
        val enc = p.getEncoded(false) // 0x04 || X || Y
        return checksum(hex(keccak256(enc.copyOfRange(1, 65)).copyOfRange(12, 32)))
    }

    fun address(priv: ByteArray): String = addressOfPoint(publicPoint(priv))

    /** EIP-55 mixed-case address */
    fun checksum(addrHexNoPrefix: String): String {
        val a = addrHexNoPrefix.lowercase().removePrefix("0x")
        val h = hex(keccak256(a.toByteArray(Charsets.US_ASCII)))
        return "0x" + a.mapIndexed { i, c -> if (c.isLetter() && h[i].digitToInt(16) >= 8) c.uppercaseChar() else c }.joinToString("")
    }

    fun personalHash(message: String): ByteArray {
        val m = message.toByteArray(Charsets.UTF_8)
        return keccak256("\u0019Ethereum Signed Message:\n${m.size}".toByteArray(Charsets.UTF_8) + m)
    }

    /** 65-byte signature hex (r || s || v), exactly what viem/ethers signMessage produce for the same key. */
    fun signPersonal(priv: ByteArray, message: String): String {
        val hash = personalHash(message)
        val signer = ECDSASigner(HMacDSAKCalculator(SHA256Digest()))
        signer.init(true, ECPrivateKeyParameters(BigInteger(1, priv), CURVE))
        val (r, s0) = signer.generateSignature(hash).let { it[0] to it[1] }
        val s = if (s0 > HALF_N) CURVE.n.subtract(s0) else s0
        val pub = publicPoint(priv)
        val recId = (0..1).first { recover(it, r, s, hash)?.let { p -> p == pub } == true }
        return "0x" + hex(pad32(r)) + hex(pad32(s)) + "%02x".format(27 + recId)
    }

    /** address that signed `message` (EIP-191), or null */
    fun recoverPersonal(message: String, sigHex: String): String? {
        val sig = unhex(sigHex)
        if (sig.size != 65) return null
        val r = BigInteger(1, sig.copyOfRange(0, 32))
        val s = BigInteger(1, sig.copyOfRange(32, 64))
        val v = sig[64].toInt() and 0xff
        val recId = when (v) { 27, 28 -> v - 27; 0, 1 -> v; else -> return null }
        return recover(recId, r, s, personalHash(message))?.let { addressOfPoint(it) }
    }

    /** SEC 1 v2 section 4.1.6 public key recovery */
    private fun recover(recId: Int, r: BigInteger, s: BigInteger, hash: ByteArray): ECPoint? {
        val n = CURVE.n
        if (r.signum() <= 0 || r >= n || s.signum() <= 0 || s >= n) return null
        val prime = CURVE_PARAMS.curve.field.characteristic
        val x = r // i = recId / 2 = 0 for secp256k1 in practice
        if (x >= prime) return null
        val enc = X9IntegerConverter().integerToBytes(x, 1 + X9IntegerConverter().getByteLength(CURVE.curve))
        enc[0] = if (recId and 1 == 1) 0x03 else 0x02
        val bigR = CURVE.curve.decodePoint(enc)
        if (!bigR.multiply(n).isInfinity) return null
        val e = BigInteger(1, hash)
        val rInv = r.modInverse(n)
        val srInv = rInv.multiply(s).mod(n)
        val eInvrInv = rInv.multiply(n.subtract(e).mod(n)).mod(n)
        return ECAlgorithms.sumOfTwoMultiplies(CURVE.g, eInvrInv, bigR, srInv).normalize()
    }

    private fun pad32(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    fun word(v: BigInteger) = pad32(v)
    fun word(addr: String): ByteArray = ByteArray(12) + unhex(addr).also { require(it.size == 20) }
}
