# Sample projects and task suites

Two medium-sized projects with **deliberate bugs** for trying Kurultay with your own models:

| Project | Language / build | Bugs | Features | Task list |
|---|---|---|---|---|
| [java-envanter](java-envanter/) | Java 8, dependency-free `tools/Build.java` (a JDK is enough) | 8 | 2 | [GOREVLER.md](java-envanter/GOREVLER.md) (Turkish) |
| [cpp-telemetri](cpp-telemetri/) | C++17, CMake + CTest, ASan/UBSan | 8 | 2 | [GOREVLER.md](cpp-telemetri/GOREVLER.md) (Turkish) |

The existing tests pass in both projects; the bugs sit on untested paths. The tasks are written like user bug reports.

## Trying it by hand

```bash
cd samples/java-envanter        # or samples/cpp-telemetri
kurultay                        # console; workspace = this folder
```

The `kurultay.config.json` of each project only holds the build/test commands; the endpoint, API key and models come from
your `~/.kurultay/config.json`. Undo the changes with `/rewind` or `git checkout samples/`.

## Measured runs (hidden tests)

The suites under `evals/` run every task on a **clean copy** of the project, add the hidden tests when the agent is done
and report the result per mode (pass rate, requests, tokens, time):

```bash
kurultay eval samples/evals/java-envanter --modes single,race,council --out eval-result
kurultay eval samples/evals/cpp-telemetri --tasks C2-crc,C4-eksik-cerceve --repeat 3
kurultay eval samples/evals/cpp-telemetri --validate   # the base project must fail, the reference solution must pass
```

Hidden tests live in `evals/<suite>/hidden/<task>/`, reference solutions in `evals/<suite>/solutions/<task>/` – the agents never see them.
CI checks on every change that both suites are valid (`--validate`).
