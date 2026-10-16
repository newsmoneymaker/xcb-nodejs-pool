# xcb_randomy: RandomY (Core Blockchain / XCB) share validation helper of the XCB pool. See
# xcb_randomy.cpp/main.cpp and xcb-project.md. Links against the real, vendored, symbol-renamed
# go-randomy/librandomx prebuilt static library (lib/librandomy_xcb.a) -- Linux x86_64 only.
CXX ?= g++

CXXFLAGS = -O2 -std=c++17

xcb_randomy: main.o xcb_randomy.o
	$(CXX) -O2 -o $@ main.o xcb_randomy.o -Llib -l:librandomy_xcb.a -lcrypto -lstdc++ -lm -lpthread

main.o: main.cpp xcb_randomy.h
	$(CXX) $(CXXFLAGS) -c -o $@ $<

xcb_randomy.o: xcb_randomy.cpp xcb_randomy.h xcb_randomy_upstream.h
	$(CXX) $(CXXFLAGS) -c -o $@ $<

clean:
	rm -f xcb_randomy main.o xcb_randomy.o
