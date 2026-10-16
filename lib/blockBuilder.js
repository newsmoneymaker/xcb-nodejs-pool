/**
 * Core Blockchain (XCB) Pool
 *
 * Unlike every Bitcoin-stratum coin here, there is no coinbase/merkle/block template to build: the node
 * (gocore) builds the WHOLE block itself and hands the pool only a 32 byte sealhash via cryptore_getWork
 * ([sealHashHex, seedHashHex(vestigial, ignored -- see xcb-project.md), targetHex, blockNumberHex]).
 * This file just parses that into a job and does the real PoW arithmetic (RandomY feeds RandomX with
 * SHA3-512(sealhash(32) || nonce(8, little-endian)) -- see xcb-project.md and hasher.js).
 **/

// The nonce field is 8 bytes (go-core's types.BlockNonce), not the 4 bytes most Bitcoin-stratum coins
// here use -- see poolpayminer's Job::nonceSize() for RX_XCB.
exports.NONCE_SIZE = 8;

/**
 * Parse cryptore_getWork()'s real result shape into a job. Throws on anything unexpected.
 **/
exports.buildJob = function (work) {
	if (!Array.isArray(work) || work.length < 4) throw new Error('unexpected cryptore_getWork shape');
	let sealHash = String(work[0]).replace(/^0x/, '').toLowerCase();
	let targetHex = String(work[2]).replace(/^0x/, '');
	let heightHex = String(work[3]).replace(/^0x/, '');
	if (!/^[0-9a-f]{64}$/.test(sealHash)) throw new Error('bad sealhash ' + work[0]);
	if (!/^[0-9a-f]+$/.test(targetHex) || !targetHex.length) throw new Error('bad target ' + work[2]);

	return {
		sealHash: sealHash,
		target: BigInt('0x' + targetHex),
		height: parseInt(heightHex || '0', 16)
	};
};

/**
 * Build the 40 byte (sealhash || nonce) buffer this coin's RandomY seed-prep hashes -- see
 * xcb_randomy.cpp: seed = SHA3_512(blob40), fed into RandomX. nonce must be exactly 8 bytes, already in
 * the little-endian order go-core's own RandomY() expects (see xcb-project.md's byte-order derivation --
 * this is the SAME bytes the miner's own nonce-splicing machinery wrote natively, no reversal needed
 * anywhere on this path).
 **/
exports.buildBlob40 = function (sealHashHex, nonceLE8) {
	return Buffer.concat([Buffer.from(sealHashHex, 'hex'), nonceLE8]);
};

/**
 * mining.notify params for this pool's own invented wire shape (poolpayminer's EthStratumClient.cpp
 * RX_XCB branch): [job_id, sealHashHex(64 chars), targetHex(64 chars, zero padded), heightHex, clean].
 **/
exports.notifyParams = function (job, id, clean) {
	return [
		id,
		job.sealHash,
		job.target.toString(16).padStart(64, '0'),
		job.height.toString(16),
		!!clean
	];
};
