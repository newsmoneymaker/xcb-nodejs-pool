/* Core Blockchain (XCB) "RandomY" hasher -- thin wrapper around the real, vendored (symbol-renamed)
 * go-randomy/librandomx prebuilt library. See xcb_randomy_upstream.h and xcb-project.md for the full story.
 *
 * Usage (one VM per CPU worker thread -- randomx_vm is NOT safe for concurrent use from multiple threads,
 * the shared cache behind it is read-only after init and IS safe to share):
 *   void *vm = xcb_randomy::createVm();     // first call anywhere lazily builds the one shared, fixed-key
 *                                            // cache (ASCII "56789", never rotated -- see go-randomy's own
 *                                            // vm.go NewRandomYVMWithKeyAndMutex()); safe to call from many
 *                                            // threads concurrently (std::call_once-guarded).
 *   xcb_randomy::hash(vm, blob40, out32);    // blob40 = sealhash(32 bytes) || nonce(8 bytes, native x86
 *                                            // little-endian -- exactly what this project's generic
 *                                            // nonce-splicing machinery already writes into Job::blob()
 *                                            // at nonceOffset()=32/nonceSize()=8 for RX_XCB, see Job.cpp).
 *                                            // Internally: out = RandomX(SHA3-512(blob40)), matching
 *                                            // go-randomy's own RandomY() in vm.go exactly.
 *   xcb_randomy::destroyVm(vm);              // per-thread, on worker shutdown.
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
// through THIS wrapper's exact code path (own cache/vm, same calculate_hash call) -- not just the raw
// library. Returns true iff the renamed, vendored library still behaves identically.
bool selfTest();

} // namespace xcb_randomy

#endif // XMRIG_XCB_RANDOMY_H
