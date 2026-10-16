# The C++ half of the planner: Sleipnir and our problem on top of it. Built by
# build.rs through the cmake crate; nothing here is meant to be built by hand.
cmake_minimum_required(VERSION 3.21)
project(AresNlp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

include(FetchContent)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
# Diagnostics need <print>, which GCC 13 does not have; we report through Rust.
set(SLEIPNIR_DISABLE_DIAGNOSTICS ON CACHE BOOL "" FORCE)
FetchContent_Declare(
    Sleipnir
    GIT_REPOSITORY https://github.com/SleipnirGroup/Sleipnir
    GIT_TAG v0.6.6
    GIT_SHALLOW ON
    SYSTEM
)
FetchContent_MakeAvailable(Sleipnir)

add_library(ares_nlp STATIC nlp/ares_nlp.cpp)
target_include_directories(ares_nlp PUBLIC nlp)
target_link_libraries(ares_nlp PRIVATE Sleipnir::Sleipnir)
if(MSVC)
    target_compile_options(ares_nlp PRIVATE /EHsc /utf-8)
endif()

install(TARGETS ares_nlp ARCHIVE DESTINATION lib)
