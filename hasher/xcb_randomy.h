/* Core Blockchain (XCB) "RandomY" hasher -- thin wrapper around the real, vendored (symbol-renamed)
 * go-randomy/librandomx library (now built by the main poolpayminer project itself from real upstream
 * source, same library). See xcb_randomy_upstream.h and xcb-project.md for the full story.
 *
 * Updated 2026-10-17: this helper's pool.js caller (lib/pool.js's onSubmit()) calls hasher.hash() for
 * EVERY real submitted share -- both for vardiff credit and real block-candidate checks, not just
 * occasional candidates -- so this process hashes at roughly the same real volume as a connected miner.
 * It is a standalone, long-running, NATIVE LINUX process (this Makefile is Linux x86_64 only, no
 * Windows/wine concern at all), so it gets the SAME full/dataset-mode + JIT treatment as the real Linux
 * poolpayminer build (proven correct and stable there) -- full mode is now simply always on, no light-mode
 * toggle exposed here (unlike the miner side, which keeps a config-driven toggle for low-RAM machines);
 * this helper is meant to run on the pool's own server, not an end-user's machine.
 *
 * Usage (one VM per helper process -- randomx_vm is NOT safe for concurrent use from multiple threads,
 * the shared cache/dataset behind it is read-only after init and IS safe to share -- not relevant here
 * since each helper process is single-threaded, see main.cpp):
 *   void *vm = xcb_randomy::createVm();     // first call lazily builds the one shared, fixed-key cache
 *                                            // (ASCII "56789", never rotated -- see go-randomy's own
 *                                            // vm.go NewRandomYVMWithKeyAndMutex()) AND the ~264 MiB
 *                                            // dataset (built once, multi-threaded across all available
 *                                            // CPU threads -- the one genuinely slow startup cost).
 *   xcb_randomy::hash(vm, blob40, out32);    // blob40 = sealhash(32 bytes) || nonce(8 bytes, native x86
 *                                            // little-endian -- see blockBuilder.js/pool.js).
 *                                            // Internally: out = RandomX(SHA3-512(blob40)), matching
 *                                            // go-randomy's own RandomY() in vm.go exactly -- identical
 *                                            // result to light mode, by RandomX's own design guarantee
 *                                            // (verified explicitly, see xcb-project.md).
 *   xcb_randomy::destroyVm(vm);              // on process shutdown.
 */

#ifndef XMRIG_XCB_RANDOMY_H
#define XMRIG_XCB_RANDOMY_H

#include <cstdint>

namespace xcb_randomy {

void *createVm();
void destroyVm(void *vm);

// blob40 must point to exactly 40 readable bytes (sealhash[0..32) || nonce[32..40)); out must point to
// 32 writable bytes.
void hash(void *vm, const uint8_t *blob40, uint8_t *out32);

// Self-test: real vector cross-checked against go-randomy's own randomy_test.go (key="test key 000",
// input="This is a test" -> hash 0e9ab13e4b337c866e17445621be8d180c0a18a325932078dc33f7ac69ff17e8), run
// through THIS wrapper's exact code path (own one-off cache/vm, same calculate_hash call) in BOTH light
// and full/dataset mode, checking they give the BYTE-IDENTICAL hash -- not just the raw library, and not
// just one mode. Returns true iff the renamed, vendored library still behaves identically in both modes.
bool selfTest();

} // namespace xcb_randomy

#endif // XMRIG_XCB_RANDOMY_H
