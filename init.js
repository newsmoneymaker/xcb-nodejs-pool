/**
 * Core Blockchain (XCB) Pool -- initialization script.
 *
 * Deliberately smaller than this template's other coins: no charts/telegram module this pass (sections
 * 5+ of the launch checklist are out of scope -- see xcb-project.md). Same `-module=` single-module
 * convention as every other coin here (each gets run as its own systemd unit: xcb-pool, xcb-pool-api,
 * xcb-pool-unlocker, xcb-pool-payments).
 **/
let cluster = require('cluster');

require('./lib/configReader.js');
require('./lib/logger.js');

let logSystem = 'master';
require('./lib/exceptionWriter.js')(logSystem);

log('info', logSystem, 'Starting Core Blockchain (XCB) pool version %s', [version]);

let redis = require('redis');
let redisDB = (config.redis.db && config.redis.db > 0) ? config.redis.db : 0;
global.redisClient = redis.createClient(config.redis.port, config.redis.host, {
	db: redisDB,
	auth_pass: config.redis.auth
});

if (cluster.isWorker) {
	switch (process.env.workerType) {
		case 'pool': require('./lib/pool.js'); break;
		case 'blockUnlocker': require('./lib/blockUnlocker.js'); break;
		case 'paymentProcessor': require('./lib/paymentProcessor.js'); break;
		case 'api': require('./lib/api.js'); break;
	}
	return;
}

let singleModule = (function () {
	let validModules = ['pool', 'api', 'unlocker', 'payments'];
	for (let i = 0; i < process.argv.length; i++) {
		if (process.argv[i].indexOf('-module=') === 0) {
			let moduleName = process.argv[i].split('=')[1];
			if (validModules.indexOf(moduleName) > -1) return moduleName;
			log('error', logSystem, 'Invalid module "%s", valid modules: %s', [moduleName, validModules.join(', ')]);
			process.exit();
		}
	}
})();

function spawnOne (type, enabled) {
	if (!enabled) return;
	let create = function () {
		let worker = cluster.fork({workerType: type});
		worker.on('exit', function () {
			log('error', logSystem, '%s died, spawning replacement...', [type]);
			setTimeout(create, 2000);
		});
	};
	create();
}

(function init () {
	if (singleModule) {
		log('info', logSystem, 'Running in single module mode: %s', [singleModule]);
		switch (singleModule) {
			case 'pool': spawnOne('pool', config.poolServer && config.poolServer.enabled); break;
			case 'unlocker': spawnOne('blockUnlocker', config.blockUnlocker && config.blockUnlocker.enabled); break;
			case 'payments': spawnOne('paymentProcessor', config.payments && config.payments.enabled); break;
			case 'api': spawnOne('api', config.api && config.api.enabled); break;
		}
	} else {
		spawnOne('pool', config.poolServer && config.poolServer.enabled);
		spawnOne('blockUnlocker', config.blockUnlocker && config.blockUnlocker.enabled);
		spawnOne('paymentProcessor', config.payments && config.payments.enabled);
		spawnOne('api', config.api && config.api.enabled);
	}
})();
