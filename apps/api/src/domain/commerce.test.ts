import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CommerceMode, ProgramKind, ProgramRights } from '@hailiday/core';
import type { CapabilityMode } from '@hailiday/server/capabilities';
import type { MerchantProgram, Offer } from '@hailiday/server/db';
import {
  fillSearchTemplate,
  fillTrackingTemplate,
  hrefOf,
  isHttpsLink,
  issueClickToken,
  linkModeFor,
  optionLinkOf,
  orderOptions,
  programServed,
  rotationOf,
  searchLinksOf,
  subIdOf,
  verifyClickToken,
} from './commerce.js';

const NOW = new Date('2026-11-20T17:00:00.000Z');

const ALLOWED: ProgramRights = {
  tracked_product_links: { state: 'allowed', evidence: 'Signed terms', recordedAt: null },
  tracked_search_links: { state: 'allowed', evidence: 'Signed terms', recordedAt: null },
  beside_ai_picture: { state: 'allowed', evidence: 'Signed terms', recordedAt: null },
  beside_other_retailers: { state: 'allowed', evidence: 'Signed terms', recordedAt: null },
};

function program(overrides: Partial<MerchantProgram> = {}): MerchantProgram {
  const programKey = overrides.programKey ?? `program_${randomUUID().slice(0, 8)}`;
  return {
    id: randomUUID(),
    programKey,
    displayName: programKey,
    programType: 'network',
    network: 'test',
    status: 'planned',
    statusHistory: [],
    linkMethod: 'manual_links',
    subIdCapability: false,
    subIdParam: null,
    trackingIds: [],
    apiAccess: 'none',
    attributionWindowHours: null,
    commissionSchedule: [],
    policyVersion: null,
    kind: 'fixture',
    placement: 'group',
    searchUrlTemplate: `https://example.com/${programKey}/search?q={query}`,
    trackingLinkTemplate: null,
    displayRights: {},
    refreshTermHours: null,
    ...overrides,
  } as MerchantProgram;
}

function offer(merchantProgramId: string, overrides: Partial<Offer> = {}): Offer {
  return {
    id: randomUUID(),
    merchantProgramId,
    productId: 'product',
    availability: 'in_stock',
    priceSource: 'feed',
    priceMinor: 2999,
    priceObservedAt: new Date(NOW.getTime() - 60_000),
    currency: 'USD',
    destinationUrl: 'https://example.com/p/item',
    trackingUrlTemplate: null,
    sponsored: false,
    ...overrides,
  } as Offer;
}

