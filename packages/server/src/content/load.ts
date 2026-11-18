import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  ANCHOR_CATEGORIES,
  CLIMATE_CLASSES,
  CommerceCatalogSchema,
  HOLIDAY_IDS,
  HolidayPackSchema,
  LIGHTING_MODES,
  ProgramKindSchema,
  ProgramPlacementSchema,
  ProgramRightsSchema,
  SCENE_TYPES,
  SEARCH_QUERY_PLACEHOLDER,
  STYLES,
  SceneTypeSchema,
  SpecAttributesSchema,
  StyleKitSchema,
  packMajorMinor,
  packOfferFor,
} from '@hailiday/core';
import type {
  AnchorCategory,
  ClimateClass,
  CommerceCatalog,
  HolidayId,
  HolidayPack,
  LightingMode,
  ProgramKind,
  ProgramPlacement,
  ProgramRights,
  SceneType,
  SpecAttributes,
  Style,
  StyleKit,
} from '@hailiday/core';
import { sha256Hex } from '../ids/index.js';
import { SNOW_PATTERN } from '../pipeline/plan/phrases.js';
import { forbiddenViolations } from '../pipeline/plan/validator.js';

/** Default content directory: `packages/server/content` (sibling of `src` and `dist`). */
export const DEFAULT_CONTENT_DIR = fileURLToPath(new URL('../../content/', import.meta.url));
/** Default fixtures directory: `packages/server/fixtures`. */
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/', import.meta.url));

