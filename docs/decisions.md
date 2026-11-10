# Holiday: decision register

This file lists every product and technical decision that shapes Holiday. For each one it gives the status, the owner, what settles it, and why the plan recommends what it does. Other documents implement these decisions and link here by ID (for example [D-15](#d-15)). They do not restate a decision's status.

**Owns:** decision IDs, statuses, owners, rationale, and the dated decision log (including gate outcomes and licensing outcomes).
**Baseline:** planning baseline 2026-11-09; external facts retrieved 2026-11-08.

## How decisions work

### Statuses

| Status | Meaning | Who may change it | What the build does |
| --- | --- | --- | --- |
| **Fixed** | Set by the user (the product owner) as a requirement | Only the user | Builds it as stated. Where the plan interprets a Fixed decision, the interpretation is recorded in [traceability](traceability.md#interpretations-of-the-brief) |
| **Proposed** | The plan's recommended default, with its rationale and the evidence that would change it | The user accepts or amends it; a Proposed technical decision is accepted as built unless the user objects first (step 2 below). The named owner may propose an amendment | Proceeds on the default unless the user amends it |
| **Accepted** | A Proposed decision the user has approved or that was accepted as built, or an Open decision the user has settled | Only the user, through a new dated log entry | Builds the accepted value |
| **Open** | Needs a user decision or evidence that does not exist yet | The named owner gathers evidence. The user decides | Uses the stated **default until decided**, and the named backlog item or gate settles it |

Owners are roles. "user" means the product owner. "engineering lead", "editorial" (design and editorial lead) and "commercial" (operations and commercial lead) are delivery roles. "counsel" is external legal advice. "user + counsel" means the user decides after counsel advises. Where a decision depends on a fact that may change, its record contains one **Verify:** line naming the check and who runs it.

### How a decision changes status

1. **Proposed to Accepted.** The decision is approved as written or amended, and a log entry records the date, the ID and any amended value. The record's status line then reads "Accepted (date)". Approval is not a precondition for building: work proceeds on Proposed defaults, and an amendment changes the affected specs and backlog items.
2. **Who accepts a Proposed decision.** Product decisions (owned by the user alone or with counsel, editorial or commercial) are accepted only by the user, who writes or approves the log entry. Proposed technical decisions (owner: engineering lead) are accepted by default: when the settling backlog item is Done, the engineering lead writes the log entry "D-nn accepted as built at" followed by the item ID (for example "D-31 accepted as built at B01"). The user may object at any time before that entry, or amend the decision afterwards under step 4. The engineering lead may draft any entry for the user.
3. **Open to Accepted.** The owner presents the evidence named under "Settles when". The user chooses an option. The log entry records the choice, and the record's Decision field is rewritten to the chosen option.
4. **Amending an Accepted or Fixed decision.** Only the user can do this. The record is edited in place, and a new log entry states the previous value, the new value and the reason. IDs are never reused or renumbered. A new decision takes the next unused ID.
5. **Propagation.** When a decision's value changes, the owner files listed under "Primary doc" are updated in the same change, so the specs never contradict the register.

### What the decision log records

Every entry is dated and has a type:

| Entry type | When | Required content |
| --- | --- | --- |
| Decision | A status or value changes | IDs, old value, new value, decided by, evidence links |
| Gate outcome | Gate A, B, C or D is evaluated (checklists in [backlog](backlog.md#gates)) | Gate, decider (the user, advised by the engineering lead), evidence artifacts, pass or fail against the pass rule, the failure branch chosen if it failed, and the decisions it settles |
| Licensing outcome | The user receives, or stops waiting for, an answer on Street View licensing ([D-15](#d-15)) | Outcome (full, partial, denied, unknown), dated evidence reference, clause-by-clause mapping for a partial grant, and the resulting `asset_policies` and `country_capabilities` changes |
| Activation | Any capability moves to `live_public`, or a capability is withdrawn from it ([D-47](#d-47)) | Capability key, previous and new activation state, evidence reference |
| Merchant program | A merchant program changes status (for example `applied` to `provisional` to `approved`) ([D-25](#d-25)) | Program, status change, date, consequences for commerce activation |

Day-to-day capability changes are also written to the audit log by the system. The decision log is the human-readable record of why they happened.

### Record format

Each decision below is an H3 heading that is exactly its ID, so links such as `decisions.md#d-15` resolve. The heading is followed by a bold title and these fields:

- **Status:** the status, owner, and what settles it.
- **Decision:** the binding statement. For an Open decision this field is labeled "Decision (default until decided)", and the options under consideration appear under Alternatives considered, directly after it.
- **Rationale:** why, grounded in the user's original request, verified external facts (with sources) or the reference repositories.
- **Alternatives considered:** what else was weighed and why it was not chosen.
- **Consequences:** what the decision obliges the specs, backlog and operations to do.
- **Settles when / what would change it:** the evidence, gate or event that settles or reopens it.

Configuration values that appear in a decision (allowance numbers, retention periods, windows) are defaults. The owner spec named in the record holds the live configuration contract.

## Decision register

| ID | Title | Status | Owner | Settled by | Primary doc |
| --- | --- | --- | --- | --- | --- |
| [D-01](#d-01) | Monorepo | Fixed | user | 2026-11-08 | [architecture](architecture.md#repository-layout) |
| [D-02](#d-02) | US-first geography | Fixed | user | 2026-11-08 | [PLAN §3](PLAN.md#3-scope-of-the-us-release) |
| [D-03](#d-03) | Street View path in the initial build | Fixed | user | 2026-11-08 | [address spec](specs/address-and-street-view.md#licensing-outcomes-and-activation) |
| [D-04](#d-04) | Uploads in the US Release | Fixed | user | 2026-11-08 | [uploads spec](specs/uploads.md#upload-flow) |
| [D-05](#d-05) | Affiliate commerce direction | Fixed | user | 2026-11-08 | [commerce spec](specs/commerce.md#shop-the-look) |
| [D-06](#d-06) | Landing and interaction | Fixed | user | 2026-11-08 | [experience spec](specs/experience.md#landing) |
| [D-07](#d-07) | Real photos, faithfully decorated | Fixed | user | 2026-11-08 | [render spec](specs/render-pipeline.md#quality-checks) |
| [D-08](#d-08) | US holiday catalog | Proposed | user + editorial | Phase 0 (P03) | [holidays spec](specs/holidays-and-content.md#us-holiday-catalog) |
| [D-09](#d-09) | Windows, timezone and off-season | Proposed | user | Phase 0 (P03) | [holidays spec](specs/holidays-and-content.md#windows-and-selection) |
| [D-10](#d-10) | Style and lighting defaults | Proposed | user | Gate A | [holidays spec](specs/holidays-and-content.md#lighting-policy), [render spec](specs/render-pipeline.md#lighting-modes) |
| [D-11](#d-11) | Mid-November emphasis and examples | Proposed | user | Phase 0 (P02/P03) | [experience spec](specs/experience.md#landing) |
| [D-12](#d-12) | Guest allowance values | Proposed | user | Gate C (pilot values); retuned at L05 from pilot measurements | [economics](specs/economics.md#capacity-and-spend-ceilings) (values), [data and API](specs/data-and-api.md#allowance-quotas-and-rate-limits) (enforcement), [experience](specs/experience.md#allowance-and-limits) (UX) |
| [D-13](#d-13) | What happens at the allowance limit | Open | user | Gate D | [experience spec](specs/experience.md#allowance-and-limits) |
| [D-14](#d-14) | Review mode and latency metric | Proposed | user | Gate A (range), Gate D (mode switch per scene type) | [render spec](specs/render-pipeline.md#latency-budget), [quality spec](specs/quality-and-benchmark.md#pilot-evaluation) |
| [D-15](#d-15) | Street View source modes and licensing outcomes | Proposed | user (records outcomes) | User's licensing track; Gate C/D | [address spec](specs/address-and-street-view.md#street-view-source-modes) |
| [D-16](#d-16) | Interim public address experience | Proposed | user | Gate C | [address spec](specs/address-and-street-view.md#licensing-outcomes-and-activation), [experience spec](specs/experience.md#address-entry-and-confirmation) |
| [D-17](#d-17) | Audience and age | Proposed | user + counsel | Phase 0 (P05) | [privacy spec](specs/privacy-safety-legal.md#audience-and-age) |
| [D-18](#d-18) | People in uploaded photos | Open | user + counsel | Phase 0 (P05) | [uploads spec](specs/uploads.md#people-in-photos), [privacy spec](specs/privacy-safety-legal.md#content-policy-and-admission) |
| [D-19](#d-19) | Content policy, screening and child safety | Proposed | user + counsel | Gate C | [privacy spec](specs/privacy-safety-legal.md#child-safety-reporting), [uploads spec](specs/uploads.md#content-admission) |
| [D-20](#d-20) | Retention schedule | Open | user + counsel | Phase 0 (P04) | [privacy spec](specs/privacy-safety-legal.md#retention-schedule) |
| [D-21](#d-21) | Accounts and sign-in | Proposed | user | M06 | [experience spec](specs/experience.md#saving-accounts-and-sharing), [data and API](specs/data-and-api.md#http-api) |
| [D-22](#d-22) | Sharing and downloads | Proposed | user | M09 | [experience spec](specs/experience.md#saving-accounts-and-sharing), [privacy spec](specs/privacy-safety-legal.md#data-handling-rules) |
| [D-23](#d-23) | Saved-project address storage | Proposed | user + counsel | Phase 0 (P05) | [address spec](specs/address-and-street-view.md#saved-projects-and-address-storage) |
| [D-24](#d-24) | Product relationships and style kits | Proposed | user + commercial | P01 with K04 and C02 | [commerce spec](specs/commerce.md#product-relationships) |
| [D-25](#d-25) | Merchant onboarding and commerce activation | Proposed | user + commercial | C05 and L04 | [commerce spec](specs/commerce.md#merchant-onboarding) |
| [D-26](#d-26) | Advertising disclosure | Proposed | user + counsel | C03 | [commerce spec](specs/commerce.md#disclosure) |
| [D-27](#d-27) | Business decision rules | Proposed | user | Gate D (rules); L05 (applied after the minimum sample) | [economics spec](specs/economics.md#decision-rules) |
| [D-28](#d-28) | AI provenance and labeling | Proposed | user | S05 | [render spec](specs/render-pipeline.md#provenance-and-labeling) |
| [D-29](#d-29) | Brand and domain | Open | user | P08 (by Gate D) | [PLAN §12](PLAN.md#12-risks-and-open-questions) |
| [D-30](#d-30) | Toolchain and module format | Proposed | engineering lead | B01 | [architecture](architecture.md#conventions-from-the-reference-repositories) |
| [D-31](#d-31) | Package boundaries | Proposed | engineering lead | B01 | [architecture](architecture.md#packages-and-boundaries) |
| [D-32](#d-32) | API framework and validation | Proposed | engineering lead | B01 | [architecture](architecture.md#packages-and-boundaries) |
| [D-33](#d-33) | Database and migrations | Proposed | engineering lead | B02 | [architecture](architecture.md#environments-and-deployment) |
| [D-34](#d-34) | Job queue | Proposed | engineering lead | B04 | [architecture](architecture.md#jobs-and-queue) |
| [D-35](#d-35) | Web stack | Proposed | engineering lead | B01 | [architecture](architecture.md#repository-layout) |
| [D-36](#d-36) | Landing and share-page delivery | Proposed | engineering lead | M01 | [architecture](architecture.md#landing-and-share-page-delivery) |
| [D-37](#d-37) | Hosting, storage and environments | Proposed | engineering lead | B02 | [architecture](architecture.md#environments-and-deployment) |
| [D-38](#d-38) | Google API topology and pre-render spend controls | Proposed | engineering lead | B05 | [architecture](architecture.md#security-architecture), [address spec](specs/address-and-street-view.md#pre-render-spend-controls) |
| [D-39](#d-39) | Address precision and viewpoint geometry | Proposed | engineering lead | F01 | [address spec](specs/address-and-street-view.md#property-resolution-and-precision) |
| [D-40](#d-40) | Viewpoint adjustment UI | Open | user + engineering lead | F10 (Gate A) | [address spec](specs/address-and-street-view.md#viewpoint-adjustment), [experience spec](specs/experience.md#address-entry-and-confirmation) |
| [D-41](#d-41) | Upload formats and HEIC | Open | engineering lead + counsel | F09 (before B06) | [uploads spec](specs/uploads.md#accepted-formats-and-heic) |
| [D-42](#d-42) | Image-edit provider | Open | user + engineering lead | Gate A (F06) | [quality spec](specs/quality-and-benchmark.md#provider-comparison), [research](research/image-ai-providers.md#candidate-shortlist) |
| [D-43](#d-43) | Vision-language model for analysis and QA | Open | engineering lead | F08 (Gate A) | [render spec](specs/render-pipeline.md#model-roster), [quality spec](specs/quality-and-benchmark.md#qa-judge-calibration) |
| [D-44](#d-44) | Content-safety vendors | Open | engineering lead + counsel | S01 | [uploads spec](specs/uploads.md#content-admission), [privacy spec](specs/privacy-safety-legal.md#child-safety-reporting) |
| [D-45](#d-45) | Analytics and error tracking | Proposed | engineering lead | B14 and O01 | [architecture](architecture.md#observability-and-operations) |
| [D-46](#d-46) | Test stack | Proposed | engineering lead | B01 | [architecture](architecture.md#continuous-integration-and-testing) |
| [D-47](#d-47) | Capability and activation records | Proposed | engineering lead | B03 | [architecture](architecture.md#external-integrations-and-fixture-modes), [data and API](specs/data-and-api.md#entities) |
| [D-48](#d-48) | Email delivery provider | Open | engineering lead | M06 (decided as its first step) | [architecture](architecture.md#external-integrations-and-fixture-modes) |
| [D-49](#d-49) | Product thesis: simple, beautiful, emotional | Fixed | user | 2026-11-09 | [PLAN §1](PLAN.md#1-product-promise) |

## Fixed decisions

The user set D-01 to D-07 on 2026-11-08 and D-49, the product thesis, on 2026-11-09. They are requirements, not recommendations. The records below explain what each one means for the build, and [traceability](traceability.md#interpretations-of-the-brief) shows how the plan reads each phrase of the original request ([original_prompt.txt](original_prompt.txt)).

### D-01

**Monorepo**

- **Status:** Fixed · owner: user · 2026-11-08.
- **Decision:** A pnpm monorepo with `apps/*` and `packages/*`, modeled on `~/nodejs/pulse` and `~/moontography/dynamic-liquidity`.
- **Rationale:** The user asked for this structure because it makes code easy to reuse and makes it easy to add new apps and features. Both reference repositories have a private root package, a pinned pnpm version in `packageManager`, the two workspace globs, `@scope/name` packages consumed through `workspace:*`, `tsc` builds, a root `eslint .`, and no Turborepo. The two references differ in places (module format, what "core" means, landing delivery, queue, tests). Holiday therefore copies the shared pattern and records each deliberate difference as its own decision ([D-30](#d-30) to [D-37](#d-37), [D-45](#d-45), [D-46](#d-46)).
- **Alternatives considered:** A build orchestrator such as Turborepo or Nx. Neither reference uses one, and root pnpm scripts with filters and workspace concurrency give the same benefits.
- **Consequences:** B01 scaffolds `apps/web`, `apps/api`, `apps/workers`, `packages/core` and `packages/server` ([D-31](#d-31)). New apps join `apps/*` and never import each other. Fresh version pins are chosen at scaffold time rather than copied from either reference, because the references disagree with each other ([architecture](architecture.md#conventions-from-the-reference-repositories)).
- **Settles when / what would change it:** Fixed. Only the user changes it.

### D-02

**US-first geography**

- **Status:** Fixed · owner: user · 2026-11-08.
- **Decision:** The US Release supports US addresses. International support comes later through extensible contracts.
- **Rationale:** Each country needs its own address and imagery adapters, holiday calendar, merchant programs and legal review, and Google Maps Platform terms vary by billing-account address ([Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms), retrieved 2026-11-08). Starting with one country lets every one of those be validated once, while country-coded contracts keep later markets from requiring a rewrite.
- **Alternatives considered:** Launching in several countries at once. That multiplies the validation work before the core experience is proven, and the user chose to start with the US.
- **Consequences:** English copy, USD, US merchant offers and one US `country_capabilities` row ([D-47](#d-47)). Non-US addresses return `ADDRESS_OUT_OF_SCOPE` with an upload option. The single home for how later countries are added is [architecture: international extension boundaries](architecture.md#international-extension-boundaries).
- **Settles when / what would change it:** Fixed. Only the user changes it. The next country is chosen from demand under Later expansion.

### D-03

**Street View path in the initial build**

- **Status:** Fixed · owner: user · 2026-11-08.
- **Decision:** The path from address to Street View to AI decoration to before/after is built now. Street View licensing is the user's parallel track, and engineering is not blocked by it. Public activation follows the grants actually received ([D-15](#d-15)).
- **Rationale:** The address-first experience is the user's core vision. Google's terms forbid storing Street View images and creating content based on Google Maps Content, and they contain no clause that addresses AI editing. Only Google Sales can grant an exception ([Maps Platform Terms](https://cloud.google.com/maps-platform/terms) §3.2.3(a)–(c); [Street View policies](https://developers.google.com/maps/documentation/streetview/policies); both retrieved 2026-11-08). Building the path now against fixtures and Street View-shaped photos means the product is ready to switch on as soon as a grant exists, and a license request can describe a working system.
- **Alternatives considered:** Waiting for the license before building, or shipping only uploads for exteriors. The user rejected both. The interim public behavior ([D-16](#d-16)) covers the period before a grant.
- **Consequences:** Engineering builds and fixture-tests all four Street View source modes. "Engineering-complete" (fixture mode with automated tests) is kept separate from "live-validated" and "publicly activated" ([glossary](glossary.md#scope-and-delivery-terms)). Licensing outcomes, activation and the request brief are specified once, in [address spec: licensing outcomes and activation](specs/address-and-street-view.md#licensing-outcomes-and-activation) and [licensing request brief](specs/address-and-street-view.md#licensing-request-brief).
- **Settles when / what would change it:** Fixed. Only the user changes it. Licensing outcomes change activation through [D-15](#d-15), not this decision.

### D-04

**Uploads in the US Release**

- **Status:** Fixed · owner: user · 2026-11-08.
- **Decision:** The US Release accepts uploads of interiors, apartment entries, balconies and exteriors. No address is required.
- **Rationale:** The user asked for "home/apartment/place of living". An address cannot show a private interior, and a multi-unit facade does not identify a unit, so a photo of the actual space is the only honest source for these places. Uploads also give the renderer a native-resolution source rather than the 640×640 Street View maximum, and they need no Street View license.
- **Alternatives considered:** Treating uploads as a fallback only. Interiors and balconies are first-class scene types, not fallbacks.
- **Consequences:** The upload path is a full path through the same render pipeline, with its own formats, screening and people handling ([D-18](#d-18), [D-19](#d-19), [D-41](#d-41)). Rendering uploads live needs only an image-edit vendor account ([architecture](architecture.md#external-integrations-and-fixture-modes)). Multi-unit addresses route to `skip_to_upload`.
- **Settles when / what would change it:** Fixed. Only the user changes it.

### D-05

**Affiliate commerce direction**

- **Status:** Fixed · owner: user · 2026-11-08.
- **Decision:** The revenue direction is affiliate commerce with popular vendors.
- **Rationale:** This is the user's stated business model: show decorations from popular stores and earn a commission when users buy through affiliate links.
- **Alternatives considered:** Subscriptions or paid renders as the primary model. These are not the direction. They remain only as pre-authorized levers under [D-27](#d-27).
- **Consequences:** Products are labeled honestly by relationship ([D-24](#d-24)), disclosed before any click ([D-26](#d-26)) and activated per merchant program ([D-25](#d-25)). The canonical economics illustration shows that affiliate commission alone does not cover generation cost under its assumptions, so the pilot measures real rates and [D-27](#d-27) chooses levers ([economics](specs/economics.md#sensitivity)).
- **Settles when / what would change it:** Fixed. Only the user changes it.

### D-06

**Landing and interaction**

- **Status:** Fixed · owner: user · 2026-11-08.
- **Decision:** A simple seasonal hero for the upcoming holiday (in mid-November a Thanksgiving dining-room scene, in mid-December a Christmas scene), one prominent address input that accepts any address, a quieter upload route, easy switching of address and holiday, and a dead simple experience overall.
- **Rationale:** This is the user's description of the first screen and the core interaction, including both seasonal examples.
- **Alternatives considered:** None. The plan's job is to keep the experience this simple while honoring the safety, cost and licensing constraints.
- **Consequences:** The friction budget, screens and copy are specified in the [experience spec](specs/experience.md#friction-budget). "Most popular upcoming holiday" becomes an editorial calendar ([D-09](#d-09)). Switching is bounded by the guest allowance ([D-12](#d-12)). The mid-November mismatch between an interior hero and an exterior result is handled by [D-11](#d-11).
- **Settles when / what would change it:** Fixed. Only the user changes it.

### D-07

**Real photos, faithfully decorated**

- **Status:** Fixed · owner: user · 2026-11-08.
- **Decision:** Decorate real photographs explicitly and in fine detail while preserving the place. Never present a synthesized house or a neighbor's building as the user's place.
- **Rationale:** The user asked for "the clearest picture(s)" of the real property, decorated "very explicitly, specifically, and in fine, clear detail". The product is only valuable, and only honest, if the result is recognizably the user's own place.
- **Alternatives considered:** Generating an idealized house in the user's style. It is cheaper and prettier, but it breaks the promise and misleads.
- **Consequences:** Every variant starts from the original source, never from a previous output. Ambiguous matches need confirmation. Generated images carry the "AI preview" label. A structured plan, deterministic prompt compilation and QA checks govern rendering ([render spec](specs/render-pipeline.md#quality-checks)). No automated check can prove a property unchanged, so the plan never claims 100% fidelity.
- **Settles when / what would change it:** Fixed. Only the user changes it.

### D-49

**Product thesis: simple, beautiful, emotional**

- **Status:** Fixed · owner: user · 2026-11-09.
- **Decision:** Holiday exists to pull on people's emotions very simply, easily and with very little friction: it recreates their own spaces decorated for a holiday, and that feeling nudges them toward buying items to decorate those spaces themselves. Because people could already do this with general AI tools, product-market fit and the most important feature are that the experience is simple, beautiful and emotional ([PLAN §1](PLAN.md#1-product-promise); REQ-12). Beautiful means hyperrealistic: every image on the platform, wherever it appears (landing heroes, examples, previews, share cards), looks like a real photograph of real homes, rooms and landscapes, and nothing is illustrated, cartoon-like or animated.
- **Rationale:** The user set this on 2026-11-09 to make the product's purpose explicit and to steer every build choice. Decorating a photo with AI is available to anyone; what a general tool does not give is an effortless path from an address or one photo to a beautiful, faithful and moving picture of one's own place, with the right products one tap away.
- **Alternatives considered:** Competing on capability with free-text prompts, object-level editing and many controls. Rejected: it adds friction and recreates what general AI tools already offer.
- **Consequences:** Every trade-off favors simplicity, beauty and emotional impact over breadth of features: no prompts, at most one blocking step before the first render ([friction budget](specs/experience.md#friction-budget)), reviewed and art-directed holiday packs, the first reveal of the visitor's own place as the central moment ([experience principles](specs/experience.md#experience-principles)), and Shop the look after that moment with honest labels and no pressure. The private pilot measures all three qualities ([pilot evaluation](specs/quality-and-benchmark.md#pilot-evaluation)). Safety, honesty and legal obligations are unchanged and are presented with the same care.
- **Settles when / what would change it:** Fixed. Only the user changes it.

## Proposed product decisions

These are the plan's recommended defaults for product behavior. The build proceeds on them unless the user amends them. Each record names the evidence that would change it.

### D-08

**US holiday catalog**

- **Status:** Proposed · owner: user + editorial · settled by Phase 0 (P03).
- **Decision:** Halloween, Thanksgiving (US) and Christmas. New Year's Eve is included only if its content passes review. Other holidays are later packs.
- **Rationale:** These three are the main US home-decorating occasions. For example, NRF projects $4.3B of 2026 Halloween spending on decorations ([NRF](https://nrf.com/media-center/press-releases/nrf-halloween-survey-shows-consumer-spending-expected-to-reach-13-5-billion), retrieved 2026-11-08). Each holiday needs a reviewed pack, style kits, hero and example art, and benchmark coverage, so the catalog is kept to what can be done well. Release packs are secular by default, and religion is never inferred from an address, name or image.
- **Alternatives considered:** Shipping additional traditions (for example Hanukkah, Diwali, Lunar New Year, Easter, July 4th) in the US Release. Each would need its own reviewed content and art, so they are later packs that a user explicitly selects.
- **Consequences:** The pack model is region-keyed and versioned, so new traditions are content additions, not code changes ([holidays spec](specs/holidays-and-content.md#holiday-packs)). In the US Release, packs are repository files validated in CI and published at deploy, so an editorial change goes through review and a deploy. A holiday is never advertised until its pack passes review.
- **Settles when / what would change it:** Accepted when P03 approves the packs. It changes if a pack fails review (New Year's Eve drops out) or if pilot demand shows another holiday matters more.

### D-09

**Windows, timezone and off-season**

- **Status:** Proposed · owner: user · settled by Phase 0 (P03).
- **Decision:** Each holiday has a promotion window, with the values in the [holidays spec](specs/holidays-and-content.md#windows-and-selection). The server resolves the hero and the default in America/New_York, and the client does not recompute them in the visitor's timezone. Off-season shows a neutral hero and does not auto-start a render until a holiday is chosen.
- **Rationale:** No objective "most popular upcoming holiday" exists, so the plan uses an editorial calendar that keeps the user's examples (November 15 shows Thanksgiving, December 15 shows Christmas). Halloween decor shoppers start early: NRF reports that 49% start shopping in September or earlier ([NRF](https://nrf.com/media-center/press-releases/nrf-halloween-survey-shows-consumer-spending-expected-to-reach-13-5-billion), retrieved 2026-11-08). One editorial timezone gives the server-rendered hero a stable cache key ([D-36](#d-36)), and recomputing on the client keeps visitors in other US timezones correct at boundaries. Off-season, auto-starting would spend a render on a holiday the visitor did not choose.
- **Alternatives considered:** Proximity-only selection, which picks the nearest date regardless of decorating behavior. Computing boundaries server-side in each visitor's timezone, which defeats the shell's cache key. Auto-rendering the next holiday off-season, which spends money without intent.
- **Consequences:** Selection precedence, the worked calendar for 2026 to 2028 and the boundary rule live in the [holidays spec](specs/holidays-and-content.md#worked-calendar). Commerce windows are separate and owned by the [commerce spec](specs/commerce.md#seasonal-commerce-calendar).
- **Settles when / what would change it:** Accepted at P03. It changes if pilot or search data shows that a window starts too late or ends too early, or if merchant shipping cut-offs require different commerce timing.

### D-10

**Style and lighting defaults**

- **Status:** Proposed · owner: user · settled by Gate A.
- **Decision:** Styles are `subtle`, `classic` and `abundant`, with `classic` as the default. The default lighting mode is `source`. `evening` is offered after the first result for the `house_exterior`, `balcony` and `interior` sections of Christmas, Halloween and New Year's Eve, and for Thanksgiving interiors. `apartment_entry` offers `source` only in the US Release. For Street View-origin sources, whether `evening` is offered also depends on the recorded grant (configuration per source kind, with the pack as the upper bound). `evening` becomes a default only if the benchmark lighting arm passes its decision rule. Thanksgiving exteriors use no electric lights.
- **Rationale:** Street View and most photos are captured in daylight, where decor lights read weakly, so evening is where lights-centric holidays look best. However, an evening relight changes pixels outside the decoration regions. That defeats paste-back compositing and raises the risk of structural drift ([render spec](specs/render-pipeline.md#compositing-and-resolution)); the plan therefore relights the accepted daylight variant with a relight-only edit instead of decorating and relighting in one edit (the live-quality redesign entry of the 2026-11-09 decision log). The plan also measures it before making it a default. Three named styles and no free-text prompts ([PLAN §7](PLAN.md#7-decorating-with-ai)) keep the controls simple and the outputs reviewable. Thanksgiving exterior decor is harvest and porch styling, not light displays.
- **Alternatives considered:** `evening` as the Christmas default without measurement, which risks shipping the least faithful variant as the headline result. A third "night" mode, which drifts further from the source. Continuous sliders, which cannot be benchmarked.
- **Consequences:** The benchmark includes a lighting arm with its own decision rule ([quality spec](specs/quality-and-benchmark.md#statistics-and-decision-rules)). Per-holiday lighting policy lives in the [holidays spec](specs/holidays-and-content.md#lighting-policy), and mode definitions live in the [render spec](specs/render-pipeline.md#lighting-modes).
- **Settles when / what would change it:** Gate A, from the lighting arm. If `evening` passes for a holiday and scene type, it may become that combination's default. If it fails, it stays an optional control or is withheld.

### D-11

**Mid-November emphasis and examples**

- **Status:** Proposed · owner: user · settled by Phase 0 (P02/P03).
- **Decision:** Keep the Thanksgiving hero and the address input ([D-06](#d-06)). During the Thanksgiving window, invite a dining-room or table photo more strongly on the landing and result screens. Publish one permissioned before/after example per holiday and scene type, shown behind "See an example" and during waits.
- **Rationale:** The mid-November hero promises a candlelit dining room, while the address path renders an exterior where Thanksgiving decor is modest (wreath, garland, pumpkins). The headline journey therefore shows its weakest output exactly when the hero sets the highest expectation. A stronger photo invitation steers people toward the scene that matches the promise without changing the user's landing. Examples show what to expect before any money is spent.
- **Alternatives considered:** Changing the mid-November hero to an exterior, which contradicts D-06. A dramatic Thanksgiving exterior treatment, which is a hypothesis to benchmark, not a default.
- **Consequences:** Experience copy and placement live in the [experience spec](specs/experience.md#landing). Example art and its rights records live in the [holidays spec](specs/holidays-and-content.md#hero-and-example-art). The benchmark reports appeal by holiday and scene type so the emphasis can be checked against evidence.
- **Settles when / what would change it:** Accepted at P02/P03. It changes if the benchmark shows Thanksgiving exteriors scoring as well as interiors on appeal, or if pilot participants ignore the photo invitation.

### D-12

**Guest allowance values**

- **Status:** Proposed · owner: user · settled by Gate C (pilot values); retuned at L05 from pilot measurements.
- **Decision:** Each owner (anonymous session or account) gets 3 accepted variants per rolling 24 h. Cached variants are free, and rejected or failed jobs do not consume allowance. Each owner may also start 3 new addresses and 8 paid attempts per 24 h. A device/IP backstop allows 6 render requests per 24 h per dimension, with separate settings for the device (`quota.render_requests_per_device_24h`) and the IP (`quota.render_requests_per_ip_24h`). All values are configuration. [Economics](specs/economics.md#capacity-and-spend-ceilings) holds the values, [data and API](specs/data-and-api.md#allowance-quotas-and-rate-limits) holds the enforcement points, and the [experience spec](specs/experience.md#allowance-and-limits) holds the UX.
- **Rationale:** Switching holiday, style and address is part of the core interaction ([D-06](#d-06)), so a single free preview would contradict the user's request. Accepted variants per completing visitor is the largest variable-cost lever in the economics model, and each extra variant costs several times the illustrated affiliate revenue per visitor ([economics](specs/economics.md#sensitivity)). Three looks covers the default render plus two deliberate changes. Counting only `succeeded` jobs means users never pay for the system's failures. The allowance (a product policy), abuse quotas, rate limits and spend ceilings are kept separate so each has its own error code and copy. The device/IP backstop is a signal, not an identity.
- **Alternatives considered:** One preview, which breaks toggling. Two looks, the tightest value that still allows one holiday change. Unlimited previews, which the economics cannot support.
- **Consequences:** `ALLOWANCE_EXHAUSTED` carries `resetsAt` and `permittedActions`. The remaining allowance appears in `GET /v1/experience` so the counter shows before a tap. The pilot measures accepted variants per completing visitor. Under `APP_ENV=development` the seeded defaults are 30 accepted variants, 30 new addresses, 60 paid attempts and 300 device/IP render requests (and 200 sessions per IP per 10 minutes) so that one person can test locally; staging, production and test use the values above, and the mechanism and overrides are in [data and API](specs/data-and-api.md#allowance-quotas-and-rate-limits). An amendment of D-12 changes the specified values only, never the development profile.
- **Settles when / what would change it:** Confirmed for the pilot at Gate C and retuned at L05 from pilot measurements: the distribution of variants per completing visitor, allowance-reached rate, contribution per visitor, and abuse signals.

### D-14

**Review mode and latency metric**

- **Status:** Proposed · owner: user · settled by Gate A (range) and Gate D (mode switch per scene type).
- **Decision:** In the private pilot, a person reviews each result before delivery (`needs_review`). In the public rollout, automated QA gates delivery, and a sample of delivered results is audited afterwards (sample rate in the [quality spec](specs/quality-and-benchmark.md#pilot-evaluation)). The switch is made per scene type once that scene type meets its calibration and reviewer-agreement criteria; lagging scene types stay in `needs_review` during capped rollout. The latency metric is the automated-path p90 of `qaPassedAt − max(requestedAt, sourceReadyAt)`, with an aspiration of 60 s and a decision range of 60–120 s fixed from Phase 1 measurements. Human-review wait is reported separately.
- **Rationale:** No automated check can prove a property unchanged, so pilot results get a human check, and the review decisions become calibration labels for the QA judge ([quality spec](specs/quality-and-benchmark.md#qa-judge-calibration)). A latency target that included human review would be meaningless, so the metric measures only the automated path. A pipeline of analysis, plan, render, check and an occasional repair is serial. A 60 s p90 at the target acceptance rates needs a first-attempt median of about 40 s or less ([render spec](specs/render-pipeline.md#latency-budget)), which is not yet measured, so the plan commits to a range rather than a single promise.
- **Alternatives considered:** Post-delivery audit from the first pilot user, which delivers unreviewed results before the judge is calibrated. Pre-delivery review at public scale, which cannot meet a latency goal and does not scale. A single fixed 60 s target, which is unproven.
- **Consequences:** The render state machine includes `needs_review`, used only when pilot review mode is on ([render spec](specs/render-pipeline.md#lifecycle-state-machines)). The waiting UI has an honest label for review ([experience spec](specs/experience.md#waiting-and-progress)). Phase 1 records per-stage timings.
- **Settles when / what would change it:** Gate A fixes the latency range from measurements. Gate D switches the review mode for each scene type whose judge calibration and reviewer agreement meet the criteria and whose pilot audit results support it. Other scene types stay pre-delivery, and L05 revisits them on the same criteria.

### D-15

**Street View source modes and licensing outcomes**

- **Status:** Proposed · owner: user (records outcomes) · settled by the user's licensing track and Gates C/D.
- **Decision:** Four Street View source modes, `persist`, `transient`, `display_only` and `unavailable`, are derived from the evaluated AssetPermission. Licensing outcomes map to modes as follows: a full grant gives `persist` or `transient` as the grant allows; a partial grant is mapped clause by clause; a denial gives `display_only`; an unknown outcome gives `display_only` for live traffic while fixtures continue. Only Google-attributed imagery goes to models. Screens that show Google imagery have no shop panel unless the grant covers it (the `commerceAdjacent` use).
- **Rationale:** This is the licensing caveat for the whole plan. Under standard terms, Holiday may not store Street View images, may cache only the panorama ID, may not create content based on Google Maps Content and may not use it to augment an advertising product ([Maps Platform Terms](https://cloud.google.com/maps-platform/terms) §3.2.3(a)–(d); [Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)). Google's Geo Guidelines also bar analyzing or extracting information from Street View imagery ([Geo Guidelines](https://about.google/brand-resource-center/products-and-services/geo-guidelines/)). No clause addresses AI editing, and only Google Sales can grant exceptions (all retrieved 2026-11-08). The outcome is unknown, so behavior must change by configuration, not code. A stored copy never receives Google's later homeowner blurs ([Street View privacy](https://www.google.com/streetview/privacy/), retrieved 2026-11-08), which is why `persist` needs revalidation. Contributor imagery is not covered by Google's automatic face and plate blurring, and its rights sit with the contributor, so by default it is display-only.
- **Alternatives considered:** Storing Street View images by default, which is non-compliant. Disabling the address path until a grant exists, which contradicts [D-03](#d-03) and [D-06](#d-06). Higher-resolution Google products (Map Tiles Street View tiles, Aerial View, Solar, Photorealistic 3D Tiles), which forbid analysis or derivation or do not fit the use ([research](research/address-and-imagery.md#alternatives-considered)).
- **Consequences:** Engineering builds and fixture-tests all four modes. The outcome matrix, the activation procedure and the request brief are specified once in the [address spec](specs/address-and-street-view.md#licensing-outcomes-and-activation). The user records each outcome as a dated log entry, together with `asset_policies` and `country_capabilities` changes ([D-47](#d-47)). Until a grant is recorded, the public address path is the interim experience ([D-16](#d-16)).
- **Settles when / what would change it:** Each licensing outcome the user records. The user also sets a trigger (a date or event) at which an unanswered request is treated as denied. Gate C and Gate D check that configuration matches the recorded outcome.

### D-16

**Interim public address experience**

- **Status:** Proposed · owner: user · settled by Gate C.
- **Decision:** Until `street_view_ai` is `live_public`, the address path shows the Street View image (display only) to confirm the place, then asks for the user's own photo of the front to decorate.
- **Rationale:** Showing the Static API image in the app with Google attribution is ordinary use of the service (counsel to confirm). It keeps the address-first landing ([D-06](#d-06)) and confirms the right property, while the AI decoration uses a photo the user is entitled to edit. Fixture or sample imagery is never shown as the address's photo, and the copy never suggests a screenshot, which the Geo Guidelines prohibit ([Geo Guidelines](https://about.google/brand-resource-center/products-and-services/geo-guidelines/), retrieved 2026-11-08).
- **Alternatives considered:** Hiding the address input until licensing, which breaks D-06. Upload-only, which loses the place confirmation. Decorating Street View pixels without a grant, which is not allowed.
- **Consequences:** `display_only` mode is a complete, tested journey (Journey A′ in [PLAN §4](PLAN.md#4-experience-overview)), with its own copy and the `SOURCE_NOT_EDITABLE` code (`details.reason: display_only`; [error codes](specs/data-and-api.md#error-codes)). The Static API spend controls still apply because each displayed view is billed.
- **Settles when / what would change it:** Gate C confirms which address experience the pilot uses, based on the recorded licensing outcome. When `street_view_ai` becomes `live_public`, Journey A replaces the interim experience by configuration.

### D-17

**Audience and age**

- **Status:** Proposed · owner: user + counsel · settled by Phase 0 (P05).
- **Decision:** Adults 18+. The service is not directed to children. A passive line sits under the address input ("By continuing you confirm you're 18 or older and agree to the Terms"). An explicit checkbox at first upload combines the age and photo-rights confirmations. No age estimation. Counsel reviews.
- **Rationale:** The Gemini API terms require users to be 18+ and bar apps "directed towards or likely to be accessed by" under-18s ([Gemini API terms](https://aistudio.google.com/docs/terms), retrieved 2026-11-08). OpenAI's guidance requires safeguards for minors and zero data retention before processing under-13 data ([OpenAI under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance), retrieved 2026-11-08). COPPA reaches general-audience sites on actual knowledge, and photos of children are personal information ([FTC COPPA FAQ](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions), retrieved 2026-11-08). Vertex AI is not a route around the Gemini restriction: the Google Cloud Service Specific Terms carry the same under-18 clause for Generative AI Services ([Service Specific Terms](https://cloud.google.com/terms/service-terms), retrieved 2026-11-08; counsel confirms the reading). Estimating age would create exactly that knowledge, so the plan does not estimate. A passive line keeps the landing simple ([D-06](#d-06)), and the checkbox appears only when a photo is first uploaded.
- **Alternatives considered:** An age wall on the landing, which adds friction before any value. No stated audience, which leaves provider eligibility and COPPA posture undefined.
- **Consequences:** Hero art, packs and kits follow not-directed-to-children guardrails ([holidays spec](specs/holidays-and-content.md#climate-culture-and-existing-decorations)). Attestations are recorded with timestamp and policy version. Provider selection checks age terms ([D-42](#d-42)).
- **Settles when / what would change it:** Accepted at P05 with counsel's memo. It changes if counsel finds the design likely to be accessed by minors under a provider's terms, or if the selected provider requires stronger age assurance.

### D-19

**Content policy, screening and child safety**

- **Status:** Proposed · owner: user + counsel · settled by Gate C.
- **Decision:** Decline non-dwelling subjects, nudity, documents and IDs. Run CSAM hash matching and a classifier before any paid call. Keep a documented NCMEC reporting procedure. Vendor refusals are terminal for that input.
- **Rationale:** Screening before the paid call keeps prohibited content away from vendors and avoids paying for edits that will be refused. A service provider that obtains actual knowledge of apparent child sexual abuse material has federal reporting and preservation duties (18 U.S.C. §2258A). Counsel confirms how they apply ([privacy spec](specs/privacy-safety-legal.md#child-safety-reporting)). A repair would resubmit the same input, so a vendor refusal ends that input's path instead of triggering a retry.
- **Alternatives considered:** Relying on the image vendor's own moderation. That sends every upload to the vendor first, pays for refusals and leaves no reporting procedure.
- **Consequences:** The upload admission stage and its order of checks live in the [uploads spec](specs/uploads.md#content-admission). The content policy and incident procedure live in the [privacy spec](specs/privacy-safety-legal.md#content-policy-and-admission). Vendor selection is [D-44](#d-44). Gate C requires screening live, the hold mechanism tested and a reporting drill completed.
- **Settles when / what would change it:** Accepted when counsel signs off before Gate C. It changes if counsel's reading of the reporting duty changes the procedure or the hold periods.

### D-21

**Accounts and sign-in**

- **Status:** Proposed · owner: user · settled by M06.
- **Decision:** Accounts are optional. Email magic link is the only sign-in method in the US Release, and the "Save" flow doubles as sign-in. Google sign-in is a later option.
- **Rationale:** The first preview must need no account ([D-06](#d-06)). A magic link needs no password storage, and it turns "Save" into a single step. Pulse's OAuth building blocks remain available if Google sign-in is added later.
- **Alternatives considered:** Passwords, which add credential storage and reset flows. Google sign-in in the US Release, which adds a consent screen and another Google dependency.
- **Consequences:** An email provider is required ([D-48](#d-48)). The endpoints are `POST /v1/auth/magic-link` and `POST /v1/auth/verify` ([data and API](specs/data-and-api.md#http-api)). Saving moves the current anonymous project to the account.
- **Settles when / what would change it:** Accepted at M06. It changes if pilot users abandon at the email step or ask for Google sign-in.

### D-22

**Sharing and downloads**

- **Status:** Proposed · owner: user · settled by M09.
- **Decision:** Sharing uses explicit share grants with opaque tokens. Shares never include the address, can be revoked, and expire after 30 days by default; a share pins only the shared derivative. Upload-origin variants can be downloaded. Street View-origin variants can be shared or downloaded only if the grant allows `distributeDerivative`.
- **Rationale:** Addresses never appear in share links or pages. Without pinning, the 24-hour anonymous expiry would break every guest share. Sharing a Street View-derived image off the site is distribution outside Google's services, and the Geo Guidelines bar promotional uses ([Geo Guidelines](https://about.google/brand-resource-center/products-and-services/geo-guidelines/), retrieved 2026-11-08), so it depends on the grant. Upload-origin images come from the user's own photo.
- **Alternatives considered:** Public galleries or address-keyed pages. These create a residential address directory, enable harassment and conflict with §3.2.3(d)(iii). Shares that never expire, which retain derivatives indefinitely.
- **Consequences:** The share page shows no product links ([D-26](#d-26)) and carries the "AI preview" label ([D-28](#d-28)). Revocation returns 410 and purges the CDN. Downloaded copies cannot be recalled and never receive later Google blurs, and the share flow says so.
- **Settles when / what would change it:** Accepted at M09. It changes with the licensing outcome (Street View sharing scope) or if retention decisions ([D-20](#d-20)) change the expiry.

### D-23

**Saved-project address storage**

- **Status:** Proposed · owner: user + counsel · settled by Phase 0 (P05).
- **Decision:** Persist the Google place ID, which may be cached. On save, obtain the display address by Geocoding the place ID and store it per owner under the Geocoding caching terms. Keep Places coordinates for at most 30 days. Counsel reviews the end-user personal-data clause.
- **Rationale:** Google's caching terms let Places results keep only latitude and longitude, for up to 30 days, plus the place ID. Geocoding results may keep a formatted address indefinitely only to support the end-user-facing function, and only isolated per end user ([Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms), retrieved 2026-11-08). Storing the Places address string would break the first rule, and Geocoding by place ID satisfies the second. The terms also say the customer will not provide end users' personal information to Google (§4.4(c)(ii)). Counsel interprets what that means for typed addresses.
- **Alternatives considered:** Re-resolving with Place Details on every return, which bills every visit and stores no address. Treating the autocomplete selection as user-owned data, which is viable only with counsel's agreement.
- **Consequences:** Field-level storage, coordinate expiry and renewal on return are specified in the [address spec](specs/address-and-street-view.md#saved-projects-and-address-storage). Retention follows [D-20](#d-20).
- **Settles when / what would change it:** Accepted at P05 with counsel's review. It changes if counsel reads the caching clause or §4.4(c)(ii) differently.

### D-24

**Product relationships and style kits**

- **Status:** Proposed · owner: user + commercial · settled by P01 with K04 and C02.
- **Decision:** Products use the relationship enum `similar`, `described`, `reference` and `verified`. There is one versioned style kit per holiday and scene type. Specs are written in our own words, and no merchant images or merchant text go into prompts. The panel is named "Shop the look".
- **Rationale:** A model-drawn wreath is no evidence that a retailer's wreath appears in the image, so matching items after rendering (`similar`) is a weak link. Using merchant images as model inputs is blocked for Amazon: its Program Content may not be stored, cached, altered or used to develop models ([Amazon Associates policies](https://affiliate-program.amazon.com/help/operating/policies), retrieved 2026-11-08). Describing each kit item in our own words from public attributes, and checking afterwards that the render follows the description, gives a stronger link that needs no new rights.
- **Alternatives considered:** `similar` only, which is the weakest link to what users see. Merchant-image references in the US Release, which Amazon's policies forbid and which other programs would need to permit individually. Kits per style instead of per scene type, which triples catalog size.
- **Consequences:** Styles select subsets of a kit. Kit content lives in the [holidays spec](specs/holidays-and-content.md#style-kits) and product mapping in the [commerce spec](specs/commerce.md#style-kits-and-products). A failed adherence check downgrades an item or hides it. `reference` and `verified` are later capabilities. The cross-holiday offer row (`crossHolidayRow`) is off by default; turning it on needs a decision-log entry under this decision ([commerce spec](specs/commerce.md#seasonal-commerce-calendar)).
- **Verify:** that in-house attribute specs are not merchant Program Content (counsel, during P05 and K04).
- **Settles when / what would change it:** Accepted at P01, confirmed when K04 approves the kits and C02 implements the relationships. It changes if adherence rates are too low for `described` to be honest, or if counsel's reading of merchant content rules differs.

### D-25

**Merchant onboarding and commerce activation**

- **Status:** Proposed · owner: user + commercial · settled by C05 and L04.
- **Decision:** Commerce activates per merchant program, independently of public rollout (Gate D can pass with commerce off). Open network accounts early (Impact, CJ, Rakuten and others as needed); apply to each merchant program only once the public site meets that program's prerequisites; submit to Amazon Associates only when three qualifying sales within 180 days are plausible. Use manually curated links until API access is granted.
- **Rationale:** An Amazon applicant has 180 days to refer three qualifying sales, or the application is withdrawn. The Creators API, which replaces the deprecated PA-API 5, requires at least 10 qualifying sales in the trailing 30 days ([Amazon Associates help](https://affiliate-program.amazon.com/help/node/topic/G7MJTPEP9NC3YKMG); [Creators API](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction); both retrieved 2026-11-08). Networks approve at their own discretion ([Walmart affiliate FAQ](https://affiliates.walmart.com/page/faqs), retrieved 2026-11-08). Merchants want traffic and public traffic wants merchants. Making commerce independent of Gate D removes that circular dependency.
- **Alternatives considered:** Applying to Amazon at the start, which risks withdrawal before traffic exists. Waiting for all merchant approvals before rollout, which deadlocks.
- **Consequences:** Each program carries a status (`planned` through `suspended`) and a `commerce:<merchantProgramId>` capability. The runbook lives in the [commerce spec](specs/commerce.md#merchant-onboarding). Program status changes are logged here.
- **Settles when / what would change it:** Accepted at C05 and confirmed at L04. It changes when program terms change, or when the Amazon application timing proves wrong.

### D-26

**Advertising disclosure**

- **Status:** Proposed · owner: user + counsel · settled by C03.
- **Decision:** A visible "Ad" label and a plain disclosure line sit next to Shop the look, before any click. Amazon's required sentence appears wherever Amazon links appear. Share pages show no product links.
- **Rationale:** The FTC expects material connections to be disclosed clearly and close to the recommendation. "Affiliate link" alone may not be understood, and "paid link" is given as an adequate example ([FTC endorsement guides FAQ](https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking), retrieved 2026-11-08). Amazon requires a specific statement ([Amazon Associates Operating Agreement](https://affiliate-program.amazon.com/help/operating/agreement), retrieved 2026-11-08). Share pages reach people who did not ask to shop, and they may carry Google-derived imagery, so they stay ad-free.
- **Alternatives considered:** A disclosure only in the footer or on a separate page, which is not "close to the recommendation".
- **Consequences:** Exact wording, sponsored labeling and placement are owned by the [commerce spec](specs/commerce.md#disclosure).
- **Settles when / what would change it:** Accepted at C03 with counsel's review. It changes if FTC guidance or program terms change.

### D-27

**Business decision rules**

- **Status:** Proposed · owner: user · settled by Gate D (rules) and L05 (applied after the minimum sample).
- **Decision:** The decision rules, minimum samples and pre-authorized levers live in the economics spec. The levers are a cheaper render tier that still passes the fidelity benchmark, paid looks or HD downloads, installer leads, and sponsored collections.
- **Rationale:** Under the canonical illustration, affiliate revenue per visitor is well below variable cost even at one accepted variant per completing visitor ([economics](specs/economics.md#sensitivity)). No credible home-decor affiliate conversion benchmark exists, so click, purchase and basket rates must be measured in the pilot. Agreeing the rules and levers in advance stops the pilot and rollout data from being read selectively.
- **Alternatives considered:** Deciding after the pilot without rules agreed in advance. Unlimited free renders funded by commission, which the illustration rules out. Commission-driven ranking, which the ranking integrity rules forbid ([commerce spec](specs/commerce.md#ranking-integrity)).
- **Consequences:** The pilot instruments clicks, attributed sales and cost per accepted variant per cohort. The thresholds live in the [economics spec](specs/economics.md#decision-rules).
- **Settles when / what would change it:** Gate D accepts the rules and confirms that they and the lever order stand, before any rollout data is read. They are applied at L05, the post-launch review, once the minimum sample in the [economics spec](specs/economics.md#decision-rules) exists and at least one merchant program is live; the private pilot is too small to reach it. Measured contribution chooses the lever.

### D-28

**AI provenance and labeling**

- **Status:** Proposed · owner: user · settled by S05.
- **Decision:** A visible "AI preview" label on results, share pages and share cards. Downloads carry a small burned-in "AI preview" corner mark by default (configuration; the user may turn it off). IPTC digital source type metadata on delivered files. In Phase 4, a Holiday-signed C2PA manifest, with the provider's manifest included as an ingredient where one exists.
- **Rationale:** Compositing and re-encoding strip vendor C2PA manifests, which are fragile metadata ([OpenAI content provenance](https://developers.openai.com/api/docs/guides/content-provenance.md); [Google content credentials](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/content-credentials); both retrieved 2026-11-08). The visible label is therefore the dependable signal. The California AI Transparency Act has been operative since 2026-08-02 for covered providers with over 1,000,000 monthly users ([AB 853](https://calmatters.digitaldemocracy.org/bills/ca_202520260ab853), retrieved 2026-11-08). Holiday is likely not covered at first, but its vendors are, and counsel confirms.
- **Alternatives considered:** Serving vendor files unmodified to keep their manifests, which conflicts with compositing and attribution. A visible label alone, with no machine-readable provenance.
- **Consequences:** Mechanics live in the [render spec](specs/render-pipeline.md#provenance-and-labeling) and policy in the [privacy spec](specs/privacy-safety-legal.md#ai-disclosure-and-provenance).
- **Settles when / what would change it:** Accepted at S05. It changes if AI-disclosure law starts to cover Holiday, or if vendors change their provenance signals.

## Proposed technical decisions

These are the engineering lead's recommended defaults. Each one follows a reference-repository precedent where one exists and names the deviation where it does not. Each is accepted as built when its settling item is Done, unless the user objects first ([how a decision changes status](#how-a-decision-changes-status)). The reference conventions are compared in [architecture](architecture.md#conventions-from-the-reference-repositories).

### D-30

**Toolchain and module format**

- **Status:** Proposed · owner: engineering lead · settled by B01.
- **Decision:** TypeScript in strict mode. ESM throughout, as a deliberate deviation from both references, which use CommonJS. Node 26 LTS, matching the references' Docker and CI images. pnpm 10, pinned through `packageManager`, plus a `.node-version` file.
- **Rationale:** `packages/core` is consumed by both the Vite browser app and Node services. A single ESM output avoids the dual CommonJS and ESM build that Dynamic Liquidity maintains for its core. Both references build and test on Node 26 images, but Dynamic Liquidity's `.node-version` and `engines` say 22, so the plan requires one Node version everywhere: `.node-version`, Dockerfiles and CI. pg-boss requires Node 22.12 or later ([D-34](#d-34)), which Node 26 satisfies.
- **Alternatives considered:** CommonJS to match the references, which would force interop shims in the browser-shared core. A dual build, which is extra work without a demonstrated consumer.
- **Consequences:** `tsconfig.base.json` uses an ESM module setting. Every package declares `"type": "module"` and an exports map ([architecture](architecture.md#packages-and-boundaries)).
- **Verify:** Node 26's LTS status and the latest pnpm 10 release when B01 scaffolds (engineering lead). Done 2026-11-09: Node 26 (Lithium) has been Active LTS since 2026-10-28 ([Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json), retrieved 2026-11-09). pnpm releases before 10.34.5 are affected by published advisories, including path traversal on install, a bypass of the lifecycle-script block and command injection through environment substitution ([GitHub advisory database](https://github.com/advisories?query=ecosystem%3Anpm+pnpm), retrieved 2026-11-09). The pin is therefore the latest 10.x release.
- **Pins (B01 scaffold, 2026-11-09):** Node 26 (`.node-version`, `engines`, `node:26-slim` images); pnpm 10.34.9; TypeScript 6.0.3, because typescript-eslint 8.72.1 does not yet support TypeScript 7; ESLint 10.14.0; Prettier 3.9.10; Vitest 5.1.0; Playwright 1.65.0; React 19.3.1; Vite 8.3.7; react-router 7.18.5; zustand 5.1.0; Fastify 5.12.8 with fastify-type-provider-zod 7.0.0; zod 4.6.7; Kysely 0.29.8 with pg 8.23.1; pg-boss 12.38.1; sharp 0.35.5. Security floors for transitive packages are `overrides` in `pnpm-workspace.yaml`.
- **Settles when / what would change it:** Accepted at B01. It changes if a required dependency cannot run as ESM on the chosen Node line.

### D-31

**Package boundaries**

- **Status:** Proposed · owner: engineering lead · settled by B01.
- **Decision:** B01 creates both `packages/core` (`@holiday/core`: browser-safe schemas, types, holiday logic and error codes) and `packages/server` (`@holiday/server`: Node-only database, migrations, policy evaluator, ledger, storage, queue, provider adapters, logger and config). Apps never import each other.
- **Rationale:** "core" means different things in the references. Pulse's `@pulse/core` is a Node-only server library (Kysely, pg, S3, logger, migrations) with no exports map. Dynamic Liquidity's core is a browser-safe SDK with an exports map. Holiday needs both: contracts shared with the browser, and server code shared by the API and the workers. Workers need the database from B04, so the server package must exist from the start, not be extracted later. There must be one AssetPermission evaluator, called at submission and again before every provider call.
- **Alternatives considered:** Putting persistence in `apps/api`, which would make workers import an app. Deferring `@holiday/server` until reuse appears, which duplicates the database client and provider adapters immediately.
- **Consequences:** The root `db:migrate` script targets `@holiday/server`. Provider adapters, with their fixture and live switch, request signing, SSRF-safe fetch and cost recording, live in one place ([architecture](architecture.md#packages-and-boundaries)).
- **Settles when / what would change it:** Accepted at B01. It changes only if a second deployable needs a narrower server package.

### D-32

**API framework and validation**

- **Status:** Proposed · owner: engineering lead · settled by B01.
- **Decision:** Fastify 5, following the Dynamic Liquidity precedent. zod schemas live in core and connect to Fastify through a zod type provider. Express is the alternative.
- **Rationale:** Dynamic Liquidity serves its API with Fastify 5. Built-in schema hooks, typed routes and pino logging fit a contract-first API. Neither reference has a runtime schema library, so this one is new to both. Defining schemas once in `@holiday/core` lets the web app and the API validate the same contracts, and it covers the SceneAnalysis, DecorationPlan and JudgeResult schemas the render pipeline needs.
- **Alternatives considered:** Express 5, the Pulse precedent, which has hand-written validation middleware. TypeBox, which integrates well with Fastify but is less common in browser code.
- **Consequences:** Error codes and payload schemas are shared types ([data and API](specs/data-and-api.md#conventions)). The logger is pino, with redaction ([architecture](architecture.md#observability-and-operations)).
- **Settles when / what would change it:** Accepted at B01. It changes if the zod type provider proves immature for Fastify 5 at scaffold time.

### D-33

**Database and migrations**

- **Status:** Proposed · owner: engineering lead · settled by B02.
- **Decision:** PostgreSQL, version 16 or later as the host offers. Kysely with pg. Numbered TypeScript migrations with an advisory lock in `@holiday/server`, run in the release phase (the Pulse pattern).
- **Rationale:** Pulse runs PostgreSQL 16, Kysely 0.28 with pg, and numbered TypeScript migrations through an advisory-locked migrator in Heroku's release phase. Dynamic Liquidity's idempotent `schema.sql` notes that it should move to Pulse's approach once destructive migrations arrive. Kysely gives typed queries without an ORM runtime, and pg-boss has a Kysely adapter for transactional enqueue ([D-34](#d-34)).
- **Alternatives considered:** Prisma or Drizzle, which add ORM layers with no reference precedent. An idempotent schema file applied on boot, which cannot handle destructive changes.
- **Consequences:** Production runs the compiled migrator before dynos boot ([architecture](architecture.md#environments-and-deployment)). Entities and indexes are specified in [data and API](specs/data-and-api.md#entities).
- **Settles when / what would change it:** Accepted at B02. It changes if the host's PostgreSQL version or extensions do not fit.

### D-34

**Job queue**

- **Status:** Proposed · owner: engineering lead · settled by B04.
- **Decision:** pg-boss 12.x with transactional enqueue through its Kysely adapter. There is no separate dispatcher process or handoff table. Each project has a singleton key, there is a dead-letter queue, and Postgres NOTIFY feeds SSE. graphile-worker is the alternative.
- **Rationale:** pg-boss lets `send()` join an existing transaction through adapters that include Kysely ([pg-boss adapters](https://pgboss.io/api/adapters); version 12.38.1 published 2026-11-05, Node 22.12 or later; retrieved 2026-11-08). The render job row, the spend reservation and the queue entry therefore commit or roll back together, which is the guarantee a separate dispatcher would otherwise provide. One database means one backup, one consistency model and no Redis. Dynamic Liquidity already uses Postgres NOTIFY to feed SSE.
- **Alternatives considered:** node-resque on Redis (the Pulse stack), which needs Redis plus a transactional handoff table and a dispatcher to keep the database and the queue consistent. A managed queue, which has the same consistency gap. graphile-worker, an equivalent in-Postgres option that is kept as the fallback.
- **Consequences:** The domain talks to a small `JobQueue` interface in `@holiday/server`, never to pg-boss directly. Domain idempotency (Idempotency-Key and one non-terminal job per project) stays in the domain. Infrastructure retries never buy another paid attempt ([architecture](architecture.md#jobs-and-queue); [render spec](specs/render-pipeline.md#repair-and-retries)). pg-boss is maintained by one person ([pg-boss](https://pgboss.io/), retrieved 2026-11-08), which is a known risk that the interface keeps cheap to replace.
- **Settles when / what would change it:** Accepted at B04. It changes if measured queue depth, multi-region workers or an independent need for Redis justifies another transport. In that case a transactional handoff mechanism has to be added deliberately.

### D-35

**Web stack**

- **Status:** Proposed · owner: engineering lead · settled by B01.
- **Decision:** React 19, Vite and react-router 7, with plain CSS (CSS modules allowed), a typed fetch wrapper, a small store (zustand) and no UI kit.
- **Rationale:** React 19, Vite and react-router 7 are the shared baseline of both references, and neither uses Tailwind, a component library or react-query. Pulse uses zustand and a hand-written typed fetch wrapper. The interface is deliberately quiet ([experience spec](specs/experience.md#experience-principles)), so a UI kit adds weight without benefit.
- **Alternatives considered:** Tailwind or a component library, which have no precedent and are heavier than the design needs. react-query, which is not needed for a handful of endpoints plus SSE.
- **Consequences:** Accessible combobox and slider components are built in-house to the patterns in the [experience spec](specs/experience.md#accessibility).
- **Settles when / what would change it:** Accepted at B01.

### D-36

**Landing and share-page delivery**

- **Status:** Proposed · owner: engineering lead · settled by M01.
- **Decision:** Fastify serves the built SPA from the same origin. `/` and `/s/:token` get a server-rendered HTML shell containing the hero `<img>` with dimensions, a preload hint, inline experience JSON and OG tags. Hero and example assets live in object storage behind a CDN. The alternative is a prerendered static page per season.
- **Rationale:** With a plain SPA, the hero would appear only after HTML, then JavaScript, then an API call, then the image: four steps on the LCP path. The shell puts the hero in the first response, which serves the LCP ≤ 2.5 s, INP ≤ 200 ms and CLS ≤ 0.1 targets at p75 ([web.dev Web Vitals](https://web.dev/articles/vitals), retrieved 2026-11-08). Share pages need per-token OG tags, which requires server rendering either way. Pulse serves its SPA from the API process in the same way. Pulse keeps a separate static landing app because its app sits behind sign-in and its landing needs crawlable review content. Holiday's landing is the app's own entry point, so one process is simpler.
- **Alternatives considered:** A prerendered page per season selected at the CDN edge, where every hero change needs a deploy and share pages still need a server. A plain SPA, which has the slow LCP path. A separate static landing app (Pulse), which duplicates assets and state.
- **Consequences:** The shell's cache key rolls at window boundaries ([D-09](#d-09)). A worker generates share cards. Revocation returns 410 and purges the CDN ([architecture](architecture.md#landing-and-share-page-delivery)).
- **Settles when / what would change it:** Accepted at M01. It changes if measured LCP misses the target with the shell.

### D-37

**Hosting, storage and environments**

- **Status:** Proposed · owner: engineering lead · settled by B02.
- **Decision:** Heroku container stack, as in both references: a web dyno serving the API and SPA, a worker dyno, and release-phase migrations. Heroku Postgres. A private S3 bucket for uploads and outputs, accessed through signed URLs. A public CDN (CloudFront) for hero, example and share-card assets. RustFS, an S3-compatible server, locally. Separate dev, staging and production accounts, buckets and keys.
- **Rationale:** Both references deploy to Heroku's container stack with scripted builds, and Pulse's release-phase migration is the more robust of the two patterns. S3 is the only object-storage precedent. Private images never pass through a shared CDN cache. Only public assets do. An S3-compatible emulator in docker-compose is new to both references, and it lets fixture mode run entirely on a laptop. RustFS is Apache-2.0 licensed and actively maintained ([rustfs/rustfs](https://github.com/rustfs/rustfs), retrieved 2026-11-09). Locally it was verified for presigned POST with `content-length-range`, presigned GET, bucket policy and bucket CORS.
- **Alternatives considered:** Other platforms (container services on AWS or GCP, or serverless), which have no precedent, more operations work, and no release-phase convention. MinIO as the local emulator, the original choice: its community repository is archived ([minio/minio](https://github.com/minio/minio), retrieved 2026-11-09) and its images could not be pulled from Docker Hub or Quay at scaffold time.
- **Consequences:** Deploy scripts follow the references' flags. Environments map to activation states: local runs in `fixture` mode, staging may run `live_private`, production may run `live_public` ([architecture](architecture.md#environments-and-deployment)).
- **Settles when / what would change it:** Accepted at B02. It changes if the dyno memory limits do not fit image decoding, or if a license requires a specific processing region.

### D-38

**Google API topology and pre-render spend controls**

- **Status:** Proposed · owner: engineering lead · settled by B05.
- **Decision:** All Places, Geocoding and Street View metadata and fetch calls go through the server. The browser holds only a referrer-restricted key enabled solely for the Street View Static API, used for server-signed display URLs, plus a Maps JavaScript key only if [D-40](#d-40) adopts one. Cloudflare Turnstile runs at session creation. Per-session limits and per-SKU daily ceilings apply, with values in the [address spec](specs/address-and-street-view.md#pre-render-spend-controls).
- **Rationale:** Autocomplete, Place Details and Static images all cost money before any render is requested. A proxy can throttle, challenge and write every call to the ledger, which a browser key cannot. Autocomplete sessions that end with a Place Details Essentials call bill the first 12 requests. Abandoned sessions bill per request. Ending a session with non-Essentials fields bills at the Enterprise + Atmosphere rate ([Places session pricing](https://developers.google.com/maps/documentation/places/web-service/session-pricing), retrieved 2026-11-08). So the server requests Essentials fields only. Turnstile's free plan has unlimited challenges ([Turnstile plans](https://developers.cloudflare.com/turnstile/plans/), retrieved 2026-11-08). Static API signatures do not expire per URL, so the display key relies on restrictions and quotas ([digital signature](https://developers.google.com/maps/documentation/streetview/digital-signature), retrieved 2026-11-08).
- **Alternatives considered:** The Maps JavaScript autocomplete element with a browser key, which has no server throttle or ledger and relies on client-controlled referrers. reCAPTCHA Enterprise, which is paid above its free tier. No challenge at all, which leaves paid endpoints open to bots.
- **Consequences:** The key inventory and the challenge flow live in [architecture: security](architecture.md#security-architecture). `VERIFICATION_REQUIRED` and `RATE_LIMITED` are distinct codes. Per-SKU ceilings degrade gracefully (autocomplete falls back to manual entry, discovery to upload) instead of failing silently.
- **Settles when / what would change it:** Accepted at B05. It changes if abuse tests show the challenge placement is too weak or too visible.

### D-39

**Address precision and viewpoint geometry**

- **Status:** Proposed · owner: engineering lead · settled by F01.
- **Decision:** Place Details (New) requests Essentials fields only. The Geocoding API supplies `location_type` and `partial_match`. Geocoding v4 SearchDestinations supplies building outlines and entrances for heading and fov when available.
- **Rationale:** Essentials fields keep Place Details at the lowest SKU. Geocoding's `location_type` and `partial_match` separate rooftop-precision results from interpolated ones, which match confidence needs ([D-15](#d-15)). Building outlines and entrances let the server aim the camera at the facade rather than at the API's default heading, and they are billed as Geocoding ([SearchDestinations](https://developers.google.com/maps/documentation/geocoding/search-for-destinations), retrieved 2026-11-08). Geometry-based signals avoid analyzing Street View pixels, which the licensing track has not cleared.
- **Alternatives considered:** Leaving the heading to the Static API's default aim. Requests instead always go by panorama ID with an explicit heading, computed toward the building geometry when available and otherwise toward the resolved point, with the heading source recorded ([address spec](specs/address-and-street-view.md#viewpoint-selection)). Reading house numbers from imagery, which is allowed only when `aiProcess` is permitted and is never required.
- **Consequences:** The viewpoint algorithm and the match-confidence signals are specified in the [address spec](specs/address-and-street-view.md#viewpoint-selection). The coverage probe measures the SearchDestinations hit rate.
- **Verify:** SearchDestinations' launch stage and terms before relying on it in production (engineering lead, F01).
- **Settles when / what would change it:** Accepted when F01 shows the hit rate and precision split (with the F02 coverage probe as supporting evidence). It changes if SearchDestinations is pre-GA or rarely returns outlines.

### D-45

**Analytics and error tracking**

- **Status:** Proposed · owner: engineering lead · settled by B14 and O01.
- **Decision:** A first-party event table in Postgres, with no third-party trackers or ad pixels in the US Release. Sentry with PII scrubbing for errors. Sentry is a new subprocessor and is listed in the privacy policy.
- **Rationale:** Analytics events never contain addresses, image URLs, prompts or photos ([data and API](specs/data-and-api.md#analytics-events)). A first-party table enforces that and keeps data out of ad networks, which also simplifies the US privacy-law position ([privacy spec](specs/privacy-safety-legal.md#us-privacy-law)). Neither reference has an error-tracking SDK. Both rely on bunyan and Heroku logs, which is not enough for a consumer product.
- **Alternatives considered:** Third-party product analytics, which adds pixels, subprocessors and address-leak risk. No error tracking, which leaves failures invisible.
- **Consequences:** Dashboards are SQL over the event table. Sentry scrubbing is tested ([architecture](architecture.md#observability-and-operations)).
- **Settles when / what would change it:** Accepted at B14 and O01. It changes if growth needs attribution that first-party events cannot provide, which would be a new decision with a privacy review.

### D-46

**Test stack**

- **Status:** Proposed · owner: engineering lead · settled by B01.
- **Decision:** Vitest for unit and integration tests. Playwright for browser tests. Contract fixtures for each integration leg. Golden files for prompt compilation.
- **Rationale:** Dynamic Liquidity uses Vitest. Pulse has no test framework, only standalone scripts, so it offers no precedent to follow. Contract fixtures are how the Street View path becomes engineering-complete without live pixels ([D-03](#d-03)). Prompt compilation is deterministic code, so golden files catch unintended changes.
- **Alternatives considered:** Jest, which has no reference precedent. Pulse-style scripts, which give no coverage or isolation tooling.
- **Consequences:** CI is to run automatically, unlike either reference ([architecture](architecture.md#continuous-integration-and-testing)); it is planned under B12 and does not exist yet, so the suites are run by hand until then ([development](development.md#tests)). The quality benchmark harness is separate ([quality spec](specs/quality-and-benchmark.md#formal-benchmark)).
- **Settles when / what would change it:** Accepted at B01.

### D-47

**Capability and activation records**

- **Status:** Proposed · owner: engineering lead · settled by B03.
- **Decision:** `country_capabilities` rows hold each capability's activation state with an evidence reference and a review date. They are enforced at runtime, and changes are audited. The US Release has one US row.
- **Rationale:** Licensing, vendor and merchant outcomes arrive on timelines outside engineering's control. Switching `fixture`, `live_private` and `live_public` by data, not by deploy, lets the user act on an outcome right away and leaves an auditable trail. Country-keyed rows are also how later markets are added ([D-02](#d-02)).
- **Alternatives considered:** Environment variables or feature flags, which carry no evidence, need redeploys and are hard to audit. A large international policy engine, which is premature.
- **Consequences:** Capability keys and activation states are defined in the [glossary](glossary.md#scope-and-delivery-terms). Fields are in [data and API](specs/data-and-api.md#entities). Every operator-made move to `live_public` is logged here. One deliberate local-only deviation (log entry of 2026-11-09): under `APP_ENV=development` the release-phase seed sets a standard-terms leg (`address_lookup`, `street_view_display`, `image_editing`, `vision_analysis`) to `live_public` when its provider resolves live from `.env` keys, so one person can test the live product without a pilot-role account. Those rows carry the evidence reference `seed:default-profile:development`, follow the keys on every re-seed unless an operator changed them, and are exempt from the log rule; `street_view_ai` never leaves `fixture` locally, and staging and production never seed a live state and follow the activation rules ([environments and deployment](architecture.md#environments-and-deployment)).
- **Settles when / what would change it:** Accepted at B03.

## Open decisions

These need a user decision or evidence that does not exist yet. Each runs on its stated default until the named backlog item or gate settles it.

### D-13

**What happens at the allowance limit**

- **Status:** Open · owner: user · settled by Gate D.
- **Decision (default until decided):** For the private pilot, "More looks tomorrow" with the reset time. The current result, comparison and every control stay usable.
- **Alternatives considered (options for public rollout):** (a) an optional account that grants extra looks, which reuses the magic-link flow ([D-21](#d-21)); (b) a clearly labeled paid-looks interest test that charges nothing.
- **Rationale:** Each option trades spend protection against exploration and revenue evidence. The default is the simplest honest behavior and fits the rolling 24-hour allowance. An account option deepens engagement and enables the seasonal return loop. An interest test is the cheapest signal of willingness to pay, and it needs no billing infrastructure.
- **Consequences:** The UX for every option is specified in the [experience spec](specs/experience.md#allowance-and-limits). The pilot records allowance-reached rates and funnel observations.
- **Settles when / what would change it:** Gate D chooses the public-rollout behavior from the pilot's allowance-reached rate, funnel observations and contribution per visitor; if option (b) is chosen, its card-action results feed [D-27](#d-27) at L05 and may re-open this decision.

### D-18

**People in uploaded photos**

- **Status:** Open · owner: user + counsel · settled by Phase 0 (P05).
- **Decision (default until decided, Option A):** Detection only: bounding boxes, with no face templates and no age estimation. If people are detected, suggest a one-tap crop. If the user proceeds uncropped, the variant is private-only, with no share or download link.
- **Alternatives considered (Option B):** Guidance and attestation only, with no detection.
- **Rationale:** Photos that show people are personal information, and photos of children are personal information under COPPA ([FTC COPPA FAQ](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions), retrieved 2026-11-08). Detection-only processing avoids storing face geometry, which matters under biometric laws such as BIPA. Counsel confirms. Age estimation is excluded because it would create actual knowledge ([D-17](#d-17)). Option A protects people in the frame at the cost of one detector call. Option B is simpler but relies entirely on the user.
- **Consequences:** The crop interaction and flags are specified in the [uploads spec](specs/uploads.md#people-in-photos). The legal posture is in the [privacy spec](specs/privacy-safety-legal.md#us-privacy-law). `PEOPLE_DETECTED` exists under Option A.
- **Settles when / what would change it:** P05, with counsel's memo on biometric and child-privacy exposure.

### D-20

**Retention schedule**

- **Status:** Open · owner: user + counsel · settled by Phase 0 (P04).
- **Decision (default until decided):** Anonymous projects are kept 24 h after last activity. Saved projects are kept until deleted or until 13 months without activity. Street View-derived data follows the grant. Redacted logs are kept 30 days. Backups are kept at most 30 days, with deletion re-applied after a restore.
- **Alternatives considered:** Saved projects kept 30 days, renewable on return (the stricter posture).
- **Rationale:** The 24-hour anonymous window matches the guest session. Thirteen months supports the natural return loop of the same address in the next year's season. A 30-day limit is the stricter privacy posture, but it is about the gap between Thanksgiving and Christmas and would lose year-to-year return. Re-applying deletions after a restore keeps deletion verifiable even with backups. Street View-derived data cannot outlive what the grant allows.
- **Consequences:** The schedule, mechanisms and deletion verification live in the [privacy spec](specs/privacy-safety-legal.md#retention-schedule), which also owns the companion defaults (the hard cap on anonymous projects, inactive-account deletion, deletion completion time, tombstones, the declined-upload blocklist and hashed signal retention). Share grants pin only the shared derivative ([D-22](#d-22)). Saved address storage follows [D-23](#d-23).
- **Settles when / what would change it:** P04, with counsel's review of state privacy law, provider retention and any license terms.

### D-29

**Brand and domain**

- **Status:** Open · owner: user · settled by P08 (by Gate D).
- **Decision (default until decided):** "Holiday" is a working name, used in code scopes (`@holiday/*`) and documents only.
- **Alternatives considered:** Candidate names come from naming research. None is shortlisted yet.
- **Rationale:** "Holiday" is a generic word. Its trademark and domain availability are unknown, and both affect the share pages and the merchant program applications.
- **Consequences:** No public-facing brand assets are final until this is decided. Renaming later touches copy, domains and program records, but not package scopes.
- **Settles when / what would change it:** P08, after naming research and trademark and domain review; Gate D requires the decision to be recorded.

### D-40

**Viewpoint adjustment UI**

- **Status:** Open · owner: user + engineering lead · settled by F10 (Gate A).
- **Decision (default until decided):** Up to 3 discrete candidate views, plus left and right nudges rendered as Static images.
- **Alternatives considered:** An embedded interactive panorama, evaluated in Phase 1 for pricing and terms. An optional confirmation map pin, which must be a Google map.
- **Rationale:** Discrete views reuse the Static API and stay within the per-address fetch cap. An embedded panorama is a different SKU with its own licensing posture, and reading the viewer's camera position to re-fetch through the Static API is not documented as allowed. Google forbids showing Street View with a non-Google map on the same screen (§3.2.3(e), [Maps Platform Terms](https://cloud.google.com/maps-platform/terms), retrieved 2026-11-08).
- **Consequences:** Nudges count against the Static fetch cap ([address spec](specs/address-and-street-view.md#viewpoint-adjustment)). If adopted, the panorama becomes part of the licensing request brief. Adoption at Gate A schedules the panorama as Later expansion after the US Release ships with discrete views; bringing it into the US Release requires the user to amend [PLAN §3](PLAN.md#3-scope-of-the-us-release) in the same log entry.
- **Settles when / what would change it:** F10, recorded at Gate A, from Phase 1 pricing, terms review and the discovery sample.

### D-41

**Upload formats and HEIC**

- **Status:** Open · owner: engineering lead + counsel · settled by F09 (before B06).
- **Decision (default until decided):** The server accepts only JPEG, PNG and WebP. The file input lists `image/jpeg` first, so iOS Safari transcodes HEIC. Other HEIC files are converted in the browser by a lazily loaded decoder. Servers never decode HEVC. Counsel reviews the HEVC decoder exposure.
- **Alternatives considered:** A custom libvips with libheif in the worker image.
- **Rationale:** sharp's prebuilt binaries cannot decode HEVC-encoded HEIC, because HEVC is patent-encumbered. Decoding it needs a self-built libvips with libheif and an HEVC decoder ([sharp install](https://sharp.pixelplumbing.com/install), retrieved 2026-11-08), which moves the patent question to Holiday. iOS Safari transcodes HEIC to the first type in the accept list, but this behavior is undocumented and varies by version ([WebKit bug 292350](https://bugs.webkit.org/show_bug.cgi?id=292350), retrieved 2026-11-08). The default therefore keeps decoding on the client and tests it on real devices.
- **Consequences:** The device test matrix and limits are specified in the [uploads spec](specs/uploads.md#accepted-formats-and-heic). `UPLOAD_UNSUPPORTED_FORMAT` carries helpful copy.
- **Settles when / what would change it:** The F09 device tests and counsel's review, before B06. It changes to the server-side alternative if browser conversion fails on common devices.

### D-42

**Image-edit provider**

- **Status:** Open · owner: user + engineering lead · settled by Gate A (F06, from the F03 formal benchmark).
- **Decision (default until decided):** No provider is selected; the formal benchmark runs the shortlisted candidates ([research](research/image-ai-providers.md#candidate-shortlist)) and F06 decides at Gate A. Until then a provisional live default applies wherever a live editor is configured (`IMAGE_EDITOR_PROVIDER=auto` is the default only in development; tests always run fixtures; decision log entry of 2026-11-09): OpenAI `gpt-image-2.5-flare` at quality `medium`, with no provider mask (`IMAGE_EDIT_PROVIDER_MASK=none`) and, in `source` lighting, a tight local paste-back with registration and photometric alignment ([compositing and resolution](specs/render-pipeline.md#compositing-and-resolution)); Google `gemini-nano-banana-2.1` at 1K with thinking `minimal` is the configured fallback. `auto` uses the editor whose key is present, and with both keys `IMAGE_EDITOR_PREFERENCE` (default `openai`) picks ([provider parameters](specs/render-pipeline.md#provider-parameters)). The provisional default is not the Gate A selection, and the bake-off behind it is not gate evidence ([exploratory spike](specs/quality-and-benchmark.md#exploratory-spike)). The selection applies these hard criteria: no training on inputs; acceptable retention or zero-data-retention terms; age terms compatible with [D-17](#d-17); US processing; commercial output rights. Per-source-kind routing is allowed if a license requires a specific processor.
- **Alternatives considered:** The candidates in the research shortlist are the options. If both OpenAI and Google fail terms or fidelity for private photos, a hosted or self-hosted open-weight model (for example Qwen-Image-Edit-2511, Apache 2.0) becomes a separate user decision, because it adds a subprocessor or self-hosting. Aggregators such as fal and Replicate are used only for benchmarking on permissioned images, never on user photos.
- **Rationale:** Public leaderboards rank general edit preference, not preservation of a specific building, so the formal benchmark decides ([quality spec](specs/quality-and-benchmark.md#provider-comparison)). Terms differ at model level. OpenAI's zero-data-retention list for image endpoints includes the GPT-Image-2.5 models but not 2.6 ([OpenAI your data](https://developers.openai.com/api/docs/guides/your-data), retrieved 2026-11-08). Black Forest Labs' API terms allow training on inputs ([FLUX API terms](https://bfl.ai/legal/flux-api-service-terms), retrieved 2026-11-08). The Gemini API carries an under-18 clause, and Vertex AI carries the same one ([D-17](#d-17)). A Street View grant may name the processor it permits, so routing by source kind is allowed.
- **Consequences:** The adapter isolates transport and operation tracking. Switching vendors still requires compiler and pack re-tuning plus a re-benchmark ([render spec](specs/render-pipeline.md#rendering)). An `evening` look is a relight-only edit of the accepted `source` variant, checked against that variant; a relight the checks reject after its repair ends the job rejected, and the deterministic relight is never delivered for a live editor, whatever the provider ([repair and retries](specs/render-pipeline.md#repair-and-retries), rule 10).
- **Verify:** zero-data-retention eligibility for the exact model snapshot selected, in writing where it is not listed (engineering lead, before Gate A).
- **Settles when / what would change it:** Gate A, by F06 from benchmark results, terms and cost. It reopens when a provider changes terms or the selected model is retired.

### D-43

**Vision-language model for analysis and QA**

- **Status:** Open · owner: engineering lead · settled by F08 (Gate A).
- **Decision (default until decided):** Claude Opus 5.5 (`claude-opus-5-5`, configuration `ANTHROPIC_VISION_MODEL`) runs scene analysis and the QA judge; escalated judging is the same model at a higher effort setting (`high` instead of `medium`), not a second model. Claude Sonnet 5.5 is the cheaper candidate to benchmark for analysis and judging, and Claude Haiku 5.5 the triage candidate (decision log entry of 2026-11-09). The same model also localizes the decorations the editor added ([Localizing](specs/render-pipeline.md#localizing)), and the upload triage runs on the vision leg (`vision_analysis`), not on the content-screening leg ([uploads](specs/uploads.md#adapters-and-fixture-mode)). Until Gate A, analysis and judging run against fixtures and permissioned photos only.
- **Alternatives considered:** Comparable OpenAI and Google vision models, compared on the same calibration sets.
- **Rationale:** Scene analysis and the QA judge need reliable structured output against zod schemas, and the Claude models support structured outputs ([Claude docs](https://platform.claude.com/docs); Anthropic model table cached 2026-10-06). The selection rests on the analysis and judge calibration targets ([quality spec](specs/quality-and-benchmark.md#qa-judge-calibration)), not on vendor preference. Analyzing Street View-sourced images with any model falls under the licensing track, so live Street View analysis is gated like editing, while uploads are unaffected ([D-15](#d-15)).
- **Consequences:** The roster, output contracts and recorded version fields are specified in the [render spec](specs/render-pipeline.md#model-roster). Per-call costs, including the measured Opus 5.5 costs, appear in the [economics cost worksheet](specs/economics.md#cost-worksheet). The judge thresholds in force were exercised with Opus 5.5 verdicts; a move to Sonnet 5.5 is a new configuration that must be calibrated before it gates delivery ([QA judge calibration](specs/quality-and-benchmark.md#qa-judge-calibration)).
- **Settles when / what would change it:** F08, recorded at Gate A, from analysis accuracy and judge calibration on benchmark outputs. It reopens on a model retirement or a calibration regression.

### D-44

**Content-safety vendors**

- **Status:** Open · owner: engineering lead + counsel · settled by S01.
- **Decision (default until decided):** Hash matching plus a moderation classifier, vendors not yet chosen. Until they are contracted, uploads run in `fixture` mode or for internal users only. Uploads from people outside the team require screening to be live ([D-19](#d-19)).
- **Alternatives considered:** For hash matching, Thorn Safer, Microsoft PhotoDNA or Google Content Safety API. For the moderation classifier, OpenAI moderation, AWS Rekognition or Google Cloud Vision SafeSearch.
- **Rationale:** [D-19](#d-19) requires both hash matching and a classifier before any paid call. Hash-matching programs have eligibility requirements, and cache-based scanning tools that operate at the CDN do not fit private screening before inference.
- **Consequences:** The admission stage order and costs live in the [uploads spec](specs/uploads.md#content-admission). Each vendor is a subprocessor listed in the privacy policy.
- **Verify:** eligibility, terms and pricing for each candidate (engineering lead with counsel, during S01).
- **Settles when / what would change it:** S01, when vendors are contracted and the reporting drill passes before Gate C.

### D-48

**Email delivery provider**

- **Status:** Open · owner: engineering lead · settled by M06 (decided as its first step).
- **Decision (default until decided):** The email adapter runs in `fixture` mode and captures messages locally, so magic-link sign-in can be built and tested.
- **Alternatives considered:** Postmark or Amazon SES.
- **Rationale:** Magic links ([D-21](#d-21)) and "email me my preview" depend on reliable delivery of transactional email. The provider is a new subprocessor, and CAN-SPAM applies to the messages ([privacy spec](specs/privacy-safety-legal.md#us-privacy-law)).
- **Consequences:** The adapter interface is listed in [architecture](architecture.md#external-integrations-and-fixture-modes).
- **Settles when / what would change it:** Decided as the first step of M06, on deliverability, cost and data terms.

## Decision log

Newest entries go at the bottom. The entry types and their required content are defined under [What the decision log records](#what-the-decision-log-records).

| Date | Type | IDs | Entry | Decided by |
| --- | --- | --- | --- | --- |
| 2026-11-08 | Decision | D-01–D-07 | Fixed by the user: monorepo, US-first geography, Street View path built now with licensing as the user's parallel track, uploads in the US Release, affiliate commerce direction, landing and interaction, real photos faithfully decorated. | user |
| 2026-11-09 | Decision | D-08–D-48 | Baseline register created, with the remaining decisions recorded as Proposed or Open as listed in the [decision register](#decision-register). None has been accepted yet. | planning baseline |
| 2026-11-09 | Decision | D-49 | Fixed by the user: the product thesis. Holiday must be simple, beautiful and emotional, because people could already decorate a photo with general AI tools; the emotion of seeing their own place transformed is what nudges them to decorate it themselves. Recorded as REQ-12 in PLAN §2 and stated in PLAN §1. | user |
| 2026-11-09 | Decision | D-49 | Clarified by the user: every image on the platform is hyperrealistic and photographic (real homes, dining rooms, landscapes), never illustrated, cartoon-like or animated. | user |
| 2026-11-09 | Decision | D-30 | Verify done at the B01 scaffold. Node 26 is Active LTS. Version pins recorded in the D-30 record. pnpm moves from 10.24.0 to 10.34.9: 10.24.0 is affected by advisories fixed in 10.34.5. TypeScript is 6.0.3 because typescript-eslint 8.72.1 does not support 7.x. Playwright is pinned to 1.65.0 by an override. Evidence: [D-30](#d-30) sources. | engineering lead |
| 2026-11-09 | Decision | D-37 | Local S3-compatible emulator changed. Old value: MinIO locally. New value: RustFS locally. MinIO's community repository is archived and its images could not be pulled; RustFS passed the presigned POST, GET, policy and CORS checks locally. Evidence: [D-37](#d-37) sources. Status stays Proposed until B02. | engineering lead |
| 2026-11-09 | Decision | D-30–D-39, D-45–D-47 | Implemented ahead of their settling items. The US Release code (B00 to B11, B13, B14, F04, A01 to A06, A08, A09, M01 to M10, M12, M13 and C01 to C04 exist as engineering-complete but unverified code; see [README Status](README.md#status)) builds these Proposed technical decisions on their defaults, but none of the settling items (B01 to B05, B14, M01, F01) is Done: there is no CI and no merged pull request ([definition of done](backlog.md#definition-of-done)). Acceptance as built is therefore deferred: each "accepted as built" entry is written when its settling item is Done. No value changes. | engineering lead |
| 2026-11-09 | Decision | D-42 | Provisional live default; status stays Open until the formal benchmark (F03) and the F06 decision at Gate A. Old value: no provider selected; development uses fixture adapters. New value: wherever a live editor is configured, OpenAI `gpt-image-2.5-flare` at quality `medium` with no provider mask and, in `source` lighting, a tight local paste-back with registration and photometric alignment; Google `gemini-nano-banana-2.1` (1K, thinking `minimal`) is the configured fallback; `IMAGE_EDITOR_PREFERENCE` defaults to `openai`. Evidence: the [model bake-off](development.md#model-bake-off) of 2026-11-09 with the owner's development keys (eight curated example photos from the licensed photo library, live Claude Opus 5.5 analysis and judge; live evidence, n = 8, neither the exploratory spike nor the formal benchmark, not gate evidence): Flare medium rendered 8 of 8, 6 of 8 judge-accepted, $0.025 per edit, $0.035 per judge call, $0.080 per accepted variant; Nano Banana 2.1 rendered 7 of 8 (one `camera_changed`), 3 of 7 accepted, $0.050 per edit, $0.036 per judge call, $0.216 per accepted variant; Claude analysis $0.041 per photo, outside the per-variant figures. Earlier runs the same day measured GPT image 2.5 Sunburst at `high` at $0.057 per edit before the mask fixes. Findings that changed the design: oversized composite masks (whole roof planes, 49% of one frame) let the model repaint homes, hence tight placement shapes and no provider mask; OpenAI rejects `input_fidelity` for the 2.5 models and needs an RGBA mask; Gemini rejects thinking level `low`; a model's evening global relight replaced a door and removed porch furniture, hence the evening keep clause and the deterministic relight fallback. Owner files updated: [render spec](specs/render-pipeline.md#provider-parameters), [economics](specs/economics.md#cost-worksheet), [development](development.md#live-mode). | engineering lead |
| 2026-11-09 | Decision | D-43 | Default model changed; status stays Open until F08. Old value: Claude Sonnet 5.5 for analysis and judging, Claude Opus 5.5 for escalated judging. New value: Claude Opus 5.5 for scene analysis and the QA judge, escalation the same model at effort `high`; Claude Sonnet 5.5 is the cheaper candidate to benchmark; Haiku 5.5 stays the triage candidate. Evidence: the [model bake-off](development.md#model-bake-off) of 2026-11-09 ran with Opus 5.5 (analysis $0.041 per photo, judge $0.035 to $0.036 per call, effort `medium`), and its judge verdicts informed the D-42 entry above; Sonnet 5.5 costs half as much per token and has not been compared. Owner files updated: [render spec](specs/render-pipeline.md#model-roster), [economics](specs/economics.md#cost-worksheet), [quality spec](specs/quality-and-benchmark.md#qa-judge-calibration). | engineering lead |
| 2026-11-09 | Decision | D-47 | Local-only deviation recorded. Under `APP_ENV=development` the seed sets `address_lookup`, `street_view_display`, `image_editing` and `vision_analysis` to `live_public` when their provider resolves live from `.env` keys, so one person can test the live product without a pilot-role account; the rows carry `seed:default-profile:development` and are exempt from the activation log rule. Staging and production never seed a live state and follow the activation rules. Evidence: `defaultCapabilityState` in `packages/server/src/capabilities` and its tests. Owner files updated: [D-47](#d-47), [environments and deployment](architecture.md#environments-and-deployment), [development](development.md#live-mode). | engineering lead |
| 2026-11-09 | Decision | D-10, D-42, D-43 | Live-quality redesign after the first live run on the owner's stack (OpenAI `gpt-image-2.5` editing, Claude Opus 5.5 vision). Statuses stay as they are (D-10 Proposed; D-42 and D-43 Open); three behaviors change. **(1) Source compositing keeps what the editor added.** Old value: the paste-back keep-mask was the union of the plan's tight shapes only. New value: after registration the vision model localizes the added decorations in the aligned candidate, and the keep-mask is the union of the plan's shapes and the localized boxes (each dilated by 1% of the long edge), minus privacy and legal exclusions only, capped at 50% coverage; everything else is restored from the original photo, so the fidelity guarantee is kept while placement follows the editor's composition. A failed localization falls back to the plan-only mask. **(2) Evening relights the accepted daylight variant.** Old value: an `evening` job decorated and relit in one edit, with the deterministic relight of the `source` composite as the fallback. New value: the evening variant is a relight-only edit (no mask) of the accepted daylight variant of the same key, so it shows the same decorations and the editor changes only the light; with no daylight variant the job renders and publishes that base first, then relights it. The deterministic relight is never delivered for a live editor and stays the fixture editor's relight so offline mode keeps working. A relight that fails its checks after its repair ends the job rejected, with nothing consumed, instead of delivering a poor image. The judge gained a `relight` mode and a plan-adherence rule that accepts a planned item in a different natural spot. **(3) Upload triage follows the vision leg.** Old value: the triage ran on the leg that `content_screening` resolves to, which is the fixture always locally, so real photos never got Claude's living-space, scene and people check and an unhinted file name pre-selected "A room inside / Living room". New value: the triage follows `vision_analysis`, charged as a `vision_call` (stage `screening`), with pause and spend gates that fall back to the fixture triage and record why, and an unhinted fixture file name returns no scene type. **Evidence (2026-11-09, live bungalow render, smoke run 3 and experiments A and B):** the editor's raw daylight output carried six decorations (a wreath, two lit potted trees flanking the door, a lantern, a garland spiraling the right column and a garland along the right rail); the plan-only paste-back kept the wreath and two garland fragments, because the plan had put the trees at the foot of the steps, and the judge rejected both attempts for `plan_not_followed`. Localizing with Claude Opus 5.5 returned tight boxes for all six decorations and listed the one unintended change (a rocking chair shifted left) in about 9 s for about $0.034, and the localized paste-back kept all six and restored the chair. The combined evening edit was rejected for `structure_changed`, and the deterministic relight of the daylight image produced flat orange rectangles over windows and across a column, darkened decorations and sparkle noise on white flowers. Relighting the decorated daylight image with a relight-only instruction and no mask preserved every object and decoration with both GPT image 2.5 Flare (about $0.025 per edit) and Sunburst (about $0.04) at `medium`, with glowing bulbs, warm windows and the porch light on. The triage had run on the fixture vision in 66 ms. n = 1 live property plus experiments: live evidence only, not Gate A evidence ([exploratory spike](specs/quality-and-benchmark.md#exploratory-spike)). Cost: a daylight attempt adds one localization call; an evening variant costs one relight edit and judge on top of an existing daylight variant ([cost worksheet](specs/economics.md#measured-live-costs)). Owner files updated: [render spec](specs/render-pipeline.md#localizing), [data model](specs/data-and-api.md#entities), [economics](specs/economics.md#measured-live-costs), [uploads](specs/uploads.md#adapters-and-fixture-mode), [development](development.md). | engineering lead |
| 2026-11-09 | Decision | D-12, D-10, D-15, D-42 | Final-round rules, recorded with their owner files. **(1) An evening request that renders its own daylight base counts as one look.** Old value: the companion daylight job counted toward the variant allowance like any other. New value: the companion job is excluded from the variant allowance and leaves no variant residue when its project is deleted; the request consumes one allowance unit and delivers two variants. The companion row is identified by `input_snapshot.relightBaseOf`, which only the pipeline writes, not by its idempotency key, which the client supplies. Owner files: [data model](specs/data-and-api.md#entities), [economics](specs/economics.md#measured-live-costs). **(2) A Street View panorama that answers `ZERO_RESULTS` or `NOT_FOUND` with no location evidence stays `missing`.** When the property's coordinates have expired (30 days) or were never kept, no location can be probed, so a panorama retired by newer imagery cannot be told from a removal and its variants are purged. This is the privacy-protective reading of the removal rule and an owner-visible consequence. The location probe around the property's target point uses a 60 m radius, above the 50 m first step of the discovery ladder; a panorama that only a wider search found (a deep setback) reads `missing` when it is retired. A failed or uninformative metadata call at render time fails the render and no longer marks the source stale. Owner files: [address and Street View](specs/address-and-street-view.md#revalidation-rules), [privacy](specs/privacy-safety-legal.md#street-view-privacy). **(3) Judge rule for decorate mode.** Old value: extra or relocated decorations could be judged `unrequested_change` or `plan_not_followed`. New value: additional decorations of the requested holiday and style in sensible places are neither; `unrequested_change` remains any change to what belongs to the home or the scene (an object removed, replaced, moved or restyled, repainting, landscaping, snow, season, sky, vehicles, bins) and any addition that is not a decoration; `plan_not_followed` means a key item missing, the wrong kind, holiday or style, or clearly fewer than planned. Evidence: the model bake-off found both editors adding matching garlands over both windows of an interior, which the judge rejected as `unrequested_change`, while the two genuine rejections (white urns replaced by trees, a table vase replaced by a centerpiece) were object replacements, which stay rejected. The judge prompt version is `judge-2026.11.3`. Owner files: [quality and benchmark](specs/quality-and-benchmark.md#major-failure-codes), [render spec](specs/render-pipeline.md#failure-codes). | engineering lead |
