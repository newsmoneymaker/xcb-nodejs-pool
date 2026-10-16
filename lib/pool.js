/**
 * Core Blockchain (XCB) Pool
 *
 * Stratum server for this coin's own invented wire shape (poolpayminer's EthStratumClient.cpp RX_XCB
 * branch is the only client that needs to understand it -- no third party compatibility to preserve).
 * Structurally much simpler than every Bitcoin-stratum coin here: the node (gocore) builds the WHOLE
 * block itself (no coinbase/merkle tree at all) and only ever hands the pool a 32 byte sealhash via
 * cryptore_getWork() -- see consensus/cryptore/api.go/sealer.go and xcb-project.md.
 *
 *   node cryptore_getWork() --> job (blockBuilder.js buildJob()) --notify--> miners --submit-->
 *   share check (hasher: the real go-randomy/librandomx library, symbol-renamed, see hasher.js) -->
 *   redis (shares.js). A share that meets the real network target is relayed to the node with
 *   cryptore_submitWork(nonce, sealhash) -- the node itself re-verifies and, if still valid and not
 *   stale, assembles and extends the chain with the real block.
 *
 * mining.notify (5 params, see blockBuilder.js notifyParams()): [job_id, sealHashHex, targetHex,
 * heightHex, clean_jobs]. mining.set_target (not mining.set_difficulty): a raw 256 bit target, hex, no
 * byte reversal (consistent with VRSC's own convention here). mining.submit (3 params): [worker,
 * job_id, nonceHex] -- nonceHex is "0x" + 16 hex digits, big-endian digit order (poolpayminer's default
 * ethash-style submit() formatting, see EthStratumClient.cpp) representing the SAME integer value the
 * miner's own nonce-splicing machinery wrote as 8 LITTLE-ENDIAN bytes into the hash seed -- so this
 * exact hex string can be forwarded to cryptore_submitWork()'s nonce param completely unchanged (see
 * xcb-project.md's byte-order derivation), while the LOCAL share-check here must byte-reverse it back to
 * those same 8 LE bytes before concatenating with the sealhash (see onSubmit() below).
 *
 * extranonce1 (2 bytes, see EN1_SIZE) is written into the START of the 8 byte nonce field by the
 * client (EthStratumClient.cpp's RX_XCB notify branch) so different miners don't redundantly search the
 * same nonce range -- the remaining EN2_SIZE=6 bytes are this miner's own search space.
 **/
let net = require('net');
let tls = require('tls');
let fs = require('fs');
let crypto = require('crypto');

let utils = require('./utils.js');
let shares = require('./shares.js');
let rpc = require('./xcbRpc.js');
let hasher = require('./hasher.js');
let builder = require('./blockBuilder.js');
let reward = require('./reward.js');

let logSystem = 'pool';
require('./exceptionWriter.js')(logSystem);

let poolConfig = config.poolServer;
let varDiffConfig = Object.assign({startDiff: 100, minDiff: 10, maxDiff: 50000000, targetTime: 20, retargetTime: 60, variancePercent: 30, maxJump: 100}, poolConfig.varDiff || {});
let JOB_REFRESH = poolConfig.jobRefresh || 1000;
let ALGO_NAME = 'rx/xcb';

let banningEnabled = poolConfig.banning && poolConfig.banning.enabled;
let bannedIPs = {};
let perIPStats = {};

const MAX_CLIENT_LINE = 16 * 1024;
const MAX_WORKERNAME = 32;
const EN1_SIZE = 2;
const EN2_SIZE = builder.NONCE_SIZE - EN1_SIZE;
const TWO_64_1 = 18446744073709551615n;
const TWO_256 = 1n << 256n;

/**
 * Split a byte stream into lines
 **/
function lineSplitter (maxLength, onLine, onOverflow) {
	let buffer = '';
	return function (data) {
		buffer += data;
		let idx;
		while ((idx = buffer.indexOf('\n')) !== -1) {
			let line = buffer.slice(0, idx).replace(/\r$/, '');
			buffer = buffer.slice(idx + 1);
			if (line.length) onLine(line);
		}
		if (buffer.length > maxLength) {
			buffer = '';
			onOverflow();
		}
	};
}

/**
 * Parse the stratum login: [prop:]<address>[.workername | +workername]
 * XCB addresses: 44 char ICAN-style hex strings, mainnet version byte 0xcb (common/types.go
 * AddressLength=22 raw bytes) -- see xcb-project.md. This does NOT verify the real ICAN/EIP-1191-style
 * checksum (not derived from source this pass); the node itself is the final authority and will reject
 * a real payout to a malformed address, same safety net as every other coin here.
 **/
