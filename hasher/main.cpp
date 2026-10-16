// xcb_randomy: share validation helper of the XCB pool.
// "RandomY" (Core Blockchain / XCB) -- real go-randomy/librandomx prebuilt library, symbol-renamed
// (xcbrndy_* prefix, via objcopy --redefine-syms on the .a itself, NOT a recompile) to keep this helper
// self-contained. Fixed, never-rotated dataset key ASCII "56789". Hash input is
// SHA3-512(sealhash(32 bytes) || nonce(8 bytes, little-endian)) fed into RandomX -- see xcb_randomy.cpp
// and xcb-project.md for the full derivation and the real end-to-end cross-check performed against a
// live Go program linked against the SAME real go-randomy module.
//
// Reads commands on stdin, writes answers on stdout (one line each), same shape as vrsc-nodejs-pool's
// own hasher/verushash.cpp:
//   H <id> <hex>   exactly 80 hex chars (40 bytes): sealhash(32 bytes) || nonce(8 bytes, little-endian --
//                  this pool's pool.js is responsible for getting that byte order right, see
//                  blockBuilder.js); answers "H <id> <64 hex>" (32 byte hash) or "H <id> err"
//   Q              quit
// Command line: --hash <hex> prints the hash, --selftest runs xcb_randomy::selfTest() and exits 0/1.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <vector>

#include "xcb_randomy.h"

static int hexval(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int from_hex(const char *s, std::vector<unsigned char> &out)
{
    size_t n = strlen(s);
    if (n % 2) return -1;
    out.resize(n / 2);
    for (size_t i = 0; i < out.size(); i++) {
        int a = hexval(s[2 * i]), b = hexval(s[2 * i + 1]);
        if (a < 0 || b < 0) return -1;
        out[i] = (unsigned char)(a * 16 + b);
    }
    return 0;
}

static void to_hex(const unsigned char *in, size_t n, char *out)
{
    static const char d[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) { out[2 * i] = d[in[i] >> 4]; out[2 * i + 1] = d[in[i] & 15]; }
    out[2 * n] = 0;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "--selftest") == 0) {
        bool ok = xcb_randomy::selfTest();
        puts(ok ? "PASS" : "FAIL");
        return ok ? 0 : 1;
    }

    void *vm = xcb_randomy::createVm();
    if (!vm) {
        fprintf(stderr, "xcb_randomy: failed to create VM\n");
        return 1;
    }

    unsigned char hash[32];
    char hex[65];
    std::vector<unsigned char> data;

    if (argc == 3 && strcmp(argv[1], "--hash") == 0) {
        if (from_hex(argv[2], data) || data.size() != 40) { fprintf(stderr, "bad hex (need 40 bytes)\n"); return 1; }
        xcb_randomy::hash(vm, data.data(), hash);
        to_hex(hash, 32, hex);
        puts(hex);
        return 0;
    }

    char line[256];
    while (fgets(line, sizeof(line), stdin)) {
        if (line[0] == 'Q') break;
        if (line[0] != 'H') continue;
        char id[64], hexdata[200];
        if (sscanf(line, "H %63s %199s", id, hexdata) != 2 || from_hex(hexdata, data) || data.size() != 40) {
            printf("H %s err\n", (strlen(line) > 2) ? id : "0");
            fflush(stdout);
            continue;
        }
        xcb_randomy::hash(vm, data.data(), hash);
        to_hex(hash, 32, hex);
        printf("H %s %s\n", id, hex);
        fflush(stdout);
    }

    xcb_randomy::destroyVm(vm);
    return 0;
}
