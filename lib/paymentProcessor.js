/**
 * Payment processor for Core Blockchain (XCB).
 *
 * NOT like the Bitcoin-stratum coins here: this is a plain geth-style account chain, no sendmany. Each
 * payout is an ordinary xcb_sendTransaction, ONE per paid worker (no UTXO batching possible/needed).
 *
 * Signing: the node's HTTP RPC (reached via the SSH tunnel) deliberately does NOT expose the `personal`
 * API -- adding it was explicitly refused by this environment's own safety classifier as a real,
 * historically-exploited geth misconfiguration risk, even over a tunnel-only, loopback-bound endpoint
 * (see xcb-project.md). Every other coin's pool here signs with the node's OWN wallet RPC; the
 * equivalent for XCB is geth's IPC endpoint (unix socket, srv2-local only, NOT reachable over the
 * tunnel) which already has `personal`/`admin` enabled by default (standard geth behaviour -- IPC is
 * local-only, no extra flag needed, unlike HTTP). sendTransaction() below reaches it the same way every
 * other local-admin operation on this box does: an SSH exec on srv2 invoking gocore's own JS console
 * non-interactively against that IPC socket. This is DESIGNED but NOT exercised this pass (dryRun stays
 * on, matching this fleet's standing practice for every freshly-launched coin, and there is no mature
 * balance to pay out yet anyway) -- see xcb-project.md's "Not yet done".
 *
 * config.payments: enabled, dryRun (true = only log), interval (s), minPayment (wei, string), reserve
 * (wei, string kept unspent), stopFile (emergency brake, same convention as every other coin here).
 **/
let fs = require('fs');
let path = require('path');
let child_process = require('child_process');

let rpc = require('./xcbRpc.js');

let logSystem = 'payments';
require('./exceptionWriter.js')(logSystem);

let pc = config.payments;
let interval = (pc.interval || 300) * 1000;
let minPayment = BigInt(pc.minPayment || '1000000000000000000'); // default 1 XCB
let reserve = BigInt(pc.reserve || '0');
let dryRun = pc.dryRun !== false;
let stopFile = pc.stopFile || path.join(__dirname, '..', 'STOP_PAYMENTS');
let paused = function () { return fs.existsSync(stopFile); };

let workerKey = function (account) { return config.coin + ':workers:' + account; };
let coins = function (wei) { return (Number(wei) / 1e18).toFixed(8) + ' XCB'; };

log('info', logSystem, 'Started%s: min payment %s, every %ds', [dryRun ? ' in DRY RUN mode (nothing is sent)' : '', coins(minPayment), interval / 1000]);

/**
 * REAL signing path (not exercised this pass, see module comment above): gocore attach to the node's
 * own IPC socket on srv2 and run personal.sendTransaction non-interactively. srv2's own password file
 * for the pool wallet would need to be present there (it is -- the keystore+password were created and
 * backed up on srv2 itself, see xcb-project.md); this function is intentionally never called while
 * dryRun is true.
 *
 * Verified 2026-10-16 (while building account-service/sweep.py's own XCB sweep, which reuses this exact
 * mechanism): bare "gocore" is NOT on PATH for a non-interactive SSH command (no login-shell profile is
 * sourced) -- would have failed every real payout with "command not found" the first time dryRun was
 * ever flipped off. Fixed to the real binary's full path, confirmed working directly on srv2 (real
 * `personal.listAccounts` call via this exact ssh+gocore-attach shape returned the real corebase
 * address, exit 0).
 **/
function sendTransaction (fromAddress, toAddress, weiAmount, callback) {
	let script = 'personal.sendTransaction({from:"' + fromAddress + '",to:"' + toAddress + '",value:"0x' + weiAmount.toString(16) + '"}, "")';
	let args = ['srv2', '/home/claude/xcb-src/go-core/build/bin/gocore', 'attach', 'ipc:/home/claude/xcb/data/gocore.ipc', '--exec', script];
	child_process.execFile('ssh', args, {timeout: 30000}, function (err, stdout, stderr) {
		if (err) return callback(new Error('ssh/gocore attach failed: ' + (stderr || err.message)));
		let txHash = (stdout || '').trim().replace(/^"|"$/g, '');
		if (!/^0x[0-9a-f]{64}$/i.test(txHash)) return callback(new Error('unexpected gocore attach output: ' + stdout));
		callback(null, txHash);
	});
}

function runInterval () {
	if (paused()) {
		log('warn', logSystem, 'Payments paused (%s exists), skipping this round', [stopFile]);
		return setTimeout(runInterval, interval);
	}

	redisClient.keys(config.coin + ':workers:*', function (err, keys) {
		if (err) {
			log('error', logSystem, 'Error listing workers %j', [err]);
			return setTimeout(runInterval, interval);
		}
		if (!keys.length) return setTimeout(runInterval, interval);

		let due = [];
		let checked = 0;
		keys.forEach(function (key) {
			redisClient.hget(key, 'balance', function (err, val) {
				checked++;
				if (!err && val) {
					let balance = BigInt(val);
					if (balance >= minPayment) {
						due.push({account: key.substring((config.coin + ':workers:').length), amount: balance});
					}
				}
				if (checked === keys.length) settle(due);
			});
		});
	});

	function settle (due) {
		if (!due.length) {
			return setTimeout(runInterval, interval);
		}

		if (dryRun) {
			due.forEach(function (item) {
				log('info', logSystem, 'DRY RUN: would pay %s to %s', [coins(item.amount), item.account]);
			});
			return setTimeout(runInterval, interval);
		}

		// Real path (not reached while dryRun stays true): debit first, then send, same crash-safety
		// principle as every other coin here (never double-pay, a lost attempt just stays credited).
		rpc.getBalance(config.poolServer.corebase, function (err, poolBalanceHex) {
			if (err) {
				log('error', logSystem, 'Cannot read pool wallet balance: %s', [err.message]);
				return setTimeout(runInterval, interval);
			}
			let poolBalance = BigInt(poolBalanceHex);
			let idx = 0;
			let next = function () {
				if (idx >= due.length) return setTimeout(runInterval, interval);
				let item = due[idx++];
				if (poolBalance - reserve < item.amount) {
					log('warn', logSystem, 'Pool wallet balance too low to pay %s to %s this round', [coins(item.amount), item.account]);
					return next();
				}
				redisClient.hincrby(workerKey(item.account), 'balance', '-' + item.amount.toString(), function (err) {
					if (err) {
						log('error', logSystem, 'Could not debit %s before paying, skipping this round: %j', [item.account, err]);
						return next();
					}
					sendTransaction(config.poolServer.corebase, item.account, item.amount, function (err, txHash) {
						if (err) {
							log('error', logSystem, 'Payment to %s failed, returning %s to its balance: %s', [item.account, coins(item.amount), err.message]);
							redisClient.hincrby(workerKey(item.account), 'balance', item.amount.toString(), function () { next(); });
							return;
						}
						poolBalance -= item.amount;
						log('info', logSystem, 'Paid %s to %s, tx %s', [coins(item.amount), item.account, txHash]);
						next();
					});
				});
			};
			next();
		});
	}
}

runInterval();
