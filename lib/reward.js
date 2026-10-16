/**
 * Core Blockchain (XCB) block reward: a plain, flat constant, confirmed from source
 * (consensus/cryptore/consensus.go: `BlockReward = big.NewInt(5e+18)`), no halving logic found anywhere
 * in accumulateRewards(). 18 decimals (COIN = 1e18, Ethereum/wei-style units) -- see
 * [[critical-wrong-coin-unit-scale]] for why this was checked against source rather than assumed, and
 * xcb-project.md for the live getblock cross-check.
 *
 * Uncle blocks (GHOST-style) exist in this chain's consensus but are NOT handled here: this pool only
 * ever credits straight block rewards. If a real block we found is ever seen paying an unexpected extra
 * amount (an uncle inclusion reward), blockUnlocker.js logs and flags it rather than guessing a split --
 * see its own comment.
 **/
const MINER_REWARD = 5000000000000000000n; // 5 XCB, 18 decimals

exports.minerReward = function () {
	return MINER_REWARD;
};
