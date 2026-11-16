# Glossary

The canonical vocabulary for the Hailiday plan. This file lists every product, domain, code and status term the other documents use, with its allowed values and a link to the section that sets its behavior. When a document, schema, API field or UI string needs a word for one of these concepts, it uses the term here and no other.

**Owns:** all project vocabulary: term names, enum values, ID schemes and retired synonyms. Behavior, rules and numbers stay in the linked owner sections.
**Baseline:** planning baseline 2026-11-09; external facts retrieved 2026-11-08.

## How to use this glossary

- Each table row gives the term, a one-sentence definition, its allowed values or code form, and its **owner**: the one section where its rules and numbers live. Follow the owner link for behavior. This file defines meaning only.
- `Code font` marks an exact identifier: an enum value, field, table, endpoint, error code or event name. Use it exactly as written in code, schemas, analytics and documents. Enum values are lowercase snake_case. JSON fields are camelCase and database columns are snake_case ([data conventions](specs/data-and-api.md#conventions)).
- Use US spelling everywhere, including identifiers such as `canceled`.
- A plain word in quotation marks is user-facing copy (for example "AI preview"). The experience spec's [copy deck](specs/experience.md#copy-deck) owns the final strings.
- When a limit, window or size applies to a term, it is configuration with a default, and the number lives in the owner section, not here.
- If a cross-document term is missing, add it here first, then use it. A term in [Retired terms](#retired-terms) must not appear in any other document.

## Scope and delivery terms

| Term | Definition | Values / code form | Owner |
| --- | --- | --- | --- |
| US Release | The first public product release: US addresses, uploads, the Street View path as far as its activation allows, English copy and USD offers. | — | [PLAN §3](PLAN.md#3-scope-of-the-us-release) |
| Later expansion | Work deliberately kept out of the US Release, such as other countries and later commerce capabilities. It is not a numbered phase. | — | [backlog](backlog.md#later-expansion), [architecture](architecture.md#international-extension-boundaries) |
| Phase | One of six delivery phases that build the US Release. PLAN and the backlog use identical names. "Phase N" always means a delivery phase and never a product release. | see [Phases](#phases) | [PLAN §11](PLAN.md#11-delivery-phases-and-gates) |
| Gate | A decision point where the product owner, advised by the engineering lead, checks the recorded evidence against a pass rule and logs the outcome in the [decision log](decisions.md#decision-log). | Gate A–D, see [Gates](#gates) | [backlog](backlog.md#gates) |
| Journey | A named path through the product, used in PLAN and the experience spec. | A (address, Street View AI active), A′ (address, interim experience), B (upload), C (variations and shopping), D (save, share, return) | [PLAN §4](PLAN.md#4-experience-overview) |
| Required fallback behavior | The table that maps each situation (no imagery, multi-unit, allowance reached and so on) to the experience it must produce. | — | [PLAN §4](PLAN.md#4-experience-overview) |
| Friction budget | The maximum number of blocking steps allowed before the first render on each path, plus where every notice is placed. | blocking, passive | [experience](specs/experience.md#friction-budget) |
| Product owner | The user who commissioned Hailiday. The product owner sets Fixed decisions, approves Proposed ones, decides every gate, and appears as "user" in owner columns. | — | [decisions](decisions.md#how-decisions-work) |
| Owner (of data) | The anonymous session or signed-in account that owns a project, render job, share grant or allowance. Both kinds share one `owners` row, the single foreign-key target for owned data. This is not the product owner. | anonymous session, user; `owners` | [data-and-api](specs/data-and-api.md#conventions) |
| Guest | A visitor with no account. The guest's data is owned by an anonymous session. | `anonymous_sessions` | [experience](specs/experience.md#saving-accounts-and-sharing) |
| Decision ID | The identifier of a recorded decision. | `D-01` … `D-52` | [decisions](decisions.md#decision-register) |
| Decision status | Where a decision stands. Fixed: set by the user. Proposed: the recommended default, which the build follows unless amended. Accepted: a Proposed decision the owner has approved. Open: needs a decision or evidence and has a stated default until then. | Fixed, Proposed, Accepted, Open | [decisions](decisions.md#how-decisions-work) |
| Requirement ID | A requirement from the product owner's original request ([original_prompt.txt](original_prompt.txt)) (REQ) or a derived requirement (NFR). | `REQ-01` … `REQ-12`, `NFR-01` … `NFR-09` | [PLAN §2](PLAN.md#2-requirements) |
| Interpretation | How the plan reads an ambiguous phrase in the original request, and why. | — | [traceability](traceability.md#interpretations-of-the-brief) |
| Backlog item ID | A prefix letter plus a two-digit number. | see [Backlog item prefixes](#backlog-item-prefixes) | [backlog](backlog.md#how-to-use-this-backlog) |
| Verify marker | The bold word **Verify:** followed by a concrete check and its owner. It flags a genuine uncertainty once. | — | [README](README.md#conventions) |

### Phases

| Phase | Name | Ends at |
| --- | --- | --- |
| Phase 0 | [Decide and prepare](backlog.md#phase-0-decide-and-prepare) | — |
| Phase 1 | [Feasibility](backlog.md#phase-1-feasibility) | Gate A |
| Phase 2 | [Foundations and both paths](backlog.md#phase-2-foundations-and-both-paths) | Gate B |
| Phase 3 | [Complete US experience](backlog.md#phase-3-complete-us-experience) | — |
| Phase 4 | [Commerce, safety and operations](backlog.md#phase-4-commerce-safety-and-operations) | Gate C |
| Phase 5 | [Pilot and rollout](backlog.md#phase-5-pilot-and-rollout) | Gate D, inside the phase, after the private pilot |

### Gates

| Gate | Name | Position | Passing opens |
| --- | --- | --- | --- |
| Gate A | Feasibility and provider decision | Exit of Phase 1 | Phase 2, built on the selected providers |
| Gate B | Both paths complete | Exit of Phase 2 | Phase 3 |
| Gate C | Private pilot readiness | Exit of Phase 4 | The private pilot |
| Gate D | Public rollout readiness | Inside Phase 5, after the private pilot | The capped public rollout |

The evidence, pass rules and failure branches for each gate are in the backlog's [Gates](backlog.md#gates) section and nowhere else.

### Activation and completion

| Term | Definition | Values / code form | Owner |
| --- | --- | --- | --- |
| Capability | A product function that is activated on its own, per country. | see [Capability keys](#capability-keys) | [architecture](architecture.md#external-integrations-and-fixture-modes), [D-47](decisions.md#d-47) |
| Activation state | How far a capability is switched on. `fixture`: contract-shaped fixtures and permissioned photos only. `live_private`: real providers, internal and pilot users only. `live_public`: real providers, public traffic. One local-only exception: under `APP_ENV=development` the seed sets a keyed standard-terms leg to `live_public` for single-person testing ([D-47](decisions.md#d-47)). | `fixture`, `live_private`, `live_public` | [architecture](architecture.md#external-integrations-and-fixture-modes) |
| `country_capabilities` | The runtime record, one row per country (only `US` in the US Release), holding each capability's activation state with an evidence reference and `reviewedAt`. Changes need no deploy and are audited. | table | [data-and-api](specs/data-and-api.md#entities), [D-47](decisions.md#d-47) |
| Engineering-complete | The function works end to end in `fixture` mode, with automated tests. | — | [backlog](backlog.md#definition-of-done) |
| Live-validated | The function has been verified in `live_private`, with recorded evidence. | — | [backlog](backlog.md#definition-of-done) |
| Publicly activated | The capability is `live_public`. | — | [architecture](architecture.md#external-integrations-and-fixture-modes) |
| Fixture evidence, live evidence | Results from `fixture` mode versus results from real providers. Every result is labeled as one or the other, and fixture success never counts as live validation. | — | [quality](specs/quality-and-benchmark.md#live-street-view-validation) |
| Contract fixture | A recorded or synthetic provider response in the shape of the real API contract, used in place of a live call. | — | [architecture](architecture.md#external-integrations-and-fixture-modes) |
| Permissioned photo | A real photo whose rights record allows AI processing (owner-consented, commissioned or licensed), used in development, fixtures and benchmarks. It is never customer data. | — | [quality](specs/quality-and-benchmark.md#permissioned-corpus) |
| Replayed render | A stored image-editor output returned in `fixture` mode in place of a paid call. | — | [architecture](architecture.md#external-integrations-and-fixture-modes) |

#### Capability keys

| Key | What activation enables |
| --- | --- |
| `address_lookup` | Address suggestions, resolution and manual-entry geocoding. |
| `street_view_display` | Showing Street View imagery for confirmation and as the before image. |
| `street_view_ai` | Sending Street View imagery to models and decorating it (Journey A). In development it defaults to `live_public` when the Street View provider and the image editor are live and `STREET_VIEW_USE_POLICY` is not `display_only`. |
| `uploads` | Accepting user photos as sources. |
| `image_editing` | Paid image-edit provider calls. |
| `vision_analysis` | Vision-model calls for scene analysis and the QA judge. |
| `content_screening` | Hash-matching and moderation vendor calls. |
| `sharing` | Creating share grants and serving share pages. |
| `commerce:<merchantProgramId>` | Shop the look offers from one merchant program. |

### Backlog item prefixes

| Prefix | Meaning | Usual phase |
| --- | --- | --- |
| P | Product decisions and preparation | Phase 0 |
| F | Feasibility | Phase 1 |
| B | Foundations and both source paths (`B00` is repository hygiene) | Phase 2 |
| A | AI pipeline | Phase 2 |
| M | Main US experience | Phase 3 |
| C | Commerce | Phase 4 |
| O | Operations and quality operations | Phase 4 |
| S | Safety, trust and legal | Set per item |
| K | Content: corpus, packs, kits, hero and example art | Set per item |
| L | Pilot and launch | Phase 5 |

The backlog sets each item's actual phase and dependencies.

## Places, sources and imagery

| Term | Definition | Values / code form | Owner |
| --- | --- | --- | --- |
| Project | One owner-scoped place being decorated: one resolved property, or one upload subject with no address. It holds source assets, the current holiday, style and lighting selections, and `projectVersion`. A different address creates a new project. A new photo or viewpoint of the same place stays in the same project. | `projects` | [render](specs/render-pipeline.md#concepts) |
| `projectVersion` | The optimistic-concurrency counter for the project's current source only. It increments when a source is bound or replaced, and never on a holiday, style or lighting change, so toggling back to an earlier choice returns the cached variant. A request that carries an older value fails with `STALE_PROJECT_VERSION`. | integer | [data-and-api](specs/data-and-api.md#idempotency-and-concurrency) |
| Property | The address-resolved target location of a project: place ID, target point and precision. | `properties` | [address](specs/address-and-street-view.md#property-resolution-and-precision) |
| Place ID | Google's identifier for a resolved place, and the address identifier Hailiday persists. | — | [address](specs/address-and-street-view.md#saved-projects-and-address-storage) |
| Display address | The human-readable address shown on a saved project. It is obtained on save by geocoding the place ID and stored per owner ([D-23](decisions.md#d-23)). | — | [address](specs/address-and-street-view.md#saved-projects-and-address-storage) |
| Target point | The coordinates of the property itself, not of the camera. They are kept only for a limited period. | — | [address](specs/address-and-street-view.md#property-resolution-and-precision) |
| Precision | How exactly the resolved location identifies one building, judged from Geocoding `location_type`, `partial_match` and place types. | — | [address](specs/address-and-street-view.md#property-resolution-and-precision) |
| Multi-unit | An address that resolves to a building with several dwellings or that carries a unit. Its facade is never decorated as "your home". | routes to `skip_to_upload` with `multi_unit` | [address](specs/address-and-street-view.md#property-resolution-and-precision) |
| Manual entry | Typed address fields, geocoded to a list of candidates when autocomplete fails. Manual entry never auto-starts a render. | `POST /v1/addresses/geocode` | [address](specs/address-and-street-view.md#manual-entry) |
| Geocode candidate | One address match returned by manual entry. The user picks one, and `POST /v1/addresses/resolve` accepts it in place of a place ID and session token. It is not a candidate viewpoint. | `candidateId` (signed token returned by `POST /v1/addresses/geocode`, accepted by `POST /v1/addresses/resolve`) | [data-and-api](specs/data-and-api.md#http-api) |
| Autocomplete session token | A UUID for one address search. It groups the suggestion requests and the resolution that ends them for billing. | `sessionToken` | [address](specs/address-and-street-view.md#address-entry) |
| Source discovery | The server step after resolution that finds candidate viewpoints and assigns a match class. | `source_discoveries`, `POST /v1/projects/:id/source-discovery` | [address](specs/address-and-street-view.md#viewpoint-selection) |
| Panorama | One Street View capture, identified by a pano ID and located where the camera stood, not at the house. | pano ID | [address](specs/address-and-street-view.md#viewpoint-selection) |
| Viewpoint | The Street View camera parameters for one image: pano ID, heading, pitch, fov and size (always 640×640). Images are always requested by pano ID with an explicit heading. The candidate's view is the source's identity; the frame the looks are made on is the framed view once the source is framed (see Framing). | `source_assets.viewpoint` | [address](specs/address-and-street-view.md#viewpoint-selection) |
| Heading mode | What the explicit heading was aimed at: the building geometry target, or the resolved point when no geometry is available. | `headingMode`: `geometry`, `point` | [address](specs/address-and-street-view.md#viewpoint-selection) |
| Candidate viewpoint | One viewpoint offered by discovery: a primary plus up to two alternates. | `candidateId` | [address](specs/address-and-street-view.md#viewpoint-selection) |
| Nudge | A bounded user adjustment to the heading or fov of the chosen candidate ([D-40](decisions.md#d-40) default). | — | [address](specs/address-and-street-view.md#viewpoint-adjustment) |
| Match confidence | The metadata and geometry signals that decide the match class, such as precision, panorama distance, capture age, imagery owner, multi-unit flag and blocked address. | — | [address](specs/address-and-street-view.md#match-confidence-and-auto-start) |
| Match class | The outcome of discovery, which decides the next step. | see [Match classes](#match-classes) | [address](specs/address-and-street-view.md#match-confidence-and-auto-start) |
| Source asset | One immutable source image record. Every variant starts from one. A Street View source asset is identified by (pano ID, heading, pitch, fov, size). If a refetch shows the panorama has changed, a new source asset is created and the user is told. | `source_assets`; kinds `street_view`, `upload`, `fixture` | [render](specs/render-pipeline.md#concepts) |
| Original | The source asset's image as admitted. It is never edited, and every variant is rendered from it, never from an earlier output. For an upload it is the normalized original. | — | [render](specs/render-pipeline.md#concepts) |
| Normalized original | The re-encoded, metadata-stripped copy of an upload that serves as its source image. It is the only stored copy of the upload. | — | [uploads](specs/uploads.md#server-side-validation) |
| Working image | The normalized derivative of the original that is sent to providers. | — | [render](specs/render-pipeline.md#compositing-and-resolution) |
| Source asset state | Where a source asset is in admission and retention. | see [Source asset states](#source-asset-states) | [render](specs/render-pipeline.md#lifecycle-state-machines) |
| Before image | The source image shown next to the preview. For Street View sources it is a server-signed Static API image shown with attribution and capture date. | — | [address](specs/address-and-street-view.md#before-image-and-attribution) |
| Display URL | A server-signed Street View Static API URL, built from the pano ID (never from an address), that the browser loads. | `displayUrl` | [address](specs/address-and-street-view.md#before-image-and-attribution) |
| Transient fetch | Fetching Street View pixels into worker memory for one job, then discarding them. | — | [address](specs/address-and-street-view.md#street-view-source-modes) |
| Capture date | The Street View metadata date (year and month, or year only) shown with the image. | `captureDate` | [address](specs/address-and-street-view.md#before-image-and-attribution) |
| Google attribution | The Google Maps logo or text plus the per-image copyright. It is shown next to any Street View image or derivative and never covered or cropped. | `copyright` | [address](specs/address-and-street-view.md#before-image-and-attribution) |
| Google-attributed imagery | Street View imagery whose metadata copyright identifies Google. All other imagery is contributor imagery. | `isGoogleImagery` | [address](specs/address-and-street-view.md#street-view-source-modes) |
| Street View-shaped photo (SV-shaped) | A permissioned photo processed to mimic Static API output (640×640, fov about 90°, taken from street distance). It stands in for Street View in benchmarks and fixtures because live Street View pixels may not be processed before licensing. | — | [quality](specs/quality-and-benchmark.md#permissioned-corpus) |
| Coverage probe | A metadata-only measurement of Street View availability and match-class distribution on a stratified sample of US addresses. | — | [address](specs/address-and-street-view.md#coverage-probe) |
| Upload | A photo the user supplies. It becomes a source asset of kind `upload`. | `POST /v1/uploads` | [uploads](specs/uploads.md#upload-flow) |
| Rights attestation | The one combined checkbox at a user's first upload confirming they are 18 or older and have the right to use the photo. | `attestedAt`, `attestationVersion` | [privacy](specs/privacy-safety-legal.md#audience-and-age) |

### Match classes

| `matchClass` | Meaning |
| --- | --- |
| `auto_start` | A confident match. The client requests the default render at once, with no confirmation step. |
| `confirm` | A plausible match with some doubt. The user confirms the place or picks an alternate first. |
| `skip_to_upload` | No usable or safe match. The user is asked for a photo, and the result carries a `reason`. |

| `skip_to_upload` reason | Meaning |
| --- | --- |
| `no_imagery` | No usable panorama near the property. |
| `multi_unit` | The address is a building with several dwellings. |
| `low_precision` | The address does not resolve to one building. |
| `blocked_address` | The place is on the homeowner opt-out list. Stored on the discovery only; the client sees the reason as `unavailable`, with copy that never claims there is no imagery. |
| `out_of_scope` | The address is outside the US Release scope. |
| `error` | Discovery failed. |

Discovery returns up to 3 candidate viewpoints. The [Street View source mode](#street-view-source-modes) then decides what follows confirmation: a render, or the photo prompt in `display_only`.

### Source asset states

| State | Meaning |
| --- | --- |
| `pending_upload` | An upload slot has been issued, but the bytes are not complete. |
| `quarantined` | The bytes have arrived and are held, unused, until validation. |
| `screening` | Content admission checks are running. |
| `ready` | Admitted and usable for renders. Street View and fixture assets are created directly in `ready` at confirmation. |
| `declined` | Refused by content admission. |
| `failed` | Could not be processed. |
| `stale` | Revalidation found the Street View panorama replaced by newer imagery or removed. A difference in the bytes of a refetched frame never marks a source stale. A stale source whose own panorama still resolves becomes ready again at its next check. |
| `expired` | The retention period has ended. |
| `deleted` | Removed by the owner or a deletion sweep, and tombstoned. |

## Holidays and decoration controls

| Term | Definition | Values / code form | Owner |
| --- | --- | --- | --- |
| Holiday | A tradition, independent of year and region. | `halloween`, `thanksgiving_us`, `christmas`, `new_years_eve` (optional pack, [D-08](decisions.md#d-08)) | [holidays](specs/holidays-and-content.md#holiday-model) |
| Occurrence | One holiday in one region and year, with its celebration dates, promotion window and commerce window. | — | [holidays](specs/holidays-and-content.md#holiday-model) |
| Promotion window | The inclusive date range in which a holiday is the default holiday on the landing page. | per occurrence | [holidays](specs/holidays-and-content.md#windows-and-selection) |
| Commerce window | The date range in which Shop the look offers for a holiday are active, validated against merchant shipping cut-offs. | per occurrence | [commerce](specs/commerce.md#seasonal-commerce-calendar) |
| Editorial timezone | America/New_York. The server resolves the hero and the default in this timezone, and the client does not recompute them. | — | [holidays](specs/holidays-and-content.md#windows-and-selection) |
| Default holiday | The holiday preselected by precedence: an explicit choice, then the holiday in its promotion window, then none (off-season). | `holidayId` or none | [holidays](specs/holidays-and-content.md#windows-and-selection) |
| Off-season | Any date outside every promotion window. The landing page shows a neutral hero, the picker lists all supported holidays, and no render auto-starts. | — | [holidays](specs/holidays-and-content.md#off-season-behavior) |
| Holiday picker | The control that lists the supported holidays. A deep link can preselect one. | `?holiday=<holidayId>` | [holidays](specs/holidays-and-content.md#windows-and-selection) |
| Hero | The photograph for the holiday currently in its window, or a neutral photograph off-season, shown full-viewport in a hero frame on the landing and the other hero-frame screens. | `hero_assets` | [holidays](specs/holidays-and-content.md#hero-and-example-art) |
| Example | One permissioned before/after per holiday and scene type, shown behind "See an example" and during waits ([D-11](decisions.md#d-11)). | `example_assets` | [holidays](specs/holidays-and-content.md#hero-and-example-art) |
| Art direction | The editorial guidance for hero and example images. | — | [holidays](specs/holidays-and-content.md#hero-and-example-art) |
| Holiday pack | Versioned, reviewed content for one holiday and region: scene sections, styles, lighting policy, kits, prompt fragments, forbidden list and hero references. Packs are repository files, validated in CI and published at deploy ([D-08](decisions.md#d-08)). | `holidayPackVersion` as `MAJOR.MINOR.PATCH` | [holidays](specs/holidays-and-content.md#holiday-packs) |
| Content cell | One holiday × scene type × style × lighting mode combination that a pack offers. A render request for a cell the pack does not offer fails with `VALIDATION_FAILED`. | — | [holidays](specs/holidays-and-content.md#holiday-packs) |
| Journey emphasis | A per-holiday hint in the experience projection that tells the landing and result screens which path to invite more strongly ([D-11](decisions.md#d-11)). | `journeyEmphasis`: `exterior`, `interior`, `balanced` | [holidays](specs/holidays-and-content.md#holiday-model) |
| Pack version | `MAJOR.MINOR` is part of the variant key, so content changes invalidate cached variants. `PATCH` covers copy fixes that do not. | `MAJOR.MINOR.PATCH` | [holidays](specs/holidays-and-content.md#holiday-packs) |
| Brief | Editorial prose written before a pack is authored. Code never reads it. It is not a benchmark case and not hero art direction. It is also not the product owner's original request, which the documents call the original request (the traceability headings "Requirements from the original brief" and "Interpretations of the brief" excepted). | — | [holidays](specs/holidays-and-content.md#content-authoring-and-review) |
| Scene section | A pack's rules for one scene type: allowed anchor categories, placement and preserve rules, styles with quantity rules, the kit, and prompt fragments. | keyed by scene type | [holidays](specs/holidays-and-content.md#pack-schema) |
| Scene type | The kind of space in a source photo. It selects the scene section. Once a render job exists for a source asset, its scene type is fixed; a correction creates a child source asset (same bytes, new ID). | see [Scene types](#scene-types) | [holidays](specs/holidays-and-content.md#holiday-model), [uploads](specs/uploads.md#scene-type-and-photo-guidance) |
| Decoration controls | The only three choices a user makes: holiday, style and lighting mode. The US Release has no free-text prompts. | — | [experience](specs/experience.md#changing-holiday-style-and-lighting) |
| Style | How much decoration a render adds: a tier inside a scene section, chosen by the user. | `subtle`, `classic`, `abundant` (default) | [holidays](specs/holidays-and-content.md#holiday-packs), [D-10](decisions.md#d-10) |
| Lighting mode | Whether the render keeps the photo's light or relights it (evening for exteriors, bright for rooms). | see [Lighting modes](#lighting-modes) | [render](specs/render-pipeline.md#lighting-modes), [D-10](decisions.md#d-10) |
| Lighting policy | For each holiday and scene type: the default lighting mode, which modes are offered, and evening guidance. `evening` is the default for exteriors and balconies (offering `source` as the alternative); interiors and apartment entries offer `bright` only, with no choice. | — | [holidays](specs/holidays-and-content.md#lighting-policy) |
| Style kit | For one (holiday, scene type) pair, a versioned set of product archetypes with specs written in-house. Each style uses a subset. | versioned | [holidays](specs/holidays-and-content.md#style-kits), [commerce](specs/commerce.md#style-kits-and-products) |
| Kit item | One archetype in a style kit, with an anchor category, spec text, spec attributes and a quantity per style. | — | [holidays](specs/holidays-and-content.md#style-kits) |
| Spec text | Our own description of a kit item's public attributes, sent to the renderer. It never contains merchant text or images. | — | [commerce](specs/commerce.md#style-kits-and-products) |
| Anchor | A real, visible surface or feature in the photo where decor may attach, typed by a fixed anchor-category list. | for example `front_door`, `porch_rail`, `mantel`, `dining_table` | [holidays](specs/holidays-and-content.md#example-packs), [render](specs/render-pipeline.md#scene-analysis) |
| Forbidden list | A pack's list of things never added, such as people, pets, text, house numbers, unselected religious symbols, and snow that is not visible in the source. | — | [holidays](specs/holidays-and-content.md#pack-schema) |
| Existing decorations | Decor already present in the source. It is kept and complemented: indoors, in apartment entries and on balconies it is never removed, moved or covered; outside a house (`house_exterior`) a decoration of the chosen holiday may take the place of a removable seasonal item at its spot (a wreath or door hanger, a potted plant, flower pot, planter or urn, a hanging basket, a seasonal flag, a doormat), and furniture, fixtures, mailboxes, anything built, vehicles, bins and plants growing in the ground stay. House numbers, signs and logos are never covered. | `existingDecorations` | [holidays](specs/holidays-and-content.md#climate-culture-and-existing-decorations) |

### Scene types

| `sceneType` | Covers | Attribute |
| --- | --- | --- |
| `house_exterior` | The front of one house | `buildingForm`: `detached`, `attached`, `other` |
| `apartment_entry` | A unit door, stoop or hallway outside one dwelling | — |
| `balcony` | A balcony, patio or terrace | — |
| `interior` | A room inside a home | `roomType`: `dining_room`, `living_room`, `entryway`, `kitchen`, `bedroom`, `other` |

A multi-unit building facade is not a scene type. Discovery routes it to `skip_to_upload`.

### Lighting modes

| `lightingMode` | UI label | Meaning |
| --- | --- | --- |
| `source` | "As photographed" | Keeps the photo's light (for an enhanced Street View frame, the photo's own daylight as redrawn by the enhancement), and electric decor glows. Offered for exteriors and balconies as the alternative to `evening`. |
| `evening` | "Evening" | Relights the decorated scene to dusk or evening, with decor lights clearly lit. The default for `house_exterior` and `balcony`. A photo already at dusk or night is decorated as photographed and delivered as its evening look. |
| `bright` | Bright (copy key exists; never shown in a caption) | Relights the decorated photo to a bright, airy, cheerful version of the same room. The only mode, and the default, for `interior` and `apartment_entry`, so no lighting control is shown. A photo that is already bright is not relit. |

## Rendering terms

| Term | Definition | Paid provider call | Effect on allowance | Owner |
| --- | --- | --- | --- | --- |
| Render request | A user action that asks for a variant (`POST /v1/renders`). If the variant key already has an accepted variant, that variant is returned and no job is created. | Only through the job it creates | None by itself | [render](specs/render-pipeline.md#variant-key-and-reuse) |
| Render job | One attempt to produce one variant. A project has at most one non-terminal job. | Through its attempts | Counts one accepted variant, only on `succeeded` | [render](specs/render-pipeline.md#concepts) |
| Render attempt | One paid image-edit provider call that decorates or relights (the enhancement of a Street View frame is not an attempt). A job has at most 2: the initial attempt plus one repair. A relit look that decorates its own base has at most 3: the base, the relight and one repair of either. | Yes, one | None directly. Counts toward the paid-attempt quota | [render](specs/render-pipeline.md#concepts) |
| Repair | The single re-plan after a QA rejection that a repair can follow, with failure-informed constraints. A decorate repair starts again from the original source, a relight repair from the same decorated base; either creates the next attempt. A job is repaired at most once. | Yes (the next attempt) | None | [render](specs/render-pipeline.md#repair-and-retries) |
| Transport retry | An infrastructure re-dispatch of the same attempt. It first queries the recorded provider operation and never creates a new paid attempt. | No new call | None | [render](specs/render-pipeline.md#repair-and-retries) |
| User retry | A new render job started by the user after a terminal job. | Through the new job | As a new job | [render](specs/render-pipeline.md#repair-and-retries) |
| Accepted variant | The output of a job that reached `succeeded`. Every published rendering is kept: an owner may hold several renderings of one variant key, and the newest is the one cached, listed among the project's looks and relit. | — | Counted once, when accepted | [render](specs/render-pipeline.md#concepts) |
| Preview | The user-facing word for an accepted variant, always shown with the "AI preview" label. | — | — | [experience](specs/experience.md#result-and-comparison) |
| Cached variant | The newest existing accepted variant returned for a matching variant key. | No | Free | [render](specs/render-pipeline.md#variant-key-and-reuse) |

| Term | Definition | Values / code form | Owner |
| --- | --- | --- | --- |
| Variant key | The identity and cache key of a variant: (sourceAssetId, holidayId, style, lightingMode, holidayPackVersion as MAJOR.MINOR, compilerVersion). | — | [render](specs/render-pipeline.md#variant-key-and-reuse) |
| Supersede | A newer project version or render request replaces a non-terminal job. The old job ends as `superseded` and never publishes. | `superseded` | [render](specs/render-pipeline.md#variant-key-and-reuse) |
| Late-result suppression | The rule that a canceled, superseded, expired or deleted job never publishes an output, even if a provider response arrives later. | — | [render](specs/render-pipeline.md#lifecycle-state-machines) |
| Pilot review mode | A configuration option, used in the private pilot, under which every output waits in `needs_review` for a human decision before delivery ([D-14](decisions.md#d-14)). The switch to automated delivery happens per scene type, once that scene type meets its calibration and reviewer-agreement criteria. | — | [render](specs/render-pipeline.md#lifecycle-state-machines), [quality](specs/quality-and-benchmark.md#pilot-evaluation) |
| Post-delivery audit | In public rollout, human review of a sample of variants after delivery. Audit misses feed QA judge recalibration. | — | [quality](specs/quality-and-benchmark.md#qa-judge-calibration) |
| Scene analysis | The vision-model stage that records the scene type, anchors, preserve and access regions, people, blurred regions, existing decor and lighting. | `SceneAnalysis` | [render](specs/render-pipeline.md#scene-analysis) |
| Decoration plan | The deterministic, validated list of placements built from the scene section, style, kit and anchors. | `DecorationPlan` | [render](specs/render-pipeline.md#decoration-plan) |
| Placement | One planned kit item on one existing anchor, with region, count and spec text. | — | [render](specs/render-pipeline.md#decoration-plan) |
| Prompt compilation | Deterministic code that turns a decoration plan into provider instructions. Its version is part of the variant key. | `compilerVersion` | [render](specs/render-pipeline.md#prompt-compilation) |
| Image-edit provider | The vendor model that edits the working image ([D-42](decisions.md#d-42)). | `ImageEditor.edit`, `ImageEditor.getOperation` | [render](specs/render-pipeline.md#rendering) |
| Provider operation ID | The vendor's identifier for an attempt, recorded before the response is awaited so the outcome can be recovered. | — | [render](specs/render-pipeline.md#rendering) |
| Vision-language model | The model that performs scene analysis and QA judging ([D-43](decisions.md#d-43)). | — | [render](specs/render-pipeline.md#model-roster) |
| Quality checks | The `checking` stage: deterministic checks plus the QA judge. Any critical code rejects the output. | — | [render](specs/render-pipeline.md#quality-checks) |
| QA judge | The vision-model check that compares the original, the attempt's output and the plan, and returns failure codes, per-placement adherence and confidence. | `JudgeResult` | [render](specs/render-pipeline.md#quality-checks) |
| Normalized box | A region given as `[x0, y0, x1, y1]` in 0–1 on the working image. Adapters convert vendor formats. | — | [render](specs/render-pipeline.md#coordinate-and-schema-conventions) |
| Compositing | Pasting original pixels back outside the feathered keep-mask (the plan's decoration shapes and the localized decorations) in `source` mode, plus final encoding. | — | [render](specs/render-pipeline.md#compositing-and-resolution) |
| Localization | The vision call after registration that boxes each decoration the editor added (and every other change) in the aligned output, so the paste-back keeps what the editor added wherever it placed it. | `LocalizationRecord` | [render](specs/render-pipeline.md#localizing) |
| Framing | The step at a Street View source's next look while no framing is recorded (its first look, or the next look of a place whose looks were made before) that finds the home in the fetched frame with the vision model and fetches the same panorama again at the view that fills the picture with just that home, so every look shows the home zoomed in and without the lawn, trees and neighbors around it. It is recorded on the viewpoint (`framed`, or `kept` when the wide frame stays for good: no home, ambiguous, a gain under 1.15 times, or `refused_framed`, the analysis having refused a framed frame), runs once per source, never for uploads, is recorded only while no other render job of the source is unfinished, and is switched by `STREET_VIEW_FRAMING`. Looks made before it keep their wide picture and a true "Before". The viewpoint's own heading, pitch and fov stay its identity. It is not a render attempt, a look or an allowance unit. | `source_assets.viewpoint.framing`; sub-stage `framing`; ledger stage `framing` | [render](specs/render-pipeline.md#framing), [address](specs/address-and-street-view.md#the-framed-view) |
| Enhancement | The one global edit by which the image editor redraws a stored Street View frame sharper and cleaner, as a picture of the same place, before any decoration is planned onto it. It is registered to the frame, given the frame's own pixels back inside people, blurred areas, recorded plates, house numbers and signs, given Google's two corner marks back, checked and judged; accepted, the picture is the working image of that source for every look (decorations are composited onto it and relights relight it), and "Before" stays Google's frame. One per (source, stored frame, compiler version), reused by every later look, remembered when rejected, switched by `STREET_VIEW_ENHANCE`. It is not a render attempt, a look or an allowance unit. Uploads are never enhanced. | `source_enhancements`; `render_jobs.enhancement` `outcome`: `made`, `reused`, `rejected`, `failed`, `skipped`; ledger stage `enhancing` | [render](specs/render-pipeline.md#enhancing) |
| Sub-stage | What the worker is doing inside a job state when the state alone does not say it: `framing` in `preparing`, `enhancing` in `analyzing`, `relight` in `planning` and `rendering` of a relight attempt. It selects the stage label and is cleared by every transition. | `render_jobs.sub_stage`: `framing`, `enhancing`, `relight` | [render](specs/render-pipeline.md#ui-labels) |
| Stage labels | The words the waiting screen shows for the job's state and sub-stage: "Getting your photo ready", "Zooming in on your home" (framing), "Sharpening your street photo" (enhancing), "Planning the decorations", "Decorating", "Checking the details", "Setting the evening light" and "Brightening the room" (a relight), "A person is checking your preview". | `stage.preparing`, `stage.framing`, `stage.enhancing`, `stage.planning`, `stage.rendering`, `stage.checking`, `stage.eveningLight`, `stage.brightLight`, `stage.review` | [render](specs/render-pipeline.md#ui-labels), [experience](specs/experience.md#copy-deck) |
| Fidelity mode | The render mode recorded on an attempt, which follows from the lighting mode: additive compositing for `source`, a global relight of the decorated base for `evening` and `bright`. | `fidelityMode`: `composite_additive`, `global_relight` | [render](specs/render-pipeline.md#lighting-modes) |
| Decorates its own base | A relit job (`evening` or `bright`) with no accepted daylight variant to relight: its first attempt decorates the photo as photographed (the base) and a later attempt relights that base. It may make three attempts. | — | [render](specs/render-pipeline.md#repair-and-retries) |
| Stroke restoration | How an embedded Street View attribution rectangle is restored in a relit or sharpened picture. Each mark has a place: the logo's is fixed (its letters, x 11 to 97 and rows 992 down at a 1024 working size), the copyright's is the inside of its dark box, found from the picture. Only strokes inside the place are kept: thin (at most 4 px), of enough contrast against their surround and of one brightness in one line. They keep the daylight base's pixels and the ground behind them follows the new light. The rectangle is copied verbatim when the box cannot be seen, when no stroke is validated, when something rejected may be one of the strokes (all or nothing, so a mark is never restored without one of its strokes), when a look-alike or a stroke cut by the place's edge says the strokes are not the mark's, or when the strokes are not found reliably; a relit look with a verbatim mark is likely rejected and the visitor gets the daylight look. Validated for 640 × 640 frames at a 1024 px working size only. | `restoreAttributionRelit`; mode `adapted` or `verbatim` | [render](specs/render-pipeline.md#compositing-and-resolution) |
| Last resort | What a decorate attempt that failed the checks with no repair to follow gets before it is rejected: every spot the judge objected to is pasted back from the original (each box grown by 3% of the long edge), and the restored picture goes on as an attempt accepted with a doubt when at least 40% of the decorations' area remains, one planned placement keeps 60% of its region and its deterministic checks report no code. The judge is not called again. It does not apply when a critical finding has no box, when a deterministic code is present, when no finding has a box, or when a code is `wrong_property`, `camera_changed`, `unsafe_or_offensive` or `attribution_altered`; a confident major finding without a box is recorded (`composite_mask.restored.recordedMajors`) and the picture goes on. When the boxes of boxed major findings would leave too little of the decorations, only the critical findings' boxes are put back. A doubt that is delivered has its doubted spots put back the same way when at least 85% of the decorations remain. An attempt that would have passed with no repair after it is kept through its repair and delivered as it stands when the repair yields no picture. | `PIPELINE_DEFAULTS.lastResort`; `render_attempts.composite_mask.restored` | [render](specs/render-pipeline.md#decision-policy) |
| Held base | The daylight base of an `evening` look that ended without its relight, held in `pre_delivery` review as an as-photographed candidate under a companion job; approval publishes it as the daylight variant. | `relight-base:<jobId>`; `heldJobId` | [render](specs/render-pipeline.md#repair-and-retries) |
| Job time limit | The longest a render job runs, measured from `startedAt`: 240 s by default and at least 240 s: a lower `RENDER_MAX_JOB_DURATION_S` is raised to 240 s. A repair, or the relight that follows a decorated base, starts only while the time left exceeds the repair budget (48 s by default). The render queue expires a job 30 s after the limit (`RENDER_QUEUE_EXPIRY_MARGIN_S`), so the job's own deadline fires first. | `RENDER_MAX_JOB_DURATION_S`, `RENDER_REPAIR_BUDGET_S` | [render](specs/render-pipeline.md#latency-budget) |
| Provider mode | Whether an attempt used a contract fixture, a replayed render or a live provider call. | `providerMode`: `fixture`, `replay`, `live` | [architecture](architecture.md#external-integrations-and-fixture-modes) |
| "AI preview" label | The visible label on every generated image, share page and share card ([D-28](decisions.md#d-28)). Downloads also carry a small burned-in "AI preview" corner mark by default (configuration). | — | [render](specs/render-pipeline.md#provenance-and-labeling) |
| Provenance metadata | IPTC digital source type on delivered files, plus a Hailiday-signed C2PA manifest (Phase 4) that includes the provider's manifest as an ingredient where one exists. | — | [render](specs/render-pipeline.md#provenance-and-labeling) |
| Latency metric | The automated-path p90 of `qaPassedAt − max(requestedAt, sourceReadyAt)` ([D-14](decisions.md#d-14)). Human-review wait is reported separately. | — | [render](specs/render-pipeline.md#latency-budget) |

### Render job states

States run in this order: `queued` → `preparing` → `analyzing` → `planning` → `rendering` → `checking` → [`needs_review`] → `succeeded`. The repair edge is `checking` → `planning`; a relit job that decorates its own base takes the same edge from its accepted base to its relight. The transitions are defined in [Lifecycle state machines](specs/render-pipeline.md#lifecycle-state-machines).

| State | Kind | Meaning | UI stage label |
| --- | --- | --- | --- |
| `queued` | Non-terminal | Accepted and waiting for a worker. | "Getting your photo ready" |
| `preparing` | Non-terminal | Loading the source and normalizing the working image; at a Street View source's next look while no framing is recorded, first zooming in on the home (sub-stage `framing`). | "Getting your photo ready"; "Zooming in on your home" while the framing runs |
| `analyzing` | Non-terminal | Running scene analysis and, for a stored Street View frame, the enhancement (sub-stage `enhancing`). | "Planning the decorations"; "Sharpening your street photo" while the enhancement runs |
| `planning` | Non-terminal | Building and validating the plan, then compiling it. Re-entered for a repair (at most once) and for the relight of a decorated base. | "Planning the decorations"; for a relight (sub-stage `relight`), "Setting the evening light" or "Brightening the room" |
| `rendering` | Non-terminal | A paid attempt is in progress. | "Decorating"; for a relight attempt, "Setting the evening light" or "Brightening the room" |
| `checking` | Non-terminal | Quality checks are running on the attempt's output. | "Checking the details" |
| `needs_review` | Non-terminal | Waiting for a human reviewer. Used only in pilot review mode. | "A person is checking your preview" |
| `succeeded` | Terminal | The output was accepted and published as an accepted variant. | — |
| `rejected` | Terminal | An output existed and was not accepted: quality checks rejected it with no repair left (the job's repair was used and the next attempt failed, or an attempt failed with a non-repairable code), or a reviewer rejected it (there is no repair after review), or an `evening` look that decorated its own base ended without a relight to deliver (its daylight look exists, and the job's status carries it as `variant`). A decorate attempt that failed with no repair left is rejected only when its objected spots cannot be put back (the last resort). It carries a `rejectionReason` and surfaces as `RENDER_REJECTED`. | — |
| `failed` | Terminal | The job could not produce an output for any reason other than quality checks: a provider, infrastructure, permission or source failure that transport retries did not resolve. It carries a `failureKind`. | — |
| `canceled` | Terminal | The owner canceled the job. | — |
| `superseded` | Terminal | A newer project version or render request replaced the job. | — |
| `expired` | Terminal | The owner's session or project expired. | — |

The UI never shows percentages.

| `failureKind` (on `failed`) | Meaning |
| --- | --- |
| `provider_error` | The provider returned an error that transport retries did not resolve. |
| `timeout` | The provider call or the job exceeded its time limit. |
| `policy_denied` | The pre-call permission evaluation denied a needed use. |
| `moderation_blocked` | A provider or screening vendor refused the input or output. Refusals are terminal for that input. |
| `source_unavailable` | The source image could not be loaded or fetched. |
| `source_rejected` | The source was found unsuitable before any paid edit. An optional `failureDetail` names why. |
| `unknown_outcome` | The recorded provider operation's result could not be determined. |
| `internal_error` | A defect or unexpected condition inside Hailiday's own code. |

| `failureDetail` (on `source_rejected`) | Meaning |
| --- | --- |
| `no_usable_anchors` | The scene offers no anchor where decor can attach, so the plan has no placements. |
| `house_number_mismatch` | A visible house number contradicts the resolved address. |
| `facade_not_in_frame` | The target facade is not in the frame. |
| `owner_blurred` | The property is blurred in the Street View imagery, typically at the owner's request. |

| `rejectionReason` (on `rejected`) | Meaning |
| --- | --- |
| `qa_critical` | The QA judge found a critical code and no repair remains. |
| `qa_uncertain` | The QA judge's verdict stayed uncertain under automated delivery. |
| `reviewer_rejected` | A pilot reviewer rejected the output. |

`no_usable_anchors` is a `failureDetail`, never a `rejectionReason`.

| Render job timestamp | Written when |
| --- | --- |
| `requestedAt` | The render request creates the job. |
| `sourceReadyAt` | The job's source is confirmed and `ready`. The later of this and `requestedAt` starts the latency metric. |
| `startedAt` | A worker starts the job. |
| `renderStartedAt` | The first paid attempt is issued. |
| `renderCompletedAt` | The last attempt's output is received. |
| `qaPassedAt` | Quality checks accept the output. |
| `reviewCompletedAt` | A pilot reviewer approves or rejects it. |
| `succeededAt` | The job enters `succeeded`. |
| `terminalAt` | The job enters any terminal state. |

### Failure codes

Failure codes are shared by the QA judge and the human review rubric. Which codes can be repaired is set in [Repair and retries](specs/render-pipeline.md#repair-and-retries). Anchored definitions are in the [review rubric](specs/quality-and-benchmark.md#review-rubric).

| Critical code | Meaning |
| --- | --- |
| `structure_changed` | Architecture or room layout changed: roofline, walls, doors, windows or furniture positions. |
| `wrong_property` | The decorated building or space is not the target. |
| `neighbor_decorated` | Decor was added to a neighboring property. |
| `access_blocked` | Decor blocks a door, steps, walkway or circulation path. |
| `privacy_regression` | A Google blur, face, plate or person was made clearer or reconstructed. |
| `people_altered` | A person was added, removed or changed. |
| `text_added` | Text, signage or numbers were added or altered. |
| `unsafe_or_offensive` | The content is unsafe, offensive or outside the pack's limits. |
| `camera_changed` | The viewpoint, crop or perspective differs from the source. |
| `attribution_altered` | Street View-origin outputs only: burned-in or required attribution was cropped, covered or altered. In a relit look the ground behind the logo and copyright following the new light is expected, and the loss of a faint semi-transparent provider watermark elsewhere in the picture (a relight repaints it) is not reported; neither is this failure. |

| Major code | Meaning |
| --- | --- |
| `unrequested_change` | A change to what belongs to the home or the scene, such as an object replaced or removed, repainting, landscaping, added snow or a season change. Extra decorations of the requested holiday and style are not one. |
| `plan_not_followed` | Key planned placements are missing, of the wrong kind, holiday or style, or clearly fewer than planned. |
| `implausible_decor` | Decor floats, is the wrong scale or is attached impossibly. |
| `lighting_implausible` | The lighting or glow is physically unconvincing. |

Major codes count against acceptability but not against structural fidelity.

### Quality evaluation terms

| Term | Definition | Owner |
| --- | --- | --- |
| Permissioned corpus | All permissioned photos used for tuning and evaluation, each with a rights record. | [quality](specs/quality-and-benchmark.md#permissioned-corpus) |
| Exploratory spike | The Phase 1 tuning exercise on the tuning set that freezes the first benchmark configuration. Its photos are never reused in the formal benchmark. | [quality](specs/quality-and-benchmark.md#exploratory-spike) |
| Formal benchmark | The blinded Phase 1 comparison of provider arms on fixed cohorts that supplies Gate A evidence. | [quality](specs/quality-and-benchmark.md#formal-benchmark) |
| Model bake-off | The `pnpm models:bakeoff` comparison of live image models and settings on the curated example photos, scored by the live QA judge. Live evidence for choosing provisional budget defaults; never gate evidence, and neither the exploratory spike nor the formal benchmark. "The bake-off" always means this activity. | [quality](specs/quality-and-benchmark.md#exploratory-spike), [development](development.md#model-bake-off) |
| Case | One permissioned photo paired with one holiday pack at a fixed style. Attempt-level counts are never gate denominators. A case is never called a brief. | [quality](specs/quality-and-benchmark.md#statistics-and-decision-rules) |
| Cohort | A benchmark stratum of photos: detached houses, attached houses, apartment entries and balconies, or interiors. | [quality](specs/quality-and-benchmark.md#formal-benchmark) |
| Provider arm, provider candidate | One image-edit provider configuration under evaluation. | [quality](specs/quality-and-benchmark.md#provider-comparison) |
| SV-shaped arm, lighting arm | Benchmark arms that run SV-shaped photos, and `source` versus `evening`, respectively. | [quality](specs/quality-and-benchmark.md#formal-benchmark) |
| Held-out set | Photos never used for tuning, run at the production pipeline re-benchmark before Gate C. | [quality](specs/quality-and-benchmark.md#production-pipeline-re-benchmark) |
| Structural fidelity | The output preserves the place's structure and camera. The quality spec defines which critical codes count against it. | [quality](specs/quality-and-benchmark.md#quality-goals) |
| Acceptability | Whether an output is good enough to deliver. Any critical code fails it, and major codes count against it. | [quality](specs/quality-and-benchmark.md#quality-goals) |
| Appeal, plan adherence, property correctness | Anchored rubric measures: attractiveness, match to the plan, and decorating the right place. | [quality](specs/quality-and-benchmark.md#review-rubric) |
| Gate A quality rule | A numbered pass rule in the quality spec. PLAN and the backlog gates cite these IDs (`QA-1` … `QA-n`) instead of restating the rules. | [quality](specs/quality-and-benchmark.md#statistics-and-decision-rules) |
| Wilson interval, Cohen's kappa | The interval method behind gate rules, and the reviewer-agreement statistic that must reach its target before scores count. | [quality](specs/quality-and-benchmark.md#statistics-and-decision-rules) |
| QA judge calibration | Measuring the QA judge against human labels before it may gate delivery. | [quality](specs/quality-and-benchmark.md#qa-judge-calibration) |
| Live Street View validation | Measuring real Street View rendering once `street_view_ai` is `live_private` under a grant, a written evaluation allowance or the owner decision of 2026-11-10. | [quality](specs/quality-and-benchmark.md#live-street-view-validation) |
| Private pilot, capped public rollout | The adult-participant pilot in Phase 5, and the limited public launch that Gate D opens. | [quality](specs/quality-and-benchmark.md#pilot-evaluation), [backlog](backlog.md#phase-5-pilot-and-rollout) |

### API, errors and events

| Term | Definition | Values / code form | Owner |
| --- | --- | --- | --- |
| Public API | The versioned HTTP API used by the web app, plus the two server-rendered pages. | `/v1/...`, `GET /`, `GET /s/:token` | [data-and-api](specs/data-and-api.md#http-api) |
| Internal operations API | Role-protected endpoints for capabilities, global pause, spend ceilings, review, report triage, the opt-out list, offers and kits. | `/internal/v1/...` | [data-and-api](specs/data-and-api.md#internal-operations-api) |
| Idempotency key | A client-supplied header on `POST /v1/renders`. Reusing it with a different request body fails with `IDEMPOTENCY_CONFLICT`. | `Idempotency-Key` | [data-and-api](specs/data-and-api.md#idempotency-and-concurrency) |
| Live updates | Server-sent events for render progress, with polling as the fallback. | `GET /v1/renders/:id/events` | [data-and-api](specs/data-and-api.md#live-updates) |
| `permittedActions` | The list of next steps the client may offer, returned on render status and on some errors. | — | [data-and-api](specs/data-and-api.md#http-api) |
| Error code | A stable, machine-readable failure code. The data-and-api spec owns status, retryability and copy key for each. | `VALIDATION_FAILED`, `VERIFICATION_REQUIRED`, `RATE_LIMITED`, `ALLOWANCE_EXHAUSTED`, `BUDGET_PAUSED`, `AT_CAPACITY`, `ADDRESS_OUT_OF_SCOPE`, `ADDRESS_NOT_FOUND`, `NO_STREET_VIEW`, `NEEDS_CONFIRMATION`, `NEEDS_PHOTO`, `SOURCE_NOT_EDITABLE`, `UPLOAD_UNSUPPORTED_FORMAT`, `UPLOAD_TOO_LARGE`, `UPLOAD_DECLINED`, `PEOPLE_DETECTED`, `STALE_PROJECT_VERSION`, `IDEMPOTENCY_CONFLICT`, `PROVIDER_UNAVAILABLE`, `RENDER_REJECTED`, `NOT_FOUND`, `FORBIDDEN`, `SHARE_REVOKED` (minimum set) | [data-and-api](specs/data-and-api.md#error-codes) |
| Analytics event | A first-party event. It never contains addresses, image URLs, raw prompts or photos. Client-emitted events arrive in batches at `POST /v1/analytics`. `landing_viewed` carries a coarse `referrerClass`. | `landing_viewed`, `holiday_changed`, `address_selected`, `address_manual_submitted`, `source_discovery_completed`, `source_confirmed`, `source_unavailable`, `photo_prompt_shown`, `upload_started`, `upload_accepted`, `upload_declined`, `render_requested`, `render_succeeded`, `render_rejected`, `render_failed`, `render_canceled`, `render_superseded`, `render_expired`, `variant_viewed`, `compare_used`, `allowance_reached`, `shop_panel_viewed`, `product_clicked`, `project_saved`, `share_created`, `share_viewed`, `project_deleted`, `feedback_submitted`, `report_submitted`, `web_vitals`, `experiment_shown`, `experiment_clicked`, `lead_submitted` | [data-and-api](specs/data-and-api.md#analytics-events) |

## Rights and permissions

| Term | Definition | Values / code form | Owner |
| --- | --- | --- | --- |
| Asset policy | The stored rights record for one source asset or product reference: one state per use, plus evidence reference, license version, territory, attribution text and expiry. | `asset_policies`; per-use state `unknown`, `allowed`, `denied` | [data-and-api](specs/data-and-api.md#entities) |
| Use | One kind of action an asset policy allows or denies. Each use corresponds to an AssetPermission field. | see [AssetPermission fields](#assetpermission-fields) | [privacy](specs/privacy-safety-legal.md#data-handling-rules) |
| AssetPermission | The evaluated view of an asset policy, computed at submission and again immediately before any provider call. The asset policy stays the source of truth: each evaluation is stored in `permission_evaluations` as a record of the decision and referenced by `permissionEvaluationId` on render jobs and attempts. For live traffic, `unknown` evaluates as denied. | type; `permission_evaluations` | [privacy](specs/privacy-safety-legal.md#data-handling-rules) |
| Street View source mode | How Street View imagery may be used, derived from AssetPermission. | see [Street View source modes](#street-view-source-modes) | [address](specs/address-and-street-view.md#street-view-source-modes), [D-15](decisions.md#d-15) |
| Licensing track | The user's parallel work with Google on Street View licensing ([D-03](decisions.md#d-03)). Its outcomes are recorded as described in [licensing outcomes](specs/address-and-street-view.md#licensing-outcomes-and-activation). | — | [address](specs/address-and-street-view.md#licensing-outcomes-and-activation) |
| Licensing outcome | The recorded answer to a licensing request. Each outcome maps to a source mode and to capability states. | full grant, partial grant, denied, unknown | [address](specs/address-and-street-view.md#licensing-outcomes-and-activation) |
| Grant | Written permission from a rights holder (Google, a merchant or a photo owner), recorded as evidence on an asset policy. | `evidenceId` | [data-and-api](specs/data-and-api.md#entities) |
| Interim address experience | When `STREET_VIEW_USE_POLICY=display_only`, or, for contributor imagery, when `STREET_VIEW_CONTRIBUTOR_IMAGERY=display_only`, the address path shows the Street View image only to confirm the place, then asks for the user's own photo of the front ([D-16](decisions.md#d-16)). This is Journey A′. | `display_only` | [address](specs/address-and-street-view.md#licensing-outcomes-and-activation) |
| Contributor imagery | Street View imagery not attributed to Google. By default it gets what the Street View use policy gives Google imagery, after the confirmation screen; under `STREET_VIEW_CONTRIBUTOR_IMAGERY=display_only` it is display-only unless a license says otherwise. | `isGoogleImagery: false` | [address](specs/address-and-street-view.md#street-view-source-modes) |

### AssetPermission fields

| Field | Meaning |
| --- | --- |
| `display` | Show the image to the user. |
| `store` | Keep the pixels in Hailiday storage. |
| `aiProcess` | Send the image to any model, for analysis, editing or QA. |
| `edit` | Create a derivative. |
| `distributeDerivative` | Download, share or display the derivative publicly. |
| `train` | Use the image to train models. Always false. |
| `commerceAdjacent` | Show Shop the look on a screen that displays this source's imagery or its derivative. |
| `attribution` | The attribution text that must accompany the image. |
| `expiresAt` | When the permission lapses. |
| `territory` | Where the permission applies. |
| `evidenceId` | The evidence record that grants the permission. |

### Street View source modes

| `StreetViewSourceMode` | Permissions | Meaning |
| --- | --- | --- |
| `persist` | display, aiProcess, edit, store | Street View pixels may be stored and decorated (the default `full` use policy). |
| `transient` | display, aiProcess, edit (no store) | Pixels exist only in worker memory for the job, and a later variant refetches them (the `decorate` use policy). |
| `display_only` | display | The before image is shown from a server-signed Static URL. Decorating requires the user's own photo. Every Street View source under `STREET_VIEW_USE_POLICY=display_only`, and contributor imagery under `STREET_VIEW_CONTRIBUTOR_IMAGERY=display_only`. |
| `unavailable` | none usable | No usable imagery, or display is not permitted. |

Imagery may be sent to models only where its evaluated permission allows it. Contributor imagery is evaluated like Google-attributed imagery unless `STREET_VIEW_CONTRIBUTOR_IMAGERY=display_only`.

### Sharing, safety and privacy terms

| Term | Definition | Values / code form | Owner |
| --- | --- | --- | --- |
| Share grant | An explicit, revocable grant behind an opaque token that exposes one derivative and never an address ([D-22](decisions.md#d-22)). | `share_grants`, `POST /v1/shares` | [experience](specs/experience.md#saving-accounts-and-sharing) |
| Share page | The server-rendered public page for a share grant. A revoked grant returns `SHARE_REVOKED`. | `GET /s/:token` | [architecture](architecture.md#landing-and-share-page-delivery) |
| Share card | The link-preview image for a share page, generated by a worker and carrying the "AI preview" label. | — | [architecture](architecture.md#landing-and-share-page-delivery) |
| Private-only variant | A variant with no share or download link, for example an upload with people left uncropped under the [D-18](decisions.md#d-18) default. | distributable flag false | [uploads](specs/uploads.md#people-in-photos) |
| Content admission | The checks an upload passes before it becomes `ready`: hash matching, a moderation classifier, a dwelling-or-room check and people detection. The outcome is admitted, declined or held for review; a held upload stays `screening` with `holdForReview`. | `UPLOAD_DECLINED`, `PEOPLE_DETECTED`, `holdForReview` | [uploads](specs/uploads.md#content-admission), [D-19](decisions.md#d-19) |
| People detection | Detecting people with bounding boxes only: no face templates and no age estimation. | — | [uploads](specs/uploads.md#people-in-photos) |
| Child-safety report | The documented procedure for reporting suspected child sexual abuse material and preserving evidence. | — | [privacy](specs/privacy-safety-legal.md#child-safety-reporting) |
| Homeowner opt-out | "Don't decorate my home": a place-ID blocklist that routes the Street View path to `skip_to_upload`. A homeowner asks through a report with reason `this_is_my_home` and a resolved place; there is no separate endpoint. | `blocked_addresses`, reason `blocked_address` | [privacy](specs/privacy-safety-legal.md#abuse-harassment-and-takedown) |
| Report | A user report about a result or share page, such as harmful content, privacy, "this is my home" or a pictured child. | `POST /v1/reports`; reason `this_is_my_home` among others | [experience](specs/experience.md#reporting-and-feedback) |
| Feedback | A thumbs rating with reasons on a result. | `POST /v1/feedback` | [experience](specs/experience.md#reporting-and-feedback) |
| Retention schedule | How long each data class is kept, and the mechanism that deletes it ([D-20](decisions.md#d-20)). | retention class per entity | [privacy](specs/privacy-safety-legal.md#retention-schedule) |
| Time-based deletion | Removal of projects, sources and renderings by age or inactivity. Paused by default (owner decision 2026-11-10): while the setting is off nothing expires by age, and every rendering is kept until the person deletes it. | `retention.time_based_deletion` | [privacy](specs/privacy-safety-legal.md#retention-schedule) |
| Gallery | The owner-wide list of every rendering, grouped by place for address projects and by project for uploads, at `/gallery` ([D-52](decisions.md#d-52)). | `GET /v1/gallery`, `GalleryItem` | [experience](specs/experience.md#gallery), [data and API](specs/data-and-api.md#gallery) |
| Tombstone | A deletion marker that stops late jobs, restores or callbacks from bringing deleted data back. | — | [privacy](specs/privacy-safety-legal.md#deletion-and-verification) |
| Preservation hold | A record that exempts named objects from retention sweeps and deletion during a child-safety or legal hold. | `preservation_holds` | [privacy](specs/privacy-safety-legal.md#deletion-and-verification) |
| Audience | Adults 18 and older. The product is not directed to children ([D-17](decisions.md#d-17)). | — | [privacy](specs/privacy-safety-legal.md#audience-and-age) |

## Commerce terms

| Term | Definition | Values / code form | Owner |
| --- | --- | --- | --- |
| Shop the look | The disclosed product panel below a result. It shows `similar` or `described` items in the US Release and never appears on a screen showing Google imagery unless the evaluated permission allows the `commerceAdjacent` use (the default `full` use policy does). | — | [commerce](specs/commerce.md#shop-the-look) |
| Panel state | What Shop the look shows for a variant. `hidden` applies whenever `commerceAdjacent` is not allowed. | `active`, `no_offers`, `off_season`, `hidden` | [commerce](specs/commerce.md#shop-the-look) |
| Product relationship | How a product relates to a specific render. It is never upgraded without the required evidence, and on failure it is downgraded or hidden. | see [Product relationships](#product-relationships) | [commerce](specs/commerce.md#product-relationships), [D-24](decisions.md#d-24) |
| Product | A real item, described by its public attributes and independent of any merchant listing. | `products` | [commerce](specs/commerce.md#offers-and-lifecycle) |
| Offer | One merchant's sellable listing of a product: program, SKU, destination country, currency, price display policy, tracking link and lifecycle status. | `offers` | [commerce](specs/commerce.md#offers-and-lifecycle) |
| Offer lifecycle | The status of an offer. | `draft`, `active`, `paused`, `retired` | [commerce](specs/commerce.md#offers-and-lifecycle) |
| Price source | Where an offer's price comes from, which decides whether a price may be displayed. | `priceSource`: `none`, `api`, `feed`, `merchant_served_link`, `manual_non_amazon` | [commerce](specs/commerce.md#offers-and-lifecycle) |
| Link mode | Whether a product link is the plain merchant URL or the program's tracking link. | `linkMode`: `plain`, `tracking` | [commerce](specs/commerce.md#click-tracking-and-attribution) |
| Catalog retirement | The date an occurrence stops making offers eligible, after which panels for that holiday resolve to `off_season`. | `catalogRetireAt` | [commerce](specs/commerce.md#seasonal-commerce-calendar) |
| Cross-holiday row | An optional, separately labeled row of the next holiday's offers on a result for the current holiday. Off by default; turning it on needs a decision-log entry under [D-24](decisions.md#d-24). | `crossHolidayRow` | [commerce](specs/commerce.md#seasonal-commerce-calendar) |
| Merchant program | One affiliate program Hailiday applies to or joins, directly or through a network. | `merchant_programs` | [commerce](specs/commerce.md#merchant-onboarding) |
| Merchant program status | Where a program stands. | see [Merchant program statuses](#merchant-program-statuses) | [commerce](specs/commerce.md#merchant-onboarding) |
| Commerce activation | Turning on `commerce:<merchantProgramId>` for one program. This is independent of public rollout, so Gate D can pass with commerce off ([D-25](decisions.md#d-25)). | activation states | [commerce](specs/commerce.md#commerce-activation) |
| Adherence check | The post-render check, required for `described`, that a placed item matches its spec in category, color family and count. | adherence status: `pass`, `fail`, `uncertain`, `not_checked` | [commerce](specs/commerce.md#product-relationships) |
| Disclosure | The visible "Ad" label and plain disclosure line next to Shop the look before any click, plus Amazon's required statement wherever Amazon links appear ([D-26](decisions.md#d-26)). | — | [commerce](specs/commerce.md#disclosure) |
| Sponsored placement | A paid placement, labeled "Sponsored" and ranked separately from relevance-ranked items. | — | [commerce](specs/commerce.md#ranking-integrity) |
| Ranking integrity | The rule that relevance comes first and commission never silently outranks it. | — | [commerce](specs/commerce.md#ranking-integrity) |
| Product click | A minimal first-party click record followed by the merchant's tracking link, with opaque sub-IDs and no personal data. | `POST /v1/clicks`, `product_clicked` | [commerce](specs/commerce.md#click-tracking-and-attribution) |
| Qualifying sale, reversal | A purchase the program credits for commission, and a later cancellation of that credit. | — | [commerce research](research/commerce-and-markets.md#amazon-associates) |
| Affiliate conversion | One commission record imported from a program's report and reconciled against product clicks by tracking or sub-ID. | `affiliate_conversions`; status `pending`, `approved`, `reversed`, `paid` | [commerce](specs/commerce.md#click-tracking-and-attribution) |

### Product relationships

| Value | Customer label | Evidence required |
| --- | --- | --- |
| `similar` | "Similar item" | Category and style match the rendered element, judged after the render. |
| `described` | "Similar to what's pictured" | Our own text spec of this real product's public attributes was sent to the renderer, and the adherence check passed. |
| `reference` | Set in the commerce spec | A permitted merchant image was an input. Later capability. |
| `verified` | Set in the commerce spec | A reference was used and identity review passed. Later capability. |

### Merchant program statuses

| Value | Meaning |
| --- | --- |
| `planned` | Identified as a target; no application yet. |
| `applied` | Application submitted; awaiting a decision. |
| `provisional` | Accepted on conditions the program has not yet confirmed. |
| `approved` | Fully approved; offers may be activated. |
| `declined` | The program refused the application. |
| `withdrawn` | The application or account was closed without a refusal, by Hailiday or by the program's rules. |
| `suspended` | The program has paused the account. |

## Allowance, limits and spend

These five mechanisms are separate. Each has its own purpose, error code and owner.

| Mechanism | Protects against | Counts | When exceeded | Values | Enforcement |
| --- | --- | --- | --- | --- | --- |
| Allowance | Unbounded free use. It is the product limit a guest sees as "N more looks today". | Accepted variants per owner per rolling window, and new addresses per owner per rolling window. Cached variants are free, and rejected or failed jobs do not count. | `ALLOWANCE_EXHAUSTED` with `resetsAt` and `permittedActions` | [economics](specs/economics.md#capacity-and-spend-ceilings), [D-12](decisions.md#d-12) | [data-and-api](specs/data-and-api.md#allowance-quotas-and-rate-limits) |
| Abuse quota | One owner, device or network driving cost or misuse. | Paid attempts per owner, plus a device/IP backstop on render requests that is a signal, not an identity. | Per the [error codes](specs/data-and-api.md#error-codes) table | [economics](specs/economics.md#capacity-and-spend-ceilings), [D-12](decisions.md#d-12) | [data-and-api](specs/data-and-api.md#allowance-quotas-and-rate-limits) |
| Rate limit | Request floods against address and session endpoints. | Requests per session, session token or short window. | `RATE_LIMITED` with `Retry-After` | [address](specs/address-and-street-view.md#pre-render-spend-controls) | [data-and-api](specs/data-and-api.md#allowance-quotas-and-rate-limits) |
| Spend ceiling | Service-wide vendor spend running past budget. | Money per day and month, plus per-SKU daily amounts. | `BUDGET_PAUSED` | [economics](specs/economics.md#capacity-and-spend-ceilings) | [data-and-api](specs/data-and-api.md#allowance-quotas-and-rate-limits) |
| Capacity | More concurrent work than providers and the queue can serve. | Provider concurrency and queue depth. | `AT_CAPACITY` with `Retry-After` | [economics](specs/economics.md#capacity-and-spend-ceilings) | [architecture](architecture.md#capacity-and-admission-control) |

| Term | Definition | Values / code form | Owner |
| --- | --- | --- | --- |
| Verification | The Cloudflare Turnstile check at session creation ([D-38](decisions.md#d-38)). | `VERIFICATION_REQUIRED` | [architecture](architecture.md#security-architecture) |
| Pre-render spend controls | The limits that cap Google API spend before any render happens: autocomplete behavior, suggestion and session-token limits, discovery and Static-fetch caps. | — | [address](specs/address-and-street-view.md#pre-render-spend-controls) |
| Usage ledger | The record of every chargeable call: stage, provider, model, units, unit price, and whether it is reserved or settled. Amounts are in USD micros because provider SKUs are sub-cent. | `usage_ledger`; `unitPriceMicros`, `amountMicros` | [render](specs/render-pipeline.md#cost-recording) |
| Minor units | How customer-facing prices are stored: an integer count of the currency's smallest unit plus the currency code. | — | [data-and-api](specs/data-and-api.md#conventions) |
| Reservation | The worst-case cost of a job, including its repair (and, for a relit look, its relight), held in the ledger in the same transaction that creates and enqueues the job. | — | [render](specs/render-pipeline.md#cost-recording), [architecture](architecture.md#jobs-and-queue) |
| Settlement | Replacing a reservation with the actual cost once calls finish, including reconciliation of unknown outcomes. | — | [render](specs/render-pipeline.md#cost-recording) |
| Cost per accepted variant | Total variable cost (all attempts, analysis, QA and delivery) divided by accepted variants. It is the main unit-cost metric. | — | [economics](specs/economics.md#unit-economics-model) |
| Global pause, kill switch | Operator controls that stop rendering service-wide, disable one provider, or change a capability's activation state. | `/internal/v1` | [architecture](architecture.md#observability-and-operations) |
| Runtime settings | The operator-editable, audited values that change without a deploy: global pause, per-provider disable, spend ceilings, admission-control limits, allowance values and review mode. | `runtime_settings` | [data-and-api](specs/data-and-api.md#entities) |

## Picture surfaces and design terms

| Term | Definition | Values / code form | Owner |
| --- | --- | --- | --- |
| Paper | The white surface: ink type, hairlines, Outfit and JetBrains Mono, solid ink pill buttons, the holiday dot as the only interface color. Everything that is not a picture is paper. | `--paper`, `--ink` | [experience](specs/experience.md#design-system) |
| Picture surface | A photograph or a picture stage that reaches the viewport's left and right edges, with white type on ink and minimal controls. A picture has no border, rounded frame, card shadow or phone gutter. | — | [experience](specs/experience.md#design-system) |
| Hero frame | A full-viewport photograph with content resting on it: at least the first viewport tall and never under 560 px, the photograph covering it around its focal point and drifting once. Used by the landing, the upload entry, the not-found page and the No Street View screen. | `.hero-frame`, `HeroFrame` | [experience](specs/experience.md#hero-frame) |
| Dock | The white panel (radius `--dock-radius`, shadow `--dock-shadow`) that rests on a hero frame and holds its controls: paper again inside. | `.hero-dock`, `HeroDock` | [experience](specs/experience.md#hero-frame) |
| Picture stage (stage) | The ink ground a picture is shown on: the full viewport width, the picture contained and centered at the largest size the screen allows, never above its natural size and never cropped. Not to be confused with a render job's stage label. | `.stage`, `Stage`; fill `viewport` or `picture`; `--stage` | [experience](specs/experience.md#picture-stage) |
| Stage peek | What stays visible under a stage in the first viewport, so the caption, the title and the actions are on the first screen. | `--stage-peek` | [experience](specs/experience.md#picture-stage) |
| Matte | The 20 px of ink a stage keeps under its picture from 600 px wide, so a pale picture never melts into the paper below it. | `--stage-matte` | [experience](specs/experience.md#picture-stage) |
| Ambient layer | The rendering, or the person's uploaded photo, repeated behind a stage's picture from 900 px wide: blurred, darkened and decorative. Never present for a raw Street View frame. | `.stage__ambient` | [experience](specs/experience.md#ambient-layer) |
| Header tone | The header's surface: `paper` (on the white page), `photo` (laid over a hero frame, transparent, white type) or `stage` (its own ink band above a stage). It sets the browser's theme color. | `paper`, `photo`, `stage`; `site-header--photo`, `site-header--stage` | [experience](specs/experience.md#header-tones-and-theme-color) |
| Theme color | The browser chrome color for the page: `#0d0d0f` on photo and stage pages, `#ffffff` on paper pages. | `theme-color` | [experience](specs/experience.md#header-tones-and-theme-color) |
| Reveal | The one-time divider sweep that uncovers a look that arrives while the person is watching. | `--dur-reveal` | [experience](specs/experience.md#reveal) |
| Light string | The string of holiday lights that hangs along a stage's top edge while a look is being made: a wire in even swags with bulbs in the look's holiday colors that twinkle in a wave and answer the pointer. Decorative (`aria-hidden`). The second place the interface carries color after the holiday dot. | `.light-string`, `LightString.tsx`, `ui/stringGeometry.ts`, `--bulb-1` to `--bulb-3` | [experience](specs/experience.md#light-string-and-status-card) |
| Status card | What names the step a look is in while it is made: the stage label with a pulse, the trail, the time hint (or the queue position) and Cancel. Three placements: on the stage (from 600 px wide and 560 px tall, hung from the light string), on paper (a first look on smaller screens) and as a band over the title (another look on smaller screens). | `.look-card`; `look-card--stage`, `--paper`, `--band`; `LookCard` | [experience](specs/experience.md#light-string-and-status-card) |
| Stage trail | The short words of the stages a render job has reported, each once, with the current one marked: Photo, Sharpen, Plan, Decorate, Check, Evening light, Bright light, Review. It shows only stages the job reported. | `StageTrail`, `stageTrail.ts`, `trail.*` | [experience](specs/experience.md#waiting-and-progress) |
| Look lock | While a look is being made, the controls that would start another look or change the place are dimmed, focusable and inert, and say so. Held by the page's code as well as its buttons. | `makingLook`, `controls.locked` | [experience](specs/experience.md#while-a-look-is-being-made) |

## Retired terms

These terms are ambiguous or superseded. Do not use them in documents, code, schemas, analytics or UI copy.

| Retired term | Canonical term | Note |
| --- | --- | --- |
| "Product Phase 1"; "Phase 1" meaning the release; "first release", "initial product" or "initial scope" meaning the release | US Release | "Phase 1" refers only to the feasibility phase. The phrase "initial build" appears only in the titles of D-03 and REQ-11. |
| "MVP" | US Release | Never use it as a phase name either. |
| "first technical spike", "engineering Phase 1" | Phase 1 (Feasibility) | — |
| "the spike" | exploratory spike, or Phase 1 | Name the specific activity. |
| Other names for phases (for example "Prove Street View integration and AI", "Build US MVP") | The canonical phase names in [Phases](#phases) | — |
| "Gate A — engineering readiness", "Gate B — complete engineering paths" | Gate A: Feasibility and provider decision; Gate B: Both paths complete | — |
| "Gate C — US public-use activation" | Gate C: Private pilot readiness; Gate D: Public rollout readiness | Public activation is Gate D. |
| "release gates", "decision gates" used as names | Gate A–D | — |
| "live/public operation", "public-use activation", "public operation", "live use", "live activation", "commercial activation" | `fixture`, `live_private` or `live_public` (activation state); commerce activation | Name the specific state. |
| "capability configuration", "capability record", "capability registry", "live activation record", "capability/grant record", "operating configuration" | `country_capabilities` row and activation state | — |
| "adapter capability flags" | adapter supported-operation flags | "Capability" means an activatable product function only. |
| "preset", "intensity", "intensity preset", "stylePreset", `styleId` | style (`style`) | The only name for `subtle`, `classic`, `abundant`. |
| "presetVersion", `preset_versions`, `holiday_definitions` | `holidayPackVersion`; holiday pack versions and occurrences | Entity names are set in [data-and-api](specs/data-and-api.md#entities). |
| "us-thanksgiving" | `thanksgiving_us` | — |
| "day/evening control"; `lightingMode` value "day" or "dusk" | lighting mode: `source` ("As photographed"), `evening` ("Evening"), `bright` ("Bright") | — |
| "setting" (meaning the kind of space), `sceneMode`, "interior mode", "room/exterior mode" | scene type (`sceneType`) | — |
| `multi_unit_exterior` | none (not a scene type) | Multi-unit facades route to `skip_to_upload`. |
| "Shop this style", "Products used as references" panel | Shop the look | There is one panel. Later relationships appear inside it. |
| "exact/reference/similar"; "Similar wreath", "inspired by this look", "Reference product", "Verified depiction" | `similar`, `described`, `reference`, `verified` and their customer labels | — |
| "source policy", "source policies", "policy ID", "rights per asset" | asset policy (`asset_policies`), evaluated as AssetPermission | — |
| "source-use matrix" | asset policy for runtime data; the research documents hold licensing evidence | — |
| "QUOTA_EXCEEDED" | `ALLOWANCE_EXHAUSTED`, `RATE_LIMITED`, `BUDGET_PAUSED`, `AT_CAPACITY` | Name the specific mechanism: allowance, abuse quota, rate limit, spend ceiling or capacity. |
| "free allowance", "complimentary preview", "guest quotas" | allowance (plus abuse quotas where meant) | — |
| "acceptedAt" | `qaPassedAt` and `succeededAt` on render jobs; `attestedAt` for the upload attestation | — |
| `app_settings` | `runtime_settings` | — |
| `headingMode` values `computed`, `api_default` | `geometry`, `point` | — |
| "accepted render", "accepted preview", "accepted result", "sibling variant" | accepted variant (preview in UI copy) | — |
| "obsolete" or "stale" for a replaced render | `superseded` | `stale` is a source asset state only. |
| "cancelled" | `canceled` | — |
| "render completed" (event), "holiday selected" (event) | `render_succeeded`, `holiday_changed` | — |
| "Finding your place", "Planning decorations", "Creating your preview" | The UI stage labels in [Render job states](#render-job-states) | Discovery copy is in the experience spec. |
| "outbox", "outbox dispatcher", `outbox_events` | none: transactional enqueue ([D-34](decisions.md#d-34)) | — |
| "candidate" used alone for an output or a vendor | the attempt's output; provider candidate | "Candidate" alone means a candidate viewpoint. |
| "permitted photos", "permitted-photo fixtures", "permissioned image fixtures" | permissioned photo | — |
| "contract replay", "provider replay", "replayed evidence", "synthetic metadata" | contract fixture; replayed render; fixture evidence | — |
| "working copies" | working image | — |
| "decoration brief", "holiday brief" (per benchmark case) | case | — |
| "hero brief" | art direction | — |