/** A content file failed validation; `issues` lists every problem found. */
export class ContentError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid content:\n  - ${issues.slice(0, 50).join('\n  - ')}`);
    this.name = 'ContentError';
    this.issues = issues;
  }
}

/** One validated holiday pack file with its publication fingerprint. */
export interface PackContent {
  holidayId: HolidayId;
  region: string;
  version: string;
  majorMinor: string;
  /** SHA-256 of the file bytes, stored as `holiday_pack_versions.content_sha256`. */
  sha256: string;
  /** Server-only path relative to the content directory (`packs/<holidayId>.yaml`). */
  contentRef: string;
  pack: HolidayPack;
}

/** A style kit validated by the core schema, plus the product each item currently maps to. */
export interface KitContent {
  kit: StyleKit;
  packVersion: string;
  /** `kitItemId` → product key from `currentProductId`, or null. */
  currentProducts: ReadonlyMap<string, string | null>;
}

/** Fields of a merchant program record beyond the core content schema. */
export interface MerchantProgramExtras {
  programType: string;
  subIdParam: string | null;
  trackingIds: { holidayId: string; channel: string; trackingId: string }[];
  statusHistory: { status: string; at: string; evidenceRef: string | null }[];
  logoPermitted: boolean;
  notes: string | null;
  /** `fixture` (example data) or `real` (an actual retailer). */
  kind: ProgramKind;
  /** `group` (in a decoration's group) or `separate` (a line of its own). */
  placement: ProgramPlacement;
  /** Link to the retailer's own search results, with a `{query}` placeholder. */
  searchUrlTemplate: string | null;
  /** Program-level tracking link pattern. */
  trackingLinkTemplate: string | null;
  /** What the program's terms allow, per use; a missing use is `unknown`. */
  displayRights: ProgramRights;
  /** Hours the program's data may be kept before it is refreshed. */
  refreshTermHours: number | null;
}

/** The words sent to a retailer's search for one kit item key. */
export interface SearchPhraseContent {
  kitItemKey: string;
  phrase: string;
  /** A different phrase for a program, by program key. */
  programOverrides: Record<string, string>;
}

/** A decoration typical of a look (holiday, scene type, style) that no kit item covers. */
export interface LookItemContent {
  lookItemKey: string;
  holidayId: HolidayId;
  sceneType: SceneType;
  style: Style;
  ourTitle: string;
  anchorCategory: AnchorCategory | null;
  searchPhrase: string;
  programOverrides: Record<string, string>;
  sortOrder: number;
}

/** Fields of an offer record beyond the core content schema. */
export interface OfferExtras {
  contentRightsEvidence: Record<'imageDisplay' | 'imageAiInput' | 'textUse', string | null>;
  verifiedByLabel: string | null;
}

export interface CommerceContent {
  catalog: CommerceCatalog;
  programExtras: ReadonlyMap<string, MerchantProgramExtras>;
  offerExtras: ReadonlyMap<string, OfferExtras>;
  /** One search phrase per kit item key of the kits content. */
  searchPhrases: SearchPhraseContent[];
  /** Decorations typical of a lavish look, each with its sort order within its look. */
  lookItems: LookItemContent[];
  /** Offer timestamps are authored relative to this instant. */
  authoredAt: string | null;
  /** Whether the seed shifts offer timestamps by (now − authoredAt). */
  rebaseTimestampsOnSeed: boolean;
}

export interface HeroCropSpec {
  focalPoint: { x: number; y: number };
  safeArea: [number, number, number, number];
}

/** One hero art specification (images are produced by a later seed step). */
export interface HeroContent {
  heroAssetId: string;
  holidayId: HolidayId | null;
  sceneType: SceneType | null;
  roomType?: string;
  title: string;
  lightingMode: LightingMode;
  altKey: string;
  altText: string;
  palette: string[];
  /** The licensed photograph the hero is cropped from (`content/photos` manifest ID). */
  photo?: { photoId: string };
  crops: Record<string, HeroCropSpec>;
  rights: Record<string, unknown>;
  approval: { approvedAt: string; approvedBy: string; approvedCrops: string[] };
}

export interface HeroCropConfig {
  aspect: string;
  master?: { width: number; height: number };
  renditionWidths?: number[];
  renditions?: { width: number; height: number }[];
  derivedFrom?: string;
  width?: number;
  height?: number;
}

/** One before/after example specification (images are produced by a later seed step). */
export interface ExampleContent {
  exampleId: string;
  holidayId: HolidayId;
  sceneType: SceneType;
  style: Style;
  lightingMode: LightingMode;
  source: Record<string, unknown>;
  packVersion: string;
  width: number;
  height: number;
  captionKey: string;
  rights: Record<string, unknown>;
  approval: { approvedAt: string; approvedBy: string };
}

export interface Content {
  dir: string;
  packs: PackContent[];
  kits: KitContent[];
  commerce: CommerceContent;
  heroes: HeroContent[];
  heroCrops: Record<string, HeroCropConfig>;
  heroFormats: string[];
  /** Byte budget of the hero rendition a phone loads first. */
  heroByteBudget: number | null;
  examples: ExampleContent[];
  genericScenes: Record<string, Record<string, unknown>>;
  climateClasses: Record<string, ClimateClass>;
  packFor(holidayId: HolidayId): PackContent | undefined;
  kitFor(holidayId: HolidayId, sceneType: SceneType): KitContent | undefined;
}

/** Splits `"green, red"` style lists; arrays pass through. */
function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeSpecAttributes(raw: unknown): SpecAttributes {
  const record = (raw ?? {}) as Record<string, unknown>;
  const candidate: Record<string, unknown> = { ...record, colorFamily: toList(record.colorFamily) };
  for (const key of ['countRange', 'sizeRange', 'material', 'lightColor']) {
    if (candidate[key] !== undefined && candidate[key] !== null)
      candidate[key] = String(candidate[key]);
    else delete candidate[key];
  }
  return SpecAttributesSchema.parse(candidate);
}

function zodIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${prefix}: ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
}

async function readText(dir: string, relative: string): Promise<{ text: string; bytes: Buffer }> {
  const bytes = await readFile(path.join(dir, relative));
  return { text: bytes.toString('utf8'), bytes };
}

const KitFileSchema = z.object({
  holidayId: z.enum(HOLIDAY_IDS),
  packId: z.string(),
  packVersion: z.string(),
  kits: z.array(
    z.object({
      kitId: z.string(),
      holidayId: z.enum(HOLIDAY_IDS),
      sceneType: SceneTypeSchema,
      version: z.string(),
      status: z.enum(['draft', 'published', 'retired']).default('published'),
      items: z.array(
        z.object({
          kitItemId: z.string(),
          sortOrder: z.int().nonnegative(),
          anchorCategory: z.string(),
          anchors: z.array(z.string()).min(1),
          specText: z.string(),
          specAttributes: z.unknown(),
          quantity: z.record(z.enum(STYLES), z.tuple([z.int(), z.int()])),
          required: z.array(z.enum(STYLES)).default([]),
          currentProductId: z.string().nullable().optional(),
        }),
      ),
    }),
  ),
});

const ProgramFileSchema = z.object({
  programs: z.array(z.record(z.string(), z.unknown())),
});

/** `https://`, a literal host with an optional port, then `/`: no placeholder before the path. */
const LITERAL_HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\//;
/** A query parameter that carries an affiliate ID, which only a tracking pattern may add. */
const AFFILIATE_PARAMETER = /[?&](tag|subid|sid|u1)=/i;
/** Placeholders of a tracking pattern, none of which a search pattern may hold. */
const TRACKING_PLACEHOLDERS = ['{subId}', '{trackingId}', '{destinationUrl}'] as const;
const DESTINATION_PLACEHOLDER = '{destinationUrl}';

/**
 * True for a search link pattern: `https://` and a literal host followed by `/`, a `{query}`
 * placeholder, no tracking placeholder and no affiliate parameter. The CHECK constraint on
 * `merchant_programs.search_url_template` (migration 0020) applies the same rule; keep the two in
 * step.
 */
export function isSearchUrlTemplate(value: string): boolean {
  return (
    LITERAL_HTTPS_ORIGIN.test(value) &&
    value.includes(SEARCH_QUERY_PLACEHOLDER) &&
    !TRACKING_PLACEHOLDERS.some((placeholder) => value.includes(placeholder)) &&
    !AFFILIATE_PARAMETER.test(value)
  );
}

