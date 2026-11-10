# Holidays and content

This specification defines what Holiday knows about holidays and what it is allowed to draw: the holiday, occurrence and pack model; the US Release catalog; how the default holiday is chosen on any date in any timezone; the versioned holiday packs that turn a photo and a choice into a decoration plan; the style kits behind the shop panel; lighting policy; climate, culture and existing-decoration rules; hero and example art; and how content is authored, reviewed and released. Engineers and coding agents implement from it; editorial staff author to it. Rendering mechanics live in [render-pipeline.md](render-pipeline.md), product mapping in [commerce.md](commerce.md), and the screens that show this content in [experience.md](experience.md).

**Owns:** holiday, occurrence and pack model; US holiday catalog; promotion windows and selection; worked calendar; off-season behavior; pack schema and example packs; style kits (content side); lighting policy per holiday; climate, culture and existing-decoration rules; hero and example art; content authoring and review.

**Baseline:** planning baseline 2026-11-09; external facts retrieved 2026-11-08.

## Holiday model

### Terms

| Term | Definition | Identifier and values |
| --- | --- | --- |
| Holiday | A tradition, independent of year and place. | `holidayId` ∈ `halloween`, `thanksgiving_us`, `christmas`, `new_years_eve` in the US Release. |
| Occurrence | One holiday in one region and one year: celebration date(s), promotion window, commerce window, hero assignment, pack version in force. | `occurrenceId` = `<holidayId>.<region>.<year>`, for example `thanksgiving_us.US.2026`. `region` is an ISO 3166-1 alpha-2 country code; a later subdivision suffix (`US-TX`) is allowed by the schema but unused in the US Release. |
| Holiday pack | Versioned, reviewed content for one holiday and region: scene sections, styles, lighting policy, kit archetypes, prompt fragments, forbidden list, hero and example references, review record. | `packId` = `<holidayId>.<region>`, for example `christmas.US`; `version` is `MAJOR.MINOR.PATCH` ([Holiday packs](#holiday-packs)). |
| Scene section | A pack's rules for one scene type: allowed anchor categories, placement rules, access and preserve rules, styles with quantity rules, kit, prompt fragments. | Keyed by scene type. |
| Scene type | What kind of place the source photo shows. | `house_exterior` (attribute `buildingForm`: `detached`, `attached`, `other`), `apartment_entry` (unit door, stoop or hallway), `balcony` (balcony, patio or terrace), `interior` (attribute `roomType`: `dining_room`, `living_room`, `entryway`, `kitchen`, `bedroom`, `other`). |
| Style | How much decor a scene section places; a tier inside the section, not a separate pack. | `subtle`, `classic`, `abundant`; default `classic` (Proposed, [D-10](../decisions.md#d-10)). |
| Lighting mode | Whether the photo keeps its own light or is relit for evening. | `source` (UI label "As photographed"), `evening` (UI label "Evening"); defaults per [Lighting policy](#lighting-policy). |
| Style kit | The set of product archetypes a scene section can place, each with an in-house spec; styles select subsets. | `kitId` = `<holidayId>.<sceneType>`; archetypes are `kitItemId`s ([Style kits](#style-kits)). |
| Content cell | One combination (holiday, scene type, style, lighting mode) that a pack offers. A request for a combination the pack does not offer fails validation. | Derived from the pack; no stored identifier. |
| Brief | Editorial prose that precedes a pack (subject, mood, coverage, climate guidance, forbidden symbols). | Never consumed by code. |

Multi-unit building facades are never decorated as "your home"; the address path routes them to the user's own photo ([address-and-street-view.md](address-and-street-view.md#match-confidence-and-auto-start)). The glossary carries one-line definitions of every term above ([glossary.md](../glossary.md#holidays-and-decoration-controls)).

### Relationships

```mermaid
flowchart LR
  H[Holiday<br/>halloween, thanksgiving_us, christmas, new_years_eve] -->|per region and year| O[Occurrence<br/>dates, promotion window, hero, pack version]
  H -->|per region| P[Holiday pack<br/>MAJOR.MINOR.PATCH]
  P --> S1[Scene section: house_exterior]
  P --> S2[Scene section: apartment_entry]
  P --> S3[Scene section: balcony]
  P --> S4[Scene section: interior]
  S1 --> K1[Style kit<br/>4 to 6 archetypes]
  S1 --> ST[Styles: subtle, classic, abundant<br/>quantity rules per archetype]
  P --> L[Lighting policy per scene type]
  P --> F[Forbidden list]
  P --> HR[Hero and example references]
```

Rules that follow from the model:

- Tradition is separate from occurrence. Adding Canadian Thanksgiving later means a new occurrence set and pack keyed `thanksgiving_ca.CA`; the US definition does not change ([architecture.md](../architecture.md#international-extension-boundaries)).
- Religion is never inferred from an address, a name or an image. People select traditions explicitly; US Release packs are secular by default ([US holiday catalog](#us-holiday-catalog)).
- The selected holiday is stored on the project independently of the address. Changing the address never erases a deliberate holiday choice ([Windows and selection](#windows-and-selection)).
- The pack version in force is snapshotted into every render job as `holidayPackVersion` (MAJOR.MINOR) and is part of the variant key ([render-pipeline.md](render-pipeline.md#variant-key-and-reuse)).
- Persistence of occurrences and published pack versions (columns, indexes) is defined in [data-and-api.md](data-and-api.md#entities); this file defines the content and its meaning.

## US holiday catalog

Proposed ([D-08](../decisions.md#d-08)): three packs are in the US Release; New Year's Eve ships only if its pack passes review. Everything else is later expansion. The product owner and the design and editorial lead settle the catalog before pack authoring starts.

| `holidayId` | Display name | Status in the US Release | Tradition notes (secular by default) | Scene types with sections | Journey emphasis | Exterior expectation |
| --- | --- | --- | --- | --- | --- | --- |
| `halloween` | Halloween | In the US Release | Playful and autumnal: pumpkins and jack-o'-lanterns, cobwebs, bats, lanterns, harvest plants, orange and purple light. No gore, no realistic weapons or corpses, no cartoon or licensed characters. | all four | `exterior` | Lit jack-o'-lanterns and cobwebs on the porch; a clear change in `source`, strongest in `evening`. |
| `thanksgiving_us` | Thanksgiving | In the US Release | Harvest and gathering: wreaths of autumn leaves, garland, pumpkins and gourds, chrysanthemums, a set table with candlelight indoors. No Pilgrim, Native American or other costume or caricature imagery; no electric lights outdoors. | all four | `interior` (dining room; the hero scene) | A harvest porch in daylight: wreath, rail garland, pumpkin groups, mums. A modest, tasteful change; the example gallery sets this expectation ([Hero and example art](#hero-and-example-art)). |
| `christmas` | Christmas | In the US Release | Evergreen and light: wreaths, garland, warm-white string lights, bows, lanterns, a decorated tree indoors. No religious symbols (nativity, crosses, angels), no Santa or snowman figures, no inflatables. | all four | `balanced` | Warm-white lights on eaves and rail, door wreath, garland; strongest in `evening`. |
| `new_years_eve` | New Year's Eve | Optional: enabled only if the pack passes the review checklist | Celebration in gold, silver and white: string lights, metallic garland, lanterns, a set table. No fireworks or sky effects, no alcohol branding, no clocks or numerals (text). | `house_exterior`, `balcony`, `interior` (no `apartment_entry`) | `balanced` | Warm-white and gold string lights with metallic accents; strongest in `evening`. |

Religious sub-traditions (for example a Christmas pack with a nativity scene, or Hanukkah) are later packs that a user selects explicitly; the catalog never attaches them to a region or infers them. Other candidates for later expansion, in no committed order: Hanukkah, Diwali, Lunar New Year, Eid, Canadian Thanksgiving, Valentine's Day, Easter, Independence Day. Each needs its own occurrence rules (some depend on lunar or announced dates and need an annually reviewed calendar), its own pack and its own review before it is selectable.

`journeyEmphasis` is published in the experience projection so the landing and result screens can invite the stronger path for the current holiday (Proposed, [D-11](../decisions.md#d-11)): during the Thanksgiving window the dining-room photo invitation is stronger, while the hero and the address input stay as fixed in [D-06](../decisions.md#d-06). Screen behavior is specified in [experience.md](experience.md#landing).

Content policy at the product level (what Holiday declines to decorate, Halloween content limits, no free-text prompts) is owned by [privacy-safety-legal.md](privacy-safety-legal.md#content-policy-and-admission); the pack forbidden lists in this file are its enforceable form.

## Windows and selection

Proposed ([D-09](../decisions.md#d-09)). All dates are inclusive calendar dates in the timezone described below. Window boundaries are configuration on the occurrence; the values here are the defaults.

### Promotion windows

| Holiday | Promotion window (default) | Celebration date | Hero shown | Auto-start holiday on the address path |
| --- | --- | --- | --- | --- |
| `halloween` | September 15 – October 31 | October 31 | Halloween hero | `halloween` |
| `thanksgiving_us` | November 1 – Thanksgiving Day | Fourth Thursday of November | Thanksgiving hero (dining room) | `thanksgiving_us` |
| `christmas` | Day after Thanksgiving – December 25 | December 25 | Christmas hero | `christmas` |
| `new_years_eve` (optional) | December 26 – January 1 | December 31 (evening) and January 1 | New Year's Eve hero | `new_years_eve` |
| Off-season | Every other date, including December 26 – January 1 when the New Year's Eve pack is not enabled | — | Neutral hero | None: no render starts until a holiday is chosen ([Off-season behavior](#off-season-behavior)) |

The windows are adjacent by construction and never overlap. If a later pack introduces an overlap, the occurrence with the lower `editorialPriority` value wins (lower is more important) and the nearer celebration date breaks ties. The Halloween window opens in mid-September because Halloween decor shopping starts early: 49% of US Halloween shoppers start in September or earlier, and decorations are a $4.3B category (NRF 2026 Halloween survey, https://nrf.com/media-center/press-releases/nrf-halloween-survey-shows-consumer-spending-expected-to-reach-13-5-billion, retrieved 2026-11-08). Thanksgiving Day is the fourth Thursday of November (5 U.S.C. § 6103, https://www.law.cornell.edu/uscode/text/5/6103, retrieved 2026-11-08).

Commerce windows (when offers are live) are different from promotion windows and may open earlier; they are owned by [commerce.md](commerce.md#seasonal-commerce-calendar). Demand seasonality and its capacity consequences are in [economics.md](economics.md#seasonality).

### Occurrence record

The content-side contract for one occurrence. Column-level persistence is in [data-and-api.md](data-and-api.md#entities).

| Field | Meaning | Example (`thanksgiving_us.US.2026`) |
| --- | --- | --- |
| `occurrenceId`, `holidayId`, `region`, `year` | Identity | `thanksgiving_us.US.2026`, `thanksgiving_us`, `US`, `2026` |
| `celebrationStart`, `celebrationEnd` | Calendar dates of the celebration itself | `2026-11-26`, `2026-11-26` |
| `promotionStart`, `promotionEnd` | Default hero and default holiday | `2026-11-01`, `2026-11-26` |
| `commerceStart`, `commerceEnd`, `catalogRetireAt` | Offer eligibility; values and semantics owned by [commerce.md](commerce.md#seasonal-commerce-calendar) | per commerce spec |
| `editorialPriority` | Tie-break for overlapping windows (lower wins) | `10` |
| `heroAssetId` | Hero for this occurrence ([Hero and example art](#hero-and-example-art)) | `hero.thanksgiving_us.dining_room.v2` |
| `packId`, `packVersion` | Pack in force while this occurrence is current | `thanksgiving_us.US`, `1.2.0` |
| `enabled` | False until the pack and hero pass review; a disabled occurrence is treated as absent | `true` |
| `reviewedAt`, `reviewedBy` | Annual calendar review ([Content authoring and review](#content-authoring-and-review)) | `2026-08-20`, design and editorial lead |

Occurrences are generated by code for each year (fixed dates, or the fourth-Thursday rule for Thanksgiving) and then reviewed and enabled; the computed dates are never edited by hand without a recorded reason.

### Selection precedence

1. **Explicit choice.** A holiday chosen in this session (picker, or a valid `?holiday=` deep link) or stored on the saved project being viewed. An explicit choice persists across address changes, viewpoint changes and photo replacement within the project and session.
2. **In-window default.** The enabled occurrence whose promotion window contains today's date in the resolved timezone.
3. **Off-season.** No occurrence in window: neutral hero, picker visible, no auto-start.

Only step 2 depends on the clock. The server renders the landing shell with the default resolved in the editorial timezone **America/New_York** (the hero image, headline and inline experience JSON). The client does not recompute step 2: there is no client-side timezone swap, so the hero and the default holiday are the editorial-timezone ones for every visitor and never change after the shell paints (the shell is identical for everyone). `GET /v1/experience` ignores `?holiday=` for the hero and the default; it only echoes a valid, enabled requested holiday as `requestedHolidayId`, and the client applies a deep link as an explicit choice. Choosing a holiday in the picker sends no request: it changes the project's selection, not the hero. Window containment is evaluated on the calendar date in the editorial timezone, never on UTC. Saved projects and shares carry the explicit holiday, not a timezone.

`GET /v1/experience` returns the server-resolved default and the full occurrence calendar for the current and next year, which the picker uses to order holidays and show windows (payload in [data-and-api.md](data-and-api.md#http-api)).

### Picker contents and order

- The picker lists every holiday with an enabled occurrence in the current or next calendar year: Halloween, Thanksgiving, Christmas and, if enabled, New Year's Eve. Disabled packs never appear.
- Order: the current default first (in window), then the remaining holidays by next celebration date ascending. Off-season: all by next celebration date ascending.
- Selecting a holiday is an explicit choice (precedence step 1) and emits `holiday_changed`. It applies to the current project immediately: a cached accepted variant is shown at once; otherwise the client asks for a new variant ([experience.md](experience.md#changing-holiday-style-and-lighting)).
- Changing the address creates a new project and carries the explicit holiday choice forward; the in-window default is used only when no explicit choice exists.

### Deep links

`GET /?holiday=<holidayId>` sets an explicit choice for the session when `holidayId` names an enabled holiday; unknown or disabled values are ignored and the default applies. Share pages, example pages and seasonal landing variants use this parameter in their calls to action. The parameter never carries an address or a project.

## Worked calendar

Thanksgiving dates are computed by the occurrence generator (fourth Thursday of November): 2026-11-26, 2027-11-25, 2028-11-23; the unit tests below assert them. The rows below are the expected outputs of the occurrence generator for the default windows; they are the fixture for the unit tests that [architecture.md](../architecture.md#continuous-integration-and-testing) requires for window and timezone boundaries.

### Window boundaries by year

| Year | Halloween | Thanksgiving | Christmas | New Year's Eve (if enabled) | Off-season |
| --- | --- | --- | --- | --- | --- |
| 2026 | 2026-09-15 – 2026-10-31 (Sat) | 2026-11-01 – 2026-11-26 (Thu) | 2026-11-27 – 2026-12-25 (Fri) | 2026-12-26 – 2027-01-01 | 2027-01-02 – 2027-09-14 |
| 2027 | 2027-09-15 – 2027-10-31 (Sun) | 2027-11-01 – 2027-11-25 (Thu) | 2027-11-26 – 2027-12-25 (Sat) | 2027-12-26 – 2028-01-01 | 2028-01-02 – 2028-09-14 |
| 2028 | 2028-09-15 – 2028-10-31 (Tue) | 2028-11-01 – 2028-11-23 (Thu) | 2028-11-24 – 2028-12-25 (Mon) | 2028-12-26 – 2029-01-01 | 2029-01-02 – 2029-09-14 |

When the New Year's Eve pack is not enabled, December 26 – January 1 belongs to the off-season row.

### Test vectors

Each row is one unit test: the instant and timezone are the input, the default is the expected output of precedence step 2 (or step 1 where an explicit choice is given). The product evaluates step 2 only in the editorial timezone (America/New_York); rows in other timezones exercise the function, which takes the timezone as an argument.

| Local date and time | Timezone | Expected default | Why |
| --- | --- | --- | --- |
| 2026-11-15 12:00 | America/Chicago | `thanksgiving_us` | The owner's mid-November example. |
| 2026-12-15 12:00 | America/Los_Angeles | `christmas` | The owner's mid-December example. |
| 2027-11-15 12:00 and 2028-11-15 12:00 | America/New_York | `thanksgiving_us` | The example holds every year because the window starts November 1 and Thanksgiving is never before November 22. |
| 2026-09-14 23:59 | America/New_York | off-season | Last off-season minute before Halloween. |
| 2026-09-15 00:00 | America/New_York | `halloween` | Window opens at local midnight. |
| 2026-10-31 21:00 | America/Los_Angeles | `halloween` | The same instant is 2026-11-01 04:00 UTC; evaluating on UTC would wrongly return Thanksgiving. (The product evaluates in New York, where this instant is 2026-11-01 00:00 and the default is Thanksgiving.) |
| 2026-11-01 00:30 | America/New_York | `thanksgiving_us` (server shell) | The same instant is 2026-10-31 21:30 in Los Angeles, where the function returns `halloween`; the product still shows Thanksgiving to a Los Angeles visitor, because it does not swap by visitor timezone. |
| 2026-11-26 19:30 | Pacific/Honolulu | `thanksgiving_us` | The same instant is 2026-11-27 00:30 in New York, where the server shell already shows Christmas; the function returns `thanksgiving_us` for Honolulu, but the product shows the New York default. |
| 2026-11-27 00:00 | America/New_York | `christmas` | Day after Thanksgiving. |
| 2026-12-25 23:59 | America/New_York | `christmas` | Last minute of the Christmas window. |
| 2026-12-26 00:00 | America/New_York | `new_years_eve` if enabled, else off-season | The optional pack decides what follows Christmas. |
| 2026-12-25 20:00 | Pacific/Honolulu | `christmas` | The same instant is 2026-12-26 01:00 in New York, where the server shell already shows New Year's Eve or the neutral hero; the function returns `christmas` for Honolulu, but the product shows the New York default. |
| 2027-01-02 12:00 | America/New_York | off-season | Start of the long off-season. |
| 2027-03-28 12:00 | America/New_York | off-season | Easter is not in the catalog; nothing special happens. |
| 2027-07-04 12:00, `?holiday=christmas` | any | `christmas` | Explicit choice wins in any season. |
| 2026-12-15 12:00, saved project with `holidayId: halloween` | any | `halloween` | A saved project's choice wins over the in-window default. |
| 2028-11-24 12:00 | America/New_York | `christmas` | Day after Thanksgiving 2028 (2028-11-23). |

## Off-season behavior

Proposed ([D-09](../decisions.md#d-09)). Off-season is every date outside a promotion window, and in the US Release that is most of the year (January 2 to September 14, plus December 26 to January 1 when New Year's Eve is not enabled).

| Element | Off-season behavior |
| --- | --- |
| Hero | The neutral hero: a bright, uncluttered real-home scene with no holiday decor (art direction in [Hero and example art](#hero-and-example-art)), with the holiday picker visible beside the headline. |
| Picker | All enabled holidays, ordered by next celebration date; no holiday is preselected. |
| Address path | Discovery and confirmation run as usual. On `auto_start` the client does not call `POST /v1/renders` until the visitor picks a holiday; the confirmed place is shown with the picker in focus. On `confirm` the holiday is asked for on the same confirmation step. |
| Upload path | The holiday is chosen before or with the upload; the render request requires a `holidayId`, so nothing changes mechanically. |
| Copy | Headline unchanged ("Imagine your place for the holidays."). The subhead invites a choice ("Pick a holiday to see your place decorated."). The waiting screen and result screen do not mention an upcoming holiday. Final strings and keys are in the [copy deck](experience.md#copy-deck). |
| Shop the look | Follows the commerce windows: hidden or "Plan ahead" copy when no offer is in an active commerce window ([commerce.md](commerce.md#seasonal-commerce-calendar)). |
| Allowance and spend | Unchanged mechanics; per-season values, if any, are configuration owned by [economics.md](economics.md#capacity-and-spend-ceilings). |
| Analytics | `landing_viewed` carries the resolved default (none off-season) so off-season traffic is measurable; event schemas are in [data-and-api.md](data-and-api.md#analytics-events). |

Every enabled holiday can be rendered off-season by explicit choice; packs do not turn off outside their window. Only the default and the hero change.

## Holiday packs

A holiday pack is the only place decoration content lives. The scene analysis finds anchors in the photo; the pack says what may go on each anchor, how much per style, what must stay untouched and what is forbidden; the plan builder and compiler in [render-pipeline.md](render-pipeline.md#decoration-plan) turn pack plus analysis into provider instructions. There are no free-text prompts and no per-render editorial decisions.

### Contents

| Part | What it holds | Consumed by |
| --- | --- | --- |
| Identity and metadata | `id`, `version`, `holidayId`, `region`, `displayName`, `journeyEmphasis`, `traditionNotes` | Experience projection, catalog |
| Lighting policy | Default and offered lighting modes per scene type; evening guidance text | Experience projection, plan builder, compiler |
| Climate rule | Source precedence for climate, snow rule, cold-climate-only items | Plan builder |
| Existing-decoration policy | `preserve_and_complement` and the notice trigger | Plan builder, experience |
| Forbidden list | Enumerated items the plan may never place and the compiler always negates | Plan validator, compiler, QA judge |
| Scene sections | Per scene type: allowed anchor categories, form or room rules, preserve and keep-clear rules, placement limits, kit archetypes with placement rule, priority and quantity rules per style, prompt fragments | Plan builder, validator, compiler, shop panel |
| Hero and example references | Which hero assets and example before/after pairs belong to the pack | Experience projection |
| Review record | Checklist version, approvers, approval date, golden run reference | Release process only |

### Versioning

`version` is `MAJOR.MINOR.PATCH`. The variant key carries `holidayPackVersion` as `MAJOR.MINOR` ([render-pipeline.md](render-pipeline.md#variant-key-and-reuse)), so MAJOR and MINOR bumps invalidate cached variants and PATCH bumps do not.

| Bump | When | Cached variants |
| --- | --- | --- |
| MAJOR | A scene section, style, kit archetype or anchor category is removed or renamed; the forbidden list changes; a lighting default changes | Invalidated |
| MINOR | Placement rules (`placementRule`, `priority`, `limits`, form and room rules), quantity rules, kit spec text or attributes, prompt fragments, offered lighting modes, climate or existing-decoration rules change; a scene section, style or kit archetype is added | Invalidated |
| PATCH | `displayName`, `traditionNotes`, `journeyEmphasis`, hero or example references, review record, comments | Kept |

Rule of thumb: anything that can change a decoration plan or a compiled instruction is at least MINOR. The golden-file test for prompt compilation ([render-pipeline.md](render-pipeline.md#prompt-compilation)) enforces it: if golden output changes under a PATCH-only bump, the build fails.

### Storage, validation and publication

- **Files.** One directory per pack in the server package (`@holiday/server`), holding `pack.yaml`; large scene sections may be split into one file per scene type and merged at load. Pack files never ship in `@holiday/core` or in the browser bundle ([architecture.md](../architecture.md#packages-and-boundaries)).
- **Schema.** A zod schema in `@holiday/core` (`HolidayPack`, with the enums `HolidayId`, `SceneType`, `BuildingForm`, `RoomType`, `Style`, `LightingMode`, `AnchorCategory`, `AttachmentIntent`, `PlacementRule`, `ForbiddenItem`), including each kit archetype's `placementRule` and `priority` and each scene section's `limits`. Core exports the enums so the web app, the scene-analysis schema and the pack share one vocabulary.
- **Validation.** Every pack file is validated in CI and again at server start; an invalid pack stops the process. Cross-field rules: scene section keys are scene types; every anchor named in a section is allowed for that scene type ([Anchor categories](#anchor-categories)); every kit archetype anchor is in the section's anchor list; every `formRules` and `roomRules` anchor is in the section's anchor list; every kit archetype has a `placementRule`, and `priority` values are unique within a section; quantity minimums are not above maximums; `required` styles have a minimum of at least 1; `limits.maxPlacements` never decreases from `subtle` to `classic` to `abundant` and, for each style, is at least the number of archetypes that list the style in `required`; the forbidden list contains the baseline set; `lightingPolicy.bySceneType.<sceneType>.default` is in `offered`; `heroRefs` and `exampleRefs` resolve to approved assets; `kitId` equals `<holidayId>.<sceneType>`.
- **Publication.** A version is published by deploying the file, inserting a `holiday_pack_versions` row (`holidayId`, `region`, `version`, `contentRef`, `contentSha256`, `reviewRecord`) and setting its `status` to `published` (`publishedAt`); the previously published row becomes `retired` (columns in [data-and-api.md](data-and-api.md#entities)). The API resolves the published version for (`holidayId`, `region`) on the server, and each enabled occurrence pins the version it uses. Rollback sets the previous row back to `published` and retires the current one, so previous MAJOR.MINOR files stay in the repository until no occurrence references them. Packs are not editable in a database without a deploy: they change rarely, and schema validation plus golden renders are the safety net.
- **Kit seeding.** On publication the kit archetypes of each scene section are upserted into `style_kits` and `kit_items` by `kitItemId`, so the commerce side can map products to them ([commerce.md](commerce.md#style-kits-and-products)). Product columns on those rows are owned by the commerce spec.
- **Public projection.** `GET /v1/experience` exposes, per holiday: `holidayId`, `displayName`, `isDefault`, `journeyEmphasis`, hero, examples and, per scene type, `styles`, `defaultStyle`, `lightingModes` (offered) and `defaultLightingMode`. It never exposes prompt fragments, forbidden lists, kit spec text, quantity rules or review records (payload in [data-and-api.md](data-and-api.md#http-api)).
- **Request validation.** A render request whose (`holidayId`, `style`, `lightingMode`) is not an offered content cell for the project's scene type fails with `VALIDATION_FAILED` ([data-and-api.md](data-and-api.md#error-codes)).

## Pack schema

### Schema by example

The annotated skeleton below is the normative shape; the zod schema in core mirrors it field for field. Compact notations used in this file: `quantity: { <style>: [min, max] }` counts instances (runs, for string lights and garland) per style, and `required: [<styles>]` lists the styles in which the archetype must appear whenever one of its anchors is visible. `priority` is optional and omitted in the example packs because list order is the default. How the plan builder uses these fields is in [Placement fields](#placement-fields).

```yaml
id: christmas.US                      # <holidayId>.<region>
version: 1.0.0                        # MAJOR.MINOR.PATCH, see Versioning
holidayId: christmas                  # HolidayId enum
region: US                            # ISO 3166-1 alpha-2, optional subdivision suffix later
displayName: Christmas
journeyEmphasis: balanced             # exterior | interior | balanced
traditionNotes: >                     # shown to editors and in the catalog; secular by default
  Evergreen, light and warmth. No religious symbols: a user selects a religious
  sub-tradition pack explicitly when one exists.
lightingPolicy:
  bySceneType:                        # keys are scene types; values from the Lighting policy section
    house_exterior: { default: source, offered: [source, evening] }
    apartment_entry: { default: source, offered: [source] }
    balcony: { default: source, offered: [source, evening] }
    interior: { default: source, offered: [source, evening] }
  eveningGuidance: >                  # compiled only when lightingMode is evening
    Early dusk: darkened sky and lowered ambient light with the structure still legible;
    string lights and lanterns glow warm white with soft bloom; windows that exist may show a
    soft warm glow; no light source that is not a placed decoration.
climateRule:
  sourcePrecedence: [scene_analysis, address_region, neutral]
  snow: only_if_visible_in_source     # the only allowed value
  coldClimateOnlyItems: []            # kitItemIds allowed only when climate class is cold
existingDecorPolicy: preserve_and_complement   # the only allowed value; notice rules in Climate, culture and existing decorations
forbidden:                            # ForbiddenItem enum; must include the baseline set
  - people
  - pets
  - text_or_signage
  - house_number_changes
  - new_structures
  - structural_changes
  - landscaping_changes
  - neighbor_decor
  - blocked_access
  - brand_logos
  - cartoon_or_licensed_characters
  - mascots_and_inflatables
  - snow_or_frost_unless_visible
  - sky_effects
  - religious_symbols               # pack-specific additions follow the baseline
  - open_flame_indoors
sceneSections:
  house_exterior:
    buildingForms: [detached, attached, other]
    formRules:                        # tighten the section for a building form
      attached: { excludeAnchors: [lawn], note: placements stay within the target unit's facade span }
      other: { excludeAnchors: [roofline, eaves, lawn] }
    anchors: [front_door, door_frame, porch_rail, porch_steps, roofline, eaves, window_frame, column, walkway_edge, planter, lawn]
    preserve: [roofline shape, window and door positions, siding and trim color, steps, landscaping, sky, neighbors, house numbers, existing blur regions]
    keepClear: [door swing, step treads, walkway surface, driveway, mailbox face]
    limits:                           # optional; the values shown are the schema defaults, see Placement fields
      maxPlacements: { subtle: 3, classic: 6, abundant: 10 }
      overlapTolerance: 0.10          # share of a placement region allowed over preserve and access regions
      groundMarginFraction: 0.03      # exteriors only
      edgeMarginFraction: 0.02        # exteriors only
    kitId: christmas.house_exterior
    kit:                              # 4 to 6 archetypes; attributes in the Style kits section
      - kitItemId: christmas.house_exterior.string_lights_warm_white
        archetype: string_lights
        anchors: [eaves, roofline, porch_rail]
        attachment: strung
        placementRule: along          # PlacementRule enum
        priority: 1                   # optional; list order is the default (1 = placed first)
        specText: outdoor warm-white LED string lights with evenly spaced bulbs, following the eave line or rail
        quantity: { subtle: [0, 1], classic: [1, 2], abundant: [2, 3] }
        required: [classic, abundant]
    promptFragments:
      scene: a tasteful US Christmas display added to the confirmed target home
      preserve: keep the same camera position, crop, roof outline, doors, windows, siding color, steps, landscaping, sky, time of day and neighboring buildings
      negative: no snow or frost unless present in the source, no Santa or snowman figures, no inflatables, no religious symbols, no text, no people, no new structures
  interior:
    roomTypes: [dining_room, living_room, entryway, kitchen, bedroom, other]
    anchors: [mantel, dining_table, sideboard, interior_window, wall, floor_area, shelf, banister]
    roomRules:                        # replace the section's anchors for a room type
      dining_room: { anchors: [dining_table, sideboard, interior_window, wall, shelf] }
      living_room: { anchors: [mantel, floor_area, interior_window, wall, shelf] }
      entryway: { anchors: [banister, floor_area, wall, shelf] }
      kitchen: { anchors: [dining_table, interior_window, shelf] }
      bedroom: { anchors: [interior_window, wall, shelf] }
      other: { anchors: [interior_window, wall, shelf] }
    preserve: [walls, windows, doors, flooring, ceiling, furniture positions, existing light fixtures, artwork and photographs, existing blur regions]
    keepClear: [doorways, circulation paths, stair treads, stove and sink, seating surfaces]
    kitId: christmas.interior
    kit: []                           # see Example packs
    promptFragments: { scene: ..., preserve: ..., negative: ... }
heroRefs:
  - { heroAssetId: hero.christmas.exterior.v1, orientation: landscape }
  - { heroAssetId: hero.christmas.exterior.v1, orientation: portrait }
exampleRefs:
  - { exampleAssetId: example.christmas.house_exterior.classic.source.v1, sceneType: house_exterior, style: classic, lightingMode: source }
review:
  checklistVersion: 1
  approvedBy: [editorial_lead, second_approver]
  approvedAt: null                    # set at approval
  goldenRunId: null                   # set when the golden renders are approved
```

### Placement fields

These fields give the plan builder in [render-pipeline.md](render-pipeline.md#decoration-plan) everything it needs to turn eligible anchors into placements deterministically.

**Eligible anchors for a section.** The section's `anchors` list is the full set. `formRules.<buildingForm>.excludeAnchors` removes anchors for that building form; `roomRules.<roomType>.anchors` replaces the list for that room type. A building form or room type with no entry uses the section's `anchors` unchanged. An anchor detected by scene analysis is eligible for an archetype when its category is in both the archetype's `anchors` and the resulting section list and it passes the analysis checks in the render spec.

**Placement rule.** Each archetype names one `placementRule`, which sets how its placement region is derived from the anchor box:

| `placementRule` | Placement region | Example archetypes |
| --- | --- | --- |
| `centered_on` | Centered on the anchor box, sized to the archetype's size range relative to the anchor | Door wreath, window wreath |
| `along` | Follows the anchor's long edge for its visible length | String lights on eaves, garland on a rail or window top, cobweb across a rail corner |
| `beside` | Next to the anchor on the ground, outside its access region; inside the anchor for area anchors (`lawn`, `planter`) | Pumpkin groups and lanterns beside the steps, potted mums |
| `on_surface` | On the anchor's top surface, inside its outline | Table runner, centerpiece, candles, sideboard arrangement |
| `cluster_at` | Inside an area anchor (`floor_area`, `balcony_floor`, `wall`, `planter`) as one standing item or a compact grouping | Tree, wrapped gifts, bat silhouettes, small jack-o'-lanterns on a balcony floor |
| `hang_from` | Hanging below the anchor's front edge | Stockings from a mantel |

**Priority.** Archetypes are placed in ascending `priority` (1 first); when `priority` is omitted, list order is the priority. The compiler writes placements in the same order.

**Count.** For a style, an archetype whose `quantity` maximum is 0 is not placed. Otherwise `count` = clamp(number of eligible anchors, min, max), so every included archetype, and in particular one that lists the style in `required`, gets at least 1 whenever any of its anchors is eligible; `required` additionally protects the archetype from the placement cap below. Instances go to eligible anchors in descending analysis confidence, one per anchor in turn, until `count` is reached; each anchor used yields one placement whose `count` is the number of instances assigned to it (four candles on one table is one placement with `count` 4).

**Section limits.** `limits` is optional; omitted fields take the defaults below (configuration in the pack file).

| Field | Default | Meaning |
| --- | --- | --- |
| `maxPlacements` | `subtle` 3, `classic` 6, `abundant` 10 | Maximum placements in one plan for the style. When the plan exceeds it, placements are removed from the lowest-priority archetype upward, lowest-confidence anchor first. An archetype that lists the style in `required` keeps at least one placement, and its instances move to that placement so its `count` stays at least `min`. |
| `overlapTolerance` | 0.10 | Largest share of a placement region that may overlap preserve and access regions before the validator shrinks or removes it. Protected blur regions and people boxes always have zero tolerance. |
| `groundMarginFraction` | 0.03 | Exteriors: how far below the bottom edge of the `targetFacade` box placements on `porch_steps`, `walkway_edge`, `planter` and `lawn` anchors may extend, as a fraction of image height. |
| `edgeMarginFraction` | 0.02 | Exteriors: placements are clipped to stay at least this fraction of image width inside the side edges of the `targetFacade` box; a placement with nothing left is removed, so nothing lands on the boundary with a neighbor. |

When existing decoration density is high, the next-lower style's quantities and `maxPlacements` apply ([Existing decorations](#existing-decorations)).

### Anchor categories

The fixed vocabulary shared by packs, scene analysis ([render-pipeline.md](render-pipeline.md#scene-analysis)) and the commerce kit tables. Analysis emits only these categories; a pack may use only the categories allowed for the scene type.

| Category | Scene types | Meaning | Typical placements |
| --- | --- | --- | --- |
| `front_door` | `house_exterior` | The target's main entry door | Wreath |
| `door_frame` | `house_exterior`, `apartment_entry`, `balcony` | Trim around the entry, unit or balcony door | Garland, string lights |
| `porch_rail` | `house_exterior` | Porch or stoop railing | Garland, lights, cobwebs |
| `porch_steps` | `house_exterior` | Sides of the entry steps, never the treads | Pumpkin groups, potted plants, lanterns |
| `roofline` | `house_exterior` | One roof section of the target facade, boxed from its eave line up to its ridge (a front-facing gable from its eave corners up to the apex) | String lights along the eave line, or along both gable edges |
| `eaves` | `house_exterior` | Eave or gutter line, boxed tightly | String lights, icicle lights |
| `window_frame` | `house_exterior` | Exterior window trim | Window wreaths, electric window candles |
| `column` | `house_exterior` | Porch posts and columns | Garland wrap, lights |
| `walkway_edge` | `house_exterior` | Edges of the path to the door, never its surface | Stake lights, luminaria |
| `planter` | `house_exterior`, `balcony`, `apartment_entry` | Existing planters and urns | Seasonal plants, small pumpkins |
| `lawn` | `house_exterior` | Lawn in front of the target facade | Ground-standing items only; landscaping unchanged |
| `balcony_railing` | `balcony` | The user's own railing | Lights, garland; never onto a neighbor's railing |
| `balcony_floor` | `balcony` | Floor area clear of the door swing | Pumpkins, potted plants, lanterns |
| `unit_door` | `apartment_entry` | The user's unit door | Wreath |
| `banister` | `apartment_entry`, `interior` (entryway) | Stair handrail | Garland |
| `mantel` | `interior` | Fireplace mantel | Garland, stockings, candles |
| `dining_table` | `interior` (dining room, kitchen) | Dining or kitchen table; the box top is the far edge of the tabletop | Runner, centerpiece, candles, place accents (`on_surface`; Thanksgiving runner and centerpiece, Christmas centerpiece along the table center) |
| `sideboard` | `interior` | Sideboard, buffet or console top | Arrangement |
| `interior_window` | `interior` | Interior window frame or sill | Garland, wreath, electric candles |
| `wall` | `interior`, `apartment_entry`, `balcony` | Wall area free of fixtures, art and photographs | Hung wreath, silhouettes |
| `floor_area` | `interior`, `apartment_entry` | Open floor beside a wall or window, outside circulation | Tree, lanterns, gifts, potted evergreen |
| `shelf` | `interior` | Open shelf top | Small arrangement |

Attachment intents: `hung`, `wrapped`, `draped`, `strung`, `standing`, `placed`, `stretched` (cobwebs). Pixel regions in plans describe the image, not real-world dimensions.

**One vocabulary, three consumers.** The scene-analysis prompt lists exactly the categories allowed for the scene type, each with the box extent above (the [render spec's placement geometry](render-pipeline.md#placement-geometry) reads those extents: lights follow the bottom edge of `eaves` and `roofline` boxes, garlands the top edge of rails, frames, mantels and shelves, `on_surface` items the top of tables, sideboards, mantels and shelves). Every pack section's `anchors`, `roomRules` lists and archetype `anchors` use only categories allowed for the scene type, every archetype anchor appears in its section's list, and a test checks the three agree. For the surface anchors (`dining_table`, `sideboard`, `mantel`, `shelf`) analysis reports occlusion of the top surface only, and the planner accepts up to 0.6 occlusion for `on_surface` placements on them, because chairs in front of a table hide its sides, not its top.

### Forbidden items

| Item | Baseline (every pack) | Meaning for the plan and the QA judge |
| --- | --- | --- |
| `people`, `pets` | yes | Never added, moved, removed or altered; existing people and pets stay as photographed (`people_altered`). |
| `text_or_signage` | yes | No lettering, numerals, banners or signs (`text_added`); includes "Merry Christmas" lettering, countdown clocks and doormat text. |
| `house_number_changes` | yes | House numbers and nameplates stay legible and unchanged. |
| `new_structures`, `structural_changes` | yes | No added porches, pergolas, arches or changed roofs, windows, doors (`structure_changed`). |
| `landscaping_changes` | yes | No new or removed plants, trees, lawns or paving (`unrequested_change`). |
| `neighbor_decor` | yes | Nothing on any building, balcony, door or railing that is not the target (`neighbor_decorated`). |
| `blocked_access` | yes | Doors, steps, walkways, corridors, balcony doors and stairs stay passable (`access_blocked`). |
| `brand_logos` | yes | No recognizable brand products, logos or packaging. |
| `cartoon_or_licensed_characters`, `mascots_and_inflatables` | yes | Not-directed-to-children guardrail ([Climate, culture and existing decorations](#climate-culture-and-existing-decorations)). |
| `snow_or_frost_unless_visible` | yes | No snow, frost or icicles unless the source shows them. |
| `sky_effects` | yes | No fireworks, auroras or added celestial objects; the sky changes only under `evening` relighting rules. |
| `religious_symbols` | per pack | Required in every US Release pack; a religious sub-tradition pack omits it deliberately. |
| `open_flame_indoors` | per pack | Required for every `interior` section: candles are enclosed or flameless. |
| `gore`, `realistic_weapons`, `costume_caricature` | per pack | Halloween (`gore`, `realistic_weapons`) and Thanksgiving (`costume_caricature`). |

The QA codes in parentheses are the failure codes in [render-pipeline.md](render-pipeline.md#quality-checks) that each item maps to.

## Example packs

Excerpts of the US Release packs. They show real content at the level the pack files carry; attributes for each archetype are in [Style kits](#style-kits). All excerpts assume the baseline forbidden list and the preserve and keep-clear rules shown in the schema.

### Christmas, `house_exterior` (detached)

```yaml
sceneSections:
  house_exterior:
    buildingForms: [detached, attached, other]
    formRules:
      attached: { excludeAnchors: [lawn], note: placements stay within the target unit's facade span }
      other: { excludeAnchors: [roofline, eaves, lawn] }
    anchors: [front_door, door_frame, porch_rail, porch_steps, roofline, eaves, window_frame, column, walkway_edge, planter]
    kitId: christmas.house_exterior
    kit:
      - { kitItemId: christmas.house_exterior.string_lights_warm_white, anchors: [eaves, roofline, porch_rail], attachment: strung, placementRule: along,
          specText: outdoor warm-white LED string lights with evenly spaced bulbs following the eave line or rail,
          quantity: { subtle: [0, 1], classic: [1, 2], abundant: [2, 3] }, required: [classic, abundant] }
      - { kitItemId: christmas.house_exterior.wreath_evergreen, anchors: [front_door], attachment: hung, placementRule: centered_on,
          specText: a 24 to 30 inch mixed evergreen wreath with a red velvet bow, centered on the existing front door,
          quantity: { subtle: [1, 1], classic: [1, 1], abundant: [1, 1] }, required: [subtle, classic, abundant] }
      - { kitItemId: christmas.house_exterior.garland_evergreen, anchors: [door_frame, porch_rail, column], attachment: draped, placementRule: along,
          specText: mixed evergreen garland with pinecones following the door frame or rail,
          quantity: { subtle: [0, 1], classic: [1, 2], abundant: [2, 3] }, required: [classic] }
      - { kitItemId: christmas.house_exterior.potted_evergreen_pair, anchors: [porch_steps, planter], attachment: standing, placementRule: beside,
          specText: a pair of potted evergreens three to four feet tall with warm-white lights flanking the entry beside the steps,
          quantity: { subtle: [0, 0], classic: [0, 1], abundant: [1, 1] }, required: [] }
      - { kitItemId: christmas.house_exterior.lantern_flameless, anchors: [porch_steps, planter], attachment: placed, placementRule: beside,
          specText: a black metal lantern with a flameless pillar candle beside the entry, not on a step tread,
          quantity: { subtle: [0, 1], classic: [0, 2], abundant: [1, 2] }, required: [] }
      - { kitItemId: christmas.house_exterior.window_wreath, anchors: [window_frame], attachment: hung, placementRule: centered_on,
          specText: a small evergreen wreath with a red bow centered on each front window,
          quantity: { subtle: [0, 0], classic: [0, 0], abundant: [1, 4] }, required: [] }
    promptFragments:
      scene: a tasteful US Christmas display added to the confirmed target home
      preserve: keep the same camera position, crop, roof outline, doors, windows, siding color, steps, landscaping, sky, time of day and neighboring buildings
      negative: no snow or frost unless present, no Santa or snowman figures, no inflatables, no religious symbols, no text, no people, no new structures, nothing on neighboring homes
```

The 640×640 input size of Street View sources ([render-pipeline.md](render-pipeline.md#compositing-and-resolution)) is why exterior archetypes are large, high-contrast items (light runs, a full wreath, garland) rather than small ornaments.

### Christmas, `interior` (dining room and living room)

```yaml
sceneSections:
  interior:
    roomRules:
      dining_room: { anchors: [dining_table, sideboard, interior_window, wall, shelf] }
      living_room: { anchors: [mantel, floor_area, interior_window, wall, shelf] }
      entryway: { anchors: [banister, floor_area, wall, shelf] }
    kitId: christmas.interior
    kit:
      - { kitItemId: christmas.interior.tree_prelit, anchors: [floor_area], attachment: standing, placementRule: cluster_at,
          specText: a pre-lit artificial evergreen tree with warm-white lights, red and gold ornaments and a simple topper, scaled to the visible ceiling height, standing on open floor beside a wall or window with circulation clear,
          quantity: { subtle: [0, 1], classic: [1, 1], abundant: [1, 1] }, required: [classic, abundant] }
      - { kitItemId: christmas.interior.mantel_garland_lit, anchors: [mantel, interior_window], attachment: draped, placementRule: along,
          specText: mixed evergreen garland with warm-white lights and pinecones along the mantel or window top,
          quantity: { subtle: [1, 1], classic: [1, 2], abundant: [2, 3] }, required: [subtle, classic, abundant] }
      - { kitItemId: christmas.interior.stockings, anchors: [mantel], attachment: hung, placementRule: hang_from,
          specText: three to four knit stockings in red, cream and green hung from the mantel edge,
          quantity: { subtle: [0, 0], classic: [1, 1], abundant: [1, 1] }, required: [] }
      - { kitItemId: christmas.interior.table_centerpiece, anchors: [dining_table], attachment: placed, placementRule: on_surface,
          specText: a low evergreen centerpiece with pinecones, red berries and flameless pillar candles along the table center,
          quantity: { subtle: [1, 1], classic: [1, 1], abundant: [1, 2] }, required: [subtle, classic, abundant] }
      - { kitItemId: christmas.interior.sideboard_arrangement, anchors: [sideboard, shelf], attachment: placed, placementRule: on_surface,
          specText: a small evergreen arrangement with gold ornaments and a flameless candle on the sideboard,
          quantity: { subtle: [0, 1], classic: [1, 1], abundant: [1, 2] }, required: [] }
      - { kitItemId: christmas.interior.wrapped_gifts, anchors: [floor_area], attachment: placed, placementRule: cluster_at,
          specText: a few wrapped gifts in red, gold and cream paper under the tree,
          quantity: { subtle: [0, 0], classic: [0, 3], abundant: [3, 6] }, required: [] }
    promptFragments:
      scene: a tasteful US Christmas interior added to the room in the photo
      preserve: keep walls, windows, doors, flooring, ceiling, furniture positions, artwork, photographs and existing light fixtures unchanged
      negative: no religious figures, no cartoon characters or toys, no text, no people or pets, no open flames, no new furniture, no changed wall color
```

The tree appears only when analysis reports a `floor_area` anchor large enough for its footprint with circulation clear; a living room without one gets the mantel and window placements only. In the dining room the table centerpiece is the lead item and there is no tree.

### Thanksgiving, `house_exterior` (harvest porch, no electric lights)

```yaml
sceneSections:
  house_exterior:
    buildingForms: [detached, attached, other]
    formRules:
      attached: { excludeAnchors: [lawn] }
      other: { excludeAnchors: [roofline, eaves, lawn] }
    anchors: [front_door, door_frame, porch_rail, porch_steps, column, planter, walkway_edge]
    kitId: thanksgiving_us.house_exterior
    kit:
      - { kitItemId: thanksgiving_us.house_exterior.wreath_autumn, anchors: [front_door], attachment: hung, placementRule: centered_on,
          specText: a 22 to 26 inch wreath of orange and russet maple leaves with small pinecones and wheat, centered on the existing front door,
          quantity: { subtle: [1, 1], classic: [1, 1], abundant: [1, 1] }, required: [subtle, classic, abundant] }
      - { kitItemId: thanksgiving_us.house_exterior.garland_harvest, anchors: [porch_rail, door_frame, column], attachment: draped, placementRule: along,
          specText: amber and rust leaf garland with small gourds following the visible rail or door frame,
          quantity: { subtle: [0, 1], classic: [1, 1], abundant: [1, 3] }, required: [classic] }
      - { kitItemId: thanksgiving_us.house_exterior.pumpkin_group, anchors: [porch_steps, planter], attachment: placed, placementRule: beside,
          specText: a group of two to four uncarved orange and white pumpkins and gourds beside the entry, not on a step tread,
          quantity: { subtle: [1, 1], classic: [1, 2], abundant: [2, 3] }, required: [classic, abundant] }
      - { kitItemId: thanksgiving_us.house_exterior.mums_potted, anchors: [porch_steps, planter, walkway_edge], attachment: standing, placementRule: beside,
          specText: potted chrysanthemums in rust, gold and burgundy beside the steps or in existing planters,
          quantity: { subtle: [0, 1], classic: [1, 2], abundant: [2, 4] }, required: [] }
      - { kitItemId: thanksgiving_us.house_exterior.corn_stalks, anchors: [column, porch_rail], attachment: wrapped, placementRule: beside,
          specText: a bundle of dried corn stalks tied to a porch post,
          quantity: { subtle: [0, 0], classic: [0, 0], abundant: [1, 2] }, required: [] }
    promptFragments:
      scene: a tasteful US Thanksgiving harvest display added to the confirmed target home in its existing daylight
      preserve: keep the same camera position, crop, roof outline, doors, windows, siding color, steps, landscaping, sky, time of day and neighboring buildings
      negative: no electric lights, no Christmas or Halloween items, no Pilgrim or Native American figures or costume imagery, no text, no people, no snow, no new structures
```

No archetype in this section is lit, and `lightingPolicy.bySceneType.house_exterior.offered` is `[source]` only ([Lighting policy](#lighting-policy)).

### Thanksgiving, `interior` (dining room, the hero scene)

```yaml
sceneSections:
  interior:
    roomRules:
      dining_room: { anchors: [dining_table, sideboard, interior_window, wall, shelf] }
      kitchen: { anchors: [dining_table, interior_window, shelf] }
      living_room: { anchors: [mantel, interior_window, shelf] }
    kitId: thanksgiving_us.interior
    kit:
      - { kitItemId: thanksgiving_us.interior.table_runner, anchors: [dining_table], attachment: draped, placementRule: on_surface,
          specText: a woven linen table runner in rust or mustard along the center of the existing table,
          quantity: { subtle: [1, 1], classic: [1, 1], abundant: [1, 1] }, required: [subtle, classic, abundant] }
      - { kitItemId: thanksgiving_us.interior.centerpiece_low, anchors: [dining_table], attachment: placed, placementRule: on_surface,
          specText: a low centerpiece of small pumpkins, gourds, eucalyptus and autumn leaves that keeps sightlines across the table,
          quantity: { subtle: [1, 1], classic: [1, 1], abundant: [1, 2] }, required: [subtle, classic, abundant] }
      - { kitItemId: thanksgiving_us.interior.candles_flameless, anchors: [dining_table, sideboard, mantel], attachment: placed, placementRule: on_surface,
          specText: a set of flameless taper and pillar candles in brass or glass holders with a warm glow,
          quantity: { subtle: [0, 2], classic: [2, 4], abundant: [4, 8] }, required: [classic, abundant] }
      - { kitItemId: thanksgiving_us.interior.place_accents, anchors: [dining_table], attachment: placed, placementRule: on_surface,
          specText: cloth napkins in autumn tones with simple rings at each existing place setting,
          quantity: { subtle: [0, 0], classic: [1, 1], abundant: [1, 1] }, required: [] }
      - { kitItemId: thanksgiving_us.interior.sideboard_harvest, anchors: [sideboard, shelf, mantel], attachment: placed, placementRule: on_surface,
          specText: a harvest arrangement of leaves, small pumpkins and wheat on the sideboard,
          quantity: { subtle: [0, 1], classic: [1, 1], abundant: [1, 2] }, required: [] }
      - { kitItemId: thanksgiving_us.interior.window_garland, anchors: [interior_window], attachment: draped, placementRule: along,
          specText: autumn leaf garland along the window top,
          quantity: { subtle: [0, 0], classic: [0, 1], abundant: [1, 2] }, required: [] }
    promptFragments:
      scene: a warm US Thanksgiving table and room added to the existing dining room
      preserve: keep walls, windows, doors, flooring, ceiling, furniture positions, chairs, artwork, photographs and existing light fixtures unchanged
      negative: no open flames, no Christmas items, no text, no people or pets, no new furniture, no food unless already on the table
```

`lightingPolicy.bySceneType.interior.offered` is `[source, evening]`, the upper bound described in [Lighting policy](#lighting-policy): in `evening` the candles and existing lamps carry the light, matching the hero.

### Halloween, `house_exterior`

```yaml
sceneSections:
  house_exterior:
    buildingForms: [detached, attached, other]
    formRules:
      attached: { excludeAnchors: [lawn] }
      other: { excludeAnchors: [roofline, eaves, lawn] }
    anchors: [front_door, door_frame, porch_rail, porch_steps, eaves, column, planter, walkway_edge, lawn]
    kitId: halloween.house_exterior
    kit:
      - { kitItemId: halloween.house_exterior.jack_o_lanterns, anchors: [porch_steps, planter, walkway_edge], attachment: placed, placementRule: beside,
          specText: two to four carved pumpkins with simple friendly or classic faces lit from inside by flameless candles, beside the steps or path, not on a tread,
          quantity: { subtle: [1, 1], classic: [1, 2], abundant: [2, 3] }, required: [subtle, classic, abundant] }
      - { kitItemId: halloween.house_exterior.pumpkin_group, anchors: [porch_steps, planter], attachment: placed, placementRule: beside,
          specText: a group of uncarved orange and white pumpkins and gourds beside the entry,
          quantity: { subtle: [0, 1], classic: [1, 1], abundant: [1, 2] }, required: [] }
      - { kitItemId: halloween.house_exterior.cobwebs, anchors: [porch_rail, column, door_frame], attachment: stretched, placementRule: along,
          specText: stretched white synthetic cobweb across a railing corner or around a porch post,
          quantity: { subtle: [0, 0], classic: [1, 2], abundant: [2, 3] }, required: [] }
      - { kitItemId: halloween.house_exterior.string_lights_orange_purple, anchors: [eaves, porch_rail, door_frame], attachment: strung, placementRule: along,
          specText: outdoor LED string lights in orange and purple following the eave line or rail,
          quantity: { subtle: [0, 0], classic: [0, 1], abundant: [1, 2] }, required: [] }
      - { kitItemId: halloween.house_exterior.mums_and_corn, anchors: [porch_steps, planter, column], attachment: standing, placementRule: beside,
          specText: potted chrysanthemums in rust and gold with a bundle of dried corn stalks,
          quantity: { subtle: [0, 1], classic: [1, 1], abundant: [1, 2] }, required: [] }
      - { kitItemId: halloween.house_exterior.skeleton_stylized, anchors: [lawn, porch_steps], attachment: standing, placementRule: beside,
          specText: one stylized bone-white plastic skeleton seated or standing beside the steps or on the lawn, no blood or damage,
          quantity: { subtle: [0, 0], classic: [0, 0], abundant: [0, 1] }, required: [] }
    promptFragments:
      scene: a playful, tasteful US Halloween display added to the confirmed target home
      preserve: keep the same camera position, crop, roof outline, doors, windows, siding color, steps, landscaping, sky, time of day and neighboring buildings
      negative: no gore, blood, weapons or corpses, no cartoon or licensed characters, no inflatables, no text, no people, no fog or sky effects, no new structures, nothing on neighboring homes
```

Halloween content stays within the limits in [privacy-safety-legal.md](privacy-safety-legal.md#content-policy-and-admission): friendly or classic jack-o'-lantern faces, no frightening figures below `abundant`, and the skeleton only as an optional `abundant` item.

### Halloween, `balcony`

```yaml
sceneSections:
  balcony:
    anchors: [balcony_railing, balcony_floor, door_frame, planter, wall]
    preserve: [railing structure, floor, balcony door, exterior wall, neighboring balconies and units, view beyond the railing]
    keepClear: [balcony door swing, the path from the door to the railing, the railing top edge]
    kitId: halloween.balcony
    kit:
      - { kitItemId: halloween.balcony.railing_lights, anchors: [balcony_railing], attachment: strung, placementRule: along,
          specText: battery LED string lights in orange or warm white woven along the inside of the railing, ending at the balcony's own edge,
          quantity: { subtle: [0, 1], classic: [1, 1], abundant: [1, 1] }, required: [classic, abundant] }
      - { kitItemId: halloween.balcony.jack_o_lanterns_small, anchors: [balcony_floor, planter], attachment: placed, placementRule: cluster_at,
          specText: one to three small carved pumpkins with friendly faces lit by flameless candles on the floor near a railing corner,
          quantity: { subtle: [1, 1], classic: [1, 2], abundant: [2, 3] }, required: [subtle, classic, abundant] }
      - { kitItemId: halloween.balcony.cobwebs, anchors: [balcony_railing, door_frame], attachment: stretched, placementRule: along,
          specText: stretched white synthetic cobweb across one railing corner or the top of the door frame,
          quantity: { subtle: [0, 0], classic: [0, 1], abundant: [1, 2] }, required: [] }
      - { kitItemId: halloween.balcony.door_wreath, anchors: [door_frame], attachment: hung, placementRule: centered_on,
          specText: a small wreath of black and orange leaves with mini pumpkins hung on the balcony door frame,
          quantity: { subtle: [0, 1], classic: [1, 1], abundant: [1, 1] }, required: [] }
      - { kitItemId: halloween.balcony.mums_potted, anchors: [balcony_floor, planter], attachment: standing, placementRule: cluster_at,
          specText: a potted chrysanthemum in rust or gold on the floor or in an existing planter,
          quantity: { subtle: [0, 1], classic: [1, 1], abundant: [1, 2] }, required: [] }
      - { kitItemId: halloween.balcony.bat_silhouettes, anchors: [wall], attachment: hung, placementRule: cluster_at,
          specText: a small cluster of flat black paper bat silhouettes on the wall beside the door,
          quantity: { subtle: [0, 0], classic: [0, 0], abundant: [1, 1] }, required: [] }
    promptFragments:
      scene: a playful, tasteful US Halloween display on the user's own balcony
      preserve: keep the railing, floor, door, wall, the view beyond the railing and every neighboring balcony exactly as photographed
      negative: no items on the railing top edge, nothing on neighboring balconies or railings, no gore or weapons, no cartoon characters, no text, no people
```

Nothing may sit on the railing top edge (fall hazard) and nothing crosses to a neighbor's railing; both are keep-clear rules the validator enforces with the analysis regions.

### Christmas, `apartment_entry`

```yaml
sceneSections:
  apartment_entry:
    anchors: [unit_door, door_frame, floor_area, planter, banister, wall]
    preserve: [the door and its hardware, unit numbers and nameplates, corridor walls and floor, neighboring doors, lighting fixtures, signage]
    keepClear: [the door swing, the corridor or stair path, neighboring doors, fire equipment]
    kitId: christmas.apartment_entry
    kit:
      - { kitItemId: christmas.apartment_entry.door_wreath, anchors: [unit_door], attachment: hung, placementRule: centered_on,
          specText: an 18 to 24 inch evergreen wreath with a red bow centered on the unit door below any number plate,
          quantity: { subtle: [1, 1], classic: [1, 1], abundant: [1, 1] }, required: [subtle, classic, abundant] }
      - { kitItemId: christmas.apartment_entry.frame_garland_lit, anchors: [door_frame], attachment: draped, placementRule: along,
          specText: evergreen garland with battery warm-white lights along the top and sides of the door frame,
          quantity: { subtle: [0, 1], classic: [1, 1], abundant: [1, 1] }, required: [classic, abundant] }
      - { kitItemId: christmas.apartment_entry.lantern_pair, anchors: [floor_area], attachment: placed, placementRule: cluster_at,
          specText: a pair of small lanterns with flameless candles on the floor in the door's own alcove, clear of the corridor,
          quantity: { subtle: [0, 0], classic: [0, 1], abundant: [1, 1] }, required: [] }
      - { kitItemId: christmas.apartment_entry.potted_evergreen_small, anchors: [floor_area, planter], attachment: standing, placementRule: cluster_at,
          specText: a small potted evergreen with warm-white lights beside the door, clear of the corridor,
          quantity: { subtle: [0, 0], classic: [0, 1], abundant: [1, 1] }, required: [] }
      - { kitItemId: christmas.apartment_entry.banister_garland, anchors: [banister], attachment: wrapped, placementRule: along,
          specText: evergreen garland wrapped along the stair handrail of the user's stoop or entry stairs,
          quantity: { subtle: [0, 0], classic: [0, 1], abundant: [1, 1] }, required: [] }
    promptFragments:
      scene: a tasteful Christmas welcome at the user's own apartment door
      preserve: keep the door, its number and hardware, the corridor, neighboring doors, lighting and signage exactly as photographed
      negative: nothing on neighboring doors, nothing in the corridor path, no religious symbols, no text, no people, no inflatables
```

Floor items appear only when analysis reports a `floor_area` in the door's own alcove; a flat corridor wall with no alcove gets the wreath and frame garland only. `apartment_entry` offers `source` lighting only.

## Style kits

A style kit is the content side of Shop the look (Proposed, [D-24](../decisions.md#d-24)): the archetypes a scene section can place, each described in our own words so that the rendered item and the product shown beside the result describe the same object. Mapping archetypes to real products and offers, the `described` versus `similar` labels and the adherence check, and product swap rules are owned by [commerce.md](commerce.md#style-kits-and-products).

### Rules

- One kit per (holiday, scene type): `kitId` = `<holidayId>.<sceneType>`, 4 to 6 archetypes, authored inside the pack's scene section and seeded into `style_kits` and `kit_items` at publication ([Holiday packs](#holiday-packs)). Styles are subsets of the same kit through `quantity` and `required`, so the catalog stays small.
- Spec text and attributes are written in-house from a product's public attributes. Merchant titles, bullets, descriptions and images never appear in prompts, spec text or pack files.
- An archetype whose anchors are absent from the analysis is dropped from the plan and from the shop panel for that render; the panel never shows an item the plan did not place.
- Changing an archetype's spec text or attributes is a pack MINOR bump; replacing the product behind an unchanged archetype is a commerce operation that does not touch the pack.
- The same real product may back archetypes in several kits (warm-white string lights in the Christmas and New Year's Eve exterior kits); each kit keeps its own `kitItemId`.
- Spec attributes are the structured fields the adherence check and product matching use: `category`, `sizeRange`, `material`, `colorFamily`, `lit` (and `lightColor` when lit), `indoorOutdoor`, `countRange`. The quality rubric's plan-adherence score judges renders against the same spec text ([quality-and-benchmark.md](quality-and-benchmark.md#review-rubric)).

### Kit coverage

| Kit | Archetypes | Where defined |
| --- | --- | --- |
| `christmas.house_exterior` | warm-white string lights, evergreen wreath, evergreen garland, potted evergreen pair, flameless lantern, window wreaths | [Example packs](#example-packs) |
| `christmas.interior` | pre-lit tree, lit mantel or window garland, stockings, table centerpiece, sideboard arrangement, wrapped gifts | Example packs |
| `christmas.apartment_entry` | door wreath, lit frame garland, lantern pair, small potted evergreen, banister garland | Example packs |
| `christmas.balcony` | railing lights (warm white), door-frame garland, small potted evergreen, lantern, door wreath | Pack file; same pattern as the Halloween balcony kit |
| `thanksgiving_us.house_exterior` | autumn wreath, harvest garland, pumpkin group, potted mums, corn stalks | Example packs |
| `thanksgiving_us.interior` | table runner, low centerpiece, flameless candles, place accents, sideboard harvest arrangement, window garland | Example packs |
| `thanksgiving_us.apartment_entry` | autumn door wreath, harvest frame garland, pumpkin group in the alcove, potted mum | Pack file |
| `thanksgiving_us.balcony` | autumn door wreath, pumpkin and gourd group, potted mums, harvest garland along the inside of the railing | Pack file |
| `halloween.house_exterior` | jack-o'-lanterns, pumpkin group, cobwebs, orange and purple string lights, mums and corn stalks, stylized skeleton (`abundant` only) | Example packs |
| `halloween.balcony` | railing lights, small jack-o'-lanterns, cobwebs, door wreath, potted mum, bat silhouettes | Example packs |
| `halloween.apartment_entry` | black and orange door wreath, small jack-o'-lantern pair in the alcove, cobweb on the frame, bat silhouettes beside the door | Pack file |
| `halloween.interior` | mantel or table garland in black and orange, small pumpkin and gourd grouping, flameless candles in dark holders, bat silhouettes on a wall, cobweb on a shelf (`abundant` only) | Pack file |
| `new_years_eve.house_exterior`, `.balcony`, `.interior` (optional pack) | warm-white and gold string lights, metallic garland, lanterns, a set table with flameless candles, gold and silver ornament bowls | Pack file, only if the pack passes review |

### Spec attributes for the example kits

| Kit | Archetype (`kitItemId` suffix) | Category | Size range | Material | Color family | Lit | Use |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `christmas.house_exterior` | `string_lights_warm_white` | string lights | 25–100 ft run | LED on green wire | warm white | yes, warm white | outdoor |
| | `wreath_evergreen` | wreath | 24–30 in | artificial mixed evergreen, velvet bow | green, red | no | outdoor |
| | `garland_evergreen` | garland | 6–9 ft | artificial evergreen, pinecones | green, brown | no | outdoor |
| | `potted_evergreen_pair` | potted tree | 3–4 ft | artificial evergreen in pot, lights | green, warm white | yes | outdoor |
| | `lantern_flameless` | lantern | 12–20 in | black metal, glass, flameless pillar | black, warm white | yes, flameless | outdoor |
| | `window_wreath` | wreath | 12–16 in | artificial evergreen, bow | green, red | no | outdoor |
| `christmas.interior` | `tree_prelit` | tree | 6–7.5 ft | artificial evergreen, pre-lit | green, warm white, red, gold | yes | indoor |
| | `mantel_garland_lit` | garland | 6–9 ft | artificial evergreen, pinecones, lights | green, warm white | yes | indoor |
| | `stockings` | stocking | 18–20 in | knit | red, cream, green | no | indoor |
| | `table_centerpiece` | centerpiece | 24–36 in | artificial evergreen, berries, flameless candles | green, red, white | yes, flameless | indoor |
| | `sideboard_arrangement` | arrangement | 12–18 in | artificial evergreen, ornaments, flameless candle | green, gold | yes, flameless | indoor |
| | `wrapped_gifts` | gift wrap | boxes 6–14 in | paper, ribbon | red, gold, cream | no | indoor |
| `thanksgiving_us.house_exterior` | `wreath_autumn` | wreath | 22–26 in | artificial maple leaves, pinecones, wheat | orange, russet | no | outdoor |
| | `garland_harvest` | garland | 6–9 ft | artificial leaves, small gourds | amber, rust | no | outdoor |
| | `pumpkin_group` | pumpkins | 6–14 in each | real or foam pumpkins and gourds | orange, white | no | outdoor |
| | `mums_potted` | potted plant | 10–14 in pot | chrysanthemum | rust, gold, burgundy | no | outdoor |
| | `corn_stalks` | stalk bundle | 5–7 ft | dried corn stalks, twine | tan | no | outdoor |
| `thanksgiving_us.interior` | `table_runner` | table linen | 72–108 in | woven linen or cotton | rust, mustard | no | indoor |
| | `centerpiece_low` | centerpiece | 24–36 in, under 10 in tall | small pumpkins, gourds, eucalyptus, leaves | orange, green, cream | no | indoor |
| | `candles_flameless` | candles | tapers 10–12 in, pillars 4–8 in | flameless LED, brass or glass holders | ivory, brass | yes, flameless | indoor |
| | `place_accents` | napkins | 20 in napkins with rings | cloth, metal or wood rings | rust, olive, mustard | no | indoor |
| | `sideboard_harvest` | arrangement | 12–24 in | leaves, small pumpkins, wheat | orange, tan | no | indoor |
| | `window_garland` | garland | about 6 ft | artificial autumn leaves | orange, russet | no | indoor |
| `halloween.house_exterior` | `jack_o_lanterns` | carved pumpkins | 8–14 in | real or foam, flameless candles | orange, warm glow | yes, flameless | outdoor |
| | `pumpkin_group` | pumpkins | 6–14 in | pumpkins and gourds | orange, white | no | outdoor |
| | `cobwebs` | cobweb | 1–2 stretched packs | synthetic fiber | white | no | outdoor |
| | `string_lights_orange_purple` | string lights | 25–50 ft | LED on black wire | orange, purple | yes | outdoor |
| | `mums_and_corn` | potted plant and stalks | 10–14 in pot, 5–7 ft stalks | chrysanthemum, dried stalks | rust, gold, tan | no | outdoor |
| | `skeleton_stylized` | figure | about 5 ft | plastic | bone white | no | outdoor |
| `halloween.balcony` | `railing_lights` | string lights | 10–25 ft | battery LED | orange or warm white | yes | outdoor |
| | `jack_o_lanterns_small` | carved pumpkins | 5–8 in | foam or real, flameless tea lights | orange, warm glow | yes, flameless | outdoor |
| | `cobwebs` | cobweb | 1 pack | synthetic fiber | white | no | outdoor |
| | `door_wreath` | wreath | 14–18 in | artificial leaves, mini pumpkins | black, orange | no | outdoor |
| | `mums_potted` | potted plant | 10–12 in pot | chrysanthemum | rust, gold | no | outdoor |
| | `bat_silhouettes` | wall decal | 3–6 in each, 12–20 pieces | paper or vinyl | black | no | outdoor |
| `christmas.apartment_entry` | `door_wreath` | wreath | 18–24 in | artificial evergreen, bow | green, red | no | indoor or outdoor |
| | `frame_garland_lit` | garland | about 9 ft | artificial evergreen, battery lights | green, warm white | yes | indoor or outdoor |
| | `lantern_pair` | lantern | 10–14 in | metal, glass, flameless candle | black, warm white | yes, flameless | indoor or outdoor |
| | `potted_evergreen_small` | potted tree | 2–3 ft | artificial evergreen, battery lights | green, warm white | yes | indoor or outdoor |
| | `banister_garland` | garland | about 9 ft | artificial evergreen | green | no | indoor or outdoor |

## Lighting policy

Proposed ([D-10](../decisions.md#d-10)). `source` keeps the photo's own light and renders electric decor switched on with a modest glow consistent with the existing exposure; `evening` relights the scene to dusk so lit decor reads clearly. Definitions, the relight instructions, why compositing is disabled in `evening` and how QA judges a relit image are in [render-pipeline.md](render-pipeline.md#lighting-modes). This section says which modes each content cell offers and what `evening` means for each holiday.

### Defaults and offered modes

| Holiday | `house_exterior` | `apartment_entry` | `balcony` | `interior` |
| --- | --- | --- | --- | --- |
| `halloween` | default `source`; `evening` offered | `source` only | default `source`; `evening` offered | default `source`; `evening` offered |
| `thanksgiving_us` | `source` only; no electric lights in the kit | `source` only | `source` only | default `source`; `evening` offered (candlelit table, matching the hero) |
| `christmas` | default `source`; `evening` offered | `source` only | default `source`; `evening` offered | default `source`; `evening` offered |
| `new_years_eve` (optional) | default `source`; `evening` offered | not offered (no section) | default `source`; `evening` offered | default `source`; `evening` offered |

Rules:

- `evening` is offered after the first result, as a control on the result screen ([experience.md](experience.md#changing-holiday-style-and-lighting)), and only when scene analysis judges the source to be daylight. A source already photographed at dusk or night gets `source` only; its lit decor glows regardless.
- `apartment_entry` offers `source` only in the US Release: corridor and stoop light is usually artificial and a dusk relight has no clear meaning there.
- Thanksgiving exteriors have nothing to light, so `evening` is not offered; the harvest porch is a daylight scene by design.
- The table is the upper bound. `evening` stays in a `house_exterior` offered set only where the benchmark lighting rule passed for that holiday, and in the Thanksgiving and Christmas `interior` offered sets only where the interior lighting check passed ([quality-and-benchmark.md](quality-and-benchmark.md#statistics-and-decision-rules)); New Year's Eve inherits the Christmas decision. Other `evening` cells are offered on golden-render approval ([Pack testing](#pack-testing)). A withheld mode is removed from the pack's `offered` list, which is a MINOR bump.
- A default may change to `evening` for a holiday and scene type only when the benchmark lighting arm passes the decision rule in [quality-and-benchmark.md](quality-and-benchmark.md#statistics-and-decision-rules). The change is a pack MAJOR bump and a dated entry in the decision log; it is never made from taste alone. The reason the arm exists: the Christmas exterior kit centers on string lights, and a daylight render of unlit strings may be judged less appealing than a dusk render, while a relight changes every pixel and raises structural risk.
- For Street View-origin sources an `evening` relight alters the whole frame, which is a different use from adding decor. It is named separately in the licensing request brief, and whether `evening` is offered for `street_view` source assets follows the recorded grant ([address-and-street-view.md](address-and-street-view.md#licensing-request-brief)); the offered set is therefore configuration per source kind, with the pack's offered set as the upper bound.

### Evening guidance per holiday

The `lightingPolicy.eveningGuidance` fragment each pack compiles when `lightingMode` is `evening`. All variants share: early dusk, not night; the sky darkens to blue hour and ambient light lowers while the structure, materials, colors, neighbors and camera stay identical in shape and position; light comes only from placed decorations and from windows that exist in the source; nothing is added to the sky.

| Holiday | Evening guidance |
| --- | --- |
| `christmas` | Electric decorations named in the placements glow warm white with soft bloom and contact light on the surfaces they touch; nothing else is lit or added; existing windows may show a soft warm interior glow. |
| `halloween` | Jack-o'-lanterns glow from inside; orange and purple string lights cast a restrained colored glow on railings and walls; cooler ambient than Christmas; no fog, no colored sky. |
| `new_years_eve` | Warm-white and gold string lights with gentle sparkle; metallic garland catches the light; no fireworks or sky effects. |
| `thanksgiving_us` (interiors only) | Flameless candles and existing lamps carry the room; warm, low, even light across the table; daylight from windows reduced to dusk. |

## Climate, culture and existing decorations

### Climate

- **Snow.** Snow, frost and icicles are never added unless the source shows them (`snow_or_frost_unless_visible`, baseline forbidden item; QA `unrequested_change`). A warm-climate home never becomes a snowy scene, and a Christmas pack has no "snowy" variant.
- **Climate class.** `cold`, `mild`, `warm`, resolved in the order the pack's `climateRule.sourcePrecedence` gives: season cues from scene analysis (visible snow, bare or leafy foliage, lawn state; [render-pipeline.md](render-pipeline.md#scene-analysis)), then the address region on the address path (a US state to climate class table kept beside the packs in the content directory, authored as a content item in the [backlog](../backlog.md) with the design and editorial lead accountable, and looked up at planning time from the state in the property's address components), then `neutral`. The resolved class and its source are recorded on the decoration plan ([render-pipeline.md](render-pipeline.md#decoration-plan)); nothing else about climate is stored. Upload-first projects without an address stop at scene analysis.
- **What the class changes.** Only kit eligibility through `coldClimateOnlyItems` (the US Release packs list none) and the `neutral` fallback's conservative choices. Decor plants such as chrysanthemums and artificial evergreens are placed in every climate; existing foliage, lawns and planting beds are never changed (`landscaping_changes`).
- **Heroes are climate-neutral.** The Christmas hero shows no snow, so a visitor in a warm climate is not promised a scene the product will not draw ([Hero and example art](#hero-and-example-art)).

### Culture

- Religion is never inferred from an address, a name or an image, and the US Release packs are secular by default ([US holiday catalog](#us-holiday-catalog)). Religious sub-traditions are later packs that a user selects explicitly.
- Thanksgiving packs use harvest imagery only: no Pilgrim, Native American or other costume or caricature imagery (`costume_caricature`).
- Halloween packs contain no religious imagery and no imagery from other traditions: Día de los Muertos motifs (sugar skulls, ofrendas) are a distinct tradition and are not Halloween decor; no derogatory costumes or effigies.
- Christmas packs contain no religious symbols and no Santa, snowman or reindeer figures; evergreen, light, bows and ornaments carry the look.
- **Not directed to children** (Proposed, [D-17](../decisions.md#d-17)). No child-oriented characters, cartoon or animated figures, mascots, inflatables, toys, child models or child-targeted advertising appear in heroes, packs, kits, example art or copy. Animated characters, child models and child-oriented subject matter are among the factors the FTC lists for deciding whether a service is directed to children (FTC COPPA FAQ, https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions, retrieved 2026-11-08). The audience policy and counsel review live in [privacy-safety-legal.md](privacy-safety-legal.md#audience-and-age); the content checklist applies the guardrail to every pack, hero and example.

### Existing decorations

- Scene analysis reports existing decorations (likely holiday, density) and the plan builder reads them ([render-pipeline.md](render-pipeline.md#scene-analysis)). The only policy in the US Release is `preserve_and_complement`: existing decorations are never removed, moved or altered; new items go on anchors that are still free.
- When the existing decorations belong to the chosen holiday, the plan fills the free anchors and skips occupied ones.
- When they belong to a different holiday (Halloween decor in an October Street View capture while Christmas is chosen), the render proceeds and the result screen shows a non-blocking notice that the photo already shows other decorations and that a current photo gives a cleaner result; the mixed result is honest, removal would not be. Copy and placement are in [experience.md](experience.md#result-and-comparison).
- When existing decoration density is high, the plan uses the quantities of the next-lower style (an `abundant` request places `classic` quantities and placement limits; [Placement fields](#placement-fields)) so the scene does not become cluttered.

### Neighbors, access and occluders

- Nothing is placed on a building, balcony, door or railing that is not the target; the plan validator rejects placement regions outside the target facade or unit (`neighbor_decorated`). Attached houses are decorated within the target unit's facade span only.
- Doors, steps, walkways, corridors, balcony doors, stairs and fire equipment stay passable (`access_blocked`); keep-clear rules per scene section are the enforceable form.
- Occluders such as parked vehicles, bins and foliage are never removed and nothing is invented behind them; when a Street View view is badly occluded the address path offers an alternate view or the user's own photo ([address-and-street-view.md](address-and-street-view.md#viewpoint-selection)).

## Hero and example art

### Heroes

One approved hero per occurrence plus one neutral hero for the off-season. Heroes are editorial art, produced separately from property edits.

| Rule | Requirement |
| --- | --- |
| Sources | Every hero and example is a real photograph or indistinguishable from one: real homes, dining rooms and landscapes, hyperrealistic and professionally lit (Fixed [D-49](../decisions.md#d-49)). Illustration, cartoon, painterly or 3D-render looks and animation are never used. Commissioned or licensed photography is preferred. Photorealistic generated imagery is allowed with a complete rights record (model ID, prompt version, vendor terms reference) and IPTC digital source type metadata per [render-pipeline.md](render-pipeline.md#provenance-and-labeling); it is never captioned as a customer's result. Never a real customer's home, never a Street View image, never a listing or stock photo without AI-display rights. |
| People | No identifiable people and no children in any hero. |
| Climate | Climate-neutral: no snow in the Christmas hero; nothing that only one US region could show. |
| Composition | The subject survives both crops; a quiet area for the headline and address input is reserved and recorded as a focal point and safe area per crop; contrast for text comes from the image itself, not a heavy dark overlay; still images only. |
| Approval | Approved at desktop and mobile sizes by the content checklist ([Content authoring and review](#content-authoring-and-review)) before an occurrence that uses it can be enabled. |

Art direction per holiday:

| Holiday | Art direction |
| --- | --- |
| `thanksgiving_us` | An expansive dining room, warm candlelight, a beautifully set dinner table, natural autumn color, rich but restrained styling, bright readable detail. The user's own words: "a table with full Thanksgiving dinner in a candlelit big dining room". |
| `christmas` | Architectural warmth, tasteful evergreen decorations, luminous warm-white lights, professional editorial photography. Not dark, oversaturated or cluttered; no snow. |
| `halloween` | A porch or entry at early dusk with glowing jack-o'-lanterns, pumpkins, mums and restrained cobwebs; playful and elegant, not gory, no characters. |
| `new_years_eve` (optional) | An elegant table or balcony with warm-white and gold string lights and metallic accents; sparkle without fireworks; no branded bottles or text. |
| Neutral (off-season) | A bright, uncluttered real-home scene with no holiday decor, for example a sunlit living room or a front porch with plants; climate-neutral; leaves room for the picker. |

Sizes and formats (defaults; delivery mechanics in [architecture.md](../architecture.md#landing-and-share-page-delivery)):

| Asset | Specification |
| --- | --- |
| Master | At least 3000 px on the long edge, sRGB, lossless or highest-quality source kept in object storage |
| Landscape crop (3:2) | Renditions 2400, 1600, 1200 and 800 px wide in AVIF, WebP and JPEG; explicit width and height recorded |
| Portrait crop (2:3) | Renditions 1080×1620 and 720×1080 in the same formats; art-directed, not a center crop |
| Social and share card background | 1200×630 derived from the landscape crop |
| Byte budget | The rendition a phone loads first is at most about 200 KB (default, configuration), so the mobile web-vitals targets in [PLAN.md](../PLAN.md#10-quality-bar-and-release-criteria) hold |
| Focal point and safe area | `focalPoint` (x, y in 0–1) and `safeArea` (box in 0–1) per crop |

Rights record (one per hero, stored as `hero_assets` with an `asset_policies` row; columns in [data-and-api.md](data-and-api.md#entities)):

| Field | Meaning |
| --- | --- |
| `heroAssetId`, `holidayId` or `neutral`, `orientation` | Identity |
| `sourceKind` | `commissioned`, `licensed` or `generated` |
| `creator`, `licensor`, `licenseRef`, `licenseVersion`, `territory` | Who made it and under what terms |
| `permittedUses` | `landing`, `share_card`, `example_pages`, `marketing` (marketing is a separate opt-in) |
| `attribution`, `expiresAt` | Required credit, if any, and license expiry |
| `generation` | For generated art: model ID, prompt version, vendor terms reference, provenance metadata written |
| `approvedAt`, `approvedBy`, `approvedCrops` | Approval record for landscape and portrait |

Switching is data-driven: each occurrence names its `heroAssetId`, the server shell resolves the hero for the default in America/New_York, and the client never swaps it ([Windows and selection](#windows-and-selection)). Changing a hero is a configuration change, not a deploy. An occurrence without an approved hero cannot be enabled.

### Example before/after pairs

Proposed ([D-11](../decisions.md#d-11)): one permissioned before/after example per holiday and scene type, so a visitor can see what the product makes before any spend and so the Thanksgiving exterior's modest harvest porch is expected rather than a disappointment.

| Rule | Requirement |
| --- | --- |
| Coverage | 12 pairs in the US Release (3 holidays × 4 scene types), 3 more if New Year's Eve is enabled; style `classic`, lighting `source`; an `evening` pair may be added where offered. |
| Source photos | From the permissioned corpus ([quality-and-benchmark.md](quality-and-benchmark.md#permissioned-corpus)) and only assets whose release permits example and marketing use. Never a customer project, never a Street View image. |
| Production | Rendered by the production pipeline with the active pack version, never hand-edited, so examples represent current output. Regenerated when the pack's MAJOR.MINOR changes or the pipeline is re-benchmarked; each regeneration passes the content checklist. |
| Labeling | Shown with the "AI preview" label and an "Example" caption wherever they appear: behind "See an example" on the landing and during waits ([experience.md](experience.md#waiting-and-progress)). |
| Record | `exampleId`, `holidayId`, `sceneType`, `style`, `lightingMode`, `sourceAssetId`, `renderAssetId`, `packVersion`, rights evidence, `approvedAt`; stored as `example_assets` ([data-and-api.md](data-and-api.md#entities)). |

## Content authoring and review

### Roles

| Role | Responsibility in this specification |
| --- | --- |
| Product owner (the user) | Settles the catalog ([D-08](../decisions.md#d-08)), windows ([D-09](../decisions.md#d-09)) and any lighting default change ([D-10](../decisions.md#d-10)); approves briefs. |
| Design and editorial lead | Accountable for briefs, packs, kit archetypes, the US state to climate class table, heroes and example pairs; first approver. |
| Second approver | An independent editorial or design approver for every pack version, hero and example; never the author. |
| AI pipeline engineer | Keeps the pack schema and enums in core, compiles packs, runs golden renders, loads the climate table at planning time and maintains the occurrence generator. |
| Commercial lead | Maps products to archetypes and maintains offers ([commerce.md](commerce.md#commerce-operations)). |
| Counsel (external) | Applies the not-directed-to-children factors to the landing and the Halloween pack as part of the audience policy ([privacy-safety-legal.md](privacy-safety-legal.md#audience-and-age)). |
| Operations | Rights records, asset publication, occurrence enablement. |

Production work is tracked as the content items in the [backlog](../backlog.md) (permissioned corpus, holiday packs per holiday, style kits, hero art, example before/afters).

### Authoring sequence

1. **Brief.** Subject, mood, scene types covered, climate guidance, forbidden symbols and the lighting policy for the holiday; approved by the product owner and the design and editorial lead. Not consumed by code.
2. **Pack draft.** A schema-valid pack with every scene section the holiday offers, kit archetypes with spec text and attributes, quantity rules per style and prompt fragments. The draft passes CI validation before anyone renders with it.
3. **Golden renders.** Each offered content cell is rendered through the production pipeline on the tuning set ([quality-and-benchmark.md](quality-and-benchmark.md#exploratory-spike); never the held-out set or the formal benchmark photos). The `classic`/`source` cells come first; `subtle`, `abundant` and `evening` cells are approved separately.
4. **Review.** Both approvers walk the checklist below over the pack text and the golden renders and record the result in the pack's `review` block.
5. **Publication.** The pack version is published ([Holiday packs](#holiday-packs)); its kit archetypes are seeded for commerce; the occurrence pins the version.
6. **Enablement.** An occurrence is enabled only when its pack version is approved, its hero is approved, and every scene type the pack offers has an approved `classic`/`source` cell. A holiday with no enabled occurrence never appears in the picker.

### Review checklist

Applied to every pack version (text and golden renders), every hero and every example pair. A single failed item blocks approval.

1. Symbolism: secular by default; no religious symbols unless the pack is an explicitly selected sub-tradition; no caricature or costume imagery; nothing from another tradition.
2. Spelling and signage: display names and tradition notes are correct; no lettering, numerals or signs appear in any rendered item or hero.
3. Placement plausibility: attachments look secure, scale matches the scene, nothing floats, nothing sits on step treads, railing tops or seating.
4. Child-appeal guardrails: no characters, mascots, inflatables, toys, child models or child-targeted framing.
5. Climate: no snow, frost or icicles unless the source shows them; heroes are climate-neutral.
6. Access and egress: doors, steps, walkways, corridors, balcony doors and fire equipment stay clear in every golden render.
7. Flame safety: indoor candles are enclosed or flameless; no open flame near fabric or foliage.
8. Brand and trademark: no logos, packaging or merchant text; spec text is in our own words.
9. Neighbors and people: nothing on neighboring property; people and pets unchanged.
10. Inspectability: the result stays bright enough to inspect; `evening` renders keep the structure legible.
11. Street View sources: attribution and any burned-in logo remain visible and unaltered (`attribution_altered`); existing blur regions are untouched ([address-and-street-view.md](address-and-street-view.md#before-image-and-attribution)).
12. Consistency: the forbidden list contains the baseline; quantity rules never decrease from `subtle` to `classic` to `abundant`; prompt fragments agree with the forbidden list; every kit has 4 to 6 archetypes; lighting defaults match [Lighting policy](#lighting-policy).

### Pack testing

- **Schema and cross-field validation** in CI for every pack file; unknown anchor categories, forbidden items or scene types fail the build.
- **Golden compiled instructions**: the render spec's golden-file test compiles a fixed set of synthetic scene analyses against every offered content cell; pack changes update the golden files deliberately in the same change ([render-pipeline.md](render-pipeline.md#prompt-compilation)).
- **Golden renders** on the tuning set for every MAJOR or MINOR change, limited to the affected cells; approvers compare the previous and new renders side by side and record `goldenRunId`. Cost is recorded like any other render ([economics.md](economics.md#cost-worksheet)).
- **Benchmark relationship**: the formal benchmark measures the `classic`/`source` cells, the lighting arm and the interior lighting check ([quality-and-benchmark.md](quality-and-benchmark.md#formal-benchmark)); every other cell is offered on golden-render approval, not assumed from the benchmark.
- **Calendar tests**: the worked-calendar rows and test vectors in this file are unit tests, re-run with each new year's occurrences.

### Release and cache invalidation

1. Merge the pack change with its golden-file updates and approval record.
2. Deploy; the server validates the file at start.
3. Insert the `holiday_pack_versions` row and set its `status` to `published` (the previous row becomes `retired`); occurrences that should use it pin the new version.
4. The experience projection changes immediately; the cached landing shell keys roll ([architecture.md](../architecture.md#landing-and-share-page-delivery)).
5. MAJOR or MINOR: cached variants with the previous `holidayPackVersion` are no longer returned; the next request renders anew ([render-pipeline.md](render-pipeline.md#variant-key-and-reuse)). PATCH: nothing is invalidated.
6. Rollback: set the previous row back to `published` and retire the current one; the previous MAJOR.MINOR file is still deployed because files are kept until no occurrence references them.

Changes that touch a decision (catalog, windows, lighting defaults) are also recorded as dated entries in the [decision log](../decisions.md#decision-log). Pack releases themselves are content releases and are recorded only in `holiday_pack_versions`.

### Annual calendar review

Before the Halloween promotion window opens each year (so, by early September), the design and editorial lead and the AI pipeline engineer:

1. Generate the next calendar year's occurrences (fixed dates; fourth Thursday for Thanksgiving) and add the year's rows to the worked calendar and test vectors.
2. Confirm promotion windows, `editorialPriority`, hero assignments and pack versions per occurrence; decide whether the New Year's Eve pack is enabled.
3. Confirm commerce windows with the commercial lead ([commerce.md](commerce.md#seasonal-commerce-calendar)).
4. Re-run the calendar unit tests and the example-pair regeneration if a pack changed.
5. Enable the occurrences and record `reviewedAt` and `reviewedBy`.

The same review runs whenever the catalog changes (a holiday added or retired) or a decision changes a window.
