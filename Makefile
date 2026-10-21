# Ringtrue: one C++ core, built natively (command line + tests) and as WebAssembly (the site).
CXX      ?= g++
WARN     := -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wsign-conversion -Wold-style-cast -Werror
CXXFLAGS := -std=c++20 -O2 $(WARN) -fno-exceptions -fno-rtti
SAN      := -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all
CORE     := core/bar.cpp core/tune.cpp core/advise.cpp core/spectrum.cpp core/api.cpp
HEADERS  := $(wildcard core/*.hpp)
WASMFLAGS := --target=wasm32 -std=c++20 -O3 -nostdlib -ffreestanding -fno-exceptions -fno-rtti -mbulk-memory $(WARN) \
             -Wl,--no-entry -Wl,--initial-memory=33554432 -Wl,--max-memory=33554432 \
             -Wl,-z,stack-size=524288 -Wl,--strip-all

.PHONY: all wasm cli test test-core test-web lint clean

all: wasm cli

wasm: site/assets/ringtrue.wasm

site/assets/ringtrue.wasm: $(CORE) core/wasm.cpp $(HEADERS)
	clang++ $(WASMFLAGS) -o $@ $(CORE) core/wasm.cpp

cli: build/ringtrue

build/ringtrue: $(CORE) cli/ringtrue.cpp $(HEADERS)
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Icore -o $@ $(CORE) cli/ringtrue.cpp

build/core_test: $(CORE) tests/core_test.cpp $(HEADERS)
	@mkdir -p build
	$(CXX) -std=c++20 $(WARN) -fno-exceptions -fno-rtti $(SAN) -Icore -o $@ $(CORE) tests/core_test.cpp -lm

test-core: build/core_test
	./build/core_test

# Index arithmetic stays far below 2^31 (at most a few thousand), so widening checks are off.
lint:
	clang-tidy $(CORE) core/wasm.cpp cli/ringtrue.cpp -warnings-as-errors='*' \
	  -checks='-*,bugprone-*,cert-*,clang-analyzer-*,performance-*,-bugprone-easily-swappable-parameters,-cert-err33-c,-bugprone-narrowing-conversions,-bugprone-implicit-widening-of-multiplication-result' \
	  -- -std=c++20 -Icore

test-web: wasm cli
	node --test --test-concurrency=1 tests/web/*.test.mjs

test: test-core test-web

clean:
	rm -rf build site/assets/ringtrue.wasm
