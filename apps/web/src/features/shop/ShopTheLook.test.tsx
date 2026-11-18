import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductsPanel, ShopGroup, ShopOption, ShopSearchLink } from '@hailiday/core';
import { analytics } from '../../analytics';
import * as endpoints from '../../api/endpoints';
import { project, variant } from '../../test/fixtures';
import { ShopTheLook } from './ShopTheLook';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({
  createClick: vi.fn(async () => undefined),
  getProducts: vi.fn(),
}));

const api = vi.mocked(endpoints);

const hidden: ProductsPanel = {
  panelState: 'hidden',
  linkMode: null,
  season: null,
  disclosure: { copyKeys: [], programs: [] },
  retailers: [],
  groups: [],
};

const noOffers: ProductsPanel = { ...hidden, panelState: 'no_offers' };

const MERCHANTS: Record<string, string> = {
  walmart_us: 'Walmart',
  target_us: 'Target',
  amazon_us: 'Amazon',
};

function option(programKey: string, title: string, overrides: Partial<ShopOption> = {}) {
  return {
    clickToken: `option-${programKey}-${title}`,
    programKey,
    title,
    merchantName: MERCHANTS[programKey]!,
    relationship: 'similar',
    relationshipLabelKey: 'commerce.relationship.similar',
    price: { policy: 'check_at_retailer' },
    linkMode: 'plain',
    sponsored: false,
    href: `https://example.com/${programKey}/${encodeURIComponent(title)}`,
    position: 1,
    ...overrides,
  } satisfies ShopOption;
}

function search(programKey: string, groupKey: string, overrides: Partial<ShopSearchLink> = {}) {
  return {
    clickToken: `search-${groupKey}-${programKey}`,
    programKey,
    merchantName: MERCHANTS[programKey]!,
    linkMode: 'plain',
    sponsored: false,
    href: `https://example.com/${programKey}/search?q=${groupKey}`,
    ...overrides,
  } satisfies ShopSearchLink;
}

function group(groupKey: string, overrides: Partial<ShopGroup> = {}): ShopGroup {
  return {
    groupKey,
    basis: 'placed',
    title: groupKey,
    anchorCategory: null,
    options: [],
    searchLinks: [],
    separateLinks: [],
    position: 1,
    ...overrides,
  };
}

/** Two placed decorations (one sold only at Walmart) and one typical of the look. */
function activePanel(overrides: Partial<ProductsPanel> = {}): ProductsPanel {
  return {
    panelState: 'active',
    linkMode: 'plain',
    season: 'in_window',
    disclosure: {
      copyKeys: ['commerce.disclosure.plain'],
      programs: ['walmart_us', 'target_us', 'amazon_us'],
    },
    retailers: [
      { programKey: 'walmart_us', merchantName: 'Walmart' },
      { programKey: 'target_us', merchantName: 'Target' },
    ],
    groups: [
      group('christmas.house_exterior.wreath', {
        title: 'Evergreen wreath',
        anchorCategory: 'front_door',
        options: [
          option('walmart_us', 'Pre-lit evergreen wreath'),
          option('target_us', 'Frosted pine wreath', {
            position: 2,
            relationship: 'described',
            relationshipLabelKey: 'commerce.relationship.described',
          }),
        ],
        searchLinks: [
          search('walmart_us', 'wreath'),
          search('target_us', 'wreath', { linkMode: 'tracking' }),
        ],
        separateLinks: [search('amazon_us', 'wreath')],
        position: 1,
      }),
      group('christmas.house_exterior.lights', {
        title: 'Warm white eave lights',
        options: [option('walmart_us', 'Warm white string lights')],
        position: 2,
      }),
      group('christmas.house_exterior.abundant.lanterns', {
        basis: 'typical',
        title: 'Porch lanterns',
        searchLinks: [search('walmart_us', 'lanterns'), search('target_us', 'lanterns')],
        position: 3,
      }),
    ],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function view(shown: ReturnType<typeof variant>) {
  return (
    <MemoryRouter>
      <ShopTheLook variant={shown} project={project()} />
    </MemoryRouter>
  );
}

/** Opens the row once the panel the server answers with is known. */
async function openWith(panel: ProductsPanel) {
  api.getProducts.mockResolvedValue(panel);
  render(view(variant()));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Shop the look/ }));
  });
  return screen.getByRole('region', { name: 'Shop the look' });
}

