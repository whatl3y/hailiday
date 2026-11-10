# Research: address and imagery sources

Dated research on the address, geocoding and street-level imagery providers Holiday depends on: what Google Maps Platform allows, what its APIs return and cost, and why the alternatives do not replace it. This file records evidence only; the rules built on it live in the specs linked below.

**Owns:** Google terms analysis, API facts, pricing, alternatives and the claims register for address and imagery sources.
**Baseline:** planning baseline 2026-11-09; external facts retrieved 2026-11-08 unless a row says otherwise.

## Summary

| Conclusion | Where it is applied |
| --- | --- |
| Google's terms do not mention AI editing or third-party AI processing of Street View imagery. The nearest clauses are the no-scraping, no-caching and no-derived-content rules in §3.2.3(a), (b) and (c). Google Sales is the only documented exception path. | Outcomes and activation: [licensing outcomes](../specs/address-and-street-view.md#licensing-outcomes-and-activation); decisions [D-03](../decisions.md#d-03) and [D-15](../decisions.md#d-15) |
| Only the panorama ID is cacheable, and Google advises against persisting it. Store location and view parameters and refresh. | [Street View source modes](../specs/address-and-street-view.md#street-view-source-modes) |
| The Static API returns at most 640x640 pixels with no scale parameter. Higher-resolution Google products are not usable as a derivative-imagery route. | [Viewpoint selection](../specs/address-and-street-view.md#viewpoint-selection); [Alternatives considered](#alternatives-considered) |
| Street View metadata is free and returns status, copyright, capture date, panorama location and panorama ID. It does not say which building the camera faces. | [Coverage probe](../specs/address-and-street-view.md#coverage-probe) |
| Places Details (New) has no geocode-precision field. Precision comes from Geocoding `location_type` and `partial_match`, with Geocoding v4 SearchDestinations for building geometry. | [Property resolution and precision](../specs/address-and-street-view.md#property-resolution-and-precision); [D-39](../decisions.md#d-39) |
| Place ID and Geocoding address caching rules differ; coordinates from Places are cacheable for at most 30 days. | [Saved projects and address storage](../specs/address-and-street-view.md#saved-projects-and-address-storage); [D-23](../decisions.md#d-23) |
| No alternative provider found offers a lower-risk path. Mapillary's terms limit commercial use to two purposes, Mapbox geocoding requires a Mapbox map, and the other Google products forbid analysis or derivation. | [Alternatives considered](#alternatives-considered) |
| Typical Google cost per address-path visitor is about $0.05 at the listed prices; the worst case is bounded by the per-address Static display budget ([pre-render spend controls](../specs/address-and-street-view.md#pre-render-spend-controls)). | [Pricing](#pricing); worked model, including the worst case, in [economics](../specs/economics.md#cost-worksheet) |

Limits of this research: it is a reading of public documentation and terms, not legal advice and not a negotiated license. Behaviors marked **Verify** below have not been tested against the live API.

## Google Maps Platform terms

Sources: Google Maps Platform Terms of Service (https://cloud.google.com/maps-platform/terms) and Service Specific Terms (https://cloud.google.com/maps-platform/terms/maps-service-terms), both retrieved 2026-11-08. Clause letters are those in the Terms page at retrieval.

### Clause analysis

| Clause | What it says | Relevance to Holiday |
| --- | --- | --- |
| §3.2.3(a) No scraping | No exporting, extracting or scraping Google Maps Content for use outside the Services. Examples include pre-fetching, indexing, storing, resharing, rehosting, and bulk-downloading Street View images. | The most direct clause against persisting fetched Street View photos or passing them to another service. |
| §3.2.3(b) No caching | No caching except as the Service Specific Terms expressly permit. | Governs what may be stored; see [Caching](#caching). No Street View image caching permission exists in the Service Specific Terms. |
| §3.2.3(c) No creating content based on Google Maps Content | General ban on creating content based on Google Maps Content (examples: tracing, 3D models, a tree index from Street View). | The broadest exposure for an AI-decorated Street View image. Whether an edited output is "content based on" the source is a legal inference, not stated text. |
| §3.2.3(c)(vii) | Bars using Google Maps Content to improve ML or AI models (training, testing, validation, fine-tuning). | Addresses model improvement, not inference-only editing on its face. Holiday never trains on any imagery (`train` is always false). |
| §3.2.3(d) No re-creating Google products | Bars re-creating Google products or features. Example (d)(iii): use in a listings or directory service, or to create or augment an advertising product. The product must offer substantial, independent value. | Whether a shopping layer beside Street View counts as an advertising product is an inference. Addressed in the licensing request, not by engineering. |
| §3.2.3(e) No use with non-Google maps | No displaying Street View imagery and non-Google maps on the same screen. | Rules out pairing Street View with a Mapbox or other third-party map. |
| §3.2.2(a) | The application's own terms must state that Google Maps features and content are subject to the Google Maps End User Additional Terms and the Google Privacy Policy. | A legal deliverable; see [privacy, safety and legal](../specs/privacy-safety-legal.md#legal-deliverables). |
| §3.2.2(b) | Attribution must not be modified, obscured or deleted. | Applies to the before image and to any derived output; see [before image and attribution](../specs/address-and-street-view.md#before-image-and-attribution). |
| §3.2.1(c)(vi) | Under General Restrictions, the customer will not access or use the Services in a Customer Application that would be deemed a "Website or online service directed to children" under COPPA (clause verified 2026-11-09). | Contractual basis for the adult-audience stance on the address path ([audience and age](../specs/privacy-safety-legal.md#audience-and-age); [D-17](../decisions.md#d-17)). |
| §4.4(c)(ii) | The customer will not provide end-user personally identifiable information to Google. | The text does not say how this applies to users typing home addresses. Counsel interprets it ([D-23](../decisions.md#d-23)). |

No clause in the Terms or Service Specific Terms expressly addresses editing or modifying Street View imagery, or sending it to third-party AI services. General language that could apply: §3.2.3(a)(i) (rehost outside the Services), §3.2.3(c) (content based on) and §3.2.1(a) (derivative work of the Services or software, not of content).

### Street View policies

Source: https://developers.google.com/maps/documentation/streetview/policies (page last updated 2026-11-06; retrieved 2026-11-08).

- The policies page defers to §3.2.3(a) and (b) for storage and caching; the only stated exemption is the panorama ID.
- It restates §3.2.3(c) ("Don't create content based on Google Maps Content"). It does not use the word "modify" about photos; it uses it about attribution.
- Custom licensing goes through Google Sales; technical support cannot grant exceptions.
- Attribution is the Google Maps logo where possible, or the text "Google Maps" where space is limited, in the same visual container as the content, visually distinguished, never removed, hidden, obscured or modified. Logo height 16-19 dp; text size 12-16 sp. The page adds that visual modifications must still meet all attribution requirements.
- The EEA versions of the Service Specific Terms apply when the billing account address is in the EEA; the non-EEA versions apply otherwise (effective 8 July 2025, per the Service Specific Terms).

### Geo Guidelines

Source: https://about.google/brand-resource-center/products-and-services/geo-guidelines/ (retrieved 2026-11-08). These are general guidance, not the API contract, but they show Google's position and the Terms cross-reference them for trademarks.

- Annotation is allowed, but imagery should not be "significantly altered" from how Street View looks online. The explicit permission to alter imagery covers Earth content with simulation labeling, not Street View.
- Screenshotting or removing Street View from embedded sources is barred "for any purpose".
- Under additional restrictions (applying to academic, nonprofit and commercial projects): no analyzing or extracting information from Street View imagery, no downloading images for use separately from Google services, no stitching images.
- Revenue-generating use must go through Google Maps Platform. Street View may not be used in print or in "advertisements or promotional materials of any kind". Digital ads may use it only through the Maps APIs or Google's embed. This bears on share cards, social exports and marketing assets that reuse a before image.

### Homeowner blur and privacy

Source: https://www.google.com/streetview/privacy/ (retrieved 2026-11-08).

- Anyone can use "Report a problem" to request a blur of their entire house, car or body. Google says it applies the blur "to all copies of the published Street View image".
- Faces and license plates are automatically blurred in Google-contributed imagery (designed to blur, not guaranteed). User-contributed imagery is not covered by that policy.
- Blurs are not removed from existing imagery.
- Google says newly blurred images are excluded from its own generative AI prompting, and that blur requests do not affect AI imagery already created by third parties.
- Whether Static API images show the blurs is not stated explicitly; the Geo Guidelines imply Google edits propagate to API-sourced use (inference). A stored copy would not receive later blurs.

## Street View Static API facts

Sources: https://developers.google.com/maps/documentation/streetview/request-streetview, https://developers.google.com/maps/documentation/streetview/metadata, https://developers.google.com/maps/documentation/streetview/usage-and-billing, https://developers.google.com/maps/documentation/streetview/digital-signature, https://developers.google.com/maps/documentation/streetview/overview (all retrieved 2026-11-08).

| Topic | Fact |
| --- | --- |
| Image size | Maximum 640x640 pixels (usage page). The request page states only the `{width}x{height}` format. No `scale` parameter exists. |
| `fov` | Default 90, maximum 120, no stated minimum (smaller zooms in). |
| `pitch` | Default 0, positive is up, 90 is straight up, -90 straight down; documented relative to the capture vehicle, "often, but not always, flat". |
| `heading` | 0-360. If omitted, the API computes a heading toward the requested location from the nearest photo's capture point. Given an address or place ID, the API may use a different camera location to display the location better. |
| `radius` | Default 50 m, non-negative integer. |
| `source` | `default` (no restriction), `google` (official Google collections), `outdoor` (outdoor collections only; indoor excluded, and PhotoSpheres omitted because indoor or outdoor is unknown). Google's own pages conflict: the overview says there is no way to use only one source of imagery, while the request page lists `source=google`. **Verify:** live test of `source=google` filtering (engineering lead, during the [coverage probe](../specs/address-and-street-view.md#coverage-probe)). |
| `return_error_code=true` | Returns 404 when no image exists and 400 for an invalid request, instead of the gray "no imagery" image. |
| Signing | Recommended (required for former Premium Plan customers). Unsigned requests have lower quotas and can be limited. A maximum URL length is not stated in the pages read. |
| Quota | 30,000 queries per minute. |
| Burned-in logo | Not documented. Attribution must be displayed by the app regardless. **Verify:** live request showing whether a logo is embedded in the returned image (engineering lead). |

### Metadata

- Free, with no quota consumed (pricing list: Street View Metadata SKU, unlimited free).
- Fields: `status` (OK, ZERO_RESULTS, NOT_FOUND, OVER_QUERY_LIMIT, REQUEST_DENIED, INVALID_REQUEST, UNKNOWN_ERROR), `copyright`, `date` (year-month or year; omitted if unavailable), `location` (the panorama location, not the building), `pano_id`. The size, heading, fov and pitch parameters are ignored.
- The documented copyright example is "(c) 2017 Google". Google says imagery can be contributed by external parties or Google and identifies third-party contributions by the contributor's attribution name; the exact format of contributor values is unverified.
- Google's request and metadata pages say panoramas "may change ID over time, so don't persist this ID" and advise saving location coordinates instead.

### Building geometry for heading

Geocoding API v4 SearchDestinations (`POST https://geocode.googleapis.com/v4/geocode/destinations`) returns navigation points, landmarks, entrances and building outlines (`displayPolygon` on a place view with `structureType` BUILDING). The earlier v3 building-outlines feature page calls itself experimental and points to SearchDestinations. Some sub-features (imagery annotation, altitude, AI summaries) are Experimental on `/v4alpha/`. The page does not label the core method with a launch stage. **Verify:** launch stage of SearchDestinations before depending on it (engineering lead). Sources: https://developers.google.com/maps/documentation/geocoding/search-for-destinations, https://developers.google.com/maps/documentation/geocoding/geocoding-v4-migrate (retrieved 2026-11-08). Computing a heading from a panorama toward an outline centroid or entrance is an engineering inference, not a documented feature.

## Places and Geocoding facts

### Place details fields and precision

- Place Details (New) Essentials fields are `addressComponents`, `addressDescriptor`, `adrFormatAddress`, `formattedAddress`, `location`, `plusCode`, `postalAddress`, `shortFormattedAddress`, `types` and `viewport` (https://developers.google.com/maps/documentation/places/web-service/place-details, retrieved 2026-11-08). None is a geocode-granularity field.
- Geocoding results distinguish precise street-address matches from interpolated, geometric-center and approximate locations through `location_type`, and flag `partial_match` (https://developers.google.com/maps/documentation/geocoding/guides-v3/requests-geocoding, retrieved 2026-11-08). Address Validation exposes `verdict.geocodeGranularity` (https://developers.google.com/maps/documentation/address-validation/understand-response, retrieved 2026-11-08).
- A precise address match does not show that a nearby street camera faces that building.

### Autocomplete sessions

Source: https://developers.google.com/maps/documentation/places/web-service/session-pricing (retrieved 2026-11-08).

- A session uses one token across its autocomplete requests and its terminating Place Details request. An ended token must not be reused.
- Terminated by Place Details Essentials: the first 12 autocomplete requests bill at the Autocomplete Requests rate and requests from the 13th on are free; the Details call bills separately.
- Terminated by Place Details Essentials (IDs Only): every request bills per request.
- Abandoned sessions bill per request.
- Terminated by a non-Essentials Place Details call: autocomplete is free, but the terminating call bills at Enterprise + Atmosphere regardless of the fields requested.
- Worst-case Essentials-terminated session is about 12 x $0.00283 + $0.005, about $0.039 (derived from the listed prices).

### Caching

Source: Service Specific Terms, https://cloud.google.com/maps-platform/terms/maps-service-terms (retrieved 2026-11-08).

| API | May be cached | Conditions |
| --- | --- | --- |
| Places | Latitude and longitude, up to 30 days; place ID | Place ID is cacheable. |
| Geocoding | Latitude and longitude, up to 30 days | Temporary caching. |
| Geocoding | Latitude and longitude, formatted address, structured address, indefinitely | Only to support the direct end-user-facing function, not as a replacement for further calls, and logically isolated per end user (no cross-user use). |
| Street View | Panorama ID | General term lists `pano_id` among cacheable IDs; images are not cacheable. Google's request pages advise against persisting the ID. |

### Coverage and place IDs

Google distinguishes products and data quality in its coverage documentation (https://developers.google.com/maps/coverage, retrieved 2026-11-08); country-level geocoding availability does not guarantee every address or street photo. Google's place ID guidance (refresh IDs older than 12 months) is cited by the address spec ([saved projects](../specs/address-and-street-view.md#saved-projects-and-address-storage)); the cost of a refresh call is unverified. **Verify:** place ID refresh cost (engineering lead).

### EEA terms

The EEA service specific terms apply by billing-account address, not by the searched property's country (Service Specific Terms, effective 8 July 2025; https://cloud.google.com/maps-platform/terms/maps-service-terms, retrieved 2026-11-08). They differ from the non-EEA terms, including how Places content may be combined with maps. See [international extension boundaries](../architecture.md#international-extension-boundaries).

### Place Photos

Place Photos supplies photos associated with places with author attribution. The documentation does not promise a photo of every residential address or of a specific apartment's interior (https://developers.google.com/maps/documentation/places/web-service/place-photos, retrieved 2026-11-08). Inference: it is not a sufficient sole residential image source, and finding a photo there does not settle transformation rights.

## Pricing

Source: https://developers.google.com/maps/billing-and-pricing/pricing (last updated 2026-11-03; retrieved 2026-11-08). Since 1 March 2025 each SKU has a free monthly allotment (Essentials 10,000, Pro 5,000, Enterprise 1,000) instead of the earlier $200 credit (https://developers.google.com/maps/billing-and-pricing/overview). The Geocoding usage page still carries a stale sentence about the $200 credit.

| SKU | Price per 1,000 | Free per month | Notes |
| --- | --- | --- | --- |
| Static Street View | $7.00 (to 100,000); $5.60 (100,001-500,000) | 10,000 | $0.007 per image load; two loads (typical) is about $0.014 (derived). The per-address display budget ([pre-render spend controls](../specs/address-and-street-view.md#pre-render-spend-controls)) caps the worst case. |
| Street View Metadata | Free | Unlimited | |
| Autocomplete Requests | $2.83 (to 100,000); $2.27 (next tier) | 10,000 | Session rules in [Autocomplete sessions](#autocomplete-sessions). |
| Autocomplete Session Usage | Free | Unlimited | |
| Place Details Essentials | $5.00 | 10,000 | |
| Place Details Pro | $17.00 | 5,000 | |
| Place Details Enterprise | $20.00 | 1,000 | |
| Place Details Enterprise + Atmosphere | $25.00 | 1,000 | |
| Geocoding (Essentials) | $5.00 | 10,000 | Geocoding v4 methods, including SearchDestinations, bill under this SKU (https://developers.google.com/maps/documentation/geocoding/usage-and-billing). |
| Street View Tiles | $2.00 | 100,000 | Not used; see [Alternatives considered](#alternatives-considered). |
| Aerial View | $16.00 (Pro) | 5,000 | Not used. |
| Photorealistic 3D Tiles | $6.00 (Enterprise) | 1,000 | Not used. |

Per-visitor Google cost on the address path (typical about $0.05; worst case bounded by the per-address Static display budget) is derived from these prices and modeled in [economics](../specs/economics.md#cost-worksheet). Prices change; the claims register carries the re-verify trigger.

## Alternatives considered

None of the alternatives below replaces Street View Static imagery for an address-first, AI-edited exterior. Statements about vendor terms come from the pages cited; items marked unverified were not confirmed.

### Imagery and rights matrix

| Source | Display | Store | AI edit | Share derivative | Position |
| --- | --- | --- | --- | --- | --- |
| User upload or permissioned photo | User grant | Retention policy | User grant plus processor terms | Private by default; sharing needs a grant | Primary validation and fallback source ([uploads](../specs/uploads.md)) |
| Commissioned or directly licensed photos | Contract-specific | Contract-specific | Needs express permission | Needs distribution and attribution terms | Candidate for curated examples and the pilot |
| Google Street View | API display with attribution | Not permitted by standard terms | Not addressed in standard terms | Not addressed in standard terms | Primary address source; outcome depends on the grant ([licensing outcomes](../specs/address-and-street-view.md#licensing-outcomes-and-activation)) |
| Google Place Photos | Within the API experience | Restricted | Not a core source | No assumed rights | Not a residential source |
| Mapillary | Conditional | See terms | Unclear | CC BY-SA obligations | Not usable without written clarification |
| MLS or ATTOM listing photos | Contract-specific | Contract-specific | Unresolved without an explicit grant | Unresolved without an explicit grant | Procurement question only |
| Nearmap aerial imagery | Contract-specific | Contract-specific | Restricted by default | Contract-specific | Not an eye-level source |
| Cyclomedia street-level imagery | Contract-specific | Contract-specific | Contract-specific | Contract-specific | Procurement contact if Google declines |
| Listing, rental or broker pages found on the web | No assumed permission | No assumed permission | No assumed permission | No assumed permission | Never scraped or ingested |

### Mapillary

- Terms of Use are public (https://www.mapillary.com/terms, effective 2024-02-15, retrieved 2026-11-08), provided by Meta Platforms Ireland Limited. Meta is named for DMCA notices, and the API v4 changelog shows updates through 2026-06-26, so the service appears active; no 2026 shutdown news was found.
- Section 3: user content from other users is under CC BY-SA unless indicated otherwise (some sets are CC BY-NC-SA).
- Section 12: commercial use is allowed only for "(i) improvement, training, and development of products ... algorithms, datasets" and "(ii) in the provision of services for or on behalf of one or more of your clients". The terms also bar re-identifying or unblurring any content.
- Whether showing and AI-editing Mapillary images in a consumer app fits purpose (ii) is unclear and would need written clarification from Meta.
- CC BY-SA adaptations require attribution, change notice and share-alike for distributed adaptations (https://creativecommons.org/licenses/by-sa/4.0/). Creative Commons notes that copyright permission does not settle privacy or publicity rights. The Mapillary help article on its CC BY-SA licensing could not be rechecked (blocked by a bot challenge).
- API limits: entity API 60,000 per minute per app, search 10,000 per minute per app, tiles 50,000 per day per app; Image Radius Search default and maximum radius 50 m. Tile attribution is "(c) Mapillary". Residential coverage depends on contributors and has not been measured.

### Mapbox geocoding

- Temporary results cannot be cached; permanent results can be stored indefinitely and need `permanent=true` plus a card on file or an enterprise contract. Temporary is the default (https://docs.mapbox.com/api/search/geocoding/, retrieved 2026-11-08).
- Pricing page (retrieved 2026-11-08): temporary geocoding free to 100,000 requests per month, then $0.75 per 1,000 (100,001-500,000); permanent geocoding has no free tier, $5.00 per 1,000 to 500,000 per month.
- The geocoding page states: "You may only use responses from the Geocoding API in conjunction with a Mapbox map." Google §3.2.3(e) bars showing Street View and a non-Google map on the same screen, so Mapbox geocoding cannot sit beside Street View under both sets of terms. It is excluded.

### Other Google products

| Product | Why it is not a derivative-imagery route | Source (retrieved 2026-11-08) |
| --- | --- | --- |
| Map Tiles API, Street View Tiles | Panoramas up to 13,312 px wide at $2.00 per 1,000, but the Map Tiles policy prohibits image analysis, machine interpretation, object detection and identification, and offline use. A viewer is needed to stitch tiles; thumbnails are at most 600x250. Copyright must be shown with every panorama. | https://developers.google.com/maps/documentation/tile/streetview, https://developers.google.com/maps/documentation/tile/policies |
| Aerial View API | US-only video of an address, not a photo. Video ID and place ID may be cached; videos cannot be downloaded or stored. | https://developers.google.com/maps/documentation/aerial-view/overview, https://developers.google.com/maps/documentation/aerial-view/policies |
| Solar API | Permitted only for energy-system purposes; aerial raster, not street level. | https://cloud.google.com/maps-platform/terms/maps-service-terms, https://developers.google.com/maps/documentation/solar/overview |
| Photorealistic 3D Tiles | Bars non-visualization use and any 3D object derived by hand or machine from the tiles. | https://developers.google.com/maps/documentation/tile/policies |

### Third-party property and imagery vendors

- **ATTOM:** its photo documentation says listing photographs remain copyrighted and may be used only under the MLS and ATTOM terms that make them available, and names Slipstream as the photo-access product rather than ATTOM Cloud (https://cloud-help.attomdata.com/article/518-photos, retrieved 2026-11-08). Property data alone is not proof of photo access, and a listing-photo feed is not proof of rights to AI-edit or redistribute.
- **Nearmap:** APIs for aerial imagery and property information (https://developer.nearmap.com/docs/about-nearmap-apis); its master agreement includes usage restrictions, including on machine-learning products unless the agreement permits the use (https://www.nearmap.com/legal/master-subscription-agreement). Retrieved 2026-11-08. Aerial imagery also lacks the eye-level view.
- **Regrid:** documents parcel, address, building and zoning data (https://regrid.com/api, retrieved 2026-11-08); not a documented source of front-of-house photographs.
- **Cyclomedia:** operates licensed street-level imagery with a developer API. Its developer terms (https://developer.cyclomedia.com/terms/, retrieved 2026-11-09) limit API use to integration into the customer's application (§1.1), license Image Material only for testing and demonstration with other uses needing written approval (§3.1), bar volume tests (§1.4.2) and bar giving Image Material to third parties without approval (§3.3). They do not mention AI or machine learning. Commercial residential-use terms were not found; a custom agreement would be needed.
- **Apple Look Around:** no public API was found in a forum thread (https://developer.apple.com/forums/thread/665745; thread date not shown). Unverified for 2026.

## Claims register

Re-verify triggers: **provider selection** (Gate A), **licensing request** (before the Google Sales request is sent), **activation** (before a capability moves to `live_private` or `live_public`), **pricing refresh** (before each cost worksheet update). Status is "read" when the page was read on the retrieval date and "unverified" when it could not be confirmed.

| ID | Claim | Source URL | Clause or section | Retrieved | Re-verify trigger | Status |
| --- | --- | --- | --- | --- | --- | --- |
| GM-01 | §3.2.3(a) bars scraping; examples include storing and rehosting Street View images | https://cloud.google.com/maps-platform/terms | §3.2.3(a) | 2026-11-08 | licensing request | read |
| GM-02 | No caching except as the Service Specific Terms permit | https://cloud.google.com/maps-platform/terms | §3.2.3(b) | 2026-11-08 | licensing request | read |
| GM-03 | No creating content based on Google Maps Content; (c)(vii) bars ML/AI improvement | https://cloud.google.com/maps-platform/terms | §3.2.3(c), (c)(vii) | 2026-11-08 | licensing request | read |
| GM-04 | (d)(iii) lists advertising products and listings or directory services as re-creation examples | https://cloud.google.com/maps-platform/terms | §3.2.3(d)(iii) | 2026-11-08 | licensing request | read |
| GM-05 | No Street View with non-Google maps on one screen | https://cloud.google.com/maps-platform/terms | §3.2.3(e) | 2026-11-08 | provider selection | read |
| GM-06 | App terms must flow down the End User Additional Terms and Privacy Policy; attribution not modified or obscured | https://cloud.google.com/maps-platform/terms | §3.2.2(a), (b) | 2026-11-08 | activation | read |
| GM-07 | Customer will not give Google end-user PII; application to typed addresses is not clarified | https://cloud.google.com/maps-platform/terms | §4.4(c)(ii) | 2026-11-08 | activation | read; interpretation open |
| GM-08 | No clause expressly addresses AI editing or third-party AI processing | https://cloud.google.com/maps-platform/terms, https://cloud.google.com/maps-platform/terms/maps-service-terms | Terms and Service Specific Terms | 2026-11-08 | licensing request | read |
| GM-09 | Panorama ID is the only cacheable Street View item; Google advises not to persist it | https://cloud.google.com/maps-platform/terms/maps-service-terms, https://developers.google.com/maps/documentation/streetview/request-streetview | Service Specific Terms, general term | 2026-11-08 | activation | read |
| GM-10 | Custom licensing goes through Sales; support cannot grant exceptions; attribution sizes 16-19 dp / 12-16 sp | https://developers.google.com/maps/documentation/streetview/policies | Street View policies (updated 2026-11-06) | 2026-11-08 | licensing request | read |
| GM-11 | Geo Guidelines bar analyzing or extracting Street View information, screenshots for any purpose, and promotional use | https://about.google/brand-resource-center/products-and-services/geo-guidelines/ | Additional restrictions; Web and apps; print and ads | 2026-11-08 | licensing request | read |
| GM-12 | Homeowner blur requests apply to all copies of published imagery; stored copies do not receive later blurs; Static API propagation not stated | https://www.google.com/streetview/privacy/ | Blur policy | 2026-11-08 | activation | read; propagation inferred |
| GM-13 | Static API: 640x640 maximum, no scale parameter, fov default 90 and maximum 120, radius default 50 m, heading default computed toward location | https://developers.google.com/maps/documentation/streetview/usage-and-billing, https://developers.google.com/maps/documentation/streetview/request-streetview | Usage and request pages | 2026-11-08 | pricing refresh | read |
| GM-14 | `source=outdoor` excludes indoor and PhotoSpheres; docs conflict on a Google-only filter | https://developers.google.com/maps/documentation/streetview/request-streetview, https://developers.google.com/maps/documentation/streetview/overview | `source` parameter | 2026-11-08 | activation | unverified (live test) |
| GM-15 | `return_error_code=true` returns 404 or 400 instead of the gray image; signing recommended | https://developers.google.com/maps/documentation/streetview/request-streetview, https://developers.google.com/maps/documentation/streetview/digital-signature | Request and signature pages | 2026-11-08 | activation | read |
| GM-16 | Whether a logo is burned into Static API images is undocumented | https://developers.google.com/maps/documentation/streetview/policies | Attribution | 2026-11-08 | activation | unverified (live test) |
| GM-17 | Metadata is free and returns status, copyright, date, panorama location and pano ID | https://developers.google.com/maps/documentation/streetview/metadata, https://developers.google.com/maps/billing-and-pricing/pricing | Metadata page; pricing list | 2026-11-08 | pricing refresh | read |
| GM-18 | Place Details (New) Essentials fields contain no geocode granularity | https://developers.google.com/maps/documentation/places/web-service/place-details | Essentials field list | 2026-11-08 | provider selection | read |
| GM-19 | Geocoding supplies `location_type` and `partial_match`; Address Validation supplies `verdict.geocodeGranularity` | https://developers.google.com/maps/documentation/geocoding/guides-v3/requests-geocoding, https://developers.google.com/maps/documentation/address-validation/understand-response | Response guides | 2026-11-08 | provider selection | read |
| GM-20 | SearchDestinations returns building outlines and entrances; core-method launch stage not stated | https://developers.google.com/maps/documentation/geocoding/search-for-destinations | Geocoding v4 | 2026-11-08 | activation | read; launch stage unverified |
| GM-21 | Autocomplete session billing rules (12 billed requests, IDs-only, abandoned, non-Essentials termination) | https://developers.google.com/maps/documentation/places/web-service/session-pricing | Session pricing | 2026-11-08 | pricing refresh | read |
| GM-22 | Prices: Static $7.00, Autocomplete $2.83, Details Essentials $5.00, Geocoding $5.00 per 1,000; Metadata free | https://developers.google.com/maps/billing-and-pricing/pricing | Pricing list (updated 2026-11-03) | 2026-11-08 | pricing refresh | read |
| GM-23 | Places cache only coordinates (30 days) and place ID; Geocoding coordinates 30 days, addresses per end user for the end-user function | https://cloud.google.com/maps-platform/terms/maps-service-terms | Service Specific Terms | 2026-11-08 | activation | read |
| GM-24 | EEA terms apply by billing-account address | https://cloud.google.com/maps-platform/terms/maps-service-terms | Service Specific Terms (effective 8 July 2025) | 2026-11-08 | before any EEA expansion | read |
| GM-25 | Street View Tiles forbid image analysis and machine interpretation; Aerial View cannot be stored; Solar is energy-only; 3D Tiles forbid derivation | https://developers.google.com/maps/documentation/tile/policies, https://developers.google.com/maps/documentation/aerial-view/overview, https://cloud.google.com/maps-platform/terms/maps-service-terms | Product policies | 2026-11-08 | licensing request | read |
| GM-26 | Mapillary terms: effective 2024-02-15, Meta-operated, CC BY-SA user content, commercial use limited to two purposes | https://www.mapillary.com/terms | Sections 3 and 12 | 2026-11-08 | provider selection | read; help article unverified |
| GM-27 | Mapbox geocoding responses may be used only with a Mapbox map; temporary versus permanent caching | https://docs.mapbox.com/api/search/geocoding/ | Usage limits | 2026-11-08 | provider selection | read |
| GM-28 | ATTOM listing photos are copyrighted and usable only under MLS and ATTOM terms; Slipstream is the photo product | https://cloud-help.attomdata.com/article/518-photos | Photos documentation | 2026-11-08 | provider selection | read |
| GM-29 | Nearmap master agreement restricts machine-learning products unless permitted | https://www.nearmap.com/legal/master-subscription-agreement | Master agreement | 2026-11-08 | provider selection | read |
| GM-30 | Cyclomedia developer terms limit API use to integration and Image Material to testing and demonstration | https://developer.cyclomedia.com/terms/ | §1.1, §1.4.2, §3.1, §3.3 | 2026-11-09 | provider selection | read; commercial terms not found |
| GM-31 | Apple has no public Look Around API | https://developer.apple.com/forums/thread/665745 | Forum thread | 2026-11-08 | provider selection | unverified (thread date unknown) |
| GM-32 | The Terms bar use of the Services in a Customer Application directed to children under COPPA | https://cloud.google.com/maps-platform/terms | §3.2.1(c)(vi) (General Restrictions) | 2026-11-09 | activation | read |
