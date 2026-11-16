# Local development and testing

How to run, try, test and develop Hailiday on one machine. It is written for the product owner first (the "Run it" and "A guided first test" sections need only Docker) and for engineers after that (host development, tests, troubleshooting). Everything here is read from the repository: the compose files, `package.json` scripts, `.env.example`, the configuration module, the fixture data READMEs and the Playwright configuration.

**Owns:** local prerequisites; the one-command start and the local service endpoints; the guided first test; running fixture and live providers locally, including the live-mode budget guide, the development-mode limits and the model bake-off command; `.env` use and precedence; host development; the root script reference; running the unit, integration and browser tests; resetting, logs and local troubleshooting; the known limitations of fixture mode. Provider parameters and their configuration contract are owned by the [render pipeline](specs/render-pipeline.md#provider-parameters); runtime setting values by [data and API](specs/data-and-api.md#allowance-quotas-and-rate-limits).
**Baseline:** repository state at planning baseline 2026-11-09. The integration and fixture/live matrix is owned by [architecture](architecture.md#external-integrations-and-fixture-modes); the activation vocabulary by the [glossary](glossary.md).

## Prerequisites

| Need | Version | Why |
| --- | --- | --- |
| Docker with Compose | Compose 2.24 or later | `docker-compose.yml` marks `.env` as an optional env file (`required: false`), which older Compose versions reject. This is all the one-command start needs. |
| Node | 26 (`.node-version` is `26`; `engines.node` is `>=26`) | Host development, tests and the browser tests only. |
| pnpm | 10.34.9, pinned by `packageManager` in the root `package.json` | Host development, tests and the browser tests only. With Corepack enabled (`corepack enable`), running `pnpm` in the repository selects that version. |

You need no provider accounts or keys: with none configured, every integration runs in fixture mode ([fixture and live providers](#fixture-and-live-providers)).

## Run it

From the repository root:

```bash
docker compose up --build
```

`pnpm docker:up` runs the same command detached (`-d`). The first build takes a few minutes. Open http://localhost:8080 when the `api` service is healthy (its health check calls `/healthz`).

Compose starts these services:

| Service | What it is | URL or address | Credentials |
| --- | --- | --- | --- |
| `api` | The Fastify API; it also serves the built web app, share pages and the live-update stream | http://localhost:8080 (`APP_PORT`) | none |
| `mailpit` | A mail catcher. Every email the app sends, such as the magic link, lands here | http://localhost:8025 (`MAILPIT_PORT`) | none |
| `storage` | RustFS, an S3-compatible object store holding uploads, renders, heroes and share cards | API http://localhost:9000 (`STORAGE_PORT`); web console http://localhost:9001 (`STORAGE_CONSOLE_PORT`) | access key `hailiday`, secret `hailiday-dev-secret` (set in `docker-compose.yml` for the storage and the app services alike) |
| `postgres` | PostgreSQL 16; it also holds the job queue | `localhost:5434` (`DB_PORT`), database `hailiday` | user `postgres`, password `postgres` |
| `migrate` | A one-shot job that runs the database migrations, installs the queues, creates the buckets with their CORS and public-read policy, then seeds content. It exits when done | none | none |
| `workers` | The pg-boss consumers that run renders, upload screening and the scheduled sweeps | none | none |

`api` and `workers` start only after `migrate` has finished successfully, so a failed migration keeps the app down ([troubleshooting](#troubleshooting)). Postgres listens on 5434, not 5432, so it does not collide with a Postgres already on your machine.

`docker-compose.yml` sets the local storage's credentials and bucket names itself, for the app services and the storage service with the same literals (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PRIVATE_BUCKET` and `S3_PUBLIC_BUCKET` in `x-app-env`), so a value left in `.env` from an earlier `.env.example` cannot make the stack's storage, the app and the tests disagree.

The stack's stored-data names carry the product name: the Compose project `hailiday`, the volumes `hailiday-pgdata` and `hailiday-storage`, the database `hailiday`, the storage credentials' defaults (`hailiday` and `hailiday-dev-secret`), the buckets `hailiday-private` and `hailiday-public`, the cookies `hailiday_session` and `hailiday_device` and the browser storage keys `hailiday.…`. The browser-test stack and the test database are `hailiday-e2e` and `hailiday_test`.

**A checkout that ran under the old name.** The stack now starts as Compose project `hailiday` with empty volumes: an empty database and empty storage. A `.env` copied from an earlier `.env.example` still names the old database, buckets, credentials and sender, so update the values of `DATABASE_URL`, `DATABASE_URL_TEST`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PRIVATE_BUCKET`, `S3_PUBLIC_BUCKET` and `EMAIL_FROM` to the ones in the current `.env.example`. The stack in Docker runs either way, because Compose sets the containers' `DATABASE_URL`, the storage credentials and the bucket names itself; the four storage values in `.env` matter only for tools you run on the host, and those tools with `DATABASE_URL` need the new database name. The old project's containers and data remain until you remove them: `docker compose -p holiday down` stops them and keeps the data, and `docker compose -p holiday down -v` deletes it. Browsers get a new session cookie, so places made under the old name are not listed.

## A guided first test

Each step below can be done in a few minutes and needs no keys. The landing page takes a holiday from a deep link, which is useful off-season: http://localhost:8080/?holiday=christmas preselects Christmas.

### 1. The happy path

1. Open http://localhost:8080/?holiday=christmas. Type `14 Lan` in the address field and pick **14 Lantern Hill Rd, Maplebrook, VT**.
2. This place starts without a confirmation step. A waiting screen shows the stages, then the before and after result appears with a slider.
3. The page is minimal: the picture, a row of actions, and four collapsed rows. Open **Try another look** to change the holiday, style and lighting (the first look of an exterior is Abundant in the Evening light; an interior is Abundant and Bright, with no lighting choice). Open **Shop the look**, share the preview, save it, open **How does it look?** to give feedback or report it, and delete the project from **More**.
4. Open **Gallery** in the header: every look you made appears there, grouped by place. Typing the same address again returns to the same place and its results.

Every image from fixture mode carries a **Fixture** badge ([what fixture images are](#what-fixture-images-are)).

### 2. The fixture places

All places are fictional: invented street and town names, real states (the state selects the climate class). Type the beginning of the street, or part of the name, and pick the suggestion. Real addresses need the Google keys ([live mode](#live-mode)); without them any other address finds no match, and the empty state says so and offers `14 Lantern Hill` and `418 Larkspur` as one-tap samples. The complete table, with the photo each place uses, is [`packages/server/fixtures/README.md`](../packages/server/fixtures/README.md).

| Scenario | Type | What you should see |
| --- | --- | --- |
| Auto-start, render passes | `14 Lantern Hill` | Straight to rendering (the best all-round test house). Also `2207 Saguaro Bend` (warm climate, no snow at Christmas) and `418 Larkspur` (full porch) |
| Existing decorations | `2401 Orchard Bluff` | Glowing jack-o'-lanterns already on the porch; new items avoid them and the result says so. Its street photo was taken at dusk, so its default Evening look is the photo decorated as photographed (the relight is skipped and the attempt records why), and afterwards Evening is no longer offered |
| Snow already present | `6610 Birchfield` | A winter photo; nothing adds more snow |
| Confirm the place | `4 Driftwood Cove` | A confirmation step with three views to compare before rendering. Also `880 Tamarack` (41 m away, 2018 capture), `31 Piñon Mesa` (contributor imagery: confirmed first like any place, then decorated and credited to its own copyright holder; under `STREET_VIEW_CONTRIBUTOR_IMAGERY=display_only` the photo only confirms the place, then the app asks for your own photo), `1207 Larch` (attached row house) and `250 Old Quarry` (partial match, deep setback) |
| Skip to upload: no imagery | `4120 Bitterroot` | Straight to "upload your own photo" |
| Skip to upload: multi-unit | `2150 Wicker Ln Apt 4B` | The facade is not decorated as your home; the app asks for a photo of your door, balcony or room |
| Skip to upload: low precision | `Sourwood Ridge Rd` | Only the road matched, so the app asks for a photo |
| Skip to upload: blocked address | `63 Wren Song` | Shown only as "a street photo isn't available" (the homeowner opt-out is never revealed) |
| Skip to upload: lookup error | `940 Aspen Hollow` | Skip to upload with a retry offer |
| Outside the US | `18 Thornbury` | Appears in suggestions, but resolving it is refused (`ADDRESS_OUT_OF_SCOPE`) and no project is created |
| Slow render | `1735 Magnolia` | The render stage takes about 20 seconds, so the waiting screen and its stage labels stay visible |
| Repair | `9 Gullwing` | Attempt 1 fails a quality check, attempt 2 passes. For the default Evening look of an exterior (a relit look) attempt 1 is the decorated base, attempt 2 repairs it and attempt 3 relights it |
| Reject | `52 Fernwood` | Both attempts fail; the job ends rejected and no allowance is used |
| Provider error | `308 Mesquite Draw` | The image editor fails (`provider_error`); no allowance is used |
| Moderation | `1199 Cornflower` | The editor refuses the input (`moderation_blocked`); that source cannot be rendered again |
| No anchors | `77 Hemlock Ridge` | Too occluded (`source_rejected` / `no_usable_anchors`); the app offers the upload path |
| Owner-blurred facade | `15 Sitka Spruce` | The house is blurred in the street photo; the render is refused (`owner_blurred`) and the upload path is offered |

Manual entry also works: type the street line exactly as listed (`14 Lantern Hill Road` or `14 Lantern Hill Rd`) with any city, state and ZIP. A different city or ZIP still matches but is flagged as a partial match, and a manual entry never auto-starts, so even a clean place shows the confirmation step.

### 3. Uploading your own photo

Six sample photos ship in [`packages/server/content/photos/samples/`](../packages/server/content/photos/samples/): `sample-front-porch.jpg`, `sample-dining-room.jpg`, `sample-living-room-mantel.jpg`, `sample-kitchen.jpg`, `sample-balcony.jpg` and `sample-apartment-hallway.jpg`. On the landing page choose **Upload a photo instead**, or reach the upload step through any skip-to-upload place above.

Outcomes follow the file name. Copy a sample and rename it; matching ignores case, and hyphens, underscores, spaces and dots count as the same separator.

| File name contains | Result |
| --- | --- |
| `decline` | Declined with guidance (`not_a_living_space`) |
| `people` | Accepted with people detected; you choose crop, keep or another photo (`PEOPLE_DETECTED` until you do) |
| `hold` | Held for review; it stays in screening |
| `repair` | Render: attempt 1 fails a quality check, attempt 2 passes; a relit look (the default bright look of an interior) relights the repaired base on attempt 3 |
| `relight reject` (also `relight-reject`) | Render: the decorations pass, every relight fails its checks (the fixture scenario `relight_reject`); an evening look ends with its daylight look delivered, with one line and "Try the evening light again" |
| `reject` | Render: both attempts fail (rejected, allowance not used) |
| `provider-error` | Render: the image editor fails (`failed`, `provider_error`) |
| `slow` | Render: about 20 seconds |
| `no-anchors` | Render: nothing to decorate (`failed`, `source_rejected` / `no_usable_anchors`) |
| `moderation` | Render: the editor refuses the photo (`failed`, `moderation_blocked`) |
| anything else | Accepted; the render passes |

The scene type also comes from words in the file name: `dining`, `living`, `kitchen`, `bedroom`, `entryway` or `foyer` (interior); `balcony`, `patio` or `terrace`; `apartment`, `hallway` or `door` (apartment entry); `house`, `porch`, `front` or `townhouse` (house exterior). With none of these the app asks you to pick the scene type. For example, `thanksgiving-dining-slow.jpg` is a dining room that renders slowly. The full rules are in [`upload-triggers.json`](../packages/server/fixtures/upload-triggers.json).

### 4. Read the magic-link email

Choose **Save this place**, enter any email address and submit. In Docker the message goes to Mailpit: open http://localhost:8025, open the newest message and click the link (it is valid for 15 minutes, `MAGIC_LINK_TTL_MIN`). The saved place then appears under **Your places**. On the host, where the email provider defaults to `fixture`, the link is written to the API log instead (the `fixture email recorded` line carries it in development) and the message is stored in the `fixture_emails` table.

### 5. Hit the daily allowance

The product gives each owner (a browser session, or an account once signed in) 3 accepted looks and 3 new addresses in a rolling 24 hours (`allowance.variants_per_24h` and `allowance.addresses_per_24h`, [allowance rules](specs/data-and-api.md#allowance-quotas-and-rate-limits)). Rejected and failed renders, and a repeat of a look you already have, consume nothing. Local development raises these limits to 30 so that one person can test freely ([development-mode limits](#development-mode-limits)), so to see the limit:

- Put `ALLOWANCE_VARIANTS_PER_24H=3` (or `1`, to reach it faster) in `.env` and run `docker compose up -d --force-recreate api workers`. Any runtime setting can be overridden this way ([configuration](#configuration-with-env)).
- Render that many different looks on one project by changing the holiday, style or lighting each time. The next attempt shows **That's all the looks for today** with the time more looks arrive, and everything already made stays usable.

## Fixture and live providers

### What fixture images are

Fixture mode never draws or generates pictures from scratch.

- Street-level photos are real, licensed photographs of other houses from [`packages/server/content/photos`](../packages/server/content/photos/README.md), credited in each frame as "Fixture photo: photographer / license" and never presented as Google imagery. Hero images and the sample photos are real photographs too.
- A "decorated" result is made by the fixture compositor, which places cut-out photographs of real decorations (wreaths, pumpkins, lanterns, garlands, candles) on the measured positions of the house or room. These are photographic stand-ins for what the image-editing model would produce, not the model's output.
- Every such image is marked with a **Fixture** badge in the app and carries `providerMode: fixture` in its metadata, so it cannot be mistaken for a real photo of a place. Fixture success never counts as live validation ([activation and completion](glossary.md#activation-and-completion)).

### Choosing a provider

Each leg has a provider setting. In `.env.example` and in development the default is `auto`: use the live provider when its key is set and the fixture otherwise. Outside development (`test`, `staging`, `production`) the default is `fixture`.

| Leg | Setting | `auto` becomes live when | Explicit values |
| --- | --- | --- | --- |
| Address lookup | `ADDRESS_PROVIDER` | `GOOGLE_MAPS_SERVER_KEY` is set | `fixture`, `google` |
| Street View display | `STREET_VIEW_PROVIDER` | `GOOGLE_MAPS_SERVER_KEY`, `GOOGLE_STREET_VIEW_BROWSER_KEY` and `GOOGLE_STREET_VIEW_SIGNING_SECRET` are all set | `fixture`, `google` |
| Image editing | `IMAGE_EDITOR_PROVIDER` | `GEMINI_API_KEY` or `OPENAI_API_KEY` is set; with both, `IMAGE_EDITOR_PREFERENCE` picks (default `openai`) | `fixture`, `openai`, `gemini` |
| Scene analysis and quality judging | `VISION_PROVIDER` | `ANTHROPIC_API_KEY` is set | `fixture`, `anthropic` |
| Upload screening (hash matching, moderation, people detection) | `SAFETY_PROVIDER` | never: `fixture` is the only value, because the live vendors are not chosen yet. The living-space, scene and people check of an upload (the triage call) is not part of this leg: it runs on live Claude whenever `VISION_PROVIDER` is live | `fixture` |
| Bot check | `TURNSTILE_MODE` | not part of `auto`; set `live` and both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. Staging and production refuse to start (and the migrate and release step shares that check) unless it is `live` | `fixture` (accepts the token `fixture-pass`; development and test only), `live` |
| Email | `EMAIL_PROVIDER` | not part of `auto`; `smtp` in Docker (to Mailpit), `fixture` on the host. Staging and production refuse to start unless it is `smtp`; `createEmailSender` also refuses the fixture sender outside development and test, with a startup error naming `EMAIL_PROVIDER=smtp` | `smtp`, `fixture` (development and test only) |

Selecting a live provider explicitly without its keys is a startup error that names the missing variable, and so is any live selection under `APP_ENV=test`, which runs only fixtures.

Under the default Street View use policy (`STREET_VIEW_USE_POLICY=full`, an owner decision of 2026-11-10; [licensing outcomes and activation](specs/address-and-street-view.md#licensing-outcomes-and-activation)), real Street View frames are decorated like uploaded photos, at the owner's accepted risk against the Google Maps Platform terms. With the Google keys the address path therefore shows real Street View to confirm the place (clean places auto-start) and decorates it. Contributor imagery follows the same policy once you have confirmed the place. Every place when `STREET_VIEW_USE_POLICY=display_only`, and contributor imagery when `STREET_VIEW_CONTRIBUTOR_IMAGERY=display_only`, shows the street photo only to confirm the place and then asks for your own photo of the front. Adding `OPENAI_API_KEY` (or `GEMINI_API_KEY`) together with `ANTHROPIC_API_KEY` switches uploads to Claude analysis and live photorealistic decoration.

Live calls cost money. Keys go only in `.env`, never in your shell and never in a committed file. To force fixture mode:

- leave the keys empty (or comment them out) in `.env`; or
- set `ADDRESS_PROVIDER`, `STREET_VIEW_PROVIDER`, `IMAGE_EDITOR_PROVIDER` and `VISION_PROVIDER` to `fixture` in `.env`, which holds even when keys are present; or
- use the browser-test stack (`pnpm docker:e2e`), which sets every provider to `fixture` and blanks every key regardless of `.env` ([browser tests](#browser-tests)).

The before and after examples on the landing page are never drawn by fixtures. They are produced by `pnpm --filter @hailiday/server examples:render [exampleId]`, which needs a live image editor and otherwise explains what is missing and exits with code 2. It compiles with the configured `IMAGE_EDIT_PROVIDER_MASK`, `OPENAI_IMAGE_QUALITY`, `GEMINI_IMAGE_SIZE` and `GEMINI_THINKING_LEVEL`, as the render job does; without them the example strip stays hidden.

### Live mode

Live mode is the same app with real models behind the image legs.

**Before you add a key.** Live calls send your photos to the vendor, so the account behind each key must meet the plan's vendor conditions ([data-handling rules](specs/privacy-safety-legal.md#data-handling-rules), rule 9; the same conditions as owner action 9 in the [README](README.md#what-the-owner-needs-to-do-next)):

- Gemini: a key from a Google AI Studio or Google Cloud project with billing enabled (the paid tier). The free tier returns `RESOURCE_EXHAUSTED` with a limit of 0 for `gemini-nano-banana-2.1`, and its terms let Google use content to improve products and let human reviewers read it ([data, training and age terms](research/image-ai-providers.md#data-training-and-age-terms), claim AI-11).
- OpenAI: an organization with zero data retention enabled for the image endpoints (`gpt-image-2.5-flare` and `gpt-image-2.5-sunburst` are eligible). Without it, inputs and outputs stay in abuse-monitoring logs for up to 30 days ([provider-side retention](specs/privacy-safety-legal.md#retention-schedule)).
- Anthropic: a paid account.

Until these are confirmed, render live only the shipped [sample photos](#3-uploading-your-own-photo) and the curated examples, never a photo of a real home or room.

Put the keys in `.env` (never in your shell), leave the provider settings at `auto`, then apply them: `docker compose up migrate` re-runs the seed, which in development sets each matching capability to `live_public` (`street_view_ai` too, once the Street View and image-editor keys are set and `STREET_VIEW_USE_POLICY` is not `display_only`), so any local session, including an anonymous one, reaches the live model (a deliberate local-only deviation, [D-47](decisions.md#d-47); a capability an operator changed is never overwritten, and the `live_private` pilot path runs only when you set a row through the internal capabilities API), and `docker compose up -d --force-recreate api workers` restarts the app with the keys. On the host, run `pnpm db:seed` and restart `pnpm dev`. Removing a key and doing the same returns that leg to its fixture.

| Key in `.env` | What turns live |
| --- | --- |
| `GEMINI_API_KEY` | Image editing with Google Nano Banana 2.1 (`GEMINI_IMAGE_MODEL`) |
| `OPENAI_API_KEY` | Image editing with OpenAI GPT image 2.5 (`OPENAI_IMAGE_MODEL`) |
| `ANTHROPIC_API_KEY` | Claude scene analysis of each photo, the Claude QA judge of each attempt, the localization call that finds the decorations the editor drew, and the Claude triage of each uploaded photo (living space, scene, people), even though `SAFETY_PROVIDER` stays `fixture` (`ANTHROPIC_VISION_MODEL`, default `claude-opus-5-5`). Without it a live edit is planned from fixture analysis, which knows only the shipped library photos and generic positions, so set it together with an image key |
| `GOOGLE_MAPS_SERVER_KEY`, `GOOGLE_STREET_VIEW_BROWSER_KEY`, `GOOGLE_STREET_VIEW_SIGNING_SECRET` | Address lookup and Street View display. Street View is shown to confirm the place and, under the default use policy, decorated; with `STREET_VIEW_USE_POLICY=display_only` (or `STREET_VIEW_CONTRIBUTOR_IMAGERY=display_only` for imagery credited to someone other than Google) the visitor's own photo is what gets decorated |

Street View has these settings besides its keys:

| Variable | Values | Default |
| --- | --- | --- |
| `STREET_VIEW_USE_POLICY` | `full`: Google-attributed frames are decorated like uploads (stored privately, downloadable, shareable, with Shop the look); `decorate`: processing and editing only (frames stay in worker memory, private previews); `display_only`: display for confirmation only | `full`. Seeded `street_view_ai` rows (version 0) switch to `live_public` on the next seed once the Street View and image-editor keys are set |
| `STREET_VIEW_CONTRIBUTOR_IMAGERY` | `decorate`: imagery not attributed to Google (a contributor's, or of unknown credit) gets every use `STREET_VIEW_USE_POLICY` gives Google imagery, after the confirmation screen (it never starts decorating by itself); `display_only`: it is shown for confirmation only whatever the use policy. A change acts at the next use: places found under `display_only` become decoratable, and switching back refuses new looks, deletes stored frames, revokes share links and makes existing looks private | `decorate` |
| `STREET_VIEW_FRAME_MAX_AGE_DAYS` | a positive integer: the age in days after which a stored Street View frame is fetched again before it is decorated (one $0.007 Static fetch and one scene analysis, both reserved at admission; the analysis is released when the frame's bytes are unchanged). The fetched frame replaces the stored copy (unless a preservation hold covers the source) and the render goes on with it, so no new look is made from the old copy; other bytes never take the address out of use | `30` |
| `STREET_VIEW_FRAMING` | `on` or `off`. `on`: at a Street View source's next look while no framing is recorded (its first look, or the next look of a place whose looks were made before) the vision model finds the home in the fetched frame and the frame is fetched again from the same panorama zoomed in on it, so every look shows just the home ([framing](specs/render-pipeline.md#framing)); it costs about $0.01 (a vision call of about $0.003 and one $0.007 Static fetch) and about 4 to 5 s once per source and nothing on later looks (a place with earlier looks also pays, at that look, for the analysis and the enhancement of the framed frame). It runs for Street View exteriors only (uploads keep the person's framing). Earlier looks keep their wide picture and a true "Before", and the framing is recorded only while no other render job of the source is unfinished. `off` keeps the confirmed view as the frame. A home the model cannot find, or that zooming in would hardly improve, is recorded and the wide frame is kept; a failed call records nothing and the source's next look tries again | `on`. Tests and the server's test configuration turn it off unless a test is about it; the browser-test stack pins it on |
| `STREET_VIEW_ENHANCE` | `on` or `off`. `on`: before a stored Street View frame is decorated, the image editor redraws it once, sharper and cleaner, the result is checked, and every look of the address is made on that picture ([enhancing](specs/render-pipeline.md#enhancing)); it costs about $0.06 and about 30 s on an address's first look of a release and nothing on later looks, and it needs `STREET_VIEW_USE_POLICY=full` (a `decorate` frame is not stored, so nothing is enhanced). `off` restores looks made on Google's pixels. It has no effect on uploads. A rejected or failed enhancement is never an error: the look is made on the frame as before | `on`. Tests and the server's test configuration turn it off unless a test is about it; the browser-test stack pins it on |
| `STREET_VIEW_ATTRIBUTION_REGIONS` | a JSON object mapping the requested Static size `"<width>x<height>"` to a list of `[x0,y0,x1,y1]` boxes normalized to that frame; invalid JSON, a key or a box refuses startup with an issue naming the variable | `{"640x640": [[0, 0.955, 0.11, 1], [0.80, 0.965, 1, 1]]}`, the rectangles measured on live frames on 2026-11-10 by the [embedded attribution test](specs/address-and-street-view.md#embedded-attribution-test-phase-1); the environment value overrides it and `{}` configures none |

**Which editor `auto` picks.** With one image key, `IMAGE_EDITOR_PROVIDER=auto` uses that editor. With both, it uses `IMAGE_EDITOR_PREFERENCE` (`gemini` or `openai`, default `openai`: GPT image 2.5 Flare at `medium`, the provisional default recorded in the 2026-11-09 [D-42](decisions.md#d-42) decision log entry with the bake-off evidence; Nano Banana 2.1 is the configured fallback). An explicit `IMAGE_EDITOR_PROVIDER=openai` or `gemini` always wins.

**Checking what is live.** The `api ready` and `workers ready` log lines (`docker compose logs api workers | grep ready`) list each leg's mode under `providerModes`, the editor in use under `imageEditor` (`provider`, `model`, the `auto` preference and the budget settings sent with every edit) and the vision model under `vision`. A leg on its fixture shows `"provider": "fixture"` and `"model": null`. No key is ever logged.

**Budget settings.** The defaults are the provisional budget defaults the [model bake-off](#model-bake-off) informed ([D-42](decisions.md#d-42)). The contract (values, repair behavior, mask policy) is in [provider parameters](specs/render-pipeline.md#provider-parameters).

| Variable | Values | Default |
| --- | --- | --- |
| `GEMINI_IMAGE_MODEL` | a Gemini image model ID | `gemini-nano-banana-2.1` |
| `GEMINI_IMAGE_SIZE` | `1K`, `2K` | `1K` |
| `GEMINI_THINKING_LEVEL` | `minimal`, `medium`, `high` | `minimal` |
| `OPENAI_IMAGE_MODEL` | an OpenAI image model ID | `gpt-image-2.5-flare` |
| `OPENAI_IMAGE_QUALITY` | `low`, `medium`, `high`, `auto` | `medium` |
| `IMAGE_EDITOR_PREFERENCE` | `gemini`, `openai` | `openai` |
| `IMAGE_EDIT_PROVIDER_MASK` | `none`, `tight` | `none` (no mask is sent; the local paste-back keeps the working image's pixels (the original photo's, or the enhanced picture's for a stored Street View frame) everywhere except the decorations the editor added: the plan's shapes and the localized items) |

**Time limits.** `RENDER_MAX_JOB_DURATION_S` (default 240, and also its floor: a lower value is raised to 240, `MIN_RENDER_MAX_JOB_DURATION_S`) is the longest a render job may run, and the render queue expires a job 30 s after it (`RENDER_QUEUE_EXPIRY_MARGIN_S`), so the job's own deadline always fires first and its fallbacks can still deliver the picture it has; a relit look may make three edit attempts, so the limit leaves room for the third, and an environment that still pins an early example's 180 s runs with 240 s. A repair or a relight starts only while the job has more than `RENDER_REPAIR_BUDGET_S` (default 48) left, and a relight edit's timeout (and a repair's, while the job keeps an attempt to fall back on) is the smaller of the 120 s render timeout and the time left on the job minus 15 s, so a slow relight ends as an attempt timeout with time left to fall back to its base ([latency budget](specs/render-pipeline.md#latency-budget)).

What one call cost in the 2026-11-09 model bake-off (eight example photos, 1536 × 1024, measured from the token usage each provider reported at list prices). The [cost worksheet](specs/economics.md#cost-worksheet) owns these figures (measured live costs) and their use in the unit economics; this table is a quick guide to the settings:

| Configuration | Settings | Cost per call |
| --- | --- | --- |
| OpenAI 2.5 Flare, medium (the default editor) | `OPENAI_IMAGE_MODEL=gpt-image-2.5-flare`, `OPENAI_IMAGE_QUALITY=medium` | about $0.025 per edit |
| OpenAI 2.5 Sunburst, high | `OPENAI_IMAGE_MODEL=gpt-image-2.5-sunburst`, `OPENAI_IMAGE_QUALITY=high` | about $0.057 per edit |
| Gemini Nano Banana 2.1, 1K, thinking minimal (the Gemini settings) | `GEMINI_IMAGE_SIZE=1K`, `GEMINI_THINKING_LEVEL=minimal` | about $0.050 per edit ($0.046 to $0.069) |
| Gemini Nano Banana 2.1, 1K, thinking medium | `GEMINI_THINKING_LEVEL=medium` | about $0.053 per edit |
| Gemini Nano Banana 2.1, 2K, thinking medium | `GEMINI_IMAGE_SIZE=2K`, `GEMINI_THINKING_LEVEL=medium` | about $0.069 per edit |
| Claude Opus 5.5 scene analysis | `ANTHROPIC_VISION_MODEL=claude-opus-5-5` | about $0.041 per photo |
| Claude Opus 5.5 QA judge | same | about $0.036 per attempt |
| Claude Opus 5.5 addition localization | same | about $0.034 per decorating attempt, about 9 s |
| OpenAI 2.5 evening relight (no mask), medium | `OPENAI_IMAGE_MODEL` Flare or Sunburst | about $0.025 (Flare); $0.0225 to $0.0250 (Sunburst, measured 2026-11-10) |
| Claude Opus 5.5 home location for the framing (one image, effort `low`) | same | about $0.003 per call and, with the framed Static fetch ($0.007), about 4 to 5 s, once per source at its first look (2026-11-11) |
| OpenAI 2.5 enhancement of a Street View frame (no mask), medium | `OPENAI_IMAGE_MODEL` | about $0.022 and 19 to 21 s per edit (three frames, 2026-11-11), plus an enhancement judge call of about $0.035 to $0.04; once per frame and release |

A render pays one analysis per job, one localization call and one judge call per decorating attempt, and a repair is a second edit, localization and judge call. A relit look (evening, or bright for interiors) relights the decorated photo: one relight edit and one judge call, no localization, after the decorating attempt when the daylight look does not exist yet. An evening-first exterior look with no daylight variant is therefore two sequential edits, measured at $0.12 to $0.18 and 72 to 105 s ([economics](specs/economics.md#cost-worksheet)); a rejected base is repaired once before its relight and a rejected relight is repaired once, so such a look makes at most three edits, about 125 s. A dusk or night photo's evening look and an already-bright interior are one edit; a relit interior look is two edits (a live bright relight measured about $0.025 at `medium`, 11 to 15 s). The first render of a persisted Street View source, and the first after its stored frame passes `STREET_VIEW_FRAME_MAX_AGE_DAYS`, adds one $0.007 Static fetch. With `STREET_VIEW_FRAMING` on, the look that frames a Street View source (its first look, or the next look of a place with earlier looks) also adds the framing, about $0.01 and 4 to 5 s once per source. With `STREET_VIEW_ENHANCE` on it also adds the enhancement of the stored frame, about $0.06 and about 30 s once per frame and release (an evening-first look of a new address then takes about 100 to 140 s, 155 to 166 s with a repair, and 124 s on the first live address; a time limit under 240 s is raised to 240 s, because a first evening look of an address that needed a repair had no time left for the evening light under 180 s); later looks of the address pay and wait nothing extra. With the default editor a look costs about $0.10 on a first-attempt pass and, at the bake-off's acceptance rate, about $0.13 per accepted look; with Nano Banana 2.1 about $0.13 and $0.31. Admission reserves a relit look as three edits (the worst case, $0.767 at list prices with a new analysis, and $0.17 more for a first look that will be enhanced; [reservation totals](specs/economics.md#measured-live-costs)) and releases what the job does not use.

### Development-mode limits

With `APP_ENV=development` (the default for Docker and in `.env.example`), six per-owner, per-device and per-IP limits default to generous values so that one person can test without hitting them. Test, staging and production use the specified values.

| Setting | Override in `.env` | Development | Specified |
| --- | --- | --- | --- |
| Accepted looks per owner per 24 hours (`allowance.variants_per_24h`) | `ALLOWANCE_VARIANTS_PER_24H` | 30 | 3 |
| New addresses per owner per 24 hours (`allowance.addresses_per_24h`) | `ALLOWANCE_ADDRESSES_PER_24H` | 30 | 3 |
| Paid render attempts per owner per 24 hours (`quota.attempts_per_owner_24h`) | `QUOTA_ATTEMPTS_PER_OWNER_24H` | 60 | 8 |
| Render requests per device per 24 hours (`quota.render_requests_per_device_24h`) | `QUOTA_RENDER_REQUESTS_PER_DEVICE_24H` | 300 | 6 |
| Render requests per IP per 24 hours (`quota.render_requests_per_ip_24h`) | `QUOTA_RENDER_REQUESTS_PER_IP_24H` | 300 | 6 |
| New anonymous sessions per IP per 10 minutes (`rate.sessions_per_ip_10m`) | `RATE_SESSIONS_PER_IP_10M` | 200 | 20 |

A value set in `.env` always wins over both columns; apply it with `docker compose up -d --force-recreate api workers` (on the host, restart `pnpm dev`). Every other runtime setting is overridden the same way: the setting key upper-cased with dots as underscores, the value as JSON. A value an operator writes through the internal settings API wins over the environment. In live mode these limits are also your spending guard: at the costs above, the 60 paid attempts a day cap the edit and judge spend at about $4 with the default editor and about $5 with Nano Banana 2.1, plus about $0.04 of analysis per render.

### Keeping everything

Time-based deletion is paused (owner decision 2026-11-10): the runtime setting `retention.time_based_deletion` defaults to false, so no project, source or rendering expires by age or inactivity, and the anonymous session lasts 400 days after its last activity. Set `RETENTION_TIME_BASED_DELETION=true` in `.env` and recreate `api` and `workers` to restore the specified schedule ([privacy spec](specs/privacy-safety-legal.md#retention-schedule)). Turning it on is destructive at once: the first retention sweeps (every 15 minutes, up to 200 projects per run) delete every unsaved project that has been idle for more than 24 hours or is older than 7 days, with its photos and looks, and kept sessions older than 7 days end. As a runtime setting (`retention.time_based_deletion`, override `RETENTION_TIME_BASED_DELETION`) it takes effect within the settings cache (`SETTINGS_CACHE_S`, 30 seconds), so turn it on only on a stack whose data you can lose. Deletions that are not time-based (deleting a project or account, opt-out, removed panoramas) work as before, and never-completed uploads still expire after one hour.

### Model bake-off

`pnpm models:bakeoff` decorates the curated example photos with several image models and settings ("arms") through the app's own example path (live Claude scene analysis, the pack's plan, the compiled request, the edit, registration, Claude localization of the added decorations and paste-back; an evening example relights its daylight example), scores every output with the live Claude QA judge, and writes comparison sheets and a cost and quality summary. Its 2026-11-09 run informed the provisional budget defaults above (the D-42 and D-43 entries in the [decision log](decisions.md#decision-log)); rerun it to re-check them when a provider ships a new model. It is live evidence on eight photos, neither the exploratory spike nor the formal benchmark, and never gate evidence ([quality and benchmark](specs/quality-and-benchmark.md#exploratory-spike)); it runs only on the curated example photos. Each arm compiles with the configured request settings (`IMAGE_EDIT_PROVIDER_MASK` above all) and its own quality, size and thinking level, and its cost is priced by the ledger's token price table, the same one that settles real renders.

```bash
pnpm build:packages
pnpm models:bakeoff -- --arms gemini-1k-minimal,gemini-1k-medium,openai-flare-medium,openai-sunburst-high --photos 8
```

| Option | Meaning |
| --- | --- |
| `--arms <list>` | Comma-separated arms; default `gemini-1k-minimal,openai-flare-medium`. `openai-<sunburst\|flare>-<low\|medium\|high\|auto>` runs GPT image 2.5 Sunburst or Flare at that `quality`; `gemini-<1k\|2k>-<minimal\|medium\|high>` runs Nano Banana 2.1 at that size and thinking level. Append `@<model-id>` to run another snapshot with the same settings, for example `openai-flare-medium@gpt-image-2.6-flare` |
| `--photos <n>` | The first n of the eight curated example photos (default 8): three houses (one of them twice, in daylight and in evening light), a living room, a dining room, an apartment entry and a balcony |
| `--out <dir>` | Output folder; default `hailiday-bakeoff-<UTC time>` in the system temp directory. A folder inside the repository is refused |
| `--concurrency <n>` | Renders in flight per arm, 1 to 4 (default 2) |
| `--no-judge` | Skip the Claude judge |
| `--save-raw` | Also keep each raw model output and any mask sent to the provider |

- Each arm sets its provider, model and request parameters for that run only; `.env` and the configuration stay as they are. Address and Street View stay on their fixtures.
- Keys come from `.env` through the same preload as the other host scripts, and the command prints only whether each key is present. An arm whose key is missing is skipped. Without `ANTHROPIC_API_KEY` the plan uses the photo library's measured anchors and outputs are not judged.
- One Claude analysis per photo is shared by every arm. Every arm calls a paid provider: the default run (two arms, eight photos) costs roughly $0.60 in edits, $0.30 in analyses and about $0.036 per judged output, about $1.50 in all.
- Output: `summary.md` (per arm: images that rendered, accepted by the judge, edit and judge cost per image, cost per accepted variant, time, judge codes, failures; then a verdict per photo and arm), `results.json` (every record, including token usage, registration and the judge's scores), `sheet-<example>.jpg` (the before photo and each arm's result, labelled with cost, time and verdict), and one folder per example with `before.jpg` and `<arm>.jpg`.
- Costs use the list prices in the [provider research](research/image-ai-providers.md#pricing) and Claude's prices (Opus 5.5 $4 and $20, Sonnet 5.5 $2 and $10, Haiku 5.5 $0.10 and $0.50 per million input and output tokens). Nano Banana 2.1 publishes only its output price, so its input is costed at $0.50 per million, a small share of the total; its thinking tokens are billed at the output price, which is why a 1K edit costs about 50% more than its image output alone.
- The tests cover the argument parsing, arm resolution, cost math and the report with stand-in models; no test runs the command against a provider.

## Configuration with .env

```bash
cp .env.example .env
```

`.env` is optional: with no file, the defaults in the configuration module apply and everything runs in fixture mode. It is git-ignored; never commit it. `.env.example` documents every variable.

| Where you run | What reads `.env` | Precedence |
| --- | --- | --- |
| `docker compose up` | The `migrate`, `api` and `workers` containers load it. Compose then overrides what must differ inside the Docker network: `DATABASE_URL`, `S3_ENDPOINT`, `SMTP_URL`, `EMAIL_PROVIDER=smtp` and (for `api`) `PORT=8080`. You never edit those for Docker | Your shell variables are not passed into the containers, so provider keys come only from `.env`. Only the values Compose interpolates into its own file (`PUBLIC_BASE_URL`, `S3_PUBLIC_ENDPOINT`, the storage credentials and the published `*_PORT` values) take a shell value over `.env` |
| Host (`pnpm dev`, `pnpm db:migrate`, `pnpm db:storage-init`, `pnpm db:seed`, `pnpm models:bakeoff`, `pnpm tombstones:replay`) | The configuration loader reads the repository's `.env` | A variable already set in your shell wins, except the provider keys (`GOOGLE_MAPS_SERVER_KEY`, `GOOGLE_STREET_VIEW_BROWSER_KEY`, `GOOGLE_STREET_VIEW_SIGNING_SECRET`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`), which come only from `.env`. A key exported in your shell is dropped at startup and the process prints which names it ignored |
| Tests | Nothing: tests never read `.env` | `APP_ENV=test` forces every provider to fixture ([tests](#unit-and-integration-tests)) |

After editing `.env`, recreate the containers that read it: `docker compose up -d --force-recreate api workers`. Values read at release time (bucket CORS, seed data) need `docker compose up migrate` as well.

Published ports are read by Compose only. Change one and keep its paired variable in step:

| Variable | Default | Keep in step with |
| --- | --- | --- |
| `APP_PORT` | 8080 | `PUBLIC_BASE_URL` (magic links, share pages) |
| `DB_PORT` | 5434 | `DATABASE_URL` (host processes) and `DATABASE_URL_TEST` |
| `STORAGE_PORT` | 9000 | `S3_PUBLIC_ENDPOINT` (the browser uploads to and downloads from storage directly through presigned URLs) |
| `STORAGE_CONSOLE_PORT` | 9001 | nothing |
| `MAILPIT_PORT` | 8025 | `HAILIDAY_E2E_MAILPIT_URL` for the browser tests |

## Host development

Use this to edit code with live reload. The database, storage and mail catcher still run in Docker.

1. `pnpm install`.
2. `pnpm docker:infra` starts Postgres, storage and Mailpit only.
3. Prepare the database and buckets once. The simplest way reuses the Docker release job, which runs migrations, bucket setup and the seed against those same services: `docker compose up migrate`. To do it on the host instead, run `pnpm build:packages`, then `pnpm db:migrate`, then `pnpm db:storage-init` (creates both buckets, applies bucket CORS for `STORAGE_CORS_ORIGINS` and the public-read policy on the public bucket), then `pnpm db:seed`. Each step is idempotent.
4. If the full stack is running, stop its app containers first: `docker compose stop api workers`. They would hold port 8080, and a second set of workers on the same database would compete for the same jobs.
5. `pnpm dev` builds `@hailiday/core` and `@hailiday/server`, then runs every package's `dev` script in parallel: the two packages recompile on change, the API and the workers restart on change, and the web app runs on the Vite dev server.

Addresses and ports on the host:

| Process | Address | Notes |
| --- | --- | --- |
| API | http://localhost:8080 (`PORT`) | Also serves `apps/web/dist` if you have run `pnpm --filter @hailiday/web build` |
| Web dev server | http://localhost:5173 | Proxies `/v1`, `/internal` and `/s/` to `HAILIDAY_API_URL` (default `http://localhost:8080`). Set `HAILIDAY_API_URL` in your shell to point it elsewhere |

The magic link written to the API log starts with `PUBLIC_BASE_URL`. If you browse the web dev server, set `PUBLIC_BASE_URL=http://localhost:5173` so the link opens the app you are using; in development and test the default bucket CORS (`STORAGE_CORS_ORIGINS`) already allows `http://localhost:5173`; in staging and production it does not.

You can run a single process with `pnpm api:dev`, `pnpm workers:dev` or `pnpm web:dev`. Changes to `packages/core` or `packages/server` reach the apps through their built `dist` output, which `pnpm dev` keeps rebuilding; if you run an app on its own, run `pnpm build:packages` after changing a package.

### Root scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | `build:packages`, then all package `dev` scripts in parallel |
| `pnpm build:packages` | Builds `@hailiday/core`, then `@hailiday/server` |
| `pnpm build` | Builds every workspace package, one at a time |
| `pnpm typecheck` | `build:packages`, then typechecks every workspace (the web app includes the e2e config) |
| `pnpm test` | `build:packages`, then every workspace's unit and integration tests, one workspace at a time, continuing past failures |
| `pnpm test:e2e` | The Playwright suite against a running stack ([browser tests](#browser-tests)) |
| `pnpm lint`, `pnpm lint:fix` | ESLint over the repository, without or with fixes |
| `pnpm format`, `pnpm format:check` | Prettier over `ts`, `tsx`, `json`, `md` and `yml`, writing or only checking |
| `pnpm db:migrate` | Applies database migrations and installs the queues (needs built packages) |
| `pnpm db:seed` | Seeds capabilities, runtime settings, holiday packs, style kits, the commerce catalog, hero rows and holiday occurrences (needs built packages) |
| `pnpm db:storage-init` | Creates the private and public buckets, applies their CORS and the public-read policy, through the `.env` preload like the other host scripts (needs built packages) |
| `pnpm models:bakeoff` | The model bake-off: live image models compared on the curated example photos, with Claude judging and measured cost; calls paid providers ([model bake-off](#model-bake-off)) (needs built packages) |
| `pnpm tombstones:replay` | The restore step: replays the mirrored deletion tombstones into a restored database ([restore runbook](architecture.md#storage-and-media-delivery)). Takes no arguments (`--help` prints the usage), prints one JSON line of counts and exits 0, 2 for an unknown argument or 1 on failure (needs built packages) |
| `pnpm web:dev`, `pnpm api:dev`, `pnpm workers:dev` | One process's dev script |
| `pnpm docker:up` | `docker compose up --build -d`: the whole stack, detached |
| `pnpm docker:infra` | Postgres, storage and Mailpit only |
| `pnpm docker:e2e` | The browser-test stack: the whole stack with the fixture-forcing override, detached, as its own Compose project (`hailiday-e2e`), so it has its own containers, network and data volumes |
| `pnpm docker:e2e:down` | Stops the browser-test stack and keeps its data |
| `pnpm docker:e2e:reset` | Stops the browser-test stack and deletes only its data volumes; the local stack's data is untouched |
| `pnpm docker:e2e:logs` | Follows the logs of the browser-test stack |
| `pnpm docker:down` | Stops the stack and keeps its data |
| `pnpm docker:reset` | Stops the stack and deletes its data volumes |
| `pnpm docker:logs` | Follows the logs of all services |

The architecture document keeps the [root scripts contract](architecture.md#root-scripts-contract). The server package also has `pnpm --filter @hailiday/server examples:render [exampleId]` ([choosing a provider](#choosing-a-provider)).

## Tests

There is no CI yet: the workflows are planned ([continuous integration and testing](architecture.md#continuous-integration-and-testing)), so nothing runs when you push. Before committing, run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm format:check` by hand, and `pnpm test:e2e` against the browser-test stack when you changed behavior a visitor sees.

### Unit and integration tests

`pnpm test` runs Vitest in each workspace. Pure unit tests need nothing. The integration tests need the Docker services running (`pnpm docker:infra`): Postgres on `localhost:5434` and storage on `localhost:9000`.

- The database is `hailiday_test`, taken from `DATABASE_URL_TEST` (default `postgres://postgres:postgres@localhost:5434/hailiday_test`). Each workspace that needs it drops and recreates it and migrates it from empty at the start of its run, so it never holds anything you want. The name must contain `test`, and it is a different database from `hailiday`, so tests do not touch your local data. Set `DATABASE_URL_TEST` in your shell (tests never read `.env`) if you changed `DB_PORT`.
- Storage-dependent tests use buckets prefixed `test-`, one set per workspace (the names are in `packages/server/src/storage/testing.ts`, `apps/api/src/test/buckets.ts` and `apps/workers/src/test-buckets.ts`). When a workspace's run ends, its global teardown deletes every object from that workspace's test buckets (`emptyTestBuckets`, which refuses any bucket name without the `test-` prefix), so test objects do not pile up in the storage volume. For that reason, run one test run per workspace at a time against the same storage: a second run of the same workspace that ends first would delete the objects the other is still using. A second checkout of the repository, or a concurrent run of the same workspace, that runs its suites at the same time sets `TEST_BUCKET_SUFFIX` (lowercase letters, digits and hyphens, for example `-copy2`) and its own `DATABASE_URL_TEST`, so the two share neither buckets nor a database.
- The server suite's per-test timeout is 60 s (`packages/server/vitest.config.ts`; the api suite's is 120 s and the workers' 90 s). A database test that makes several renders sets a longer limit of its own. The real-queue deadline test (`packages/server/src/pipeline/render/queue-deadline.db.test.ts`) runs a job with a 25 s limit in real time and takes about half a minute.
- Tests build their configuration with `APP_ENV=test` (`testConfig`), which resolves every provider to its fixture even if keys exist, and never call a live provider or any network beyond the local compose services.

To run one workspace: `pnpm --filter @hailiday/server test`.

### Browser tests

The Playwright suite in `apps/web/e2e` (sixteen spec files in fourteen numbered groups: landing, address auto-start, confirm, skip to upload, upload, change look, save by magic link, shop the look, share, allowance, gallery, dusk photo, a look that cannot be finished, an evening look that arrives in daylight; group 05 also has `05-upload-decorated-dining-room.spec.ts` and group 07 also has `07-save-magic-link-cross-browser.spec.ts`) drives a running Docker stack and never starts one itself. `13-unfinished-look.spec.ts` uploads a photo whose name makes the fixture judge refuse every attempt: the page makes one automatic second try, then shows the calm notice, and a reload starts nothing. `14-evening-fallback.spec.ts` uploads a photo whose name carries `relight reject`: the evening look arrives in daylight with one line and one action, and a reload starts nothing.

**Run it only against the browser-test stack.** The suite talks to whatever answers on `http://localhost:8080`, and the normal stack publishes the same port. Against a normal stack that holds real provider keys, `pnpm test:e2e` would make paid address, Street View, vision and image calls and leave its test projects in your local data. Stop the normal stack and start the browser-test stack first, as below; that is the simple way. To keep working on the normal stack meanwhile, move the browser-test stack to its own ports ([beside the normal stack](#beside-the-normal-stack)).

```bash
pnpm docker:down                                           # stop the normal stack (keeps its data); both use port 8080
pnpm docker:e2e                                            # full stack, every provider forced to fixture
pnpm --filter @hailiday/web exec playwright install chromium   # once per machine
pnpm test:e2e
```

- `docker-compose.e2e.yml` sets `APP_ENV=development`, every provider and `TURNSTILE_MODE` to `fixture` and every provider key to empty on `migrate`, `api` and `workers`, so the suite cannot reach a paid provider even when `.env` holds real keys. It also pins the allowance and attempts limits to their specified values and raises the device and IP render-request limits and the session creation limit to 1000, because every test comes from one machine. It pins `STREET_VIEW_CONTRIBUTOR_IMAGERY` to `decorate`, the default, so the contributor-imagery place in the fixtures is confirmed and decorated in the browser specs.
- The suite uses one worker because the specs share one stack and its per-day limits, so the numbered files run one after another in name order. The default per-test timeout is 120 seconds; the allowance spec (group 10) allows 15 minutes.
- Local stacks (this one included) issue the session cookie as `hailiday_session` over plain HTTP; a deployed stack issues it as `__Host-hailiday_session` with `Secure`, so a script that sets the cookie by name must use the name the stack issues. Staging and production (`APP_ENV=staging` or `production`) refuse to start unless `PUBLIC_BASE_URL` uses https (configuration issue `PUBLIC_BASE_URL must use https when APP_ENV=<env> (the session cookie is __Host-prefixed and Secure)`), because browsers keep the `__Host-` Secure session cookie only from a secure origin; local stacks (`development`, `test`) keep plain HTTP.
- Targets: `HAILIDAY_E2E_BASE_URL` (default `http://localhost:8080`) and `HAILIDAY_E2E_MAILPIT_URL` (default `http://localhost:8025/api/v1`, where the save spec reads the magic link). Set them in your shell if you changed ports.
- Output: the HTML report is `apps/web/playwright-report`; traces, screenshots and videos of failures are in `apps/web/test-results`. Both are git-ignored.
- The browser-test stack is its own Compose project (`hailiday-e2e`, set by `name:` in `docker-compose.e2e.yml` and by `-p` in the scripts), so its resets never touch your local data: `pnpm docker:e2e:reset` deletes only the `hailiday-e2e` volumes, and `pnpm docker:reset` deletes only the normal stack's. Both stacks publish the same host ports (8080, 9000, 8025 and the database port) unless you move the browser-test stack's ports ([beside the normal stack](#beside-the-normal-stack)), so otherwise stop one (`pnpm docker:down` or `pnpm docker:e2e:down`, both keep data) before starting the other, and restart the normal stack afterwards with `pnpm docker:up`; its database and storage are as you left them.
- The suite leaves its projects and emails in the browser-test stack. For a clean run, `pnpm docker:e2e:reset` and `pnpm docker:e2e` first.

#### Beside the normal stack

The two stacks are different Compose projects with their own containers and data, so the only thing they share is the host ports. Stopping the normal stack first is the simple way. To keep working on it meanwhile, give the browser-test stack ports of its own and point the suite at them; Compose reads the ports from your shell before `.env`:

```bash
DB_PORT=15434 STORAGE_PORT=19000 STORAGE_CONSOLE_PORT=19001 MAILPIT_PORT=18025 \
APP_PORT=18080 S3_PUBLIC_ENDPOINT=http://localhost:19000 PUBLIC_BASE_URL=http://localhost:18080 \
  docker compose -p hailiday-e2e -f docker-compose.yml -f docker-compose.e2e.yml up --build -d
HAILIDAY_E2E_BASE_URL=http://localhost:18080 HAILIDAY_E2E_MAILPIT_URL=http://localhost:18025/api/v1 pnpm test:e2e
```

`S3_PUBLIC_ENDPOINT` and `PUBLIC_BASE_URL` keep step with the storage and app ports, as in the table under [Configuration with .env](#configuration-with-env). `pnpm docker:e2e:down` and `pnpm docker:e2e:reset` name the project, not the ports, and work as before. A second checkout, or a second test run at the same time, sets `DATABASE_URL_TEST` and `TEST_BUCKET_SUFFIX` so the runs share neither a database nor buckets ([unit and integration tests](#unit-and-integration-tests)).

## Resetting, logs and rebuilding

| Task | Command |
| --- | --- |
| Stop, keep data | `pnpm docker:down` |
| Stop and delete all local data (Postgres, including `hailiday_test`, and storage) | `pnpm docker:reset` (the normal stack only) |
| Stop the browser-test stack, keeping or deleting its own data | `pnpm docker:e2e:down`, or `pnpm docker:e2e:reset` to delete its volumes; your local data is not touched |
| Follow all logs | `pnpm docker:logs` |
| One service's logs | `docker compose logs -f api` (also `workers`, `migrate`, `postgres`, `storage`, `mailpit`) |
| Rebuild after changing code | `docker compose up --build -d` (the images contain the built code, so a restart alone does not pick up edits) |
| Rebuild with no cache | `docker compose build --no-cache`, then `docker compose up -d` |
| Update the third-party images (RustFS and Mailpit use the `latest` tag) | `docker compose pull` |
| Re-run migrations, bucket setup and the seed | `docker compose up migrate` |

## Troubleshooting

- **A port is already in use.** The defaults are 8080, 8025, 9000, 9001 and 5434. A host `pnpm dev` API and the Docker `api` both want 8080: stop one. To move a port, set its variable in `.env` and the paired variable from the [ports table](#configuration-with-env), then recreate the stack.
- **Old behavior after pulling changes.** The containers run images built earlier. Run `docker compose up --build -d`; add `--no-cache` to the build if it still looks stale.
- **`migrate` fails.** `api` and `workers` wait for it, so nothing starts. Read `docker compose logs migrate`. The usual causes are Postgres or storage not yet healthy (wait and re-run `docker compose up migrate`), or a bad value in `.env`: the configuration fails fast and names each problem, for example a live provider selected without its key. Fix `.env`, then `docker compose up -d`. If the schema is damaged, for example after switching between very different branches, `pnpm docker:reset` starts clean.
- **Compose rejects the file.** The `env_file` entry with `required: false` needs Compose 2.24 or later.
- **Uploads or images fail with a CORS error in the browser console.** Bucket CORS allows only the origins in `STORAGE_CORS_ORIGINS` (default `PUBLIC_BASE_URL`, plus `http://localhost:5173` in development and test only), and presigned URLs must point at an address your browser can reach (`S3_PUBLIC_ENDPOINT`). Browsing `http://127.0.0.1:8080` instead of `http://localhost:8080` is a different origin. Open the app at `PUBLIC_BASE_URL`, or add the origin to `STORAGE_CORS_ORIGINS` and run `docker compose up migrate` to apply it.
- **The process says it ignored a key from the shell.** Provider keys on the host are read only from `.env` by design; move the key there.
- **A render never finishes.** Check that `workers` is running (`docker compose ps`) and read `docker compose logs workers`. With host `pnpm dev`, the workers process must be running too, and the Docker `workers` should be stopped.
- **Tests cannot connect.** Run `pnpm docker:infra`, and check `DATABASE_URL_TEST` matches `DB_PORT`.

## Known limitations of fixture mode

Fixture mode proves that every path works end to end. It does not show what the live product looks like or how well it performs.

- **Places are a fixed fictional list.** Only the places in the fixtures README resolve. Any other address returns no suggestions, and real addresses are never looked up.
- **The street photo is not your address.** It is a stock photograph of another house, shown with a photographer credit. The "Street View" in fixture mode is that photograph, panned and zoomed.
- **Decorations are stand-ins, not model output.** They are cut-out photographs placed on measured positions, so perspective, lighting, shadows and fit are rougher than a live image edit, and the same house always gets the same look for the same choices. Some houses have no measured spots for standing items and receive lights, wreaths and garlands only.
- **Evening and bright are grades, not edits.** In fixture mode the evening look is the deterministic relight of the daylight look (the fixture editor's answer to a relight request) and the bright look is a deterministic grade (per channel `v^0.72` with warm gains 1.03, 1 and 0.96); a live relight is an image-editor edit, and the deterministic relights are never delivered for a live editor.
- **The enhancement is a filter, not a redraw.** In fixture mode the fixture editor answers the Street View enhance request with a deterministic unsharp mask and a gentle tone curve of the stand-in photo (`FIXTURE_ENHANCE`), the fixture judge passes it, and the step takes one to two seconds under the label "Sharpening your street photo". It shows the path (the label, the stored picture, the reuse by later looks), not what a live redraw looks like; whether the live judge accepts an enhanced picture can be known only from live runs.
- **Uploads are decorated by rule, not by understanding.** Fixture analysis and judging are scripted: a photo from the shipped library is recognized and decorated at its measured positions, and any other photo gets generic positions for its scene type, so items may not sit on real features. Render outcomes follow the place data and file-name triggers, never the picture.
- **Screening is name-driven.** Fixture content screening detects "people", declines and holds only through the file-name triggers. It says nothing about what a real photo contains. The living-space, scene and people check of an upload is separate: it runs on live Claude whenever `VISION_PROVIDER` is live (even though `SAFETY_PROVIDER` stays `fixture`) and on the file-name scene hints otherwise. A name with no hint now returns no scene type, so the app asks you to choose it; earlier builds pre-selected "A room inside / Living room".
- **Image-quality, cost and latency are not representative.** Quality checks are scripted, no money is spent, and render times are fixture times (the `slow` scenario is a fixed 20 seconds). The benchmark, cost and pilot evidence the plan requires can come only from live runs ([quality and benchmark](specs/quality-and-benchmark.md)); the [model bake-off](#model-bake-off) gives a quick live comparison but is not the benchmark.
- **No real Street View.** Google display, attribution, licensing and coverage behavior can be exercised only with Google keys. Under the default use policy the fixture stand-in photos are decorated like uploads; the Piñon Mesa contributor place is confirmed first and then decorated like the others under the defaults, and is confirmation-only under `STREET_VIEW_CONTRIBUTOR_IMAGERY=display_only` or `STREET_VIEW_USE_POLICY=display_only`.
- **Before and after examples stay hidden** until `examples:render` has produced live renders.
- **Local review mode.** In development and test, renders are delivered without a human reviewer (`review.mode` defaults to `sampled_audit`), unlike the pre-delivery review that staging and production default to ([review mode](specs/render-pipeline.md#lifecycle-state-machines)).
- **Email, bot check and storage are local stand-ins.** Mailpit catches mail, the bot check accepts `fixture-pass`, and RustFS stands in for the production object store.
