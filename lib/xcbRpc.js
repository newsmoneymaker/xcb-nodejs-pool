/**
 * Core Blockchain (XCB) pool -- JSON-RPC 2.0 client for the node (gocore), reached via the main
 * server's own SSH tunnel to srv2's loopback-only RPC (see xcb-project.md: xcb-tunnel.service forwards
 * 127.0.0.1:8545 on THIS server to srv2's 127.0.0.1:8545 -- never reach across to srv2 directly).
 *
 * Real methods used (confirmed from go-core's own source, consensus/cryptore/api.go and
 * internal/xcbapi/api.go):
 *   xcb_blockNumber, xcb_syncing            -- node status
 *   cryptore_getWork()                       -> [sealHashHex, seedHashHex(vestigial, ignored), targetHex, blockNumberHex]
 *   cryptore_submitWork(nonceHex, sealHashHex) -> bool
 *   xcb_getBlockByNumber(heightHex, false)   -- for confirming a found block / its real reward
 *   xcb_getBalance(address, "latest")        -- pool wallet balance (payments)
 **/
let http = require('http');

let rpcConfig = config.daemon || {};
let host = rpcConfig.host || '127.0.0.1';
let port = rpcConfig.port || 8545;

let nextId = 1;

function call (method, params, callback) {
	callback = callback || function () {};
	let body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: method, params: params || [] });

	let req = http.request({
		hostname: host,
		port: port,
		path: '/',
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(body)
		},
		timeout: rpcConfig.timeout || 10000
	}, function (res) {
		let data = '';
		res.setEncoding('utf8');
		res.on('data', function (chunk) { data += chunk; });
		res.on('end', function () {
			let json;
			try {
				json = JSON.parse(data);
			} catch (e) {
				callback(new Error('xcbRpc: bad JSON from node: ' + e.message));
				return;
			}
			if (json.error) {
				callback(new Error('xcbRpc: ' + method + ': ' + (json.error.message || JSON.stringify(json.error))));
				return;
			}
			callback(null, json.result);
		});
	});

	req.on('timeout', function () { req.destroy(new Error('xcbRpc: ' + method + ' timed out')); });
	req.on('error', function (err) { callback(err); });
	req.write(body);
	req.end();
}

exports.call = call;

exports.blockNumber = function (cb) { call('xcb_blockNumber', [], cb); };
exports.syncing = function (cb) { call('xcb_syncing', [], cb); };
exports.getWork = function (cb) { call('cryptore_getWork', [], cb); };
// Real signature confirmed from consensus/cryptore/api.go: SubmitWork(nonce types.BlockNonce, hash
// common.Hash) bool -- exactly 2 params, no mixDigest/seedHash (RandomY has no DAG, nothing to mix).
exports.submitWork = function (nonceHex, sealHashHex, cb) { call('cryptore_submitWork', [nonceHex, sealHashHex], cb); };
exports.getBlockByNumber = function (heightHex, fullTx, cb) { call('xcb_getBlockByNumber', [heightHex, !!fullTx], cb); };
exports.getBalance = function (address, cb) { call('xcb_getBalance', [address, 'latest'], cb); };
exports.getTransactionCount = function (address, cb) { call('xcb_getTransactionCount', [address, 'latest'], cb); };
