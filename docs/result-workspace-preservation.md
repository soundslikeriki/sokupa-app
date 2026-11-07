# Result workspace: feature preservation

Baseline: `67742d9cbc21e55eaee61ba944a1c2647f7a8077`. This is a local UI change; publication requires a separate decision.

## Navigation

- The top-right menu selects existing functions. Memo measurement is the image/dimensions panel. Actual-dimension measurement is explicitly labelled as the existing square-metre calculator, not a new length/width measuring tool. The order list is the existing accumulated order draft.
- The memo result has three views: quantity (default), editing/repeat for one selected product, and original photos.
- Result views and main modes hide panels without remounting the editor or previously mounted calculators. The displayed result job remains the source of private photos, independent of a newer accepted job or upload preview.
- Navigation intent is captured before input blur, including non-focusing buttons with null/ancestor focus targets. Pointer cancellation clears it; completed gestures expire it after the focus handoff. Explicit Enter/cancel and intentional non-navigation blur keep their existing meaning.
- Result tabs add same-document view history. Browser Back restores that view; in-app return and Escape go to quantity. Existing main-mode selection remains a view switch, not a new route. A page reload starts at quantity and uses existing saved-workspace recovery.

## Preserved capabilities

| Existing capability | Location / verification |
| --- | --- |
| Multiple memo images, HEIC conversion, new analysis, background progress | Optional image/site section; ongoing/error states remain outside it. Integrated and legacy/job-recovery browser suites. |
| Saved history, paging, archived/deferred results, export/restore choices | Common history disclosure and recovery cards, available across main modes. Deferred-result and upgrade suites. |
| Latest result, original result, raw blank/invalid values, storage-conflict protection | Same workspace keys, schema, locks and snapshot code. Upgrade/basic-fallback suites. |
| Per-row and master repeat, distinct source heights, manual order and loss/allowance settings | Selected product editor; unchanged calculation functions and fingerprints. Simple-order, quantity-first and new workspace suites. |
| New-row draft, explicitly added rows, product-code draft | Same mounted editor and state maps. Navigation is excluded from accidental blur commits. New workspace suite. |
| Original row/product resets, details collapse and product metadata | Existing selected-product controls remain. Simple-order suite and source review. |
| Manufacturer grouping | Existing grouped product cards and grouped product selector remain. |
| Correction/source review, final-quantity confirmation | Existing fingerprints and guards remain. Reading-review and quantity-first suites. |
| Copy, individual/all draft transfer, final quantity without double allowance | Existing handlers and readiness guards. Simple-order/quantity-first suites. |
| Order-draft manual fields, duplicate merge/separate/cancel and queue | Same mounted OrderDraftList and HomePageClient state. New workspace suite plus existing unit tests. |
| Area inputs, width mode, allowance and product lookup | Existing AreaCalculator remains mounted after first use. Navigation never initiates a lookup. New workspace suite. |
| Private source photos, explicit unavailable/retry states | Existing owner-protected endpoints. Metadata/image errors and invalid indices do not substitute another photo. New photo-boundary/workspace suites. |
| Automatic LINE order list and idempotent retries | `67742d9` notification builder retained without modification. Unit tests; no real LINE send in verification. |
| Sign-in, invite/admin rules, API/Storage boundaries, background scheduling | No changes to routes, authentication, DB schema/policies, keys or scheduler. Existing source and unit checks remain applicable. |

## Verification limits

All new browser cases use synthetic data and local builds, blocking external requests. Desktop Chrome at 320/390px and landscape sizes verifies layout, focus, and a simulated keyboard viewport. It does not prove physical iPhone Safari/PWA chrome or keyboard behavior. No AI/provider request, real LINE send, production DB change, Git push or deployment belongs to this work.

Preserve the current secure production version as the rollback target. Do not restore the old insecure legacy release. Main publication automatically deploys, so review and explicit publication authorization precede any push.
