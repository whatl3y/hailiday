# Retailer catalogs research

Dated research on how Hailiday could show real products from The Home Depot, Costco, Walmart, Target and Lowe's in Shop the look, let visitors choose among them and earn commission when they buy, together with the route this evidence supports. It records facts, sources and a proposal. It owns no product rule: what the owner accepted of the proposal on 2026-11-17 lives in the decision register, the commerce spec and the backlog ([proposal](#proposal)).

**Owns:** product-data and affiliate-link facts for the five named retailers; Impact partner API facts; facts on the aggregators and data services that could supply retailer products; the comparison of routes; the proposal for real retailer catalogs (its first build step accepted on 2026-11-17; the rest not in force); the retailer-catalog claims register (RC-01 onward).
**Baseline:** external facts retrieved 2026-11-17; code and specifications as committed on that date.

## Summary

The question, asked by the owner on 2026-11-17: what is the best, most efficient and most cost-effective way to get at the catalogs of The Home Depot, Costco, Walmart, Target and Lowe's, so that visitors can select real items and optionally buy them through affiliate links. Today every program, product and offer in Shop the look is an example ([what exists today](#what-exists-today)).

1. **Only a retailer's own affiliate program supplies product data that may be shown.** Every retailer whose terms could be read bars collecting data from its site, and Walmart's affiliate terms allow a price "only if such information is provided to you by Walmart". The sanctioned source is the feed or catalog a program gives the affiliates it has accepted. See [what each retailer offers](#what-each-retailer-offers).
2. **That source is confirmed for one retailer of the five.** Walmart's is confirmed on Walmart's own pages. Target's and The Home Depot's are reported by third parties. Lowe's has none that could be found. No program that pays on Costco merchandise could be found either.
3. **One free integration can serve three of them.** Walmart, Target and (as reported) The Home Depot run on Impact, whose partner API searches product catalogs at no charge. Each catalog item already carries a link that credits the partner, and a click can add its own sub-ID to it. Catalog access by API has to be enabled, and a brand can withhold its catalog from a partner it has accepted. See [the Impact partner API](#the-impact-partner-api).
4. **"The full catalog" is the wrong unit.** Shop the look needs only the seasonal items that match the decorations in a picture. Rules can find candidate items in a program's catalog; a person has to approve each one before it shows, because the fields a catalog carries cannot prove a match or keep child-directed items out. See [finding, approving and refreshing items](#finding-approving-and-refreshing-items).
5. **Commission from these five does not pay for data, and is small beside the cost of rendering.** The Home Depot pays 1% on most products with a 1-day cookie, Lowe's paid 0% for part of 2026, Walmart pays at most 4% and no Costco program was found that pays on merchandise. Paid data from unofficial services costs about $99 to $198 a month and breaks the retailers' terms. See [economics](#economics).
6. **Nothing here can reach a visitor or earn in the 2026 season.** The app is not public, and the Christmas commerce window closes on 2026-12-18. The next windows open on 2027-09-01 (Halloween) and 2027-10-15 (Thanksgiving and Christmas). One thing does expire now: the Christmas range in the retailers' catalogs, which is the only real data the search rules can be tried against before autumn 2027. See [calendar](#calendar).
7. **The owner's work sets the date, not the build.** A public site, the applications, each agreement read and each written answer chased come before any tracked click, and all of it falls to one person. See [the owner's work, in order](#the-owners-work-in-order).

The route these findings support is in [the proposal](#proposal). Amazon, which the owner asked about afterwards, fits it as a links-only retailer ([Amazon](#amazon)). Decisions that would consume this research: [D-24](../decisions.md#d-24) (product relationships and style kits), [D-25](../decisions.md#d-25) (merchant onboarding and commerce activation) and [D-27](../decisions.md#d-27) (business decision rules). Earlier evidence on the same programs, retrieved 2026-11-08, is in the [commerce and markets research](commerce-and-markets.md#retail-affiliate-programs-and-networks); for the five retailers named here this file is the later reading.

Status labels used in this file: **Verified** (the organization's own page was read on 2026-11-17), **Third-party** (a secondary source, or a search-engine excerpt of an official page that would not load), **Unverified** (sources conflict or nothing confirms it).

## Method and limits

- Eight research passes (one per retailer, one each for networks, aggregators and unofficial data services) and an independent re-check of their claims on the same day. Where the passes disagreed, the re-check's reading is the one recorded here. A further reading of Impact's own documentation that day supplied the facts on item links, sub-IDs, API access and the fuller limits.
- Pages were read through a fetch tool that returns a model's reading of the page, so quoted words are as that tool returned them and long sentences may be shortened.
- Unreadable on the day: every homedepot.com and lowes.com page (HTTP 403), walmart.io (HTTP 456), Walmart's site terms (bot check), partners.target.com, developer.lowes.com and developers.cj.com (the pages did not render).
- Several affiliate blogs stamp the current date automatically. Their "updated" dates are not evidence of freshness.
- Readings of contract terms are not legal advice; counsel to confirm before any term is relied on.

## What exists today

Shop the look works end to end in `fixture` mode with example data: six programs with fictional names, 50 products in our own words and 63 offers pointing at `example.com` ([offers and lifecycle](../specs/commerce.md#offers-and-lifecycle)). A card is one kit item the plan placed, with one offer, a text title of our own, no image, and a price only when the offer's source permits it ([card content](../specs/commerce.md#group-and-option-content)). What real retailer catalogs would need and the code does not have:

| Missing | Where it would attach |
| --- | --- |
| A client for any feed or catalog API | A new adapter beside the existing ones in `packages/server/src/providers`, with `fixture` and live modes |
| A way for offers to arrive other than from content files at seed time | The scheduled jobs `offer_verification` and `affiliate_report_import` exist but import nothing |
| A match from a retailer's item to a kit item | Products are written by hand; nothing scores or stores candidate items |
| Retailer name for the product, image, brand or product code on a card | The card schema and the `products` and `offers` tables have no such fields; `content_rights` is stored and never read |
| More than one option per decoration | The candidate offers of a card are recorded in `render_product_links.candidate_offer_ids` and never returned |
| Links made through a network's API | Only a URL template is filled; the `api` link method has no code path |
| Imported conversions and any operator tooling for products and offers | The import function has no caller; the internal API has no route to create or edit a product or an offer and none for conversions |
| Cards for the lavish tier's extra decorations | Curtain lights, net lights, trunk wraps, lit reindeer, gift boxes, path stakes and ornament clusters are in the [lavish description](../specs/holidays-and-content.md#the-lavish-description) and in no kit; the house exterior kit is at its limit of six items |
| Any way to change a program, an offer or a kit item outside development | Content is inserted once and never updated outside a local environment; the internal API can set a status and record a manual check, and cannot otherwise edit a program or an offer |
| A category illustration for a card without a picture | The [card rule](../specs/commerce.md#group-and-option-content) names one; the web app has none |

## What each retailer offers

| Retailer | Product data for an accepted affiliate | Links and commission | Limits | Status |
| --- | --- | --- | --- | --- |
| Walmart | Data feeds through the Affiliate Member Center on Impact: "access to the Affiliate Member Center, where you can get more banners, generate links and get data feeds" ([program page](https://affiliates.walmart.com/)). Fields, size, format, refresh rate and whether the catalog is reachable through Impact's API show only after acceptance. A separate affiliate API exists on [walmart.io](https://walmart.io/apidocs/affiliates/quickstart); the portal blocked automated reading, so its access rules and terms are unread here, though a search excerpt of its quickstart describes a self-serve sign-up (log in with a Walmart.com account, create an application, upload a public key). A person can read it in a browser. | Tracking links through Impact to item, category and department pages and "anything on Walmart.com"; "up to 4%" per eligible sale ([FAQ](https://affiliates.walmart.com/faqs)). Category rates are unpublished; the terms name no cookie length (3 days per a third party); payment follows about 90 days after month end ([terms](https://affiliates.walmart.com/terms)). | [Walmart terms that reach Shop the look](#walmart-terms-that-reach-shop-the-look). | Verified, except the cookie (Third-party) and the walmart.io API (Unverified) |
| Target | A data feed is listed for Target Partners by the agency that manages the program ("Data Feed: Yes", [agency listing](https://accelerationpartners.com/affiliate-programs/target)). No Target page confirms it. | Target Partners on Impact; a search excerpt of [Target's partner FAQ](https://partners.target.com/faqs) describes it as for family-friendly sites with mainly US viewers. 1% to 8% and a 7-day cookie per the agency listing, with rates said to be set per agreement. The program retired in May 2026 was the separate creator program ([report](https://creatorflow.so/blog/target-creator-program/), updated 2026-10-30). | Target's [site terms](https://www.target.com/c/terms-conditions/-/N-4sr7l) (last updated 2026-09-10) bar commercial use of listings, prices and images, scraping, building a database from site content and any agent outside a named list ("Target's AI Shopping Assistant, OAI, Google and Microsoft"). No carve-out for affiliates was found; the affiliate agreement can be read only after acceptance. | Third-party (program, feed, rates); Verified (site terms) |
| The Home Depot | "Up-to-date data feeds along with a wide variety of banner ads and text links" are promised on the [program page](https://www.homedepot.com/c/SF_MS_The_Home_Depot_Affiliate_Program) (search excerpt; the page returned 403). No official API was found. | Reported on Impact; one [tracker](https://www.affilitizer.com/programs/homedepot.com) shows the Impact listing removed on 2026-08-17 while articles from September and October 2026 still name Impact. 1% on most products and 8% on "HD Home" products (a [reseller listing](https://www.flexoffers.com/affiliate-programs/home-depot-affiliate-program) shows 80% of each); nothing shows holiday decor in the 8% tier. 1-day cookie; the 30-day figure belongs to the separate Installation program. | No Home Depot term could be read. The [Creator Portal](https://corporate.homedepot.com/news/company/new-home-depot-creator-portal-connects-influencers-home-improvement-enthusiasts) launched 2025-12-10 serves social creators and offers no data API. | Third-party |
| Lowe's | None confirmed. The [Developer Hub](https://developer.lowes.com/portal) is a portal for contracted business partners, not a source for affiliates. | An affiliate program on CJ or on Impact: a [sign-up link](https://geniuslink.com/blog/lowes-affiliate-program/) from May 2026 leads to CJ, other sources say Impact, and FlexOffers resells it at 80% ([listing](https://www.flexoffers.com/affiliate-programs/lowes-affiliate-program/), 2026-02-01: "1.6% of online sale"). About 1% to 2% with a 1-day cookie. One publisher reports that Lowe's "dropped our affiliate rate to 0% for the remainder of the quarter" in 2026 ([report](https://toolguyd.com/lowes-links-broken-2026/), search excerpt); the current rate is unknown. | Terms unreadable. | Unverified (network, rate, cookie); Third-party (the rate cut) |
| Costco | None. | No program that pays on merchandise was found, and Costco publishes nothing about one. A membership referral pays "$3.20 – $6.40 depending on the membership type" with a 1-day cookie on a [reseller listing](https://www.flexoffers.com/affiliate-programs/costco-membership-affiliate-program/) (2026-07-31). | The [terms of use](https://www.costco.com/terms-and-conditions-of-use.html) (last updated 2026-10-07) bar "data mining, robots, agents or similar data gathering or extraction methods". Non-members pay a "5% surcharge over posted prices" ([Costco help](https://customerservice.costco.com/app/answers/answer_view/a_id/1155/~/why-am-i-being-charged-a-non-member-surcharge)) and, as reported, cannot see or buy member-only items. The terms grant no license to "copy, imitate or use Costco's trademarks"; counsel to confirm before the name is used on a link. | Verified (terms, surcharge, trademark clause); Third-party (the absence of a merchandise program, the reseller listing, member-only items) |

### Walmart terms that reach Shop the look

Walmart's affiliate agreement ("Last updated June 2026", [terms](https://affiliates.walmart.com/terms)) is the only affiliate agreement of the five that could be read. Status: Verified, with section 25 partly paraphrased by the fetch tool.

| Term as read | Consequence for Hailiday |
| --- | --- |
| A price may be shown "only if such information is provided to you by Walmart", updated "within 24 hours of any update of such product information"; "the price listed on the Site will govern" | A Walmart price comes only from Walmart's own feed or API and is refreshed at least daily. The existing display rule (a price shows only when observed within 24 hours, with its time) already fits ([price display policy](../specs/commerce.md#price-display-policy)). |
| No "price tracking and/or price alerting functionality" | No price history, price-drop notices or saved-price comparisons. |
| No scraping or spidering of the site "for content (such as images, logos or text)" | Already the rule: Hailiday never fetches merchant pages ([verification cadence](../specs/commerce.md#verification-cadence)). Data bought from a scraping service is the same breach at one remove. |
| Product images only where "expressly and specifically provided by Walmart for use in the Program" | Images from Walmart's feed only, unaltered. **Verify:** whether feed image URLs are licensed for display on an affiliate's page, with Walmart on acceptance (commercial owner). |
| The affiliate may not "re-distribute, display or syndicate Licensed Materials and/or Walmart's datafeed ... to any third party partner, network or agency" | Feed data stays inside Hailiday. Whether a model provider that reads item text counts as a third party is unanswered, so no model reads it ([what a visitor would see](#what-a-visitor-would-see)). |
| AI-made content "must be truthful, accurate, and not misleading"; "All claims, images, and descriptions must match the actual product"; no "dupe" wording | The decorated picture is never presented as showing a Walmart product. The relationship label stays "Similar item" ([product relationships](../specs/commerce.md#product-relationships)). Whether that satisfies the clause needs Walmart's written view. |
| AI-made content is to be reviewed before it is posted | Each picture is made for one visitor and, outside review mode, shown without a person's review. Whether the clause reaches such a picture is part of the same written question. |
| Walmart's word marks in title case, less prominent than the affiliate's own brand and never beside "percent off", "sale" or "coupons"; logos only "in the form, orientation, and colors supplied by Walmart" | The retailer is named in plain text, as the card rule already says, with no logo and no sale wording beside the name. |
| The license is revocable "for any reason"; rates may change "at any time, without notice"; sales from natural-search traffic and from browsers that block cookies earn nothing | No plan may depend on one program staying available or on a rate. |

## The Impact partner API

| Fact | Status | Source |
| --- | --- | --- |
| Endpoints for a partner account: list catalogs (`GET /Mediapartners/{AccountSID}/Catalogs`), read one, list a catalog's items (`/Catalogs/{CatalogId}/Items`), read one item (`/Catalogs/{CatalogId}/Items/{Id}`) and search items across "all available catalogs" (`/Catalogs/ItemSearch`) by keyword and by a filter such as `CurrentPrice > 50`, 100 results a page by default. "Available" is not defined. | Verified | [Search catalog items](https://integrations.impact.com/impact-publisher/reference/search-catalog-items) |
| An item carries `Name`, `Description`, `Url`, `ImageUrl`, `AdditionalImageUrls`, `CurrentPrice`, `OriginalPrice`, `StockAvailability`, `Gtin`, `Mpn`, `Category`, `SubCategory`, `Manufacturer`, `Colors`, `Bullets` and `ExpirationDate`. It has no last-updated field; only the catalog has `DateLastUpdated`. | Verified | [Catalog item object](https://integrations.impact.com/impact-publisher/reference/the-catalog-item-object-1) |
| Published limits per hour: 3,000 shared by item search and the listing of one catalog's items; 1,000 for catalog lists; 500 for `/Actions` and `/Clicks`; 250 for other reports; 1,000 for every other endpoint. Over a limit the API answers 429. | Verified | [Rate limits](https://integrations.impact.com/impact-publisher/reference/rate-limits) |
| "Accessing product catalogs via API is an advanced feature that requires enabling API access." No account tier is named. | Verified | [Download product catalogs as a partner](https://help.impact.com/partner/what-would-you-like-to-learn-about/platform-features/marketing-content/product-marketplace-and-catalogs/download-product-catalogs-as-a-partner) |
| Catalogs can also be downloaded whole from the dashboard (files under 3 GB, compressed) or by FTP; brands are "advised to update their catalogs daily". | Verified | [Download product catalogs as a partner](https://help.impact.com/partner/what-would-you-like-to-learn-about/platform-features/marketing-content/product-marketplace-and-catalogs/download-product-catalogs-as-a-partner) |
| A brand can "restrict which partners can access this product catalog". Acceptance into a program therefore does not guarantee its catalog. | Verified | [Add product catalogs as a brand](https://help.impact.com/brand/what-would-you-like-to-learn-about/platform-features/product-catalogs/add-product-catalogs-as-a-brand) |
| A catalog item's `Url` is the "Tracking URL for the product page, unique to your partner account", so an item needs no call to get its link. | Verified | [Catalogs reference](https://integrations.impact.com/partner-api-reference/reference/catalogs/catalogs) |
| A sub-ID is added to a tracking link as a query parameter (`subId1`) and "appears only in partner reporting". A `u` parameter deep-links to another page, which "must be a domain and path permitted by the brand". | Verified | [Add reporting information to your tracking links](https://help.impact.com/partner/what-would-you-like-to-learn-about/platform-features/tracking/tracking-links/create-and-manage-links/add-reporting-information-to-your-tracking-links) |
| A sub-ID is alphanumeric and at most 255 characters. | Third-party (search summary of Impact help) | [Sub ID and Shared ID parameters](https://help.impact.com/partner/what-would-you-like-to-learn-about/platform-features/tracking/tracking-links/link-parameters/sub-id-and-shared-id-parameters-explained-for-partners) |
| Links can also be created by API (`POST /Mediapartners/{AccountSID}/Programs/{ProgramId}/TrackingLinks`, with a deep link and `subId1` to `subId3`); an account may hold at most 5,000 vanity links. | Verified | [Create a tracking link](https://integrations.impact.com/impact-publisher/reference/create-a-tracking-link); [Tracking links reference](https://integrations.impact.com/partner-api-reference/reference/tracking-links/tracking-links) |
| Joining Impact as a partner is free; no fee for API use appears in any page read; a verified property improves the odds of approval in Impact's marketplace. | Verified | [Sign up as a partner](https://help.impact.com/partner/what-would-you-like-to-learn-about/getting-started/sign-up-as-a-partner-on-impactcom) |
| Conversions: `GET /Mediapartners/{AccountSID}/Actions` "Returns a list of actions attributed to you", each with the `SubId1` and `SharedId` of the winning click. Date filters were read only on the brand-side page. | Third-party (search excerpt; the page itself returned "Page Not Found") | [Actions](https://integrations.impact.com/partner-api-reference/reference/actions/actions) |

## Other sources examined

### Other networks

CJ documents a product-feed API (a GraphQL endpoint at `https://ads.api.cj.com/query`) open to publishers joined to an advertiser; its reference pages did not render, so every detail is Unverified ([CJ reference](https://developers.cj.com/graphql/reference/Product%20Feed)). It matters if Lowe's turns out to be on CJ and shares a feed, and for the specialist decor merchants the [earlier research](commerce-and-markets.md#retail-affiliate-programs-and-networks) reports on CJ. FlexOffers resells several of these programs and, on the listings read, passes on 80% of the retailer's rate.

### Aggregators and universal product APIs

| Service | What it offers | What rules it out as the main route | Status |
| --- | --- | --- | --- |
| Channel3 | One search API with prices, availability and offers; product-data pages for all five retailers. 1,000 free credits a month, then $0.007 a call ([pricing](https://channel3.ai/docs/pricing)). | It keeps 50% of each commission ([commissions](https://channel3.ai/docs/commissions)). Its terms (effective 2026-11-02) forbid to "Cache, store, or redistribute a significant portion of the Channel3 product catalog or Customer Output" and to use output to train or improve a model ([terms](https://channel3.ai/terms)), so every panel means live calls. No page says the retailers license the data, which leaves Walmart's "provided to you by Walmart" rule unmet. Its commission page names only The Home Depot of the five and says "A retailer being listed here does not mean every offer is commissionable." 11 of 12 Costco samples were priced in Canadian dollars. | Verified |
| Sovrn Commerce | Turns ordinary merchant links into paid ones after a per-site approval; a product-data API returns price, stock and images for a product URL at 20 requests a second ([reference](https://developer.sovrn.com/reference/prod-data-api)). | The API takes a URL, not a search, so it cannot find products. Revenue share is unpublished and coverage of the five is unconfirmed ([Sovrn Commerce](https://www.sovrn.com/commerce/)). | Verified |
| Skimlinks | Link monetization; product data ("Product Key", Merchant API). | Product data is for managed publishers only. | Third-party |
| Rye, Shopify Catalog | Product search and checkout APIs. | Rye's product sync covers Shopify and Amazon merchants only, and Shopify's catalog covers Shopify merchants ([Rye pricing](https://rye.com/pricing); [Shopify Catalog](https://shopify.dev/docs/agents/catalog)). | Verified |
| Agent shopping protocols (UCP, ACP) | Open specifications; Walmart and Target co-developed UCP, The Home Depot and Lowe's endorse it, Costco is absent ([UCP](https://ucp.dev/)). | No independent app has a working route: "businesses retain full control over their access policies", `/.well-known/ucp` returned 404 on target.com and walmart.com, and neither protocol carries a commission ([UCP overview](https://ucp.dev/latest/specification/overview/); [ACP](https://www.agenticcommerce.dev/)). | Verified |

### Unofficial data services

Every service below collects retailer pages without the retailer's consent and leaves compliance to the buyer.

| Service | Coverage and list price | Status |
| --- | --- | --- |
| Traject Data | A separate API per retailer: Walmart, Target and The Home Depot at $18 to $23 a month for 500 requests or $66 for 10,000, each billed annually, so three retailers at the 10,000 tier is about $198 a month; no Lowe's or Costco ([Walmart](https://trajectdata.com/pricing/bluecart-api), [Target](https://trajectdata.com/pricing/redcircle-api), [The Home Depot](https://trajectdata.com/pricing/big-box-api)). Its terms allow use "solely for your personal use" ([terms](https://trajectdata.com/traject-data-terms-of-service/), effective 2025-11-18). | Verified (prices, terms); the per-retailer reading is an inference |
| Unwrangle | All five; $99 a month for 100,000 credits ([site](https://www.unwrangle.com/)). Its terms pass the retailers' terms to the buyer ([terms](https://www.unwrangle.com/tos/)). | Verified |
| Bright Data | 5,000 free records a month, then $1.50 per 1,000 ([pricing](https://brightdata.com/pricing/web-scraper)); scrapers for Walmart, Lowe's and Costco confirmed. | Verified |
| SerpApi | Search engines for The Home Depot and Walmart; $25 a month for 1,000 searches, $75 for 5,000 ([pricing](https://serpapi.com/pricing)). | Verified |

The retailer terms that could be read ban this collection (Target, Costco, and Walmart's affiliate agreement for its affiliates); Walmart's site terms and the terms of The Home Depot and Lowe's would not load. The practical risks, in order: termination of the affiliate account and reversal of commissions, a cease-and-desist letter, loss of data when the service is blocked, and copyright claims over product photographs. Counsel to confirm.

## What can only be learned after acceptance

Owner of every check in this table: the operations and commercial lead, which today is the product owner.

| Program | Facts to read from the dashboard or ask in writing |
| --- | --- |
| Walmart | Commission by category for decor and lighting; cookie length; feed fields, size, format and refresh; whether feed images are licensed for display; whether the catalog is shared through Impact's API; Walmart's written view on products shown beside an AI-made picture. |
| Target | Whether a new, small site is accepted; rates and exclusions in the agreement; whether the catalog is shared, with its fields and item count; every rule on images, prices, storing and AI. |
| The Home Depot | Whether the program can still be joined on Impact; all program policies; whether holiday decor earns 8% or 1%; feed fields and item count; whether deep links are permitted. |
| Lowe's | The current rate; the cookie; whether any feed or link tool exists; the agreement. |
| Costco | Whether links to product pages are even permitted. |
| Impact | What "available catalogs" returns for a new account; how API access is enabled; whether item search can be limited to one catalog; how results are ordered; how fully the category, stock and image fields are filled; which hosts serve the pictures. |

Four things need no acceptance, because only the research tool was blocked. **Verify:** in a browser, the walmart.io quickstart and API terms, The Home Depot's program page and policies, Lowe's affiliate page (its network) and Target's partner FAQ, and record each result in the claims register (commercial owner).

## Routes compared

| Route | Retailers it can cover | Data cost | Commission kept | May the data be stored and refreshed | Main risk | Reading |
| --- | --- | --- | --- | --- | --- | --- |
| A. Each program's own catalog through the network API | Walmart (confirmed feed); Target and The Home Depot (reported) | $0 | 100% | Under each program's terms; Walmart requires a 24-hour refresh | Acceptance, API access and catalog sharing are each at someone else's discretion | Recommended |
| B. Walmart's own affiliate API | Walmart | $0 as far as known | 100% | Unread | Access and terms unread here; a person can read them today | First or second for Walmart, decided by what the owner finds |
| C. Whole-catalog files from the dashboard or FTP | As A | $0 | 100% | As A | Large files, almost all of it irrelevant | Only if a brand offers files and no API |
| D. Search links to each retailer, built from a link pattern per program and a search phrase per decoration | All five | $0 | 100% where a program accepts and permits tracked links to search pages; none before | Nothing is stored, so nothing goes stale or needs re-checking | Weaker cards: no picture, no price; clicks can drift to retailers that pay less | Recommended as the floor under A |
| E. Hand-picked product links (the design today) | All five | $0, plus an operator's re-check of every link every 4 days inside a commerce window | 100% where accepted | Our own words only | Labor; items sell out mid-season | Kept for picks worth pinning, and the only way to a `described` item |
| F. Aggregator search API (Channel3) | All five by name | $0.007 a call after 1,000 | 50% | No | Unlicensed data beside a direct Walmart account; loses money per panel ([economics](#economics)) | Not recommended |
| G. Link monetization service (Sovrn, Skimlinks) | Unconfirmed for the five | $0 | Unpublished share | Not applicable | Per-site approval | A later fallback for retailers that decline |
| H. A reseller network (FlexOffers) | Lowe's and others as listed; The Home Depot is listed as not currently offered | $0 | 80% of the rate on the listings read | Links only; feeds are reported to need a separate subscription | One more account and approval for a lower rate | A fallback for one retailer that declines directly |
| I. Unofficial data services | Up to five | About $99 to $198 a month | 100% until the account is closed | Against the retailers' terms | Account termination | Not recommended |
| J. Collecting pages ourselves | Any | Engineering and blocking | 100% until the account is closed | Against the terms and against the [commerce spec](../specs/commerce.md#verification-cadence) | As I | Excluded |

## Economics

The illustration in the [economics spec](../specs/economics.md#unit-economics-model) gives revenue per visitor as 60% completing × 25% clicking × 4% buying × a $120 basket × the commission rate. Cost per visitor is $0.155 at one accepted variant and, by the same formula, $0.215 at the 1.5 variants the spec plans for at peak ([capacity and spend ceilings](../specs/economics.md#capacity-and-spend-ceilings)). At the rates of these five retailers (illustrations at list terms, not forecasts):

| Effective commission | Which program pays about this | Revenue per visitor | Multiple needed at one variant | At 1.5 variants |
| --- | --- | --- | --- | --- |
| 0% | Lowe's during its cut; Costco, with no program found | $0 | none suffices | none suffices |
| 1% | The Home Depot on most products | $0.0072 | 21.5 | 29.9 |
| 2% | Lowe's before the cut | $0.0144 | 10.8 | 14.9 |
| 3% | The spec's base case | $0.0216 | 7.2 | 10.0 |
| 4% | Walmart at its ceiling | $0.0288 | 5.4 | 7.5 |
| 1% to 8% | Target, as reported, set per agreement | $0.0072 to $0.0576 | 21.5 to 2.7 | 29.9 to 3.7 |

- **Scale.** At the spec's capped public rollout of 2,000 visitors a day for 30 peak days, the whole commission is 60,000 visitors × $0.0072 to $0.0288, which is $432 to $1,728, against the $13,100 of variable cost the spec's capacity table gives for those 30 days.
- **The row has to be opened first.** Shop the look is one of four rows that stay closed on every visit ([D-51](../decisions.md#d-51)), and products load only when it is opened. The formula has no term for the share of visitors who open it, and retailer data cannot move that share; it can only lift the clicks of those who did.
- **The inputs are not retailer-specific.** The 4% purchase rate and the $120 basket are the spec's illustration. The research holds figures that cut both ways, all third-party: an average Target order of $70 and earnings of about $3 to $4 per 100 clicks, against $14.40 per 100 clicks in the illustration at 3%; and an average 2.14% for The Home Depot on baskets over $300. The purchase rate is bounded by each program's window, which is one day for The Home Depot and Lowe's.
- **Getting paid.** Walmart pays about 90 days after month end. A payout minimum of $50 is reported for Lowe's and, by direct deposit, for The Home Depot ($100 by check; the sources conflict), all third-party. $50 is $5,000 of referred sales at 1%.
- **Paid data.** $99 a month is the whole commission from about 4,600 visitors at 3%, or 13,750 at 1%, before anything goes toward rendering. $198 doubles both.
- **An aggregator's live calls.** One opened panel earns 25% × 4% × $120 × 3% × 50% = $0.018 through Channel3. At one search per card for a panel of six cards (an assumption), it costs $0.042 once the free credits are used, because results may not be stored in bulk.
- **What the catalog layer is for.** The product promise (real things to buy beside the picture) and a test of whether real products lift clicks. It is not paid back by these five: the table shows the lift would have to be at least five to twenty times. The first lever in the [decision rules](../specs/economics.md#decision-rules) pairs a cheaper render tier with a specialist decor merchant at a verified 6% or more. The specialists the earlier research names are reported on Partnerize, CJ and Sovrn, not on Impact, so that lever needs a second client or links without data.
- **When a reading exists.** The decision rules need 1,500 completed previews that showed the panel, with a tracking program, in a public window; the pooled figures decide and per-program figures are descriptive until each meets that sample. Before any program accepts, plain links give a `plain` reading: open and click rates, and cost only.

## Calendar

| When | What it means |
| --- | --- |
| 2026-11-17 | The app runs locally. No gate and no pilot has run, and no merchant application exists ([status](../README.md#status)). The plan puts the capped public rollout after Gate D and the applications after the rollout ([Phase 5](../backlog.md#phase-5-pilot-and-rollout)). |
| 2026-11-23 and 2026-12-18 | The Thanksgiving and Christmas commerce windows close ([windows](../specs/commerce.md#windows)). The optional New Year's Eve pack, off by default, would run to 2026-12-29. |
| 2026-12-19 to 2027-08-31 | No commerce window is open. Under today's rule the panel state is `off_season`: the row shows a plan-ahead line and no link ([panel states](../specs/commerce.md#panel-states)). |
| 2027-09-01 | Halloween opens, to 2027-10-24. Under today's off-season rule this is the earliest click that can earn, and only if the site is public and a program has accepted by then. If search links show all year, a tracked search link can earn from the day a program accepts. |
| 2027-10-15 | Thanksgiving (to 2027-11-22) and Christmas (to 2027-12-18) open. |
| About the end of December 2027 | Walmart's payment for September sales, at about 90 days after month end. December sales are paid about the end of March 2028. |
| January 2028 | The reading of the Christmas 2027 window closes, after the longest attribution window and a weekly reconciliation ([seasonality](../specs/economics.md#seasonality)). A Halloween reading can close in November 2027 if that window alone reaches the minimum sample. |

Two consequences follow. The only work with a deadline is looking at real in-season results: seasonal items leave the catalogs when the season ends, so the search rules can be tried against real Christmas items in the next few weeks or again from autumn 2027. And a program's reviewer who visits between windows sees the Shop the look row with a plan-ahead line and no links, although the runbook asks for the panel working in plain link mode at application ([runbook](../specs/commerce.md#runbook)); either the applications go in inside a window, or search links show all year, which changes the off-season rule.

## Proposal

**Accepted in part on 2026-11-17.** The owner answered the six [decisions for the owner](#decisions-for-the-owner) put that day (the route; Costco left out and Lowe's as a plain link; a program that accepts and does not answer in writing; the lavish decorations as a fixed list; build 1 now; Amazon as a links-only retailer on a line of its own, with about ten decorating guides planned) with "yes to all, go ahead and build out". The answers are recorded as amended [D-25](../decisions.md#d-25) and [D-17](../decisions.md#d-17) and as [D-53](../decisions.md#d-53) to [D-56](../decisions.md#d-56) and [D-58](../decisions.md#d-58), with the go-ahead on three uses read as the answer to the third; search links all year, which was not among the six, is [D-57](../decisions.md#d-57), Proposed ([decision log](../decisions.md#decision-log)). Build 1, the panel foundation, exists as code ([Shop the look](../specs/commerce.md#shop-the-look)); builds 2 and 3 and the per-retailer activation are not built and wait for what the table below names. The decision register, the commerce spec and the backlog own the rules; the text below is the proposal as it was put to the owner, and where it differs from those files they win.

### Principles

1. **Program data only.** Product names, pictures, prices and stock come from the catalog a program gives Hailiday as its accepted affiliate, never from a retailer's pages, a scraping service or an aggregator beside a direct account.
2. **A slice, not a catalog, kept no longer than a program allows.** Each decoration carries a search phrase; a scheduled job searches each program's catalog for it. What a retailer supplies is held apart from Hailiday's own records so that it can be purged when a license ends.
3. **A person approves every item before it shows.** Rules find and rank candidate items. They cannot prove a match or keep child-directed items out, so an operator's approval is what lets an item appear.
4. **Every retailer the owner shows has a floor.** A retailer without data still gets a link to its own search results for the decoration. The link is built from a pattern on the program record; it is not an offer, so there is nothing to verify and nothing to go stale.
5. **Each program's terms decide what an option shows.** The program record holds, for each use, allowed, denied or unknown, with its evidence (the agreement's text or a written answer), and unknown counts as denied. The uses: tracked links to product pages and to search pages; the retailer's name for the product; the picture, and whether it may be stored; the price and the refresh term; storing between refreshes; being shown beside other retailers' items; being shown beside an AI-made picture; the retailer's own name.
6. **Order never follows commission.** Different retailers' items are ordered by fit, stock and a spread across retailers; money compares only two offers of the same item.
7. **Buying happens at the retailer.** Hailiday links out and takes no payment; checkout for merchant goods stays [out of scope](../PLAN.md#out-of-scope).
8. **Fixture and real never mix.** Fixture programs are served only in `fixture` mode and real ones only at `live_private` or `live_public`, the sync follows each program's capability, sample pictures are placeholders on Hailiday's own origin, and tests never call a network.

### The owner's work, in order

This list, not the build, sets the date of the first tracked click. The commerce spec divides the work among several roles ([roles](../specs/commerce.md#roles)); today they are one person.

1. **Now, while Christmas items are in the catalogs.** None of it needs a public site.
   - Read the walmart.io quickstart and API terms in a browser and try to create a key.
   - Read by hand the pages the research tool could not: The Home Depot's program page and policies, Lowe's affiliate page and Target's partner FAQ.
   - Open an Impact partner account, ask for API access to catalogs and create a read-only token.
   - If a real catalog is then visible, Impact's or Walmart's own, run [the in-season check](#finding-approving-and-refreshing-items).
2. **The public site.** As the plan has it: Gates A and B, then Gate C and the pilot, Gate D, then the capped public rollout ([gates](../backlog.md#gates)). The full list is in [what the owner needs to do next](../README.md#what-the-owner-needs-to-do-next).
3. **Applications.** To Walmart, Target Partners and The Home Depot, each saying plainly that the pictures are AI-made, that similar items are listed beside them and that some listed decorations are typical of the look and may not appear in the picture. Not to Lowe's until its network and a rate above zero are confirmed. Not to Costco.
4. **On each acceptance.** Read the agreement. Fill the program record, each right with its evidence. Send [the questions](#questions-to-put-to-each-program-in-writing) and chase the answers. Have counsel read the terms that reach the feature.
5. **Each commerce window.** Approve candidate items, run the [readiness checklist](../specs/commerce.md#readiness-checklist) and re-read the rates.

### Build steps and what each waits for

| Build | What it is | Waits for |
| --- | --- | --- |
| 1. Panel foundation | Several options per decoration in the products response and the panel; a click token that names the option; a sub-ID the networks accept; option position and kind on the click record; an order that never uses commission across different items; search links from a pattern on the program record; real programs kept apart from fixture ones; a program record an operator can edit, with rights and their evidence. It changes the commerce spec, the schema, the API and the web app. | Nothing to build it. It is needed whatever the approvals bring, and before any application. Visitors see it only after the gates. |
| 2. Network client | A thin client behind a network-neutral interface (search a catalog, read an item, read conversions), with Impact as its first implementation, in `fixture` and live modes. | The Impact account, so that the client is checked read-only against the real API. |
| 3. Catalog layer | The two sync loops, the matching rules, the staging of candidate items, an approval screen for the operator, and retailer names, pictures and prices on options. | One real in-season catalog visible to the account, and the in-season check passing its marks. Its scope is set with the `plain` reading of a public window, where one exists by then. |
| Activation, per retailer | The program's rights recorded with evidence; a first sync at `live_private`; the operator's approvals; then `live_public` with the evidence the spec lists ([what the two records mean](../specs/commerce.md#what-the-two-records-mean)). | Build 3; the retailer's acceptance and shared catalog; the agreement read; the written answers, or the owner's decision to go ahead on what the agreement's text allows. |
| Measure and widen | The pooled reading against the [decision rules](../specs/economics.md#decision-rules). A second client (CJ, Partnerize) only for a merchant whose verified rate is worth one. | A public commerce window with a tracking program. |

What each outcome leaves in use:

| If | In use | Unused |
| --- | --- | --- |
| Approvals are slow | Build 1 with plain search links, and the `plain` reading of open and click rates | Build 2, which is small; build 3 is not yet built |
| Every program declines | Build 1 for good, with plain links, a link monetization service or a reseller | Build 2 |
| A program accepts and withholds its catalog | Build 1 with tracked search links where the program permits them; build 2 for conversions; Walmart's own API if it is open | Build 3 for that retailer |
| A program accepts, shares its catalog and never answers in writing | With the owner's go-ahead, builds 1 to 3 showing a tracked link, our title and the price; without it, a plain search link | Names and pictures on that program's options |

### Data model

- The heading of a group is the kit item's existing product row, in our own words. Each approved retailer item is an offer under it.
- An offer's uniqueness changes from program, merchant item and country to include the product, so that one retailer item can serve two decorations. A 24-inch wreath fits both the house door's and the apartment door's wreath items today.
- What a retailer supplies (name, picture address, price, stock, product codes, the catalog's update time) sits in its own table keyed by offer. It can then be purged when a license ends without breaking the click history that points at the offer.
- A synced option always shows as `similar`, whatever the link row's relationship says. `described` stays what it is today: a hand-picked product with a recorded adherence pass.
- A search link is not an offer. The program record holds a link pattern and the decoration holds a search phrase; the link is built when the panel is read, and a click on it is recorded with its program and decoration and no offer.
- A group that has only search links still counts: it makes the panel `active`. A program with links only has no verified offer to show as evidence, so it moves to `live_public` on its link pattern opened and checked once by an operator.
- Search phrases and matching rules are data an operator can edit, in commerce tables. Kit and pack content cannot hold them: it is inserted once outside development, and a kit change is a new version.

### Finding, approving and refreshing items

- **Discovery.** At most daily, starting some days before a window opens, a keyword search per decoration and program brings candidate items into staging as `draft`. Rules rank and thin them: required and excluded words, a size read from the name where one is given, color, the brand's own category names mapped by hand per program, in stock, a price range. These are heuristics over the retailer's free text. A kit item's attributes are our own free text, and a catalog item has no size, lighting or audience field.
- **Approval.** An operator approves, pins or blocks each candidate item, seeing its picture. Nothing shows unapproved, so the audience rule ([D-17](../decisions.md#d-17)) does not rest on a word list. The excluded words mirror the packs: licensed and cartoon characters, mascots and inflatables, Santa and snowman figures, toys.
- **Refresh.** Twice a day inside a window, each approved item is read again by its ID for name, picture, price and stock. An item stops showing after several completed runs without it or on its `ExpirationDate`, never because one search page left it out, and it returns when its stock returns. A run that fails or times out changes nothing and raises an alert. The sync owns the status of synced offers; `offer_verification` keeps the hand-picked ones.
- **A program's refresh term.** Walmart's 24 hours is recorded on the program record. Once the last successful refresh is older than the term, everything the retailer supplied stops showing and the option falls back to our title and "Check price at retailer". A price's "as of" time is never later than the catalog's own `DateLastUpdated`.
- **No call on the visitor's path.** The panel reads Hailiday's own tables. A program outage ages the data until the term hides it; it never slows or breaks a page.
- **Volume (an assumption, not a measurement).** About 30 decorations for a holiday in its window (the Christmas content holds 22 kit items today), three programs, two searches and two pages each make a discovery run of under 400 requests, against 3,000 an hour. A refresh run reads each approved item once: at four options for 30 decorations and three programs that is 360 reads, against 1,000 an hour if a read by ID falls under the general limit.
- **The in-season check, before build 3.** With a read-only token, run the Christmas kit items' search phrases twice, at least 12 hours apart, and record: whether a search can be limited to one catalog; the share of items present in both runs; how fully the category, stock, product code and image fields are filled, and which hosts serve the pictures; for five kit items, how many of the first 200 results a person would accept, and how many character or inflatable items get past the excluded words. Suggested marks: nine items in ten present in both runs, and four or more acceptable in-stock items for four kit items in five. Listing a catalog's items by category would give steadier membership than a search, if the listing takes a filter; that is the alternative to test.

### What a visitor would see

- The row stays closed until the visitor opens it, as today ([D-51](../decisions.md#d-51)), and shows only where `commerceAdjacent` allows it ([D-15](../decisions.md#d-15)).
- One group per decoration, headed in our own words.
- Up to four options per group (configuration). Each is an approved retailer item labeled "Similar item". It shows the retailer's name for the product, its picture and its price with the "as of" time where the program's rights allow each; otherwise our title, a category illustration and "Check price at retailer". The retailer is always named in plain text. Tracking links carry the "Ad" label and the disclosure as today ([disclosure](../specs/commerce.md#disclosure)).
- Under a lavish look, a group for a decoration the plan did not place carries its own label, typical of the look, in place of "Similar item" ([decorations of the lavish tier](#decorations-of-the-lavish-tier)).
- Under the options, a "find similar at" link for each retailer the owner shows. It carries no relationship label.
- A retailer filter above the groups.
- Order within a group: fit to the decoration, in stock, price known, a spread across retailers, then a fixed order that has nothing to do with money. Commission, attribution window and program status are compared only between offers of the same retailer item ([ranking integrity](../specs/commerce.md#ranking-integrity)).
- Pictures are served from Hailiday's own storage where a program allows storing. Loading them from a retailer's host is a request to a third party when the row opens, which the privacy rules exclude today (rule 12 of the [data-handling rules](../specs/privacy-safety-legal.md#data-handling-rules); [D-45](../decisions.md#d-45)). It happens only if the owner decides so and those rules are amended. A picture that is blocked or fails falls back to the illustration, which has yet to be drawn.
- Not in this proposal: a saved shopping list across retailers (a later addition, and never with price alerts); rendering a chosen product into the picture (the `reference` relationship, a later capability under [D-24](../decisions.md#d-24)); and a model reading retailer text to sort items, which D-24, [PLAN section 9](../PLAN.md#9-commerce-and-business-model) and privacy rule 5 exclude as written and each program would have to permit.

### Decorations of the lavish tier

The default look for a house exterior asks for decorations no kit holds. For a lavish plan the picture check already records, as a record only, whether each of the plan's listed placements is present, and a kit item reported absent gets no card. The extra decorations are not placements, so nothing records them, and spots can be put back from the original after the check has looked. The house exterior kit is at its limit of six items, and [D-10](../decisions.md#d-10) set aside more kit items for this tier. Three ways to make the extra decorations shoppable:

| Way | What it takes | Effect |
| --- | --- | --- |
| 1. Look items outside the kit and the pack: a list per holiday, scene and style, each with a product in our own words and a search phrase | Commerce tables and one step at publish; the rule that the panel lists exactly the plan's placements amended ([style kits](../specs/holidays-and-content.md#style-kits)); a label of their own that says the items are typical of the look, since "Similar item" needs a kit item or a placement to match ([product relationships](../specs/commerce.md#product-relationships)), which adds to D-24's enum. Packs, plans and cached looks are untouched. | Every group shows for every lavish look, drawn or not, so it sits further than way 2 from Walmart's rule that content match the actual product; question 4 asks about it. It can ship with build 1. |
| 2. The picture check also reports which decoration types it sees | Both check prompts (the decorated picture and its evening relight); a new optional field in a strict result schema; a new prompt version, with recalibration on at least 60 attempts ([recalibration triggers](../specs/quality-and-benchmark.md#recalibration-triggers)); the fixture check; a box per type if put-back spots are to hide a group. Judge calibration is not yet built. | Groups show only for what the check saw. |
| 3. The extra decorations become kit items of the `abundant` style | Both limits of six raised; anchor categories for shrubs and tree trunks; higher placement and card limits; a pack MINOR bump, which stops every cached look of that holiday from being reused; D-10 amended by the owner. | The existing presence and put-back logic applies. It changes what the plan asks the editor to draw. |

Way 1 is the cheapest and is recommended first. Way 2 is worth its cost only if a reading shows groups for decorations that are not in the picture.

### Per retailer

Rights as they stand on 2026-11-17. For Target, The Home Depot and Lowe's every right is unknown until an agreement is read, and no program was found for Costco.

| Use | Walmart, as its agreement and program pages read |
| --- | --- |
| Tracked links to item, category and department pages | Allowed on acceptance ("anything on Walmart.com") |
| Tracked links to search results | Allowed on the same words; confirm in writing |
| Price | Allowed when Walmart supplies it and it is refreshed within 24 hours |
| The retailer's name for a product | Unknown: not addressed |
| Picture | Unknown: only images "provided by Walmart for use in the Program" |
| Storing between refreshes | Unknown: not addressed beyond the 24-hour refresh |
| Shown beside other retailers' items | Unknown: not addressed; price tracking and alerts are barred |
| Shown beside an AI-made picture | Unknown: needs Walmart's written view |
| The name "Walmart" in plain text | Allowed under the trademark rules as read |

By principle 5 that leaves nothing of Walmart's to show on the text alone beyond a plain search link: every option sits beside an AI-made picture, in a group with other retailers' options, with its price held in Hailiday's tables between refreshes, and each of those three uses is unknown. With the owner's go-ahead on those three ([decisions for the owner](#decisions-for-the-owner)), a Walmart option shows a tracked link, our own title and Walmart's price. Walmart's name for the product and its picture wait for a written answer.

| Retailer | First route | If that fails | What it earns |
| --- | --- | --- | --- |
| Walmart | Its catalog through Impact (route A) or its own API (route B), whichever the owner's reading in a browser shows to be open | Search links (D) | Up to 4%, the highest verified rate of the five |
| Target | Its catalog through Impact (A) | Search links (D) | 1% to 8% as reported, with the longest reported cookie of the five |
| The Home Depot | Its catalog through Impact (A) | Search links (D) | About a quarter of Walmart's rate, with a 1-day cookie. It is there for the visitor. |
| Lowe's | A plain search link, if the owner wants the choice shown | Left out | Nothing until its network and a rate above zero are confirmed; no application before that |
| Costco | Left out | A plain search link if the owner wants the name present, after counsel's reading of the trademark clause | Nothing |

### Amazon

Amazon was not among the five; the owner asked about it on 2026-11-17. Its program facts are owned by the commerce and markets research ([Amazon Associates](commerce-and-markets.md#amazon-associates), [re-read on 2026-11-17](commerce-and-markets.md#re-read-on-2026-11-17)). This section says how Amazon fits the route.

| Stage | What may show |
| --- | --- |
| Before the application | A plain link to Amazon's search results for the decoration, in our own words. No tracking ID, logo, picture or price. |
| From the day of the application | Tagged text links to products or to search results, with Amazon's required statement. One tracking ID per holiday and channel, and no per-click identifier. No picture and no price. |
| With the Creators API | Names, pictures served by Amazon and prices, but only with Amazon's written approval: the license excludes a site whose principal purpose is not marketing Amazon. |

- **Links only.** Amazon's product data is out of reach twice over. The API needs 10 qualifying sales in the trailing 30 days and lapses after 30 days without one, which for this product is every off-season; and its license does not plainly cover a site that lists several retailers. Amazon is therefore a "find similar at Amazon" link (route D) or a hand-picked product link (route E), in our own words, with "Check price at retailer".
- **Kept apart.** Amazon's license bars sending traffic to other sites "in conjunction with" its links, except from parts of the site "not closely associated" with them. Until Amazon says otherwise in writing, its link sits on a line of its own, outside the options of other retailers, and never in a price comparison.
- **One application.** Three qualifying sales within 180 days, with personal orders excluded. The review expects original content beyond advertising ("a good rule of thumb is at least 10 posts"), recent within about 60 days. After a rejection for anything but unsuitable content, re-joining needs Amazon's advance authorization. So the application goes in once, inside a commerce window with real traffic, after the site has content of its own besides the tool.
- **What it earns.** 3% in the Home, Home Improvement and Lawn & Garden categories. Anything bought in the session earns; the session ends after 24 hours or at the first order. Attribution is per tracking ID, never per click.
- **No other payer.** A link monetization service cannot stand in: none was found that still pays on Amazon links, and a tagged link may be shown only on the Associate's own site.
- **Already built.** The `amazon_associates` program type, the required statement beside Amazon tracking links and tracking IDs per holiday ([Amazon specifics](../specs/commerce.md#amazon-specifics), [sub-IDs and tracking IDs](../specs/commerce.md#sub-ids-and-tracking-ids)).

What build 1 adds for Amazon: a search-link pattern that carries a tracking ID in place of a sub-ID, and a separate line for Amazon's link in the panel. Questions to put to Amazon in writing, through the Associates contact form: whether its link may sit in the same list as other retailers' links for the same kind of item; whether a site of AI-made pictures with similar items listed beside them meets the content it expects; and whether the Creators API may be used on a site that lists several retailers.

### What would change

| Owner file | What changes |
| --- | --- |
| Decision register | [D-25](../decisions.md#d-25): "manually curated links until API access is granted" gains the catalog route and the search-link floor. [D-17](../decisions.md#d-17): its consequences name retailer items. [D-27](../decisions.md#d-27) and D-15 hold as written. D-24's enum gains a label if look items are chosen (way 1 of the lavish tier) and otherwise holds. D-10 changes only for way 3, and D-45 only if pictures load from a retailer's host. The rest are new decisions ([decisions for the owner](#decisions-for-the-owner)). |
| PLAN | Commerce in the release scope; "three to six items" with "our own title"; "manually curated links at first" ([scope](../PLAN.md#3-scope-of-the-us-release), [experience overview](../PLAN.md#4-experience-overview), [commerce and business model](../PLAN.md#9-commerce-and-business-model)). |
| Commerce spec | The panel's size in groups and options ([what the panel is](../specs/commerce.md#what-the-panel-is)) and [card content](../specs/commerce.md#group-and-option-content). A search link makes a group eligible and the panel `active` ([placement and eligibility](../specs/commerce.md#placement-and-eligibility), [panel states](../specs/commerce.md#panel-states)), and a program with links only reaches `live_public` on evidence other than a verified offer ([what the two records mean](../specs/commerce.md#what-the-two-records-mean)). The calendar [rules](../specs/commerce.md#rules), if search links show all year. [Product relationships](../specs/commerce.md#product-relationships): options always `similar`, a search link without a label. A product "holds no merchant text or images" ([kit item to product](../specs/commerce.md#kit-item-to-product)); [pilot catalog sizing](../specs/commerce.md#pilot-catalog-sizing). [Offer fields](../specs/commerce.md#offer-fields), the [lifecycle](../specs/commerce.md#lifecycle) of synced offers, [verification cadence](../specs/commerce.md#verification-cadence) and the default of no price ([price display policy](../specs/commerce.md#price-display-policy)). The [program record](../specs/commerce.md#program-record) (rights with evidence, link pattern, refresh term), the [runbook](../specs/commerce.md#runbook) and the [candidate programs](../specs/commerce.md#candidate-programs). [Panel composition](../specs/commerce.md#panel-composition), [offer selection within a kit item](../specs/commerce.md#order-within-a-group), [what commission may never do](../specs/commerce.md#what-commission-may-never-do) and the audit in [recorded metadata](../specs/commerce.md#recorded-metadata), restated for several options. The [click event](../specs/commerce.md#click-event), [sub-IDs](../specs/commerce.md#sub-ids-and-tracking-ids) and [metrics](../specs/commerce.md#metrics). The [readiness checklist](../specs/commerce.md#readiness-checklist) and [internal tools](../specs/commerce.md#internal-tools). A product-side audience rule, which the privacy spec points to and the commerce spec does not yet hold. |
| Holidays spec | "The panel never shows an item the plan did not place", and the sentence on lavish plans after it ([style kits](../specs/holidays-and-content.md#style-kits)). Kit size and the pack MINOR bump only for way 3. |
| Render pipeline and quality specs | Only for way 2: the [judge](../specs/render-pipeline.md#judge) and its [recalibration triggers](../specs/quality-and-benchmark.md#recalibration-triggers). |
| Data and API spec | Offers, products, `render_product_links`, `affiliate_clicks`, `merchant_programs` and the new tables ([entities](../specs/data-and-api.md#entities)); the products response and clicks ([HTTP API](../specs/data-and-api.md#http-api)); editing programs and offers, approving candidate items and running a sync ([internal operations API](../specs/data-and-api.md#internal-operations-api)); `shop_panel_viewed` and `product_clicked` ([analytics events](../specs/data-and-api.md#analytics-events)). |
| Architecture | A sync queue ([queues](../architecture.md#queues)); a catalog leg with its capability and fixture contract ([integration matrix](../architecture.md#integration-matrix)); the network's credentials ([key inventory](../architecture.md#key-inventory)); image sources in the content security policy ([sessions, CSRF and CORS](../architecture.md#sessions-csrf-and-cors)); the network API host, and image hosts if pictures are stored ([outbound requests and SSRF](../architecture.md#outbound-requests-and-ssrf)). |
| Privacy spec | The network as a subprocessor ([subprocessors](../specs/privacy-safety-legal.md#subprocessors)); the product rule the audience guardrail points to ([audience and age](../specs/privacy-safety-legal.md#audience-and-age)). Only if pictures load from a retailer's host: rule 12, the "no sale or sharing" statement and the cookie notice ([US privacy law](../specs/privacy-safety-legal.md#us-privacy-law), [legal deliverables](../specs/privacy-safety-legal.md#legal-deliverables)). |
| Experience spec | The Shop the look row and its item count ([below the card](../specs/experience.md#below-the-card)); its copy ([copy deck](../specs/experience.md#copy-deck)); the alt text of pictures ([components](../specs/experience.md#components)). |
| Economics spec | Click and purchase rate with several options and unpaid search links ([unit economics model](../specs/economics.md#unit-economics-model)); program rows with rates read from dashboards ([revenue assumptions](../specs/economics.md#revenue-assumptions)). |
| Glossary, backlog, traceability | Product, Offer and each new term ([commerce terms](../glossary.md#commerce-terms)); C01 to C07 and the criteria of S06, S07, O03 and O04 that test the rules above ([Phase 4](../backlog.md#phase-4-commerce-safety-and-operations)); L04 ([Phase 5](../backlog.md#phase-5-pilot-and-rollout)); REQ-08 ([requirements from the original brief](../traceability.md#requirements-from-the-original-brief)). |
| Code | A migration. `packages/server/src/providers` (client, host list), `packages/server/src/config/index.ts`, `packages/server/src/capabilities/index.ts`. `packages/server/src/queue/definitions.ts`, `packages/server/src/pipeline/handlers.ts`, `packages/server/src/pipeline/jobs/commerce-and-coverage.ts`. `packages/server/src/content/publish.ts` and `packages/server/content/commerce`. `packages/server/src/pipeline/render/publish.ts`. `packages/core/src/schemas/commerce.ts` and `packages/core/src/schemas/analytics.ts`. `apps/api/src/domain/commerce.ts`, `apps/api/src/routes/renders.ts`, `apps/api/src/routes/internal.ts`, `apps/api/src/html/shell.ts`. `apps/web/src/features/shop/ShopTheLook.tsx` and `shop.css`, `apps/web/src/api/endpoints.ts`, `apps/web/src/copy/deck.ts`, an approval screen and the category illustrations. The tests of the panel, and first tests for ranking, click tokens and link building, which have none today. Way 2 adds `packages/server/src/providers/vision/prompts.ts` and `packages/core/src/schemas/pipeline.ts`; way 3 adds `packages/core/src/schemas/content.ts`, `packages/server/src/content/load.ts` and `packages/server/content/packs`. |

### Questions to put to each program in writing

Answers to questions 1, 3, 4 and 6 are conditions for the uses they cover, except where the owner records a go-ahead without one ([decisions for the owner](#decisions-for-the-owner)).

1. May product names, pictures and prices from your feed be shown on our pages, and may they be stored between refreshes? For how long?
2. Is your catalog available to our account through the network's API?
3. May your items appear beside other retailers' items for the same kind of decoration?
4. Our pictures are AI-made illustrations of the visitor's own home, each made for one visitor and shown without a person's review. Products are labeled "Similar item", and some listed decorations are typical of the look and may not appear in the picture. Does that meet your rules on AI content and accuracy? Is any wording required?
5. May a picture be loaded from your image host on our page, or stored and served by us?
6. Are tracked links to search and category pages allowed, and can each click carry its own sub-ID?
7. Which rate and attribution window apply to seasonal decor and lighting?

### Risks

| Risk | Answer |
| --- | --- |
| No program accepts a new site, or one accepts and withholds its catalog. The research measures none of these odds. | The search-link floor; Walmart's own API; a link monetization service or a reseller for one retailer; a new application once there is traffic |
| A program never answers in writing | Only what its agreement's text allows is shown; the owner's decision on tracked links |
| A retailer objects to products beside an AI-made picture | The "Similar item" label; the pairing described in the application; the program switched off by its capability |
| A program's terms deny pictures, names or prices | The option falls back to our title, the illustration and "Check price at retailer" |
| A sync fails for longer than a program's refresh term | Everything the retailer supplied stops showing at the term; an alert on any failed run |
| Unsuitable or child-directed items arrive in a catalog | Nothing shows before an operator approves it; the excluded words mirror the packs |
| The rules do not find enough good items | The in-season check and its marks before build 3; hand-picked items |
| Seasonal items sell out or leave the catalog mid-window | The refresh loop; an operator approves replacements from the day's candidate items |
| Clicks drift to retailers that pay less or nothing | The owner's decision on which retailers show; click share per retailer in the first reading |
| Visitors do not open the row | A `plain` reading of a public window, where one exists before build 3 starts, sets how much of it is built; a low click rate sends work to relevance and placement first, as the decision rules say |
| A program closes, cuts its rate or moves network | Each program is its own switch; rates re-read at every window's readiness check |
| The approval work outgrows one person | The rules are judged by the share of their candidate items an operator accepts; four options a group is a ceiling, not a target |

### Decisions for the owner

| Decision | Recommended | Holds only if |
| --- | --- | --- |
| The route | Program data through the network API, or for Walmart through its own API if the owner finds it open (route A or B), with search links as the floor; no scraping service and no aggregator beside a direct account | No condition |
| What an option may show | The retailer's name for the product, its picture and its price wherever the agreement's text or a written answer allows; nothing on "unknown" | For Walmart today that is the price, and only with the go-ahead in the row on unanswered questions |
| Pictures | From Hailiday's own storage where a program allows storing; otherwise the illustration | Loading from a retailer's host would need the privacy rules amended first |
| Choice | Up to four options per decoration and a retailer filter, never ordered by commission | Each program's answer on being shown beside other retailers |
| Lavish decorations | Shoppable as look items typical of the look (way 1) | The style kits rule amended and a label added to D-24's enum |
| Retailers shown | Walmart, Target and The Home Depot; Lowe's as a plain link; Costco left out. Reviewed at the first reading, since a click to a retailer that pays less is a click a paying one did not get | Counsel's reading before Costco's name is ever used |
| A program that accepts and does not answer in writing | Go ahead on three uses its agreement does not address: its links and price beside an AI-made picture, when the application described the pictures; beside other retailers' items; and its price held up to the refresh term. Its name for the product and its picture wait for the answer | The owner records this as an accepted risk: a program that objects later can end the account and reverse commissions. Without the decision, that program shows only as a plain search link |
| Amazon | Added as a links-only retailer on a line of its own. One application, inside a commerce window with real traffic, after the site has original content besides the tool | Amazon's written answer before its link sits among other retailers' options |
| When to apply | To the Impact programs as soon as the site is public, with search links showing all year so that a reviewer sees a working panel | The off-season rule amended; otherwise apply only inside a window |
| Order of the build | Build 1 before the site is public; build 2 when the Impact account exists; build 3 only after a real in-season catalog has been seen and the check has passed | Build 3's scope follows the `plain` reading of a public window, where one exists by then |

Each row the owner settles is recorded by a dated entry in the [decision log](../decisions.md#decision-log). The route and the floor amend D-25, and D-17's consequences gain the product-side audience rule. The others take the next unused IDs ([how decisions work](../decisions.md#how-decisions-work)). D-24's enum gains a label if look items are chosen (way 1). D-10 and D-45 are amended only if the owner chooses way 3 or pictures loaded from a retailer's host.

## Claims register

Each row is a claim another document may rely on. "Re-check" says when a reader should confirm it again.

| ID | Claim | Source | Status | Re-check before |
| --- | --- | --- | --- | --- |
| RC-01 | Walmart's US affiliate program runs on Impact | [Walmart FAQ](https://affiliates.walmart.com/faqs) | Verified | Applying |
| RC-02 | Accepted Walmart affiliates get data feeds through the Affiliate Member Center; fields, size, format and refresh are not public | [Program page](https://affiliates.walmart.com/) | Verified (existence only) | Designing the Walmart sync |
| RC-03 | Walmart's affiliate terms (June 2026): price only if provided by Walmart; update within 24 hours; no price tracking or alerts; no scraping; images only as provided; the datafeed not passed to third parties; AI content truthful, reviewed before posting and matching the actual product; no "dupe" wording; trademark rules for the name and logos | [Terms](https://affiliates.walmart.com/terms) | Verified (read through the fetch tool) | Showing any Walmart data; re-read in full on acceptance |
| RC-04 | Walmart pays "up to 4%" and about 90 days after month end; category rates and cookie length are unpublished (3 days reported) | [FAQ](https://affiliates.walmart.com/faqs); [terms](https://affiliates.walmart.com/terms) | Verified; cookie Third-party | Any revenue estimate |
| RC-05 | A Walmart affiliate API exists on walmart.io; a search excerpt of its quickstart describes a self-serve sign-up; access and terms are unread | [Quickstart](https://walmart.io/apidocs/affiliates/quickstart) (HTTP 456) | Unverified | Choosing route B; readable in a browser today |
| RC-06 | Target Partners runs on Impact and lists a data feed; 1% to 8%; 7-day cookie | [Agency listing](https://accelerationpartners.com/affiliate-programs/target) | Third-party | Applying; reading the dashboard |
| RC-07 | Target's site terms (2026-09-10) bar commercial use of listings, prices and images, scraping, database building and unapproved agents | [Site terms](https://www.target.com/c/terms-conditions/-/N-4sr7l) | Verified | Showing any Target data |
| RC-08 | The Home Depot's program is on Impact, promises data feeds, pays 1% on most products and 8% on "HD Home" products, with a 1-day cookie; one tracker shows the Impact listing removed 2026-08-17 | [Program page](https://www.homedepot.com/c/SF_MS_The_Home_Depot_Affiliate_Program) (excerpt); [tracker](https://www.affilitizer.com/programs/homedepot.com); [reseller listing](https://www.flexoffers.com/affiliate-programs/home-depot-affiliate-program) | Third-party | Applying |
| RC-09 | Lowe's network is unsettled (CJ or Impact); no affiliate feed is confirmed; about 1% to 2% and a 1-day cookie; the rate was cut to 0% for part of 2026 | [Sign-up report](https://geniuslink.com/blog/lowes-affiliate-program/); [reseller listing](https://www.flexoffers.com/affiliate-programs/lowes-affiliate-program/); [publisher report](https://toolguyd.com/lowes-links-broken-2026/) | Unverified | Applying |
| RC-10 | No affiliate program that pays on Costco merchandise was found; Costco's terms (2026-10-07) bar automated extraction and grant no license to use its trademarks; non-members pay a 5% surcharge | [Reseller listing](https://www.flexoffers.com/affiliate-programs/costco-membership-affiliate-program/); [terms](https://www.costco.com/terms-and-conditions-of-use.html); [Costco help](https://customerservice.costco.com/app/answers/answer_view/a_id/1155/~/why-am-i-being-charged-a-non-member-surcharge) | Third-party (no merchandise program); Verified (terms, surcharge) | Adding Costco in any form |
| RC-11 | Impact's partner API lists catalogs, reads one item by its ID, searches items across available catalogs and returns name, URL, image, prices, stock, product codes and category per item | [Search catalog items](https://integrations.impact.com/impact-publisher/reference/search-catalog-items); [item object](https://integrations.impact.com/impact-publisher/reference/the-catalog-item-object-1) | Verified | Building the client |
| RC-12 | Impact limits per hour: 3,000 shared by item search and one catalog's item listing; 1,000 for catalog lists; 500 for `/Actions` and `/Clicks` | [Rate limits](https://integrations.impact.com/impact-publisher/reference/rate-limits) | Verified | Sizing the sync |
| RC-13 | A brand on Impact can restrict its catalog to named partners; brands are advised to update catalogs daily; catalog access by API has to be enabled | [Brand help](https://help.impact.com/brand/what-would-you-like-to-learn-about/platform-features/product-catalogs/add-product-catalogs-as-a-brand); [partner help](https://help.impact.com/partner/what-would-you-like-to-learn-about/platform-features/marketing-content/product-marketplace-and-catalogs/download-product-catalogs-as-a-partner) | Verified | Counting on a catalog after acceptance |
| RC-14 | An Impact catalog item's `Url` is a tracking link unique to the partner; a sub-ID is added as the `subId1` query parameter; a `u` parameter deep-links to a page the brand permits | [Catalogs reference](https://integrations.impact.com/partner-api-reference/reference/catalogs/catalogs); [tracking link help](https://help.impact.com/partner/what-would-you-like-to-learn-about/platform-features/tracking/tracking-links/create-and-manage-links/add-reporting-information-to-your-tracking-links) | Verified | Building links and click tokens |
| RC-15 | Channel3 keeps 50% of commissions, charges $0.007 a call after 1,000 free credits, forbids storing a significant portion of its catalog and discloses no license from retailers | [Commissions](https://channel3.ai/docs/commissions); [pricing](https://channel3.ai/docs/pricing); [terms](https://channel3.ai/terms) | Verified | Considering any aggregator |
| RC-16 | Sovrn's product-data API takes a product URL, not a search; coverage of the five retailers and its revenue share are unpublished | [Reference](https://developer.sovrn.com/reference/prod-data-api); [Sovrn Commerce](https://www.sovrn.com/commerce/) | Verified | Considering route G |
| RC-17 | Unofficial data for real coverage costs about $99 a month at list price (one service, all five) to about $198 (three per-retailer plans at $66) | [Unwrangle](https://www.unwrangle.com/); Traject pricing for [Walmart](https://trajectdata.com/pricing/bluecart-api), [Target](https://trajectdata.com/pricing/redcircle-api) and [The Home Depot](https://trajectdata.com/pricing/big-box-api) | Verified (list prices); the $198 total is an inference from separate pricing pages | Not needed unless route I is reopened |
| RC-18 | The agent shopping protocols give an independent app no working route to these retailers and carry no commission | [UCP overview](https://ucp.dev/latest/specification/overview/); [ACP](https://www.agenticcommerce.dev/) | Verified | A retailer publishing an open endpoint |
| RC-19 | CJ offers a product-feed API to publishers joined to an advertiser | [CJ reference](https://developers.cj.com/graphql/reference/Product%20Feed) (did not render) | Unverified | Lowe's or a specialist merchant turning out to be on CJ |
| RC-20 | Impact's partner API returns the conversions attributed to a partner (`/Actions`) with the sub-ID of the winning click; a sub-ID is alphanumeric, at most 255 characters | [Actions](https://integrations.impact.com/partner-api-reference/reference/actions/actions) (excerpt); [sub-ID help](https://help.impact.com/partner/what-would-you-like-to-learn-about/platform-features/tracking/tracking-links/link-parameters/sub-id-and-shared-id-parameters-explained-for-partners) (summary) | Third-party | Building the conversion import and the click token |
