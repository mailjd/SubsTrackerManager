## v3.3.26

`old-version-integration.py` now uses the local Node SQLite bridge rather than Python `_sqlite3`. All original cross-version assertions remain. Pass `--baseline-dir` containing the real old `18/` and `19/` source trees, and a fresh `--out` directory. Use `tests/runtime/no-sqlite-python.py` to run with Python SQLite explicitly disabled. This only tests synthetic local storage; never point it at production.

# v3.3.20 safe-upgrade tests

Run `node --test tests/upgrade/*.test.mjs` with Node22.13+. These 56 tests use synthetic KV/SQLite and a strict fake Cloudflare REST transport; the CLI and gate are real, but no production network/deployment happens. Production16-minute draining is advanced only in the isolated fake-transport test clock, not configurable away in production.

Cross-version integration: see VERIFICATION_3.3.20.md for `old-version-integration.py`. It requires separate extracted18/19 releases and refuses an existing output directory. Results from the actual final run are in `tests/results/3.3.20/`.

The main Workers Vitest suite remains mandatory in CI and is not replaced by these local tests.
