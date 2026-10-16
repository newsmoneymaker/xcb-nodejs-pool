/**
 * Core Blockchain (XCB) Pool -- module=api
 *
 * Public JSON API for the website, matching the same dvandal-template contract js/common.js expects
 * on every other pool-pay.com coin (veil, qwc, c64, keva, sal, tdc, hac, ...): /stats, /live_stats
 * (long poll), /stats_address, /get_payments, /get_blocks, /get_top10miners, /block_explorers,
 * /get_apis, /miners_hashrate, /workers_hashrate. Without /get_apis specifically, the site's own init
 * flow never even calls loadLiveStats() -- the whole dashboard would sit empty, not just missing a
 * widget (checked by reading index.html's own init script before writing this).
 *
 * Stats are recomputed on a timer (config.api.updateInterval, default 5s) into `currentStats`, same
 * pattern as cryptonote-nodejs-pool's collectStats(): one Redis round trip per cycle, not per request.
 * Network info is read from the `xcb:network` Redis hash pool.js itself already writes on every new
 * job (height/algorithm/difficulties) -- no separate RPC poll needed here, unlike a coin whose api.js
 * has to ask the node directly.
 **/
let http = require('http');
let url = require('url');

let rpc = require('./xcbRpc.js');
let reward = require('./reward.js');

let logSystem = 'api';
require('./exceptionWriter.js')(logSystem);

const COIN = config.coin;
const apiCfg = config.api || {};
const hashrateWindow = apiCfg.hashrateWindow || 600;
const updateInterval = apiCfg.updateInterval || 5;
const blocksLimit = apiCfg.blocks || 30;
const paymentsLimit = apiCfg.payments || 30;
// Real, measured average over 16 real mainnet blocks (height 0x127903d..0x127904d), not a guess --
// see xcb-project.md. Used only for the cosmetic "Network Hash Rate" display (difficulty /
// coinDifficultyTarget); every pool-side number is computed independently of this.
const coinDifficultyTarget = apiCfg.coinDifficultyTarget || 11;

let currentStats = {};
let minerStats = {}; // login[~worker] -> { hashrate }
let liveConnections = {}; // key -> http.ServerResponse, answered on the next collectStats() cycle
let addressConnections = {}; // key -> http.ServerResponse, same but for /stats_address long-polls

function sendJson(res, obj, status) {
	let body = JSON.stringify(obj);
	res.writeHead(status || 200, {
		'Access-Control-Allow-Origin': '*',
		'Cache-Control': 'no-cache',
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(body, 'utf8')
	});
	res.end(body);
}

function totalFeePercent() {
	let fee = (config.blockUnlocker && config.blockUnlocker.poolFee) || 0;
	let donations = (config.blockUnlocker && config.blockUnlocker.donations) || {};
	Object.keys(donations).forEach(function (a) { fee += Number(donations[a]) || 0; });
	return fee;
}