/**
 * True for a program-level tracking link pattern: it holds `{destinationUrl}` and starts either
 * with that placeholder or with `https://` and a literal host followed by `/`. The CHECK
 * constraint on `merchant_programs.tracking_link_template` (migration 0020) applies the same
 * rule; keep the two in step.
 */
export function isTrackingLinkTemplate(value: string): boolean {
  return (
    value.includes(DESTINATION_PLACEHOLDER) &&
    (value.startsWith(DESTINATION_PLACEHOLDER) || LITERAL_HTTPS_ORIGIN.test(value))
  );
}

/** Plain words: letters, digits, spaces, hyphens and apostrophes, starting with a letter or digit. */
const SEARCH_PHRASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 '-]*$/;

/**
 * True for a search phrase: what a shopper types into a retailer's search box, as plain words of
 * 2 to 120 characters.
 */
export function isSearchPhrase(value: string): boolean {
  return value.length >= 2 && value.length <= 120 && SEARCH_PHRASE_PATTERN.test(value);
}

/** The program record fields Shop the look reads, beside the core content schema. */
const ProgramRecordSchema = z.object({
  kind: ProgramKindSchema,
  placement: ProgramPlacementSchema.default('group'),
  searchUrlTemplate: z
    .string()
    .refine(
      isSearchUrlTemplate,
      'must be an https:// URL on a literal host with a {query} placeholder, no other placeholder and no affiliate parameter',
    )
    .nullable()
    .default(null),
  trackingLinkTemplate: z
    .string()
    .refine(
      isTrackingLinkTemplate,
      'must hold {destinationUrl} and start with it or with an https:// URL on a literal host',
    )
    .nullable()
    .default(null),
  displayRights: ProgramRightsSchema.default({}),
  refreshTermHours: z.int().positive().nullable().default(null),
});

/** A search phrase: what a shopper types into a retailer's search box. */
const PhraseSchema = z
  .string()
  .min(2)
  .max(120)
  .regex(SEARCH_PHRASE_PATTERN, 'must be letters, digits, spaces, hyphens and apostrophes');
const ProgramOverridesSchema = z.record(z.string().min(1), PhraseSchema);

const SearchPhraseFileSchema = z.object({
  version: z.literal(1),
  description: z.string().optional(),
  phrases: z.array(
    z.strictObject({
      kitItemKey: z.string().min(1),
      phrase: PhraseSchema,
      programOverrides: ProgramOverridesSchema.default({}),
    }),
  ),
});

const LookItemFileSchema = z.object({
  version: z.literal(1),
  description: z.string().optional(),
  lookItems: z.array(
    z.strictObject({
      lookItemKey: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/),
      holidayId: z.enum(HOLIDAY_IDS),
      sceneType: SceneTypeSchema,
      style: z.enum(STYLES),
      ourTitle: z.string().min(2).max(120),
      anchorCategory: z.enum(ANCHOR_CATEGORIES).optional(),
      searchPhrase: PhraseSchema,
      programOverrides: ProgramOverridesSchema.default({}),
      sortOrder: z.int(),
    }),
  ),
});
const ProductFileSchema = z.object({ products: z.array(z.record(z.string(), z.unknown())) });
const OfferFileSchema = z.object({
  authoredAt: z.string().nullable().optional(),
  rebaseTimestampsOnSeed: z.boolean().optional(),
  offers: z.array(z.record(z.string(), z.unknown())),
});

const HeroFileSchema = z.object({
  crops: z.record(z.string(), z.record(z.string(), z.unknown())),
  formats: z.array(z.string()).default(['jpeg']),
  firstLoadByteBudget: z.int().positive().optional(),
  heroes: z.array(
    z.object({
      heroAssetId: z.string().min(1),
      holidayId: z.enum(HOLIDAY_IDS).nullable(),
      sceneType: SceneTypeSchema.nullable(),
      roomType: z.string().optional(),
      title: z.string(),
      lightingMode: z.enum(LIGHTING_MODES),
      altKey: z.string(),
      altText: z.string(),
      palette: z.array(z.string()).default([]),
      photo: z.object({ photoId: z.string().min(1) }).optional(),
      crops: z.record(
        z.string(),
        z.object({
          focalPoint: z.object({ x: z.number(), y: z.number() }),
          safeArea: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        }),
      ),
      rights: z.record(z.string(), z.unknown()),
      approval: z.object({
        approvedAt: z.string(),
        approvedBy: z.string(),
        approvedCrops: z.array(z.string()).default(['landscape', 'portrait']),
      }),
    }),
  ),
});

const ExampleFileSchema = z.object({
  genericScenes: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  examples: z.array(
    z.object({
      exampleId: z.string().min(1),
      holidayId: z.enum(HOLIDAY_IDS),
      sceneType: SceneTypeSchema,
      style: z.enum(STYLES),
      lightingMode: z.enum(LIGHTING_MODES),
      source: z.record(z.string(), z.unknown()),
      packVersion: z.string(),
      width: z.int().positive(),
      height: z.int().positive(),
      captionKey: z.string(),
      rights: z.record(z.string(), z.unknown()),
      approval: z.object({ approvedAt: z.string(), approvedBy: z.string() }),
    }),
  ),
});

