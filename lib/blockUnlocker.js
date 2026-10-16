/**
 * Block unlocker for Core Blockchain (XCB).
 *
 * A block candidate (redis zset <coin>:blocks:candidates, score = height, member
 * rewardType:login:sealHash:time:difficulty:shares:score, written by shares.js when cryptore_submitWork
 * returned true) is settled once the chain is `depth` blocks past it:
 *  - xcb_getBlockByNumber(height) is read; if no block exists there yet, try again later;
 *  - if block.miner does not match this pool's corebase address (config.poolServer.corebase, the SAME
 *    address xcb-node.service's --miner.corebase was set to), it is not actually our block (should not
 *    normally happen -- the node always mines FOR itself -- treated as orphaned defensively);
 *  - otherwise it is real, confirmed ours: reward = reward.minerReward() (flat 5 XCB, see reward.js).
 *
 * Amounts are BigInt throughout (18 decimals, COIN=1e18 -- see critical-wrong-coin-unit-scale.md: 5e18
 * already exceeds Number.MAX_SAFE_INTEGER, so this does NOT use plain Number/Math.floor arithmetic
 * anywhere a real amount is involved, unlike this template's Bitcoin-stratum-coin siblings). Worker
 * balances are stored as a STRING field (<coin>:workers:<address> balance) holding the decimal digits
 * of the BigInt, read-added-written explicitly rather than via redis HINCRBY (which would go through
 * ioredis's own Number coercion and silently lose precision above 2^53).
 *
 * Uncle blocks (GHOST-style) exist in this chain's consensus but are NOT specially handled: see
 * reward.js's own comment -- if a real block we found is ever seen with extra, unexpected balance (an
 * uncle inclusion reward), this logs it and credits only the flat reward, rather than guessing a split.
 * This is the conservative choice from [[critical-double-credit-bug]]'s lesson: never silently invent a
 * number when a real one isn't confirmed.
 **/
let async = require('async');

let rpc = require('./xcbRpc.js');
let notifications = require('./notifications.js');
let reward = require('./reward.js');

let unlockerConfig = config.blockUnlocker;
let depth = unlockerConfig.depth || 20;
let corebase = (config.poolServer.corebase || '').toLowerCase();

let logSystem = 'unlocker';
require('./exceptionWriter.js')(logSystem);

let donations = {};
if (unlockerConfig.donations) {
	Object.keys(unlockerConfig.donations).forEach(function (addr) {
		let pct = Number(unlockerConfig.donations[addr]);
		if (/^cb[0-9a-f]{42}$/i.test(addr) && pct > 0 && pct <= 10) donations[addr.toLowerCase()] = pct;
	});
}
let donationPercent = Object.keys(donations).reduce(function (sum, a) { return sum + donations[a]; }, 0);

log('info', logSystem, 'Started (depth %d blocks, pool fee %s%%, developer donation %s%%)', [depth, unlockerConfig.poolFee || 0, donationPercent]);

function getBalance (worker, cb) {
	redisClient.hget(config.coin + ':workers:' + worker, 'balance', function (err, val) {
		if (err) return cb(err);
		cb(null, val ? BigInt(val) : 0n);
	});
}