function collectStats() {
	let startTime = Date.now();
	let windowStart = '(' + (((Date.now() / 1000) - hashrateWindow) | 0);

	let redisCommands = [
		['zremrangebyscore', COIN + ':hashrate', '-inf', windowStart],
		['zrange', COIN + ':hashrate', 0, -1],
		['zrevrange', COIN + ':blocks:candidates', 0, -1, 'WITHSCORES'],
		['zrevrange', COIN + ':blocks:matured', 0, blocksLimit - 1, 'WITHSCORES'],
		['zrevrangebyscore', COIN + ':payments:all', '+inf', '-inf', 'WITHSCORES', 'LIMIT', 0, paymentsLimit],
		['zcard', COIN + ':payments:all'],
		['hgetall', COIN + ':network']
	];

	redisClient.multi(redisCommands).exec(function (err, replies) {
		if (err) {
			log('error', logSystem, 'Redis error collecting stats: %s', [err.message]);
			setTimeout(collectStats, updateInterval * 1000);
			return;
		}

		let hashrateMembers = replies[1] || [];
		let candidatesFlat = replies[2] || [];
		let maturedFlat = replies[3] || [];
		let paymentsFlat = replies[4] || [];
		let totalPayments = parseInt(replies[5], 10) || 0;
		let networkRaw = replies[6] || {};

		minerStats = {};
		let minerTotals = {};
		let poolTotalShares = 0;
		hashrateMembers.forEach(function (m) {
			let parts = m.split(':');
			let weight = parseInt(parts[0], 10) || 0;
			let login = parts[1];
			if (!login) return;
			minerTotals[login] = (minerTotals[login] || 0) + weight;
			poolTotalShares += weight;
		});
		let miners = 0, workers = 0;
		for (let login in minerTotals) {
			minerStats[login] = {hashrate: Math.round(minerTotals[login] / hashrateWindow)};
			if (login.indexOf('~') !== -1) workers++; else miners++;
		}
		let poolHashrate = Math.round(poolTotalShares / hashrateWindow);

		let blocksFlat = candidatesFlat.concat(maturedFlat);

		let totalBlocks = 0, totalDiff = 0, totalShares = 0, lastBlockFound = null, lastReward = null, lastHeight = null, lastHash = null;
		for (let i = 0; i < maturedFlat.length; i += 2) {
			let parts = maturedFlat[i].split(':');
			totalBlocks++;
			totalDiff += parseInt(parts[4], 10) || 0;
			totalShares += parseInt(parts[5], 10) || 0;
			let t = parseInt(parts[3], 10) * 1000;
			if (!lastBlockFound || t > lastBlockFound) {
				lastBlockFound = t;
				lastReward = parts[7] || null;
				lastHeight = parseInt(maturedFlat[i + 1], 10);
				lastHash = parts[2];
			}
		}

		let difficulties = {};
		try { difficulties = JSON.parse(networkRaw.difficulties || '{}'); } catch (e) { difficulties = {}; }
		let network = {
			height: networkRaw.height ? parseInt(networkRaw.height, 10) : null,
			difficulty: difficulties[networkRaw.algorithm] || 0,
			difficulties: difficulties,
			algorithm: networkRaw.algorithm || 'rx/xcb'
		};
		let lastblock = {
			height: lastHeight,
			hash: lastHash,
			timestamp: lastBlockFound ? Math.floor(lastBlockFound / 1000) : null,
			reward: lastReward || reward.minerReward().toString()
		};

		currentStats = {
			pool: {
				hashrate: poolHashrate, hashrateSolo: 0,
				miners: miners, minersSolo: 0, workers: workers, workersSolo: 0,
				totalBlocks: totalBlocks, totalBlocksSolo: 0, totalDiff: totalDiff, totalDiffSolo: 0,
				totalShares: totalShares, totalSharesSolo: 0,
				lastBlockFound: lastBlockFound, lastBlockFoundSolo: null,
				roundScore: 0, roundHashes: 0,
				payments: paymentsFlat, totalPayments: totalPayments, totalMinersPaid: 0,
				blocks: blocksFlat
			},
			network: network,
			lastblock: lastblock,
			config: {
				poolHost: config.poolHost || '',
				coin: COIN, symbol: 'XCB',
				coinUnits: config.coinUnits, coinDecimalPlaces: config.coinDecimalPlaces, coinDifficultyTarget: coinDifficultyTarget,
				depth: (config.blockUnlocker && config.blockUnlocker.depth) || 20,
				fee: totalFeePercent(),
				soloFee: 0, networkFee: 0, finderReward: 0,
				donation: (config.blockUnlocker && config.blockUnlocker.donations) || {},
				version: require('../package.json').version,
				paymentsInterval: (config.payments && config.payments.interval) || 300,
				minPaymentThreshold: (config.payments && config.payments.minPayment) || '1000000000000000000',
				maxPaymentThreshold: null,
				transferFee: 0, denominationUnit: 1,
				slushMiningEnabled: false, weight: null,
				priceSource: null, priceCurrency: null,
				paymentIdSeparator: '.', fixedDiffEnabled: false, fixedDiffSeparator: '.',
				sendEmails: false,
				blocksChartEnabled: false, blocksChartDays: null, telegramBotName: null,
				workerSeparator: '+', algorithms: ['rx/xcb'],
				blockMaturity: (config.blockUnlocker && config.blockUnlocker.depth) || 20
			},
			charts: {}
		};

		broadcastLiveStats();
		log('info', logSystem, 'Stat collection finished in %d ms', [Date.now() - startTime]);
		setTimeout(collectStats, updateInterval * 1000);
	});
}

