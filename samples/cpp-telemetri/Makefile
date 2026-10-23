# Without CMake: make test
CXX ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Wpedantic -g -O0
SRC := $(filter-out src/main.cpp,$(wildcard src/*.cpp))
TESTS := $(wildcard tests/*.cpp)

all: build/telemetri_demo build/telemetri_tests

build/telemetri_demo: $(SRC) src/main.cpp $(wildcard include/telemetri/*.hpp)
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude $(SRC) src/main.cpp -o $@

build/telemetri_tests: $(SRC) $(TESTS) $(wildcard include/telemetri/*.hpp) tests/mini_test.hpp
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Itests $(SRC) $(TESTS) -o $@

test: build/telemetri_tests
	./build/telemetri_tests

clean:
	rm -rf build

.PHONY: all test clean
