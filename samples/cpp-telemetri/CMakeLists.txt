cmake_minimum_required(VERSION 3.16)
project(telemetri LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON) # compile_commands.json for Kurultay / clangd

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Debug)
endif()

option(TELEMETRI_SANITIZE "AddressSanitizer + UBSan in Debug builds" ON)

file(GLOB TELEMETRI_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp)
list(REMOVE_ITEM TELEMETRI_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/src/main.cpp)
add_library(telemetri STATIC ${TELEMETRI_SOURCES})
target_include_directories(telemetri PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

if(MSVC)
  target_compile_options(telemetri PUBLIC /W4 /utf-8)
else()
  target_compile_options(telemetri PUBLIC -Wall -Wextra -Wpedantic)
  if(TELEMETRI_SANITIZE AND CMAKE_BUILD_TYPE STREQUAL "Debug" AND NOT WIN32)
    target_compile_options(telemetri PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(telemetri PUBLIC -fsanitize=address,undefined)
  endif()
endif()

add_executable(telemetri_demo src/main.cpp)
target_link_libraries(telemetri_demo PRIVATE telemetri)

enable_testing()
file(GLOB TELEMETRI_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/tests/*.cpp)
add_executable(telemetri_tests ${TELEMETRI_TESTS})
target_link_libraries(telemetri_tests PRIVATE telemetri)
target_include_directories(telemetri_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
add_test(NAME telemetri_tests COMMAND telemetri_tests)
set_tests_properties(telemetri_tests PROPERTIES TIMEOUT 120) # a hang must fail, not block the run
