# Privacy, safety and legal specification

This specification defines how Holiday handles personal data, what it refuses to render, how it responds to abuse and to legal duties, and which public legal documents must exist before real people use the product. Engineers and AI coding agents implement from it directly; the product owner and counsel use it as the sign-off checklist. Mechanics that belong to another specification (the upload screening pipeline, Street View source modes, provenance metadata, screen copy) are linked, not restated. Every legal conclusion in this file is a working position marked "counsel to confirm"; none is legal advice.

**Owns:** data inventory; data-handling rules; retention schedule and deletion service levels; audience and age policy; content policy; child-safety reporting procedure; abuse, takedown and homeowner opt-out policy; Street View privacy rules; US privacy law register; AI disclosure policy; legal deliverables; accessibility statement.
**Baseline:** planning baseline 2026-11-09; external facts retrieved 2026-11-08.

## Data inventory

One row per data class. "Location" names the store and, where useful, the entity from [data-and-api](data-and-api.md#entities). "Processor" names every third party that receives the data. "Retention" gives the default from the [retention schedule](#retention-schedule); "Deletion" names the mechanism from [deletion and verification](#deletion-and-verification). Anything not in this table is not collected; adding a data class is a change to this file first.

| Data class | Purpose | Location | Processor | Retention (default) | Deletion mechanism |
| --- | --- | --- | --- | --- | --- |
| Address query text (autocomplete) | Suggestions while typing | Not stored; relayed by the server to Google and discarded | Google Places Autocomplete (New) | None; never logged | Never written |
| Place ID | Identify the resolved property; refresh details on return | `properties` (place ID) | Google (origin) | Project lifetime; refreshed after 12 months per [saved projects and address storage](address-and-street-view.md#saved-projects-and-address-storage) | Project deletion or expiry |
| Places coordinates (target point, viewport) | Viewpoint geometry and discovery | `properties` with `coordsExpireAt` | Google (origin) | At most 30 consecutive days | Coordinate-expiry worker; project deletion |
| Display address, saved project | Show the owner which place the project is | `properties`, per owner, obtained by Geocoding the place ID on save ([D-23](../decisions.md#d-23)) | Google Geocoding | Saved-project lifetime | Project or account deletion |
| Display address, anonymous project | Label the place on the confirmation and result screens | Not stored server-side: the Place Details formatted address is returned in the resolve response and kept only in the browser session; the server holds the place ID and time-limited coordinates ([saved projects and address storage](address-and-street-view.md#saved-projects-and-address-storage)) | Google Place Details (New) Essentials | None on the server | Not applicable |
| Manually typed address | Manual entry and forward geocoding | `properties` typed text (user data) | Google Geocoding | Project lifetime | Project deletion |
| Street View descriptors | Refetch, attribution, staleness detection | `source_assets`: pano ID, heading, pitch, fov, size, capture date, copyright, checksum | Google (origin) | Project lifetime; pano ID refreshed on revalidation | Project deletion |
| Street View pixels, `transient` mode | One render job | Worker memory only, for the duration of the job | Image-edit provider; vision model (Google-attributed imagery only) | Duration of the job; never written to storage | Process memory released at job end; only the checksum remains on the attempt |
| Street View pixels, `persist` mode | Reuse across variants; before image | Private object storage, only when `AssetPermission.store` is allowed | Image-edit provider; vision model | Per the grant; metadata revalidated at most every 24 h | Project deletion; purge when the panorama changes or is blurred or removed |
| Street View display, `display_only` mode | Before image for confirmation | Not on Holiday servers; the browser loads a server-signed Static URL from Google | Google | None | Not applicable |
| Upload original (raw bytes) | Validation and creation of the normalized original | Object storage `quarantine/` prefix | None (decoded only by the isolated decoder pool; never sent to a vendor) | Deleted inside the `upload_validate` job at promotion, before content admission; lifecycle backstop 1 hour | Deleted by the `upload_validate` job on promotion; quarantine lifecycle rule |
| Normalized original (re-encoded, oriented, metadata-stripped upload) | Lineage source for every variant; screening; analysis; render; before image | Object storage `originals/{ownerId}/{sourceAssetId}` ([storage and media delivery](../architecture.md#storage-and-media-delivery)) | Hash-matching, moderation and triage vendors ([D-44](../decisions.md#d-44)); image-edit provider; vision model | Project lifetime | Project deletion or expiry; a preservation hold suspends this |
| Working images (provider-sized input, masks, intermediates) | One render job | Object storage `working/{renderJobId}/` (never for `transient` Street View) | Image-edit provider; vision model | Deleted at job `terminalAt` plus a grace period (default 1 hour, configuration) | Working-prefix sweep; lifecycle backstop |
| Accepted variants (outputs) | Result, comparison, share, download | Object storage, output prefix; `render_assets` | None after creation | Project lifetime; a shared derivative is pinned to its share grant | Project deletion; share revocation; expiry sweep |
| Rejected or failed attempt candidates | QA review, repair, judge calibration sampling | Object storage, attempt prefix | None after creation | 7 days after the job is terminal (configuration) | Attempt sweep |
| Scene analyses, decoration plans, judge results | Planning, QA, repair | Postgres rows: boxes, categories, flags; no pixels | Produced by the vision model | Project lifetime | Project deletion |
| Share cards (1200×630) | Social previews of a share | Object storage share-card prefix; public CDN | None | Share-grant lifetime (default 30 days) | Revocation: 410 plus CDN purge; expiry sweep |
| Share grants | Explicit sharing | `share_grants` (opaque token; never an address) | None | 30 days default; revocable | `DELETE /v1/shares/:token`; expiry |
| Email address | Magic-link sign-in; saved projects | `users`; `auth_tokens` (hashed tokens, with the email they were sent to) | Email provider ([D-48](../decisions.md#d-48)) | Account lifetime; `auth_tokens` rows until 1 day after token expiry | `DELETE /v1/me`; retention sweep purges expired `auth_tokens` |
| Session identifiers | Owner scoping for anonymous use | `anonymous_sessions` (hashed) | Cloudflare Turnstile receives only the challenge token at creation | 24 h after last activity | Retention sweep |
| Hashed IP and device signals | Device/IP backstop and rate limits ([D-12](../decisions.md#d-12)); report context | Rate-limit counters; `render_jobs` device and IP hashes (the backstop reads 24 hours); `reports`, `auth_tokens` and `anonymous_sessions` IP (and device) hashes | None | 7 days (configuration) | Rolling expiry: the retention sweep nulls the hash columns 7 days after the row was written |
| Age and rights attestation | Legal record of the checkbox at first upload | `source_assets` attestation fields; session policy version and timestamp | None | Asset lifetime; version and timestamp survive in the tombstone | Tombstone retention |
| Reports and homeowner opt-out requests | Abuse handling; "Don't decorate my home" | `reports` (contact email until the report is actioned; for an actioned opt-out only its SHA-256, and the typed address text is removed); `blocked_addresses` (place ID, `requester_contact_hash`) | None | Reports: 12 months after resolution (unless under a preservation hold); opt-out rows: indefinite | Retention sweep deletes resolved reports; operator deletion through the internal operations API |
| Usage ledger and affiliate clicks | Cost control; attribution reconciliation | `usage_ledger`; `affiliate_clicks` (opaque IDs and sub-IDs) | Merchant networks receive an opaque sub-ID only | Business records, default 7 years (configuration) | Not user-deletable; the owner link is severed and the row keeps only opaque IDs |
| Analytics events | Funnel and quality metrics | `analytics_events` (no personal data; see [analytics events](data-and-api.md#analytics-events)) | None | Per data-and-api | Contains no personal data; nothing to delete per person |
| Logs and traces | Operations | Log host, written through the redacting logger | Log host; Sentry for errors ([D-45](../decisions.md#d-45)) | 30 days, redacted | Host retention policy |
| Error reports | Debugging | Sentry, PII-scrubbed | Sentry | Per Sentry plan | Sentry retention. **Verify:** retention period of the chosen Sentry plan and whether per-event deletion is available; owner: engineering lead |
| Backups | Recovery | Postgres backups; no image bytes | Hosting provider | At most 30 days | Age-out; tombstone replay after any restore |
| Audit log | Operator accountability | `audit_log` (including the hashed IP of the operator request, kept as accountability data for the same 13 months) | None | 13 months | Age-out |
| Deletion receipts and tombstones | Verification; restore safety | `deletion_requests`; `tombstones` (opaque ID and object-key hashes; a source asset's attestation version and timestamp); append-only mirror `tombstones/{date}/{batchId}.jsonl` in the private bucket | None | Backup window plus 30 days (60 days) | Age-out (rows by the retention sweep; mirror batches by the sweep and a 61-day lifecycle rule) |
| Provider-side copies | Vendor abuse monitoring | Vendor systems | Image-edit, vision and safety vendors | Per vendor; see [provider-side retention](#provider-side-retention) | No per-item deletion API documented by any candidate; disclosed, not promised |
| Viewer's own device | Downloads and shares the user chose to make | Outside Holiday | None | Uncontrolled | Cannot be recalled; disclosed at share and download |

Holiday never collects: resident names, ownership records, valuations or contact details for a looked-up address (no property dossier); device geolocation; date of birth or age beyond the attestation; face templates or any biometric identifier; payment details; third-party tracker or advertising identifiers; a stored Place Details address string for an anonymous project; Street View pixels in `display_only` mode or for contributor imagery.

## Data-handling rules

These rules are the single rule set. Each is testable; the test table at the end of this section says how. Where a rule's mechanism belongs to another specification, that specification is linked and this file states only the rule.

1. **Minimization.** Collect only the classes in the [data inventory](#data-inventory). Request only Place Details (New) Essentials fields; never Pro or Enterprise fields ([address entry](address-and-street-view.md#address-entry)). A home address is a search input, not a reason to collect anything about the people who live there.
2. **Addresses never appear** in share links, share pages, analytics events, merchant links, logs, traces, error reports, object keys, queue payloads or prompts. Object keys are opaque ([storage and media delivery](../architecture.md#storage-and-media-delivery)).
3. **Query text is never logged.** The suggestions endpoint relays the typed text to Google and records only counts and latency.
4. **Metadata is stripped.** Every upload is re-encoded and all EXIF, GPS and other embedded metadata removed before storage ([server-side validation](uploads.md#server-side-validation)).
5. **Providers receive the image and the compiled plan, nothing else.** No address, place ID, coordinates, display address, email or session identifier reaches an image-edit, vision or safety vendor. Correlation uses opaque job and attempt IDs.
6. **Permission before every provider call.** `AssetPermission` is evaluated at submission and again immediately before any provider call; `unknown` evaluates as denied for live traffic; `train` is always false ([rights and permissions](../glossary.md#rights-and-permissions)).
7. **Only Google-attributed Street View imagery goes to models**; contributor and unknown imagery is `display_only` ([D-15](../decisions.md#d-15); [Street View privacy](#street-view-privacy)).
8. **Street View pixels are never written to storage** unless the evaluated permission allows `store`; the storage client refuses `street_view` writes otherwise ([storage and media delivery](../architecture.md#storage-and-media-delivery)).
9. **Vendor settings.** For every model vendor: no training on inputs or outputs; zero data retention enabled where the exact model ID supports it; processing in the United States; the vendor's standard moderation setting, never a relaxed one; any abuse-monitoring tail disclosed in the Privacy Policy. These are hard criteria of [D-42](../decisions.md#d-42) and apply equally to the vision model ([D-43](../decisions.md#d-43)).
10. **Private images never pass through a shared cache.** Signed URLs are short-lived and image responses are marked private and non-storable; the public CDN serves only hero, example and share-card assets (lifetimes and headers in [storage and media delivery](../architecture.md#storage-and-media-delivery)).
11. **Private by default.** Projects are owner-scoped; there is no public gallery; accepted variants are never served to another owner as a cache hit.
12. **First-party analytics only.** No third-party trackers, pixels or advertising identifiers in the US Release ([D-45](../decisions.md#d-45)); analytics events carry no personal data ([analytics events](data-and-api.md#analytics-events)).
13. **Error tracking is scrubbed.** Sentry receives events after address, image URL, token and prompt redaction ([observability and operations](../architecture.md#observability-and-operations)).
14. **People detection is detection only.** Bounding boxes; no face templates, no recognition, no age estimation ([D-18](../decisions.md#d-18); [people in photos](uploads.md#people-in-photos)).
15. **Image text is untrusted.** Anything OCR'd or described from a user image is data, never instruction; prompts are compiled from allow-listed vocabulary ([moderation and model-behavior risks](render-pipeline.md#moderation-and-model-behavior-risks)).
16. **Subprocessors are listed** in the table below and in the Privacy Policy; adding one is a Privacy Policy change before the integration goes `live_private`.
17. **Staff access to images is least-privilege and logged.** Reviewers and report triagers see images only through the internal operations tools, with every view written to `audit_log`; there is no ad-hoc bucket browsing in production.
18. **Fixtures carry rights records.** Fixture and benchmark photos come from the permissioned corpus, never from customers ([permissioned corpus](quality-and-benchmark.md#permissioned-corpus)).
19. **Keys, sessions, CSRF, SSRF and webhook verification** follow [security architecture](../architecture.md#security-architecture).
20. **Deletion is verifiable**, per [deletion and verification](#deletion-and-verification).

### Subprocessors

| Processor | Role | Data received | Terms Holiday must hold | Decision |
| --- | --- | --- | --- | --- |
| Google Maps Platform (Places, Geocoding, Street View Static and metadata) | Address lookup; imagery | Query text, place IDs, coordinates, pano requests; the browser's Static URL loads carry the viewer's IP to Google | Maps Platform Terms, including the §4.4(c)(ii) end-user PII clause (counsel to interpret for typed addresses; https://cloud.google.com/maps-platform/terms, retrieved 2026-11-08) | [D-38](../decisions.md#d-38), [D-39](../decisions.md#d-39) |
| Image-edit provider | Rendering | Working image and compiled instructions | No training; zero data retention for the exact model ID or a disclosed tail; age terms compatible with [D-17](../decisions.md#d-17); US processing; commercial output rights | [D-42](../decisions.md#d-42) (Open) |
| Vision model (Claude candidates) | Scene analysis; QA judging | Working image, candidate output, plan | No training; retention terms recorded. **Verify:** Anthropic API data-retention and zero-data-retention terms for the selected model; owner: engineering lead | [D-43](../decisions.md#d-43) (Open) |
| Safety vendors (hash matching; moderation classifier) | Content admission | Upload bytes or hashes, per vendor | Eligibility and terms. **Verify:** which candidate receives bytes versus hashes and its retention; owner: engineering lead with counsel | [D-44](../decisions.md#d-44) (Open) |
| Object storage and CDN (S3, CloudFront) | Storage and delivery | All stored media | Data processing agreement | [D-37](../decisions.md#d-37) |
| Hosting and database (Heroku, Heroku Postgres) | Compute; database | All rows | Data processing agreement | [D-37](../decisions.md#d-37) |
| Email provider (Postmark or Amazon SES) | Magic links; deletion receipts | Email address, message content | Data processing agreement | [D-48](../decisions.md#d-48) (Open) |
| Sentry | Error tracking | Scrubbed error events | Data processing agreement; listed in the Privacy Policy | [D-45](../decisions.md#d-45) |
| Cloudflare Turnstile | Bot defense at session creation | Challenge token; the challenge itself runs in the viewer's browser against Cloudflare | Cloudflare terms (free plan: unlimited challenges, https://developers.cloudflare.com/turnstile/plans/, retrieved 2026-11-08) | [D-38](../decisions.md#d-38) |
| Merchant affiliate networks | Outbound product links | Opaque sub-ID and click; never personal data | Network agreement; disclosure rules in [commerce](commerce.md#disclosure) | [D-25](../decisions.md#d-25) |

### Tests that prove the rules

| Rule | Test or check |
| --- | --- |
| 2, 3, 13 | Redaction test: a synthetic address, image URL, session token and prompt are injected into every log, trace, error and analytics path; none appears in the sink |
| 5 | Provider adapter contract tests assert request payloads contain only image bytes, compiled instructions and opaque IDs |
| 6, 7, 8 | Policy-evaluator unit tests for every `AssetPermission` combination; storage-client test that a `street_view` write without `store` is refused |
| 9 | Vendor configuration recorded in the `country_capabilities` evidence reference and checked at the gate ([gates](../backlog.md#gates)) |
| 10, 11 | Browser test: a signed URL from owner A fails for owner B; private image responses carry non-storable cache headers |
| 14 | Upload screening tests assert no face embedding or age field exists in any schema or payload |
| 17 | Audit-log test: every image view through internal tools writes a row |
| 20 | Deletion test harness in [deletion and verification](#deletion-and-verification) |

## Retention schedule

[D-20](../decisions.md#d-20) is Open; these are its defaults, all configuration. The strictest applicable rule wins: a source license figure, a user deletion or a preservation hold overrides any default. Numbers below are owned here; other files link to this section.

| Data | Default retention | Anchor | Mechanism | Alternative under D-20 |
| --- | --- | --- | --- | --- |
| Anonymous projects (session, properties, source assets, normalized originals, variants) | 24 h after last activity; hard cap 7 days after creation without saving | Last activity = any request that touches the project | Retention sweep worker. No bucket lifecycle rule covers the originals, outputs and downloads of anonymous projects, because those prefixes are shared with saved projects and no object is tagged; a tag-based backstop is planned work ([backlog](../backlog.md#tracked-gaps-and-open-items)) | None proposed |
| Saved projects | Until deleted or 13 months without activity | Last activity = opening, rendering or saving | Retention sweep worker; the `reconciliation` job ([architecture](../architecture.md#jobs-and-queue)) | 30 days, renewable on return, with an expiry notice email |
| Accounts | Until `DELETE /v1/me`, or 13 months without sign-in and with no saved projects | Last sign-in | Retention sweep worker | None proposed |
| Street View-derived data | `transient`: none beyond the job. `persist`: the grant's figure, with metadata revalidation at most every 24 h. `display_only`: nothing stored | Per [Street View source modes](address-and-street-view.md#street-view-source-modes) | Transient fetch discards at job end; persist-mode revalidation purges on change | Set by the licensing outcome |
| Places coordinates | 30 consecutive days from retrieval (Google Service Specific Terms; https://cloud.google.com/maps-platform/terms/maps-service-terms, retrieved 2026-11-08) | Retrieval | Coordinate-expiry worker deletes or re-resolves | None (contractual) |
| Share grants and share cards | 30 days; pins only the shared derivative and its card | Grant creation | Expiry sweep; revocation returns 410 and purges the CDN; lifecycle backstop on the share-card prefix at the maximum configured grant lifetime plus one day | None proposed |
| Raw upload bytes | Deleted inside the `upload_validate` job at promotion of the normalized original, before content admission | Promotion | `upload_validate` job; lifecycle backstop on the `quarantine/` prefix at 1 hour | None proposed |
| Normalized originals | Lifetime of the owning project (anonymous or saved, above) | Project | Retention sweep worker; project deletion | Follows the project's alternative |
| Working images | Job `terminalAt` plus a grace period, default 1 hour | Job `terminalAt` | Working-prefix sweep; lifecycle backstop on the `working/` prefix | None proposed |
| Declined-upload checksum blocklist | 90 days | Decline | Age-out from the tombstone store | None proposed |
| Rejected or failed attempt candidates | 7 days after the job is terminal | Job `terminalAt` | Attempt sweep | None proposed |
| Redacted operational logs and traces | 30 days | Write time | Log host retention | None proposed |
| Backups | At most 30 days; never contain image bytes | Backup time | Provider age-out; tombstone replay after restore | None proposed |
| Hashed IP and device signals | 7 days | Write time | Rolling expiry: the retention sweep nulls `render_jobs`, `reports`, `auth_tokens` and `anonymous_sessions` hash columns older than 7 days; `auth_tokens.ip_hash` is also cleared when the token is consumed | None proposed |
| Magic-link and re-authentication tokens (`auth_tokens`: email, token hash, return path) | 1 day after expiry (longer than the operator re-authentication window) | Token expiry | Retention sweep; `DELETE /v1/me` | None proposed |
| Reports | 12 months after resolution | Resolution | Retention sweep deletes resolved reports not under a preservation hold | None proposed |
| Homeowner opt-out rows | Indefinite (the purpose is to keep honoring the request) | Confirmation | Operator deletion on the requester's instruction | None proposed |
| Audit log | 13 months | Write time | Age-out | None proposed |
| Deletion receipts and tombstones | 60 days (backup window plus 30 days) | Deletion | Age-out | None proposed |
| Allowance residue (owner ID, kind and counted timestamp only; no content, place, project or job reference) | 24 hours: until the counted unit leaves the rolling allowance window | The deleted unit's counted timestamp | Written by every deletion path in the row-deletion transaction; the retention sweep deletes rows past `expires_at` ([`allowance_residue`](data-and-api.md#allowance_residue)) | None proposed |
| Usage ledger and affiliate clicks | 7 years as business records, owner link severed on deletion | Write time | Age-out | None proposed |
| Preservation holds | Until the release condition; mandatory-report holds 1 year after the report (see [child safety reporting](#child-safety-reporting)) | Hold placement | Operator release with recorded reason | Set by counsel |

Mechanisms, stated once:

- **Retention sweep worker** (apps/workers) runs at least hourly, selects expired rows, and executes the [deletion order](#deletion-and-verification) for each, writing a receipt.
- **Bucket lifecycle rules** are a backstop independent of application code, set above the maximum legitimate age for each prefix (values above); they never replace the sweep because they cannot see last activity. `storage-init` applies them on every release (S3 counts expiration in whole days, so the one-hour quarantine promise is kept by code and the rule removes anything left after a day): private `quarantine/` 1 day, `working/` 2 days, `attempts/` and `reviews/` 8 days, `tombstones/` 61 days; public `shared/` and `cards/` 31 days; never a rule on `held/`. An endpoint without lifecycle support is logged and skipped. No rule covers anonymous projects' `originals/`, `outputs/` and `downloads/`: those prefixes are shared with saved projects, no object is tagged, and the retention sweep alone removes them. A tag-based backstop (tag `retention=anonymous` at write for anonymous owners, remove the tag on save and claim, and a repair sweep for missed tags) is planned work and is never shipped without untag-on-save ([backlog](../backlog.md#tracked-gaps-and-open-items)).
- **Coordinate-expiry worker** deletes Places coordinates at `coordsExpireAt`; a saved project re-resolves on the owner's next visit ([saved projects and address storage](address-and-street-view.md#saved-projects-and-address-storage)).
- **Share-grant pinning**: when a project expires while a share grant is live, only the shared variant, its share card and the grant row survive until the grant expires or is revoked; the normalized original, working images and other variants are deleted on schedule.
- **Backups** exclude the image buckets (versioning off; non-current versions, if any, expire within one day; no replication). The database backup window is at most 30 days. Tombstones are also appended to a store outside the database so that a restore replays them before traffic resumes: each deletion writes its tombstones as one JSONL batch under `tombstones/{date}/` in the private bucket when it completes, and the retention sweep mirrors any tombstone not yet mirrored (`tombstones.mirrored_at`).
- **Image bytes are never in queue payloads**; jobs carry opaque IDs and object keys only ([jobs and queue](../architecture.md#jobs-and-queue)).

### Provider-side retention

Disclosed in the Privacy Policy exactly as the selected vendors' terms state; the table lists what is known for the candidates.

| Provider | What is retained | How long | Holiday's control | Source (retrieved 2026-11-08) |
| --- | --- | --- | --- | --- |
| OpenAI image endpoints | Abuse-monitoring logs of inputs and outputs | Up to 30 days by default; zero data retention available for `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2`, `gpt-image-1.5` and `gpt-image-1-mini`, not for the 2.6 models. Images flagged by the CSAM classifier are retained for manual review even under zero data retention | Choose a listed model ID or accept and disclose the tail; **Verify:** zero-data-retention status of the 2.6 models with OpenAI before selecting one; owner: engineering lead | https://developers.openai.com/api/docs/guides/your-data |
| Gemini API, paid tier | Prompts and responses logged for abuse detection | "A limited period of time"; length not stated | None beyond vendor choice; not used to improve products | https://aistudio.google.com/docs/terms |
| Vertex AI (Gemini image models) | Abuse logging possible; no training | Zero data retention requires explicit configuration; some models may still log | Configure as the data-governance page describes | https://docs.cloud.google.com/vertex-ai/generative-ai/docs/data-governance |
| Black Forest Labs API | Inputs and outputs usable for training and public display | Not applicable: excluded for private photos without a written agreement | Excluded | https://bfl.ai/legal/flux-api-service-terms |
| Aggregators (fal, Replicate) | fal media URLs public for at least 7 days by default; Replicate deletes inputs and outputs after an hour | As stated | Not preferred; each adds a subprocessor ([aggregators and open weights](../research/image-ai-providers.md#aggregators-and-open-weights)) | https://fal.ai/docs/documentation/model-apis/faq.md; https://replicate.com/docs/topics/predictions/data-retention |
| Vision model (Claude candidates) | Not recorded in this plan's sources | **Verify:** see the subprocessor table | Record the terms in the capability evidence before `live_private` | https://platform.claude.com/docs (Anthropic model table cached 2026-10-06 covers models and prices, not retention) |
| Google Maps Platform | Google's own service data; Holiday holds only cacheable fields | Not Holiday's data | None | https://cloud.google.com/maps-platform/terms/maps-service-terms |

A selection criterion for [D-42](../decisions.md#d-42): the exact model ID is zero-data-retention eligible, or the product owner has accepted and the Privacy Policy discloses the provider tail. The research file carries the per-model facts ([data, training and age terms](../research/image-ai-providers.md#data-training-and-age-terms)).

### The retention promise

Holiday makes one promise, worded in the Privacy Policy and in the just-in-time notices ([copy deck](experience.md#copy-deck) holds the strings and IDs). It must convey all of the following and nothing stronger:

- Photos and previews in an unsaved project are removed from Holiday's storage 24 hours after you last use the project, and in any case within 7 days.
- A saved project is removed when you delete it, or 13 months after you last open it (or the D-20 alternative, if chosen).
- Deleting a project or account removes your photos and previews from Holiday's primary storage within one hour and from backups within 30 days.
- Our image provider may keep a copy for up to 30 days for abuse monitoring, or is configured for zero data retention; the policy states which, by name.
- Images flagged by a child-safety classifier may be retained for review and reporting as the law requires.
- Copies you download or share, and anything a recipient saves, cannot be recalled.
- Street View imagery is Google's; Holiday keeps only what its license allows and refreshes it from Google.

## Deletion and verification

Deletion is designed to be proven, not asserted. Four paths lead into the same order of operations.

| Path | Trigger | Scope |
| --- | --- | --- |
| User-initiated | `DELETE /v1/projects/:id`; `DELETE /v1/me`; `DELETE /v1/shares/:token` | One project; the whole account with every project, grant and token; one share grant |
| Automatic | Retention sweep, coordinate expiry, attempt sweep, share expiry | Per the [retention schedule](#retention-schedule) |
| Operator-initiated | Report resolution, homeowner opt-out, takedown, repeat-offender action, through the [internal operations API](data-and-api.md#internal-operations-api) | Named objects or every derived output for a place ID |
| Hold release | A preservation hold's release condition is met | Held objects, which then follow the ordinary order |

### Order of operations

1. **Tombstone and refuse.** In one transaction that first locks the project row, write the tombstone (opaque project, asset and object-key hashes; attestation version and timestamp; deletion time; never an address or image) and mark the rows deleted. From this moment every endpoint returns `NOT_FOUND` for the objects; access is revoked synchronously. Locking the row means concurrent first deletions of one project share one request: a caller that finds the project already marked deleted joins the latest `deletion_requests` row instead of writing a new one, both callers get the same `deletionRequestId`, and the receipt kept is the one from the completion that removed the rows. One exception: a completed expiry request on a project whose variants are still pinned to a live share grant gets a new request when the remainder is deleted.
2. **Cancel work.** Non-terminal render jobs move to `canceled` with an abort signal to the worker; a deleted job never publishes an output, even if a late provider response arrives ([lifecycle state machines](render-pipeline.md#lifecycle-state-machines)).
3. **Revoke shares.** Grants are revoked (`SHARE_REVOKED`), `GET /s/:token` returns 410, and the CDN entries for the share card and share page are purged. Every deletion of a grant's public copies calls the storage client's CDN purge for `shared/{token}/after.jpg`, `shared/{token}/before.jpg` and `cards/{token}.jpg`; where no CDN is configured (local development and tests) the purger records the paths instead. Public copies are served with `Cache-Control: public, max-age=300, s-maxage=3600`, so browsers stop showing a revoked copy within 5 minutes.
4. **Delete objects.** Quarantine objects if any remain, normalized originals, working images, variants, rejected candidates and share cards; CDN purge for anything that was public.
5. **Delete or redact rows.** Properties (address text, coordinates, place ID), source-asset descriptors, analyses, plans and judge results are deleted; ledger and click rows keep only opaque IDs with the owner link severed; analytics events already contain nothing to delete.
6. **Provider copies.** Request deletion where a vendor offers an API. No candidate documents one for abuse-monitoring copies; the Privacy Policy says so rather than promising it.
7. **Receipt.** `deletion_requests` records, per store, the object count, timestamps and outcome. Failures retry with alerting and the "deletion failure" runbook ([observability and operations](../architecture.md#observability-and-operations)): steps 2 to 7 are idempotent, every retention sweep resumes requests left `pending`, `in_progress` or `failed` for more than 5 minutes on the same request row (an account request deletes the owner's projects it never reached), repeating `DELETE /v1/projects/:id` completes an unfinished deletion, and a request still open an hour after it was made is logged at error level (`deletion request overdue`), which the alert watches.
8. **Event.** Emit `project_deleted` (no personal data) once per deletion, from the request whose completion removed the rows; a concurrent request that joined the same deletion emits nothing, and a deletion that ends `held` is reported by the request that found it held. This includes a repeated `DELETE /v1/projects/:id` that completes an interrupted deletion; the event ID derives from the deletion request, so concurrent requests record one event ([analytics events](data-and-api.md#analytics-events)).

Account deletion runs steps 1 to 8 for every project, then deletes `users`, `auth_tokens` and the email address, and sends one confirmation email before the address is removed. The owner tombstone is mirrored to the append-only store right after the account transaction commits, as per-project deletions mirror theirs (a storage failure is logged and left to the retention sweep's mirror run). The account request ends `held` when any project deletion returned `held` (the deletion resume settles it once the holds are released), `failed` when a project deletion failed, and `completed` otherwise; its receipt counts only the projects actually deleted.

### Service levels (defaults; configuration)

| Measure | Default |
| --- | --- |
| Access revoked | Synchronously, within the deleting request |
| Primary bytes removed (object storage) | Within 1 hour |
| CDN purge of public share assets | Within 1 hour |
| Backups free of the deleted data | Within the 30-day backup window |
| Receipt written | With the deletion, before the request returns for user-initiated deletion |
| Rights requests received by email (access, deletion, correction) from identified users or non-users | Acknowledged within 2 business days; completed within 30 days (counsel confirms against statutory periods) |

### Preservation holds

A preservation hold suspends steps 4 to 6 for named objects while keeping the user-facing revocation of step 1. A hold records the reason (mandatory report, complaint investigation, vendor flag under review, legal process), an authority reference, the release condition and the operator who placed it; placing and releasing are role-restricted and audited. Retention sweeps, lifecycle rules (held objects are moved to a held prefix with no lifecycle rule) and deletion requests skip held objects. Holds are disclosed in the Privacy Policy. Street View revalidation never deletes a held source's stored copy or clears its object key. Each hold is a `preservation_holds` row in the [data model](data-and-api.md#entities).

How holds are enforced:

- **Coverage.** Every hold resolves to concrete rows: `project` covers the project, its source assets and its variants; `source_asset` covers the asset and the variants made from it; `render_asset` covers the variant; `report` covers the reported variant and its source (or the reported project); `owner` covers every project of the owner. Placing a hold sets `preservation_hold_id` on the covered rows; releasing clears it.
- **Held prefix.** On placement the covered objects (normalized originals, reviewer copies, variants and their derivatives, download files, attempt candidates) are copied to `held/{holdId}/{sha256(originalKey)}` and the copies are recorded on the hold (`held_objects`); release deletes them. Street View-derived pixels are never copied (the storage client writes them only under an evaluated permission); they are recorded as protected in place.
- **Deletion.** A deletion request on anything held still revokes access at once (step 1 marks the project, its sources and variants deleted; render, event, product and variant endpoints answer `NOT_FOUND`), revokes shares and cancels work. The project row is never deleted while anything in it is held, because its cascade would remove the held rows: objects and rows that are not held are deleted or marked deleted (a row step 1 already marked keeps its access-revocation time as its deletion time, so a resumed deletion still reports the project's variant count), held rows keep their objects, and the request is `held`. After release, the next retention sweep completes the deletion on the same request.
- **Sweeps.** The retention sweep, attempt sweep and reconciliation skip covered rows and their objects (reconciliation treats a covered row as live whatever its deletion marks); `held/` has no lifecycle rule and is never bulk-deleted.
- **Automated placement.** A child-safety signal at upload screening (hash match or classifier) places a `mandatory_report` hold on the declined source asset itself, with no operator (`placed_by` empty), copies its original under `held/` and pages operations. Report triage places a `complaint_investigation` hold with the `preservation_hold` action and a `mandatory_report` hold with `escalate_child_safety`.

### Verification

- **Deletion test harness** (integration layer, fixture mode): create a project, render, share and download; delete the project; assert that the signed URL fails, object HEAD returns not-found for every prefix, the share page returns 410, rows are tombstoned, the receipt exists with matching counts, and the reconciliation job reports zero. A second case deletes an account. A third case places a hold, runs the sweep, and asserts the held objects survive and everything else is gone.
- **The `reconciliation` job** ([architecture](../architecture.md#jobs-and-queue)) lists object storage for objects past their expiry or without a live owning row, deletes them, writes a receipt and alerts. The metric "objects past expiry" must read zero; any non-zero value pages the on-call runbook.
- **Audit log** holds every operator deletion, hold placement and release.
- **Restore safety**: after any database restore, the tombstone replay runs from the external store before traffic resumes; the runbook makes this a required step, and the deletion test harness runs against the restored environment. It runs as `pnpm tombstones:replay` (no arguments; it prints one JSON line of counts and exits 0, 2 for an unknown argument or 1 on failure; [scripts contract](../architecture.md#root-scripts-contract)). The replay (`replayTombstoneMirror` in the server package) re-inserts missing tombstone rows, marks projects, source assets and variants whose ID hash is tombstoned deleted again (a re-deleted project gets a `pending` deletion request that the next sweep completes), revokes share grants of tombstoned tokens and removes the account email of tombstoned owners. It is idempotent.
- **Cadence**: the harness runs in CI on every change; a full deletion drill (including a restore) runs before Gate C and after any storage change ([gates](../backlog.md#gates)).

### Rights requests from people who are not users

A homeowner whose house was decorated by someone else, or a person who appears in someone's upload, has no account. The Privacy Policy and the "Don't decorate my home" page give an email route and the opt-out form. Holiday can locate address-based projects by geocoding the requester's address to a place ID and matching `properties` (place ID); it cannot locate an upload by description, so upload complaints need the share link or report path. Verification of identity is proportionate: a confirmed email suffices for an opt-out (over-blocking only sends the address path to the photo prompt), while access requests for stored data require stronger verification set by counsel.

## Audience and age

Proposed ([D-17](../decisions.md#d-17)): Holiday is a service for adults, 18 or older, planning their own decor. It is not directed to children. There is no age wall on the landing page, no age estimation and no collection of a date of birth.

### What the product does

| Element | Rule | Where specified |
| --- | --- | --- |
| Passive age line | Under the address input: "By continuing you confirm you're 18 or older and agree to the Terms" (passive, non-blocking) | Placement and string: [friction budget](experience.md#friction-budget), [copy deck](experience.md#copy-deck) |
| Combined attestation | One checkbox at the first upload: 18 or older, and the right to share this photo of this space (blocking, once per session) | [photo upload and capture](experience.md#photo-upload-and-capture) |
| Attestation record | Boolean, timestamp (`attestedAt`) and the policy version accepted, stored on the session and on each upload source asset; the version and timestamp survive in the tombstone | [data inventory](#data-inventory); [entities](data-and-api.md#entities) |
| Terms clause | The Terms of Service state the 18+ eligibility | [legal deliverables](#legal-deliverables) |
| Not-directed-to-children guardrails | No child-oriented characters, mascots, toys, child models or child-targeted advertising in hero art, example art, holiday packs, style kits or Shop the look | Content rules: [climate, culture and existing decorations](holidays-and-content.md#climate-culture-and-existing-decorations); product rules: [shop the look](commerce.md#shop-the-look) |
| Counsel review | Counsel reviews the FTC "directed to children" factors (subject matter, visual content, animated characters, age of models, advertising, audience evidence) against the built landing page and the Halloween pack before Gate C | [legal deliverables](#legal-deliverables) |
| People in photos | [D-18](../decisions.md#d-18), Open. Default Option A: detection only, one-tap crop suggested, uncropped variants private-only (no share or download). Option B: guidance and attestation only | [people in photos](uploads.md#people-in-photos) |

### COPPA posture (counsel to confirm)

The FTC's COPPA guidance states that the Rule covers operators of general-audience services only where they have actual knowledge they are collecting personal information from a child under 13, that operators are not required to ask visitors' ages, and that a photograph containing a child's image is personal information (https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions, retrieved 2026-11-08; the FAQs are staff views). Holiday's posture:

1. General audience, not directed to children, with the guardrails above.
2. No age estimation anywhere, because an age classifier would manufacture actual knowledge without a way to act on it.
3. **Actual knowledge procedure.** When a report, support contact or account detail shows that a child under 13 used the service or that a child's image was uploaded as the subject of a photo: delete the project's normalized originals, working images, variants and shares through the [deletion order](#deletion-and-verification); block the session; record the handling in `audit_log` without retaining the image; if a provider copy exists, request deletion where an API exists and record that none does otherwise.
4. The "a child is pictured" report reason ([reporting and feedback](experience.md#reporting-and-feedback)) routes to this procedure. It is distinct from the child-safety reporting duty below, which concerns abuse material.
5. The Google Maps Platform Terms separately bar use in a Customer Application directed to children under COPPA (§3.2.1(c)(vi), General Restrictions, https://cloud.google.com/maps-platform/terms; analysis in [clause analysis](../research/address-and-imagery.md#clause-analysis), claim GM-32 in the [claims register](../research/address-and-imagery.md#claims-register)), so the stance is also a contractual requirement of the address path; counsel to confirm the reading.

### Provider implications

| Provider route | Age term | Consequence for [D-42](../decisions.md#d-42) and [D-43](../decisions.md#d-43) |
| --- | --- | --- |
| Gemini API (paid or unpaid tier) | "Age Requirements": users must be 18 or older, and the APIs may not be used in an API client "directed towards or is likely to be accessed by individuals under the age of 18" (https://aistudio.google.com/docs/terms, retrieved 2026-11-08) | Conditional: eligible only with written counsel sign-off that Holiday as designed is not likely to be accessed by under-18s. A landing-page age gate would satisfy it but contradicts [D-06](../decisions.md#d-06) and is not proposed |
| Vertex AI generative models | Google Cloud Service Specific Terms, Generative AI Services, "Age Restrictions", carries the same clause (https://cloud.google.com/terms/service-terms, retrieved 2026-11-08; counsel to confirm the reading) | Same condition; Vertex is not a route around the clause |
| OpenAI image and vision models | "Under 18 API Guidance": additional safeguards when serving minors; do not process personal data of children under 13 without first implementing zero data retention (https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance, retrieved 2026-11-08) | Eligible with the safeguards above. Because uploads may contain children's images, the selected model ID should be zero-data-retention eligible (see [provider-side retention](#provider-side-retention)) or OpenAI's written confirmation obtained |
| Anthropic (Claude vision candidates) | Not recorded in this plan's sources. **Verify:** Anthropic's commercial terms on minimum user age and on applications accessible to minors; owner: engineering lead with counsel | Record the outcome in the capability evidence before `live_private` |
| Black Forest Labs | Not assessed; excluded for private photos on training terms | Not a candidate |

## Content policy and admission

Proposed ([D-19](../decisions.md#d-19)). Holiday decorates real photographs of dwellings and their spaces for a holiday. Nothing else.

### What Holiday decorates

The four scene types and only those: `house_exterior`, `apartment_entry`, `balcony` and `interior` ([holiday model](holidays-and-content.md#holiday-model)). The source is the user's own photograph or a Google-attributed Street View image under a permitted source mode. Users choose a holiday, a style and a lighting mode; there are no free-text prompts in the US Release, which is the primary control on what can be asked for. Decor content comes only from reviewed holiday packs, whose forbidden lists govern what may be added (people, pets, text or signage, house numbers, religious symbols unless selected, gore beyond pack limits, snow unless visible in the source; [pack schema](holidays-and-content.md#pack-schema)). Halloween stays decorative; the Halloween packs' limits define how far "spooky" goes.

### What Holiday declines

| Declined input | Reason | Detected by | Outcome |
| --- | --- | --- | --- |
| A person or group as the subject of the photo | Not a space; privacy | People detection plus scene check | `UPLOAD_DECLINED` |
| Incidental people in an otherwise valid photo | Privacy; never send identifiable people to a model when avoidable | People detection | `PEOPLE_DETECTED` with the one-tap crop; uncropped renders are private-only ([D-18](../decisions.md#d-18) default) |
| Nudity or sexual content | Policy | Moderation classifier | `UPLOAD_DECLINED` |
| Graphic violence or injury | Policy | Moderation classifier | `UPLOAD_DECLINED` |
| Documents, screens, identity cards or mail as the subject | Sensitive data | Classifier and scene check | `UPLOAD_DECLINED` |
| Anything that is not a living space (vehicles, landscapes, storefronts, offices, products) | Out of scope | Dwelling or room check | `UPLOAD_DECLINED`; the user cannot override. Scene-type correction only moves between the four scene types |
| Hash match or child-safety classifier flag | Law | Hash matching ([D-44](../decisions.md#d-44)) | Declined to the user with neutral copy; held and handled under [child safety reporting](#child-safety-reporting) |
| A multi-unit facade presented as "your home" | Honesty | Discovery | `skip_to_upload` with reason `multi_unit` ([match confidence and auto-start](address-and-street-view.md#match-confidence-and-auto-start)) |
| Contributor or unknown-copyright Street View imagery | [D-15](../decisions.md#d-15) | Metadata copyright gate | `display_only` |
| A copied listing photo or someone else's home | Rights | Cannot be detected reliably | Attestation at upload; report and takedown path |

Declines never reveal which filter fired; the copy is neutral and offers another photo ([copy deck](experience.md#copy-deck)). The checksum of a declined upload is kept in the tombstone store for the period in the [retention schedule](#retention-schedule) so the same bytes are declined again without a new screening call.

### Pipeline, refusals and outputs

- The admission pipeline, its order (hash matching, moderation classifier, dwelling or room check, people detection), its cost and its outcomes live in [content admission](uploads.md#content-admission). It runs before any paid model call.
- **Vendor refusals are terminal for that input.** A provider's safety refusal (for example OpenAI `moderation_blocked`, or a Gemini HTTP 400 `safety` or `prohibited_content` response) ends the render job as `failed` with `failureKind` `moderation_blocked`. It is never retried with the same input, never triggers a repair, does not consume allowance, is recorded on the source asset and is counted in operations metrics. Three refusals on one owner's inputs within 24 h (configuration) apply a cooldown ([abuse, harassment and takedown](#abuse-harassment-and-takedown)).
- **Outputs are checked too.** The QA judge's critical codes `unsafe_or_offensive`, `text_added` and `people_altered` reject any output that adds disallowed content ([quality checks](render-pipeline.md#quality-checks)).
- **Pilot review.** In the private pilot, every preview passes a human reviewer before delivery ([D-14](../decisions.md#d-14)), so reviewers will see every admitted upload. The escalation rule and reviewer wellbeing provisions in [child safety reporting](#child-safety-reporting) apply from the first pilot session.
- **Sharing.** Share pages carry the report link, so anything that becomes visible to a recipient can be reported owner-independently.

## Child safety reporting

This section is the procedure for apparent child sexual abuse material (CSAM). It is distinct from the COPPA procedure in [audience and age](#audience-and-age) and from the "a child is pictured" privacy report. Counsel signs off on this section before Gate C; the drill below is a Gate C artifact ([gates](../backlog.md#gates)).

### Legal basis (counsel to confirm)

18 U.S.C. §2258A (https://www.law.cornell.edu/uscode/text/18/2258A, retrieved 2026-11-08):

- §2258A(a): a provider "shall, as soon as reasonably possible after obtaining actual knowledge" of an apparent violation make a report to NCMEC's CyberTipline.
- §2258A(f): nothing in the section requires a provider to monitor users or to "affirmatively search, screen, or scan". Holiday's pre-admission hash matching is therefore product policy and cost control, not the statutory duty; the duty is procedural.
- §2258A(h): a report is treated as a request to preserve the reported contents. The period on the retrieved text is one year (changed from 90 days by Pub. L. 118-59). **Verify:** the preservation period currently in force; owner: counsel.
- §2258A(e): knowing and willful failure to report carries fines, tiered by monthly active users.
- §2258E defines "provider" as an electronic communication service or remote computing service (https://www.law.cornell.edu/uscode/text/18/2258E). Whether Holiday is a provider is counsel's determination; the plan assumes it is.

Vendor behavior that interacts with the duty: OpenAI scans image inputs for CSAM on submission and retains flagged images for manual review even under zero data retention (https://developers.openai.com/api/docs/guides/your-data, retrieved 2026-11-08); Gemini blocks child-safety content non-adjustably and returns HTTP 400 with `safety` or `prohibited_content` codes (https://aistudio.google.com/docs/safety-settings, retrieved 2026-11-08). A coarse vendor category flag is not by itself actual knowledge (counsel defines the threshold), but it starts the review below.

### Registration

Before any real person uploads a photo (the private pilot), Holiday registers with NCMEC's CyberTipline as an electronic service provider. Reports begin through NCMEC's web form; API credentials, which NCMEC issues on request (https://report.cybertip.org/ispws/documentation/, retrieved 2026-11-08), come later. Owner: the product owner, until a trust-and-safety lead is named.

### Procedure

| Step | Action | Who |
| --- | --- | --- |
| 1. Detect | Sources of a signal: hash match at admission; child-safety classifier flag; vendor refusal in a child-safety category; a reviewer's observation in the review queue; a report | Automated; reviewer; triager |
| 2. Quarantine | The upload becomes `declined`, or, if it was already admitted, its render jobs are canceled; no provider call is made or continues; a preservation hold (a `preservation_holds` row) is placed on the normalized original and any derivative; access is restricted to the two named roles and every access is logged | Automated, then the trust-and-safety lead |
| 3. Minimize viewing | A hash match is reported without a human viewing the image where NCMEC's process allows; a classifier or vendor flag is reviewed by one trained reviewer only, through the review tool with blurred thumbnails by default | Trained reviewer |
| 4. Report | On actual knowledge, file the CyberTipline report with the counsel-approved template; target within 24 h of actual knowledge (configuration) and never later than the statutory standard | Trust-and-safety lead; counsel informed |
| 5. Preserve | The hold runs for the statutory period after the report; held objects are encrypted at rest in the held prefix and exempt from every retention and deletion path | Automated hold; operator release only |
| 6. Block | Block the session, device and IP signals and any account; add the checksum to the blocklist; terminate the account under the repeat-infringer policy | Trust-and-safety lead |
| 7. Do not tip off | The uploader sees only the neutral decline copy; nothing is disclosed to anyone other than NCMEC and law enforcement; no internal discussion outside the named roles | Everyone |
| 8. Record | An incident record (no image, no hash beyond what the report needs) in `audit_log` and the incident log; counsel receives the record | Trust-and-safety lead |

A user report with the reason "a child is pictured" is first assessed for which path applies: a family photo with a child in frame is the COPPA and privacy path; apparent abuse material is this procedure.

### Roles and wellbeing

- Trust-and-safety lead (the product owner until delegated): owns registration, reporting and the incident log.
- Counsel (external): approves the procedure and template; determines provider status and the actual-knowledge threshold; is informed of every report.
- Two trained reviewers: the only people who view flagged material; limits on daily review volume, the right to stop, and access to support are written into the reviewer guide before the pilot. The pilot's pre-delivery review means these provisions apply to ordinary review work as well.
- A tabletop drill of steps 1 to 8 runs before Gate C with a synthetic case (no real material), and the runbook is updated from it ([observability and operations](../architecture.md#observability-and-operations)).

## Abuse, harassment and takedown

Holiday lets anyone look up any US address (statement: any address may be explored within the limits in [PLAN §8](../PLAN.md#8-trust-privacy-and-safety)) and lets anyone upload a photo. Both surfaces need an owned response, specified at the same depth as rendering.

### Threat model

| Threat | Example | Mitigations |
| --- | --- | --- |
| Decorating someone else's home to mock or harass | A former partner's house rendered as a Halloween graveyard and posted socially | Curated packs only; no free-text prompts; no added text or signage; Halloween pack limits; private by default; share pages carry no address; report link on every share page; homeowner opt-out; takedown; the new-address allowance (values in [economics](economics.md#capacity-and-spend-ceilings), [D-12](../decisions.md#d-12)) |
| Offensive or shocking output | Gore, hateful or sexual imagery | Pack review; QA critical code `unsafe_or_offensive`; vendor moderation at the standard setting; vendor refusals terminal |
| Deception with a preview | Using a decorated image in a rental listing, insurance or HOA claim | "AI preview" label, IPTC and C2PA provenance ([D-28](../decisions.md#d-28)); Terms ban deceptive use; report reason "other" with triage |
| Scraping or bulk use | Enumerating addresses for a directory or dataset | Turnstile at session creation; per-session and per-owner limits; spend ceilings; no public gallery; `AT_CAPACITY` admission control ([allowance, quotas and rate limits](data-and-api.md#allowance-quotas-and-rate-limits)) |
| Copyright infringement | Uploading a listing photo or a photographer's work | Attestation at upload; DMCA notice and takedown; repeat-infringer policy |
| Prompt injection through image text | A sign in the photo reading "ignore the plan" | Image text is untrusted data; prompts compiled from allow-listed vocabulary ([moderation and model-behavior risks](render-pipeline.md#moderation-and-model-behavior-risks)) |
| Planting projects into another person's account through a sign-in link | An attacker has a victim open a magic link that was requested from the attacker's session, so the attacker's anonymous projects (or content the attacker uploaded) land in the victim's account | A sign-in claims only the rows of the session that is verifying the link. A link requested from one session and opened in another signs that other session in as the account holder but never claims the requesting session's projects, and the requesting session is never signed in by it ([sessions and sign-in](data-and-api.md#accounts)) |
| Spend abuse | Scripted render requests | Allowance, attempt cap, device/IP backstop, budget pause ([allowance, quotas and rate limits](data-and-api.md#allowance-quotas-and-rate-limits)) |
| False or mass reporting | Reporting a stranger's harmless project to get it removed | Human triage; rate limit on `POST /v1/reports`; outcomes audited |
| Impersonating Holiday | Phishing with the brand | Not mitigated by product design; handled with the brand and domain decision ([D-29](../decisions.md#d-29)) |

Address-path friction is deliberately plain: no "I live here" attestation on the address path, because the product is for any address and the Street View image is already public on Google Maps. The distinct-address cap is the D-12 allowance; anomaly patterns (many addresses from one device, repeated refusals) trigger a Turnstile re-challenge and cooldowns, not identity checks.

### Reports

- Entry points: on every result, on every share page and in the footer; reasons are harmful or offensive, privacy, "this is my home", a child is pictured, copyright, other ([reporting and feedback](experience.md#reporting-and-feedback)).
- `POST /v1/reports` is owner-independent: a share recipient can report what they were shown. The payload references a share token, a render ID or, for a homeowner opt-out, a resolved place; it is the only report endpoint, and no separate opt-out endpoint exists ([HTTP API](data-and-api.md#http-api)).
- Triage happens in the report-triage tool of the [internal operations API](data-and-api.md#internal-operations-api): queue, reviewer, decision, action, audit entry.
- Actions available: no action; delete derived outputs; delete the project; block the address (opt-out list); block the owner (cooldown, device and IP signals, account termination); place a hold; file a mandatory report.
- Service levels (defaults; configuration): acknowledgement to the reporter, when a contact was given, within 1 business day; decision within 2 business days; privacy and "this is my home" reports actioned within 2 business days; child-safety and illegal-content reports within 24 h.
- Every report, decision and action is in `audit_log`; monthly counts by reason and outcome are an operations metric.

### Repeat offenders

Escalating cooldowns on render requests (default 1 h, 24 h, 7 days; configuration); a blocklist of declined-upload checksums; blocking of session, device and IP signals; account termination. Signals are hashed and expire per the [retention schedule](#retention-schedule); a block records only the hashed signal, the reason and the date.

### Homeowner opt-out: "Don't decorate my home"

1. A footer link opens the form ([reporting and feedback](experience.md#reporting-and-feedback)): the address to protect and an email address for confirmation. No proof of ownership is required; the cost of over-blocking is low because a blocked address simply sends the address path to the photo prompt.
2. The form resolves the address to a place through the ordinary [address entry](address-and-street-view.md#address-entry) and submits `POST /v1/reports` with reason `this_is_my_home` and the resolved place; the server sends a confirmation email. On confirmation it writes a `blocked_addresses` row (place ID, created date, hash of the requester's contact, operator notes). The typed address text is deleted once the place ID is stored; the requester's email is kept only as a hash after confirmation. In the current build the operator's `block_address` triage action is the confirmation: in one step it writes the row with `requester_contact_hash` (SHA-256 of the normalized email), replaces the report's contact email with the same hash, removes the typed address text, runs step 4 and sends the one confirmation email (what was done, and Google's own tool for the source image; the email contains no address).
3. Discovery checks `blocked_addresses` before any Street View metadata call; a match routes to `skip_to_upload` with reason `blocked_address` ([match confidence and auto-start](address-and-street-view.md#match-confidence-and-auto-start)). The client-visible reason is projected to `unavailable` with honest generic copy ("A street photo isn't available for this address. Upload a photo to decorate it."; [copy deck](experience.md#copy-deck)); the block is never disclosed, and the copy never claims that no imagery exists.
4. Every existing derived output for that place ID, in every owner's projects, is deleted through the [deletion order](#deletion-and-verification), and the requester is told in one sentence what was done. "Derived" means made from Street View imagery of that place (uploads are matched by nothing, per step 5); each variant gets its own `asset` deletion request, and a variant under a preservation hold loses access but keeps its objects. Every retention sweep also purges any remaining Street View variant of a place on `blocked_addresses`, whatever wrote the row (homeowner request, operator, or a whole-house blur detected at render time), so a block removes existing variants within the hour.
5. Uploads are not blocked by an address entry (a photo has no address); a photo of the protected home can still be reported through "this is my home".
6. The confirmation reply points to Google's own "Report a problem" tool for blurring the source imagery at Google (https://www.google.com/streetview/privacy/, retrieved 2026-11-08), because Holiday cannot change Google's image.
7. Bulk or suspicious opt-out requests (many addresses from one requester) are held for operator review before taking effect.
8. The list is managed in the homeowner opt-out tool of the [internal operations API](data-and-api.md#internal-operations-api); removals require the original requester's confirmation.

### Copyright and DMCA (counsel to confirm)

Uploads are private by default and shared only by explicit grant, so public exposure of infringing material is limited to share pages. Holiday still adopts the §512 safe-harbor posture because the cost is small and the plan anticipates copied listing photos:

- Register a designated agent with the US Copyright Office and publish the agent's details on the site; the fee is $6 per designation and the designation expires three years after registration (https://www.copyright.gov/dmca-directory/, retrieved 2026-11-08).
- Notice intake accepts the elements of 17 U.S.C. §512(c)(3)(A); a valid notice leads to takedown of the identified project or share; the uploader is notified where permitted; counter-notices follow §512(g)(2), with restoration not less than 10 nor more than 14 business days after a counter-notice unless the claimant files suit (https://www.law.cornell.edu/uscode/text/17/512, retrieved 2026-11-08).
- A repeat-infringer termination policy per §512(i)(1)(A) is published in the Terms and applies to accounts and to anonymous sessions through the hashed-signal blocks above.
- Whether the safe harbor reaches AI-transformed outputs is a question for counsel; the posture does not depend on the answer.

### Law-enforcement and legal-process requests (counsel to confirm)

Holiday discloses user data only in response to valid legal process under US law, to NCMEC under the mandatory-reporting duty, or in a counsel-approved emergency involving imminent harm. Every request is logged with its authority reference; disclosure is limited to the responsive data; the user is notified where the law and the process permit (never for CyberTipline reports). Because data is keyed by opaque identifiers, a request must identify a project, share token, account email or place ID. The Privacy Policy states this policy in one paragraph.

### Tooling

Report triage, the opt-out list, holds and takedown actions live in the role-protected [internal operations API](data-and-api.md#internal-operations-api) with the operator authentication described in [security architecture](../architecture.md#security-architecture). Lookup is by opaque ID, share token, account email or place ID; there is no free-text search over addresses. Runbooks for abuse reports, opt-out requests, DMCA notices, apparent illegal content and law-enforcement requests are listed in [observability and operations](../architecture.md#observability-and-operations).

## Street View privacy

Google's Street View privacy page (https://www.google.com/streetview/privacy/, retrieved 2026-11-08) states that anyone can ask Google to blur "your entire house, car, or body", that Google honors such requests "by applying the blur to all copies of the published Street View image", that blurs are never removed from existing imagery, that automatic face and license-plate blurring applies to Google-contributed imagery, that newly blurred imagery is excluded from Google's own generative AI prompting, and that blur requests "do not affect any AI-generated imagery that has already been created or published by third parties". That last statement is why Holiday gates before rendering rather than relying on later blurs. The rules:

1. **Copyright gate, free and first.** The Street View metadata request costs nothing; its `copyright` field decides eligibility. Only Google-attributed imagery may be sent to any model ([D-15](../decisions.md#d-15)); contributor and unknown-copyright panoramas are `display_only`: shown for "Is this the right place?" and then replaced by the user's own photo. Contributor imagery is also outside Google's automatic face and plate blurring, which is a second reason to exclude it. Extending processing to contributor imagery is a licensing-outcome decision recorded under [licensing outcomes and activation](address-and-street-view.md#licensing-outcomes-and-activation), never a default.
2. **Owner-blurred houses are never decorated.** A facade blurred at the owner's request is a privacy refusal, not a quality problem to solve with another view, because Google blurs all copies. When scene analysis detects a blurred target facade ([scene analysis](render-pipeline.md#scene-analysis); the threshold is calibrated on fixtures, not fixed here) or a report identifies one, the render job ends `failed` with `failureKind` `source_rejected` and `failureDetail` `owner_blurred` before any paid edit, no alternate panorama is tried for that reason, and the user is offered their own photo (`NEEDS_PHOTO`; copy in the [copy deck](experience.md#copy-deck)).
3. **Protected regions.** Google's face and plate blurs and any blurred patch are passed to the renderer as regions to preserve, and because masks are guidance only, QA verifies the result: the critical code `privacy_regression` rejects any output in which a blurred region is sharper than in the input, a face, plate or text becomes legible, or structure is invented where the source was blurred ([quality checks](render-pipeline.md#quality-checks)).
4. **People and vehicles are never sharpened, reconstructed, added or removed.** When a candidate without people is available, discovery prefers it; otherwise the render proceeds with protected regions, and `people_altered` and `privacy_regression` guard the output.
5. **Stored copies do not receive later blurs.** In `transient` mode the panorama is refetched for every job, so owner blurs propagate automatically. In `persist` mode (only under a grant), metadata is revalidated at most every 24 h before reuse; a changed, blurred or removed panorama marks the source asset `stale` and purges derivatives ([panorama changes, blur and takedown](address-and-street-view.md#panorama-changes-blur-and-takedown)). The `street_view_revalidation` job deletes the stored copy when metadata reports the panorama replaced or removed (never on a failed or uninformative call, which leaves the check due), except for a source under a preservation hold; when metadata no longer returns imagery for it and no other panorama answers at its pinned location (`missing`: removed or blurred) it also withdraws and deletes every variant made from it, revokes their share grants and deletes their public copies, outputs and downloads through the deletion order (`purgeSourceDerivatives`); a panorama replaced by newer imagery keeps its variants, labeled by the stale source; a failed metadata call (`error`) changes nothing and retries on the next run. The job also re-checks sources already `stale`, in either mode, that still have live variants (not deleted, not withdrawn), when they were marked stale after their last check or that check is older than 24 h, and deletes any stored persist-mode copy of them (unless a hold covers the source), so a removal noticed at render time is purged within one run even if the render-time path did not purge it. At render time, in both source modes, a `missing` panorama (metadata no longer returns imagery and no other panorama answers at the pinned location) marks the source `stale`, purges every variant made from it (share grants, public copies and objects; requested by `system`) and deletes the persist-mode stored copy unless a preservation hold covers the source; a `replaced` panorama (newer imagery) marks the source `stale` (the label only) and fails the render `source_unavailable`, and an `error` (a failed or uninformative metadata call) fails the render `source_unavailable` and changes nothing (the source stays `ready` and the next request checks again). When the property's coordinates have expired (30 days) or were never kept, no location can be probed, so a `ZERO_RESULTS` or `NOT_FOUND` answer reads `missing` and purges the variants: without location evidence a panorama retired by newer imagery cannot be told from a removal, and the purge is the privacy-protective choice. Owner-blur detection on the facade keeps its `blocked_addresses` path, purged by the retention sweep.
6. **Attribution travels with the image.** The Google Maps logo or text and the per-image copyright accompany the before image and every Street View-derived output, are never cropped or covered, and are carried into downloads and share cards only where `distributeDerivative` is permitted ([before image and attribution](address-and-street-view.md#before-image-and-attribution)). The QA critical code `attribution_altered` rejects any Street View-origin output whose attribution is cropped, covered or altered ([quality checks](render-pipeline.md#quality-checks)).
7. **No promotional use.** Holiday's hero art, example art, marketing and social assets never use Street View imagery, in line with Google's Geo Guidelines, which bar Street View in advertisements and promotional materials (https://about.google/brand-resource-center/products-and-services/geo-guidelines/, retrieved 2026-11-08). User shares are the user's, not Holiday's promotion, and follow rule 6.
8. **Removal path for the pictured owner.** "Don't decorate my home" ([abuse, harassment and takedown](#abuse-harassment-and-takedown)) deletes derived outputs for the place ID, blocks future discovery and points to Google's own tool for the source.
9. **No addresses in discovery logs.** Discovery records its signals (precision class, distance, capture age, copyright class, people present, blur score) without the address ([match confidence and auto-start](address-and-street-view.md#match-confidence-and-auto-start)).
10. **Fixtures and live validation.** Fixtures for an owner-blurred house, blurred face and plate regions, contributor-copyright metadata and a person in frame are built from permissioned photos with synthetic blur ([external integrations and fixture modes](../architecture.md#external-integrations-and-fixture-modes)). Before `street_view_ai` reaches `live_private`, a live test confirms that Static API output shows the same owner, face and plate blurs as the Maps interface and captures real contributor copyright strings ([live Street View validation](quality-and-benchmark.md#live-street-view-validation)).

## US privacy law

A register of the regimes that bear on the US Release, with Holiday's posture. Every row is a working position, counsel to confirm; counsel also maintains the list of other state statutes and their thresholds, which this file does not attempt to enumerate. Thresholds are re-checked against traffic every quarter and recorded in the decision log.

| Regime | When it applies | Holiday's posture (counsel to confirm) | Source (retrieved 2026-11-08) |
| --- | --- | --- | --- |
| California Consumer Privacy Act as amended (CCPA/CPRA) | For-profit business with more than $25 million gross annual revenue, or that buys, sells or shares the personal information of 100,000 or more California residents or households, or derives 50% or more of revenue from selling personal information | Honor access, deletion and correction requests regardless of thresholds; no third-party ad trackers, so no "sale or share" (counsel to confirm that affiliate sub-IDs and network click tracking are not "sharing"); honor the Global Privacy Control signal as an opt-out; notice at collection through the just-in-time lines; quarterly threshold check | https://oag.ca.gov/privacy/ccpa |
| California Online Privacy Protection Act (Bus. & Prof. Code §22575) | Any operator of a commercial website collecting personally identifiable information from California residents | Applies from the first real user. The Privacy Policy is conspicuously posted and contains the categories of personal information collected and of third parties with whom it is shared, the process for reviewing and requesting changes, how changes are notified, the effective date, how "Do Not Track" signals are handled, and whether third parties collect data across sites | https://california.public.law/codes/ca_bus_and_prof_code_section_22575 |
| Other state comprehensive privacy laws | Thresholds vary, usually by consumer counts | Same rights honored for every US resident; counsel keeps the register; quarterly re-check | Counsel's register |
| Illinois Biometric Information Privacy Act (740 ILCS 14) and similar biometric statutes | "Biometric identifier" includes a "scan of hand or face geometry" | People detection is detection only: bounding boxes, no face templates, no geometry stored, no recognition ([D-18](../decisions.md#d-18)); vendor contracts confirm the same; counsel confirms the posture and lists similar statutes | https://lig.ilga.gov/legislation/ilcs/documents/074000140K10.htm |
| Children's Online Privacy Protection Act (COPPA) | General-audience operators on actual knowledge; photos containing a child's image are personal information | [Audience and age](#audience-and-age): 18+ stance, not directed to children, no age collection, actual-knowledge deletion procedure | https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions |
| CAN-SPAM Act | All commercial email; transactional or relationship messages are exempt from most provisions but may not contain false or misleading routing information | Magic links, deletion receipts and expiry notices are transactional and carry accurate headers. The US Release sends no marketing email. If a reminder opt-in is ever added it carries an opt-out honored within 10 business days, a physical postal address and an advertisement identification | https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business |
| FTC Act §5 | "Unfair or deceptive acts or practices in or affecting commerce" | The honesty statements (never a synthesized or neighboring house as the user's place; "AI preview" on every generated image; accurate product relationships), the advertising disclosure ([disclosure](commerce.md#disclosure)), and a Privacy Policy that matches configured behavior, checked mechanically at the gates | https://www.ftc.gov/about-ftc/mission/enforcement-authority |
| FTC Endorsement Guides | Material connections in recommendations | Owned by [commerce](commerce.md#disclosure) and [disclosure rules](../research/commerce-and-markets.md#disclosure-rules) | https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking |
| California AI Transparency Act (Bus. & Prof. Code §22757 et seq.) | Operative 2026-08-02 (AB 853 moved the date). A "covered provider" creates, codes or otherwise produces a generative AI system with more than 1,000,000 monthly visitors or users that is publicly accessible in California; duties include a free AI detection tool, an optional manifest disclosure and a latent disclosure that is permanent or extraordinarily difficult to remove; $5,000 per violation per day | Holiday uses vendors' systems rather than producing one and is below the user threshold initially, so it is likely not a covered provider (counsel to confirm whether an editing service "produces" a system). Its vendors are covered; Holiday preserves or re-signs their latent disclosures ([AI disclosure and provenance](#ai-disclosure-and-provenance)) and re-assesses if monthly users approach 1,000,000 | https://calmatters.digitaldemocracy.org/bills/ca_202520260ab853; https://www.mayerbrown.com/fr/insights/publications/2025/10/new-obligations-under-the-california-ai-transparency-act-and-companion-chatbot-l |
| New York synthetic-performer advertising disclosure (S.8420-A/A.8887-B) | Advertisements using a synthetic performer, with actual knowledge; effective 2026-06-09 per law-firm reports (secondary source) | Holiday's advertising never uses synthetic people; hero or example art with generated people would need review before use in ads | https://www.cooley.com/news/insight/2026/2026-01-29-new-york-enacts-synthetic-performer-disclosure-law-for-advertisements-including-those-us |
| State breach-notification statutes | A breach of personal information | The incident runbook includes a notification assessment with counsel; counsel keeps the register | Counsel's register |
| Google Maps Platform Terms (contract, not statute) | Any use of Google Maps Platform | §3.2.2(a)(i): Holiday's Terms notify users that the app includes Google Maps features and content and state that their use is subject to the Google Maps End User Additional Terms of Service and Google Privacy Policy; §3.2.2(a)(iii): suspend users who breach Google's terms; §3.2.1(c)(vi) (General Restrictions): no Customer Application directed to children under COPPA (counsel to confirm the reading; [audience and age](#audience-and-age); claim GM-32 in the [claims register](../research/address-and-imagery.md#claims-register)); §4.4(c)(i)–(iii): comply with privacy and cookie laws, give advance notice of the types of data collected, and do not provide end-user personally identifiable information to Google (counsel to interpret for typed addresses) | https://cloud.google.com/maps-platform/terms; analysis in [Google Maps Platform terms](../research/address-and-imagery.md#google-maps-platform-terms) |
| 17 U.S.C. §512 (DMCA) | Hosting user material | [Copyright and DMCA](#copyright-and-dmca-counsel-to-confirm) | https://www.law.cornell.edu/uscode/text/17/512 |
| 18 U.S.C. §2258A | Apparent child sexual abuse material | [Child safety reporting](#child-safety-reporting) | https://www.law.cornell.edu/uscode/text/18/2258A |

### Rights requests

- Channels: in-product deletion (`DELETE /v1/projects/:id`, `DELETE /v1/me`), the privacy email in the Privacy Policy, and the opt-out form. Access and correction requests arrive by email.
- Verification: for account holders, a magic-link confirmation from the account email; for anonymous data, only the session that created it can access it, which the policy explains; for non-users, see [deletion and verification](#deletion-and-verification).
- Global Privacy Control: the server reads the signal on every request and records it on the session; because Holiday has no sale or sharing, honoring it changes nothing functionally, and the Privacy Policy says so explicitly.
- Service levels: the defaults in [deletion and verification](#deletion-and-verification).

### Security incidents and breach notification (counsel to confirm)

A security incident is any unauthorized access to, or loss of, personal data in the [data inventory](#data-inventory), including a vendor's notice of an incident on their side. The posture, with the runbook itself in [observability and operations](../architecture.md#observability-and-operations):

1. **Contain first.** Use the kill switches in `runtime_settings`: global pause, per-provider disable, or setting the affected capability back to `fixture`; rotate the affected keys and the URL-signing secret (short signed-URL lifetimes make rotation effective within minutes); revoke operator sessions.
2. **Assess with counsel.** Assessment starts within 24 h of detection (configuration): which data classes, how many owners, which states and which contracts are involved.
3. **Notify.** Account holders by email where an address exists; anonymous owners cannot be reached individually, so a notice on the site covers them; regulators, consumers and contractual counterparties (Google Maps Platform, vendors, merchant networks) per counsel's register of state breach-notification statutes and the contracts' notice clauses.
4. **Record and learn.** Incident log entry, `audit_log` entries for every containment action, and a post-incident review whose actions enter the backlog.

The Privacy Policy states that Holiday notifies affected people as the law requires; the limits of notification for anonymous use are disclosed there too.

## AI disclosure and provenance

Policy level ([D-28](../decisions.md#d-28), Proposed); mechanics are owned by [provenance and labeling](render-pipeline.md#provenance-and-labeling).

1. **Every generated image is labeled "AI preview"** wherever it is shown: the result screen, the comparison (labels "Before" and "AI preview"), the share page and the share card. The label is part of the design, not an overlay the user can hide.
2. **Delivered files carry machine-readable provenance.** IPTC digital source type metadata states that the file is a composite with synthetic elements; from Phase 4 a Holiday-signed C2PA manifest is attached, with the provider's manifest as an ingredient when the provider supplies one. Compositing and re-encoding strip the vendor's own C2PA signature, which is why Holiday re-signs rather than claiming to preserve it. Invisible watermarks the vendor embeds (SynthID on Google models) survive where they survive; Holiday neither relies on nor removes them. Facts: OpenAI and Google outputs carry C2PA and SynthID signals, and re-encoding removes C2PA ([provenance](../research/image-ai-providers.md#provenance)).
3. **A downloaded or shared file remains identifiable without the page around it.** The share card always carries the visible label; downloaded files always carry the metadata and, by default, a small burned-in "AI preview" corner mark (configuration; the product owner may turn it off; [D-28](../decisions.md#d-28)), rendered as specified in [provenance and labeling](render-pipeline.md#provenance-and-labeling).
4. **Honesty statements** apply to every surface: never a synthesized house, a neighboring building or a placeholder presented as the user's place; product relationships stated as `similar` or `described`, never as the pictured item ([product relationships](commerce.md#product-relationships)); no claim that a preview is a measurement, quote or installation plan.
5. **A public page, "How AI previews work",** explains in plain language that previews are AI edits of a real photograph, that decor is illustrative, that products shown are similar or described items, and how to report a misuse ([legal deliverables](#legal-deliverables)).
6. **Law.** The California AI Transparency Act and the New York synthetic-performer law are in the [US privacy law](#us-privacy-law) register; neither currently imposes a duty on Holiday beyond what this policy already does, counsel to confirm.
7. **Street View attribution** is a separate obligation that accompanies the label on Street View-derived images ([Street View privacy](#street-view-privacy), rule 6).

## Legal deliverables

Drafts are produced by the product owner with engineering (AI drafting is acceptable); counsel review is recorded as a dated entry in the [decision log](../decisions.md#decision-log). Every document is versioned, and the version a user accepted is recorded on the session and on upload attestations. Numbers in the documents (retention, subprocessors, merchants, provider) are generated from or tested against configuration so the "notices match configuration" check at each gate is mechanical ([gates](../backlog.md#gates)). Footer placement is owned by [experience](experience.md#landing).

| Deliverable | Must contain | Owner | Needed by |
| --- | --- | --- | --- |
| Terms of Service | 18+ eligibility ([D-17](../decisions.md#d-17)); notice that the app includes Google Maps features and content and that their use is subject to the then-current Google Maps End User Additional Terms of Service and Google Privacy Policy (§3.2.2(a)(i)); acceptable use with a suspension path for breaches of Google's terms (§3.2.2(a)(iii)); the service is for places you live in or have permission to visualize; bans on use in real-estate, rental, insurance or HOA representations, harassment and deception; the versioned upload rights-and-age attestation text; outputs are AI previews with no warranty of fit, quantity, electrical or installation suitability; sharing and revocation terms, including that downloaded copies cannot be recalled; affiliate relationship statement; DMCA notice-and-takedown clause and repeat-infringer policy; allowance and limits may change | Product owner; counsel review | Gate C |
| Privacy Policy | CalOPPA §22575 contents (categories of personal information and of third parties, review and change process, change notification, effective date, Do Not Track and Global Privacy Control statement, cross-site tracking statement); the [data inventory](#data-inventory) in plain language; the [retention promise](#the-retention-promise) and provider tails by vendor name; preservation holds; the deletion and access channel and service levels; children statement (general audience, actual-knowledge deletion, photos may contain children); advance notice of data types (Google §4.4(c)(iii)); the subprocessor list; law-enforcement request policy; the no-sale, no-sharing and GPC statement | Product owner; counsel review | Gate C |
| Content policy page | What Holiday decorates and declines ([content policy and admission](#content-policy-and-admission)), people-in-photos behavior, that vendor refusals are final for a photo, how to report | Product owner | Gate C |
| "How AI previews work" page | The disclosure content in [AI disclosure and provenance](#ai-disclosure-and-provenance) | Product owner | Gate C |
| Advertising disclosure page and inline strings | Wording owned by [commerce disclosure](commerce.md#disclosure), including Amazon's required statement wherever Amazon links appear | Product owner with the commercial lead; counsel review | First `commerce:<merchantProgramId>` activation ([commerce activation](commerce.md#commerce-activation)) |
| Just-in-time notices | One-line notices at address entry, upload, save and share that match the policies (strings in the [copy deck](experience.md#copy-deck)) | Product owner | Gate C |
| Accessibility statement | [Accessibility statement](#accessibility-statement) below | Product owner with the web engineer | Gate D |
| DMCA policy and designated agent | Agent registered with the Copyright Office and published; notice and counter-notice procedure | Product owner; counsel | Gate D (registration may start earlier) |
| Takedown and homeowner opt-out page | "Don't decorate my home" form and explanation; report routes; pointer to Google's "Report a problem" | Product owner | Gate C |
| Storage and cookie notice | Required only if a cookie law applies to the session cookie and first-party analytics (US Release: strictly necessary session cookie, no third-party cookies); counsel decides whether a separate notice is needed beyond the Privacy Policy | Counsel | Gate C decision |
| Vendor data processing agreements | One per subprocessor in the [subprocessor table](#subprocessors), with the no-training, retention and age-terms positions recorded in the capability evidence | Product owner; counsel review | Before each vendor's `live_private` |
| Google licensing records | Outcomes recorded per [D-15](../decisions.md#d-15) in the decision log, asset policies and capability rows ([licensing outcomes and activation](address-and-street-view.md#licensing-outcomes-and-activation)) | Product owner (user) | Gate C for `live_private`; Gate D for `live_public` |
| Child-safety procedure sign-off and CyberTipline registration | [Child safety reporting](#child-safety-reporting) | Product owner; counsel | Before the first real-user upload (Gate C) |
| Counsel memo: audience, COPPA factors and provider age terms | The conclusions needed by [D-17](../decisions.md#d-17), [D-18](../decisions.md#d-18) and [D-42](../decisions.md#d-42) | Counsel | Before Gate A's provider decision for the age-terms part; Gate C for the rest |
| Counsel memo: Google §4.4(c)(ii) and address storage basis | Typed addresses relayed to Google; the display-address basis under [D-23](../decisions.md#d-23); whether the Places end-user-address exception allows storing a Place Details address string for an anonymous project (until it does, none is stored) | Counsel | Gate C |

## Accessibility statement

Holiday commits to WCAG 2.2 Level AA (NFR-06). The requirements that implement the commitment (combobox and slider patterns, focus management, live regions for stage changes, alt-text patterns for generated images, reduced motion, contrast over imagery, target sizes, keyboard-only flows) are specified in [accessibility](experience.md#accessibility); automated checks run in CI on every change, and a manual screen-reader pass (VoiceOver on iOS, NVDA on Windows) is a Gate C and a Gate D artifact.

The published statement contains:

| Element | Content |
| --- | --- |
| Commitment | WCAG 2.2 AA for the landing page, address path, upload path, result and comparison, Shop the look, account and share pages |
| Status | Conformance status as measured at the last audit, with the audit date |
| Known limitations | Filled from the audit before Gate D. Expected entries: alt text for generated images is derived from the decoration plan and may not describe every detail; the before/after slider has a button toggle as its alternative; Google Street View imagery and merchant pages are third-party content outside Holiday's control; images from users carry no alt text beyond "Your photo" |
| Contact route | An accessibility email address and the in-product feedback form (`POST /v1/feedback`), with a response target of 5 business days (configuration) |
| Review cadence | Statement reviewed at every release that changes a user-facing screen and at least once a year; the review date is printed on the page |
| Compatibility | Browsers and assistive technologies tested, listed from the audit |

Draft statement text (strings in the [copy deck](experience.md#copy-deck)): "Holiday is designed to meet WCAG 2.2 Level AA. We test every release with automated checks and screen readers. If something does not work for you, tell us at [accessibility email] or through the feedback form and we will respond within five business days. Known limitations and the date of our last review are listed below."
