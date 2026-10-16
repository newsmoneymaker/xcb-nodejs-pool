# Changes

## 1.0.0

* First release: Core Blockchain (XCB, RandomY/cryptore PoW) pool -- an account-based, EVM-like chain,
  structurally different from every Bitcoin-stratum or cryptonote-style pool in this family (no
  coinbase/merkle tree/block template; the node builds the whole block itself from a 32-byte sealhash).
* `lib/xcbRpc.js`: plain JSON-RPC 2.0 client for `cryptore_getWork`/`cryptore_submitWork`/
  `xcb_blockNumber`/`xcb_syncing`/`xcb_getBlockByNumber`/`xcb_getBalance`.
* `lib/blockBuilder.js`/`lib/pool.js`: this project's own invented stratum wire shape (5-field
  `mining.notify`, 3-field `mining.submit`, no mixHash -- RandomY has no DAG-mixing concept).
* `lib/hasher.js` + `hasher/xcb_randomy`: share checking via the real, renamed, vendored `librandomy`
  the upstream node itself links (SHA3-512 seed step + RandomX-family hash, cache-only/light mode).
* `lib/reward.js`: flat 5 XCB block reward (`consensus/cryptore/consensus.go`'s `BlockReward`), BigInt
  throughout (18 decimals, `COIN = 1e18` -- Ethereum-style wei units, not Bitcoin's `1e8`).
* `lib/blockUnlocker.js`: settles a block once `depth` confirmations have passed, verified against
  `xcb_getBlockByNumber(height).miner`; dedupes candidates by sealhash before crediting (never pay the
  same real block twice).
* `lib/paymentProcessor.js`: one `xcb_sendTransaction`-equivalent per paid worker. Real signing path
  (geth IPC on the node's own host) designed but not yet exercised -- stays `dryRun: true` until a real
  mature balance exists and the first payout is rehearsed manually.
* `lib/api.js`: minimal public API (`/stats`, `/get_blocks`, `/get_payments`, `/stats_address`).
* Dedicated Redis instance (AOF persistence), TCP keepalive on every stratum socket, client user-agent
  captured and logged on login.
* Real end-to-end test against the live, fully-synced mainnet node: real jobs at advancing block
  heights, real shares accepted from a real poolpayminer (`rx/xcb`) miner, both over localhost and over
  the public `xcb.pool-pay.com:6200` hostname/port.
