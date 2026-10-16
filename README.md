# xcb-nodejs-pool

Mining pool software for **Core Blockchain (XCB, "Core Coin")** written in Node.js. Core Blockchain
([coreblockchain.net](https://coreblockchain.net)) is an account-based, EVM-like chain -- a fork of
`go-ethereum`-family `go-core` -- **not** a Bitcoin-style UTXO chain, so this pool's wire protocol and
block-finding pipeline are structurally very different from every other `*-nodejs-pool` in this family.
Live example: <https://xcb.pool-pay.com>.

## Why this is not another cryptonote/Bitcoin-stratum fork

The node (`gocore`) builds the **entire block itself** -- there is no coinbase transaction, no merkle
tree, no block template to assemble. The pool's only job is to:

1. Poll `cryptore_getWork` (a classic geth/ethash-family mining RPC, `consensus/cryptore/api.go`) for the
   current `[sealHash, seedHash (vestigial), target, blockNumber]`.
2. Hand miners a job built from just the 32-byte `sealHash` + the network target.
3. Verify submitted shares locally with the real PoW function (RandomY, see below).
4. Relay a winning nonce back with `cryptore_submitWork(nonce, sealHash)` -- the node re-verifies and,
   if accepted, extends the chain with the real block. Every block reward lands **entirely on-chain, in
   the pool's own wallet** automatically; there is no coinbase split to carve a fee out of (see
   `lib/blockUnlocker.js`'s module comment for how pool-fee/developer-donation bookkeeping is handled as
   a purely off-chain Redis balance split of money the pool already holds).

## Proof of work: RandomY

"RandomY" is **not** a brand-new algorithm -- it's a tuned fork of Monero's RandomX (different Argon2
iteration count/salt, program size, scratchpad sizing; see `go-randomy`/`RandomY`'s own
`configuration.h`), with two coin-specific wrinkles: (1) a **fixed dataset key** `"56789"` that never
rotates per epoch (no DAG-epoch logic needed), and (2) a seed step of
`SHA3-512(sealHash[32] || nonce[8, little-endian])` fed into the hash as input, in place of the raw
header RandomX normally hashes. `lib/hasher.js` drives a small persistent C++ helper
(`hasher/xcb_randomy`) built against the real, renamed, vendored `librandomy` the upstream node itself
links -- see [poolpayminer](https://github.com/newsmoneymaker/poolpayminer)'s `rx/xcb` algorithm for the
miner-side implementation and the byte-order/library derivation notes.

## What it does

* **Stratum server** (`lib/pool.js`): this project's own invented wire shape (`mining.notify` =
  `[job_id, sealHashHex, targetHex, heightHex, clean_jobs]`, `mining.submit` = `[worker, job_id,
  nonceHex]`, no `mixHash` -- RandomY has no DAG-mixing concept at all). Connection-flood limits, an IP
  allow list, banning on a high invalid-share rate, vardiff remembered across reconnects, TCP keepalive
  on every stratum socket.
* **Accounts** are Core Blockchain addresses (`cb` + 42 hex chars, the real 44-char ICAN-style shape).
  Optional `.worker`/`+worker` suffix, reward mode prefix `prop:` (default, shared with time/score
  weighting) or `solo:`.
* **Block unlocker** (`lib/blockUnlocker.js`): a block candidate is settled once the chain is `depth`
  blocks past it. Confirms the block is really ours by reading `xcb_getBlockByNumber(height).miner`
  against the pool's own `corebase` address. Amounts are `BigInt` throughout (18 decimals, `COIN = 1e18`
  -- this chain uses Ethereum-style wei units, not Bitcoin's `1e8`). Dedupes block candidates by sealhash
  before crediting anyone, so the same real block can never be paid out twice.
* **Payment processor** (`lib/paymentProcessor.js`): one plain `xcb_sendTransaction`-equivalent per paid
  worker (no UTXO batching, none needed). The node's HTTP RPC deliberately never exposes the `personal`
  API (a real, historically-exploited geth misconfiguration risk, even tunnel/loopback-only); the real
  signing path is geth's own IPC socket (local-only on the node's own host, `personal`/`admin` already
  enabled there by default). Dry-run mode and an emergency-brake stop file, same convention as every
  other pool in this family.
* **Minimal public API** (`lib/api.js`): `/stats`, `/get_blocks`, `/get_payments`, `/stats_address`.

## Credits

Shares its coin-agnostic plumbing (`configReader.js`, `logger.js`, `exceptionWriter.js`, `utils.js`,
`notifications.js`, `market.js`, `apiInterfaces.js`, `shares.js`) with this project's sibling pools, all
ultimately descended from [cryptonote-nodejs-pool](https://github.com/dvandal/cryptonote-nodejs-pool) by
Dvandal (GNU GPL v2). The RPC/protocol-shape-specific files (`xcbRpc.js`, `blockBuilder.js`, `hasher.js`,
`reward.js`, `pool.js`, `blockUnlocker.js`, `paymentProcessor.js`) are written fresh for this coin's
fundamentally different, no-coinbase RPC shape.

## Configuration

Copy `config_examples/xcb.json` to `config.json`, fill in your own pool wallet address
(`poolServer.corebase`), Redis connection, and TLS certificate paths. Never commit a real developer
donation address into `config_examples/` -- that stays blank so anyone cloning this repo runs their own
honest pool, not ours.
