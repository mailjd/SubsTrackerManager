# Table save regression suite (3.3.18)

## Scope

Tests run the **production API router and data modules**, not replacement save
functions. A local server binds `127.0.0.1` with file-backed KV and SQLite D1
adapters. They are not a live Cloudflare Workers / KV consistency benchmark.
The local test endpoints and injected credentials exist only in this test server;
none are added to the production router.

The browser suite uses the actual admin HTML and native Chromium DOM events. In
this runner browser navigation is restricted, so it uses `about:blank`,
`set_content`, in-memory Web Storage adapters and an async loopback fetch bridge.
Only styling utilities for interaction tests are substituted. No browser policy
is disabled. These tests do not validate CDN styling or native OS clipboard APIs.
They do validate the app's paste event handler, actual save-button events,
backend requests, disk data, failed acknowledgements and fresh page/process reads.

## Reproduce

Node 22.13+ and Python 3 are needed for the disk/API suite. The optional browser
suite additionally needs Python Playwright and an installed Chromium executable.
`CHROMIUM_PATH` selects that executable (default `/usr/bin/chromium`).

From the project directory:

```sh
node --test tests/regression/contract.node.mjs
python tests/regression/api-regression.py . /tmp/subs-api-regression
python tests/regression/browser-regression.py . /tmp/subs-browser-regression
```

Use a new output directory for each run. The tests only modify that output
folder and synthetic local fixtures; they do not deploy anything.

The existing Workers Vitest suite remains in place, with extra API regression
cases added to `tests/api/subscriptions-table-edit.test.js`. With dependencies
installed run `npm run lint`, `npm run test:table-contract`, and `npm test`.
The release environment could not install dependencies (npm registry DNS
`EAI_AGAIN`); therefore full Vitest and full project TypeScript checks are **not
claimed as passed**. The checked-in `results/` contains the tests actually run.

## Important invariant

`storageVerified` cannot mean only “the updater output equals the snapshot”.
Every submitted editable field must equal its **normalized input intent** before
writing, after reading storage, and in the browser's acknowledgement check.
Business-rule conflicts return a failure without clearing the pending draft.
A multi-row save is not a transaction: successful rows are cleared; rejected rows
stay pending. A rule-store write/readback failure after a subscription write is
reported as unconfirmed, not rolled back or falsely marked successful.

The existing calendar overflow / end-of-month policy is unchanged by this fix.
Automatic expiry recalculation is tested independently from implicit renewal.
