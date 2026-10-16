/**
 * Core Blockchain (XCB) Pool -- minimal stats API (read-only). Deliberately smaller than this template's
 * other coins' api.js: full account-service/admin.pool-pay.com integration is explicitly out of scope
 * for this pass (sections 5+ of the launch checklist) -- see xcb-project.md. Covers just enough for
 * basic monitoring: /stats, /get_blocks, /get_payments, /stats_address.
 **/
let http = require('http');
let url = require('url');

let utils = require('./utils.js');
let rpc = require('./xcbRpc.js');

let logSystem = 'api';
require('./exceptionWriter.js')(logSystem);

let currentStats = {};

function collectStats (callback) {
	let multi = redisClient.multi([
		['hgetall', config.coin + ':stats'],
		['hgetall', config.coin + ':network'],
		['zcard', config.coin + ':blocks:matured'],
		['zcard', config.coin + ':blocks:candidates'],
		['hgetall', config.coin + ':payments:pending']
	]);
	multi.exec(function (err, replies) {
		if (err) return callback(err);
		rpc.syncing(function (syncErr, syncing) {
			let stats = {
				pool: {
					stats: replies[0] || {},
					blocks: {matured: Number(replies[2] || 0), candidates: Number(replies[3] || 0)}
				},
				network: Object.assign({}, replies[1] || {}),
				coin: config.coin,
				algorithm: 'rx/xcb',
				coinUnits: config.coinUnits,
				coinDecimalPlaces: config.coinDecimalPlaces,
				node: {
					syncing: !syncErr && syncing ? syncing : false
				},
				config: {
					poolFee: config.blockUnlocker.poolFee || 0,
					minPayment: config.payments.minPayment,
					ports: (config.poolServer.ports || []).map(function (p) { return {port: p.port, desc: p.desc || ''}; })
				}
			};
			callback(null, stats);
		});
	});
}

function handleStats (response) {
	collectStats(function (err, stats) {
		response.writeHead(200, {'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Content-Type': 'application/json'});
		response.end(JSON.stringify(err ? {error: err.message} : stats));
	});
}

function handleGetBlocks (response) {
	redisClient.zrevrange(config.coin + ':blocks:matured', 0, 99, 'WITHSCORES', function (err, data) {
		let blocks = [];
		if (!err && data) {
			for (let i = 0; i < data.length; i += 2) {
				let parts = data[i].split(':');
				blocks.push({
					height: Number(data[i + 1]),
					rewardType: parts[0], login: parts[1], hash: parts[2], time: Number(parts[3]),
					difficulty: parts[4], shares: parts[5], orphaned: parts[6] === '1', reward: parts[7] || null
				});
			}
		}
		response.writeHead(200, {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'});
		response.end(JSON.stringify(blocks));
	});
}

function handleGetPayments (response) {
	redisClient.hgetall(config.coin + ':payments:pending', function (err, data) {
		response.writeHead(200, {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'});
		response.end(JSON.stringify(err ? {error: err.message} : Object.values(data || {}).map(function (s) { try { return JSON.parse(s); } catch (e) { return null; } })));
	});
}

function handleMinerStats (urlParts, response) {
	let address = String(urlParts.query.address || '').toLowerCase();
	if (!/^cb[0-9a-f]{42}$/.test(address)) {
		response.writeHead(400, {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'});
		return response.end(JSON.stringify({error: 'invalid address'}));
	}
	redisClient.hgetall(config.coin + ':workers:' + address, function (err, data) {
		response.writeHead(200, {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'});
		response.end(JSON.stringify(err ? {error: err.message} : (data || {})));
	});
}

function handleServerRequest (request, response) {
	let urlParts = url.parse(request.url, true);
	switch (urlParts.pathname) {
		case '/stats':
			return handleStats(response);
		case '/get_blocks':
			return handleGetBlocks(response);
		case '/get_payments':
			return handleGetPayments(response);
		case '/stats_address':
			return handleMinerStats(urlParts, response);
		default:
			response.writeHead(404, {'Access-Control-Allow-Origin': '*'});
			response.end('Not found');
	}
}

let server = http.createServer(handleServerRequest);
server.listen(config.api.port, config.api.bindIp || '0.0.0.0', function () {
	log('info', logSystem, 'API started on port %d', [config.api.port]);
});
