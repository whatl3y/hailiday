# Economics: unit economics and capacity

This specification is the single home for Hailiday's money and load arithmetic: how a visit turns into cost and, through Shop the look, into affiliate revenue; the dated worksheet of unit prices behind every figure; the business decision rules that choose a lever once the pilot has measured the real rates; the revenue experiments that run alongside affiliate commerce; the guest allowance values; and the capacity and spend-ceiling values the platform enforces. Every dollar figure here is an illustration computed at list prices, not a vendor or merchant quote; pilot measurements replace the assumptions.

**Owns:** unit economics model; dated cost worksheet; revenue assumptions; sensitivity; business decision rules (D-27); revenue experiments; guest allowance and abuse limit values (D-12); capacity, admission-control and spend-ceiling values; seasonality of demand.
**Baseline:** planning baseline 2026-11-09; external facts retrieved 2026-11-08.

## Unit economics model

The model prices one visit to the landing page. A visitor may take the address path or the upload path, may or may not complete a preview, may create several accepted variants, may click to shop and may buy. Revenue is affiliate commission (D-05, [decisions](../decisions.md#d-05)); cost is what Google, the image-edit provider, the vision model, safety vendors, storage and email charge for that visit. The result is a variable contribution per visitor. Fixed costs (hosting, database, error tracking, content production, human review time in the pilot) are budgeted separately and are not in the per-visitor model. The model carries no paid acquisition cost; if paid acquisition is ever used, it is added per visitor.

### Symbols and defaults

| Symbol | Meaning | Illustration default | Measured from |
| --- | --- | --- | --- |
| c | Completion rate: share of visitors whose session reaches at least one accepted variant | 0.60 | `render_succeeded` owners / `landing_viewed` sessions |
| a | Address-path share: share of visitors who select or type an address, whether or not a render follows | 0.70 | `address_selected` + `address_manual_submitted` / `landing_viewed` |
| g | Google cost per address-path visitor, from the first suggestion request to the last candidate image, including visitors who abandon or receive `skip_to_upload` | $0.05 typical, $0.09 worst case | `usage_ledger` entries with a Google SKU |
| V | Accepted variants per completing visitor (bounded above by the allowance in D-12) | 1 (sensitivity at 2 and 3) | accepted variants / completing owners |
| n | Paid render attempts per accepted variant (initial attempt plus repair, plus attempts in jobs that failed and were retried by the user) | 1.2 | `render_attempts` / variants that reached `succeeded` |
| e | Cost per paid render attempt (image edit plus amortized vision calls) | $0.17 (pre-build estimate, kept for comparability; the first measured live configurations are in [Measured live costs](#measured-live-costs)) | ledger, per attempt |
| u | Cost per accepted variant, u = n × e | $0.20 (same) | derived |
| s | Storage, delivery and email per accepted variant | about $0.01 (estimate) | host invoices, allocated |
| w | Uploads per visitor (upload path, plus the user's own photo in the interim address experience, D-16) | measured; not in the canonical illustration | `upload_accepted` / `landing_viewed` |
| q | Content-admission cost per screened upload | not yet priced (see the worksheet) | ledger, per screening job |
| k | Shop click rate among completers who saw Shop the look | 0.25 | `product_clicked` owners / `shop_panel_viewed` owners |
| p | Attributed purchase rate among clickers | 0.04 | `affiliate_conversions` / `affiliate_clicks` (commerce spec) |
| B | Eligible basket: commissionable order value per purchase | $120 | merchant reports |
| r | Effective commission rate after reversals | 0.03 (0.04 as the upside case) | merchant reports |

### Formulas

```text
revenue per visitor         R = c × k × p × B × r
variable cost per visitor   C = a × g  +  c × V × (n × e + s)  +  w × q
contribution per visitor    M = R − C
```

Three properties of the cost formula matter for how it is read:

1. The Google term `a × g` is spent before any render and is incurred by every address-path visitor, including those who abandon the autocomplete session (billed per request), receive no usable imagery, or are routed to `skip_to_upload`. It is a sunk cost of the address path, not a cost of rendering.
2. The render term scales with accepted variants per completing visitor, V. Because every variant starts from the original source and there is no cheaper partial edit ([render pipeline](render-pipeline.md#variant-key-and-reuse)), a holiday, style or lighting change costs a full attempt unless the variant key already has an accepted variant (cached, free). V is the largest single cost lever and the first pilot metric.
3. Attempts per accepted variant, n, folds in repair attempts and user retries after failures. A cheaper image-edit tier that fails the quality checks more often raises n and can cost more per accepted variant than a dearer tier; tiers are compared on u, never on the per-image price alone ([quality spec](quality-and-benchmark.md#provider-comparison)).

### Canonical illustration

With the defaults above and V = 1:

```text
R = 0.60 × 0.25 × 0.04 × $120 × 0.03 = $0.0216 per visitor   ($0.0288 at a 4% commission)
C = 0.70 × $0.05 + 0.60 × 1 × $0.20   = $0.155  per visitor   (V = 1)
                                       = $0.275  per visitor   (V = 2)
                                       = $0.395  per visitor   (V = 3)
```

The canonical C omits the storage, delivery and screening items (about $0.01 to $0.02 per accepted variant; worksheet below) so that the figure stays comparable across documents. It also keeps the pre-build unit estimates (e = $0.17, u = $0.20) for the same reason; the first measured live configurations cost less per attempt but have a different shape, with vision costing more than the edit, and the conclusion below holds for them too ([Measured live costs](#measured-live-costs)). Affiliate commission alone does not cover generation cost under these assumptions; the pilot measures the real rates and the [decision rules](#decision-rules) choose the lever. The same figures appear in the product plan ([PLAN §9](../PLAN.md#9-commerce-and-business-model)) as a summary; this section is their home.

### Contribution per path

The blended formula hides three different cost shapes. Report contribution per path as well as pooled.

| Path | Google cost | Pre-render cost | Render cost | Notes |
| --- | --- | --- | --- | --- |
| Address with `street_view_ai` at `live_public` (Journey A) | g per path visitor (suggestions, Place Details, Geocoding, SearchDestinations, Static display loads: typically 2, or 3 for an address on the road, at most 6 per address) | none | u per accepted variant, plus one Static fetch ($0.007) per render job in `transient` mode (the worker refetches the panorama for each job; in `persist` mode the fetch happens once per source asset, reserved and settled on the first render, and later looks on the stored frame carry none) | Source modes: [address spec](address-and-street-view.md#street-view-source-modes). Under the default `full` use policy (owner decision 2026-11-10, D-15) `commerceAdjacent` is allowed, so Shop the look appears on these screens and k applies; under `decorate` and `display_only` it is hidden and k is removed for this path. |
| Interim address path (Journey A′, D-16; `STREET_VIEW_USE_POLICY=display_only`, or contributor imagery under `STREET_VIEW_CONTRIBUTOR_IMAGERY=display_only`) | g per path visitor (the Street View image is shown for confirmation only) | q per screened upload | u per accepted variant | Pays the full Google cost and the full upload cost; completion is likely lower because a photo step is added. Measure c separately for this path. |
| Upload (Journey B) | none | q per screened upload | u per accepted variant | The cheapest path per completer; the only path whose live rendering needs no Street View licensing ([architecture](../architecture.md#external-integrations-and-fixture-modes)). |

At the defaults and V = 1, a Journey A visitor costs about $0.05 + 0.60 × $0.207 ≈ $0.17; a Journey A′ visitor about $0.05 + q + 0.60 × $0.20 ≈ $0.17 + q; a Journey B visitor about q + 0.60 × $0.20 ≈ $0.12 + q. The address-path share a therefore shifts cost per visitor even when nothing else changes, and the upload path's lower cost is not a reason to steer people to it: the address path is the product's promise (D-03, D-06).

### Costing rules

- **List prices, always.** Compute every figure at list prices even while usage sits inside a free tier. Each Google SKU Hailiday uses gives 10,000 free calls per month ([pricing](https://developers.google.com/maps/billing-and-pricing/pricing), retrieved 2026-11-08), so pilot volumes would otherwise report the address path as nearly free and understate its cost by the whole of g. The ledger stores the list unit price at the time of the call (`unitPriceMicros`, USD micros, because provider SKUs are sub-cent; [render pipeline](render-pipeline.md#cost-recording)); invoice reconciliation is an operations task, not an input to the model.
- **Include unsuccessful sessions.** Abandoned autocomplete sessions, discoveries ending in `skip_to_upload`, declined uploads and failed jobs all cost money and all count in C.
- **Dimensions.** Report R, C and M per holiday, scene type, source kind (`street_view`, `upload`), acquisition channel and merchant program ([analytics events](data-and-api.md#analytics-events); [click tracking](commerce.md#click-tracking-and-attribution)).
- **Variants, not previews.** The cost unit is the accepted variant; "preview" is the user-facing word for the same thing ([glossary](../glossary.md#rendering-terms)). There is one cost-per-accepted-variant figure, u, and other documents link to it rather than restating it.

## Cost worksheet

List prices retrieved 2026-11-08 unless a row says otherwise. Claude prices come from Anthropic's model table (cached 2026-10-06; https://platform.claude.com/docs). Re-verify every row at Gate A (provider decision), before Gate C, and whenever a vendor announces a price change; model names reflect vendor pages on the retrieval date and may be superseded. Research documents hold the surrounding terms: [Google pricing](../research/address-and-imagery.md#pricing), [image-AI pricing](../research/image-ai-providers.md#pricing).

### Google Maps Platform (address path)

| Item | SKU | List price | Free per month | Units per address-path visitor (typical / worst) | Cost (typical / worst) | Source | Re-verify trigger |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Autocomplete suggestions | Autocomplete Requests | $2.83 per 1,000 (first 12 requests per session billed when the session ends with Place Details Essentials; abandoned sessions bill every request) | 10,000 | 7 / 12 | $0.020 / $0.034 | [session pricing](https://developers.google.com/maps/documentation/places/web-service/session-pricing), [pricing](https://developers.google.com/maps/billing-and-pricing/pricing) | Gate A; price-list change |
| Session termination | Place Details (New) Essentials | $5.00 per 1,000 (never IDs-only, which bills every autocomplete request; never Pro at $17.00 or Enterprise + Atmosphere at $25.00 per 1,000) | 10,000 | 1 / 1 | $0.005 / $0.005 | same | same |
| Precision and manual entry | Geocoding | $5.00 per 1,000 | 10,000 | 1 / 1 | $0.005 / $0.005 | [pricing](https://developers.google.com/maps/billing-and-pricing/pricing) | same |
| Building outline and entrances (D-39) | Geocoding v4 SearchDestinations (billed as Geocoding) | $5.00 per 1,000 | shared with Geocoding | 1 / 1 | $0.005 / $0.005 | [Geocoding billing](https://developers.google.com/maps/documentation/geocoding/usage-and-billing) | launch stage and price at F01 |
| Panorama search | Street View Metadata | free, no quota | unlimited | 1–5 | $0 | [pricing](https://developers.google.com/maps/billing-and-pricing/pricing) | none |
| Display loads for confirmation (candidates and nudges) | Static Street View | $7.00 per 1,000 ($5.60 above 100,000) | 10,000 | 2 (3 for an address on the road) / 6 (the per-address Static display budget: up to 3 candidates plus up to 3 nudges; a place on the road issues two at discovery) | $0.014 ($0.021 on the road) / $0.042 | same | same |
| **Total per address-path visitor (g)** | | | | | **about $0.05 / $0.09** | | |
| Worker fetch for rendering (`transient` mode: every job; `persist` mode: the first render of a source) | Static Street View | $7.00 per 1,000 | shared | 1 per render job (transient); 1 per source (persist) | $0.007 per accepted variant (transient) | same | use policy and grant terms (D-15) |
| Optional confirmation map pin (D-40, not in defaults) | Maps JavaScript or Static Maps | **Verify:** price per load before adopting (owner: engineering lead, F10) | | 0 | $0 | | D-40 |

The autocomplete client rules (3 characters, 250 ms debounce, cancel stale requests) and the server limits (requests per session token, tokens per session, the Static display budget per address) that keep a session near the typical column are owned by the [address spec](address-and-street-view.md#pre-render-spend-controls).

### Image-edit provider (per attempt)

Published per-image prices where they exist; token-based estimates marked as estimates. The provider is chosen at Gate A (D-42) on fidelity first, then cost per accepted variant.

| Candidate | Price per edited image | Basis | Source |
| --- | --- | --- | --- |
| Nano Banana 2.1 (`gemini-nano-banana-2.1`) | $0.0336 at 1K, $0.0504 at 2K | published ($30.00 per million image output tokens); the measured effective price is higher because input and thinking tokens are billed too ([Measured live costs](#measured-live-costs)) | [Gemini pricing](https://aistudio.google.com/docs/pricing) (retrieved 2026-11-09) |
| Gemini 3.1 Flash Image | $0.067 at 1K, $0.101 at 2K | published | same (retrieved 2026-11-08) |
| Gemini 3 Pro Image (Gemini API or Vertex AI) | $0.134 at 1K or 2K | published; **Verify:** Vertex AI pricing separately (owner: engineering lead) | same |
| GPT-Image-2.5 and 2.6 Sunburst and Flare | about $0.05 (medium quality) to $0.21 (high quality) at 1024×1024 | **estimate**: token-priced at $8 per million image input and $30 per million image output tokens with no per-image table; the figures are the historical GPT Image 2 per-image table (low $0.006, medium $0.053, high $0.211) and must be confirmed with a metered test at the exploratory spike (owner: engineering lead); the 2026-11-09 live runs measured far less for the 2.5 models at 1536 × 1024 (Flare `medium` about $0.025, Sunburst `high` about $0.057; [Measured live costs](#measured-live-costs)) | [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [image guide](https://developers.openai.com/api/docs/guides/image-generation) |
| MAI-Image-2.7-Preview | not verified | unverified reseller figures only | [research](../research/image-ai-providers.md#pricing) |
| Seedream 5.0 Pro | $0.045 to $0.15 (reseller quotes) | unverified | [research](../research/image-ai-providers.md#pricing) |
| FLUX 3 Image | $0.048 at 1K | published; excluded for private photos unless written terms change (training and public-display clauses) | [BFL pricing](https://bfl.ai/pricing) |
| Qwen-Image-Edit-2511 (self-hosted, Apache 2.0) | GPU hosting, not a per-image price | not priced; later option | [research](../research/image-ai-providers.md#aggregators-and-open-weights) |

Input-side and thinking tokens for the source image and instructions are not a small amount on every token-priced model: measured on 2026-11-09, Nano Banana 2.1 at 1K with thinking `minimal` cost $0.046 to $0.069 per edit, a mean of $0.050, about 50% above its output-only price. Include them in the metered test. The ledger therefore settles Nano Banana 2.1 edits from the usage tokens (prompt tokens at $0.50 per million; candidate tokens plus thinking tokens at $30 per million, because Gemini bills thinking at the output price) and uses the per-image tier price above only when a reply reports no tokens; GPT image edits settle from tokens too, with the input split at $5 per million for text and $8 for image tokens when the usage carries the split and all input at $8 otherwise. The ledger's token price table is the single source for settlement and for the model bake-off. The reservation (list price, $0.134 Gemini and $0.13 OpenAI worst case) is unchanged. The canonical illustration carries **$0.13 per edit attempt**, close to the Gemini 3 Pro Image price and between the GPT-Image medium and high estimates; it is kept for comparability, not as a measurement.

### Vision model (analysis and quality checks)

| Call | Model (D-43 default and candidates) | When | Cost per call | Basis |
| --- | --- | --- | --- | --- |
| Scene analysis | Claude Opus 5.5 ($4 / $20 per million input / output tokens), effort `medium` | once per render job | $0.041, measured 2026-11-09 ([Measured live costs](#measured-live-costs)) | the working image, instructions and a structured output |
| Quality judge | Claude Opus 5.5, effort `medium` | once per attempt | $0.035 to $0.036, measured 2026-11-09 | original, candidate and plan in; JudgeResult out |
| Escalated judging | Claude Opus 5.5 at effort `high` | only on uncertain judge results; share to measure | about $0.028, measured 2026-11-10; reserved at $0.045 per possible attempt | **Verify:** escalation share in Phase 1 (owner: engineering lead) |
| Analysis and judging on Claude Sonnet 5.5 (the cheaper D-43 candidate) | Claude Sonnet 5.5 ($2 / $10) | as above | about $0.02 per analysis and $0.018 per judge call (estimate: half the measured Opus cost at the same token counts) | to benchmark ([QA judge calibration](quality-and-benchmark.md#qa-judge-calibration)) |
| Addition localization | Claude Opus 5.5, effort `medium` | once per decorating attempt (a daylight attempt, or the base attempt and the base's repair of a relit job); none for a relight and none for a decorate attempt of a lavish plan, which keeps the whole frame ([Localizing](render-pipeline.md#localizing)) | about $0.034 and about 9 s, measured 2026-11-09 ([Measured live costs](#measured-live-costs)) | the working image and the aligned edit in; added decorations and other changes, as boxes, out |
| Upload triage | The configured vision model (the triage runs on the vision leg, `vision_analysis`; Claude Haiku 5.5 at $0.10 / $0.50 is the cheap candidate) | once per screened upload when the vision leg is live; the fixture triage costs nothing | one `vision_call` charge (stage `screening`) priced from the reported token usage, with a $0.005 fallback when a reply reports none; measure in Phase 1 | part of q |

Prompt-cache reads cost $0.20 per million tokens on Sonnet 5.5 and Opus 5.5, which makes the fixed instruction blocks cheap to repeat. The canonical illustration keeps its pre-build vision estimate, made at Sonnet 5.5 rates: per accepted variant at n = 1.2 the vision cost is $0.03 + 1.2 × $0.02 ≈ $0.054, or about $0.045 per attempt when amortized, rounded to **$0.04 per attempt**, giving **e = $0.13 + $0.04 = $0.17 per attempt** and **u = 1.2 × $0.17 ≈ $0.20 per accepted variant**. At the measured Opus 5.5 costs the vision cost is $0.041 + 1.2 × $0.036 ≈ $0.084 per accepted variant, about $0.07 per attempt, more than the provisional default's edit. Measure both calls in Phase 1 with the token-counting endpoint ([model roster](render-pipeline.md#model-roster)).

### Measured live costs

Live evidence from the 2026-11-09 model bake-off ([development](../development.md#model-bake-off)): the eight curated example photos from the licensed photo library at 1536 × 1024, live Claude Opus 5.5 analysis and judge, costs computed from the token usage each provider reported at the list prices above. It is live evidence with n = 8, neither the exploratory spike nor the formal benchmark, and never gate evidence ([exploratory spike](quality-and-benchmark.md#exploratory-spike)); it informs the provisional defaults recorded under [D-42](../decisions.md#d-42) and [D-43](../decisions.md#d-43). Re-measure at the exploratory spike's metered test.

| Item | Measured 2026-11-09 | List price (the ledger's reservation price) |
| --- | --- | --- |
| Nano Banana 2.1, 1K, thinking `minimal` | $0.046 to $0.069 per edit, mean $0.050 (input and thinking tokens add about 50% to the output-only price) | $0.0336 |
| Nano Banana 2.1, 1K, thinking `medium` | about $0.053 per edit (earlier run the same day, not judged) | $0.0336 |
| Nano Banana 2.1, 2K, thinking `medium` | about $0.069 per edit (earlier run the same day, not judged) | $0.0504 |
| GPT image 2.5 Flare, `medium` | $0.024 to $0.025 per edit | about $0.05 (estimate) |
| GPT image 2.5 Sunburst, `high` | about $0.057 per edit (earlier run the same day, before the mask fixes) | about $0.21 (estimate) |
| Claude Opus 5.5 scene analysis | $0.041 per photo (7 analyses, $0.286) | $0.042 |
| Claude Opus 5.5 QA judge | $0.035 to $0.036 per call | $0.040 |
| Claude Opus 5.5 addition localization | about $0.034 per call, about 9 s (live bungalow render: six boxes plus two other changes) | $0.040, the judge's list price |
| Claude Opus 5.5 escalated judge | about $0.028 per call (measured 2026-11-10) | $0.045 per possible attempt, above the judge so that the two reservations on the shared `checking` stage are told apart by price |
| GPT image 2.5 evening relight of the decorated daylight image (no mask) | about $0.025 with Flare at `medium` (Sunburst: [measured 2026-11-10](#measured-live-costs), $0.0225 to $0.0250) | about $0.05 (estimate) |
| GPT image 2.5 enhance edit of a Street View frame (one global edit, no mask, 1024×1024, `medium`) | about $0.022 per edit (178 text, 1,024 image and 439 output tokens: $0.0223), 19.1, 19.3 and 20.6 s on three recorded frames, 2026-11-11 | $0.13, the image edit's reservation price |
| Claude Opus 5.5 home location (framing: one image, effort `low`, a box) | about $0.003 per call, measured live on 2026-11-11; with the framed Static fetch ($0.007) about 4 to 5 s, and up to two calls and two fetches for a `road` view that is turned toward its home | $0.02 (`VISION_PRICES_MICROS.locate`, ledger stage `framing`; nothing is reserved at admission) |
| Claude Opus 5.5 enhancement judge (two images, enhance mode) | expected at the relight judge's $0.035 to $0.04; the live first address settled within that range; not yet measured on a sample | $0.040 (`VISION_PRICES_MICROS.enhancement`, ledger stage `enhancing`) |

The two live configurations, with one analysis per render job:

| Configuration | e: edit plus judge per attempt | u at n = 1.2 (n × e plus analysis) | Judge acceptance in the bake-off | Per accepted variant at that acceptance: edit and judge; with analysis |
| --- | --- | --- | --- | --- |
| GPT image 2.5 Flare `medium` with Opus 5.5 (provisional default) | $0.060 | about $0.11 | 6 of 8 | $0.080; about $0.13 |
| Nano Banana 2.1 1K `minimal` with Opus 5.5 (configured fallback) | $0.086 | about $0.14 | 3 of 7 rendered (one of 8 failed `camera_changed`) | $0.216; about $0.31 |

Live evidence from the owner stack on 2026-11-10 (GPT image 2.5 Sunburst for edits, Claude Opus 5.5 for analysis, judge and localization; the default first look of an exterior, Christmas, Abundant, Evening, which is two sequential edits). It is live evidence from single jobs, not benchmark evidence.

| Job | Cost | Time |
| --- | --- | --- |
| Evening-first exterior look (decorated base, then its relight) with a new scene analysis | $0.178 | 78 s |
| The same with a reused analysis | $0.120 | 72 s |
| Relight of an existing base | $0.041 | 29 s |
| Street View job whose base was rejected, repaired and then passed (two attempts) | $0.196 | 93 s |
| One Sunburst edit | $0.0225 to $0.0250 | 18 to 24 s for a relight edit |

A default look takes 72 to 105 s with two attempts; a third attempt (the repair of a base before its relight, or of a rejected relight) ends a job at about 125 s.

The first look of a Street View address adds the [enhancement](render-pipeline.md#enhancing) once per stored frame and compiler release: one edit and one judge call, about $0.06 (about $0.022 and $0.035 to $0.04) and about 30 s (edit 19 to 21 s, checks and storage about 2 s, judge 7 to 12 s), so the first evening look of an address costs about $0.24 against $0.178 and takes 102 to 141 s by the measured parts (155 to 166 s with a repair). The first live address on 2026-11-11 was sharpened and accepted in 26 s (edit 20 s, registration score 0.82, both corner marks adapted, judge with no finding) and its first evening look took 124 s end to end (94 to 126 s before). Later looks of the address pay and wait nothing extra. The two lines are not allowance units and not paid attempts. They are bounded by the new-address allowance (an owner's enhancements per day are at most the addresses they add, 3 by default, with one retry each).

The same first look also zooms in on the home ([framing](render-pipeline.md#framing)), once per source (a place whose looks were made before the framing is zoomed in at its next look that runs a job, so the charges below fall on that look): one low-effort vision call (the locate call, about $0.003) and one Static fetch at the framed view ($0.007), about $0.01 and about 4 to 5 s, measured live on 2026-11-11. A view from the road (heading mode `road`) that is turned toward its home first pays up to one more locate call and one more Static fetch, about $0.01 and about 4 to 5 s more (a locate call took 2.0 to 2.4 s, measured live on 2026-11-13); a view in which no single home can be settled ends the look at once and pays the calls it made. Both are recorded as direct charges at the stage `framing` with nothing reserved at admission, they are not allowance units and not paid attempts, and later looks of the source pay and wait nothing extra. A framed source that has no stored frame (`transient` mode, or a policy that does not allow storing it) also shows the framed view through the browser's display URL: that load is ledgered once per source (`framing.displayIssuedAt` records it), as one `street_view_static_display` charge ($0.007) on the stage `framing` when the framing is recorded, or on the stage `display` when the picture first falls back to the framed display URL later, each in a transaction that counts it in the property's display budget; with no room in the budget the framing is skipped, nothing is recorded and nothing is charged. The fallback load on the stage `display` is issued only while spend is allowed: under the global pause, the Street View provider's pause or a spent ceiling the picture is null, nothing is counted or charged, and a later read tries again. A source whose framing is `kept` pays the call only, except `refused_framed` (the analysis refused the framed frame), which has paid the framed fetch too and pays one more Static fetch ($0.007, stage `framing`) for the wide frame it goes back to. The look that frames a place with earlier looks also pays the new analysis of the framed frame and the new enhancement of it, because the replaced frame's enhancements are dropped and analyses are keyed by the working image: admission saw a reusable analysis and a decided enhancement of the stored frame and reserved neither, so the worker charges both directly as they are made, and the look goes on. Neither is an allowance unit or a paid attempt, and a framing refused because another job of the source is unfinished charges the calls it already made and nothing more.

**Localization and the evening relight.** A decorating attempt adds one localization call (except a lavish attempt, which makes none: today a house exterior in the default `abundant` style; it costs the edit and the judge, about 9 s and $0.034 less than the figures that follow, and the job's localization reservations are released unspent, so every job still reserves two localizations; the `abundant` look of a room, an apartment entry or a balcony localizes as any other, and so does the ordinary repair of a lavish attempt), so a daylight attempt on the provisional default costs the edit (about $0.025), the localization (about $0.034) and the judge (about $0.036), about $0.095 before the amortized analysis. An `evening` variant relights an accepted daylight variant of the same key: one relight edit (about $0.025 with Flare; $0.0225 to $0.0250 with Sunburst) plus its relight-mode judge (about $0.036), about $0.06 to $0.08, and a second attempt only for the relight's repair; it makes no localization call. With no daylight variant present the job first pays a daylight attempt (edit, localization, judge) and then the relight edit and judge, about $0.12 to $0.18 measured, and delivers two variants for one allowance unit (the companion daylight variant does not count toward the allowance). Since 2026-11-10 an exterior's default first look is `evening`, so the first look of every address auto-start is this two-step path: two sequential edits, about $0.18 and 72 to 105 s measured. A rejected base is repaired once before its relight, and a rejected relight is repaired once, each a third attempt, so a relit look that decorates its own base makes at most three edits. A lavish decorate attempt that the judge only doubts, or whose objected spots can be put back from the photograph, is delivered at once with no repair, so it makes one image edit and one judge call fewer than the same look would with a repair. A `bright` interior look is the same path on the photo's decorated base (a live bright relight measured about $0.025 at `medium`, 11 to 15 s), so a relit interior look is two edits; an already-bright photo, and an `evening` look of a photo already at dusk or night, are one edit (no relight, the other reserved edits released). Example renders reuse the daylight edit of the same photo within one run, so an evening example costs its relight only.

The worst-case reservation per job at list prices ($0.13 per edit, $0.042 per analysis, $0.040 per judge and per localization line, $0.045 per escalation line; one judge and one escalation per possible attempt) is:

| Job | Analysis, edits, judges, escalations, localizations | With a new analysis | With a reusable analysis |
| --- | --- | --- | --- |
| Daylight (`source`) | 1, 2, 2, 2, 2 | $0.552 | $0.510 |
| `evening` or `bright` that relights an accepted daylight variant (the worker's shape) | 1, 2, 2, 2, 0 | $0.472 | $0.430 |
| `evening` or `bright` without a base | 1, 3, 3, 3, 2 | $0.767 | $0.725 |

A Street View source in `persist` mode with the enhancement on and no decided enhancement for its stored frame and the current compiler version adds two lines (an edit at $0.13 and a judge call at $0.040, ledger stage `enhancing`), $0.17 in all: $0.722 and $0.680 for a daylight job, $0.642 and $0.600 for a relight of an accepted daylight variant, and $0.937 and $0.895 for a relit job without a base; with a Static fetch the last figure is $0.944 (new analysis).

`POST /v1/renders` cannot see the worker's working-image checksum, so it always reserves the without-base shape for a relit look; the unused lines are released at the end. A Street View render that will fetch pixels adds a $0.007 fetch line (a transient source, a persist source with no stored frame, or one whose stored frame is older than `STREET_VIEW_FRAME_MAX_AGE_DAYS`, default 30). Such a render also keeps its analysis line even when an analysis exists, because a fetched frame may carry other bytes; the worker releases the line when it reuses the analysis. A Gemini edit reserves $0.134 instead of $0.13. A settlement uses the reported usage and can exceed a line's list price, as it does for the judge; the reservations count toward the service-wide and per-SKU [spend ceilings](#spend-ceilings).

The enhancement's lines are settled from usage like any other and released when the worker reuses or skips the enhancement, so they appear in the ceilings and the worst case but only about $0.06 of them is ever spent per first look. The look that frames a place with earlier looks is the exception: it reserves no enhancement lines, because the stored frame had a decided enhancement at admission, and the worker charges its enhancement directly. Admission counts 2 of the owner's daily paid attempts per job, relit looks included: the first attempt and its repair or relight must both fit. The worker checks the cap again (projecting one more attempt) before each further attempt, which is where a relit look's third attempt is checked. With the production cap of 8 a third relit look is admitted after two relit looks used three attempts each (6 of 8), and it may then be delivered without its repair or relight if the cap is reached.

At the plan's n = 1.2 both configurations sit below the canonical u = $0.20, but n is unmeasured at scale and the bake-off acceptance rates are the current best evidence, not benchmark evidence. At those rates the Nano Banana configuration is above the [cost ceiling](#cost-ceiling-for-provider-selection) of $0.25 and Flare is well inside it. The structural conclusion is unchanged: with these configurations C at V = 1 is about $0.10 (Flare at n = 1.2) to $0.22 (Nano Banana at the bake-off acceptance), against R = $0.0216 per visitor, so the lever order and [D-27](../decisions.md#d-27) stand. The default look of an exterior is two edits, not one: measured at $0.12 to $0.18 per look on 2026-11-10 (table above), it puts C at V = 1 at about $0.11 to $0.15 (a × g = $0.035 plus c × (the look + s) = 0.60 × ($0.12 to $0.18 + $0.01)), inside the same conclusion; the canonical n = 1.2 and e = $0.17 stay as the pricing illustration, and the peak model below uses two edits per look for load.

### Content admission (uploads)

| Item | Candidates (D-44) | Price | Status |
| --- | --- | --- | --- |
| Hash matching | Thorn Safer, Microsoft PhotoDNA, Google Content Safety API | not priced | **Verify:** eligibility, terms and price per image in S01 (owner: engineering lead with counsel) |
| Moderation classifier | OpenAI moderation, AWS Rekognition, Google Cloud Vision SafeSearch | not priced | same |
| Dwelling check and people detection | vision model triage (above) or a detector | under $0.01 estimate | measure |

Until priced, q is carried as unknown and excluded from the canonical illustration; the pipeline order and outcomes are in the [uploads spec](uploads.md#content-admission).

### Storage, delivery, email and bot defense

| Item | Basis | Estimate | Status |
| --- | --- | --- | --- |
| Object storage and CDN (source, working image, outputs, share card; retained per the [privacy spec](privacy-safety-legal.md#retention-schedule)) | S3 private bucket plus CloudFront (D-37) | about $0.01 per accepted variant | **Verify:** against the AWS rate card at scaffold (owner: engineering lead) |
| Email (magic links, "email me my preview") | Postmark or Amazon SES (D-48) | not priced | **Verify:** price per message and sending limits before M06 (owner: engineering lead) |
| Bot defense at session creation | Cloudflare Turnstile free plan: unlimited challenges | $0 | [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/) |
| Hosting, database, error tracking | Heroku dynos and Postgres, Sentry (D-37, D-45) | fixed monthly cost, outside the per-visitor model | **Verify:** at scaffold (owner: engineering lead) |

### Phase 1 evaluation spend reservations

Figures are illustrations at the list prices above; the product owner approves these reservations in P04. Each reservation is the computed figure × 1.25 (configuration; covers input-side tokens, escalated judging and incidental reruns), rounded up to the next $5 for items under $50 and to the next $50 otherwise. Per-attempt cost in an evaluation is the edit price plus one judge call ($0.036, Claude Opus 5.5 as measured on 2026-11-09, the [D-43](../decisions.md#d-43) default); scene analysis ($0.041) runs once per source photo per pass. Nano Banana 2.1 is carried at its measured effective price ($0.050 at 1K, $0.069 at 2K); the GPT-Image arms stay at the historical per-image estimates, well above the measured 2.5 prices ([Measured live costs](#measured-live-costs)) and therefore conservative until the metered test in F07. Every call is ledgered like production traffic. The harness runs against its own service-wide ceiling equal to the approved reservation, not against the private-pilot column of the [spend ceilings](#spend-ceilings).

| Item | Backlog | Formula (sample sizes from the owning spec) | Computed | Reservation (default) |
| --- | --- | --- | --- | --- |
| Coverage probe | F02 | 360 Geocoding-SKU calls × $0.005 + 30 autocomplete sessions × $0.039 (worst case: 12 requests plus Place Details Essentials) + 90 Static display loads × $0.007; metadata is free ([coverage probe](address-and-street-view.md#coverage-probe)) | $1.80 + $1.17 + $0.63 = $3.60 | $5 |
| Live Street View attribution and response test | F11 | 50 Static display loads (configuration; at least 10 per the [embedded attribution test](address-and-street-view.md#before-image-and-attribution)) × $0.007 | $0.35 | $5 |
| Exploratory spike | F07 | Attempts per provider-settings profile per pass: (12 tuning photos + 6 SV-shaped copies) × 3 holidays = 54, plus `evening` on 12 exterior inputs × 2 holidays = 24, plus `subtle` and `abundant` on 2 photos per cohort = 16, plus 3 variance cases × 3 runs = 9, total 103 ([exploratory spike](quality-and-benchmark.md#exploratory-spike)); × 3 tuning passes (configuration) = 309 attempts per profile; profiles: GPT-Image-2.5 Sunburst and Flare at medium and high, Nano Banana 2.1 at 1K and 2K, Gemini 3 Pro Image at 1K and 2K (8 profiles; per-attempt costs sum to $1.203); plus analysis 18 inputs × 3 passes × $0.041 | 309 × $1.203 + $2.21 ≈ $374 | $500 |
| Formal benchmark | F03 | About 730 attempts per arm ([formal benchmark](quality-and-benchmark.md#formal-benchmark), runs, repairs and variance; this count already includes the Street View-shaped arm, the lighting arm and the interior lighting check) × (edit price + $0.036) per arm, summed over the arms; default arms: GPT-Image-2.5 Sunburst and Flare at medium ($0.089 per attempt, $65 per arm) and high ($0.247, $180 per arm), Nano Banana 2.1 at 1K ($0.086 at the measured effective price, $63), Gemini 3 Pro Image at 1K ($0.170, $124); plus analysis 70 source photos (40 formal plus 30 SV-shaped) × $0.041 | $677.44 + $2.87 ≈ $680 | $900 |
| **Total** | | | **about $1,058** | **$1,410** |

The F07 and F03 rows were recomputed on 2026-11-09 with the measured Opus 5.5 vision costs and the measured Nano Banana price; before that they carried Sonnet 5.5 estimates ($0.03 analysis, $0.02 judge) and the output-only Nano Banana price, for a total of about $924 and reservations of $1,210. Gemini 3 Pro Image is carried at its published price; its input and thinking tokens are unmeasured and, if they add as much as Nano Banana's (about 50%), add about $49 to its F03 arm before the 1.25 factor. Each conditional GPT-Image-2.6 arm adds about $65 (medium) or $180 (high) to the F03 computed figure, and each conditional GPT-Image-2.6 profile adds about $28 (medium) or $76 (high) to F07, before the 1.25 factor; adding arms requires an amended reservation. GPT-Image figures are estimates until the metered test in F07.

## Revenue assumptions

Revenue is commission on purchases attributed to clicks from Shop the look ([commerce spec](commerce.md#shop-the-look)). Every rate below is either a published program term or a pilot measurement; there is no credible external benchmark for home-decor affiliate conversion.

### Commission rates and attribution windows

| Program | Rate | Attribution window | Status | Source |
| --- | --- | --- | --- | --- |
| Amazon Associates | 3% for Home, Home Improvement, Lawn & Garden, Furniture, Toys, Outdoors and Tools; 4.5% Kitchen; 4% all other categories | 24-hour session; items added to the cart during the session qualify if ordered within 89 days | verified | [rates](https://affiliate-program.amazon.com/help/node/topic/GRXPHT8U84RAYDXZ), [policies](https://affiliate-program.amazon.com/help/operating/policies/) |
| Walmart (Impact) | up to 4%; eligibility at Walmart's sole discretion | not stated on Walmart's page | partly verified | [Walmart FAQ](https://affiliates.walmart.com/page/faqs) |
| Etsy (Rakuten) | not stated by Etsy; commission excludes tax, shipping, returns and cancellations | 30 days | window verified | [Etsy help](https://help.etsy.com/hc/en-us/articles/360000335987) |
| Other decor merchants (Target, Wayfair, Home Depot, Lowe's, Michaels, Balsam Hill, specialist lighting retailers) | third-party claims from about 1% to 12% | third-party claims from 1 to 30 days | unverified; read from each network dashboard after approval | [commerce research](../research/commerce-and-markets.md#retail-affiliate-programs-and-networks) |

The illustration uses 3% (Amazon's home categories) as the base and 4% as the upside. Decor merchants are spread across several networks (Impact, CJ, Rakuten, Partnerize, FlexOffers, Sovrn), so "a specialist merchant at 6–8%" in the decision rules means a verified rate from an approved network program, not a third-party claim.

### Program dependencies

Commission is measurable only for merchant programs in `provisional` or `approved` status ([merchant onboarding](commerce.md#merchant-onboarding)). Amazon Associates requires three qualifying sales within 180 days of application before review, and its Creators API requires at least 10 qualifying sales in the trailing 30 days, so Amazon offers are manually curated links at first and Amazon revenue depends on an account that is not approved on day one (D-25; [Amazon](https://affiliate-program.amazon.com/help/node/topic/G7MJTPEP9NC3YKMG), [Creators API](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction)). Commerce activates per program independently of public rollout ([commerce activation](commerce.md#commerce-activation)), so the pilot and early public traffic can run with plain links or the panel hidden and R = 0 for a cohort; those visitors still count in C.

Every revenue and contribution reading carries an affiliate-tracking label per merchant program and per reporting cohort, derived from `merchant_programs.status` over the reading window:

| Label | Program status over the window | What the reading measures |
| --- | --- | --- |
| `plain` | `planned`, `applied`, `declined`, `withdrawn` or `suspended` throughout: plain destination links | Purchase intent through `product_clicked` (k) and cost; commission is zero by construction |
| `tracking` | `provisional` or `approved` throughout | k, p, B, r and R; commission is measurable |
| `mixed` | Both link modes occur inside the window | Split at the status change and read as one `plain` and one `tracking` reading |

Only `tracking` readings feed the revenue terms of the [decision rules](#decision-rules); a `plain` reading's contribution is cost alone and is never read as negative-contribution evidence. The label is printed beside every figure in the pilot report and in the post-launch review (backlog L05).

### Funnel rates are measurements

| Term | Illustration | Evidence | Rule |
| --- | --- | --- | --- |
| Click rate among completers, k | 25% | none | pilot measurement; reported per holiday, scene type, source kind, merchant program |
| Purchase rate among clickers, p | 4% | weak secondary figures only: home and furniture site conversion 0.6–1.8% ([Razorpay](https://razorpay.com/learn/order-conversion-rate-benchmarks/)), not affiliate click-to-purchase | pilot measurement; bounded by each program's attribution window, so report per program |
| Eligible basket, B | $120 | weak secondary figures: home-decor accessories median order $66 with a middle half of $31–$142 ([Madgicx](https://madgicx.com/labs/industries/home-goods-furnishings/home-decor-accessories)); a home-decor affiliate-traffic order value near $192 reported by one vendor without a date | pilot measurement from merchant reports |
| Effective commission after reversals, r | 3% | published gross rates above; reversal rate unknown | gross rate × (1 − reversal rate); returns and cancellations arrive weeks after the click |

Attribution and reconciliation mechanics (tracking-ID matrix for Amazon, per-click sub-IDs on network programs, the `affiliate_clicks` and `affiliate_conversions` records, weekly reconciliation, reversal status) are owned by the [commerce spec](commerce.md#click-tracking-and-attribution). This model needs from them: p and B per holiday × scene type × source kind × acquisition channel × merchant program, with reversals applied.

## Sensitivity

All rows start from the canonical illustration (V = 1, 3% commission, contribution −$0.133 per visitor) and move one input at a time. Values are rounded to the tenth of a cent.

### Accepted variants per completing visitor

| V | Variable cost per visitor | Contribution at 3% | Contribution at 4% |
| --- | --- | --- | --- |
| 1 | $0.155 | −$0.133 | −$0.126 |
| 2 | $0.275 | −$0.253 | −$0.246 |
| 3 (allowance maximum, D-12) | $0.395 | −$0.373 | −$0.366 |

Each additional accepted variant per completing visitor adds 0.60 × $0.20 = **$0.12 per visitor**, about 5.6 times the illustrated revenue. A loose allowance is the most expensive product decision in this document, which is why the allowance is configuration tied to the measured V and to the spend ceilings ([capacity and spend ceilings](#capacity-and-spend-ceilings)).

### One-lever moves

| Lever | Move | Contribution | Change |
| --- | --- | --- | --- |
| Commission (Amazon upside) | 3% → 4% | −$0.126 | +$0.007 |
| Commission (specialist merchant) | 3% → 8% | −$0.097 | +$0.036 |
| Click rate | 25% → 40% | −$0.120 | +$0.013 |
| Purchase rate | 4% → 8% | −$0.112 | +$0.022 |
| Basket | $120 → $200 | −$0.119 | +$0.014 |
| Completion | 60% → 75% | −$0.158 | −$0.025 (worse: renders scale with completion, revenue barely moves) |
| Cost per accepted variant (cheapest fidelity-passing tier) | $0.20 → $0.12 | −$0.085 | +$0.048 |
| Address-path share | 70% → 50% | −$0.123 | +$0.010 |
| Google cost per address-path visitor | $0.05 → $0.09 (worst case) | −$0.161 | −$0.028 |
| Attempts per accepted variant | 1.2 → 1.5 (u = $0.255) | −$0.166 | −$0.033 |
| Reversals | 10% of commission reversed (r = 2.7%) | −$0.136 | −$0.002 |

Reading: the two cost levers (tier and attempts per accepted variant) move contribution more than any single revenue lever; completion rate is not a lever for contribution at all. Revenue must reach about **7.2 times** the illustrated $0.0216 to break even at $0.20 per accepted variant, or **5.0 times** at $0.12.

### Combinations

| Scenario | Inputs | Contribution |
| --- | --- | --- |
| Every revenue lever optimistic at Amazon's 3% | 40% click, 8% purchase, $150 basket, $0.12 tier | −$0.021 (still negative; the purchase rate would need to be about 9.9%) |
| Specialist merchant, modest funnel | 8% commission, 25% click, 6% purchase, $150 basket, $0.12 tier | +$0.001 (break-even) |
| Specialist merchant, strong funnel | 8% commission, 35% click, 8% purchase, $150 basket, $0.12 tier | +$0.095 |

Affiliate commerce can carry variable cost on paper only with a specialist-rate merchant, a strong render-to-product link and the cheapest fidelity-passing tier together. That is the hypothesis the pilot tests; the decision rules below say what happens if it fails.

### Cost per accepted variant by tier

Per attempt = edit price + $0.04 vision; per accepted variant = 1.2 × per attempt. Storage and delivery excluded.

| Tier | Edit price | Per attempt | Per accepted variant |
| --- | --- | --- | --- |
| Nano Banana 2.1, 1K | $0.034 | $0.074 | $0.088 |
| GPT-Image medium quality (estimate) | $0.053 | $0.093 | $0.112 |
| Gemini 3.1 Flash Image, 1K | $0.067 | $0.107 | $0.128 |
| Gemini 3 Pro Image, 1K or 2K | $0.134 | $0.174 | $0.209 |
| GPT-Image high quality (estimate) | $0.211 | $0.251 | $0.301 |

The table assumes the same n for every tier, which the benchmark will show to be false: a tier that fails fidelity more often pays for more attempts. It also uses the published Nano Banana price and the pre-build vision estimate; the measured figures are in [Measured live costs](#measured-live-costs). n is unmeasured at scale: the 2026-11-09 bake-off acceptance rates (3 of 7 for Nano Banana 2.1, 6 of 8 for GPT image 2.5 Flare) are the current best evidence, they are not benchmark evidence, and they already reverse this table's order on cost per accepted variant. The [provider comparison](quality-and-benchmark.md#provider-comparison) ranks tiers on measured cost per accepted variant after the fidelity gates, against the cost ceiling in the [decision rules](#decision-rules).

### Allowance cost exposure

| Allowance element (D-12) | Default | Worst-case daily cost per owner |
| --- | --- | --- |
| Accepted variants per owner per rolling 24 h | 3 | 3 × $0.20 = $0.60 (paid through attempts, below) |
| New addresses per owner per rolling 24 h | 3 | 3 × $0.09 = $0.27 |
| Paid attempts per owner per rolling 24 h | 8 | 8 × $0.17 = $1.36 |
| **Worst case per owner per day** | | **about $1.63** (addresses plus attempts) |

A typical completing visitor costs far less (V = 1 to 1.5 and n = 1.2 give $0.20 to $0.30 in renders plus $0.05 in Google charges). The worst case is what the per-owner limits bound; the service-wide ceilings bound the sum over owners, and Turnstile plus the device/IP backstop bound how many owners a single abuser can be ([architecture](../architecture.md#security-architecture)).

## Decision rules

Status: Proposed (D-27, [decisions](../decisions.md#d-27)). These rules decide, from measured pilot and rollout data, whether affiliate commerce carries variable cost on its own and, if not, which pre-authorized lever is added alongside it. Affiliate commerce remains the primary direction (D-05) under every row. The product owner applies the table at the post-launch review (backlog L05, [Phase 5](../backlog.md#phase-5-pilot-and-rollout)) once the minimum sample below exists; Gate D ([gates](../backlog.md#gates)) confirms only that the rules and the lever order stand. Each application is a dated entry in the [decision log](../decisions.md#decision-log) with the measured values.

### Measurement window and minimum sample

| Rule | Default (configuration) | Why |
| --- | --- | --- |
| Measurement window | at least 1,500 completed previews (owners reaching `render_succeeded`) whose result screen showed Shop the look (`shop_panel_viewed`), with at least one merchant program carrying the `tracking` label ([program dependencies](#program-dependencies)) | At the illustration rates this is about 375 clicks and about 15 purchases: enough to see the order of magnitude. Wilson 95% intervals ([quality spec](quality-and-benchmark.md#statistics-and-decision-rules)): purchase rate 15/375 → 2.4%–6.5%; click rate 375/1,500 → 22.9%–27.3% (±2.2 points). |
| Larger window | 3,000 completed previews when a decision hinges on a difference under 1.5 points | 30/750 → 2.8%–5.7% purchase rate; 750/3,000 → 23.5%–26.6% click rate (±1.5 points). |
| Window closure | a window closes for decision only after the longest attribution window among live programs plus one weekly reconciliation have elapsed since the window's last click | Purchases attribute days to weeks after the click: Amazon's session is 24 hours, Etsy's window is 30 days. |
| Costing | list prices for every SKU | [costing rules](#costing-rules) |
| Dimensions | pooled first; then per holiday, scene type, source kind, acquisition channel and merchant program | Pooled numbers decide at the minimum sample. A cohort is decided on its own only when it meets the minimum sample itself; otherwise cohort views choose which lever applies (for example a path-specific tier or allowance). |
| Who decides | product owner, advised by the engineering lead and the operations/commercial lead | The table pre-authorizes the action; the owner confirms and records it. |

### Decision table

| Measured (pooled, list prices, after the minimum sample) | Pre-authorized action |
| --- | --- |
| M ≥ $0 | Keep the allowance; add merchants through the [onboarding runbook](commerce.md#merchant-onboarding); widen the allowance by one step (3 → 4 accepted variants per owner per 24 h) and re-measure. |
| −$0.05 < M < $0 | **Lever 1.** Make the cheapest tier that passed the fidelity gates the default render tier ([provider comparison](quality-and-benchmark.md#provider-comparison)); add at least one specialist decor merchant with a verified commission of 6% or more; re-measure. |
| M ≤ −$0.05 in two consecutive windows, or ≥10% of completers who see the paid-looks interest card click it | **Lever 2.** Owner decision on paid looks or HD downloads ([D-13](../decisions.md#d-13), Gate D). Arithmetic for that decision: to close a −$0.133 gap, a real paid offer would need 15.5% of completers paying at $1.99, 9.3% at $2.99 or 5.1% at $4.99, net of card fees of 2.9% + $0.30 per transaction ([Stripe pricing](https://stripe.com/pricing), retrieved 2026-11-08) and the paid look's own render; at V = 2 the gap and the required take rates roughly double. Interest clicks are not purchases; discount them heavily. Pulling this lever adds payment, sales-tax and consumer-billing work that is outside the US Release ([PLAN §3](../PLAN.md#3-scope-of-the-us-release)). |
| Click rate among completers < 10% | Diagnose Shop the look relevance and placement before any merchant or pricing change ([shop the look](commerce.md#shop-the-look), [ranking integrity](commerce.md#ranking-integrity)). |
| Purchase rate among clickers < 2% while click rate ≥ 20% | Treat as a render-to-product link problem: more `described` items and fuller kit coverage ([product relationships](commerce.md#product-relationships)) before adding merchants. |
| Installer-lead interest ≥ 3% of exterior completers who see the button, and at least one installer agrees a per-lead price | **Lever 3.** Open installer-lead referrals ([revenue experiments](#revenue-experiments)). |
| Any specialist merchant gives a written yes to a sponsored collection | **Lever 4.** Sponsored collections, labeled "Sponsored" and ranked separately ([ranking integrity](commerce.md#ranking-integrity)). |

The lever order is fixed: 1 cheaper fidelity-passing tier, 2 paid looks or HD downloads, 3 installer leads, 4 sponsored collections. A later lever may be prepared (conversations, interest cards) while an earlier one is being measured, but money is spent on it only in this order.

### Cost ceiling for provider selection

Gate A selects the image-edit provider (D-42) on the fidelity gates first and cost second. The economics ceiling the quality spec refers to is **$0.25 per accepted variant at list prices** (configuration, default): attempts per accepted variant measured in the formal benchmark × per-attempt cost (edit price plus vision calls). A provider above the ceiling is not selected regardless of quality; among providers under it, the fidelity and acceptability results decide. The ceiling leaves room for n up to about 1.5 at the canonical $0.17 per attempt; at the measured live configurations (analysis $0.041 per job plus $0.060 or $0.086 per attempt) it leaves room for n up to about 3.5 with GPT image 2.5 Flare and about 2.4 with Nano Banana 2.1, whose bake-off acceptance implied n of about 2.7 ([Measured live costs](#measured-live-costs)). The ceiling governs the Gate A selection; the provisional development default of [D-42](../decisions.md#d-42) is not that selection.

### Never done

- Unlimited free renders; the allowance is always finite (D-12).
- Commission-driven ranking, or any silent promotion of a higher-commission item over a more relevant one ([ranking integrity](commerce.md#ranking-integrity)).
- Treating traffic, renders or clicks as evidence of positive contribution.
- Reporting contribution at invoice prices while usage sits inside free tiers.
- Lowering the fidelity or privacy gates to reach a cheaper tier; a tier passes the quality spec's rules or it is not a tier.
- Charging money, or showing a purchase control that does not work, inside an interest test (D-13).

## Revenue experiments

Each experiment is cheap, charges nothing, leaves the allowance and the affiliate panel unchanged, and produces one number for the decision table. They are delivered as backlog item L07 in Phase 5 ([backlog](../backlog.md#phase-5-pilot-and-rollout)); the order below is the order in which money and attention are spent. Experiments 2 and 3 are measured with the first-party events `experiment_shown` and `experiment_clicked` (`experimentId`, `arm`), and experiment 3's submitted leads with `lead_submitted` (`experimentId`, `sceneType`) ([event taxonomy](data-and-api.md#analytics-events)).

| Order | Experiment | Design (no billing code) | Metric and signal | Sample | Cost | Risks and constraints |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | "Email me my preview" | On the result screen after the first accepted variant, offer to email a link to the project. The email address is captured through the magic-link flow (D-21, D-48), so the same action saves the project. The email links to the project, never to an image file, unless the variant is downloadable under D-22. | Capture rate among completers; return visits within 7 days (a later `landing_viewed` by the same owner); `holiday_changed` on return. This is a retention loop, not a revenue line; it builds the audience for experiments 2 and 3. | all completers; read at 1,500 completers | email price per message (worksheet) | Transactional email under CAN-SPAM and the address as personal data ([privacy spec](privacy-safety-legal.md#us-privacy-law), [data inventory](privacy-safety-legal.md#data-inventory)); copy must not promise the preview is kept beyond the retention schedule. |
| 2 | Paid-looks or HD-download interest test (D-13 candidate for public rollout) | A clearly labeled "Coming soon: would you pay for this?" card at the allowance boundary and on the result screen, with a stated price randomized between two arms ($2.99 and $4.99) and an optional "Tell me when it exists" email capture. Nothing is charged and no purchase control exists. Runs only if the owner chooses it at Gate D (D-13). | Card click rate among completers who see it, by arm, path and holiday; notify rate. Signal: ≥10% click → Lever 2 consideration. | 1,500 completers who see the card (at least 750 per arm) | zero marginal | Interest is not purchase. HD download is possible only for upload-origin variants: Street View sources are 640 px and the US Release does no AI upscaling ([compositing and resolution](render-pipeline.md#compositing-and-resolution)), and Street View-origin download needs `distributeDerivative` under the grant (D-22). Copy must not imply the product exists. |
| 3 | Installer-lead interest | A "Want this installed? Get a quote" button on exterior results during the Christmas and Halloween windows; a form collects ZIP code and contact details; leads are forwarded by hand to two or three local installers found through directories, who are asked what a lead is worth to them. | Button click rate among exterior completers who see it; submitted leads; installer-accepted price per lead. Signal: ≥3% click and at least one installer agreeing a price → Lever 3. | at least 500 exterior completers who see the button | manual forwarding time; a form | Lead details are personal data with their own consent copy and retention ([privacy spec](privacy-safety-legal.md#data-inventory)). Street View-derived renders are never passed to installers for promotional use: Google's Geo Guidelines bar Street View imagery in advertisements or promotional materials of any kind ([Geo Guidelines](https://about.google/brand-resource-center/products-and-services/geo-guidelines/)); upload-origin images only, with the owner's consent. A referral is not an endorsement; state lead-generation rules are for counsel to confirm. Lead value is unverified until an installer states it. |
| 4 | Sponsored collections | During network onboarding, pitch two or three specialist merchants on being the named sponsor of one style kit for one holiday, for a flat fee or a commission uplift. Conversations only. | A written yes. | not applicable | conversation time | "Sponsored" label and separate ranking ([ranking integrity](commerce.md#ranking-integrity)); disclosure wording (D-26); no merchant images or text in prompts (D-24); the sponsored kit still passes content review. |
| 5 | Credits for heavy users | Not tested until experiment 2 reads positive. | | | | Would reopen billing scope. |
| Later expansion | Agents, stagers and lighting companies (B2B) | A "For professionals" waitlist page, uploaded and owned photos only. | sign-ups with a business email | | | Street View-derived imagery cannot be used in anyone's marketing (Geo Guidelines, above); outside the US Release. |

## Capacity and spend ceilings

Capacity is bounded by the vendors' tiers, not by Hailiday's configuration: usage tiers are functions of cumulative paid history and account age, and they return 429 errors independent of any local cap. This section gives the values; the mechanics (provider concurrency, queue depth caps, `AT_CAPACITY` with `Retry-After`, one active job per project, kill switches) are in the [architecture](../architecture.md#capacity-and-admission-control) and [operations](../architecture.md#observability-and-operations) sections, and the enforcement points for allowance and quotas are in the [data and API spec](data-and-api.md#allowance-quotas-and-rate-limits).

### Vendor limits and how tiers are earned

| Vendor | Limit | Values | How the tier rises | Source |
| --- | --- | --- | --- | --- |
| OpenAI API | monthly usage limit by tier, plus per-model RPM, TPM and IPM (images per minute) | Free $100 per month; Build $500 (after $5 of credit purchases); Launch $5,000 (after $100); Grow $200,000 (after $500) | automatically as cumulative credit purchases reach each threshold; per-model limits are read in the dashboard | [rate limits](https://developers.openai.com/api/docs/guides/rate-limits) (retrieved 2026-11-09) |
| Gemini API | spend per rolling 10-minute window by tier, plus IPM for image models; exceeding returns 429 `RESOURCE_EXHAUSTED` | Tier 1 $10 (active billing account linked); Tier 2 $200 (paid $100 and 3 days since first payment); Tier 3 $200 (paid $1,000 and 30 days) | automatically once the project meets the paid-amount and age criteria; per-model limits are read in AI Studio | [rate limits](https://aistudio.google.com/docs/rate-limits) (retrieved 2026-11-09) |
| Vertex AI (Gemini 3 Pro Image route) | per-project, per-region quotas | **Verify:** quotas and the increase process before Gate A if this route is a finalist (owner: engineering lead) | by request | |
| Anthropic Claude API | rate-limit tiers by usage | **Verify:** the current tier table and the analysis-plus-judge calls per minute it allows at the peak below (owner: engineering lead; https://platform.claude.com/docs) | by usage and deposit | |
| Google Maps Platform | per-project per-minute quotas; Static Street View usage limit 30,000 queries per minute; 10,000 free calls per month on each SKU Hailiday uses | far above any value in the peak model | quota edits in the Cloud console | [Street View usage](https://developers.google.com/maps/documentation/streetview/usage-and-billing), [pricing](https://developers.google.com/maps/billing-and-pricing/pricing) |
| Safety vendors (D-44) | per vendor | **Verify:** in S01 (owner: engineering lead) | | |
| Email provider (D-48) | sending limits and warm-up | **Verify:** before M06 (owner: engineering lead) | | |
| Cloudflare Turnstile | none on the free plan | unlimited challenges | not applicable | [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/) |

Because tiers are earned with paid history, the production vendor accounts are opened early (P07, owner: the product owner), seeded with prepaid credit, and used for the formal benchmark and for all `live_private` traffic, so that each account's tier already exceeds the peak-model requirement when Gate D is considered. "Vendor tier verified in each dashboard against the peak model" is a Gate D evidence item ([gates](../backlog.md#gates)).

### Peak model

Demand concentrates in the promotion windows ([seasonality](#seasonality)); the planning peak is the busiest day of the Christmas window. All inputs are configuration with the defaults below; the planning peak-day visitor count is the product owner's call.

| Input | Symbol | Default |
| --- | --- | --- |
| Peak-day visitors | Vd | private pilot 50 (10–15 participants over several days); capped public rollout 2,000; stress case 10,000 |
| Completion rate | c | 0.60 |
| Accepted variants per completer at peak | V | 1.5 (people switch holiday and style) |
| Attempts per accepted variant (cost illustration, [Symbols and defaults](#symbols-and-defaults)) | n | 1.2 |
| Edit attempts per accepted variant (load) | nₗ | 2: the default look is two sequential edits, a decorated base and its relight; a one-edit look (as photographed, a dusk photo, an already-bright interior) is the exception |
| Share of the day's jobs in the peak hour | h | 12% |
| Service time per job (two edits plus their checks) | S | 80 s (measured 72 to 105 s; about 125 s when a third attempt runs; [latency budget](render-pipeline.md#latency-budget)) |
| Burst factor for provisioning | b | 2 |
| Maximum predicted wait before `AT_CAPACITY` | W | 240 s |

```text
jobs per day               J = Vd × c × V            (one job per accepted variant)
attempts per day           A = J × n                 (cost illustration)
peak arrival rate          λ = J × h / 60            (jobs per minute)
provider concurrency       N = λ × S / 60 × b        (lanes, each running one job's edits in turn; minimum 2)
queue depth cap            Q = N × W / S             (jobs)
predicted wait             queue depth × S / N
```

| Scale | Vd | J per day | A per day | λ per min | N | Q | Google per day | Renders per day | Total per day | 30 peak days (upper bound for a month) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Private pilot | 50 | 45 | 54 | 0.09 | 2 | 6 | $2 | $9 | $11 | $330 |
| Capped public rollout | 2,000 | 1,800 | 2,160 | 3.6 | 10 | 30 | $70 | $367 | $437 | $13,100 |
| Stress case | 10,000 | 9,000 | 10,800 | 18 | 48 | 144 | $350 | $1,836 | $2,186 | $65,600 |

Google per day = Vd × a × g (worker refetches in `transient` mode add about $13 per day at the capped rollout); renders per day = A × e (the cost illustration, n = 1.2). Checks against the vendor table at the capped rollout: Gemini image spend in the peak hour is about $2.9 (Flash tier) to $5.8 (Pro tier) per 10 minutes, and $11.6 on a 2× burst at the Pro tier, so Gemini Tier 1's $10 cap is insufficient and Tier 2 is required; OpenAI image-edit spend is about $8,400 over 30 peak days at $0.13 per edit, above the Launch tier's $5,000 per month, so the Grow tier ($500 of cumulative purchases) is required. At the stress case Gemini needs $14–$29 per 10 minutes (Tier 2 or 3) and OpenAI about $42,000 per month (Grow). Vision calls at the capped rollout are about 1,800 analyses (one per job) and, at two edits per look, about 3,600 judge calls per day; check them against the Claude tier once verified. The cost columns and the vendor checks keep the canonical n = 1.2; at nₗ = 2 the daily edit and judge volume is about 1.7 times higher (3,600 edits at the capped rollout). **Verify:** re-derive the vendor-tier requirements and the per-SKU ceilings for image-edit attempts and vision calls from nₗ = 2 before Gate D (owner: engineering lead).

### Admission-control values

| Control | Private pilot | Capped public rollout | Stress case | Behavior |
| --- | --- | --- | --- | --- |
| Image-edit provider concurrency (N) | 2 | 10 | 48 | per provider; a second live-validated provider gets its own N |
| Vision-model concurrency | 4 | 20 | 96 | 2 × N (analysis and judge calls overlap) |
| Queue depth cap (Q) | 6 | 30 | 144 | render requests beyond Q receive `AT_CAPACITY` |
| Maximum predicted wait (W) | 240 s | 240 s | 240 s | `AT_CAPACITY` when (queue depth + 1) × S / N > W, with S the median service time of the jobs that succeeded in the last hour, from `started_at` to `qa_passed_at` (else `render_completed_at`, else `succeeded_at`), so a reviewer's wait under pre-delivery review is not counted, and with the daylight companion rows of evening looks (`input_snapshot.relightBaseOf` set) left out; `Retry-After` = predicted wait rounded up to 30 s, at most 300 s |
| Queue position | shown | shown | shown | from the live-update stream ([experience](experience.md#waiting-and-progress)) |

Before any job has succeeded in the last hour, the API predicts the wait with a fallback median job duration of 80 s (the measured two-edit default look), so a cold service with two lanes and W = 240 s admits a request while at most five jobs wait. The shipped configuration defaults (provider concurrency 6, queue depth cap 36, two lanes per worker) are the starting values; the load test below fixes them.

Degradation ladder: the five steps and their runtime switches are defined once in [architecture, capacity and admission control](../architecture.md#capacity-and-admission-control); the values it reads from this file are W (240 s) and the reduced in-window allowance for new owners (1 accepted variant per 24 h, configuration).

Load test before Gate C (backlog O06): drive the capped-rollout arrival rate at the 2× burst (about 7 jobs per minute) for 30 minutes in `fixture` mode against provider stubs with realistic latency distributions. Pass: p90 of `qaPassedAt − max(requestedAt, sourceReadyAt)` inside the D-14 range; `AT_CAPACITY` engages at Q and releases; no duplicate paid attempts; the ledger reconciles reservations and settlements to the cent.

### Spend ceilings

Ceilings are configuration enforced as `BUDGET_PAUSED` ([error codes](data-and-api.md#error-codes)); operations alerts fire at 50% and 80% of each ceiling, and 100% pauses the SKU (per-SKU ceiling) or all paid work (service-wide ceiling). Daily ceilings use the calendar day in UTC; monthly ceilings the calendar month. Values are stored in `runtime_settings`; a per-SKU ceiling is enforced as spend (units × list unit price, in USD micros). Defaults derive from the peak model: daily about 1.5 × modeled peak-day spend and monthly about 1.15 × the modeled 30 peak days, both rounded to a convenient figure; per-SKU daily at least 1.7 × modeled peak-day units, rounded up.

| Ceiling | Private pilot | Capped public rollout, in-window | Off-season | Modeled peak-day units at the capped rollout |
| --- | --- | --- | --- | --- |
| Service-wide daily spend | $50 | $700 | $100 | $437 (plus about $13 of worker refetches) |
| Service-wide monthly spend | $600 | $15,000 | $1,500 | $13,100 |
| Static Street View images | 300 | 9,500 ($67) | 1,500 | 5,300 (3,500 candidate images plus up to 1,800 worker refetches in `transient` mode) |
| Autocomplete requests | 1,000 | 20,000 ($57) | 3,000 | 9,800 |
| Place Details Essentials | 150 | 3,000 ($15) | 500 | 1,400 |
| Geocoding (including SearchDestinations) | 300 | 6,000 ($30) | 1,000 | 2,800 |
| Image-edit attempts | 150 ($20) | 3,700 ($481) | 500 | 2,160 |
| Vision calls (analysis and judge) | 300 | 7,000 (about $280) | 1,000 | 3,960 |
| Screened uploads | 100 | 1,500 | 300 | 600 |
| Emails sent | 100 | 3,000 | 500 | not modeled; set from pilot volume |

Since 2026-11-10 a vision call counts toward the ceiling at its settled cost, because the list prices are at or above the measured costs. The enhancement's edit and judge lines count toward the image-edit and vision-call ceilings like the job's other lines (the reservation of a first look of a Street View address is $0.17 larger, and a request whose worst case no longer fits answers `BUDGET_PAUSED`); they are not yet included in the modeled peak-day units of the table, which count one extra edit and one extra vision call per first look of an address and release, and are to be added at the next revision of the peak model.

Per-SKU ceilings catch a runaway in one integration (a suggestion loop, a refetch bug) long before the service-wide ceiling does. When a ceiling pauses one SKU, the product degrades honestly: a paused Static Street View SKU makes discovery and viewpoint requests return `BUDGET_PAUSED` (`reason: sku_ceiling`; [data-and-api](data-and-api.md#allowance-quotas-and-rate-limits)) and the client shows the photo prompt, a paused image-edit SKU shows the budget-paused state ([experience](experience.md#allowance-and-limits)).

### Guest allowance and abuse limits

Status: Proposed (D-12, [decisions](../decisions.md#d-12)). Two allowances are product policy: how many looks (accepted variants) and how many new addresses a person gets for free. Both return `ALLOWANCE_EXHAUSTED` with a `scope` and share the allowance sheet, whose behavior at the limit is Open (D-13). Two abuse quotas are cost backstops: paid render attempts per owner, and the device/IP backstop on render requests, both returning `RATE_LIMITED`. The spend ceilings above bound the whole service (`BUDGET_PAUSED`). Each control has its own error code and screen ([data and API](data-and-api.md#allowance-quotas-and-rate-limits); [experience](experience.md#allowance-and-limits)). Values are stored in `runtime_settings` and change without a deploy. Under `APP_ENV=development` the seeded defaults for the four limits below and `rate.sessions_per_ip_10m` are 30, 30, 60, 300 and 200 so that one person can test locally; staging, production and test use the specified values, and the mechanism and overrides are in [data and API](data-and-api.md#allowance-quotas-and-rate-limits). An amendment of D-12 changes the specified values, never the development profile.

| Limit | Default (configuration) | Counting rule | Kind |
| --- | --- | --- | --- |
| Accepted variants per owner per rolling 24 h | 3 | Consumed when a render job reaches `succeeded`; non-terminal jobs are held against it at admission; a request whose variant key already has an accepted variant returns it and consumes nothing; `rejected`, `failed`, `canceled`, `superseded` and `expired` jobs consume nothing | allowance (`ALLOWANCE_EXHAUSTED`, `scope: variants`) |
| New addresses per owner per rolling 24 h | 3 | Counted when `POST /v1/addresses/resolve` creates an address project, before the Place Details call; `skip_to_upload` outcomes still count because the Google calls were made; discovery, confirmation, alternates, nudges and reopening a saved project do not count | allowance (`ALLOWANCE_EXHAUSTED`, `scope: addresses`) |
| Paid render attempts per owner per rolling 24 h | 8 | Counted at reservation, before the provider call; repair attempts count; transport retries do not; an attempt never sent to the provider (stopped by a pause or a deadline before dispatch, nothing billed) does not | abuse quota (`RATE_LIMITED`, `scope: attempts`) |
| Render requests per device per rolling 24 h | 6 (`quota.render_requests_per_device_24h`) | Counted when a render job is created; signal only; device is not identity; used to challenge, never to attribute | backstop: device dimension → challenge (`VERIFICATION_REQUIRED` with `scope: device`, then admitted with a fresh Turnstile token) |
| Render requests per IP per rolling 24 h | 6 (`quota.render_requests_per_ip_24h`) | Counted when a render job is created; signal only; IP is not identity. The IP count spans the current and the previous day's salted hash of the address, so it does not restart when the daily salt rotates | backstop: IP dimension → refuse (`RATE_LIMITED`, `scope: device`) |
| Per-session and per-address Google limits (suggestions, tokens, resolves, the Static display budget) | [address spec](address-and-street-view.md#pre-render-spend-controls) | | pre-render spend control |

**Owner decision before rollout.** The device and IP dimensions are two settings (`quota.render_requests_per_device_24h` and `quota.render_requests_per_ip_24h`), both 6 by default; each dimension is checked against its own limit. A browser that stays on one address reaches the IP refusal at the same count as the device challenge unless the two values differ, so the challenge only helps visitors whose jobs came from several addresses, and 6 render requests per IP per day refuses shared-IP households, offices and carrier-grade NAT (CGNAT) networks. The product owner decides the IP value (the separate setting makes it adjustable without touching the device value) before the capped public rollout ([README](../README.md#what-the-owner-needs-to-do-next)).

The owner is an anonymous session or an account; the window is rolling. The defaults honor the toggling promise (D-06): the first render plus two deliberate changes of holiday, style or lighting, with cached variants free to revisit. The cost exposure is in the [sensitivity section](#allowance-cost-exposure): about $1.63 per owner per day in the worst case, so about 430 maximally abusive owners would exhaust the capped-rollout daily ceiling, which is why Turnstile at session creation and the device/IP backstop exist. Widening the allowance by one step (the first row of the decision table) costs up to $0.12 per visitor at the illustrated completion rate if every completer uses it. Per-season values are allowed: the in-window and off-season columns of the ceilings table may be paired with different allowance values, with the D-12 defaults applying unless a season sets its own.

### Kill switches

| Switch | Trigger | Effect | Reversal |
| --- | --- | --- | --- |
| Global pause | manual, or 100% of a service-wide ceiling | no new paid work; `BUDGET_PAUSED`; existing results stay viewable | manual, after the cause is recorded |
| Per-SKU pause | 100% of a per-SKU daily ceiling | that integration refuses calls; honest degradation as above | automatic at the next day boundary, or manual |
| Per-provider disable | provider outage, terms incident, 429 storm | the adapter is disabled; route or pause per the degradation ladder | manual |
| Per-capability activation | licensing or vendor-terms change | the `country_capabilities` state moves to `fixture` or `live_private` (D-47) | manual, with evidence |
| Auto-start pause | degradation step 2 | the address path requires an explicit tap | manual |

All switches are configuration changes without a deploy, audited, and exercised in the runbooks ([operations](../architecture.md#observability-and-operations)).

## Seasonality

Hailiday is a seasonal product. Demand follows the promotion windows in the [holidays spec](holidays-and-content.md#windows-and-selection), which together span mid-September to New Year's Day; the rest of the year is off-season, when the landing shows a neutral hero and nothing auto-starts ([off-season behavior](holidays-and-content.md#off-season-behavior)). This section describes how demand, cost and revenue behave through the year so that capacity, commerce and configuration follow the calendar.

### Evidence

| Observation | Figure | Source | Status |
| --- | --- | --- | --- |
| Halloween is a large decoration market and shoppers start early | 2026 total $13.5 billion; decorations $4.3 billion; 78% of celebrants buy decorations; 42% decorate their home or yard; 49% start shopping in September or earlier | [NRF Halloween 2026](https://nrf.com/media-center/press-releases/nrf-halloween-survey-shows-consumer-spending-expected-to-reach-13-5-billion) | verified |
| Winter holiday spending and early starts | 2026 forecast $1.013 trillion for November 1 – December 31, up 4.2%; 43% of holiday shoppers start before November | [NRF forecast](https://nrf.com/media-center/press-releases/nrf-forecasts-2026-holiday-sales-growth-as-consumers-remain-resilient), [NRF survey](https://nrf.com/media-center/press-releases/affordability-shapes-winter-holiday-shopping-according-to-nrf-holiday-survey) | verified (NRF 2026 holiday survey, released 2026-10-20) |
| Thanksgiving decoration spend | no separate figure exists; no current primary NRF figure for winter-holiday decoration spend was found | [research](../research/commerce-and-markets.md#seasonal-demand) | not established |
| Search interest for "christmas lights" | reportedly rises from September, peaks in early December and is near zero from February to August | secondary summaries only ([research](../research/commerce-and-markets.md#seasonal-demand)) | unverified. **Verify:** pull Google Trends for "christmas lights", "halloween decorations" and "thanksgiving decorations" before the first seasonal configuration (owner: product owner with the editorial lead) |

### Implications

| Area | Implication | Where it lands |
| --- | --- | --- |
| Capacity | Two peaks a year: late October (Halloween) and the Christmas window, with the planning peak on the busiest Christmas-window day. Vendor tiers, ceilings and admission-control values are set per window from the peak model; the dependency is "tier in place before the window", not a date. | [capacity and spend ceilings](#capacity-and-spend-ceilings) |
| Cost | Render cost per visitor is the same in July as in December; off-season revenue trends toward zero. Read contribution per season and per holiday pack, never from the peak illustration; apply the off-season ceilings. | [spend ceilings](#spend-ceilings), [decision rules](#decision-rules) |
| Commerce | Commerce windows open before promotion windows because shoppers buy early (Halloween shoppers start in September); offers retire after the holiday. The Thanksgiving pack is likely to monetize below Christmas during November 1 – Thanksgiving Day while Christmas decor buying is already under way; this is a measured risk per pack, not a reason to change the hero (D-06). The contingency (Christmas one tap from a Thanksgiving result, a labeled "Get ready for Christmas" row) is the commerce spec's. | [seasonal commerce calendar](commerce.md#seasonal-commerce-calendar) |
| Decision windows | The minimum sample is reachable only inside a promotion window, and attribution lags the click, so the Christmas window's decision closes in January; the post-launch review applies the decision table then. | [decision rules](#decision-rules), [backlog](../backlog.md#phase-5-pilot-and-rollout) |
| Fixed costs | Hosting, database and error tracking run all year; off-season they dominate total cost. Budget them annually and use the off-season for content, pack and kit work rather than paid rendering. | [cost worksheet](#cost-worksheet) |
| Experiments | Installer-lead interest (experiment 3) is meaningful only in the Christmas and Halloween windows; "email me my preview" (experiment 1) is the mechanism that brings people back at the next holiday. | [revenue experiments](#revenue-experiments) |

### Per-season configuration

| Setting | In a promotion window | Off-season | Owner of the rule |
| --- | --- | --- | --- |
| Service-wide and per-SKU spend ceilings | in-window column | off-season column | this spec |
| Guest allowance | D-12 defaults | D-12 defaults unless the owner sets a lower off-season value | this spec |
| Auto-start on the address path | per match class | off until a holiday is chosen | [holidays spec](holidays-and-content.md#off-season-behavior) (D-09) |
| Shop the look | active offers inside their commerce window | hidden, or "Plan ahead" copy | [commerce spec](commerce.md#seasonal-commerce-calendar) |
| Hero and default holiday | the window's holiday | neutral hero, full picker | [holidays spec](holidays-and-content.md#windows-and-selection) |
| Vendor tier check | before each window | not needed | this spec |
