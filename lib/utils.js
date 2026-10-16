/**
 * Tidecoin Pool (based on cryptonote-nodejs-pool, GPL-2.0)
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Utilities functions
 **/

// Load required module
let crypto = require('crypto');

let dateFormat = require('dateformat');
exports.dateFormat = dateFormat;

/**
 * Generate random instance id
 **/
exports.instanceId = function () {
	return crypto.randomBytes(4);
}

/**
 * Tidecoin addresses. New wallets default to ordinary SegWit v0 bech32 ("tbc1q...", confirmed by a real
 * `getnewaddress` on our own node -- the wallet's "default_receive_scheme" (Falcon-512) governs something else,
 * not the address `getnewaddress` hands back with no type argument). There is also a second, post-quantum
 * bech32 prefix ("q1...", chainparams.bech32_pq_hrp) which this pool does not generate or accept -- document on
 * the site that payouts need an ordinary tbc1... address. Legacy base58check P2PKH/P2SH is also still valid
 * consensus-wise (base58Prefixes PUBKEY_ADDRESS=33, SCRIPT_ADDRESS=70/65) and kept here as a fallback.
 **/
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const P2PKH_VERSION = (typeof config !== 'undefined' && config && config.addressVersion !== undefined) ? config.addressVersion : 33;
const P2SH_VERSION = (typeof config !== 'undefined' && config && config.scriptAddressVersion !== undefined) ? config.scriptAddressVersion : 70;
const BECH32_HRP = (typeof config !== 'undefined' && config && config.bech32Hrp !== undefined) ? config.bech32Hrp : 'tbc';

// BIP173/350 bech32(m), used only for the ordinary SegWit hrp above (not the pq hrp).
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod (values) {
	let gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
	let chk = 1;
	for (let v of values) {
		let top = chk >>> 25;
		chk = ((chk & 0x1ffffff) << 5) ^ v;
		for (let i = 0; i < 5; i++) {
			if ((top >>> i) & 1) chk ^= gen[i];
		}
	}
	return chk;
}
function bech32HrpExpand (hrp) {
	let out = [];
	for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
	out.push(0);
	for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
	return out;
}
function convertBits (data, fromBits, toBits, pad) {
	let acc = 0, bits = 0, out = [];
	let maxv = (1 << toBits) - 1;
	for (let value of data) {
		if (value < 0 || (value >>> fromBits) !== 0) return null;
		acc = (acc << fromBits) | value;
		bits += fromBits;
		while (bits >= toBits) {
			bits -= toBits;
			out.push((acc >>> bits) & maxv);
		}
	}
	if (pad) {
		if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
	}
	else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
		return null;
	}
	return out;
}
// Decodes a bech32/bech32m string of the expected hrp. Returns {witnessVersion, program (Buffer)} or null.
function bech32Decode (address, expectedHrp) {
	if (typeof address !== 'string' || address.length < 8 || address.length > 90) return null;
	let lower = address.toLowerCase();
	if (address !== lower && address !== address.toUpperCase()) return null;
	let pos = lower.lastIndexOf('1');
	if (pos < 1 || pos + 7 > lower.length) return null;
	let hrp = lower.slice(0, pos);
	if (hrp !== expectedHrp.toLowerCase()) return null;
	let dataPart = lower.slice(pos + 1);
	let values = [];
	for (let ch of dataPart) {
		let idx = BECH32_CHARSET.indexOf(ch);
		if (idx < 0) return null;
		values.push(idx);
	}
	let checksum = bech32Polymod(bech32HrpExpand(hrp).concat(values));
	let witnessVersion = values[0];
	let isV0 = witnessVersion === 0;
	if (checksum !== (isV0 ? 1 : 0x2bc830a3)) return null;
	let program = convertBits(values.slice(1, values.length - 6), 5, 8, false);
	if (!program || program.length < 2 || program.length > 40) return null;
	if (isV0 && program.length !== 20 && program.length !== 32) return null;
	return {witnessVersion: witnessVersion, program: Buffer.from(program)};
}

