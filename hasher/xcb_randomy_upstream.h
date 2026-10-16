/* Core Blockchain (XCB) "RandomY" -- minimal, hand-transcribed declarations for the REAL, unmodified
 * upstream RandomX C ABI exported by github.com/core-coin/RandomY's own prebuilt librandomx.a (BSD-3
 * licensed, same ABI shape as tevador/RandomX -- see randomy.h in that repo). This project vendors that
 * EXACT prebuilt static library (src/crypto/xcb_randomy/lib/linux-x86_64/librandomy_xcb.a) rather than
 * trying to replicate RandomY's hash inside this project's own, heavily refactored RandomX engine
 * (src/crypto/randomx/) -- see xcb-project.md for why: RandomY's configuration.h differs from the
 * reference RandomX config in more than just the Argon2 salt (ArgonIterations, ProgramSize,
 * ProgramIterations, ScratchpadL1/L2/L3 all differ too), and reconstructing those inside this project's
 * own engine via RandomX_ConfigurationXcb produced a DIFFERENT hash than the real library for the
 * standard RandomX README test vector -- a real instance of [[critical-wrong-randomx-variant-bug]] caught
 * before being wired in. Reusing the actual, real, already-correct binary sidesteps that risk entirely.
 *
 * Every symbol below was renamed from the library's real name (randomx_*) to this xcbrndy_* prefix via
 * `objcopy --redefine-syms` applied directly to the prebuilt .a (a binary rename, not a recompile -- the
 * library's actual machine code is untouched) specifically to avoid colliding with this project's OWN,
 * differently-shaped `randomx_*` symbols already in the same xmrig binary (see
 * [[critical-vendored-lib-symbol-collision]]) -- confirmed via `nm` that the rename left every other
 * symbol (rx_blake2b* in THIS project's engine vs randomx_blake2b* in RandomY's, already non-colliding)
 * alone, and re-verified the renamed library still reproduces the real RandomX README test vector
 * (key="test key 000", input="This is a test" -> 0e9ab13e4b337c866e17445621be8d180c0a18a325932078dc33f7ac69ff17e8,
 * RandomY's own value, confirmed against its real randomy_test.go) after renaming.
 *
 * Only the handful of functions this project's own wrapper (xcb_randomy.cpp) actually calls are declared
 * here -- cache-only (light) mode only, no dataset/FULL_MEM (see xcb_randomy.cpp for why).
 */

#ifndef XMRIG_XCB_RANDOMY_UPSTREAM_H
#define XMRIG_XCB_RANDOMY_UPSTREAM_H

#include <cstddef>
#include <cstdint>

extern "C" {

struct xcbrndy_randomx_cache;
struct xcbrndy_randomx_vm;

typedef int xcbrndy_randomx_flags;
#define XCBRNDY_RANDOMX_FLAG_DEFAULT 0

xcbrndy_randomx_cache *xcbrndy_randomx_alloc_cache(xcbrndy_randomx_flags flags);
void xcbrndy_randomx_init_cache(xcbrndy_randomx_cache *cache, const void *key, size_t keySize);
void xcbrndy_randomx_release_cache(xcbrndy_randomx_cache *cache);

xcbrndy_randomx_vm *xcbrndy_randomx_create_vm(xcbrndy_randomx_flags flags, xcbrndy_randomx_cache *cache, void *dataset);
void xcbrndy_randomx_destroy_vm(xcbrndy_randomx_vm *machine);

void xcbrndy_randomx_calculate_hash(xcbrndy_randomx_vm *machine, const void *input, size_t inputSize, void *output);

} /* extern "C" */

#endif /* XMRIG_XCB_RANDOMY_UPSTREAM_H */