describe('option order', () => {
  it('never follows commission, attribution window or program status', () => {
    const generous = program({
      status: 'approved',
      attributionWindowHours: 720,
      commissionSchedule: [{ category: 'decor', ratePercent: 12, effectiveFrom: '2026-01-01' }],
    });
    const modest = program({ status: 'planned', attributionWindowHours: 24 });
    for (const assetId of ['asset-a', 'asset-b', 'asset-c', 'asset-d']) {
      const rotation = rotationOf(assetId, [generous, modest]);
      const candidates = [generous, modest].map((p) => ({ program: p, offer: offer(p.id) }));
      const { ordered, reason } = orderOptions(candidates, rotation, NOW);
      expect(ordered.map((entry) => entry.program.id)).toEqual(rotation.map((p) => p.id));
      expect(reason).toBe('retailer_rotation');
    }
  });

  it('spreads options across programs round-robin in rotation order', () => {
    const [first, second, third] = rotationOf('asset-spread', [
      program(),
      program(),
      program(),
    ]) as [MerchantProgram, MerchantProgram, MerchantProgram];
    const candidates = [
      ...[1, 2, 3].map(() => ({ program: first, offer: offer(first.id) })),
      ...[1, 2].map(() => ({ program: second, offer: offer(second.id) })),
      { program: third, offer: offer(third.id) },
    ];
    const { ordered } = orderOptions(candidates, [first, second, third], NOW);
    expect(ordered.map((entry) => entry.program.id)).toEqual([
      first.id,
      second.id,
      third.id,
      first.id,
      second.id,
      first.id,
    ]);
    const firstOffers = ordered.filter((entry) => entry.program.id === first.id);
    const ids = firstOffers.map((entry) => entry.offer.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('puts in stock, then a displayable price, ahead of the rotation', () => {
    const [first, second] = rotationOf('asset-stock', [program(), program()]) as [
      MerchantProgram,
      MerchantProgram,
    ];
    const unknownStock = { program: first, offer: offer(first.id, { availability: 'unknown' }) };
    const noPrice = { program: first, offer: offer(first.id, { priceSource: 'none' }) };
    const stale = {
      program: first,
      offer: offer(first.id, { priceObservedAt: new Date(NOW.getTime() - 2 * 86_400_000) }),
    };
    const best = { program: second, offer: offer(second.id) };
    expect(orderOptions([unknownStock, best], [first, second], NOW)).toMatchObject({
      ordered: [best, unknownStock],
      reason: 'in_stock',
    });
    expect(orderOptions([noPrice, best], [first, second], NOW)).toMatchObject({
      ordered: [best, noPrice],
      reason: 'price_displayable',
    });
    expect(orderOptions([stale, best], [first, second], NOW).reason).toBe('price_displayable');
  });

  it('names a single offer, offers of one program and no offer', () => {
    const only = program();
    const one = { program: only, offer: offer(only.id) };
    const two = { program: only, offer: offer(only.id) };
    expect(orderOptions([one], [only], NOW).reason).toBe('single_offer');
    expect(orderOptions([one, two], [only], NOW).reason).toBe('offer_id');
    expect(orderOptions([], [only], NOW).reason).toBe('no_offer');
  });
});

describe('rotation', () => {
  const programs = Array.from({ length: 5 }, (_, index) => program({ programKey: `p${index}` }));

  it('is stable for a rendering', () => {
    const keys = rotationOf('asset-1', programs).map((p) => p.programKey);
    expect(rotationOf('asset-1', [...programs].reverse()).map((p) => p.programKey)).toEqual(keys);
  });

  it('differs between renderings', () => {
    const orders = new Set(
      Array.from({ length: 12 }, (_, index) =>
        rotationOf(`asset-${index}`, programs)
          .map((p) => p.programKey)
          .join(','),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('search links', () => {
  it('encodes the phrase into the pattern', () => {
    expect(fillSearchTemplate('https://example.com/s?q={query}', 'lights & bows/#1 "red"')).toBe(
      'https://example.com/s?q=lights%20%26%20bows%2F%231%20%22red%22',
    );
    expect(fillSearchTemplate('https://example.com/s/{query}', 'a?b=c')).toBe(
      'https://example.com/s/a%3Fb%3Dc',
    );
  });

  it('uses only the stored pattern and the override or the phrase', () => {
    const decor = program({ programKey: 'decor' });
    const shop = program({ programKey: 'shop', placement: 'separate' });
    const none = program({ programKey: 'none', searchUrlTemplate: null });
    const { searchLinks, separateLinks } = searchLinksOf([decor, shop, none], {
      phrase: 'warm white lights',
      programOverrides: { shop: 'string lights&tag=evil' },
      holidayId: 'christmas',
    });
    expect(searchLinks.map((link) => link.destination)).toEqual([
      'https://example.com/decor/search?q=warm%20white%20lights',
    ]);
    expect(separateLinks.map((link) => link.destination)).toEqual([
      'https://example.com/shop/search?q=string%20lights%26tag%3Devil',
    ]);
    expect(
      searchLinksOf([decor], { phrase: null, programOverrides: {}, holidayId: 'christmas' })
        .searchLinks,
    ).toEqual([]);
  });

  it('drops a link that would not be https', () => {
    const tracked = program({
      status: 'approved',
      displayRights: ALLOWED,
      trackingLinkTemplate: 'https://network.example/c?u={destinationUrl}',
    });
    const dropped: string[] = [];
    const insecure = program({
      ...tracked,
      id: randomUUID(),
      programKey: 'insecure',
      searchUrlTemplate: 'http://example.com/s?q={query}',
    });
    const insecureTracking = program({
      ...tracked,
      id: randomUUID(),
      programKey: 'insecure_tracking',
      trackingLinkTemplate: 'http://network.example/c?u={destinationUrl}',
    });
    const result = searchLinksOf([insecure, insecureTracking, tracked], {
      phrase: 'wreath',
      programOverrides: {},
      holidayId: 'christmas',
      onDropped: (link) => dropped.push(link.program.programKey),
    });
    expect(result.searchLinks.map((link) => link.program.id)).toEqual([tracked.id]);
    expect(dropped).toEqual(['insecure', 'insecure_tracking']);

    const option = optionLinkOf(
      {
        program: tracked,
        offer: offer(tracked.id, {
          trackingUrlTemplate: 'http://tracker.example/c?u={destinationUrl}',
        }),
      },
      'christmas',
    );
    expect(option.linkMode).toBe('tracking');
    expect(isHttpsLink(option)).toBe(false);
    const safe = optionLinkOf({ program: tracked, offer: offer(tracked.id) }, 'christmas');
    expect(isHttpsLink(safe)).toBe(true);
  });
});

describe('link mode', () => {
  const tracked = program({
    status: 'approved',
    displayRights: ALLOWED,
    trackingLinkTemplate: 'https://network.example/c?u={destinationUrl}',
  });
  const template = tracked.trackingLinkTemplate;

  it('is tracking when every condition holds', () => {
    expect(linkModeFor(tracked, 'product', template, null)).toBe('tracking');
    expect(linkModeFor(tracked, 'search', template, null)).toBe('tracking');
    expect(linkModeFor({ ...tracked, status: 'provisional' }, 'search', template, null)).toBe(
      'tracking',
    );
  });

  it('is plain for each missing condition', () => {
    const without = (use: keyof typeof ALLOWED) => {
      const rights: ProgramRights = { ...ALLOWED };
      delete rights[use];
      return { ...tracked, displayRights: rights };
    };
    const denied = (use: keyof typeof ALLOWED): MerchantProgram => ({
      ...tracked,
      displayRights: {
        ...ALLOWED,
        [use]: { state: 'denied', evidence: 'Terms', recordedAt: null },
      },
    });
    for (const status of ['planned', 'applied', 'suspended', 'declined'] as const) {
      expect(linkModeFor({ ...tracked, status }, 'product', template, null)).toBe('plain');
    }
    expect(linkModeFor(tracked, 'product', null, null)).toBe('plain');
    expect(linkModeFor(without('tracked_product_links'), 'product', template, null)).toBe('plain');
    expect(linkModeFor(without('tracked_product_links'), 'search', template, null)).toBe(
      'tracking',
    );
    expect(linkModeFor(without('tracked_search_links'), 'search', template, null)).toBe('plain');
    expect(linkModeFor(denied('beside_ai_picture'), 'product', template, null)).toBe('plain');
    expect(linkModeFor(denied('beside_other_retailers'), 'search', template, null)).toBe('plain');
    expect(
      linkModeFor(
        { ...without('beside_other_retailers'), placement: 'separate' },
        'search',
        template,
        null,
      ),
    ).toBe('tracking');
    const unknown: MerchantProgram = {
      ...tracked,
      displayRights: {
        ...ALLOWED,
        beside_ai_picture: { state: 'unknown', evidence: null, recordedAt: null },
      },
    };
    expect(linkModeFor(unknown, 'product', template, null)).toBe('plain');
  });

  it('is plain when the template needs a tracking ID the program lacks for the holiday', () => {
    const withTag = '{destinationUrl}&tag={trackingId}';
    expect(linkModeFor(tracked, 'product', withTag, null)).toBe('plain');
    expect(linkModeFor(tracked, 'search', withTag, 'tag-20')).toBe('tracking');

    const tagged = program({
      status: 'approved',
      placement: 'separate',
      displayRights: ALLOWED,
      trackingLinkTemplate: withTag,
      trackingIds: [{ holidayId: 'christmas', channel: 'direct', trackingId: 'xmas-20' }],
    });
    // An option: tracking for the holiday with a tracking ID, plain for one without.
    const candidate = { program: tagged, offer: offer(tagged.id) };
    const christmasOption = optionLinkOf(candidate, 'christmas');
    expect(christmasOption).toMatchObject({ linkMode: 'tracking', template: withTag });
    expect(hrefOf(christmasOption, null)).toBe('https://example.com/p/item&tag=xmas-20');
    const halloweenOption = optionLinkOf(candidate, 'halloween');
    expect(halloweenOption).toMatchObject({ linkMode: 'plain', template: null });
    expect(hrefOf(halloweenOption, null)).toBe('https://example.com/p/item');

    // A separate link follows the same rule.
    const separateOf = (holidayId: string) =>
      searchLinksOf([tagged], { phrase: 'wreath', programOverrides: {}, holidayId })
        .separateLinks[0];
    expect(separateOf('christmas')?.linkMode).toBe('tracking');
    const plain = separateOf('halloween');
    expect(plain).toMatchObject({ linkMode: 'plain', template: null });
    expect(plain && hrefOf(plain, null)).toBe(
      `https://example.com/${tagged.programKey}/search?q=wreath`,
    );
  });
});

describe('programServed', () => {
  it('serves fixture programs only in fixture mode and real programs only live in real mode', () => {
    const kinds: ProgramKind[] = ['fixture', 'real'];
    const modes: CapabilityMode[] = ['fixture', 'live', 'unavailable'];
    const commerceModes: CommerceMode[] = ['fixture', 'real'];
    const served: string[] = [];
    for (const kind of kinds) {
      for (const mode of modes) {
        for (const commerceMode of commerceModes) {
          if (programServed(kind, mode, commerceMode))
            served.push(`${kind}/${mode}/${commerceMode}`);
        }
      }
    }
    expect(served).toEqual(['fixture/fixture/fixture', 'real/live/real']);
  });
});

describe('click tokens and sub-IDs', () => {
  it('binds a token to its session and target', () => {
    const target = randomUUID();
    const token = issueClickToken('secret', 'session-a', target);
    expect(verifyClickToken('secret', 'session-a', token)).toBe(target);
    expect(verifyClickToken('secret', 'session-b', token)).toBeNull();
    expect(verifyClickToken('other', 'session-a', token)).toBeNull();
    expect(verifyClickToken('secret', 'session-a', `${token}AA`)).toBeNull();
  });

  it('accepts only the canonical spelling of a token', () => {
    const target = randomUUID();
    const token = issueClickToken('secret', 'session-a', target);
    // 34 bytes leave four spare bits in the last character, so a changed last character can
    // decode to the same bytes.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const respelled = [...alphabet]
      .map((character) => `${token.slice(0, -1)}${character}`)
      .filter(
        (candidate) =>
          candidate !== token &&
          Buffer.from(candidate, 'base64url').equals(Buffer.from(token, 'base64url')),
      );
    expect(respelled.length).toBeGreaterThan(0);
    for (const candidate of [...respelled, `${token}=`, `${token}==`]) {
      expect(Buffer.from(candidate, 'base64url').equals(Buffer.from(token, 'base64url'))).toBe(
        true,
      );
      expect(verifyClickToken('secret', 'session-a', candidate), candidate).toBeNull();
    }
    expect(verifyClickToken('secret', 'session-a', token)).toBe(target);
  });

  it('sends an opaque sub-ID derived from the token', () => {
    const target = randomUUID();
    const token = issueClickToken('secret', 'session-a', target);
    const subId = subIdOf(token);
    expect(subId).toMatch(/^[0-9a-f]{64}$/);
    expect(subIdOf(token)).toBe(subId);
    const sameTarget = issueClickToken('secret', 'session-a', target);
    expect(sameTarget).not.toBe(token);
    expect(subIdOf(sameTarget)).not.toBe(subId);
    expect(subId).not.toContain(target.replace(/-/g, ''));
    expect(subId).not.toContain(Buffer.from(token, 'base64url').toString('hex').slice(0, 16));
  });

  it('fills a tracking template around the plain link', () => {
    const tracked = program({
      status: 'approved',
      subIdCapability: true,
      displayRights: ALLOWED,
      trackingLinkTemplate: 'https://network.example/c?sub={subId}&u={destinationUrl}',
    });
    const link = searchLinksOf([tracked], {
      phrase: 'wreath',
      programOverrides: {},
      holidayId: 'christmas',
    }).searchLinks[0];
    if (!link) throw new Error('no search link');
    const href = hrefOf(link, 'abc123');
    expect(href).toBe(
      `https://network.example/c?sub=abc123&u=${encodeURIComponent(
        `https://example.com/${tracked.programKey}/search?q=wreath`,
      )}`,
    );
    expect(
      fillTrackingTemplate('{destinationUrl}&tag={trackingId}', {
        destinationUrl: 'https://example.com/s?k=wreath',
        subId: null,
        trackingId: 'tag-20',
      }),
    ).toBe('https://example.com/s?k=wreath&tag=tag-20');
  });
});