function sha256d (buf) {
	return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();
}

function base58Decode (text) {
	let num = 0n;
	for (let ch of text) {
		let idx = B58_ALPHABET.indexOf(ch);
		if (idx < 0) return null;
		num = num * 58n + BigInt(idx);
	}
	let hex = num.toString(16);
	if (hex.length % 2) hex = '0' + hex;
	let bytes = num === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
	let zeros = 0;
	while (zeros < text.length && text[zeros] === '1') zeros++;
	return Buffer.concat([Buffer.alloc(zeros), bytes]);
}

/**
 * Validate an address. Returns {address, version, hash160, type} or null.
 **/
function parseMinerAddress (address) {
	if (typeof address !== 'string') return null;

	// Ordinary SegWit v0 bech32 ("tbc1q..."), what a real getnewaddress on our own node gives by default -- try this first.
	let bech = bech32Decode(address, BECH32_HRP);
	if (bech && bech.witnessVersion === 0) {
		return {address: address, version: null, hash160: bech.program, type: bech.program.length === 20 ? 'p2wpkh' : 'p2wsh'};
	}

	if (address.length < 26 || address.length > 35) return null;
	let raw = base58Decode(address);
	if (!raw || raw.length !== 25) return null;
	let check = sha256d(raw.slice(0, 21)).slice(0, 4);
	if (!check.equals(raw.slice(21))) return null;
	let version = raw[0];
	if (version !== P2PKH_VERSION && version !== P2SH_VERSION) return null;
	return {address: address, version: version, hash160: raw.slice(1, 21), type: version === P2PKH_VERSION ? 'p2pkh' : 'p2sh'};
}
exports.parseMinerAddress = parseMinerAddress;

// scriptPubKey (hex) of a valid address: P2WPKH/P2WSH = OP_0 <push 20/32>, P2PKH = OP_DUP OP_HASH160 <20> OP_EQUALVERIFY
// OP_CHECKSIG, P2SH = OP_HASH160 <20> OP_EQUAL.
exports.addressScript = function (address) {
	let parsed = parseMinerAddress(address);
	if (!parsed) return null;
	if (parsed.type === 'p2wpkh' || parsed.type === 'p2wsh') return '00' + (parsed.hash160.length === 20 ? '14' : '20') + parsed.hash160.toString('hex');
	return parsed.type === 'p2pkh' ? '76a914' + parsed.hash160.toString('hex') + '88ac' : 'a914' + parsed.hash160.toString('hex') + '87';
};

// Validate miner address
exports.validateMinerAddress = function (address) {
	return parseMinerAddress(address) !== null;
}

// Canonical form of a valid address, or null
exports.canonicalMinerAddress = function (address) {
	let parsed = parseMinerAddress(address);
	return parsed ? parsed.address : null;
}

/**
 * Miner account. Kept for the code shared with the other pools of this family (Tidecoin has no deposit notes):
 * account = address, note = null.
 **/
function parseMinerAccount (input) {
	let parsed = parseMinerAddress(input);
	if (!parsed) return null;
	return {publicKey: parsed.address, domain: null, address: parsed.address, note: null, account: parsed.address};
}
exports.parseMinerAccount = parseMinerAccount;

exports.canonicalMinerAccount = function (input) {
	let parsed = parseMinerAccount(input);
	return parsed ? parsed.account : null;
}

// Split a stored account back into {address, note}
exports.splitMinerAccount = function (account) {
	return {address: account, note: null};
}

/**
 * Developer donation table of the config: blockUnlocker.donations = {"<Tidecoin address>": percent of the block reward}.
 * Returns {canonical account: percent} of the valid entries (percent above 0 up to 10); onInvalid(address) is called for the others.
 **/