function parseLogin (login, pass) {
	if (typeof login !== 'string' || !login.length || login.length > 200) return {error: 'Invalid login'};

	let rewardData = utils.determineRewardData(login);
	let rest = rewardData.address;
	let workerName = null;

	let plus = rest.indexOf('+');
	if (plus === -1) plus = rest.indexOf('.');
	if (plus !== -1) {
		workerName = utils.cleanupSpecialChars(rest.substr(plus + 1)).substr(0, MAX_WORKERNAME) || null;
		rest = rest.substr(0, plus);
	}
	if (!workerName && typeof pass === 'string' && pass !== 'x' && pass.length) {
		workerName = utils.cleanupSpecialChars(pass).substr(0, MAX_WORKERNAME) || null;
	}

	let address = rest.toLowerCase();
	if (!/^cb[0-9a-f]{42}$/.test(address)) {
		return {error: 'Invalid Core Blockchain (XCB) address (expected a 44 char hex string starting with cb)'};
	}

	return {address: address, workerName: workerName, rewardType: rewardData.rewardType};
}

/**
 * Banning
 **/
let allowIPs = (poolConfig.allowIPs || []).map(String);

function isAllowedIp (ip) {
	if (!allowIPs.length) return true;
	let plain = ip.replace(/^::ffff:/, '');
	return allowIPs.indexOf(plain) !== -1 || allowIPs.indexOf(ip) !== -1;
}

function IsBannedIp (ip) {
	if (!banningEnabled || !bannedIPs[ip]) return false;
	let timeLeft = poolConfig.banning.time * 1000 - (Date.now() - bannedIPs[ip]);
	if (timeLeft > 0) return true;
	delete bannedIPs[ip];
	log('info', logSystem, 'Ban dropped for %s', [ip]);
	return false;
}

function checkBan (miner, validShare) {
	if (!banningEnabled) return;

	let stats = perIPStats[miner.ip];
	if (!stats) stats = perIPStats[miner.ip] = {validShares: 0, invalidShares: 0};
	if (validShare) stats.validShares++; else stats.invalidShares++;

	let total = stats.validShares + stats.invalidShares;
	if (total >= poolConfig.banning.checkThreshold) {
		let percent = stats.invalidShares / total * 100;
		if (percent >= poolConfig.banning.invalidPercent) {
			log('warn', logSystem, 'Banned %s@%s: %d%% invalid shares', [miner.address, miner.ip, Math.round(percent)]);
			bannedIPs[miner.ip] = Date.now();
			miner.destroy();
		}
		delete perIPStats[miner.ip];
	}
}

setInterval(function () {
	let now = Date.now();
	for (let ip in bannedIPs) {
		if (now - bannedIPs[ip] > poolConfig.banning.time * 1000) delete bannedIPs[ip];
	}
	perIPStats = {};
}, 60 * 1000);

/**
 * Limits against connection floods
 **/
let MAX_PER_IP = poolConfig.maxConnectionsPerIp || 100;
let MAX_UNAUTH_PER_IP = poolConfig.maxUnauthenticatedPerIp || 10;
let LOGIN_TIMEOUT = (poolConfig.loginTimeout || 20) * 1000;
let MAX_TOTAL = poolConfig.maxConnections || 3000;
let connectionsByIp = {};
let totalConnections = 0;
let limitLogged = {};

function limitReason (ip) {
	let c = connectionsByIp[ip];
	if (totalConnections >= MAX_TOTAL) return 'the pool is full (' + MAX_TOTAL + ' connections)';
	if (c && c.total >= MAX_PER_IP) return 'more than ' + MAX_PER_IP + ' connections from one address';
	if (c && c.unauth >= MAX_UNAUTH_PER_IP) return 'more than ' + MAX_UNAUTH_PER_IP + ' connections from one address that did not log in';
	return null;
}

/**
 * Difficulty memory
 **/
const DIFF_MEMORY_TTL = (poolConfig.diffMemoryMinutes || 15) * 60 * 1000;
let diffMemory = new Map();

setInterval(function () {
	let now = Date.now();
	diffMemory.forEach(function (mem, key) {
		if (now - mem.seen > DIFF_MEMORY_TTL) diffMemory.delete(key);
	});
}, 60 * 1000);

