# Input repeat comparison and selected-image reset

The overview compares the exact selected input formula with the chosen order quantity. It excludes reserve percentage, uses the existing metre/centimetre conversions and does not round away a shortage. Unconfirmed dimension or pattern premises remain a separate notice; their saved values and the strict construction assessment are unchanged. Explicit unsupported patterns, reapplying repeat to already adjusted active rows, unfinished input and invalid values do not receive a sufficient result. Rows all OFF use their original lengths even with an old pattern-mode flag. None of these warnings becomes an output gate.

The provided shape has 2.7m × 62 with 64.1cm repeat ON, 0.6m × 4 OFF and 0.7m × 7 OFF. Its input requirement is 206.01m; 15% reserve recommends 237m. Ordering 206m is 0.01m short; 206.01m is equal. This is arithmetic on inputs, not a construction guarantee.

Manual full reset clears selected upload previews and the native file input only after the existing locked, read-back-verified workspace save. Cancel, save failure and conflicts retain the current state. Conversion, upload/analysis and unfinished editor input remain protected. An images-only reset preserves an existing useful undo instead of replacing it with an empty snapshot. A successful reset from the memo-image tab stays there with its reset-undo control visible. Reset undo and the separate previous-draft swap slot remain independent. Automatic 24/48-hour display housekeeping keeps the next input/list/photo-selection policy.

Reset undo restores result edits, result photo/job references, site names and the list. Unsent selected-file previews have never been persisted and are not restored after reload. Cloud photos, history, notification state and backend processing are not deleted or changed.

## Reproduction and isolation

- `product-comparison.test.ts`: exact mixed/all-ON/all-OFF arithmetic, boundaries, invalid input, unsupported and already-adjusted conditions.
- `repeat-reset-flow-browser.cjs`: separate temporary browser contexts, service workers blocked, synthetic identity and intercepted APIs installed before navigation. Explicit production and LINE mutation probes are aborted by interception. The supplied JPEG may be previewed locally with `SOKUPA_MEMO_TEST_IMAGE`; the returned six-product payload is human-transcribed synthetic data, not OCR. No production history is created.
- Numerical, quantity-policy, repeat-controls, result-reset, full-reset-edges, workspace, single-archive and rescue-generation browser suites cover normal/basic views, 320/390px, output, saved input, reset failure, one-slot recovery, timed recovery and competing operations.
- `gemini-image-once.mjs --dry-run IMAGE PRIVATE_OUTPUT` prepares a provider-only request with no credentials or network. The separately gated `--execute-once` mode uses only the existing single Vercel Google variable through an anonymous pipe, one exact Google endpoint, an exclusive attempt marker, no retries and no app server/database/Storage/LINE imports. Never execute against production app routes to bypass isolation. A response of unknown outcome requires inspection, never blind repetition.

Physical iPhone/PWA/keyboard/Clipboard behavior and any real provider test are separate from these synthetic browser results. Publication requires a reviewed fixed candidate and separate authorization.

The first isolated real OCR trial returned HTTP200 but `MAX_TOKENS` at the test-only8192-token cap (2039 input,7860 thinking,318 candidate tokens). It is incomplete, not a passed OCR/E2E test. Its private response was retained and no automatic retry was made. Increasing the cap or making another paid call requires an explicit follow-up decision; production generation settings were not changed. The complete80-check local image flow used the independently transcribed fixture, not that partial response.