exports.donationTable = function (unlockerConfig, onInvalid) {
	let table = {};
	let entries = (unlockerConfig && unlockerConfig.donations) || {};
	Object.keys(entries).forEach(function (address) {
		let account = exports.canonicalMinerAccount(address);
		let percent = parseFloat(entries[address]);
		if (!account || !(percent > 0) || percent > 10) {
			if (onInvalid) onInvalid(address);
			return;
		}
		table[account] = percent;
	});
	return table;
};

function characterCount (string, char) {
	let re = new RegExp(char, "gi")
	let matches = string.match(re)
	return matches === null ? 0 : matches.length;
}
exports.characterCount = characterCount;

exports.determineRewardData = (value) => {
	let calculatedData = {
		'address': value,
		'rewardType': 'prop'
	}
	if (/^solo:/i.test(value)) {
		calculatedData['address'] = value.substr(5)
		calculatedData['rewardType'] = 'solo'
		return calculatedData
	}
	if (/^prop:/i.test(value)) {
		calculatedData['address'] = value.substr(5)
		calculatedData['rewardType'] = 'prop'
		return calculatedData
	}
	return calculatedData
}

/**
 * Cleanup special characters (fix for non latin characters)
 **/
function cleanupSpecialChars (str) {
	str = str.replace(/[ÀÁÂÃÄÅ]/g, "A");
	str = str.replace(/[àáâãäå]/g, "a");
	str = str.replace(/[ÈÉÊË]/g, "E");
	str = str.replace(/[èéêë]/g, "e");
	str = str.replace(/[ÌÎÏ]/g, "I");
	str = str.replace(/[ìîï]/g, "i");
	str = str.replace(/[ÒÔÖ]/g, "O");
	str = str.replace(/[òôö]/g, "o");
	str = str.replace(/[ÙÛÜ]/g, "U");
	str = str.replace(/[ùûü]/g, "u");
	return str.replace(/[^A-Za-z0-9\-\_+]/gi, '');
}
exports.cleanupSpecialChars = cleanupSpecialChars;

/**
 * Get readable hashrate
 **/
exports.getReadableHashRate = function (hashrate) {
	let i = 0;
	let byteUnits = [' H', ' KH', ' MH', ' GH', ' TH', ' PH'];
	while (hashrate > 1000) {
		hashrate = hashrate / 1000;
		i++;
	}
	return hashrate.toFixed(2) + byteUnits[i] + '/sec';
}

/**
 * Get readable coins
 **/
exports.getReadableCoins = function (coins, digits, withoutSymbol) {
	let coinDecimalPlaces = config.coinDecimalPlaces || config.coinUnits.toString().length - 1;
	let amount = (parseInt(coins || 0) / config.coinUnits).toFixed(digits || coinDecimalPlaces);
	return amount + (withoutSymbol ? '' : (' ' + config.symbol));
}

/**
 * Generate unique id
 **/
exports.uid = function () {
	let min = 100000000000000;
	let max = 999999999999999;
	let id = Math.floor(Math.random() * (max - min + 1)) + min;
	return id.toString();
};

/**
 * Ring buffer
 **/
exports.ringBuffer = function (maxSize) {
	let data = [];
	let cursor = 0;
	let isFull = false;

	return {
		append: function (x) {
			if (isFull) {
				data[cursor] = x;
				cursor = (cursor + 1) % maxSize;
			} else {
				data.push(x);
				cursor++;
				if (data.length === maxSize) {
					cursor = 0;
					isFull = true;
				}
			}
		},
		avg: function (plusOne) {
			let sum = data.reduce(function (a, b) {
				return a + b
			}, plusOne || 0);
			return sum / ((isFull ? maxSize : cursor) + (plusOne ? 1 : 0));
		},
		size: function () {
			return isFull ? maxSize : cursor;
		},
		clear: function () {
			data = [];
			cursor = 0;
			isFull = false;
		}
	};
};
