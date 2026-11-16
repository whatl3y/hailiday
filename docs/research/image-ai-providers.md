# Image AI providers: dated research

Research on image-editing and vision providers for decorating real photos: which candidates exist, what their terms say about private photos, what they cost, how they rank, and what provenance signals they emit. It supports the provider decisions and contains no normative instructions; the benchmark protocol and the selection rules live in the linked specifications.

**Owns:** provider shortlist, terms, pricing, leaderboards, provenance facts, aggregators, claims register (dated facts only).
**Baseline:** planning baseline 2026-11-09; external facts retrieved 2026-11-08.

## Summary

- **Shortlist.** Benchmark arms: OpenAI GPT-Image-2.5 Sunburst and Flare; OpenAI GPT-Image-2.6 Sunburst and Flare (conditional, see below); Google Nano Banana 2.1 and Gemini 3 Pro Image. Watch list, not arms: Microsoft MAI-Image-2.7, Seedream 5.0 Pro, Krea 3. Contingency, not an arm: Qwen-Image-Edit-2511 (Apache 2.0). Excluded for private photos without a written agreement: Black Forest Labs (BFL) API.
- **Hard criteria for private photos** (from [D-42](../decisions.md#d-42)): no training on inputs; retention or zero data retention (ZDR) terms the owner can accept; age terms compatible with an adult-audience product ([D-17](../decisions.md#d-17)); US processing; commercial rights to outputs.
- **What stands out.** OpenAI's 2.5 models are the only newest-generation image models explicitly listed as ZDR-compatible; the 2.6 models are not on that list. Google's paid Gemini API does not use content to improve products, but its terms bar API clients directed at or likely to be accessed by under-18s, and the Google Cloud terms carry the same clause for Vertex AI. BFL's API terms permit training on and public display of inputs and outputs. Leaderboards measure general edit preference, not preservation of a specific building.
- **What the research cannot decide.** Fidelity on real homes, cost per accepted variant and latency are measured in the benchmark ([Provider comparison](../specs/quality-and-benchmark.md#provider-comparison)); the selection is recorded as [D-42](../decisions.md#d-42). Vision-model selection for analysis and QA is [D-43](../decisions.md#d-43); the stage contracts are in [Model roster](../specs/render-pipeline.md#model-roster).
- **Model lifetimes are short.** Google lists Gemini 2.5 Flash Image (released 2025-10-02) with a shutdown of 2027-03-15, and Gemini preview image models lived four to eight months ([deprecations](https://aistudio.google.com/docs/deprecations), retrieved 2026-11-08). Pin dated snapshots and re-run the held-out set on any change; the rule is owned by [Model roster](../specs/render-pipeline.md#model-roster).

## Candidate shortlist

Capabilities are from vendor documentation; they are not measured quality. "Arm" states whether the candidate is a benchmark arm for [D-42](../decisions.md#d-42). Prices are in [Pricing](#pricing); terms detail is in [Data, training and age terms](#data-training-and-age-terms).

| Provider and model ID | Edit support and shape | Reference images | Sizes and settings | Masks | ZDR status | Training | Age terms | Arm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI `gpt-image-2.5-sunburst` (snapshot `gpt-image-2.5-sunburst-2026-09-08`) | `POST /v1/images/edits`, synchronous | Multiple; maximum count not found on the page (verify) | 1024x1024, 1536x1024, 1024x1536 recommended; custom sizes reported for 2.5, not confirmed; quality low, medium, high, xhigh, max, auto | Guidance only; alpha channel; applies to first image; cannot combine with markup | ZDR-compatible, with limitations | Not used by default | No hard 18+ ban; under-18 guidance requires safeguards | Yes |
| OpenAI `gpt-image-2.5-flare` (snapshot `gpt-image-2.5-flare-2026-09-08`) | As above | As above | As above | As above | ZDR-compatible, with limitations | Not used by default | As above | Yes |
| OpenAI `gpt-image-2.6-sunburst` | Edits and generations; markup-guided edits; complexity setting (low, medium, high; default high); single snapshot | As above | Custom-size support not confirmed for 2.6 | As above | Not on the ZDR list as of 2026-11-08; verify with OpenAI | Not used by default | As above | Conditional: only if OpenAI confirms ZDR in writing or the abuse-monitoring retention is accepted and disclosed |
| OpenAI `gpt-image-2.6-flare` | As 2.6 Sunburst | As above | As above | As above | Not on the ZDR list; verify | Not used by default | As above | Conditional, as above |
| Google Nano Banana 2.1 (`gemini-nano-banana-2.1`) | Gemini API text-plus-image edit; Google recommends it for new projects | Up to 10 object and 4 character references | 1K, 2K, 4K; thinking minimal, medium, high (default medium; cannot be disabled; thinking tokens billed) | No mask API; regional placement is prompt-driven | Gemini API: no ZDR statement found; Vertex AI availability not verified | Paid tier: not used to improve products | API clients directed at or likely accessed by under-18s barred; 18+ | Yes |
| Google Gemini 3 Pro Image (`gemini-3-pro-image`) | Text-plus-image edit; Gemini API and Vertex AI page (global region) | Up to 14 per prompt (6 object, 5 character, up to 3 style) | 1K, 2K, 4K; thinking enabled by default; up to two interim images generated (not charged) | None | Vertex AI: configurable ZDR (see terms) | Vertex AI: no training or fine-tuning without permission | 18+; Gemini API clause applies, and Vertex AI carries the same under-18 clause | Yes |
| Google Gemini 3.1 Flash Image (`gemini-3.1-flash-image`) | Labeled previous generation; replacement is Nano Banana 2.1 | Up to 14 (10 object, 4 character) | 0.5K, 1K, 2K, 4K; thinking minimal or high (default minimal) | None | As Nano Banana 2.1 | As Nano Banana 2.1 | As Nano Banana 2.1 | No |
| Microsoft MAI-Image-2.7-Preview | Ranks fourth on both boards; Artificial Analysis lists "No API available"; Foundry availability confirmed only for earlier versions via secondary sources | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | No (watch list) |
| ByteDance Seedream 5.0 Pro | Single and multi-reference editing (about 10 references per one provider); official price and terms not verified | About 10 (secondary) | 2K or 4K (resellers conflict) | Unverified | Unverified | Unverified | Unverified | No (watch list; permissioned images only if added) |
| Krea 3 Ultra | Ranks 11th on Arena edit and 6th on Artificial Analysis | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | No (watch list) |
| Qwen-Image-Edit-2511 (20B, open weights) | Self-hosted or hosted by a managed inference vendor; Apache 2.0 | Unverified | Unverified | Unverified | Not applicable when self-hosted | Not applicable when self-hosted | Not applicable | No (contingency; see [Aggregators and open weights](#aggregators-and-open-weights)) |
| Black Forest Labs FLUX 3 Image and FLUX.2 [max, pro, flex, klein] | Asynchronous request and polling; FLUX 3 Image generates and edits, bounding-box layouts | FLUX 3 Image: up to 10 | Native 2K and 4K (FLUX 3 Image); FLUX.2 output capped at 4 MP | Layout boxes, no mask guarantee documented | No zero-retention option listed | API terms permit training and public display of inputs and outputs | Not checked | No: excluded for private photos without a written agreement |

Notes:

- OpenAI's models page lists GPT-Image-2.6 Sunburst and Flare and GPT-Image-2.5 Sunburst and Flare; none is marked deprecated. The pricing page also lists `gpt-image-2`, `gpt-image-1.5` and `gpt-image-1-mini` (OpenAI [models](https://developers.openai.com/api/docs/models), [image guide](https://developers.openai.com/api/docs/guides/image-generation), retrieved 2026-11-08).
- For `gpt-image-2`, OpenAI says to omit `input_fidelity`; custom sizes require each edge at most 3840 px, 655,360 to 8,294,400 total pixels, multiples of 16 and an aspect ratio between 1:3 and 3:1 (image guide, retrieved 2026-11-08).
- Google's guide lists `gemini-3.1-flash-lite-image` as not optimized for multi-reference edits, so it is not a candidate ([image generation guide](https://aistudio.google.com/docs/image-generation), retrieved 2026-11-08).
- Gemini 3-series image models think by default; thinking cannot be disabled in the API, thinking tokens are billed by default, and thinking level differs per model. Fix the level per benchmark arm.
- Vertex AI availability of Nano Banana 2.1 and Gemini 3.1 Flash Image was not verified. Gemini 3 Pro Image has a Vertex AI page listing the global region, 1K/2K/4K and 14 images per prompt ([Vertex AI model page](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-pro-image), retrieved 2026-11-08).
- Per-source-kind routing is permitted by [D-42](../decisions.md#d-42): a license for Street View imagery may require a specific processor, while uploads can use the selected vendor.

### Not candidates

| Option | Reason | Source |
| --- | --- | --- |
| Amazon Nova Canvas | Bedrock lifecycle reportedly lists Legacy 2026-03-30 and end-of-life 2026-09-30 (confirm on the AWS page) | [AWS Bedrock model lifecycle](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.md) |
| Midjourney | No official public API found | [third-party survey](https://myarchitectai.com/blog/midjourney-apis) |
| Adobe Firefly Services | Image Model 5 with Instruct Edit and native 4 MP documented; IP indemnity applies to "Eligible Firefly Features" (Generative Fill, Generative Expand) only if the customer's agreement links the product-description page; coverage of the API and Image Model 5, pricing and data terms unverified | [Firefly Services](https://developer.adobe.com/firefly-services/docs/firefly-api/), [product description](https://helpx.adobe.com/legal/product-descriptions/adobe-firefly.html) |
| Imagen, Runway, Recraft, Ideogram, Reve | Status, official edit pricing or terms not verified; not on the top-15 boards | [Ideogram pricing](https://ideogram.ai/api-pricing/) |

## Data, training and age terms

### Image-edit vendors

| Vendor | Training on inputs and outputs | Retention | Age terms | Output rights | Source |
| --- | --- | --- | --- | --- | --- |
| OpenAI API | Not used for training by default | Abuse-monitoring logs up to 30 days; `/v1/images/generations` and `/v1/images/edits` ZDR "Yes, with limitations"; ZDR-compatible image models: `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare` (and 2026-09-08 snapshots), `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1-mini`; 2.6 models absent; images flagged by OpenAI's child-safety classifier are retained for manual review even under ZDR | No hard 18+ ban found. "Under 18 API Guidance": developers serving minors add safeguards and comply with COPPA; do not process personal data of children under 13 without first implementing ZDR; age assurance recommended where appropriate; OpenAI may audit and suspend | Services agreement assigns input and output ownership between customer and OpenAI, subject to law, and requires necessary input rights (agreement page returned HTTP 403 on retrieval; summary only: verify) | [your-data](https://developers.openai.com/api/docs/guides/your-data), [under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance), [services agreement](https://openai.com/policies/services-agreement/) |
| Google Gemini API (paid tier) | Google does not use prompts or responses to improve its products; data processing addendum applies. Unpaid tier: human reviewers may read, annotate and process input and output | Not documented in the fetched pages for image endpoints (verify) | "You must be 18 years of age or older to use the APIs"; API clients directed at or likely to be accessed by under-18s are barred; EEA, UK and Switzerland: paid services only | Google does not claim ownership of generated content; this does not clear rights in input images | [Gemini API terms](https://ai.google.dev/gemini-api/terms), [AI Studio terms](https://aistudio.google.com/docs/terms) (quotes from a summarizing fetch: re-read before quoting externally) |
| Google Vertex AI | Google does not use customer data to train or fine-tune models without prior permission or instruction | ZDR needs configuration (request-response logging off, `store=false`, no Live session resumption, caching disabled); Google may log prompts to detect abuse; some advanced models may log prompts so ZDR may not be possible | Google Cloud Service Specific Terms (Generative AI Services, age restrictions) carry the same under-18 clause as the Gemini API, so Vertex AI is not a route around it (counsel confirms the reading) | Per Google Cloud terms (not read) | [Vertex AI data governance](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/data-governance), [Service Specific Terms](https://cloud.google.com/terms/service-terms) |
| Black Forest Labs API | Standard and EU API Service Terms permit using inputs and outputs to train and improve its technology and grant a license to publicly display them; no opt-out in the API terms; website terms discuss an opt-out but are a different contract | Retention text covers retrieval windows only | Not checked | Not checked | [API service terms](https://bfl.ai/legal/flux-api-service-terms), [EU terms](https://bfl.ai/legal/eu-api-service-terms) |
| Microsoft, ByteDance, Krea | Not verified | Not verified | Not verified | Not verified; one aggregator marks MAI-Image-2.7 commercial use "restricted" (secondary) | [llmreference MAI-Image-2.7](https://www.llmreference.com/model/mai-image-2-7) |

**Verify:** OpenAI ZDR status for `gpt-image-2.6-sunburst` and `gpt-image-2.6-flare` (owner: user, through OpenAI sales or support, before the 2.6 arms run on any photo that is not a permissioned benchmark photo).
**Verify:** Vertex AI availability of Nano Banana 2.1 (owner: engineering lead, with Google Cloud documentation or support, before Gate A).

### Implications for Hailiday

- The product is for adults ([D-17](../decisions.md#d-17)) but interior uploads can show children. Gemini's clause bars clients "likely to be accessed" by under-18s, Vertex AI carries the same clause, and photos of children are personal information under COPPA. OpenAI's guidance is a safeguards model. The product-side treatment is in [Audience and age](../specs/privacy-safety-legal.md#audience-and-age).
- "No training" is not "nothing is retained": OpenAI abuse-monitoring logs persist up to 30 days unless ZDR applies, and Vertex AI may log prompts for abuse detection.
- The provider receives the image and the decoration plan, not the address ([Data-handling rules](../specs/privacy-safety-legal.md#data-handling-rules)).

### Vision-language vendors (analysis and QA)

Candidate roster and selection are in [D-43](../decisions.md#d-43) and [Model roster](../specs/render-pipeline.md#model-roster).

| Vendor and model | Role | Price per million input / output tokens | Data terms |
| --- | --- | --- | --- |
| Anthropic `claude-sonnet-5-5` | Analysis and judging | $2 / $10 (Anthropic model table, cached 2026-10-06) | Not verified for this research |
| Anthropic `claude-haiku-5-5` | Triage | $0.10 / $0.50 (prompts up to 100K tokens) | Not verified |
| Anthropic `claude-opus-5-5` | Escalated judging | $4 / $20 | Not verified |
| OpenAI vision models | Comparison | Not collected | Same OpenAI API terms as above apply; model-level ZDR not checked for vision endpoints |
| Google Gemini vision models | Comparison | Not collected | Gemini API terms as above apply |

**Verify:** Anthropic commercial terms on training, retention, ZDR availability and under-18 clauses for the API, and the same for the comparison vision models (owner: engineering lead, before Gate A). Anthropic's structured outputs are requested through `output_config.format`, and prompt-cache reads cost $0.20 per million tokens on Sonnet 5.5 and Opus 5.5 ([Anthropic documentation](https://platform.claude.com/docs); model table cached 2026-10-06). An image of about 1024x1024 is roughly 1,400 input tokens (an estimate; verify with the token-counting endpoint).

## Pricing

List prices retrieved 2026-11-08 unless a row says otherwise. The costing rule and the per-attempt worksheet are in [Cost worksheet](../specs/economics.md#cost-worksheet); this section holds the raw vendor figures only.

| Model | Published price | Notes |
| --- | --- | --- |
| OpenAI `gpt-image-2`, 2.5 and 2.6 (Sunburst and Flare) | Image input $8.00 per million tokens (cached $2.00); image output $30.00 per million; text input $5.00 per million | Billed per token; no per-image table found for 2.5 or 2.6. Batch (2.5 and `gpt-image-2`): image input $4, output $15 per million; 2.6 not in the batch table |
| OpenAI GPT Image 2 (historical per-image table) | Low $0.006 / $0.005 / $0.005; medium $0.053 / $0.041 / $0.041; high $0.211 / $0.165 / $0.165 (1024x1024 / 1024x1536 / 1536x1024) | Not confirmed current for 2.5 or 2.6 |
| Artificial Analysis cross-check (1,000 images at 1024x1024, default settings) | GPT Image 2.6 Sunburst (max) $210.72; Nano Banana 2.1 $33.60; Seedream 5.0 Pro $90.00; Krea 3 Ultra $100.00; Nano Banana 2 $67.00 | Quality tier drives cost; run OpenAI medium and max as separate arms |
| Google Nano Banana 2.1 | $30 per million image output tokens: $0.0336 per 1K image, $0.0504 at 2K, $0.113 at 4K (retrieved 2026-11-09) | Thinking tokens billed |
| Google Gemini 3.1 Flash Image | $0.50 per million input, $60 per million image output: $0.067 per 1K image ($0.045 at 0.5K, $0.101 at 2K, $0.151 at 4K) | Previous generation |
| Google Gemini 3 Pro Image | $2.00 per million input, $120 per million output: $0.134 per 1K or 2K image, $0.24 at 4K | |
| Google Gemini 2.5 Flash Image | $0.039 per image | Deprecated; shutdown 2027-03-15 |
| BFL FLUX 3 Image | 768 px $0.041; 1K $0.048; 1.5K $0.07; 2K $0.10; 4K $0.607; references included | Excluded for private photos |
| BFL FLUX.2 (per megapixel, first / additional / reference) | max $0.07 / $0.03 / $0.03; pro $0.03 / $0.015 / $0.015; flex $0.05 each; klein 9B $0.015 / $0.002 / $0.002; klein 4B $0.014 / $0.001 / $0.001 | Output capped at 4 MP; Kontext max $0.08, pro $0.04 |
| Seedream 5.0 Pro | Reseller quotes $0.045 to $0.15; official price not verified | |
| Other (not candidates) | Ideogram 4.5 about $0.03 to $0.10 per image, Recraft image-to-image about $0.04, Reve 2.1 via resellers about $0.20 to $0.24 (all third-party, unverified) | |

Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Gemini pricing](https://aistudio.google.com/docs/pricing), [BFL pricing](https://bfl.ai/pricing), [Artificial Analysis editing leaderboard](https://artificialanalysis.ai/image/leaderboard/editing), all retrieved 2026-11-08.

The spread at 1024x1024 default settings runs from about $0.034 per image (Nano Banana 2.1 at 1K) to about $0.21 (GPT Image 2.6 Sunburst at max, as computed by Artificial Analysis). Model and quality tier are the largest controllable cost lever; the canonical cost illustration of about $0.13 for the image edit is in [Unit economics model](../specs/economics.md#unit-economics-model).

## Quality leaderboards

Snapshots from 2026-11-08. Both boards measure general edit preference across many subjects; neither measures preservation of a specific building or interior, so they inform the shortlist only. Boards move quickly: an older cached Artificial Analysis snapshot showed MAI-Image-2.5-Pro and Reve 2.1 leading.

**Arena, single-image edit** ([arena.ai](https://arena.ai/leaderboard/image/image-edit/single-image)). Ranks 1, 2, 3, 6, 7, 9 and 11 are marked Preliminary.

| Rank | Model | Score |
| --- | --- | --- |
| 1 | GPT-Image-2.5 Sunburst | 1520 (about 121k votes) |
| 2 | GPT-Image-2.5 Flare | 1485 |
| 3 | GPT-Image-2.6 Sunburst (Medium) | 1477 (about 3.5k votes) |
| 4 | MAI-Image-2.7-Preview | 1468 |
| 5 | GPT-Image-2 (Medium) | 1461 |
| 6 | GPT-Image-2.6 Flare | 1460 |
| 7 | Grok Imagine Image 2.0 | 1437 |
| 8 | MAI-Image-2.6 | 1428 |
| 9 | Nano Banana 2.1 | 1427 |
| 11 | Krea 3 Ultra | 1411 |
| 14 | Seedream 5.0 Pro | 1392 |

**Artificial Analysis editing, v2.1** ([artificialanalysis.ai](https://artificialanalysis.ai/image/leaderboard/editing)).

| Rank | Model | Score |
| --- | --- | --- |
| 1 | GPT Image 2.6 Sunburst (max) | 1209 |
| 2 | GPT Image 2.6 Flare (max) | 1206 |
| 3 | GPT Image 2.5 Sunburst (max) | 1199 |
| 4 | MAI-Image-2.7-Preview | 1195 |
| 5 | GPT Image 2.5 Flare (max) | 1182 |
| 6 | Krea 3 Ultra | 1152 |
| 7 | Nano Banana 2.1 | 1152 |
| 10 | GPT Image 2 (high) | 1136 |
| 11 | Seedream 5.0 Pro | 1129 |
| 13 | Nano Banana 2 | 1125 |

Caveats:

- No FLUX model appears in the top 15 of either board.
- The best open-weight model per Artificial Analysis's FAQ is Fibo 2.0 (1085, rank 25); Qwen-Image-Edit-2511 is on neither top-15 board.
- Arena places the 2.6 models below the 2.5 models, while Artificial Analysis places them above; the 2.6 sample on Arena is small (about 3.5k votes) and the two boards use different settings.
- Gemini 3 Pro Image is not in the extracted top ranks of either snapshot; its placement was not recorded.

## Provenance

Provenance mechanics for delivered files are in [Provenance and labeling](../specs/render-pipeline.md#provenance-and-labeling); policy is [D-28](../decisions.md#d-28). Vendor facts:

| Vendor | Signals on generated images | Status of the evidence |
| --- | --- | --- |
| OpenAI | A search summary of OpenAI's help article says images from ChatGPT, Codex and the API carry C2PA Content Credentials and SynthID watermarks; OpenAI's developer guide describes C2PA metadata, a SynthID watermark and a verification API and notes metadata is fragile and SynthID more durable but not guaranteed | The help article returned HTTP 403; the guide does not state that every API image carries both signals and does not mention the edits endpoint. **Verify:** test whether edit outputs are signed (owner: engineering lead, Phase 1) |
| Google Gemini | "All generated images include a SynthID watermark" (Gemini API image guide). Google Cloud documentation says images created with listed models (including `gemini-3-pro-image`) are automatically signed by Google LLC with C2PA | Whether Gemini Developer API outputs carry C2PA is unverified; secondary reports say SynthID plus C2PA are on by default for newer models and that the visible watermark can be hidden while invisible layers remain |
| All | C2PA is signed metadata: editing, converting or sharing a file can remove it, and Google treats modification by a non-C2PA tool as tampering that fails validation. SynthID may survive some transformations without guarantee | Re-encoding with sharp drops an embedded manifest; this is an inference, not a vendor statement |

Sources: [OpenAI content provenance guide](https://developers.openai.com/api/docs/guides/content-provenance.md), [OpenAI help article](https://help.openai.com/en/articles/8912793-provenance-signals-in-openai-generated-content), [Gemini image guide](https://aistudio.google.com/docs/image-generation), [Google Cloud content credentials](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/content-credentials), [PetaPixel, 2026-05-20](https://petapixel.com/2026/05/20/openai-gets-serious-about-detecting-fake-images/) (all retrieved 2026-11-08).

The California AI Transparency Act became operative 2026-08-02 for covered providers with over 1,000,000 monthly users; the applicability analysis is in [AI disclosure and provenance](../specs/privacy-safety-legal.md#ai-disclosure-and-provenance).

## Aggregators and open weights

| Option | Facts | Use in the plan |
| --- | --- | --- |
| fal | Hosts FLUX 3 Image Edit, Seedream 4.0 Edit, Nano Banana, Nano Banana Pro and 2.1 edit, GPT Image 2 and 2.5 Sunburst edit, Bria Fibo and Grok Imagine Pro Edit. Files are "available for at least 7 days by default"; media URLs are publicly accessible until expiry (an ACL option exists; per-request header `X-Fal-Object-Lifecycle-Preference`). Privacy policy has no explicit statement on training from API inputs or outputs; enterprise data is outside that policy; zero retention not mentioned ([FAQ](https://fal.ai/docs/documentation/model-apis/faq.md), [privacy](https://fal.ai/privacy)) | Benchmarking on permissioned images only; each aggregator is an added subprocessor and not used for user photos |
| Replicate | Lists FLUX.2 max and pro, Kontext, flux-3-image, Seedream 4, 4.5 and 5-lite, Nano Banana, Pro and 2.1, Qwen-Image-Edit, GPT-Image 1.5 and 2.6 (requires your own OpenAI key), Ideogram 4.5, Krea 3, Grok Imagine and Bria. API predictions: "all input parameters, output values, output files, and logs are automatically removed after an hour, by default"; page silent on training; no ZDR option; terms and data processing agreement not read ([collection](https://replicate.com/collections/image-editing), [data retention](https://replicate.com/docs/topics/predictions/data-retention)) | As fal |
| Qwen-Image-Edit-2511 | 20B model; model card states "Qwen-Image is licensed under Apache 2.0", which permits commercial use. Hosted on Replicate. Secondary guides say Qwen-Image 2.0 and 2.0 Pro are API-only and that Qwen-Image 2.1 is a reported open 7B model with an unverified license ([Hugging Face](https://huggingface.co/Qwen/Qwen-Image-Edit-2511)) | Contingency only. If both OpenAI and paid Gemini fail on terms or fidelity for private photos, the owner chooses between a managed open-weight host (adds a subprocessor) and self-hosting (needs separate approval); not a Phase 1 arm |
| FLUX.2 [klein] 9B and 4B | Open weights per BFL's API documentation ([docs index](https://docs.bfl.ml/llms.txt)); commercial weights for FLUX 3 Image are available "via license" per the model page | Same contingency family; license terms to read before any use |

## Claims register

Re-verify triggers apply to every row: a new model generation, a vendor terms change, or the start of the benchmark. All rows retrieved 2026-11-08 unless noted.

| ID | Claim | Source | Re-verify trigger |
| --- | --- | --- | --- |
| AI-01 | OpenAI lists GPT-Image-2.6 Sunburst and Flare and GPT-Image-2.5 Sunburst and Flare; none deprecated | https://developers.openai.com/api/docs/models | Benchmark start; any OpenAI model announcement |
| AI-02 | `gpt-image-2.6-sunburst` supports image edits, markup-guided edits and a complexity setting; single snapshot | https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst | Snapshot change |
| AI-03 | Edits mask is guidance only, needs alpha, applies to the first image, cannot combine with markup; quality values low to max; custom-size rules for `gpt-image-2` | https://developers.openai.com/api/docs/guides/image-generation | Benchmark start |
| AI-04 | Image pricing per token: $8 input, $2 cached, $30 output per million; batch $4 and $15 for 2.5 and `gpt-image-2`; no per-image table for 2.5 or 2.6 | https://developers.openai.com/api/docs/pricing | Monthly until Gate A; price change |
| AI-05 | Not used for training by default; abuse monitoring up to 30 days; ZDR-compatible image models listed; 2.6 absent; child-safety-flagged images retained under ZDR | https://developers.openai.com/api/docs/guides/your-data | Before any 2.6 live use; terms change |
| AI-06 | OpenAI under-18 guidance: safeguards, COPPA, ZDR before processing under-13 personal data | https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance | Terms change; counsel review |
| AI-07 | OpenAI and Gemini outputs carry provenance signals (C2PA and SynthID); OpenAI edit-output coverage unverified | https://developers.openai.com/api/docs/guides/content-provenance.md | Phase 1 device test |
| AI-08 | Google recommends Nano Banana 2.1 for new projects; Gemini 3.1 Flash Image labeled previous generation; reference limits and thinking behavior | https://aistudio.google.com/docs/image-generation | Google model announcement |
| AI-09 | Gemini 2.5 Flash Image shutdown 2027-03-15; preview image models lived four to eight months | https://aistudio.google.com/docs/deprecations | Each quarter until Gate A |
| AI-10 | Gemini pricing: Nano Banana 2.1 $0.0336 per 1K image (retrieved 2026-11-09); 3.1 Flash Image $0.067; 3 Pro Image $0.134 | https://aistudio.google.com/docs/pricing | Benchmark start |
| AI-11 | Gemini API terms: paid tier does not use content to improve products; 18+; clients directed at or likely accessed by under-18s barred; EEA, UK and Switzerland paid only | https://ai.google.dev/gemini-api/terms | Terms change; counsel review |
| AI-12 | Vertex AI: no training without permission; ZDR needs configuration; prompts may be logged for abuse detection; `gemini-3-pro-image` page lists 14 images per prompt | https://docs.cloud.google.com/vertex-ai/generative-ai/docs/data-governance | Before choosing the Vertex route |
| AI-13 | BFL API terms permit training on and public display of inputs and outputs, in standard and EU versions | https://bfl.ai/legal/flux-api-service-terms | Any BFL written agreement |
| AI-14 | BFL pricing for FLUX 3 Image and FLUX.2; no zero-retention option listed | https://bfl.ai/pricing | Only if BFL is reconsidered |
| AI-15 | Arena single-image-edit snapshot (top ranks and scores) | https://arena.ai/leaderboard/image/image-edit/single-image | Benchmark start |
| AI-16 | Artificial Analysis editing snapshot and cost per 1,000 images at default settings | https://artificialanalysis.ai/image/leaderboard/editing | Benchmark start |
| AI-17 | MAI-Image-2.7-Preview has no API per Artificial Analysis; terms unverified | https://artificialanalysis.ai/image/leaderboard/editing | Microsoft API announcement |
| AI-18 | Qwen-Image-Edit-2511 is Apache 2.0 | https://huggingface.co/Qwen/Qwen-Image-Edit-2511 | Contingency invoked |
| AI-19 | fal media URLs public for at least 7 days by default; Replicate removes API inputs and outputs after an hour by default | https://fal.ai/docs/documentation/model-apis/faq.md; https://replicate.com/docs/topics/predictions/data-retention | Any aggregator use |
| AI-20 | Nova Canvas reportedly end-of-life 2026-09-30; Midjourney has no official API (both secondary) | https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.md | Candidate re-scan |
| AI-21 | Claude model IDs and prices (`claude-sonnet-5-5` $2 / $10, `claude-opus-5-5` $4 / $20, `claude-haiku-5-5` $0.10 / $0.50 per million tokens), cached 2026-10-06 | https://platform.claude.com/docs | Price change; D-43 decision |
| AI-22 | Firefly IP indemnity covers only listed features and agreements that link the product-description page | https://helpx.adobe.com/legal/product-descriptions/adobe-firefly.html | Only if Firefly is reconsidered |
| AI-23 | Google Cloud Service Specific Terms (Generative AI Services, age restrictions) carry the same under-18 clause as the Gemini API, so it applies on Vertex AI | https://cloud.google.com/terms/service-terms | Terms change; counsel review |