/**
 * Job manager: polls the node for new work (cryptore_getWork), keeps recent jobs.
 **/
let jobs = new Map();          // job id -> job
let currentJob = null;
let jobCounter = 0;
let miners = new Set();
let refreshing = false;
let lastWorkError = null;
let lastWorkErrorTime = 0;
let extraNonceCounter = crypto.randomBytes(2).readUInt16BE(0);

function refreshWork () {
	if (refreshing) return;
	refreshing = true;
	rpc.getWork(function (err, work) {
		refreshing = false;
		if (err) {
			let text = err.message || JSON.stringify(err);
			if (text !== lastWorkError || Date.now() - lastWorkErrorTime > 30000) {
				lastWorkError = text;
				lastWorkErrorTime = Date.now();
				log('error', logSystem, 'cryptore_getWork failed: %s', [text]);
			}
			return;
		}
		let job;
		try {
			job = builder.buildJob(work);
		} catch (e) {
			log('error', logSystem, 'Bad cryptore_getWork result: %s', [e.message]);
			return;
		}

		let newBlock = !currentJob || currentJob.sealHash !== job.sealHash;
		if (!newBlock) return; // same work, nothing to broadcast

		job.id = String(++jobCounter);
		job.blockHashes = Number(TWO_256 / (job.target + 1n));
		job.created = Date.now();
		jobs.set(job.id, job);
		currentJob = job;
		jobs.forEach(function (j, id) {
			if (job.created - j.created > 10 * 60 * 1000 || Number(id) < jobCounter - 40) jobs.delete(id);
		});

		log('info', logSystem, 'New work: height %d, network difficulty %s hashes, sealhash %s', [job.height, Math.round(job.blockHashes), job.sealHash]);
		publishNetwork(job);
		miners.forEach(function (miner) { miner.sendJob(true); });
	});
}

let lastPublished = {height: null, time: 0};

function publishNetwork (job) {
	let now = Date.now();
	if (lastPublished.height === job.height && now - lastPublished.time < 30000) return;
	lastPublished = {height: job.height, time: now};
	redisClient.hmset(config.coin + ':network', {
		height: job.height,
		algorithm: ALGO_NAME,
		difficulties: JSON.stringify({[ALGO_NAME]: job.blockHashes}),
		updated: now
	}, function (err) {
		if (err) log('error', logSystem, 'Failed to publish network data: %j', [err]);
	});
}

function shareLimit (diff) {
	return TWO_64_1 / BigInt(Math.max(1, Math.round(diff)));
}

function minerTarget (diff) {
	return (TWO_256 - 1n) / BigInt(Math.max(1, Math.round(diff)));
}

/**
 * One miner connection
 **/
