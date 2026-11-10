# Experience specification

Holiday shows a person their real home decorated for a holiday and helps them find the decorations. This document specifies what that person sees and does: every screen and state, the wording, the controls, and the rules that keep the product simple, honest and accessible. Engineers and coding agents implement `apps/web` from it; mechanics that belong to other specifications are linked, not restated.

**Owns:** screens and states; friction budget; copy deck; controls; allowance UX; sharing UX and share page content; report and feedback UX; accessibility requirements; mobile layout.
**Baseline:** planning baseline 2026-11-09; external facts retrieved 2026-11-08.

## Experience principles

The product thesis is Fixed ([D-49](../decisions.md#d-49); [PLAN §1](../PLAN.md#1-product-promise)): the experience must be simple, beautiful and emotional, because those qualities, not the AI capability, are why people choose Holiday, and the feeling of seeing their own place transformed is what nudges them to decorate it themselves. The landing and interaction model is Fixed ([D-06](../decisions.md#d-06)): a seasonal hero for the upcoming holiday, one prominent address input that accepts any US address, a quieter upload route, easy address and holiday switching, and nothing else competing for attention. The result must be a faithfully decorated real photograph ([D-07](../decisions.md#d-07)). The principles below turn those decisions into rules every screen follows. When a screen must choose between the thesis and another feature, control or notice, the thesis wins; safety, honesty and legal notices are never dropped, and the [friction budget](#friction-budget) places each one.

| Principle | Rule | What it forbids |
| --- | --- | --- |
| The reveal is the moment | The first time a visitor sees their own place decorated is the product's central moment. The first result of a project arrives as a reveal: the card shows the visitor's photo, then crossfades to the AI preview ([result card](#result-card)). Controls, notices and Shop the look sit below the card, so nothing but the required labels and attribution shares the moment. | Pop-ups, prompts, sign-up walls or the shop panel above the result at the reveal; notices covering the image. |
| Warm, celebratory voice | Copy is short, warm and specific to the holiday and the place, written like a friend who loves the holidays (for example "Your porch, ready for Halloween"); the [copy deck](#copy-deck) follows this voice. | Technical jargon, sales language, urgency, guilt or scarcity. |
| Nudge, never pressure | Shop the look follows the reveal and invites the visitor to recreate the look, with honest relationship labels and the ad disclosure ([commerce spec](commerce.md#shop-the-look)). A visitor who only wants to enjoy the picture loses nothing. | Countdown timers, fake scarcity, auto-opening shop panels, purchase prompts before the reveal, repeated nagging. |
| Quiet UI | One wordmark, one hero, one input. Legal and informational links live in the footer. Controls appear when they become useful (style and lighting after the first result). | Dashboards, dense forms, banners, modals that are not triggered by the person's own action or content. |
| Photo-first | The photograph fills the screen; text and controls sit beside or below it and never cover attribution or the AI preview label. Every image is a real photograph or hyperrealistic and indistinguishable from one ([D-49](../decisions.md#d-49)). | Heavy overlays, decorative chrome, controls layered over the image; illustrations, cartoons, clip art or animation standing in for imagery. |
| Honest states | Every state names what is true: which photo is shown, where it came from, whether it is being decorated, whether a person is reviewing it, what is left of the allowance. A synthesized house, a neighbor's building or a gray placeholder is never shown as the person's place. | Placeholder imagery standing in for the address, silent failures, controls that appear to work but do nothing. |
| One primary action per screen | Each screen has exactly one primary button; everything else is secondary or a link. | Two equal calls to action; wizards. |
| No fake progress | Waiting screens show the canonical stage label for the render job's state and, when relevant, the queue position. | Percentages, timed progress bars, invented sub-steps. |
| Nothing fails silently | At a limit the controls stay enabled and explain what happened and when it resets; every error code in [data-and-api.md#error-codes](data-and-api.md#error-codes) has a copy key in this document. | Disabled controls without explanation, generic "error" toasts. |

## Friction budget

"Dead simple" is a budget: at most one unconditional blocking step before the first render on each path. Conditional interrupts are allowed only when the person's own address or photo triggers them, and each is one tap to resolve.

| Path | Unconditional blocking steps before the first render | Conditional interrupts (triggered by the input) |
| --- | --- | --- |
| Address, `matchClass` = `auto_start` | 0. The render starts as soon as discovery returns `auto_start`; the waiting screen carries a passive "Not your place?" escape. | None. |
| Address, `matchClass` = `confirm`, manual entry, or off-season | 1. "Is this the right place?" (off-season adds a holiday choice on the same screen). | None. |
| Address, source mode `display_only` (interim experience, [D-16](../decisions.md#d-16)) | 1. The age-and-rights checkbox on the upload step that follows confirmation. | People detected; scene type below the confidence floor. |
| Upload | 1. The age-and-rights checkbox ([D-17](../decisions.md#d-17)). | People detected ([D-18](../decisions.md#d-18)); scene type below the confidence floor. |

The bot check at session creation ([D-38](../decisions.md#d-38)) is invisible unless the challenge fails, in which case `VERIFICATION_REQUIRED` adds one exceptional step; it is not counted in the budget.

### Placement of every notice

| Notice | Where | Treatment | Wording owner |
| --- | --- | --- | --- |
| Age line (D-17) | Directly under the address input on the landing page | Passive, one line, links to Terms | This spec (`landing.ageLine`) |
| Terms and Privacy links | Footer of every page; inside the age line and the upload checkbox | Passive | Documents: [privacy-safety-legal.md#legal-deliverables](privacy-safety-legal.md#legal-deliverables) |
| Google Maps attribution and per-image copyright | Inside the image card, directly below the image, on every screen that shows Street View pixels (confirm, interim prompt, waiting, result, share page) | Passive; never over the image; never cropped or covered; persists in every comparison state | Rules: [address-and-street-view.md#before-image-and-attribution](address-and-street-view.md#before-image-and-attribution) |
| Capture date | Same strip as the attribution | Passive | [address-and-street-view.md#before-image-and-attribution](address-and-street-view.md#before-image-and-attribution) |
| "AI preview" label ([D-28](../decisions.md#d-28)) | Badge in a corner of every generated image, on the share page, on share cards and in downloads (a small burned-in corner mark, on by default; configuration). On screen the badge sits in the lower-right corner unless the image carries burned-in attribution there, which every Street View-origin image (fixture or live) does; then it sits in the lower-left corner. The rule applies everywhere the badge appears: result card and comparison slider, share page, share card preview, Your places thumbnails and examples ([AI preview badge placement](#ai-preview-badge-placement)) | Passive, persistent, never over attribution: neither the strip below the image nor attribution burned into the image | Mechanics: [render-pipeline.md#provenance-and-labeling](render-pipeline.md#provenance-and-labeling) |
| "Ad" label and disclosure line ([D-26](../decisions.md#d-26)) | Header of the Shop the look panel, above the first product card, visible before any click | Passive, adjacent | [commerce.md#disclosure](commerce.md#disclosure) |
| Amazon statement | Footer of the Shop the look panel whenever an Amazon offer is shown | Passive | [commerce.md#disclosure](commerce.md#disclosure) |
| Age-and-rights checkbox (D-17) | Upload screen, before any file leaves the device | Blocking (the one blocking step on the upload path) | This spec (`upload.attestation`) |
| Processing and retention line | Under the checkbox | Passive | Values: [privacy-safety-legal.md#retention-schedule](privacy-safety-legal.md#retention-schedule) |
| Photo guidance | Upload screen, collapsed under "Tips for a great photo" | Passive | Content: [uploads.md#scene-type-and-photo-guidance](uploads.md#scene-type-and-photo-guidance) |
| Scene-type chip | After screening and in the result header | Passive one-tap correction; blocking only when confidence is below the floor | [uploads.md#scene-type-and-photo-guidance](uploads.md#scene-type-and-photo-guidance) |
| People-detected prompt (D-18) | After screening, before the render request | Conditional blocking: one sheet, two buttons | Behavior: [uploads.md#people-in-photos](uploads.md#people-in-photos) |
| "Is this the right place?" | Confirm screen | Conditional blocking (the one blocking step on the address path) | Thresholds: [address-and-street-view.md#match-confidence-and-auto-start](address-and-street-view.md#match-confidence-and-auto-start) |
| "Not your place?" escape | Waiting screen after `auto_start` | Passive link | This spec (`wait.notYourPlace`) |
| Allowance counter ([D-12](../decisions.md#d-12)) | Beside the holiday, style and lighting controls, after the first result | Passive | Values: [economics.md#capacity-and-spend-ceilings](economics.md#capacity-and-spend-ceilings) |
| Interim photo prompt (D-16) | Replaces the primary action on the confirm screen in `display_only` mode | Structural: it is the path | [address-and-street-view.md#licensing-outcomes-and-activation](address-and-street-view.md#licensing-outcomes-and-activation) |
| Existing-decorations and stale-photo notices | Result card, below the image | Passive | Rules: [holidays-and-content.md#climate-culture-and-existing-decorations](holidays-and-content.md#climate-culture-and-existing-decorations); [address-and-street-view.md#panorama-changes-blur-and-takedown](address-and-street-view.md#panorama-changes-blur-and-takedown) |
| Bot challenge | Inline where the blocked action was attempted | Exceptional blocking | [../architecture.md#security-architecture](../architecture.md#security-architecture) |

## Screen and state inventory

### Client routes

The web app is a single-page application served with a server-rendered shell for `/` and `/s/:token` ([D-36](../decisions.md#d-36); mechanics in [../architecture.md#landing-and-share-page-delivery](../architecture.md#landing-and-share-page-delivery)). All other routes are client routes. Project and share identifiers are opaque; no route, URL or page ever contains an address.

| Route | Purpose |
| --- | --- |
| `/` | Landing, address entry, holiday picker |
| `/upload` | Entry to the address-free path; creates an upload-first project and continues at `/p/:projectId` |
| `/p/:projectId` | One project: confirm, interim photo prompt, upload within a project, waiting, result. The screen switches on project state and the current render job state. A project the session does not own shows the not-found screen. |
| `/places` | Saved projects (signed in) |
| `/account` | Email, sign out, delete account |
| `/auth/verify` | Magic-link landing |
| `/s/:token` | Public share page |
| `/dont-decorate-my-home` | Homeowner opt-out form |
| `/terms`, `/privacy`, `/content-policy`, `/ai-disclosure`, `/affiliate-disclosure`, `/accessibility`, `/dmca` | Legal and information pages |

### Inventory

API payloads are defined in [data-and-api.md#http-api](data-and-api.md#http-api); events in [data-and-api.md#analytics-events](data-and-api.md#analytics-events); events the browser emits are sent in batches through `POST /v1/analytics`. Sending them never starts a session: they wait in memory until the page has a session for another reason (an address lookup, an upload, a render) and go out then; events from a page that closes first are dropped. Copy keys are defined in [Copy deck](#copy-deck).

| Screen | Route | States | Entry and exit | API calls and events | Copy keys |
| --- | --- | --- | --- | --- | --- |
| Landing | `/` | In-window (default holiday hero); Thanksgiving emphasis (Thanksgiving window, [D-11](../decisions.md#d-11)); off-season (neutral hero, picker lists all holidays); returning visitor (banner to the live project); budget paused banner | Entry: direct, share-page call to action (`?holiday=`). Exit: suggestion chosen → `/p/:id`; "Upload a photo instead" → `/upload` | Shell inline JSON on first paint; `POST /v1/sessions` on first interaction; `GET /v1/experience` once a session exists while its allowance snapshot is unknown (a holiday change alone sends no request: the hero follows the window, not the chip). Events `landing_viewed`, `holiday_changed` | `landing.*` |
| Address autocomplete | `/` | Idle; typing below the minimum; loading; suggestions; no results; out of scope; rate limited; verification required; manual entry (fields, candidates) | Exit: suggestion → resolve → `/p/:id`; manual candidate → resolve with its `candidateId` → confirm | `GET /v1/addresses/suggestions`, `POST /v1/addresses/resolve`, `POST /v1/addresses/geocode`. Events `address_selected`, `address_manual_submitted` | `address.*`, `error.ADDRESS_OUT_OF_SCOPE`, `error.ADDRESS_NOT_FOUND`, `error.RATE_LIMITED`, `error.VERIFICATION_REQUIRED` |
| Confirm place | `/p/:id` | Finding; candidates (primary plus up to 2 alternates); nudging; none of these; off-season holiday required; `display_only` (becomes the interim prompt) | Entry: discovery result `confirm`, manual entry, or off-season. Exit: confirm → render; "None of these" → upload | `POST /v1/projects/:id/source-discovery`, `PUT /v1/projects/:id/viewpoint`, `PUT /v1/projects/:id/source`, `POST /v1/renders`. Events `source_discovery_completed`, `source_confirmed`, `render_requested` | `confirm.*`, `error.NEEDS_CONFIRMATION` |
| No Street View | `/p/:id` | One screen with a reason-specific line for the client-visible reasons `no_imagery`, `multi_unit`, `low_precision`, `out_of_scope`, `error` and `unavailable` (a stored `blocked_address` is projected to `unavailable`) | Entry: discovery result `skip_to_upload`; `NO_STREET_VIEW` when a later metadata recheck finds the panorama gone. Exit: upload within the project | Events `source_unavailable`, `photo_prompt_shown` | `nosv.*`, `error.NO_STREET_VIEW`, `error.NEEDS_PHOTO` |
| Interim photo prompt | `/p/:id` | Street View image shown for confirmation; upload invited | Entry: source mode `display_only` ([D-16](../decisions.md#d-16)). Exit: upload ready → render; "Try another address" → `/`; "See an example" → examples sheet | `PUT /v1/projects/:id/source`. Event `photo_prompt_shown` | `interim.*`, `landing.seeExample`, `error.SOURCE_NOT_EDITABLE` |
| Upload | `/upload`, or inside `/p/:id` | Picker; camera; guidance; attestation; preparing (client resize); uploading; screening; held for review; ready; declined; people detected; unsupported format; too large | Exit: ready → scene-type chip → render | `POST /v1/projects` (upload-first), `POST /v1/uploads`, `POST /v1/uploads/:id/complete`, `GET /v1/uploads/:id`, `PUT /v1/projects/:id/source`. Events `upload_started`, `upload_accepted`, `upload_declined` | `upload.*` (including `upload.declined.*`), `error.UPLOAD_UNSUPPORTED_FORMAT`, `error.UPLOAD_TOO_LARGE`, `error.UPLOAD_DECLINED`, `error.PEOPLE_DETECTED` |
| Scene-type correction | Inside upload and result | Detected (passive chip); below the confidence floor (choice required); room type for `interior` | Exit: confirmed → render | `PUT /v1/projects/:id/source` (scene type and room type fields) | `scene.*` |
| Waiting | `/p/:id` | One line per render job state with the canonical label; queue position when admitted under load; long wait; `needs_review`; canceling | Entry: 202 from `POST /v1/renders`. Exit: `succeeded` → result; `failed`, `rejected` → render error; `canceled` → confirm or previous result | `GET /v1/renders/:id`, `GET /v1/renders/:id/events`, `POST /v1/renders/:id/cancel`. Event `render_canceled` | `wait.*` |
| Result | `/p/:id` | Ready; new variant pending (superseding); Street View origin (attribution strip); upload origin; private-only (people kept); existing-decorations notice; stale-photo notice; Thanksgiving dining invitation; Shop the look panel state `active`, `no_offers`, `off_season` or `hidden` | Exit: controls → cached variant or new render; Save, Share, Download, Delete; "Change address" → `/`; "Replace photo" → upload | `GET /v1/projects/:id/variants`, `GET /v1/renders/:id/products`, `POST /v1/clicks`, `POST /v1/feedback`. Events `render_succeeded`, `render_superseded`, `variant_viewed`, `compare_used`, `shop_panel_viewed`, `product_clicked`, `feedback_submitted` | `result.*`, `shop.*`, `commerce.*` |
| Allowance reached | Sheet over result, confirm or upload | Looks exhausted; new addresses exhausted | Exit: dismiss; everything behind it stays usable (an uploaded photo whose first look was refused stays attached and on screen) | `ALLOWANCE_EXHAUSTED` from `POST /v1/renders` or `POST /v1/addresses/resolve`; allowance snapshot from `GET /v1/experience`. Event `allowance_reached` | `allowance.*`, `error.ALLOWANCE_EXHAUSTED` |
| Budget paused | Banner on `/` and `/p/:id` | Paused | Exit: none needed; viewing continues | `BUDGET_PAUSED` | `error.BUDGET_PAUSED` |
| At capacity | Sheet | Refused with `Retry-After` | Exit: retry after the countdown | `AT_CAPACITY` | `error.AT_CAPACITY` |
| Render error | `/p/:id` | Provider unavailable, timeout, internal error or unknown outcome (`failed`); source no longer available (`failed`, `source_unavailable`); nothing decoratable (`failed`, `failureKind` `source_rejected`, `failureDetail` `no_usable_anchors` or `facade_not_in_frame`); possibly not the right house or owner-blurred (`source_rejected` with `house_number_mismatch` or `owner_blurred`); vendor or permission refusal (`moderation_blocked`, `policy_denied`); rejected by the quality checks or a reviewer (`rejected`) | Exit: "Try again" (new render job) for provider failures and rejections; for `source_rejected`: "Use another view" (Street View sources; opens the confirm screen with alternates) and "Use another photo", and "Try again" is not offered; "Show it as photographed" after a rejected `evening` look | `GET /v1/renders/:id` with `failureKind`, `failureDetail`, `rejectionReason`. Events `render_failed`, `render_rejected` | `error.PROVIDER_UNAVAILABLE`, `error.RENDER_REJECTED`, `wait.*` |
| Save and sign in | Sheet; `/auth/verify` | Enter email; link sent; verifying; confirm sign-in (link opened in another browser); signed in; link expired or invalid; verification failed (try again) | Exit: signed in → back to the project | `POST /v1/auth/magic-link`, `POST /v1/auth/verify`, `GET /v1/me`. Event `project_saved` | `save.*`, `auth.*` |
| Saved projects | `/places` | List; empty; expiring soon | Exit: open → `/p/:id`; delete | `GET /v1/projects`, `DELETE /v1/projects/:id` | `places.*` |
| Account | `/account` | Signed in; sign out; delete account confirmation | Exit: sign out → `/` | `GET /v1/me`, `POST /v1/auth/logout`, `DELETE /v1/me` | `account.*` |
| Share | Sheet; `/s/:token` | Create (card preview, options); link ready; stop sharing confirmation. Share page: active; revoked or expired; not found | Share page exit: call to action → `/` with holiday preselected; "Report this image" | `POST /v1/shares`, `GET /v1/shares/:token`, `DELETE /v1/shares/:token`; page `GET /s/:token`. Events `share_created`, `share_viewed` | `share.*`, `error.SHARE_REVOKED` |
| Delete confirmation | Sheet | Confirm; deleting; done | Exit: → `/` | `DELETE /v1/projects/:id`. Event `project_deleted` | `delete.*` |
| Report form | Sheet on result and share page | Reasons; details; submitted | Exit: dismiss | `POST /v1/reports`. Event `report_submitted` | `report.*` |
| Homeowner opt-out | `/dont-decorate-my-home` | Address entry; contact; submitted | Exit: dismiss | `GET /v1/addresses/suggestions`, `POST /v1/reports` (reason `this_is_my_home` with the resolved place) | `optout.*` |
| Legal pages | `/terms` and the others listed above | Static | — | None | `legal.*` |
| Not found and forbidden | Any | — | Exit: → `/` | `NOT_FOUND`, `FORBIDDEN` | `error.NOT_FOUND`, `error.FORBIDDEN` |

### Fallback situations, screen by screen

[../../PLAN.md#4-experience-overview](../PLAN.md#4-experience-overview) owns the required fallback behavior table. This table maps each situation to the screen and state that implements it; the required experience is not restated here.

| Situation (PLAN) | Screen and state in this spec | Code |
| --- | --- | --- |
| Autocomplete has no match, or the address is outside the US | Address autocomplete: no results (copy names the US scope and offers manual entry and upload); out of scope | `ADDRESS_NOT_FOUND`, `ADDRESS_OUT_OF_SCOPE` |
| Too many suggestion requests or bot check required | Address autocomplete: rate limited; verification required (typed text kept) | `RATE_LIMITED`, `VERIFICATION_REQUIRED` |
| No usable Street View imagery near the property | No Street View (reason `no_imagery`) | `skip_to_upload`, reason `no_imagery` (`NO_STREET_VIEW` only when a later metadata recheck finds the panorama gone) |
| Ambiguous match (wrong house, old capture, blocked view) | Confirm place: alternates and nudges; "None of these" → upload. Old captures show `confirm.oldCapture`. | `confirm`; `NEEDS_CONFIRMATION` |
| Multi-unit building | No Street View (reason `multi_unit`); never reaches a render request | `skip_to_upload`, reason `multi_unit` (no error code) |
| Low precision, blocked address or out of scope | No Street View (reason `low_precision`, `out_of_scope`, or `unavailable` for a blocked address) | `skip_to_upload` |
| Street View display only (interim) | Interim photo prompt | `SOURCE_NOT_EDITABLE` (`details.reason: display_only`) |
| No scene section for the detected scene type | Holiday picker lists only supported holidays; scene-type correction | — |
| Nothing decoratable found in the photo | Render error: `wait.nothingToDecorate`, shown when analysis ends and before the "Decorating" stage; "Use another view" (Street View sources) and "Use another photo", no "Try again" | `failed`, `failureKind` `source_rejected`, `failureDetail` `no_usable_anchors` or `facade_not_in_frame` |
| Quality checks reject the render | Render error: rejected | `rejected`; `RENDER_REJECTED` |
| Provider slow or unavailable; job exceeds its maximum duration | Waiting: long wait; render error: provider unavailable | `failed`; `PROVIDER_UNAVAILABLE` |
| The model vendor refuses the input | Render error: `wait.policyDeclined` | `failed`, `moderation_blocked` |
| Address, holiday, style or lighting changed mid-render | Result: new variant pending; the earlier job is superseded | `superseded`, `canceled` |
| Guest allowance reached | Allowance reached sheet | `ALLOWANCE_EXHAUSTED` |
| Spend ceiling reached or generation paused | Budget paused banner | `BUDGET_PAUSED` |
| At capacity | At capacity sheet; queue position on the waiting screen when admitted | `AT_CAPACITY` |
| Upload rejected for format or size | Upload: unsupported format; too large | `UPLOAD_UNSUPPORTED_FORMAT`, `UPLOAD_TOO_LARGE` |
| Upload declined by content screening | Upload: declined, safety class (neutral copy); a guidance-class decline shows its reason's specific line | `UPLOAD_DECLINED` (`reasonClass`) |
| People detected in the upload | Upload: people detected | `PEOPLE_DETECTED` |
| No offers, or outside a commerce window | Result: Shop the look panel state `no_offers`, `off_season` or `hidden` ([commerce.md#shop-the-look](commerce.md#shop-the-look)) | panel state |
| Share link revoked or expired | Share page: revoked or expired | `SHARE_REVOKED`, `NOT_FOUND` |
| Project changed in another tab | Silent refresh, then `error.STALE_PROJECT_VERSION` | `STALE_PROJECT_VERSION` |
| Street View source changed or removed since confirmation | Render error: `wait.sourceUnavailable`, then the confirm screen with the current view for reconfirmation; a render requested on a `stale` source asset opens the same confirm screen with `confirm.viewChanged`; result: `result.stalePhoto` on earlier variants | `failed`, `source_unavailable`; source asset `stale`; `SOURCE_NOT_EDITABLE` (`details.reason: stale`) if a render is requested on it |

## Landing

The landing page is the server-rendered shell for `/`: the hero image is in the initial HTML so the first paint needs no script ([D-36](../decisions.md#d-36)). Art direction per holiday, hero sizes, rights records and the example library live in [holidays-and-content.md#hero-and-example-art](holidays-and-content.md#hero-and-example-art). Which holiday is default on a given date is defined in [holidays-and-content.md#windows-and-selection](holidays-and-content.md#windows-and-selection) ([D-09](../decisions.md#d-09)).

### Composition, top to bottom

1. Header: wordmark (left) and the holiday chip (right). The chip reads the current holiday's display name and opens the holiday picker.
2. Hero: the holiday's photograph, art-directed for the viewport (crop ratios in [Mobile layout](#mobile-layout)). The hero appears only on `/`; project screens give the space to the person's photo.
3. Headline `landing.headline`: "Imagine your place for the holidays." Subhead `landing.subhead`: "Find your address or upload a photo to see a festive new look." Text sits on a translucent panel over the lower part of the hero on wide viewports and below the hero on phones; contrast rules are in [Accessibility](#accessibility).
4. Address field: label `landing.addressLabel` "Enter a US address", with the combobox behavior in [Address entry and confirmation](#address-entry-and-confirmation). Choosing a suggestion is the action; there is no separate submit button. A link `address.manualEntry` "Can't find it? Enter the address manually" sits under the field. On expanded layouts (1024 CSS pixels and wider) the same row also holds the link `landing.uploadInline` "Or upload a photo", which opens `/upload`.
5. Age line `landing.ageLine` (passive): "By continuing you confirm you're 18 or older and agree to the Terms." ([D-17](../decisions.md#d-17)).
6. Secondary action `landing.uploadInstead`: "Upload a photo instead". Visually secondary to the address field, always visible, and a first-class path in product terms: it is the primary route for interiors, apartment entries and balconies ([D-04](../decisions.md#d-04)). "Always visible" means on screen without scrolling: on phones and tablets the button sits below the age line; on expanded layouts the panel can end below the fold of a laptop screen, so the upload route is also the `landing.uploadInline` link beside "Can't find it?", which is on screen on load at 1024 by 768 and larger.
7. Quiet link `landing.seeExample`: "See an example". Opens a sheet with one permissioned before-and-after example per holiday and scene type, the current holiday first, each labeled `common.exampleLabel` "Example" ([D-11](../decisions.md#d-11)). Examples come from the content library, never from a customer's project.
8. Footer: Terms, Privacy, Content policy, AI disclosure, Affiliate disclosure, Accessibility, Report a problem, Don't decorate my home, Contact.

### Before the script runs

The server-rendered shell paints the hero photograph and, below it in the flow, the headline panel with the headline, the subhead and the address field (label, search glyph, placeholder `landing.addressPlaceholder`). The panel uses the app's own landing panel and address-field styles, so before any script runs it is laid out exactly like the app's panel (below the photograph on phones, a translucent panel over its lower part on wide viewports) and nothing of it is clipped: only the photograph has the fixed hero height. When the app starts, it adopts the server's photograph in place (never fetched or painted twice) and replaces the server panel with its own, which continues in place instead of animating in a second time ([../architecture.md#landing-and-share-page-delivery](../architecture.md#landing-and-share-page-delivery)).

### Holiday chip and picker

The picker lists the holidays returned by `GET /v1/experience` in the order the holidays spec defines, with the current one marked. In-window, the chip shows the default holiday; off-season it reads `landing.chooseHoliday` "Choose a holiday" and the picker is expanded by default. A deliberate choice persists for the session and the project, and an address change never resets it (rule in [holidays-and-content.md#windows-and-selection](holidays-and-content.md#windows-and-selection)). Deep links with `?holiday=` preselect the chip.

### Thanksgiving emphasis (Proposed, D-11)

During the Thanksgiving window the hero is the candlelit dining room and the address input stays primary ([D-06](../decisions.md#d-06)). Between the age line and the upload action a one-line invitation `landing.thanksgivingInvite` appears: "Hosting this year? Upload a photo of your dining room or table to see it set for Thanksgiving." The same invitation appears as a dismissible band on Thanksgiving exterior results (`result.thanksgivingInvite`). No other holiday carries an invitation in the US Release. The emphasis is data-driven: the client shows it when the holiday's `journeyEmphasis` in `GET /v1/experience` asks for it ([data-and-api.md#http-api](data-and-api.md#http-api)).

### Off-season

The hero is the neutral seasonal scene, the chip reads "Choose a holiday", the picker lists all supported holidays, and no render auto-starts: an `auto_start` discovery lands on the confirm screen with the holiday choice required. Copy and behavior rules are in [holidays-and-content.md#off-season-behavior](holidays-and-content.md#off-season-behavior).

### Returning visitor and paused service

If the session owns a project with activity in the anonymous retention window, a slim banner `landing.continueBanner` "Continue with your last place" links to it. When the experience snapshot reports a service pause, the budget-paused banner (`error.BUDGET_PAUSED`) sits above the address field; the field still works for lookups, and the pause is explained again at the render request.

## Address entry and confirmation

This section specifies the interface only. Suggestion mechanics, session tokens, resolution, precision, candidate viewpoints, match classes and spend limits are in [address-and-street-view.md](address-and-street-view.md) (sections [Address entry](address-and-street-view.md#address-entry), [Manual entry](address-and-street-view.md#manual-entry), [Match confidence and auto-start](address-and-street-view.md#match-confidence-and-auto-start), [Viewpoint adjustment](address-and-street-view.md#viewpoint-adjustment)).

### Autocomplete

- The field is an ARIA combobox with a listbox popup (pattern and keys in [Accessibility](#accessibility)). Minimum characters, debounce, stale-request cancellation and the no-re-query rule are client behaviors defined in the address spec; the client never sends the typed text anywhere but the suggestions endpoint.
- Suggestions show up to 5 rows, each with the main text (street) and secondary text (city, state), plus the provider attribution the address spec requires for suggestions shown off a map. The list paints above everything that follows the field on the landing panel (age line, invitation, secondary actions), however the person arrived at `/`; the panel's entrance animation leaves no layer behind once it has played.
- States and copy: typing below the minimum shows nothing; loading shows a subtle indicator inside the field (no spinner row); no results shows `address.noResults`; a non-US resolution shows `error.ADDRESS_OUT_OF_SCOPE`; `RATE_LIMITED` on suggestions is retried silently after `Retry-After` and shows `error.RATE_LIMITED` only if it persists; a session that cannot start is shown at once with its own line and "Try again" ([Starting the session](#starting-the-session)); `VERIFICATION_REQUIRED` renders the bot challenge inline under the field and retries the last action once on success.
- Selecting a suggestion calls resolve and navigates to `/p/:projectId`. The discovery runs there; while it runs the screen shows `confirm.finding` "Looking for a street photo of this place…" with no image. A gray or sample image is never shown as the address's photo.

### Manual entry

"Can't find it? Enter the address manually" replaces the combobox with fields: Street address, Apartment or unit (optional), City, State, ZIP. Submitting calls geocode and shows the candidate list (`address.manualCandidates` "Which of these did you mean?"). Choosing one calls resolve with its `candidateId`. A manual candidate always goes to the confirm screen; it never auto-starts.

### Confirm place

Shown when `matchClass` is `confirm`, after manual entry, off-season for any match class, and (as the interim prompt) when the source mode is `display_only`.

Layout, top to bottom:

1. Heading `confirm.heading` "Is this the right place?" and the display address on one line (shown to the owner on screen only; it never enters a URL, event or log).
2. The primary candidate image at the standard rendered size, with the attribution strip directly beneath it inside the same card: Google Maps attribution, the per-image copyright string, and the capture date as `confirm.captureDate` "Street View image from {captureDate}" or `confirm.captureDateUnknown` "Street View image, date unknown". When the capture is older than the address spec's threshold, `confirm.oldCapture` "Looks different now? Upload a current photo." appears under the strip.
3. Viewpoint adjustment (Open, [D-40](../decisions.md#d-40); default described here): a row of up to 3 candidate thumbnails labeled `confirm.viewN` "View {n}", and two nudge buttons `confirm.lookLeft` "Look left" and `confirm.lookRight` "Look right". Each nudge fetches a new Static image within the address spec's heading bounds and counts against the per-address Static display budget ([address-and-street-view.md#viewpoint-adjustment](address-and-street-view.md#viewpoint-adjustment)); when the budget is spent the nudges disable and show `confirm.noMoreViews` "No more views are available for this address." An optional small Google map with the address pin and the camera position may sit beside the image if D-40 adopts it; only a Google map may share a screen with Street View imagery (constraint recorded in the address spec).
4. Off-season only: the holiday picker inline, `confirm.chooseHolidayFirst` "Choose a holiday to decorate for." The primary button is disabled until a holiday is chosen and says why; disabled controls elsewhere in the product always carry a visible reason in the same way.
5. Primary button `confirm.yes` "Yes, decorate this place". Secondary `confirm.none` "None of these. Upload a photo instead."

Confirming calls `PUT /v1/projects/:id/source` with the chosen candidate and then `POST /v1/renders`; the waiting screen follows. In `display_only` mode the heading, image and attribution are identical, a line `interim.explain` replaces step 3 ("We can show this street photo so you can check the place, but we can't decorate street photos yet. Upload a photo of the front and we'll decorate that."), and the primary button becomes the upload action (two buttons on phones, one on desktop, per [Photo upload and capture](#photo-upload-and-capture)). Below the upload action a quiet line `interim.noPhoto` ("Only photos you took or have the right to use can be decorated.") is followed by two secondary links: `interim.changeAddress` ("Try another address", returns to `/`) and `landing.seeExample` ("See an example").

### Auto-start

When `matchClass` is `auto_start` in-window, the client calls `POST /v1/renders` as soon as discovery returns with the bound `sourceAssetId`, and the waiting screen opens with the Street View image visible and the passive link `wait.notYourPlace` "Not your place?" Tapping it cancels the render job and opens the confirm screen with the candidates. Events `source_confirmed` and `render_requested` fire in that order.

### No Street View

One screen, heading `nosv.heading` "We can't use a street photo for this address", a reason-specific line, and the upload actions. Reason lines: `nosv.no_imagery` "Street View doesn't have a usable photo here."; `nosv.multi_unit` "This looks like a building with several homes, so a street photo can't show your place. Upload a photo of your own space: the entry, balcony or a room."; `nosv.low_precision` "We couldn't pin this address to one building."; `nosv.unavailable` "A street photo isn't available for this address. Upload a photo to decorate it." for the client-visible reason `unavailable` (a blocked address; the exclusion is never disclosed and the screen never claims there is no imagery; rule in [privacy-safety-legal.md#abuse-harassment-and-takedown](privacy-safety-legal.md#abuse-harassment-and-takedown)) and for `out_of_scope`; `nosv.error` "Something went wrong looking up the street photo. You can try again or upload a photo." with a "Try again" secondary action.

## Photo upload and capture

Interface only. Accepted formats, size limits, client-side preparation, server validation, content admission, people detection and the device test matrix are in [uploads.md](uploads.md).

### Entry points

"Upload a photo instead" on the landing page (creates an upload-first project with `POST /v1/projects` carrying the current holiday selection and continues at `/p/:projectId`); "None of these" on the confirm screen; the interim photo prompt; the No Street View screen; "Replace photo" on a result. Inside an existing project the upload replaces the source and starts a new render; the previous variants stay in the project's history. When the upload step was opened from a result, the confirm screen or a render error ("Replace photo", "None of these", "Use another photo"), a quiet `common.cancel` "Cancel" returns to that screen unchanged.

### Upload screen

1. Heading `upload.heading` "Upload a photo of your place". Subline `upload.subline` "A room, your front door, a balcony or the whole house. Use a photo you took or have permission to use."
2. Pickers. On phones, two buttons: `upload.takePhoto` "Take a photo" is a file input with the accept list and `capture="environment"`, which hints the rear camera (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture, retrieved 2026-11-08); `upload.chooseLibrary` "Choose from library" is a plain file input. The two inputs exist because forcing capture removes the library path, and existing photos are the main route for interiors. On desktop, one button `upload.choosePhoto` "Choose a photo" and a drop zone with `upload.dropHint` "or drop a photo here". **Verify:** `capture` behavior on current iOS Safari and Android Chrome against the device matrix in [uploads.md#camera-capture](uploads.md#camera-capture) (owner: web engineer).
3. Guidance, collapsed under `upload.tipsToggle` "Tips for a great photo": `upload.tip1` "Step back so the whole wall or front is in the frame.", `upload.tip2` "Hold the phone level, in daylight or bright, even indoor light.", `upload.tip3` "Keep people out of the frame." Guidance content is owned by [uploads.md#scene-type-and-photo-guidance](uploads.md#scene-type-and-photo-guidance); these are its copy keys.
4. Checkbox `upload.attestation` ([D-17](../decisions.md#d-17)): "I'm 18 or older, I have the right to use this photo of this space, and I agree to the Terms." The word "Terms" inside the statement links to the Terms, as in the landing age line; following the link does not toggle the box. The statement version for this wording is `upload-attestation-2026-11b`. The pickers are always enabled; if a file is chosen while the box is unchecked, the file stays on the device, the checkbox receives focus and `upload.attestationRequired` "Please confirm before we upload your photo." appears beside it. Once checked, the attestation holds for the session, so "Replace photo" does not ask again; the record (`attestedAt` and the statement version) is stored per source asset ([data-and-api.md#entities](data-and-api.md#entities)).
5. Retention line `upload.retentionLine` (passive): "Your photo is private. Unsaved projects are deleted after {anonymousRetention}." The value comes from [privacy-safety-legal.md#retention-schedule](privacy-safety-legal.md#retention-schedule) ([D-20](../decisions.md#d-20), Open).
6. Off-season, or when no holiday has been chosen, the holiday picker appears inline with `upload.chooseHoliday` "Which holiday?" before the pickers.
7. When the project's uploaded photo is attached and ready but nothing has been decorated from it yet (for example its first look was refused with `ALLOWANCE_EXHAUSTED`, or the screen was reopened off-season), the screen shows that photo with `result.yourPhoto` "Your photo" and the primary button `upload.continue` "Decorate this photo", which requests its render again; the pickers become secondary and replace the photo. While the allowance snapshot says no looks remain, the photo carries `allowance.bodyNoPreview`, and the screen without an attached photo shows `allowance.uploadNotice` above the pickers, so nobody uploads a photo expecting it to be decorated today. The pickers stay enabled. Replacing a decorated photo ("Replace photo") shows the pickers only until the replacement is attached; from then on the replacement is the photo this item describes, and `common.cancel` returns to the result with the project's newest preview.

### Progress and outcomes

| State | What the person sees | Notes |
| --- | --- | --- |
| Preparing | `upload.preparing` "Preparing your photo…" with an indeterminate indicator | Client-side resize and any HEIC conversion ([D-41](../decisions.md#d-41), Open) happen here and are otherwise invisible. |
| Uploading | Determinate bar with `upload.uploading` "Uploading… {percent}%" | The only percentage in the product: it measures bytes transferred, not a guess. |
| Screening | `upload.screening` "Checking your photo…" | Source asset state `screening`. The checks are never itemized on screen. |
| Held for review | `upload.held` "This photo needs a closer look. It can take up to {holdWindow}. You can wait or try another photo." with `upload.tryAnother` | The asset stays `screening` with `holdForReview`; hold window and outcomes in [uploads.md#content-admission](uploads.md#content-admission). |
| Ready | The photo at the standard rendered size with the scene-type chip; the render request follows automatically once the chip is confirmed or confidence is above the floor | Off-season with no holiday chosen yet, the photo waits under the inline picker with a visible reason and continues on its own as soon as a holiday is chosen (inline or in the header chip). |
| Declined, guidance class | The reason's specific line, `upload.declined.<reason>` for `not_a_living_space`, `subject_is_people`, `document_or_screen` or `multi_unit_facade`, and `upload.tryAnother` "Try another photo" | The response carries `reasonClass` `guidance` and the `reason`; reasons and classes are owned by [uploads.md#content-admission](uploads.md#content-admission). |
| Declined, safety class | `error.UPLOAD_DECLINED`, a link to the content policy (`/content-policy`) and `upload.tryAnother` | Neutral wording with no detail: the reason is never shown and nothing hints at which check declined the photo ([privacy-safety-legal.md#content-policy-and-admission](privacy-safety-legal.md#content-policy-and-admission)). |
| Unsupported format | `error.UPLOAD_UNSUPPORTED_FORMAT` with `{formats}` | Checked on the device first where the browser can tell, and again on the server. |
| Too large | `error.UPLOAD_TOO_LARGE` with `{maxFileSize}` | Same two-stage check. |

### People in the photo (Open, D-18; default Option A)

A sheet shows the photo with soft highlights over the detected regions, `upload.peopleHeading` "This photo seems to include people" and `upload.peopleBody` "For their privacy and the best result, crop them out before we decorate." Primary `upload.cropOut` "Crop them out" opens a crop tool whose frame starts positioned to exclude the regions (the whole photo when no crop could be suggested), with free adjustment and a straighten control: a horizontal slider under the photo labeled `upload.straighten` "Straighten" (`role="slider"`, from 15° counterclockwise to 15° clockwise with level in the middle; arrows move 0.5°, Page Up and Page Down 5°, Home and End go to the limits; the whole 44-pixel track is the pointer target; the value reads `upload.straightenLevel` "Level", `upload.straightenClockwise` "{n}° clockwise" or `upload.straightenCounterclockwise` "{n}° counterclockwise"). While straightening, the photo turns inside the frame and zooms just enough that no empty corner shows, exactly as the server will crop it ([uploads.md#people-in-photos](uploads.md#people-in-photos)), and the frame grows if the zoom would take it below the minimum crop size; the server crops the uploaded original to the chosen frame ([uploads.md#people-in-photos](uploads.md#people-in-photos)), so the cropped image is what is decorated. Secondary `upload.keepAsIs` "Keep as is" continues and sets the private-only flag: the result carries `result.privateOnly` "This preview is private. It can't be shared or downloaded because people are in the photo." Detection shows highlights only: no boxes with labels, no counts, no age or identity text of any kind. Under Option B the sheet does not exist and `upload.tip3` is the only mention of people.

### Scene type

After screening, `scene.chip` "Looks like a {sceneTypeLabel} · Change" sits above the photo. Labels for the scene types: `house_exterior` → "house exterior"; `apartment_entry` → "apartment entry"; `balcony` → "balcony or patio"; `interior` → the room type label ("dining room", "living room", "entryway", "kitchen", "bedroom", "room"). Tapping Change lists the four scene types; choosing `interior` then asks the room type. Below the confidence floor ([uploads.md#scene-type-and-photo-guidance](uploads.md#scene-type-and-photo-guidance)) the chip becomes a required choice headed `scene.chooseHeading` "What's in this photo?" before the render request. For an uploaded photo the same chip sits in the result header under the heading, and Change offers the same choices. Changing the scene type after a result starts a new render on a new source asset with the same photo, so earlier variants stay in the project's history; what the pipeline reuses is defined in [render-pipeline.md#variant-key-and-reuse](render-pipeline.md#variant-key-and-reuse).

## Waiting and progress

State semantics, transitions and the latency budget are in [render-pipeline.md#lifecycle-state-machines](render-pipeline.md#lifecycle-state-machines) and [render-pipeline.md#latency-budget](render-pipeline.md#latency-budget). This section defines what the screen shows.

### What is on screen

- The source image at the standard rendered size: the Street View image with its attribution strip, or the uploaded photo with `result.yourPhoto` "Your photo" in the same position.
- One status line carrying the canonical stage label for the job's current state, with a subtle indeterminate indicator that stops under reduced motion. No percentages, no checklist, no timers, no invented sub-steps.

| Render job state | Stage label (copy key) |
| --- | --- |
| `queued`, `preparing` | `stage.preparing` "Getting your photo ready" |
| `analyzing`, `planning` | `stage.planning` "Planning the decorations" |
| `rendering` | `stage.rendering` "Decorating" |
| `checking` | `stage.checking` "Checking the details" |
| `needs_review` | `stage.review` "A person is checking your preview" |

- When the job was admitted under load, `wait.queuePosition` "You're {n} in line" sits under the status line until the position reaches zero.
- During a repair the state returns to `planning` and the label follows. Nothing else changes: no "retrying" wording, because the repair is part of the same job.
- Whenever a job is in `needs_review` (pilot review mode, or during capped rollout a scene type that has not yet met the review-mode switch criteria; [D-14](../decisions.md#d-14)), the label is followed by `wait.reviewNote` "For now, a person checks previews like this one before they're shown."
- `wait.cancel` "Cancel" calls `POST /v1/renders/:id/cancel` in one tap and returns to the previous result, or to the confirm screen when there is none. A canceled job never publishes an output.
- After `auto_start`, the passive link `wait.notYourPlace` "Not your place?" (see [Auto-start](#auto-start)).
- An examples strip headed `wait.examplesHeading` "While you wait: examples" shows the permissioned before-and-after for the current holiday and scene type first, then the others, each labeled "Example" ([D-11](../decisions.md#d-11)).
- Long wait: after a configured threshold (default: the upper bound of the D-14 decision range) the line `wait.longWait` appears: "This is taking longer than usual. You can keep waiting or come back later; we'll keep your preview here for {anonymousRetention}." A duration promise (`wait.usuallyAbout` "Usually about a minute") is a configuration flag, off by default, enabled only when measured latency supports it ([quality-and-benchmark.md#statistics-and-decision-rules](quality-and-benchmark.md#statistics-and-decision-rules)).

### Leaving and returning

Every project has the route `/p/:projectId`, owned by the session. On load the page calls `GET /v1/projects/:id`, then `GET /v1/renders/:id` for the current job, then subscribes to `GET /v1/renders/:id/events`, with the polling fallback defined in [data-and-api.md#live-updates](data-and-api.md#live-updates). Closing the tab or navigating away does not cancel a render; only Cancel does. Returning within the anonymous retention window shows the result. If the session cookie is gone (private window, cleared data) the project cannot be recovered, which is why the result screen offers Save and a share link is the only other durable reference. A `/p/:id` the session does not own, or one that has expired, shows the not-found screen (`error.NOT_FOUND`).

### Render errors

| Outcome | Screen | Actions |
| --- | --- | --- |
| `failed` with `failureKind` `provider_error`, `timeout`, `unknown_outcome` or `internal_error` | `error.PROVIDER_UNAVAILABLE` | `common.tryAgain` "Try again" (a new render job with the same selection); `common.useAnotherPhoto` "Use another photo" |
| `failed` with `source_unavailable`, Street View origin | `wait.sourceUnavailable` "The street photo of this place is no longer available. We'll look for a new one." | Discovery runs again and the confirm screen follows with the current view; nothing is delivered from imagery the person has not confirmed |
| `failed` with `source_unavailable`, upload origin | `wait.sourceUnavailableUpload` "Your photo is no longer available. Upload it again to continue." | "Use another photo" |
| `failed` with `source_rejected`, `failureDetail` `no_usable_anchors` or `facade_not_in_frame` | `wait.nothingToDecorate` "We couldn't find anything to decorate in this photo, like a door, window, porch, railing, mantel or table. Try a wider or closer view, or another photo." | `common.useAnotherView` "Use another view" (Street View sources; opens the confirm screen with the alternates) and "Use another photo"; "Try again" is not offered |
| `failed` with `source_rejected`, `failureDetail` `house_number_mismatch` | `wait.wrongHouse` "This street photo may not show the right house. Choose another view or upload a photo." | "Use another view" and "Use another photo"; "Try again" is not offered |
| `failed` with `source_rejected`, `failureDetail` `owner_blurred` | `wait.ownerBlurred` "This home's Street View image is blurred at the owner's request. Upload your own photo to see it decorated." | "Use another photo" only; alternates are not offered ([address-and-street-view.md#panorama-changes-blur-and-takedown](address-and-street-view.md#panorama-changes-blur-and-takedown)) |
| `failed` with `moderation_blocked` or `policy_denied` | `wait.policyDeclined` "We can't decorate this photo. Try a different photo." | "Use another photo" only; the same input is never retried |
| `rejected` (`rejectionReason` `qa_critical`, `qa_uncertain` or `reviewer_rejected`) | `error.RENDER_REJECTED` | "Try again"; "Use another photo"; for an `evening` look also "Show it as photographed" ([Changing holiday, style and lighting](#changing-holiday-style-and-lighting)); the previous accepted variant, if any, stays on screen |

Whether a failed or rejected job consumes the allowance is defined in [data-and-api.md#allowance-quotas-and-rate-limits](data-and-api.md#allowance-quotas-and-rate-limits); the copy above states only what the person can do next.

## Result and comparison

### Result card

The card holds the comparison control, the image area, and a strip beneath the image. Before and after are always displayed at the same rendered size (sizes in [render-pipeline.md#compositing-and-resolution](render-pipeline.md#compositing-and-resolution)).

- Comparison toggle above the image: a two-button segmented control, `result.before` "Before" and `result.aiPreview` "AI preview", with `aria-pressed`. Tapping "Before" shows the source image fully; tapping "AI preview" shows the accepted variant fully. The default on arrival is "AI preview".
- The reveal: when a project's first accepted variant arrives, the card opens on the source image and crossfades to the AI preview within about one second, then rests on "AI preview" (an instant swap under reduced motion). The reveal, and the staged entrance of the controls and Shop the look that follows it, plays once: returning to the first look later is an instant switch like any cached look, and nothing on screen fades out or disappears. Later variants use the shorter crossfade in [New variant pending](#new-variant-pending).
- Comparison slider on the image: a vertical divider whose handle is a `role="slider"` element; the value is the percentage of the width, from the left, that shows the before image (0 = all preview, 100 = all before). Arrow keys move 5, Page Up and Page Down move 20, Home sets 0 and End sets 100; `aria-valuetext` reads "{n}% before photo". The handle is at least 44 CSS pixels in each dimension and uses `touch-action: pan-y` so a page can still scroll. The slider is an enhancement; the toggle is always present (requirement in [Accessibility](#accessibility)).
- "AI preview" badge: persistent in a lower corner of the generated pixels, never over the attribution strip or attribution burned into the image ([D-28](../decisions.md#d-28)); which corner follows [AI preview badge placement](#ai-preview-badge-placement).
- Strip beneath the image, inside the card: for Street View origin, the Google Maps attribution, per-image copyright and capture date per [address-and-street-view.md#before-image-and-attribution](address-and-street-view.md#before-image-and-attribution), present in every toggle state and slider position; for uploads, `result.yourPhoto` "Your photo". The holiday label (`result.holidayLabel` "{holiday} · {style} · {lighting}") sits at the strip's right edge.
- `compare_used` fires once per variant when the toggle or slider is first used; `variant_viewed` fires each time a variant is displayed.

### AI preview badge placement

The on-screen "AI preview" badge goes in the lower-right corner of the image unless the image carries burned-in attribution there. Every Street View-origin image carries its photo credit burned into the lower-right corner, whether a live Google frame or a fixture stand-in, so on a Street View-origin image the badge goes in the lower-left corner instead. Upload-origin images and the example library carry no burned-in attribution and keep the lower-right corner. An image is Street View-origin when its payload carries Street View attribution (`Variant.attribution`, `ShareView.attribution`) or, for a variant made from the project's active source, when that source is a Street View or fixture Street View frame.

The rule applies everywhere the badge appears: the result card, the share page (server-rendered and in the app), the share card preview in the Share sheet, Your places thumbnails and the examples. On the result card the badge belongs to the generated layer: it stays pinned to its corner in every comparison state and is clipped together with the generated pixels, so while the slider splits the image the before photo covers it as the divider passes over its corner. It never moves toward the burned-in credit and never labels the before photo. Placement is a class on the badge's corner element (`--lower-right` or `--lower-left`), so component tests assert it per origin without screenshots. The burned-in download mark is placed by the render pipeline ([render-pipeline.md#provenance-and-labeling](render-pipeline.md#provenance-and-labeling)).

### Below the card

1. Controls: holiday chip, style control, lighting toggle (see [Changing holiday, style and lighting](#changing-holiday-style-and-lighting)), and the allowance counter.
2. Actions: `result.save` "Save", `result.share` "Share", `result.download` "Download" (only when permitted; see [Downloads](#downloads)), and `result.delete` "Delete" in an overflow menu. Then `result.changeAddress` "Change address" (Street View origin) or `result.replacePhoto` "Replace photo" (upload origin).
3. Notices, each one line and only when true: `result.privateOnly`; `result.existingDecor` "This photo already had decorations. We kept them and added the {holiday} look." (rule in [holidays-and-content.md#climate-culture-and-existing-decorations](holidays-and-content.md#climate-culture-and-existing-decorations)); `result.stalePhoto` "The street photo of this place has changed since this preview was made. New looks will use the new photo." (source asset `stale`); `result.thanksgivingInvite` (dismissible, Thanksgiving window, exterior results only).
4. Feedback: `feedback.prompt` "Was this preview good?" with thumbs-up and thumbs-down buttons. Thumbs-down opens reason chips `feedback.changedHome` "It changed my home", `feedback.decorWrong` "The decorations look wrong", `feedback.wrongPlace` "Wrong place", `feedback.looksFake` "Looks fake", `feedback.other` "Something else", plus an optional text field (500 characters). Submission calls `POST /v1/feedback` and shows `feedback.thanks` "Thanks, that helps." Next to it, the link `result.report` "Report this image" opens the report form.
5. Shop the look: `GET /v1/renders/:id/products` returns the panel state ([commerce.md#shop-the-look](commerce.md#shop-the-look)). `active`: heading `shop.heading` "Shop the look", then the disclosure line and the cards defined in the commerce spec. `no_offers`: the heading and `commerce.noOffers`, with no links. `off_season`: the heading and `commerce.offSeason`, with no links. `hidden`: nothing is rendered. The state is `hidden` whenever the source's `commerceAdjacent` permission is not allowed, so results that show Google imagery carry no panel unless the licensing grant covers it ([D-15](../decisions.md#d-15)). There is never an empty panel of cards. `shop_panel_viewed` fires when an `active` panel enters the viewport; a product click calls `POST /v1/clicks` and opens the merchant in a new tab.

### New variant pending

When a control starts a new render, the current accepted variant stays visible under a band `result.decoratingLook` "Decorating the {holiday} look…" with the stage label and a Cancel action. On success the new variant replaces it with a short crossfade (an instant swap under reduced motion). On failure the current variant stays and the error sheet opens.

## Changing holiday, style and lighting

Controls sit directly under the result card on phones and in a right-hand rail on wide viewports. Every control stays enabled at all times; what a tap does depends on the state below.

| Control | Values and labels | Default | Shown |
| --- | --- | --- | --- |
| Holiday chip | Supported holidays by display name, in the picker order from [holidays-and-content.md#windows-and-selection](holidays-and-content.md#windows-and-selection) | The window default, or the person's deliberate choice | Always |
| Style | `subtle` "Subtle", `classic` "Classic", `abundant` "Abundant" | `classic` | After the first result; the shown values are the project's `offered.styles` |
| Lighting | `source` "As photographed", `evening` "Evening" | `source` ([D-10](../decisions.md#d-10)) | After the first result, and only when the project's `offered.lightingModes` (from `GET /v1/projects/:id/variants`; computed by the server from the pack's lighting policy ([holidays-and-content.md#lighting-policy](holidays-and-content.md#lighting-policy)), the source-kind configuration and whether the source was judged daylight, [render-pipeline.md#lighting-modes](render-pipeline.md#lighting-modes)) includes `evening`; otherwise the control is absent, not disabled |

The client never offers a combination outside the offered sets; the server refuses one with `VALIDATION_FAILED`. When an `evening` request ends `rejected`, the error sheet offers `common.showAsPhotographed` "Show it as photographed", which switches to the `source` variant (cached if it exists, otherwise a new request).

Behavior on a tap:

1. If the project already has an accepted variant for the chosen combination (`GET /v1/projects/:id/variants`), the card switches to it instantly. No request is sent and nothing is consumed; `variant_viewed` fires.
2. Otherwise the client sends `POST /v1/renders` with an `Idempotency-Key`. A 200 returns an existing accepted variant and the card switches instantly; a 202 opens the pending band. Rapid successive taps are debounced on the client and the server supersedes the earlier job ([render-pipeline.md#variant-key-and-reuse](render-pipeline.md#variant-key-and-reuse)); the screen shows only the latest pending look.
3. If the allowance is exhausted, the allowance sheet opens instead of a request (the client knows from the allowance snapshot; the server remains authoritative and returns `ALLOWANCE_EXHAUSTED` if they disagree).

"Change address" returns to `/` with the address field focused and the holiday preserved; the new address is a new project, and the previous one remains in the session's history for the retention window. "Replace photo" opens the upload screen inside the project.

### Allowance counter

After the first result, `allowance.counter` "{n} more looks today" (`allowance.counterOne` "1 more look today" for the last one) sits beside the controls, fed by the allowance snapshot in `GET /v1/experience` and updated from each render response. At zero it reads `allowance.counterZero` "No more looks today · more at {resetsAt}". The counter never appears before the first result, so the landing page stays quiet. Values and counting rules are owned by [D-12](../decisions.md#d-12), [economics.md#capacity-and-spend-ceilings](economics.md#capacity-and-spend-ceilings) and [data-and-api.md#allowance-quotas-and-rate-limits](data-and-api.md#allowance-quotas-and-rate-limits).

## Allowance and limits

Five codes stop or delay a paid action. Each has its own screen so a person never confuses their own limit with a service condition. Enforcement points, payload fields and `Retry-After` semantics are in [data-and-api.md#allowance-quotas-and-rate-limits](data-and-api.md#allowance-quotas-and-rate-limits).

| Code | Where it can appear | What the person sees | What stays usable |
| --- | --- | --- | --- |
| `ALLOWANCE_EXHAUSTED` | `POST /v1/renders` (looks); `POST /v1/addresses/resolve` (new addresses) | The allowance sheet ([Open, D-13](../decisions.md#d-13); pilot default below) | Everything: the current result, comparison, cached variants, Save, Share, Download, Delete |
| `RATE_LIMITED` | Suggestions, renders, uploads, reports; session start (`POST /v1/sessions`) | Suggestions: silent retry after `Retry-After`, then `error.RATE_LIMITED` inline if it persists. Other actions: `error.RATE_LIMITED` inline with a "Try again" that enables after the wait. Session start: `session.limited` at once wherever the action was attempted, with a "Try again" that enables after the wait ([Starting the session](#starting-the-session)) | Everything else |
| `BUDGET_PAUSED` | Renders, discovery | Banner `error.BUDGET_PAUSED` at the top of `/` and `/p/:id`; a tap on a control repeats it inline. No retry loop and no countdown. | Viewing, comparing, saving, sharing, deleting |
| `AT_CAPACITY` | Renders | Sheet `error.AT_CAPACITY` with `common.tryAgain` enabled after the `Retry-After` countdown. The request is not queued automatically. | Everything else |
| `VERIFICATION_REQUIRED` | Any paid action when the bot check demands it | The challenge widget inline where the action was attempted; on success the action is retried once | Everything else |

### Starting the session

Every call except the public share read and the analytics batch waits for the session (`POST /v1/sessions`, created on the first interaction or the first call that needs it). Analytics never starts it ([Screen and state inventory](#screen-and-state-inventory)), so choosing a holiday on the landing page sends no request and runs no bot check. Starting it never leaves a flow waiting silently:

- The bot-check script and the session request each have a deadline (15 seconds); past it the start counts as failed.
- A failed start fails every call that was waiting on it at once, marked as a session failure, and each flow shows it where the action was attempted: under the address field (suggestions, resolve, manual entry), on `/upload`, on the upload screen, on the project page and in sheets. The line names the session, never the person's input: `session.limited` when the start was refused with `RATE_LIMITED` (its `{retryAfter}` is the remaining `Retry-After`; a 429 without the JSON error envelope, such as a plain-text or HTML answer from a proxy, counts as `RATE_LIMITED` with its `Retry-After`), `session.failed` for anything else (network, timeout, server error). A refused bot check keeps `error.VERIFICATION_REQUIRED`.
- Each place offers `common.tryAgain`, enabled once the `Retry-After` wait has passed (at once for other failures); it repeats the action, which starts the session again. Under the address field it repeats the last lookup with the typed text kept.
- After a `RATE_LIMITED` refusal the client sends no new session request until `Retry-After` has passed (30 seconds when the response names none): calls made during the wait fail at once with `session.limited` and the remaining wait, so no flow hangs and the limit is not hammered. Suggestions do not apply their silent retry to a session refusal.

### Allowance sheet (Open, D-13; pilot default)

Heading `allowance.heading` "That's all the looks for today". Body `allowance.body` "You've used today's free looks. More looks tomorrow at {resetsAt}. Your previews stay here, and you can still compare, save and share them." Over a project with no preview yet (its first look was refused), the body is `allowance.bodyNoPreview` "You've used today's free looks. More looks tomorrow at {resetsAt}. Your place stays here, ready to decorate then." For the new-address flavor the heading is `allowance.addressHeading` "That's all the addresses for today" and the body `allowance.addressBody` "You can look up more addresses tomorrow at {resetsAt}. You can still decorate the places you've already found, or upload a photo." One button, `common.gotIt` "Got it". The candidates for public rollout named in D-13 (an optional account for extra looks, or a clearly labeled paid-looks interest test with no charge) are not built for the pilot; if the owner chooses one at Gate D, it replaces the body text and adds a second action in this sheet and nowhere else.

## Saving, accounts and sharing

### Saving by magic link (Proposed, D-21)

"Save" is also sign-in. The sheet asks for an email: heading `save.heading` "Save this place", body `save.body` "Enter your email and we'll send a sign-in link. Saving keeps this project for {savedRetention} and lets you return on any device.", field `save.emailLabel` "Email", button `save.send` "Send link". `POST /v1/auth/magic-link` leads to `save.sent` "Check your email for a link from Holiday. It works for {linkLifetime}." The link opens `/auth/verify`, which calls `POST /v1/auth/verify`, attaches the session's projects to the account, and returns to the project with `save.done` "Saved. Find it any time under Your places." An expired or used link shows `auth.linkInvalid` "That link has expired. Request a new one." with the email sheet again. When the link is opened in a browser other than the one that asked for it, `POST /v1/auth/verify` answers `confirmationRequired` with a masked `emailHint` and changes nothing; `/auth/verify` then shows a sheet with `auth.confirmHeading` "Sign in as {emailHint}?", `auth.confirmBody` "We'll save your places to this account.", primary `auth.confirmContinue` "Continue" (sends the verify again with `confirm: true`, which signs in this browser only) and secondary `auth.confirmNotMe` "Not me" (leaves to `/` without using the link). Opening the link in the browser that asked for it signs in at once with no extra step. Any other failure (network, a paused or unavailable service) shows the error's message with `common.tryAgain` "Try again", which calls `POST /v1/auth/verify` again without a reload; a failed attempt is never replayed from memory, while an answered step is not repeated, so the link is never spent twice. Only the browser that opens the link is ever signed in ([data-and-api.md#accounts](data-and-api.md#accounts)). Email is the only sign-in method in the US Release; the email provider is Open ([D-48](../decisions.md#d-48)). Retention values come from [privacy-safety-legal.md#retention-schedule](privacy-safety-legal.md#retention-schedule).

### Your places

`/places` lists the account's projects: the latest variant as a thumbnail with the AI preview badge (corner per [AI preview badge placement](#ai-preview-badge-placement)), the holiday, the display address or `places.uploadedPhoto` "Uploaded photo", last activity, and `places.expires` "Kept until {date}" when within 30 days of expiry. Actions: open, delete (confirmation sheet). Empty state `places.empty` "Nothing saved yet. Decorate a place and tap Save." The header shows the holiday chip so a returning visitor can switch holidays before opening a place.

### Account

`/account` shows the email, `account.signOut` "Sign out" (`POST /v1/auth/logout`), and `account.delete` "Delete my account", which opens a confirmation: `account.deleteConfirm` "Delete your account and all your places? This removes every photo, preview and share link. Downloaded copies can't be recalled." The deletion path is defined in [privacy-safety-legal.md#deletion-and-verification](privacy-safety-legal.md#deletion-and-verification).

### Sharing (Proposed, D-22)

"Share" opens a sheet:

1. A preview of the share card (the image generated for link previews; size and generation in [../architecture.md#landing-and-share-page-delivery](../architecture.md#landing-and-share-page-delivery)) with `share.cardNote` "This is what people see when you share the link. It never includes your address."
2. Option `share.includeBefore` "Include the before photo" appears only for upload-origin variants that are not private-only; off by default. Street View-origin shares never include the before image, on the share page or the share card, in the US Release: the unedited Street View source is not exported ([address-and-street-view.md#licensing-request-brief](address-and-street-view.md#licensing-request-brief), row 8). Their share page and card show only the after image, with attribution, where `distributeDerivative` permits.
3. Expiry line `share.expiry` "The link works for {shareLifetime}." (default 30 days, configuration).
4. Buttons: `share.copyLink` "Copy link" and, where the browser offers it, `share.shareVia` "Share…" using the native share sheet.
5. For an existing share: the link, its expiry, and `share.stop` "Stop sharing" with the confirmation `share.stopConfirm` "Stop sharing? People with the link will no longer see it. Copies already saved can't be recalled."

Creating a share calls `POST /v1/shares`; stopping calls `DELETE /v1/shares/:token`. A private-only variant (people kept in the photo) has no Share or Download action, and the sheet never appears for it. Street View-origin variants can be shared only when the grant allows `distributeDerivative` ([address-and-street-view.md#licensing-outcomes-and-activation](address-and-street-view.md#licensing-outcomes-and-activation)); otherwise the Share action is absent and `result.shareUnavailable` "Sharing isn't available for street photos yet." appears in the overflow menu in its place.

### Share page

`GET /s/:token` is server-rendered, `noindex`, and contains, top to bottom: the wordmark; the after image at the standard rendered size with the "AI preview" badge (lower-left on Street View-derived images, lower-right otherwise; [AI preview badge placement](#ai-preview-badge-placement)); the comparison toggle only when the share includes the before image (upload-origin only); the holiday label; the attribution strip when the image derives from Street View (required and permitted per the address spec); `share.caption` "A holiday preview made with Holiday"; the call to action `share.cta` "See your place for the holidays" linking to `/` with the holiday preselected; `share.report` "Report this image"; and the footer. The page shows no address, no map, no name, and no product links or disclosure ([D-26](../decisions.md#d-26)). `share_viewed` fires on load without viewer identity. A revoked or expired token returns the page with `error.SHARE_REVOKED` and the call to action only. The server paints the page with the markup and classes of the app's share page (their styles ship in the page's stylesheet), so it is laid out and styled before any script runs and does not move when the app takes over: the image card's entrance plays once, on the server-painted page, and the app's card replaces it in place without playing it again. The wordmark is centered in the share page header.

### Downloads

"Download" appears only when the `Variant` payload carries `downloadUrl` ([data-and-api.md#http-api](data-and-api.md#http-api)); the client never decides eligibility itself. The server includes the field only when the variant is `downloadable` ([D-22](../decisions.md#d-22)): upload-origin variants that are not private-only, and Street View-origin variants only when the grant allows `distributeDerivative`. The file is produced when the variant is accepted: the delivered after image with a small burned-in "AI preview" corner mark (on by default; configuration, [D-28](../decisions.md#d-28)), IPTC digital-source-type metadata and, for Street View-origin variants where distribution is permitted, the required attribution band ([render-pipeline.md#provenance-and-labeling](render-pipeline.md#provenance-and-labeling)). `downloadUrl` is signed and short-lived, so the client re-reads the project's variants for a fresh link when it has expired. The first download in a session shows `result.downloadNote` "Downloads include the AI preview label." once.

### Delete

`result.delete` opens `delete.confirm` "Delete this place? This removes the photo, every preview and any share links. Downloaded copies can't be recalled." with `delete.yes` "Delete" and `common.cancel` "Cancel". `DELETE /v1/projects/:id` runs, `delete.done` "Deleted." shows, and the person returns to `/`.

## Reporting and feedback

Feedback (thumbs and reasons) is specified in [Below the card](#below-the-card). Reports and the homeowner opt-out are the public entry points to the abuse and takedown process defined in [privacy-safety-legal.md#abuse-harassment-and-takedown](privacy-safety-legal.md#abuse-harassment-and-takedown); child-safety handling follows [privacy-safety-legal.md#child-safety-reporting](privacy-safety-legal.md#child-safety-reporting).

### Report form

"Report this image" is on every result and every share page, and works for anyone, signed in or not. The sheet asks for one reason, optional details and an optional contact email:

| Reason value | Label |
| --- | --- |
| `harmful_or_offensive` | `report.harmful` "Harmful or offensive" |
| `privacy` | `report.privacy` "Privacy concern" |
| `this_is_my_home` | `report.myHome` "This is my home" |
| `child_pictured` | `report.child` "A child is pictured" |
| `copyright` | `report.copyright` "Copyright" |
| `other` | `report.other` "Something else" |

Submitting calls `POST /v1/reports` with the project, render or share reference and shows `report.thanks` "Thanks. We review every report and respond within {reportAckTarget}." The acknowledgement target is set in the privacy spec. Choosing "This is my home" adds a line `report.myHomeNote` "If you'd like to stop anyone from decorating this address, use Don't decorate my home." linking to the opt-out form.

### Homeowner opt-out

`/dont-decorate-my-home`, linked from every footer as `footer.optOut` "Don't decorate my home". Heading `optout.heading` "Don't decorate my home". Body `optout.body` "Tell us the address and we'll stop showing a street photo of it. People can still upload their own photos of places they have the right to use." The form uses the same address combobox, a contact email for verification, and `optout.submit` "Send request". It calls `POST /v1/reports` with reason `this_is_my_home` and the resolved place; the resulting list entry routes future discoveries to `skip_to_upload` with reason `blocked_address`. Confirmation `optout.thanks` "Thanks. We'll confirm by email once the address is on our list." The page also notes that homeowners can ask Google to blur the house at the source (`optout.googleNote` "To blur your home in Google Street View itself, use Google's Report a problem tool.").

## Copy deck

Every user-facing string has a key. Keys are stable identifiers used by the web app and by the error table in [data-and-api.md#error-codes](data-and-api.md#error-codes) (`error.<CODE>`). Strings are US English for the US Release and are kept in a message catalog, never hard-coded. Placeholders in braces are filled at runtime from configuration or API fields. Two customer-facing words are fixed: "preview" is an accepted variant shown with its label, and "look" is one combination of holiday, style and lighting. Disclosure wording for Shop the look is owned by [commerce.md#disclosure](commerce.md#disclosure) and is referenced, not copied, here. A row that lists several keys separated by " / ", or several values separated by " · ", defines one catalog entry per value in the same order.

### Landing and address

| Key | String |
| --- | --- |
| `landing.headline` | Imagine your place for the holidays. |
| `landing.subhead` | Find your address or upload a photo to see a festive new look. |
| `landing.addressLabel` | Enter a US address |
| `landing.addressPlaceholder` | Street address, city, state |
| `landing.ageLine` | By continuing you confirm you're 18 or older and agree to the Terms. |
| `landing.uploadInstead` | Upload a photo instead |
| `landing.uploadInline` | Or upload a photo |
| `landing.seeExample` | See an example |
| `landing.chooseHoliday` | Choose a holiday |
| `landing.thanksgivingInvite` | Hosting this year? Upload a photo of your dining room or table to see it set for Thanksgiving. |
| `landing.continueBanner` | Continue with your last place |
| `holiday.halloween` / `holiday.thanksgiving_us` / `holiday.christmas` / `holiday.new_years_eve` | Halloween / Thanksgiving / Christmas / New Year's Eve |
| `hero.<holidayId>.alt` and `hero.neutral.alt` | One entry per hero, written when the hero is approved in the content library ([holidays-and-content.md#hero-and-example-art](holidays-and-content.md#hero-and-example-art)), in the pattern "{holiday} scene: {subject}"; it describes the editorial scene and never refers to a customer's home. |
| `example.<holidayId>.<sceneType>` | Example: {holiday} {sceneTypeLabel} |
| `address.manualEntry` | Can't find it? Enter the address manually |
| `address.noResults` | No matches. Check the street number and ZIP, enter the address manually, or upload a photo. Address lookup covers US addresses for now. |
| `address.manualCandidates` | Which of these did you mean? |
| `address.fields` | Street address · Apartment or unit (optional) · City · State · ZIP |
| `confirm.finding` | Looking for a street photo of this place… |
| `confirm.heading` | Is this the right place? |
| `confirm.captureDate` | Street View image from {captureDate} |
| `confirm.captureDateUnknown` | Street View image, date unknown |
| `confirm.oldCapture` | Looks different now? Upload a current photo. |
| `confirm.viewN` | View {n} |
| `confirm.lookLeft` / `confirm.lookRight` | Look left / Look right |
| `confirm.noMoreViews` | No more views are available for this address. |
| `confirm.viewChanged` | The street photo of this place has changed. Check the current view before we decorate it. |
| `confirm.chooseHolidayFirst` | Choose a holiday to decorate for. |
| `confirm.yes` | Yes, decorate this place |
| `confirm.none` | None of these. Upload a photo instead. |
| `interim.explain` | We can show this street photo so you can check the place, but we can't decorate street photos yet. Upload a photo of the front and we'll decorate that. |
| `interim.noPhoto` | Only photos you took or have the right to use can be decorated. |
| `interim.changeAddress` | Try another address |
| `nosv.heading` | We can't use a street photo for this address |
| `nosv.no_imagery` | Street View doesn't have a usable photo here. |
| `nosv.multi_unit` | This looks like a building with several homes, so a street photo can't show your place. Upload a photo of your own space: the entry, balcony or a room. |
| `nosv.low_precision` | We couldn't pin this address to one building. |
| `nosv.unavailable` | A street photo isn't available for this address. Upload a photo to decorate it. |
| `nosv.error` | Something went wrong looking up the street photo. You can try again or upload a photo. |
| `session.limited` | We need a short breather: lots of visits came from your connection just now. Try again in about {retryAfter}. |
| `session.failed` | We couldn't get Holiday ready for you. Check your connection and try again. |

### Upload, scene type and waiting

| Key | String |
| --- | --- |
| `upload.heading` | Upload a photo of your place |
| `upload.subline` | A room, your front door, a balcony or the whole house. Use a photo you took or have permission to use. |
| `upload.takePhoto` / `upload.chooseLibrary` / `upload.choosePhoto` | Take a photo / Choose from library / Choose a photo |
| `upload.dropHint` | or drop a photo here |
| `upload.tipsToggle` | Tips for a great photo |
| `upload.tip1` | Step back so the whole wall or front is in the frame. |
| `upload.tip2` | Hold the phone level, in daylight or bright, even indoor light. |
| `upload.tip3` | Keep people out of the frame. |
| `upload.attestation` | I'm 18 or older, I have the right to use this photo of this space, and I agree to the Terms. |
| `upload.attestationRequired` | Please confirm before we upload your photo. |
| `upload.retentionLine` | Your photo is private. Unsaved projects are deleted after {anonymousRetention}. |
| `upload.chooseHoliday` | Which holiday? |
| `upload.preparing` / `upload.uploading` / `upload.screening` | Preparing your photo… / Uploading… {percent}% / Checking your photo… |
| `upload.held` | This photo needs a closer look. It can take up to {holdWindow}. You can wait or try another photo. |
| `upload.tryAnother` | Try another photo |
| `upload.declined.not_a_living_space` | This doesn't look like a home, room, balcony or entryway. Try a photo of the space you want to decorate. |
| `upload.declined.subject_is_people` | This looks like a photo of people rather than a room. Try a photo of the space itself. |
| `upload.declined.document_or_screen` | This looks like a document or a screen. Try a photo you took of the space itself. |
| `upload.declined.multi_unit_facade` | This looks like a whole building with several homes. Upload a photo of your own entry, balcony or room. |
| `upload.peopleHeading` | This photo seems to include people |
| `upload.peopleBody` | For their privacy and the best result, crop them out before we decorate. |
| `upload.cropOut` / `upload.keepAsIs` | Crop them out / Keep as is |
| `scene.chip` | Looks like a {sceneTypeLabel} · Change |
| `scene.chooseHeading` | What's in this photo? |
| `scene.labels` | house exterior · apartment entry · balcony or patio · dining room · living room · entryway · kitchen · bedroom · room |
| `stage.preparing` | Getting your photo ready |
| `stage.planning` | Planning the decorations |
| `stage.rendering` | Decorating |
| `stage.checking` | Checking the details |
| `stage.review` | A person is checking your preview |
| `wait.queuePosition` | You're {n} in line |
| `wait.reviewNote` | For now, a person checks previews like this one before they're shown. |
| `wait.cancel` | Cancel |
| `wait.notYourPlace` | Not your place? |
| `wait.examplesHeading` | While you wait: examples |
| `wait.longWait` | This is taking longer than usual. You can keep waiting or come back later; we'll keep your preview here for {anonymousRetention}. |
| `wait.usuallyAbout` | Usually about a minute |
| `wait.sourceUnavailable` | The street photo of this place is no longer available. We'll look for a new one. |
| `wait.sourceUnavailableUpload` | Your photo is no longer available. Upload it again to continue. |
| `wait.nothingToDecorate` | We couldn't find anything to decorate in this photo, like a door, window, porch, railing, mantel or table. Try a wider or closer view, or another photo. |
| `wait.wrongHouse` | This street photo may not show the right house. Choose another view or upload a photo. |
| `wait.ownerBlurred` | This home's Street View image is blurred at the owner's request. Upload your own photo to see it decorated. |
| `wait.policyDeclined` | We can't decorate this photo. Try a different photo. |
| `common.exampleLabel` | Example |

### Result, controls and allowance

| Key | String |
| --- | --- |
| `result.before` / `result.aiPreview` | Before / AI preview |
| `result.yourPhoto` | Your photo |
| `result.holidayLabel` | {holiday} · {style} · {lighting} |
| `result.save` / `result.share` / `result.download` / `result.delete` | Save / Share / Download / Delete |
| `result.changeAddress` / `result.replacePhoto` | Change address / Replace photo |
| `result.privateOnly` | This preview is private. It can't be shared or downloaded because people are in the photo. |
| `result.existingDecor` | This photo already had decorations. We kept them and added the {holiday} look. |
| `result.stalePhoto` | The street photo of this place has changed since this preview was made. New looks will use the new photo. |
| `result.thanksgivingInvite` | Hosting this year? Upload a photo of your dining room or table to see it set for Thanksgiving. |
| `result.decoratingLook` | Decorating the {holiday} look… |
| `result.shareUnavailable` | Sharing isn't available for street photos yet. |
| `result.downloadNote` | Downloads include the AI preview label. |
| `result.report` | Report this image |
| `controls.style` | Subtle · Classic · Abundant |
| `controls.lighting` | As photographed · Evening |
| `allowance.counter` | {n} more looks today |
| `allowance.counterOne` | 1 more look today |
| `allowance.counterZero` | No more looks today · more at {resetsAt} |
| `allowance.heading` | That's all the looks for today |
| `allowance.body` | You've used today's free looks. More looks tomorrow at {resetsAt}. Your previews stay here, and you can still compare, save and share them. |
| `allowance.bodyNoPreview` | You've used today's free looks. More looks tomorrow at {resetsAt}. Your place stays here, ready to decorate then. |
| `allowance.uploadNotice` | You've used today's free looks, so a new photo can't be decorated until {resetsAt}. |
| `allowance.addressHeading` | That's all the addresses for today |
| `allowance.addressBody` | You can look up more addresses tomorrow at {resetsAt}. You can still decorate the places you've already found, or upload a photo. |
| `feedback.prompt` | Was this preview good? |
| `feedback.changedHome` / `feedback.decorWrong` / `feedback.wrongPlace` / `feedback.looksFake` / `feedback.other` | It changed my home / The decorations look wrong / Wrong place / Looks fake / Something else |
| `feedback.thanks` | Thanks, that helps. |
| `shop.heading` | Shop the look |
| `commerce.noOffers` | Matching decorations aren't available for this look yet. |
| `commerce.offSeason` | Plan ahead: decorations for {holiday} appear here closer to the season. |
| `commerce.relationship.similar` / `commerce.relationship.described` | Similar item / Similar to what's pictured (wording owned by [commerce.md#product-relationships](commerce.md#product-relationships)) |
| `common.tryAgain` / `common.useAnotherPhoto` / `common.useAnotherView` / `common.showAsPhotographed` / `common.gotIt` / `common.cancel` | Try again / Use another photo / Use another view / Show it as photographed / Got it / Cancel |

### Saving, sharing, reporting and footer

| Key | String |
| --- | --- |
| `save.heading` | Save this place |
| `save.body` | Enter your email and we'll send a sign-in link. Saving keeps this project for {savedRetention} and lets you return on any device. |
| `save.emailLabel` / `save.send` | Email / Send link |
| `save.sent` | Check your email for a link from Holiday. It works for {linkLifetime}. |
| `save.done` | Saved. Find it any time under Your places. |
| `auth.linkInvalid` | That link has expired. Request a new one. |
| `auth.confirmHeading` / `auth.confirmBody` / `auth.confirmContinue` / `auth.confirmNotMe` | Sign in as {emailHint}? / We'll save your places to this account. / Continue / Not me |
| `places.title` / `places.uploadedPhoto` / `places.expires` / `places.empty` | Your places / Uploaded photo / Kept until {date} / Nothing saved yet. Decorate a place and tap Save. |
| `account.signOut` / `account.delete` | Sign out / Delete my account |
| `account.deleteConfirm` | Delete your account and all your places? This removes every photo, preview and share link. Downloaded copies can't be recalled. |
| `share.cardNote` | This is what people see when you share the link. It never includes your address. |
| `share.includeBefore` | Include the before photo |
| `share.expiry` | The link works for {shareLifetime}. |
| `share.copyLink` / `share.shareVia` / `share.stop` | Copy link / Share… / Stop sharing |
| `share.stopConfirm` | Stop sharing? People with the link will no longer see it. Copies already saved can't be recalled. |
| `share.caption` | A holiday preview made with Holiday |
| `share.cta` | See your place for the holidays |
| `share.report` | Report this image |
| `delete.confirm` | Delete this place? This removes the photo, every preview and any share links. Downloaded copies can't be recalled. |
| `delete.yes` / `delete.done` | Delete / Deleted. |
| `report.heading` | Report this image |
| `report.harmful` / `report.privacy` / `report.myHome` / `report.child` / `report.copyright` / `report.other` | Harmful or offensive / Privacy concern / This is my home / A child is pictured / Copyright / Something else |
| `report.details` / `report.contact` / `report.submit` | Details (optional) / Your email (optional, so we can follow up) / Send report |
| `report.thanks` | Thanks. We review every report and respond within {reportAckTarget}. |
| `report.myHomeNote` | If you'd like to stop anyone from decorating this address, use Don't decorate my home. |
| `optout.heading` | Don't decorate my home |
| `optout.body` | Tell us the address and we'll stop showing a street photo of it. People can still upload their own photos of places they have the right to use. |
| `optout.submit` / `optout.thanks` | Send request / Thanks. We'll confirm by email once the address is on our list. |
| `optout.googleNote` | To blur your home in Google Street View itself, use Google's Report a problem tool. |
| `footer.links` | Terms · Privacy · Content policy · AI disclosure · Affiliate disclosure · Accessibility · Report a problem · Don't decorate my home · Contact |

### Error codes

One row per code in [data-and-api.md#error-codes](data-and-api.md#error-codes). "Where" names the surface; the client behavior column of that table says when the client shows the string at all.

| Key | Where | String |
| --- | --- | --- |
| `error.VALIDATION_FAILED` | Inline at the field or action | Something doesn't look right. Check your entry and try again. |
| `error.VERIFICATION_REQUIRED` | Inline, with the challenge widget | Quick check: confirm you're a person to continue. |
| `error.RATE_LIMITED` | Inline | You're moving fast. Give it a moment and try again. |
| `error.ALLOWANCE_EXHAUSTED` | Allowance sheet | Uses `allowance.heading` and `allowance.body`, or the address variants, by the allowance named in the response. |
| `error.BUDGET_PAUSED` | Banner | New previews are paused for today. Your previews stay available to view, compare, save and share. |
| `error.AT_CAPACITY` | Sheet | Lots of people are decorating right now. Try again in about {retryAfter}. |
| `error.ADDRESS_OUT_OF_SCOPE` | Inline under the address field | Address lookup covers US addresses for now. You can still upload a photo of any place. |
| `error.ADDRESS_NOT_FOUND` | Inline under the manual-entry fields | We couldn't find that address. Check the street number and ZIP, or upload a photo. |
| `error.NO_STREET_VIEW` | No Street View screen | Uses `nosv.heading` and the reason line. |
| `error.NEEDS_CONFIRMATION` | Confirm screen | Uses `confirm.heading`. |
| `error.NEEDS_PHOTO` | No Street View screen (no editable source) | Upload a photo of the place to decorate it. |
| `error.SOURCE_NOT_EDITABLE` | Interim prompt (`details.reason: display_only`); with `details.reason: stale` the confirm screen shows `confirm.viewChanged` instead | This street photo can be shown but not decorated. Upload your own photo to see it decorated. |
| `error.UPLOAD_UNSUPPORTED_FORMAT` | Upload screen | We couldn't read that file. Use a photo in one of these formats: {formats}. |
| `error.UPLOAD_TOO_LARGE` | Upload screen | That photo is too large. The limit is {maxFileSize}. |
| `error.UPLOAD_DECLINED` | Upload screen, safety-class declines (guidance-class declines use `upload.declined.<reason>`) | We can't use this photo. Try a different photo. |
| `error.PEOPLE_DETECTED` | People sheet | Uses `upload.peopleHeading` and `upload.peopleBody`. |
| `error.STALE_PROJECT_VERSION` | Silent refresh and one retry; then inline | Something changed in this project. Reload to continue. |
| `error.IDEMPOTENCY_CONFLICT` | Inline (should not occur from the web app) | Something went wrong. Try again. |
| `error.PROVIDER_UNAVAILABLE` | Render error | Our decorating service is having trouble. Try again in a few minutes. |
| `error.RENDER_REJECTED` | Render error | We couldn't make a preview we're happy with from this photo. Try another look or another photo. |
| `error.NOT_FOUND` | Not-found screen | We couldn't find that. It may have expired or been removed. |
| `error.FORBIDDEN` | Not-found screen (same page) | You don't have access to this. |
| `error.SHARE_REVOKED` | Share page | This preview is no longer shared. |

## Accessibility

The conformance target is WCAG 2.2 Level AA (NFR-06; https://www.w3.org/TR/WCAG22/, retrieved 2026-11-08) for every public page and the complete address, upload, result, sharing and account flows. The public statement lives in [privacy-safety-legal.md#accessibility-statement](privacy-safety-legal.md#accessibility-statement); the automated checks run in CI as defined in [../architecture.md#continuous-integration-and-testing](../architecture.md#continuous-integration-and-testing).

### Components

| Component | Requirement |
| --- | --- |
| Address field | The combobox pattern with a listbox popup (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/, retrieved 2026-11-08): `role="combobox"` on the input with `aria-expanded`, `aria-controls` and `aria-autocomplete="list"`; `role="listbox"` and `role="option"` for suggestions; DOM focus stays in the input and `aria-activedescendant` tracks the highlighted option. Keys: Down moves into the list, Up and Down move between options, Enter accepts, Escape closes, Home and End return to the start or end of the typed text. A polite live region announces "{n} suggestions" when the list changes and "No matches" for the empty state; it is cleared on every edit, so an unchanged count is spoken again. A failed lookup or an error about the chosen address (for example out of scope) appears under the field as an alert and marks the input `aria-invalid`. Manual entry is always reachable by keyboard; a manual-entry submit that fails validation moves focus to the first invalid field, whose error text is its description. |
| Comparison toggle | Two buttons with `aria-pressed`; always present, so comparison never depends on dragging (WCAG 2.2 SC 2.5.7 Dragging Movements, Level AA: functionality that uses dragging must also be achievable by a single pointer without dragging; https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html, retrieved 2026-11-08). |
| Comparison slider | The slider pattern (https://www.w3.org/WAI/ARIA/apg/patterns/slider/, retrieved 2026-11-08): `role="slider"` on the focusable handle with `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow`, `aria-valuetext` "{n}% before photo", `aria-label` "Compare before and after". Keys as in [Result card](#result-card). Visible focus ring on the handle. |
| Holiday picker, style, lighting | Native `<button>` elements or a radio group; the current value is conveyed by `aria-pressed` or `aria-checked`, never by color alone. |
| Sheets | `role="dialog"` with `aria-modal`, labeled by the heading; focus moves into the sheet on open and returns to the invoking control on close; Escape closes. Focus stays inside: Tab and Shift+Tab wrap, re-enter the sheet from the dialog itself or from a lost focus, and when the focused control is replaced (a sent form, a crop step) focus moves to the sheet's first control. The page behind the sheet is `inert` while any sheet is open. |
| Images | Alt text is generated from the decoration plan and never includes the address: generated image "AI preview of your {sceneTypeLabel} decorated for {holiday}: {placementSummary}", where the summary names up to three of the features the accepted plan decorated, in plan order, from the variant's `placements` ([data-and-api.md#http-api](data-and-api.md#http-api)) with the Shop the look placement phrases and without repeating a phrase ("decorations on your eaves, your front door and your porch rail"; catalog entries `result.generatedAltPlaced` and `result.placementSummary.one` / `.two` / `.three`), and drops the colon and summary when `placements` is empty; before image "Your photo of your {sceneTypeLabel}" or "Street View image of the selected place"; hero and example images carry curated alt text from the content pack ([holidays-and-content.md#hero-and-example-art](holidays-and-content.md#hero-and-example-art)); an example's alt follows the state shown ("Example AI preview: a {sceneTypeLabel} decorated for {holiday}" or "Example photo: the same {sceneTypeLabel} before decorating") and differs from its visible caption and from the toggle's label ("Compare before and after"); the share card and the AI preview badge are described in the generated image's alt text. |
| Attribution strip | Text, not an image of text, except the Google Maps logo, which carries alt text "Google Maps". |

### Focus and announcements

- Every route sets the document title "{page} · Holiday" (`pageTitle.template`; the landing page is "Holiday"). The page name is the screen's heading or a `pageTitle.*` key: Your places, Your account, Sign in, the legal page titles, Don't decorate my home, A holiday preview (share page), and on `/p/:id` the heading of the current screen (confirm, waiting, result, render error, upload, No Street View) or "Your place" while loading. A title never contains an address.
- After a client-side navigation a polite live region announces the new document title, and focus moves to the page's `h1` (made focusable with `tabindex="-1"`), or to the `main` region when the page has no heading yet. A page that has already placed focus inside its main region (the result heading, an autofocused address field) or in an open sheet keeps it. The first page load is left to the browser.
- Stage changes on the waiting screen are announced once each through a polite live region; the status line is the live region. On the upload screen the live region names the stage only ("Uploading your photo…", `upload.uploadingStage`); the byte percentage and its bar are visual only. Countdowns (the at-capacity wait) are not live; the sheet's label carries the wait and "You can try again now." (`capacity.ready`) is announced once when it ends.
- When a result arrives, focus moves to the result heading; when a render fails, focus moves to the error heading; after an upload is declined, focus moves to the message and "Try another photo" is next in the tab order.
- Errors are identified in text next to the control they concern and are also announced.
- No content is conveyed by color alone; the current comparison state is also in the pressed button text.

### Visual and motion

- Text over the hero sits on a translucent panel or below the image so that it meets 4.5:1 contrast (3:1 for large text) at every viewport; the panel never becomes a heavy dark overlay over the whole image.
- The boundary of every text field, select, the address field and the upload drop target uses `--control-border` (#8b7b6b), at least 3:1 against paper, raised paper, sunk paper and every holiday's soft accent (WCAG 2.2 SC 1.4.11). Text buttons and chips keep the quieter line; their text identifies them.
- On-photo controls and the overlay header hold their contrast over the brightest photograph: the glass holiday chip uses `--glass-dark` (at least 4.5:1 for its text over white) and the header scrim holds `--photo-scrim-band` through the wordmark row (at least 3:1 for the large wordmark over white) before fading into the photo.
- Targets are at least 24 by 24 CSS pixels (WCAG 2.2 SC 2.5.8 Target Size (Minimum), Level AA; https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html, retrieved 2026-11-08); primary controls and the slider handle are at least 44 by 44.
- `prefers-reduced-motion: reduce` disables the first-result reveal and the crossfade between variants, the indeterminate indicator's animation and any hero motion; nothing else depends on animation. Under reduced motion nothing is delayed either: animation and transition delays are zero, so staged entrances (the landing panel, the result rail and Shop the look) appear at once.
- Text resizes to 200% without loss of content; layouts reflow at 320 CSS pixels wide without horizontal scrolling.

### Testing

Automated accessibility checks (axe rules in the browser tests) run in fixture mode over every route and state in the inventory, including the comparison control at 0, 50 and 100, the allowance sheet, the people sheet and the share page. Keyboard-only runs of both paths (address with `confirm`, upload with people detected) are part of the browser test suite. A manual screen-reader pass with VoiceOver on iOS and NVDA on Windows is a Gate C evidence artifact ([../backlog.md#gates](../backlog.md#gates)).

## Mobile layout

Most visitors arrive on phones, and the camera path exists only there. The layout is one responsive design with three widths; the same components appear at every width.

| Width class | Viewport | Layout |
| --- | --- | --- |
| Compact | below 600 CSS pixels | Single column, 16-pixel side gutters, safe-area insets respected. Hero uses the 2:3 portrait crop; its height is capped at 55% of the viewport height so the address field is visible without scrolling. Controls stack under the result card in this order: holiday, style, lighting, allowance counter, actions, notices, feedback, Shop the look. |
| Medium | 600 to 1023 | Single column with a wider content measure; hero at 3:2; controls in two rows under the card. |
| Expanded | 1024 and wider | Hero full-bleed at 3:2 with the headline panel rising over its lower part (30% of the viewport height, at most 270 pixels); address field centered at 560 pixels wide. On project screens the image card occupies the left two thirds and the controls, counter, actions and notices form a right-hand rail; Shop the look spans the full width beneath. |

### Hero crops

The layout uses two art-directed crops per hero, owned by the holidays spec: the 2:3 portrait crop for compact widths and the 3:2 landscape crop for medium and expanded widths. Where the compact height cap or a wide viewport trims a crop further, the trim keeps the recorded focal point and safe area, so the subject stays clear of the headline panel. The holidays spec supplies the assets, sizes and rights records ([holidays-and-content.md#hero-and-example-art](holidays-and-content.md#hero-and-example-art)); the server-rendered shell selects the crop through `srcset` and `sizes` ([../architecture.md#landing-and-share-page-delivery](../architecture.md#landing-and-share-page-delivery)). Web performance targets for the landing page are owned by [../../PLAN.md#10-quality-bar-and-release-criteria](../PLAN.md#10-quality-bar-and-release-criteria) and measured in the field through the `web_vitals` event ([data-and-api.md#analytics-events](data-and-api.md#analytics-events)).

### Touch and camera

- The comparison toggle is the primary comparison control on touch devices; the slider handle is 44 pixels and scroll-safe.
- The address suggestions list opens as a full-width sheet anchored under the field; the on-screen keyboard never covers the first suggestion.
- The upload screen shows the two camera and library buttons full width; after a capture the preview appears in place with the scene-type chip, so the person never leaves the project screen.
- Sheets (allowance, people, share, report, delete) slide up from the bottom edge on compact widths and are centered dialogs on wider widths; both are the same component with the same focus behavior.
- Share uses the native share sheet when the browser offers it and falls back to "Copy link".