const ClimateFileSchema = z.object({
  classes: z.record(z.string(), z.enum(CLIMATE_CLASSES)),
});

function rightsState(raw: unknown): { state: string; evidenceRef: string | null } {
  if (raw && typeof raw === 'object') {
    const value = raw as { state?: unknown; evidenceRef?: unknown };
    return {
      state: typeof value.state === 'string' ? value.state : 'unknown',
      evidenceRef: typeof value.evidenceRef === 'string' ? value.evidenceRef : null,
    };
  }
  return { state: typeof raw === 'string' ? raw : 'unknown', evidenceRef: null };
}

function mapCommerce(
  programs: Record<string, unknown>[],
  products: Record<string, unknown>[],
  offers: Record<string, unknown>[],
  issues: string[],
): {
  catalog: CommerceCatalog | null;
  programExtras: Map<string, MerchantProgramExtras>;
  offerExtras: Map<string, OfferExtras>;
} {
  const programExtras = new Map<string, MerchantProgramExtras>();
  const offerExtras = new Map<string, OfferExtras>();
  const str = (value: unknown) => (typeof value === 'string' ? value : null);

  const mappedPrograms = programs.map((program) => {
    const key = String(program.merchantProgramId ?? program.programKey ?? '');
    const record = ProgramRecordSchema.safeParse(program);
    if (!record.success) issues.push(...zodIssues(`merchant-programs.json ${key}`, record.error));
    programExtras.set(key, {
      kind: record.success ? record.data.kind : 'fixture',
      placement: record.success ? record.data.placement : 'group',
      searchUrlTemplate: record.success ? record.data.searchUrlTemplate : null,
      trackingLinkTemplate: record.success ? record.data.trackingLinkTemplate : null,
      displayRights: record.success ? record.data.displayRights : {},
      refreshTermHours: record.success ? record.data.refreshTermHours : null,
      programType: str(program.programType) ?? 'network',
      subIdParam: str(program.subIdParam),
      trackingIds: Array.isArray(program.trackingIds)
        ? (program.trackingIds as MerchantProgramExtras['trackingIds'])
        : [],
      statusHistory: Array.isArray(program.statusHistory)
        ? (program.statusHistory as MerchantProgramExtras['statusHistory'])
        : [],
      logoPermitted: program.logoPermitted === true,
      notes: str(program.notes),
    });
    return {
      programKey: key,
      displayName: program.merchantName ?? program.displayName ?? key,
      network: program.network,
      status: program.status,
      appliedAt: program.appliedAt ?? null,
      approvedAt: program.approvedAt ?? null,
      endedAt: program.endedAt ?? null,
      requiredDisclosureKey: program.requiredDisclosureKey ?? null,
      disclosureText: program.disclosureText ?? null,
      redirectPermitted: program.redirectPermitted ?? false,
      linkMethod: program.linkMethod ?? 'manual_links',
      subIdCapability: program.subIdCapability ?? false,
      apiAccess: program.apiAccess ?? 'none',
      attributionWindowHours: program.attributionWindowHours ?? null,
      commissionSchedule: program.commissionSchedule ?? [],
      policyVersion: program.policyVersion ?? null,
      reviewedAt: program.reviewedAt ?? null,
    };
  });

  const mappedProducts = products.map((product) => ({
    productKey: product.productId ?? product.productKey,
    kitItemIds: product.kitItemIds,
    ourTitle: product.ourTitle,
    ourDescription: product.ourDescription,
    category: product.category,
    specAttributes: (() => {
      try {
        return normalizeSpecAttributes(product.specAttributes);
      } catch (error) {
        issues.push(`products ${String(product.productId)}: specAttributes: ${String(error)}`);
        return product.specAttributes;
      }
    })(),
    archivedAt: product.archivedAt ?? null,
  }));

  const mappedOffers = offers.map((offer) => {
    const key = String(offer.offerId ?? offer.offerKey ?? '');
    const rights = (offer.contentRights ?? {}) as Record<string, unknown>;
    const imageDisplay = rightsState(rights.imageDisplay);
    const imageAiInput = rightsState(rights.imageAiInput);
    const textUse = rightsState(rights.textUse);
    offerExtras.set(key, {
      contentRightsEvidence: {
        imageDisplay: imageDisplay.evidenceRef,
        imageAiInput: imageAiInput.evidenceRef,
        textUse: textUse.evidenceRef,
      },
      verifiedByLabel: str(offer.verifiedBy),
    });
    return {
      offerKey: key,
      productKey: offer.productId ?? offer.productKey,
      merchantProgramKey: offer.merchantProgramId ?? offer.merchantProgramKey,
      merchantItemId: offer.merchantItemId,
      destinationCountry: offer.destinationCountry,
      currency: offer.currency,
      priceMinor: offer.priceMinor ?? null,
      priceSource: offer.priceSource ?? 'none',
      priceObservedAt: offer.priceObservedAt ?? null,
      availability: offer.availability ?? 'unknown',
      availabilityCheckedAt: offer.availabilityObservedAt ?? offer.availabilityCheckedAt ?? null,
      destinationUrl: offer.destinationUrl,
      trackingUrlTemplate: offer.trackingUrlTemplate ?? null,
      contentRights: {
        imageDisplay: imageDisplay.state,
        imageAiInput: imageAiInput.state,
        textUse: textUse.state,
      },
      status: offer.lifecycleStatus ?? offer.status,
      seasonalEligibility: offer.seasonalEligibility ?? [],
      sponsored: offer.sponsored ?? false,
      lastVerifiedAt: offer.lastVerifiedAt ?? null,
      verificationMethod: offer.verificationMethod ?? null,
      ...(typeof offer.notes === 'string' ? { notes: offer.notes } : {}),
    };
  });

  const parsed = CommerceCatalogSchema.safeParse({
    merchantPrograms: mappedPrograms,
    products: mappedProducts,
    offers: mappedOffers,
  });
  if (!parsed.success) {
    issues.push(...zodIssues('commerce', parsed.error));
    return { catalog: null, programExtras, offerExtras };
  }
  return { catalog: parsed.data, programExtras, offerExtras };
}

