# Commerce and markets research

Dated research behind the affiliate commerce direction (D-05): what Amazon and the retail programs actually require, which disclosure rules apply, how seasonal demand behaves, and what later international expansion must check. It records facts and their sources; product behavior lives in the specs linked below.

**Owns:** affiliate program and network facts, disclosure-rule sources, seasonal demand data, international commerce notes, the commerce claims register (CM-01 onward).
**Baseline:** planning baseline 2026-11-09; external facts retrieved 2026-11-08.

## Summary

Hailiday earns revenue through affiliate links on "Shop the look" ([commerce spec](../specs/commerce.md#shop-the-look)). The research changes four assumptions a reader might otherwise make:

1. **Amazon is not an instant, API-backed catalog.** A new Associates account is provisional until three qualifying sales occur within 180 days of applying. The catalog API (Creators API) needs at least 10 qualifying sales in the trailing 30 days. The first catalog is therefore hand-curated. See [Amazon Associates](#amazon-associates).
2. **Decor merchants are spread across several networks.** Impact, CJ, Rakuten, Partnerize, FlexOffers and Sovrn all appear; most rates and cookie windows are third-party claims that must be read from each network dashboard after approval. See [Retail affiliate programs and networks](#retail-affiliate-programs-and-networks).
3. **Disclosure has two layers.** The FTC wants a clear material-connection disclosure close to the recommendation; Amazon separately requires an exact sentence wherever its links appear. See [Disclosure rules](#disclosure-rules).
4. **Demand is seasonal and starts early.** For Halloween, about half of shoppers start in September or earlier; no credible home-decor affiliate conversion benchmark exists, so the pilot measures it. See [Seasonal demand](#seasonal-demand).

Decisions that consume this research: [D-24](../decisions.md#d-24) (product relationships and style kits), [D-25](../decisions.md#d-25) (merchant onboarding and commerce activation), [D-26](../decisions.md#d-26) (advertising disclosure), [D-27](../decisions.md#d-27) (business decision rules). Revenue assumptions that use the rates below are in the [economics spec](../specs/economics.md#revenue-assumptions).

Status labels used in this file: **Verified** (read on a primary page on 2026-11-08), **Third-party** (reported by a secondary source; confirm before relying), **Unverified** (could not be confirmed or sources conflict).

## Amazon Associates

Primary sources (all retrieved 2026-11-08): [application and approval help](https://affiliate-program.amazon.com/help/node/topic/G7MJTPEP9NC3YKMG), [program policies](https://affiliate-program.amazon.com/help/operating/policies), [Operating Agreement](https://affiliate-program.amazon.com/help/operating/agreement), [commission rates](https://affiliate-program.amazon.com/help/node/topic/GRXPHT8U84RAYDXZ), [Creators API introduction](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction), [PA-API 5 deprecation](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation).

| Topic | Fact | Status | Consequence for Hailiday |
| --- | --- | --- | --- |
| Application gate | A new applicant has 180 days from application to refer sales. Three qualifying sales trigger Amazon's review of the account. Without them the application can be withdrawn. A rejected Associates ID cannot be reinstated; a fresh application is needed. | Verified | Amazon is `provisional` (merchant program status) until approval. The application is submitted only when three qualifying sales within 180 days are plausible ([D-25](../decisions.md#d-25)). Timing and the dated decision are in the [onboarding runbook](../specs/commerce.md#merchant-onboarding). |
| Catalog API | PA-API 5 is deprecated and calls return HTTP 403 (AccessDeniedException). Its replacement, the Creators API, requires an enrolled Associate, registration in Associates Central, credentials and at least 10 qualifying sales in the past 30 days. Exact retirement dates were not on the fetched Amazon pages; third-party sources cite 2026-04-30 (migration cutoff) and 2026-05-15 (retirement). | Verified (requirements); Unverified (dates) | A new account has no catalog data. Offers are curated by hand with Associates-generated links and self-written titles and descriptions. API-backed refresh is a later capability gated on granted access. |
| Images and content | Amazon image content may not be stored or cached. Program Content may not be altered (resizing only with proportions kept). Program Content may not be used to develop or improve language, multimodal or other machine-learning models. API access to aggregate or extract content needs prior written approval. The policy page text differed between two fetches of the same URL. | Verified | Amazon images and text are never sent to a renderer and never hosted. Amazon products can only be `similar` or `described` ([product relationships](../specs/commerce.md#product-relationships)). Re-read the live policy before relying on exact wording. |
| Price and availability | A site may show prices and availability only if Amazon serves the link, or the data comes from the Creators API or PA-API. Data from the API or a feed that is not refreshed hourly needs an adjacent date and time stamp. API non-image content may be cached up to 24 hours. | Verified | Without API access, Amazon offers show no price ("Check price at retailer"). A hand-entered Amazon price is not permitted. |
| Required statement | The Operating Agreement requires "As an Amazon Associate I earn from qualifying purchases." to be clearly and prominently displayed. Policy text also requires a notice when Amazon text content is displayed. | Verified | Rendered wherever Amazon links appear ([disclosure](../specs/commerce.md#disclosure)). |
| Standard rates | Fixed standard rates: 3.00% for Home, Home Improvement, Lawn & Garden, Furniture, Toys, Outdoors and Tools; 4.50% Kitchen; 4.00% all other categories. No separate holiday or seasonal-decor rate was on the page. Which rate applies to a given seasonal item is not stated. | Verified (table); Unverified (category mapping) | The economics illustration uses 3% with 4% as an upside case ([economics](../specs/economics.md#revenue-assumptions)). Rates are gross before returns. |
| Tracking identifiers | Amazon help states a cap of 100 tracking IDs per account ([help page](https://affiliate-program.amazon.com/help/node/topic/GJDYPQZK6E37RLPU)). That Amazon links cannot carry a dynamic per-click parameter, and the 24-hour attribution window, are widely reported but were not located on the fetched pages. | Verified (cap); Unverified (rest) | Amazon attribution is per static tracking ID, so per-holiday and per-channel funnel cells map to a bounded set of IDs. See [click tracking](../specs/commerce.md#click-tracking-and-attribution). |

## Retail affiliate programs and networks

Decor merchants are spread across networks, so a small merchant set usually means more than one network account, each with its own approval, link format, reporting and payment threshold. Amazon is off-network.

| Merchant or path | Network (reported) | Rate and window | Status |
| --- | --- | --- | --- |
| Walmart | Impact | "Up to 4%"; eligibility "at its sole discretion" ([Walmart affiliate FAQ](https://affiliates.walmart.com/page/faqs)). Cookie is not stated on the page; third parties report 3 days and roughly 1 to 4% for decor categories. A separate Walmart creator program at up to 18% for home decor appears in one 2026 blog only. | Program existence and "up to 4%" Verified; rest Third-party or Unverified |
| The Home Depot | Impact | Official page returned 403 to the fetcher (page: [Home Depot affiliate program](https://www.homedepot.com/c/SF_MS_The_Home_Depot_Affiliate_Program)). Search results and third parties report a 24-hour US cookie and variable rates around 1 to 8%. | Third-party |
| Lowe's | CJ or FlexOffers (sources conflict) | Very low base rate in either case (roughly 0.8 to 2%; FlexOffers lists 1.6%). | Unverified |
| Target | Target Partners on Impact | About 7-day cookie; home about 5% rising toward 8% with volume (third-party; official FAQ gave no rates). | Third-party |
| Wayfair | CJ (Awin for UK) reported | 5 to 7%, cookie most often 7 days. | Unverified |
| Etsy | Rakuten, per [Etsy help](https://help.etsy.com/hc/en-us/articles/360000335987) | 30-day cookie for affiliates, 7 days for creators and app sales; commission excludes tax, shipping, returns and cancellations; rate not stated (third parties say about 4%, some name Awin, which conflicts with Etsy's page). Items come from individual sellers, a poor fit for curated `similar` matching. | Network and cookie Verified; rate Third-party |
| Michaels | CJ | About 3.2%, 1-day cookie (FlexOffers listing). | Third-party |
| Balsam Hill | Partnerize; also listed on Sovrn Commerce | About 5 to 12%, 30-day cookie reported. | Third-party |
| Grandin Road, Frontgate | CJ (Frontgate also Rakuten) | About 5% reported. | Third-party |
| At Home | FlexOffers | About 2.4%. | Third-party |
| Kohl's | Impact or Sovrn | About 3%, 7-day cookie; the Kohl's page returned 403. | Third-party |
| Christmas Lights Etc | Sovrn Commerce listing | 6.5%, 30-day cookie (aggregator data). | Third-party |

Reading the table:

- If Home Depot is on Impact as reported, Walmart and Home Depot share one Impact account, so Amazon plus both is two systems (Amazon direct and one Impact account).
- Specialist holiday-decor merchants (Balsam Hill, Grandin Road, Frontgate, Christmas Lights Etc) are reported at higher rates than Amazon's 3%. Treat that as a hypothesis. Read actual rates and cookie windows from each network dashboard after approval, and do not rank merchants on unverified rates ([ranking integrity](../specs/commerce.md#ranking-integrity)).
- Sources for third-party rows: [FlexOffers Lowe's](https://www.flexoffers.com/affiliate-programs/lowes-affiliate-program/), [FlexOffers Michaels](https://www.flexoffers.com/affiliate-programs/michaels-stores-affiliate-program/), [Target listing](https://entreresource.com/target-affiliate-program/), [Wayfair listing](https://www.bloggingtips.com/affiliate-programs/wayfair), [Balsam Hill listing](https://affi.io/m/balsam-hill), [Grandin Road listing](https://www.affilitizer.com/programs/grandinroad.com), [Walmart program overview](https://www.nichepursuits.com/walmart-affiliate-program/) (all retrieved 2026-11-08; none is authoritative).

### Aggregators

| Aggregator | What the sources say | Status |
| --- | --- | --- |
| Skimlinks | Merchants arrive through affiliate networks (50+ networks, 48,500 merchants; names AWIN, CJ, Impact, Partnerize, Rakuten) per its [merchant FAQ](https://www.skimlinks.com/insights/how-skimlinks-works-with-merchants-faq/). Revenue share reported as 70/30 in one place and 75/25 in another. A support page reportedly states it has not worked with Amazon since 2020 (page returned 403; snippet only). | Network list Verified; share and Amazon exclusion Unverified |
| Sovrn Commerce | Sites are reviewed individually before approval and need real human clicks on links ([Sovrn approval guide](https://www.sovrn.com/blog/getting-approved-for-commerce/)). No single revenue share is published. Sovrn Amazon support conflicts across sources. | Approval rule Verified; rest Unverified |

Aggregators cover many retail merchants through their underlying networks. They do not replace direct Amazon Associates enrollment and may not cover every named merchant. Evaluate one only after verifying its current revenue share and merchant coverage; the evaluation is a [commerce onboarding](../specs/commerce.md#merchant-onboarding) task.

### Product image and content permissions

Permission to display a product thumbnail or link does not establish permission to send a merchant image to an AI processor or to create, store and distribute modified imagery. Amazon's position is in the table above. For every other program the permission is a separate item to read from the program agreement before any `reference` relationship is considered (a later capability; [D-24](../decisions.md#d-24)).

## Disclosure rules

| Source | What it requires or says | Status | Use in the plan |
| --- | --- | --- | --- |
| [FTC endorsement guides FAQ](https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking) (retrieved 2026-11-08) | Disclose material connections, including affiliate relationships, clearly and close to the recommendation. The phrase "affiliate link" alone may not be understood; "paid link" beside a link is given as an adequate example. | Verified | Label and disclosure line sit adjacent to the shopping content before any click; a footer alone is not enough ([D-26](../decisions.md#d-26)). "Ad" is not the FTC's own example wording. |
| Amazon Operating Agreement | Exact required sentence wherever Amazon links appear (see [Amazon Associates](#amazon-associates)). | Verified | A contractual rule separate from the FTC's. |
| [FTC final rule on fake reviews and testimonials](https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials) | Announced 2024-08-14, published 2024-08-22. It bans fake or AI-generated reviews and testimonials, review buying, undisclosed insider reviews and fake social indicators, with civil penalties for knowing violations. The effective date of 2024-10-21 is computed by secondary sources; the primary Federal Register page was not readable. | Verified (announcement); Third-party (date) | Limited relevance: the US Release shows no user reviews. If merchant ratings, AI-written blurbs framed as reviews or testimonials are ever shown, they must be real. "AI preview" images are not reviews. |

State-level and AI-disclosure laws are tracked in the [privacy spec](../specs/privacy-safety-legal.md#ai-disclosure-and-provenance); this file covers advertising disclosure only.

## Seasonal demand

| Datum | Value | Source | Status |
| --- | --- | --- | --- |
| Halloween 2026 total spend | $13.5 billion | [NRF Halloween survey release](https://nrf.com/media-center/press-releases/nrf-halloween-survey-shows-consumer-spending-expected-to-reach-13-5-billion) (released 2026-09-22; 7,889 consumers surveyed 2026-09-01 to 09-09; retrieved 2026-11-08) | Verified |
| Halloween decorations | 78% of consumers buy decorations; $4.3 billion; second-largest Halloween category; 42% decorate home or yard | Same | Verified |
| Halloween shopping start | 49% plan to start in September or earlier | Same | Verified |
| 2026 holiday retail forecast | $1.013 trillion, up 4.2% (2025: $972 billion); season defined as November 1 to December 31 | [NRF holiday forecast](https://nrf.com/media-center/press-releases/nrf-forecasts-2026-holiday-sales-growth-as-consumers-remain-resilient) (released 2026-10-15) | Verified |
| Winter-holiday shopping start | NRF 2026 holiday survey, released 2026-10-20: 43% plan to start before November (42% in 2025); 8,094 adults surveyed 2026-10-01 to 10-07 | [NRF holiday survey release](https://nrf.com/media-center/press-releases/affordability-shapes-winter-holiday-shopping-according-to-nrf-holiday-survey) (retrieved 2026-11-08) | Verified |
| Winter-holiday decoration spend | No current primary NRF figure found; a 2012 figure is too old to use | n/a | Not established |
| Search interest | Secondary summaries say "christmas lights" interest rises from September to October, peaks in early December and is near zero from February to August | [Accio summary](https://www.accio.com/business/trends_in_christmas_lights), [R-bloggers](https://www.r-bloggers.com/christmas-starts-earlier-every-year-right) | Unverified (shape only; one source is weak) |
| Home-decor affiliate conversion and basket benchmarks | No network-published benchmark found. Weak non-affiliate figures: median home-decor-accessories account average order value $66.09 (middle half $31 to $142); home and furniture e-commerce conversion 0.6 to 1.8% (site conversion, not affiliate click-to-purchase); one analysis puts home-decor affiliate-traffic order value near $192 (date unclear) | Third-party analyses (Syte, Madgicx, Razorpay) | Unverified |

What this means for operation:

- Halloween decor shoppers begin in September, which is why the commerce window default starts September 1; the windows and their validation against merchant shipping cut-offs belong to the [seasonal commerce calendar](../specs/commerce.md#seasonal-commerce-calendar). Promotion windows are in [Windows and selection](../specs/holidays-and-content.md#windows-and-selection).
- Winter-holiday shopping starts early: 43% of holiday shoppers plan to start before November, before the Thanksgiving and Christmas promotion windows open. That is why the commerce windows for Thanksgiving and Christmas start earlier than the hero windows; their exact start dates remain defaults to validate against merchant shipping cut-offs in the [seasonal commerce calendar](../specs/commerce.md#seasonal-commerce-calendar).
- Because no conversion benchmark exists, the funnel rates in the [economics spec](../specs/economics.md#revenue-assumptions) are assumptions that the pilot replaces with measured rates ([D-27](../decisions.md#d-27)).
- Search-interest curves should be pulled directly from Google Trends before the editorial calendar relies on them.

## International notes

International expansion is later work ([D-02](../decisions.md#d-02); boundaries in [architecture](../architecture.md#international-extension-boundaries)). Nothing here is needed for the US Release. What later work must check:

| Topic | Fact | Source | Status |
| --- | --- | --- | --- |
| UK advertising rules | The UK Advertising Standards Authority publishes specific guidance on affiliate marketing. | [ASA affiliate marketing guidance](https://www.asa.org.uk/resource/affiliate-marketing.html) | Page not re-read on 2026-11-08 (Unverified) |
| EU consumer rules | The European Commission's Influencer Legal Hub treats affiliate marketing as commercial content requiring disclosure. | [Influencer Legal Hub](https://commission.europa.eu/topics/consumers/consumer-rights-and-complaints/influencer-legal-hub_en) | Same caveat |
| Data transfers | The EDPB guide to international data transfers is the reference for transfer mechanisms when image and address data reach providers outside the EEA. | [EDPB guide](https://www.edpb.europa.eu/sme/be-compliant/international-data-transfers_en) | Same caveat |
| Google terms by billing address | Google's non-EEA Service Specific Terms apply when the customer's billing account address is outside the EEA; the EEA versions apply when it is in the EEA (effective 2025-07-08). The searched property's country does not decide this. | [Google Maps Platform terms](https://cloud.google.com/maps-platform/terms) (retrieved 2026-11-08); see [Google Maps Platform terms](address-and-imagery.md#google-maps-platform-terms) | Verified |
| Merchant programs | An Amazon Associates enrollment does not cover other marketplaces; each merchant and market needs its own program record, currency and destination coverage. | Not checked against program pages on 2026-11-08 | Unverified |

Later-market commerce reuses the offer and merchant-program model; it adds records and market-specific disclosure review rather than redesigning products or render associations.

## Claims register

Each row is a claim another document may rely on. "Re-check" says when a reader should confirm it again; a stale or failing claim is reported to the owner of the decision that depends on it.

| ID | Claim | Source | Status | Re-check before |
| --- | --- | --- | --- | --- |
| CM-01 | Amazon applicants have 180 days to refer sales; three qualifying sales trigger review; otherwise the application can be withdrawn; a rejected ID cannot be reinstated | Amazon [application help](https://affiliate-program.amazon.com/help/node/topic/G7MJTPEP9NC3YKMG) | Verified | Submitting the Amazon application ([D-25](../decisions.md#d-25)) |
| CM-02 | The Creators API requires enrollment and at least 10 qualifying sales in the trailing 30 days | [Creators API introduction](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction) | Verified | Any API-backed catalog work |
| CM-03 | PA-API 5 is deprecated and returns HTTP 403 | [Deprecation page](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation) | Verified | n/a |
| CM-04 | PA-API 5 migration and retirement dates are 2026-04-30 and 2026-05-15 | Third-party sources | Unverified | Not needed unless dates matter |
| CM-05 | Amazon images may not be stored or cached; Program Content may not be altered or used to develop or improve models | Amazon [program policies](https://affiliate-program.amazon.com/help/operating/policies) | Verified (page text varied between fetches) | Commerce activation ([D-25](../decisions.md#d-25)) |
| CM-06 | Amazon prices may be shown only when Amazon serves the link or the data comes from the Creators API or PA-API; a timestamp is needed when not refreshed hourly | Amazon program policies | Verified | Commerce activation |
| CM-07 | Required sentence: "As an Amazon Associate I earn from qualifying purchases." | Amazon [Operating Agreement](https://affiliate-program.amazon.com/help/operating/agreement) | Verified | Commerce activation |
| CM-08 | Amazon standard rates: 3.00% Home, Home Improvement, Lawn & Garden, Furniture, Toys, Outdoors, Tools; 4.50% Kitchen; 4.00% other categories; no seasonal-decor rate listed | Amazon [rate page](https://affiliate-program.amazon.com/help/node/topic/GRXPHT8U84RAYDXZ) | Verified | Each revenue review ([D-27](../decisions.md#d-27)) |
| CM-09 | Amazon allows 100 tracking IDs per account | Amazon [help](https://affiliate-program.amazon.com/help/node/topic/GJDYPQZK6E37RLPU) | Verified | Designing attribution cells |
| CM-10 | Amazon links carry no per-click parameter and use a 24-hour window | Widely reported | Unverified | Confirm in Associates Central |
| CM-11 | Walmart is on Impact, pays "up to 4%", with eligibility at its sole discretion | [Walmart FAQ](https://affiliates.walmart.com/page/faqs) | Verified (cookie not stated) | Applying to Walmart |
| CM-12 | Home Depot is on Impact with a 24-hour cookie and 1 to 8% rates | Third-party; official page returned 403 | Third-party | Reading the Impact dashboard after approval |
| CM-13 | Etsy's affiliate program is run through Rakuten; cookie 30 days (affiliates), 7 days (creators and apps) | Etsy [help](https://help.etsy.com/hc/en-us/articles/360000335987) | Verified | Applying to Etsy |
| CM-14 | Specialist decor merchants (Balsam Hill, Grandin Road, Frontgate, Christmas Lights Etc) pay about 5 to 12% with 30-day cookies | Third-party listings | Unverified | Ranking or shortlisting any merchant |
| CM-15 | Target, Wayfair, Michaels, Kohl's, At Home, Lowe's rates and networks as in the table above | Third-party listings | Unverified | Applying |
| CM-16 | Decor merchants are spread across Impact, CJ, Rakuten, Partnerize, FlexOffers and Sovrn | Table above | Mixed (Etsy and Walmart verified; others third-party) | Planning network applications |
| CM-17 | Skimlinks merchants come through affiliate networks; revenue share 70/30 or 75/25; no Amazon since 2020 | Skimlinks [FAQ](https://www.skimlinks.com/insights/how-skimlinks-works-with-merchants-faq/) and search snippets | Network list Verified; rest Unverified | Evaluating an aggregator |
| CM-18 | Sovrn Commerce reviews sites individually and needs real human clicks | Sovrn [guide](https://www.sovrn.com/blog/getting-approved-for-commerce/) | Verified | Evaluating an aggregator |
| CM-19 | FTC: disclose material connections clearly and close to the recommendation; "affiliate link" alone may not be understood; "paid link" is adequate | FTC [endorsement guides FAQ](https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking) | Verified | Disclosure copy review ([D-26](../decisions.md#d-26)) |
| CM-20 | FTC final rule on fake reviews announced 2024-08-14 and published 2024-08-22; effective 2024-10-21 (computed) | FTC [press release](https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials) | Verified (announcement); Third-party (date) | Showing any ratings or testimonials |
| CM-21 | NRF 2026 Halloween: $13.5 billion total, $4.3 billion decorations, 49% start in September or earlier | NRF [release](https://nrf.com/media-center/press-releases/nrf-halloween-survey-shows-consumer-spending-expected-to-reach-13-5-billion) | Verified | Each season's window review |
| CM-22 | NRF 2026 holiday forecast: $1.013 trillion, up 4.2%; season November 1 to December 31 | NRF [release](https://nrf.com/media-center/press-releases/nrf-forecasts-2026-holiday-sales-growth-as-consumers-remain-resilient) | Verified | Each season's window review |
| CM-23 | NRF 2026 holiday survey (released 2026-10-20): 43% of holiday shoppers plan to start before November (42% in 2025) | NRF [release](https://nrf.com/media-center/press-releases/affordability-shapes-winter-holiday-shopping-according-to-nrf-holiday-survey) | Verified | Setting the Thanksgiving and Christmas commerce windows |
| CM-24 | No credible home-decor affiliate conversion or basket benchmark exists | Searches 2026-11-08 | Not established | Pilot evaluation replaces it with measured data |
| CM-25 | Search-interest seasonality shape for decor terms | Secondary summaries | Unverified | Pull Google Trends directly |
| CM-26 | Google's EEA versus non-EEA terms follow the billing account address | Google Maps Platform terms | Verified | Opening the Google billing account |
| CM-27 | ASA, European Commission and EDPB pages exist as the later-expansion references | URLs in [International notes](#international-notes) | Unverified (content not re-read) | Starting any international work |