const NEW_TAB = '(opens the retailer in a new tab)';

/** The block of one decoration, found by its title. */
function groupNamed(region: HTMLElement, title: string): HTMLElement {
  return within(region).getByRole('heading', { name: title }).closest<HTMLElement>('.shop-group')!;
}

describe('Shop the look while its products load', () => {
  it('marks the panel busy and says it is loading until the answer comes', async () => {
    let answer: (value: ProductsPanel) => void = () => undefined;
    api.getProducts.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(view(variant()));
    fireEvent.click(screen.getByRole('button', { name: /^Shop the look/ }));
    const region = screen.getByRole('region', { name: 'Shop the look' });
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(region.textContent).toContain('Loading…');
    await act(async () => {
      answer(noOffers);
    });
    expect(region.hasAttribute('aria-busy')).toBe(false);
    expect(region.textContent).not.toContain('Loading…');
  });
});

describe('Shop the look with decorations to show', () => {
  it('counts the decorations in the row summary', async () => {
    await openWith(activePanel());
    expect(screen.getByRole('button', { name: /^Shop the look/ }).textContent).toContain('3 items');
  });

  it('shows each placed decoration with its options, search links and separate line', async () => {
    const region = await openWith(activePanel());
    const titles = within(region).getAllByRole('heading', { level: 3 });
    expect(titles.map((title) => title.textContent)).toEqual([
      'Evergreen wreath',
      'Warm white eave lights',
      'Typical of this look',
    ]);
    expect(within(region).getByText('For your front door')).toBeTruthy();
    const options = within(region).getAllByRole('listitem');
    expect(options).toHaveLength(3);
    expect(options[0]!.textContent).toContain('Pre-lit evergreen wreath');
    expect(options[0]!.textContent).toContain('at Walmart');
    expect(options[0]!.textContent).toContain('Check price at retailer');
    expect(options[1]!.textContent).toContain("Similar to what's pictured");

    const wreath = groupNamed(region, 'Evergreen wreath');
    const walmart = within(wreath).getByRole('link', {
      name: `Find similar at Walmart ${NEW_TAB}`,
    });
    expect(walmart.textContent).toBe('Walmart');
    expect(walmart.getAttribute('target')).toBe('_blank');
    expect(walmart.getAttribute('rel')).toBe('noopener noreferrer');
    expect(walmart.getAttribute('href')).toBe('https://example.com/walmart_us/search?q=wreath');
    expect(within(region).getAllByText('Find similar at')).toHaveLength(2);

    const amazon = within(region).getByRole('link', { name: `Also at Amazon ${NEW_TAB}` });
    expect(amazon.getAttribute('target')).toBe('_blank');
    expect(amazon.closest('p')?.className).toBe('shop-separate');
  });

  it('puts the disclosure before the first link and the fit note after the groups', async () => {
    const region = await openWith(activePanel());
    const disclosure = within(region).getByText(/These links go to the retailer/);
    const first = region.querySelector('a[target="_blank"]')!;
    expect(disclosure.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const fit = within(region).getByText(/Sizes, quantities and fit aren't guaranteed/);
    const links = region.querySelectorAll('a[target="_blank"]');
    expect(
      links[links.length - 1]!.compareDocumentPosition(fit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('labels a tracking search link "Ad" in text and marks it sponsored', async () => {
    const region = await openWith(activePanel());
    const wreath = groupNamed(region, 'Evergreen wreath');
    const target = within(wreath).getByRole('link', {
      name: `Find similar at Target ${NEW_TAB}`,
    });
    expect(target.getAttribute('rel')).toBe('noopener noreferrer sponsored');
    expect(target.previousElementSibling?.textContent).toBe('Ad');
    const walmart = within(wreath).getByRole('link', {
      name: `Find similar at Walmart ${NEW_TAB}`,
    });
    expect(walmart.previousElementSibling).toBeNull();
  });

  it('records a click for each option, search link and separate link it opens', async () => {
    const region = await openWith(activePanel());
    const wreath = groupNamed(region, 'Evergreen wreath');
    fireEvent.click(within(wreath).getByRole('link', { name: /Pre-lit evergreen wreath/ }));
    fireEvent.click(
      within(wreath).getByRole('link', { name: `Find similar at Target ${NEW_TAB}` }),
    );
    fireEvent.click(within(wreath).getByRole('link', { name: `Also at Amazon ${NEW_TAB}` }));
    expect(api.createClick.mock.calls.map(([token]) => token)).toEqual([
      'option-walmart_us-Pre-lit evergreen wreath',
      'search-wreath-target_us',
      'search-wreath-amazon_us',
    ]);
  });

  it('reports the panel as viewed once, with its groups, options and links counted', async () => {
    await openWith(activePanel());
    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(
      'shop_panel_viewed',
      {
        panelState: 'active',
        cardCount: 3,
        optionCount: 3,
        searchLinkCount: 5,
        season: 'in_window',
        linkMode: 'plain',
        programs: ['walmart_us', 'target_us', 'amazon_us'],
        relationships: ['similar', 'described'],
      },
      expect.objectContaining({ holidayId: 'christmas' }),
    );
  });

  it('sets the decorations typical of the look under their own heading and note', async () => {
    const region = await openWith(activePanel());
    const heading = within(region).getByRole('heading', { name: 'Typical of this look' });
    expect(heading.tagName).toBe('H3');
    expect(
      within(region).getByText(
        'These decorations are typical of this look. Some may not appear in your picture.',
      ),
    ).toBeTruthy();
    const typical = within(region).getByRole('heading', { level: 4 });
    expect(typical.textContent).toBe('Porch lanterns');
    expect(heading.compareDocumentPosition(typical) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('leaves the typical heading out when the look has no typical decorations', async () => {
    const panel = activePanel();
    const region = await openWith({
      ...panel,
      groups: panel.groups.filter((shown) => shown.basis === 'placed'),
    });
    expect(within(region).queryByText('Typical of this look')).toBeNull();
    expect(within(region).queryByRole('heading', { level: 4 })).toBeNull();
  });
});

describe('the retailer filter', () => {
  it('is a labeled group of toggles, "All" pressed first', async () => {
    const region = await openWith(activePanel());
    const filter = within(region).getByRole('group', { name: 'Show retailers' });
    const toggles = within(filter).getAllByRole('button');
    expect(toggles.map((toggle) => toggle.textContent)).toEqual(['All', 'Walmart', 'Target']);
    expect(toggles.map((toggle) => toggle.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ]);
  });

  it('hides the other retailers and any group left empty, and keeps the separate line', async () => {
    const region = await openWith(activePanel());
    const filter = within(region).getByRole('group', { name: 'Show retailers' });
    fireEvent.click(within(filter).getByRole('button', { name: 'Target' }));
    expect(
      within(filter).getByRole('button', { name: 'Target' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(filter).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(within(region).queryByText('Pre-lit evergreen wreath')).toBeNull();
    expect(within(region).getByText('Frosted pine wreath')).toBeTruthy();
    expect(within(region).queryByRole('link', { name: /Find similar at Walmart/ })).toBeNull();
    expect(within(region).getAllByRole('link', { name: /Find similar at Target/ })).toHaveLength(2);
    expect(within(region).getByRole('link', { name: `Also at Amazon ${NEW_TAB}` })).toBeTruthy();
    // The lights are sold only at Walmart, so their group is left out.
    expect(within(region).queryByRole('heading', { name: 'Warm white eave lights' })).toBeNull();
  });

  it('leaves out a group with nothing from the chosen retailer, whatever its separate line', async () => {
    const [wreath, lights, lanterns] = activePanel().groups as [ShopGroup, ShopGroup, ShopGroup];
    const bows = group('christmas.house_exterior.bows', { title: 'Red velvet bows', position: 3 });
    const groups = [wreath, lights, bows, { ...lanterns, position: 4 }].map((shown) => ({
      ...shown,
      separateLinks: [search('amazon_us', shown.groupKey)],
    }));
    const region = await openWith(activePanel({ groups }));
    const titlesWithSeparateLine = () =>
      within(region)
        .getAllByRole('link', { name: /^Also at Amazon/ })
        .map((link) => link.closest('.shop-group')?.querySelector('h3, h4')?.textContent);
    // With "All", a group whose only link is its separate line still shows.
    expect(titlesWithSeparateLine()).toEqual([
      'Evergreen wreath',
      'Warm white eave lights',
      'Red velvet bows',
      'Porch lanterns',
    ]);

    const filter = within(region).getByRole('group', { name: 'Show retailers' });
    fireEvent.click(within(filter).getByRole('button', { name: 'Target' }));
    // The lights and the bows have nothing from Target: their groups go, separate lines and all.
    expect(within(region).queryByRole('heading', { name: 'Warm white eave lights' })).toBeNull();
    expect(within(region).queryByRole('heading', { name: 'Red velvet bows' })).toBeNull();
    expect(titlesWithSeparateLine()).toEqual(['Evergreen wreath', 'Porch lanterns']);
  });

  it('shows every retailer again with "All" or a second press', async () => {
    const region = await openWith(activePanel());
    const filter = within(region).getByRole('group', { name: 'Show retailers' });
    fireEvent.click(within(filter).getByRole('button', { name: 'Walmart' }));
    expect(within(region).queryByText('Frosted pine wreath')).toBeNull();
    fireEvent.click(within(filter).getByRole('button', { name: 'All' }));
    expect(within(region).getByText('Frosted pine wreath')).toBeTruthy();
    fireEvent.click(within(filter).getByRole('button', { name: 'Walmart' }));
    fireEvent.click(within(filter).getByRole('button', { name: 'Walmart' }));
    expect(within(region).getByText('Frosted pine wreath')).toBeTruthy();
    expect(within(filter).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('is left out with fewer than two retailers', async () => {
    const region = await openWith(
      activePanel({ retailers: [{ programKey: 'walmart_us', merchantName: 'Walmart' }] }),
    );
    expect(within(region).queryByRole('group', { name: 'Show retailers' })).toBeNull();
  });

  it('starts again from "All" for another preview', async () => {
    api.getProducts.mockResolvedValue(activePanel());
    const { rerender } = render(view(variant()));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Shop the look/ }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Target' }));
    expect(screen.queryByText('Pre-lit evergreen wreath')).toBeNull();
    await act(async () => {
      rerender(view(variant()));
    });
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Pre-lit evergreen wreath')).toBeTruthy();
  });
});

describe('Shop the look outside the holiday window', () => {
  it('says so above the disclosure and still shows the search links', async () => {
    const panel = activePanel();
    const region = await openWith({
      ...panel,
      season: 'off_season',
      groups: panel.groups.map((shown) => ({ ...shown, options: [] })).slice(0, 1),
    });
    const line = within(region).getByText(
      'Christmas is out of season, so retailers may have little of this in stock right now.',
    );
    const disclosure = within(region).getByText(/These links go to the retailer/);
    expect(line.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(region).queryByRole('listitem')).toBeNull();
    expect(
      within(region).getByRole('link', { name: `Find similar at Walmart ${NEW_TAB}` }),
    ).toBeTruthy();
  });

  it('shows the one line without links when the panel is off season', async () => {
    const region = await openWith({ ...hidden, panelState: 'off_season' });
    expect(region.textContent).toBe(
      'Plan ahead: decorations for Christmas appear here closer to the season.',
    );
    expect(within(region).queryByRole('link')).toBeNull();
  });
});

describe('Shop the look with nothing to show', () => {
  it('shows one line without links', async () => {
    const region = await openWith(noOffers);
    expect(region.textContent).toBe("Matching decorations aren't available for this look yet.");
    expect(within(region).queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: /^Shop the look/ }).textContent).not.toContain(
      'items',
    );
  });
});

describe('Shop the look where the server hides the panel', () => {
  it('stays, with one line, when the hidden answer comes while the row is open', async () => {
    api.getProducts.mockResolvedValue(hidden);
    render(view(variant()));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Shop the look/ }));
    });
    expect(screen.getByRole('region', { name: 'Shop the look' }).textContent).toBe(
      "Matching decorations aren't available for this look yet.",
    );
  });

  it('stays while it holds focus after the person closed it', async () => {
    let answer: (value: ProductsPanel) => void = () => undefined;
    api.getProducts.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(view(variant()));
    const toggle = screen.getByRole('button', { name: /^Shop the look/ });
    toggle.focus();
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await act(async () => {
      answer(hidden);
    });
    expect(screen.getByRole('button', { name: /^Shop the look/ })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
  });

  it('is left out for a later preview whose panel is hidden while the row is closed', async () => {
    api.getProducts.mockResolvedValue(noOffers);
    const first = variant();
    const { rerender } = render(view(first));
    const toggle = screen.getByRole('button', { name: /^Shop the look/ });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.click(toggle);
    });
    toggle.blur();
    api.getProducts.mockResolvedValue(hidden);
    await act(async () => {
      rerender(view(variant()));
    });
    expect(screen.queryByRole('button', { name: /^Shop the look/ })).toBeNull();
  });
});