/** Problems in the program overrides of a phrase: every key must name a merchant program. */
function overrideIssues(
  where: string,
  overrides: Record<string, string>,
  programKeys: ReadonlySet<string>,
): string[] {
  return Object.keys(overrides)
    .filter((key) => !programKeys.has(key))
    .map((key) => `${where}: programOverrides names unknown program ${key}`);
}

/**
 * Checks the search phrases against the kits: one phrase per kit item key of the kits content,
 * none for a key that is not one, and none twice.
 */
export function searchPhraseIssues(
  phrases: readonly SearchPhraseContent[],
  kits: readonly KitContent[],
  programKeys: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const where = 'search-phrases.json';
  const kitItemKeys = new Set(kits.flatMap(({ kit }) => kit.items.map((item) => item.kitItemId)));
  const seen = new Set<string>();
  for (const phrase of phrases) {
    if (seen.has(phrase.kitItemKey)) issues.push(`${where}: ${phrase.kitItemKey} appears twice`);
    seen.add(phrase.kitItemKey);
    if (!kitItemKeys.has(phrase.kitItemKey)) {
      issues.push(`${where}: ${phrase.kitItemKey} is not a kit item key`);
    }
    issues.push(
      ...overrideIssues(`${where}: ${phrase.kitItemKey}`, phrase.programOverrides, programKeys),
    );
  }
  for (const key of [...kitItemKeys].sort()) {
    if (!seen.has(key)) issues.push(`${where}: kit item ${key} has no search phrase`);
  }
  return issues;
}

/**
 * Checks the look items against the packs: the pack offers the style for the scene type and its
 * section for the scene type has a lavish description; the key starts with
 * `<holidayId>.<sceneType>.<style>.`; keys are unique, and so is the sort order within a look.
 */
export function lookItemIssues(
  lookItems: readonly LookItemContent[],
  packs: readonly PackContent[],
  programKeys: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const keys = new Set<string>();
  const sortOrders = new Set<string>();
  for (const item of lookItems) {
    const where = `look-items.json: ${item.lookItemKey}`;
    const look = `${item.holidayId}.${item.sceneType}.${item.style}`;
    if (keys.has(item.lookItemKey)) issues.push(`${where}: appears twice`);
    keys.add(item.lookItemKey);
    if (!item.lookItemKey.startsWith(`${look}.`)) {
      issues.push(`${where}: the key must start with ${look}.`);
    }
    const sortKey = `${look}#${item.sortOrder}`;
    if (sortOrders.has(sortKey)) {
      issues.push(`${where}: sortOrder ${item.sortOrder} is used twice in the look ${look}`);
    }
    sortOrders.add(sortKey);
    const pack = packs.find((candidate) => candidate.holidayId === item.holidayId)?.pack;
    if (!pack) {
      issues.push(`${where}: no pack for ${item.holidayId}`);
      continue;
    }
    const section = pack.sceneSections[item.sceneType];
    if (!section) {
      issues.push(`${where}: pack ${pack.id} has no ${item.sceneType} section`);
      continue;
    }
    if (!section.promptFragments.lavish) {
      issues.push(`${where}: pack ${pack.id} has no lavish description for ${item.sceneType}`);
    }
    if (!packOfferFor(pack, item.sceneType)?.styles.includes(item.style)) {
      issues.push(`${where}: pack ${pack.id} does not offer ${item.style} for ${item.sceneType}`);
    }
    issues.push(...overrideIssues(where, item.programOverrides, programKeys));
  }
  return issues;
}