function handleConnection (socket, portData) {
	let ip = socket.remoteAddress;
	if (!ip) return socket.destroy();

	if (!isAllowedIp(ip)) {
		log('info', logSystem, 'Rejected connection from %s: not in poolServer.allowIPs', [ip]);
		return socket.destroy();
	}

	if (IsBannedIp(ip)) {
		log('info', logSystem, 'Rejected connection from banned IP %s', [ip]);
		return socket.destroy();
	}

	let limited = limitReason(ip);
	if (limited) {
		if (!limitLogged[ip] || Date.now() - limitLogged[ip] > 60000) {
			limitLogged[ip] = Date.now();
			log('warn', logSystem, 'Rejected connection from %s: %s', [ip, limited]);
		}
		return socket.destroy();
	}
	let counter = connectionsByIp[ip] || (connectionsByIp[ip] = {total: 0, unauth: 0});
	counter.total++;
	counter.unauth++;
	totalConnections++;
	let authenticated = false;

	socket.setEncoding('utf8');
	socket.setNoDelay(true);
	// See critical-missing-tcp-keepalive.md -- a client that vanishes without a clean TCP close leaves a
	// zombie ESTABLISHED connection forever without this.
	socket.setKeepAlive(true, 30000);

	let closed = false;
	let connectedAt = Date.now();
	let diff = Math.min(Math.max(portData.diff || varDiffConfig.startDiff, varDiffConfig.minDiff), varDiffConfig.maxDiff);
	let extraNonce1 = Buffer.alloc(EN1_SIZE);
	extraNonce1.writeUInt16BE(extraNonceCounter = (extraNonceCounter + 1) & 0xffff, 0);
	let miner = {
		id: crypto.randomBytes(8).toString('hex'),
		ip: ip,
		address: null,
		workerName: null,
		rewardType: 'prop',
		diff: diff,
		fixedDiff: !!portData.fixedDiff,
		extraNonce1: extraNonce1,
		subscribed: false,
		sent: new Map(),
		shareTimes: [],
		lastRetarget: Date.now(),
		sendJob: function (clean) { sendJob(!!clean); },
		destroy: function () {
			if (closed) return;
			closed = true;
			clearTimeout(loginTimer);
			miners.delete(miner);
			counter.total--;
			if (!authenticated) counter.unauth--;
			totalConnections--;
			if (counter.total <= 0) delete connectionsByIp[ip];
			log('info', logSystem, 'Closing connection of %s@%s after %ds', [miner.address, ip, Math.round((Date.now() - connectedAt) / 1000)]);
			socket.destroy();
		}
	};

	let loginTimer = setTimeout(function () {
		if (authenticated) return;
		log('info', logSystem, 'No login from %s within %ds, closing', [ip, LOGIN_TIMEOUT / 1000]);
		miner.destroy();
	}, LOGIN_TIMEOUT);

	log('info', logSystem, 'Miner connected from %s on port %d', [ip, portData.port]);

	if (poolConfig.minerTimeout) {
		socket.setTimeout(poolConfig.minerTimeout * 1000, function () {
			log('info', logSystem, 'Miner %s@%s timed out', [miner.address, ip]);
			miner.destroy();
		});
	}

	function send (obj) {
		if (!closed && socket.writable) socket.write(JSON.stringify(obj) + '\n');
	}

	function reply (id, result, error) {
		send({id: id, result: result, error: error ? [error.code || 20, error.message, null] : null});
	}

	function sendJob (clean) {
		if (!authenticated || !currentJob) return;
		let job = currentJob;
		miner.sent.set(job.id, {job: job, diff: miner.diff, nonces: new Set(), pending: new Set()});
		while (miner.sent.size > 40) miner.sent.delete(miner.sent.keys().next().value);
		send({id: null, method: 'mining.set_target', params: [minerTarget(miner.diff).toString(16).padStart(64, '0')]});
		send({id: null, method: 'mining.notify', params: builder.notifyParams(job, job.id, clean)});
	}

	function onLine (line) {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch (e) {
			log('warn', logSystem, 'Malformed JSON from %s@%s', [miner.address, ip]);
			return miner.destroy();
		}
		if (!msg || typeof msg !== 'object') return miner.destroy();

		switch (msg.method) {
			case 'mining.subscribe':
				return onSubscribe(msg);
			case 'mining.authorize':
				return onAuthorize(msg);
			case 'mining.submit':
				return onSubmit(msg);
			case 'mining.extranonce.subscribe':
				return reply(msg.id, true);
			case 'mining.suggest_difficulty':
			case 'mining.configure':
				return reply(msg.id, msg.method === 'mining.configure' ? {} : true);
			default:
				return reply(msg.id, null, {code: 20, message: 'Unknown method'});
		}
	}

	function onSubscribe (msg) {
		miner.subscribed = true;
		let subParams = msg.params || [];
		if (typeof subParams[0] === 'string') miner.agent = subParams[0].substr(0, 60);
		reply(msg.id, [[['mining.set_target', 'sd' + miner.id], ['mining.notify', 'mn' + miner.id]], miner.extraNonce1.toString('hex'), EN2_SIZE]);
	}

	function onAuthorize (msg) {
		let params = msg.params || [];
		let parsed = parseLogin(params[0], params[1]);
		if (parsed.error) {
			log('warn', logSystem, 'Rejected login from %s: %s', [ip, parsed.error]);
			reply(msg.id, null, {code: 24, message: parsed.error});
			return setTimeout(miner.destroy, 100);
		}
		if (!currentJob) {
			reply(msg.id, null, {code: 20, message: 'The pool is starting (no work from the node yet), try again in a minute'});
			return setTimeout(miner.destroy, 100);
		}
		adoptRememberedDifficulty(parsed);

		if (!authenticated) {
			authenticated = true;
			counter.unauth--;
			clearTimeout(loginTimer);
		}
		miner.address = parsed.address;
		miner.workerName = parsed.workerName;
		miner.rewardType = parsed.rewardType;
		miners.add(miner);

		reply(msg.id, true);
		log('info', logSystem, 'Miner logged in: %s worker=%s type=%s ip=%s agent=%s', [parsed.address, parsed.workerName, parsed.rewardType, ip, miner.agent || '']);
		sendJob(true);
	}

	function adoptRememberedDifficulty (parsed) {
		if (miner.fixedDiff) return;
		let key = parsed.address + '~' + (parsed.workerName || '');
		let mem = diffMemory.get(key);
		if (mem && Date.now() - mem.seen <= DIFF_MEMORY_TTL) {
			miner.diff = Math.min(Math.max(mem.diff, varDiffConfig.minDiff), varDiffConfig.maxDiff);
			miner.shareTimes = mem.shareTimes;
			miner.lastRetarget = mem.lastRetarget;
		} else {
			mem = {diff: miner.diff, shareTimes: miner.shareTimes, lastRetarget: miner.lastRetarget, seen: Date.now()};
			diffMemory.set(key, mem);
		}
		miner.memory = mem;
	}

	function remember () {
		if (!miner.memory) return;
		miner.memory.diff = miner.diff;
		miner.memory.lastRetarget = miner.lastRetarget;
		miner.memory.seen = Date.now();
	}

	function reject (msg, message, code, count) {
		if (count !== false) checkBan(miner, false);
		log('info', logSystem, 'Rejected share from %s@%s: %s', [miner.address, ip, message]);
		reply(msg.id, null, {code: code || 23, message: message});
	}

	function onSubmit (msg) {
		if (!miner.address) return reply(msg.id, null, {code: 24, message: 'Unauthorized worker'});

		// [worker, job_id, nonceHex] -- params[0] (worker) is not used for lookup.
		let params = msg.params || [];
		let jobId = String(params[1]);
		let sent = miner.sent.get(jobId);
		if (!sent) return reject(msg, 'Job not found', 21, false);
		let job = sent.job;

		let nonceHex = String(params[2] || '').toLowerCase().replace(/^0x/, '');
		if (!/^[0-9a-f]{1,16}$/.test(nonceHex)) return reject(msg, 'Invalid nonce');

		let key = nonceHex;
		if (sent.nonces.has(key) || sent.pending.has(key)) return reject(msg, 'Duplicate share', 22);
		sent.pending.add(key);

		// nonceHex is big-endian digit text of the integer the miner searched (poolpayminer's default
		// ethash-style submit() formatting) -- re-derive the SAME 8 little-endian bytes the miner's own
		// nonce-splicing machinery wrote into the hash seed (see the module comment above and
		// xcb-project.md) before concatenating with the sealhash.
		let nonceValue = BigInt('0x' + nonceHex);
		let nonceLE = Buffer.alloc(8);
		nonceLE.writeBigUInt64LE(nonceValue, 0);
		let blob40 = builder.buildBlob40(job.sealHash, nonceLE);

		hasher.hash(blob40.toString('hex'), function (err, hashHex) {
			sent.pending.delete(key);
			if (err) {
				log('error', logSystem, 'Cannot check a share from %s: %s', [miner.address, err.message]);
				return reply(msg.id, null, {code: 20, message: 'Try again'});
			}
			let hash = Buffer.from(hashHex, 'hex');
			// Real consensus reads the full 256 bit hash big-endian (no reversal, see
			// consensus/cryptore/consensus.go's verifySeal(): new(big.Int).SetBytes(result)). The
			// client-side local filter approximates this with just the top 8 bytes (see
			// poolpayminer's Job::bigEndianValue()/epicValue()); the pool always does the full check.
			let top = hash.readBigUInt64BE(0);
			let credited = top <= shareLimit(sent.diff) ? sent.diff : null;
			if (credited === null) return reject(msg, 'Low difficulty share');

			let isBlock = BigInt('0x' + hashHex) <= job.target;
			sent.nonces.add(key);
			checkBan(miner, true);
			reply(msg.id, true);
			acceptShare(job, credited, nonceHex, hash, isBlock);
		});
	}

	function acceptShare (job, creditedDiff, nonceHex, hash, isBlock) {
		let weight = shares.shareWeight(creditedDiff, job.blockHashes);

		let record = function (blockHash) {
			shares.record({
				login: miner.address,
				workerName: miner.workerName,
				ip: ip,
				rewardType: miner.rewardType,
				algo: ALGO_NAME,
				height: job.height,
				rawDifficulty: creditedDiff,
				weight: weight,
				blockCandidate: !!blockHash,
				hash: blockHash || null
			});
		};

		if (!isBlock) {
			record(null);
			retarget();
			return;
		}

		log('info', logSystem, 'Block solution at height %d from %s (worker %s), submitting', [job.height, miner.address, miner.workerName || '-']);
		rpc.submitWork('0x' + nonceHex, '0x' + job.sealHash, function (err, accepted) {
			if (err) {
				log('error', logSystem, 'cryptore_submitWork failed at height %d: %s', [job.height, err.message || JSON.stringify(err)]);
				record(null);
				return;
			}
			if (!accepted) {
				log('warn', logSystem, 'cryptore_submitWork rejected the solution at height %d (stale or already found by someone else)', [job.height]);
				record(null);
				return;
			}
			log('info', logSystem, 'BLOCK FOUND at height %d by %s (worker %s), sealhash %s', [job.height, miner.address, miner.workerName || '-', job.sealHash]);
			record(job.sealHash);
			lastWorkError = null;
			setTimeout(refreshWork, 500);
		});
	}

	function retarget () {
		if (miner.fixedDiff) return;
		let now = Date.now();
		miner.shareTimes.push(now);
		if (miner.shareTimes.length > 30) miner.shareTimes.shift();
		remember();
		if (now - miner.lastRetarget < varDiffConfig.retargetTime * 1000 || miner.shareTimes.length < 4) return;
		miner.lastRetarget = now;

		let span = (miner.shareTimes[miner.shareTimes.length - 1] - miner.shareTimes[0]) / 1000 / (miner.shareTimes.length - 1);
		if (!(span > 0)) span = 0.1;
		let ratio = varDiffConfig.targetTime / span;
		if (Math.abs(1 - ratio) * 100 < varDiffConfig.variancePercent) return;
		let newDiff = miner.diff * ratio;
		let jump = varDiffConfig.maxJump / 100;
		newDiff = Math.min(Math.max(newDiff, miner.diff * (1 - jump / (1 + jump))), miner.diff * (1 + jump));
		let cap = currentJob ? Math.min(varDiffConfig.maxDiff, currentJob.blockHashes / 4) : varDiffConfig.maxDiff;
		newDiff = Math.round(Math.min(Math.max(newDiff, varDiffConfig.minDiff), Math.max(cap, varDiffConfig.minDiff)));
		if (newDiff === miner.diff) return;
		log('info', logSystem, 'Difficulty of %s@%s: %d -> %d (a share every %ss)', [miner.address, ip, miner.diff, newDiff, span.toFixed(1)]);
		miner.diff = newDiff;
		miner.shareTimes.length = 0;
		remember();
		sendJob(false);
	}

	socket.on('data', lineSplitter(MAX_CLIENT_LINE, onLine, function () {
		log('warn', logSystem, 'Oversized line from %s@%s', [miner.address, ip]);
		miner.destroy();
	}));

	socket.on('error', function (err) {
		if (err.code !== 'ECONNRESET') log('warn', logSystem, 'Socket error from %s@%s: %s', [miner.address, ip, err]);
	});

	socket.on('close', function () {
		if (!closed) log('info', logSystem, 'Miner disconnected %s@%s', [miner.address, ip]);
		miner.destroy();
	});
}