function broadcastLiveStats() {
	for (let key in liveConnections) {
		let res = liveConnections[key];
		let address = key.substr(0, key.indexOf(':'));
		let data = Object.assign({}, currentStats);
		data.miner = (address && minerStats[address]) || {};
		try { res.end(JSON.stringify(data)); } catch (e) { /* already closed */ }
	}
	liveConnections = {};

	for (let key in addressConnections) {
		let res = addressConnections[key];
		let address = key.substr(0, key.indexOf(':'));
		buildMinerData(address, function (data) {
			try { res.end(JSON.stringify(data)); } catch (e) { /* already closed */ }
		});
	}
	addressConnections = {};
}

function buildMinerData(address, cb) {
	if (!address) return cb({error: 'No address given.'});

	redisClient.multi([
		['hgetall', COIN + ':workers:' + address],
		['zrevrangebyscore', COIN + ':payments:' + address, '+inf', '-inf', 'WITHSCORES', 'LIMIT', 0, paymentsLimit],
		['keys', COIN + ':workers:' + address + '~*']
	]).exec(function (err, replies) {
		if (err || !replies[0] || !Object.keys(replies[0]).length) {
			return cb({error: 'No shares from this address yet. Enter the address your miner logs in with.'});
		}

		let stats = replies[0];
		stats.hashrate = (minerStats[address] && minerStats[address].hashrate) || 0;
		stats.roundScore = 0;
		stats.roundHashes = 0;

		let paymentsData = replies[1] || [];
		let workerKeys = replies[2] || [];

		redisClient.multi(workerKeys.map(function (k) { return ['hgetall', k]; })).exec(function (err2, workerReplies) {
			let workersData = [];
			for (let i = 0; i < workerKeys.length; i++) {
				let name = workerKeys[i].substr((COIN + ':workers:' + address + '~').length);
				let w = (workerReplies && workerReplies[i]) || {};
				workersData.push({
					name: name,
					hashrate: (minerStats[address + '~' + name] && minerStats[address + '~' + name].hashrate) || 0,
					lastShare: w.lastShare ? parseInt(w.lastShare, 10) : 0,
					hashes: w.hashes ? parseInt(w.hashes, 10) : 0
				});
			}
			cb({stats: stats, payments: paymentsData, workers: workersData, charts: {}});
		});
	});
}

function handleStats(req, res, query) {
	let data = Object.assign({}, currentStats);
	data.miner = (query.address && minerStats[query.address]) || {};
	sendJson(res, data);
}

function handleLiveStats(req, res, query) {
	res.writeHead(200, {
		'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache',
		'Content-Type': 'application/json', 'Connection': 'keep-alive'
	});
	let address = query.address || 'undefined';
	let key = address + ':' + Math.random().toString();
	res.on('close', function () { delete liveConnections[key]; });
	liveConnections[key] = res;
}

function handleStatsAddress(req, res, query) {
	let address = String(query.address || '').toLowerCase();
	let longpoll = query.longpoll === 'true';
	if (!longpoll) return buildMinerData(address, function (data) { sendJson(res, data); });

	res.writeHead(200, {
		'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache',
		'Content-Type': 'application/json', 'Connection': 'keep-alive'
	});
	if (!address) { res.end(JSON.stringify({error: 'No address given.'})); return; }
	let key = address + ':' + Math.random().toString();
	res.on('close', function () { delete addressConnections[key]; });
	addressConnections[key] = res;
}