/** Reads a JSON content file, reporting a missing or malformed file as an issue. */
async function readJson(dir: string, relative: string, issues: string[]): Promise<unknown> {
  try {
    return JSON.parse((await readText(dir, relative)).text) as unknown;
  } catch (error) {
    issues.push(`${relative}: ${String(error)}`);
    return undefined;
  }
}

function crossCheckKit(
  kitFile: z.infer<typeof KitFileSchema>['kits'][number],
  pack: HolidayPack,
  issues: string[],
): void {
  const section = pack.sceneSections[kitFile.sceneType];
  const where = `kit ${kitFile.kitId}`;
  if (!section) {
    issues.push(`${where}: pack ${pack.id} has no ${kitFile.sceneType} section`);
    return;
  }
  if (section.kitId !== kitFile.kitId) issues.push(`${where}: pack kitId is ${section.kitId}`);
  const packItems = new Map(section.kit.map((item) => [item.kitItemId, item]));
  const kitIds = new Set(kitFile.items.map((item) => item.kitItemId));
  for (const id of packItems.keys()) {
    if (!kitIds.has(id)) issues.push(`${where}: missing kit item ${id} from the pack`);
  }
  for (const item of kitFile.items) {
    const packItem = packItems.get(item.kitItemId);
    if (!packItem) {
      issues.push(`${where}: kit item ${item.kitItemId} is not in the pack`);
      continue;
    }
    if (packItem.specText !== item.specText) {
      issues.push(`${where}: ${item.kitItemId} specText differs from the pack`);
    }
    if (packItem.anchors.join(',') !== item.anchors.join(',')) {
      issues.push(`${where}: ${item.kitItemId} anchors differ from the pack`);
    }
    for (const style of STYLES) {
      const fromPack = packItem.quantity[style];
      const fromKit = item.quantity[style];
      if (!fromKit || fromPack[0] !== fromKit[0] || fromPack[1] !== fromKit[1]) {
        issues.push(`${where}: ${item.kitItemId} quantity.${style} differs from the pack`);
      }
    }
    if ([...packItem.required].sort().join(',') !== [...item.required].sort().join(',')) {
      issues.push(`${where}: ${item.kitItemId} required differs from the pack`);
    }
  }
}

/**
 * Problems in a pack's lavish descriptions. `scene` and `decorations` reach the prompt as
 * written, so they may name nothing the pack forbids, and no snow, frost or icicles: a paragraph
 * cannot be left out for a photo without snow the way a single kit item is. `negative` is a list
 * of what must not appear and is not scanned.
 */
export function lavishTextIssues(pack: HolidayPack, where: string): string[] {
  const issues: string[] = [];
  for (const sceneType of SCENE_TYPES) {
    const lavish = pack.sceneSections[sceneType]?.promptFragments.lavish;
    if (!lavish) continue;
    for (const field of ['scene', 'decorations'] as const) {
      const text = lavish[field].replace(/\s+/g, ' ');
      const at = `${where}: sceneSections.${sceneType}.promptFragments.lavish.${field}`;
      for (const item of forbiddenViolations(pack.forbidden, [text])) {
        issues.push(`${at}: names the forbidden item ${item}`);
      }
      if (SNOW_PATTERN.test(text)) issues.push(`${at}: names snow, frost or icicles`);
    }
  }
  return issues;
}

/**
 * Problems in a pack's ordinary prompt texts: each section's `scene` fragment and the spec text of
 * each kit item reach a plan, and a plan that finds a forbidden item of the pack in them fails, so
 * the load refuses them first. The snow rule does not apply here: a kit item that names snow is
 * left out of a plan for a photo without snow.
 */
export function packTextIssues(pack: HolidayPack, where: string): string[] {
  const issues: string[] = [];
  for (const sceneType of SCENE_TYPES) {
    const section = pack.sceneSections[sceneType];
    if (!section) continue;
    const texts = [
      {
        at: `sceneSections.${sceneType}.promptFragments.scene`,
        text: section.promptFragments.scene,
      },
      ...section.kit.map((item, index) => ({
        at: `sceneSections.${sceneType}.kit.${index}.specText (${item.kitItemId})`,
        text: item.specText,
      })),
    ];
    for (const { at, text } of texts) {
      for (const item of forbiddenViolations(pack.forbidden, [text.replace(/\s+/g, ' ')])) {
        issues.push(`${where}: ${at}: names the forbidden item ${item}`);
      }
    }
  }
  return issues;
}

/**
 * Reads and validates the server-only content: holiday packs (with cross-field rules), style
 * kits (checked against their packs), the commerce catalog, hero and example specifications and
 * the climate table. Every problem is collected and reported together in a `ContentError`.
 */