/**
 * Start
 **/
shares.init();
refreshWork();
setInterval(refreshWork, JOB_REFRESH);

poolConfig.ports.forEach(function (portData) {
	let onConnection = function (socket) {
		handleConnection(socket, portData);
	};

	let server;
	if (portData.tls) {
		let options;
		try {
			options = {
				cert: fs.readFileSync(poolConfig.sslCert),
				key: fs.readFileSync(poolConfig.sslKey),
				minVersion: 'TLSv1.2'
			};
		} catch (e) {
			log('error', logSystem, 'Cannot read the TLS certificate/key for port %d: %s', [portData.port, e.message]);
			return;
		}
		server = tls.createServer(options, onConnection);
		server.on('tlsClientError', function (err, socket) {
			log('info', logSystem, 'TLS handshake failed from %s: %s', [socket && socket.remoteAddress, err.message]);
		});
	} else {
		server = net.createServer(onConnection);
	}

	server.listen(portData.port, poolConfig.bindIp || '0.0.0.0', function (error) {
		if (error) {
			log('error', logSystem, 'Could not start server listening on port %d: %j', [portData.port, error]);
			return;
		}
		log('info', logSystem, 'Started %sserver listening on port %d (%s)', [portData.tls ? 'TLS ' : '', portData.port, portData.desc || '']);
	});
});