function handleGetPayments(req, res, query) {
	// Payments are permanently dryRun until a real block matures and the first real payout is
	// rehearsed (see paymentProcessor.js) -- this is honestly always empty right now, not an error.
	let key = query.address ? COIN + ':payments:' + query.address : COIN + ':payments:all';
	let maxTime = query.time ? '(' + query.time : '+inf';
	redisClient.zrevrangebyscore(key, maxTime, '-inf', 'WITHSCORES', 'LIMIT', 0, paymentsLimit, function (err, result) {
		sendJson(res, err ? {error: 'Query failed'} : (result || []));
	});
}

function handleGetBlocks(req, res, query) {
	let maxHeight = query.height ? '(' + query.height : '+inf';
	redisClient.zrevrangebyscore(COIN + ':blocks:matured', maxHeight, '-inf', 'WITHSCORES', 'LIMIT', 0, blocksLimit, function (err, result) {
		sendJson(res, err ? {error: 'Query failed'} : (result || []));
	});
}

function handleTopMiners(req, res) {
	redisClient.keys(COIN + ':workers:*', function (err, workerKeys) {
		if (err || !workerKeys) return sendJson(res, {error: 'Error collecting top 10 miners stats'});
		redisClient.multi(workerKeys.map(function (k) { return ['hmget', k, 'lastShare', 'hashes']; })).exec(function (err2, redisData) {
			if (err2) return sendJson(res, {error: 'Error collecting top 10 miners stats'});
			let minersData = [];
			for (let i = 0; i < workerKeys.length; i++) {
				let member = workerKeys[i].substr((COIN + ':workers:').length);
				let data = redisData[i] || [null, null];
				minersData.push({
					miner: member.length > 24 ? member.substring(0, 10) + '...' + member.substring(member.length - 8) : member,
					hashrate: (minerStats[member] && minerStats[member].hashrate) || 0,
					lastShare: data[0], hashes: data[1]
				});
			}
			minersData.sort(function (a, b) { return (b.hashrate || 0) - (a.hashrate || 0); });
			sendJson(res, minersData.slice(0, 10));
		});
	});
}

function handleBlockExplorers(req, res) {
	// No public Core Blockchain block/transaction explorer with a confirmed, reachable per-block or
	// per-tx URL template was found this pass (blockindex.coreblockchain.net did not respond) --
	// left genuinely empty, not guessed. js/common.js degrades to a plain, non-linked hash/height.
	sendJson(res, {xcb: {blockchainExplorer: '', transactionExplorer: ''}});
}

function handleGetApis(req, res) {
	// XCB is not aggregated with any other coin's pool here -- empty object is the correct
	// "no sibling pools" answer, same shape every other coin's handleGetApis returns.
	sendJson(res, {});
}

function handleMinersHashrate(req, res) {
	let data = {};
	for (let login in minerStats) {
		if (login.indexOf('~') !== -1) continue;
		data[login] = minerStats[login].hashrate;
	}
	sendJson(res, {minersHashrate: data});
}

function handleWorkersHashrate(req, res) {
	let data = {};
	for (let login in minerStats) {
		if (login.indexOf('~') === -1) continue;
		data[login] = minerStats[login].hashrate;
	}
	sendJson(res, {workersHashrate: data});
}

const ROUTES = {
	'/stats': handleStats,
	'/live_stats': handleLiveStats,
	'/stats_address': handleStatsAddress,
	'/get_payments': handleGetPayments,
	'/get_blocks': handleGetBlocks,
	'/get_top10miners': handleTopMiners,
	'/block_explorers': handleBlockExplorers,
	'/get_apis': handleGetApis,
	'/miners_hashrate': handleMinersHashrate,
	'/workers_hashrate': handleWorkersHashrate
};

function handleServerRequest (request, response) {
	let parsed = url.parse(request.url, true);
	let handler = ROUTES[parsed.pathname];
	if (!handler) { response.writeHead(404, {'Access-Control-Allow-Origin': '*'}); response.end('Invalid API call'); return; }
	handler(request, response, parsed.query || {});
}

let server = http.createServer(handleServerRequest);
server.listen(config.api.port, config.api.bindIp || '0.0.0.0', function () {
	log('info', logSystem, 'API started on port %d', [config.api.port]);
});

collectStats();