export async function loadContent(options: { dir?: string } = {}): Promise<Content> {
  const dir = options.dir ?? DEFAULT_CONTENT_DIR;
  const issues: string[] = [];
  const packs: PackContent[] = [];
  const kits: KitContent[] = [];

  for (const holidayId of HOLIDAY_IDS) {
    const contentRef = `packs/${holidayId}.yaml`;
    let raw: { text: string; bytes: Buffer };
    try {
      raw = await readText(dir, contentRef);
    } catch {
      continue;
    }
    const parsed = HolidayPackSchema.safeParse(parseYaml(raw.text, { uniqueKeys: true }));
    if (!parsed.success) {
      issues.push(...zodIssues(contentRef, parsed.error));
      continue;
    }
    const pack = parsed.data;
    issues.push(...packTextIssues(pack, contentRef));
    issues.push(...lavishTextIssues(pack, contentRef));
    if (pack.holidayId !== holidayId) {
      issues.push(`${contentRef}: holidayId ${pack.holidayId} does not match the file name`);
    }
    packs.push({
      holidayId: pack.holidayId,
      region: pack.region,
      version: pack.version,
      majorMinor: packMajorMinor(pack.version),
      sha256: sha256Hex(raw.bytes),
      contentRef,
      pack,
    });
  }
  if (packs.length === 0) issues.push(`no holiday packs found under ${dir}`);

  for (const pack of packs) {
    const relative = `kits/${pack.holidayId}.yaml`;
    let raw: { text: string };
    try {
      raw = await readText(dir, relative);
    } catch {
      issues.push(`${relative}: missing kit file for pack ${pack.pack.id}`);
      continue;
    }
    const file = KitFileSchema.safeParse(parseYaml(raw.text, { uniqueKeys: true }));
    if (!file.success) {
      issues.push(...zodIssues(relative, file.error));
      continue;
    }
    if (file.data.packVersion !== pack.version) {
      issues.push(`${relative}: packVersion ${file.data.packVersion} differs from ${pack.version}`);
    }
    for (const kitFile of file.data.kits) {
      crossCheckKit(kitFile, pack.pack, issues);
      let items;
      try {
        items = kitFile.items.map((item) => ({
          kitItemId: item.kitItemId,
          anchorCategory: item.anchorCategory,
          anchorCategories: item.anchors,
          specText: item.specText,
          specAttributes: normalizeSpecAttributes(item.specAttributes),
          styleQuantities: Object.fromEntries(
            STYLES.map((style) => {
              const [min, max] = item.quantity[style] ?? [0, 0];
              return [style, { min, max }];
            }),
          ),
          sortOrder: item.sortOrder,
        }));
      } catch (error) {
        issues.push(`${relative}: ${kitFile.kitId}: ${String(error)}`);
        continue;
      }
      const kit = StyleKitSchema.safeParse({
        kitKey: kitFile.kitId,
        holidayId: kitFile.holidayId,
        sceneType: kitFile.sceneType,
        version: kitFile.version,
        status: kitFile.status,
        items,
      });
      if (!kit.success) {
        issues.push(...zodIssues(`${relative} ${kitFile.kitId}`, kit.error));
        continue;
      }
      kits.push({
        kit: kit.data,
        packVersion: file.data.packVersion,
        currentProducts: new Map(
          kitFile.items.map((item) => [item.kitItemId, item.currentProductId ?? null]),
        ),
      });
    }
  }

  const programFile = ProgramFileSchema.safeParse(
    JSON.parse((await readText(dir, 'commerce/merchant-programs.json')).text),
  );
  const productFile = ProductFileSchema.safeParse(
    JSON.parse((await readText(dir, 'commerce/products.json')).text),
  );
  const offerFile = OfferFileSchema.safeParse(
    JSON.parse((await readText(dir, 'commerce/offers.json')).text),
  );
  let commerce: CommerceContent = {
    catalog: { merchantPrograms: [], products: [], offers: [] },
    programExtras: new Map(),
    offerExtras: new Map(),
    searchPhrases: [],
    lookItems: [],
    authoredAt: null,
    rebaseTimestampsOnSeed: false,
  };
  if (!programFile.success) issues.push(...zodIssues('merchant-programs.json', programFile.error));
  if (!productFile.success) issues.push(...zodIssues('products.json', productFile.error));
  if (!offerFile.success) issues.push(...zodIssues('offers.json', offerFile.error));
  if (programFile.success && productFile.success && offerFile.success) {
    const mapped = mapCommerce(
      programFile.data.programs,
      productFile.data.products,
      offerFile.data.offers,
      issues,
    );
    if (mapped.catalog) {
      commerce = {
        catalog: mapped.catalog,
        programExtras: mapped.programExtras,
        offerExtras: mapped.offerExtras,
        searchPhrases: [],
        lookItems: [],
        authoredAt: offerFile.data.authoredAt ?? null,
        rebaseTimestampsOnSeed: offerFile.data.rebaseTimestampsOnSeed ?? false,
      };
      const kitItemIds = new Set(
        kits.flatMap(({ kit }) => kit.items.map((item) => item.kitItemId)),
      );
      const productKeys = new Set(mapped.catalog.products.map((product) => product.productKey));
      for (const product of mapped.catalog.products) {
        for (const id of product.kitItemIds) {
          if (!kitItemIds.has(id))
            issues.push(`products ${product.productKey}: unknown kit item ${id}`);
        }
      }
      for (const { kit, currentProducts } of kits) {
        for (const [kitItemId, productKey] of currentProducts) {
          if (productKey && !productKeys.has(productKey)) {
            issues.push(`kit ${kit.kitKey}: ${kitItemId} names unknown product ${productKey}`);
          }
        }
      }
    }
  }

  const programKeys = new Set(commerce.catalog.merchantPrograms.map((p) => p.programKey));
  const phraseJson = await readJson(dir, 'commerce/search-phrases.json', issues);
  const phraseFile = SearchPhraseFileSchema.safeParse(phraseJson);
  if (phraseFile.success) {
    const phrases = phraseFile.data.phrases;
    issues.push(...searchPhraseIssues(phrases, kits, programKeys));
    commerce.searchPhrases = phrases;
  } else if (phraseJson !== undefined) {
    issues.push(...zodIssues('search-phrases.json', phraseFile.error));
  }
  const lookItemJson = await readJson(dir, 'commerce/look-items.json', issues);
  const lookItemFile = LookItemFileSchema.safeParse(lookItemJson);
  if (lookItemFile.success) {
    const lookItems = lookItemFile.data.lookItems.map((item) => ({
      ...item,
      anchorCategory: item.anchorCategory ?? null,
    }));
    issues.push(...lookItemIssues(lookItems, packs, programKeys));
    commerce.lookItems = lookItems;
  } else if (lookItemJson !== undefined) {
    issues.push(...zodIssues('look-items.json', lookItemFile.error));
  }

  const heroFile = HeroFileSchema.safeParse(JSON.parse((await readText(dir, 'heroes.json')).text));
  if (!heroFile.success) issues.push(...zodIssues('heroes.json', heroFile.error));
  const exampleFile = ExampleFileSchema.safeParse(
    JSON.parse((await readText(dir, 'examples.json')).text),
  );
  if (!exampleFile.success) issues.push(...zodIssues('examples.json', exampleFile.error));
  const climateFile = ClimateFileSchema.safeParse(
    JSON.parse((await readText(dir, 'climate-classes.json')).text),
  );
  if (!climateFile.success) issues.push(...zodIssues('climate-classes.json', climateFile.error));

  if (issues.length > 0) throw new ContentError(issues);

  const heroes = heroFile.success ? (heroFile.data.heroes as HeroContent[]) : [];
  const examples = exampleFile.success ? (exampleFile.data.examples as ExampleContent[]) : [];
  for (const example of examples) {
    if (!SCENE_TYPES.includes(example.sceneType)) continue;
    const pack = packs.find((candidate) => candidate.holidayId === example.holidayId);
    if (pack && pack.version !== example.packVersion) {
      issues.push(`examples ${example.exampleId}: packVersion differs from ${pack.version}`);
    }
  }
  if (issues.length > 0) throw new ContentError(issues);

  return {
    dir,
    packs,
    kits,
    commerce,
    heroes,
    heroCrops: heroFile.success
      ? (heroFile.data.crops as unknown as Record<string, HeroCropConfig>)
      : {},
    heroFormats: heroFile.success ? heroFile.data.formats : ['jpeg'],
    heroByteBudget: heroFile.success ? (heroFile.data.firstLoadByteBudget ?? null) : null,
    examples,
    genericScenes: exampleFile.success ? exampleFile.data.genericScenes : {},
    climateClasses: climateFile.success ? climateFile.data.classes : {},
    packFor: (holidayId) => packs.find((pack) => pack.holidayId === holidayId),
    kitFor: (holidayId, sceneType) =>
      kits.find(({ kit }) => kit.holidayId === holidayId && kit.sceneType === sceneType),
  };
}

/** Reads a pack file by its `content_ref` (workers load the stamped version this way). */
export async function readPackByRef(
  contentRef: string,
  options: { dir?: string; expectedSha256?: string } = {},
): Promise<HolidayPack> {
  if (!/^packs\/[a-z_]+\.yaml$/.test(contentRef)) {
    throw new ContentError([`unexpected content_ref ${contentRef}`]);
  }
  const { text, bytes } = await readText(options.dir ?? DEFAULT_CONTENT_DIR, contentRef);
  if (options.expectedSha256 && sha256Hex(bytes) !== options.expectedSha256) {
    throw new ContentError([`${contentRef}: content changed since it was published`]);
  }
  const parsed = HolidayPackSchema.safeParse(parseYaml(text, { uniqueKeys: true }));
  if (!parsed.success) throw new ContentError(zodIssues(contentRef, parsed.error));
  const textIssues = [
    ...packTextIssues(parsed.data, contentRef),
    ...lavishTextIssues(parsed.data, contentRef),
  ];
  if (textIssues.length > 0) throw new ContentError(textIssues);
  return parsed.data;
}