function runInterval () {
	async.waterfall([

		function (callback) {
			redisClient.zrange(config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES', function (error, results) {
				if (error) {
					log('error', logSystem, 'Error trying to get pending blocks from redis %j', [error]);
					callback(true);
					return;
				}
				if (results.length === 0) {
					callback(true);
					return;
				}

				let blocks = [];
				let seenHashes = {};
				let dupeMembers = [];
				for (let i = 0; i < results.length; i += 2) {
					let parts = results[i].split(':');
					let sealHash = parts[2];
					// Same real-incident protection as every other coin here (see
					// critical-double-credit-bug.md) -- a block-solving share could in principle end up
					// recorded as a candidate more than once; never credit the same sealhash twice.
					if (seenHashes[sealHash]) {
						dupeMembers.push(results[i]);
						continue;
					}
					seenHashes[sealHash] = true;
					blocks.push({
						serialized: results[i],
						height: parseInt(results[i + 1]),
						rewardType: parts[0],
						login: parts[1],
						sealHash: sealHash,
						time: parts[3],
						difficulty: parts[4],
						shares: parts[5],
						score: parts.length >= 7 ? parts[6] : parts[5]
					});
				}
				if (dupeMembers.length) {
					log('warn', logSystem, 'Removed %d duplicate block candidate(s): %j', [dupeMembers.length, dupeMembers]);
					redisClient.zrem(config.coin + ':blocks:candidates', dupeMembers, function (error) {
						if (error) log('error', logSystem, 'Failed to remove duplicate candidates %j', [error]);
					});
				}
				callback(null, blocks);
			});
		},

		function (blocks, callback) {
			rpc.blockNumber(function (error, heightHex) {
				if (error || typeof heightHex !== 'string') {
					log('error', logSystem, 'Error getting the chain height %j', [error ? (error.message || JSON.stringify(error)) : 'bad reply']);
					callback(true);
					return;
				}
				let height = parseInt(heightHex, 16);
				let ripe = blocks.filter(function (block) { return height - block.height >= depth; });
				if (ripe.length === 0) {
					callback(true);
					return;
				}
				callback(null, ripe);
			});
		},

		function (blocks, callback) {
			async.filter(blocks, function (block, mapCback) {
				let heightHex = '0x' + block.height.toString(16);
				rpc.getBlockByNumber(heightHex, false, function (error, chainBlock) {
					if (error) {
						log('error', logSystem, 'Block %d: %s, waiting', [block.height, error.message || JSON.stringify(error)]);
						return mapCback(false);
					}
					if (!chainBlock) {
						// not decidable yet (shouldn't normally happen once depth confirmations passed)
						return mapCback(false);
					}
					let miner = String(chainBlock.miner || '').toLowerCase();
					if (corebase && miner !== corebase) {
						log('warn', logSystem, 'Block %d: on-chain miner %s does not match our corebase %s -- treating as orphaned', [block.height, miner, corebase]);
						block.orphaned = 1;
						block.reward = 0n;
					} else {
						block.orphaned = 0;
						block.reward = reward.minerReward();
						if (Array.isArray(chainBlock.uncles) && chainBlock.uncles.length) {
							log('warn', logSystem, 'Block %d has %d uncle(s) -- this pool does not know how to split any uncle inclusion reward, crediting only the flat %s wei block reward', [block.height, chainBlock.uncles.length, block.reward.toString()]);
						}
					}
					mapCback(true);
				});
			}, function (decided) {
				callback(decided.length === 0 ? true : null, decided);
			});
		},

		function (blocks, callback) {
			let redisCommands = blocks.map(function (block) {
				return ['hgetall', config.coin + ':scores:' + (block.rewardType === 'prop' ? 'prop' : 'solo') + ':round' + block.height];
			});
			redisClient.multi(redisCommands).exec(function (error, replies) {
				if (error) {
					log('error', logSystem, 'Error with getting round shares from redis %j', [error]);
					callback(true);
					return;
				}
				for (let i = 0; i < replies.length; i++) blocks[i].workerScores = replies[i];
				callback(null, blocks);
			});
		},

		function (blocks, callback) {
			let orphanCommands = [];
			blocks.forEach(function (block) {
				if (!block.orphaned) return;
				orphanCommands.push(['del', config.coin + ':scores:prop:round' + block.height]);
				orphanCommands.push(['del', config.coin + ':shares_actual:prop:round' + block.height]);
				orphanCommands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
				orphanCommands.push(['zadd', config.coin + ':blocks:matured', block.height, [
					block.rewardType, block.login, block.sealHash, block.time, block.difficulty, block.shares, block.orphaned
				].join(':')]);
				if (block.workerScores && block.rewardType === 'prop') {
					Object.keys(block.workerScores).forEach(function (worker) {
						orphanCommands.push(['hincrbyfloat', config.coin + ':scores:prop:roundCurrent', worker, block.workerScores[worker]]);
					});
				}
				log('warn', logSystem, 'Block %d (%s) is orphaned', [block.height, block.sealHash]);
				notifications.sendToAll('blockOrphaned', {HEIGHT: block.height, HASH: block.sealHash});
			});
			if (orphanCommands.length === 0) return callback(null, blocks);
			redisClient.multi(orphanCommands).exec(function (error) {
				callback(error ? true : null, blocks);
			});
		},

		function (blocks, callback) {
			let unlocked = 0;
			let payments = {}; // worker -> BigInt
			let commands = [];

			blocks.forEach(function (block) {
				if (block.orphaned) return;
				unlocked++;

				commands.push(['del', config.coin + ':scores:prop:round' + block.height]);
				commands.push(['del', config.coin + ':shares_actual:prop:round' + block.height]);
				commands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
				commands.push(['zadd', config.coin + ':blocks:matured', block.height, [
					block.rewardType, block.login, block.sealHash, block.time, block.difficulty, block.shares, block.orphaned, block.reward.toString()
				].join(':')]);

				let feePercent = BigInt(Math.max(0, Math.round((unlockerConfig.poolFee || 0) * 100))); // basis points *100 -> integer
				let donationBp = BigInt(Math.round(donationPercent * 100));
				let totalBp = feePercent + donationBp; // out of 10000
				let distributable = block.reward - (block.reward * totalBp) / 10000n;

				Object.keys(donations).forEach(function (account) {
					let bp = BigInt(Math.round(donations[account] * 100));
					let amount = (block.reward * bp) / 10000n;
					payments[account] = (payments[account] || 0n) + amount;
					log('info', logSystem, 'Block %d: developer donation %s%% = %s wei to %s', [block.height, donations[account], amount.toString(), account]);
				});

				log('info', logSystem, 'Unlocked block %d: reward %s wei, pool fee %s%%, miners get %s wei', [block.height, block.reward.toString(), (unlockerConfig.poolFee || 0), distributable.toString()]);

				if (block.workerScores) {
					let totalScore = parseFloat(block.score);
					let creditedSoFar = 0n;
					let workerKeys = Object.keys(block.workerScores);
					workerKeys.forEach(function (worker, idx) {
						let part;
						if (idx === workerKeys.length - 1) {
							part = distributable - creditedSoFar; // remainder to the last worker, no wei lost to truncation
						} else {
							let shareBp = BigInt(Math.round((parseFloat(block.workerScores[worker]) / totalScore) * 1e9));
							part = (distributable * shareBp) / 1000000000n;
						}
						creditedSoFar += part;
						if (part > 0n) payments[worker] = (payments[worker] || 0n) + part;
					});
				}

				notifications.sendToAll('blockUnlocked', {HEIGHT: block.height, HASH: block.sealHash, REWARD: block.reward.toString()});
			});

			if (unlocked === 0) {
				callback(true);
				return;
			}

			async.eachSeries(Object.keys(payments), function (worker, cb) {
				let amount = payments[worker];
				if (!(amount > 0n)) return cb();
				getBalance(worker, function (err, bal) {
					if (err) return cb(err);
					commands.push(['hset', config.coin + ':workers:' + worker, 'balance', (bal + amount).toString()]);
					cb();
				});
			}, function (err) {
				if (err) {
					log('error', logSystem, 'Error reading worker balances %j', [err]);
					callback(true);
					return;
				}
				redisClient.multi(commands).exec(function (error) {
					if (error) {
						log('error', logSystem, 'Error with unlocking blocks %j', [error]);
						callback(true);
						return;
					}
					log('info', logSystem, 'Unlocked %d block(s) and updated balances of %d account(s)', [unlocked, Object.keys(payments).length]);
					callback(null);
				});
			});
		}
	], function () {
		setTimeout(runInterval, (unlockerConfig.interval || 30) * 1000);
	});
}

runInterval();
