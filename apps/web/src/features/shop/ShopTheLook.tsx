import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type {
  CardPrice,
  ProductsPanel,
  Project,
  ProductRelationship,
  ShopGroup,
  ShopOption,
  ShopSearchLink,
  Variant,
} from '@hailiday/core';
import { analytics } from '../../analytics';
import { createClick, getProducts } from '../../api/endpoints';
import { inlineMessage } from '../../api/present';
import { holidayName, t, tDynamic, type CopyKey } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { Disclosure } from '../../ui/Disclosure';
import { Icon } from '../../ui/Icon';
import './shop.css';

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Panels already reported as viewed in this page session (once per variant). */
const viewedPanels = new Set<string>();

function formatPrice(price: Extract<CardPrice, { policy: 'show' }>): string {
  const amount = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: price.currency,
  }).format(price.amountMinor / 100);
  const time = new Date(price.observedAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return t('shop.price.asOf', { price: amount, time });
}

/** Price policy: "Check price at retailer" unless a permitted, timestamped price exists. */
function priceText(price: CardPrice): string {
  return price.policy === 'show' ? formatPrice(price) : t('shop.price.check');
}

/** Records the click with a keep-alive request; the retailer opens directly, no interstitial. */
function recordClick(clickToken: string): void {
  void createClick(clickToken).catch(() => undefined);
}

/** A tracking link adds `sponsored` to its `rel`. */
function relFor(linkMode: ShopOption['linkMode']): string {
  return linkMode === 'tracking' ? 'noopener noreferrer sponsored' : 'noopener noreferrer';
}

/** The "Ad" and "Sponsored" labels: text, so they are read with what they label. */
function PaidLabels({ link }: { link: Pick<ShopSearchLink, 'linkMode' | 'sponsored'> }) {
  return (
    <>
      {link.linkMode === 'tracking' ? (
        <span className="product__ad">{t('commerce.card.ad')}</span>
      ) : null}
      {link.sponsored ? <span className="product__ad">{t('commerce.card.sponsored')}</span> : null}
    </>
  );
}

/** One product offered for a decoration, in our own words. */
function Option({ option }: { option: ShopOption }) {
  return (
    <li className="product">
      <a
        className="product__link"
        href={option.href}
        target="_blank"
        rel={relFor(option.linkMode)}
        onClick={() => recordClick(option.clickToken)}
      >
        <span className="product__meta">
          <PaidLabels link={option} />
          <span className="product__relationship">
            {tDynamic(option.relationshipLabelKey, 'commerce.relationship.similar')}
          </span>
        </span>
        <span className="product__title">{option.title}</span>
        <span className="product__footer">
          <span className="product__merchant">
            {t('shop.merchant', { merchant: option.merchantName })}
          </span>
          <span className="product__price">{priceText(option.price)}</span>
          <Icon name="arrowRight" className="product__arrow" />
        </span>{' '}
        <span className="sr-only">({t('shop.newTab')})</span>
      </a>
    </li>
  );
}

/** A link to a retailer's own search results; the click is recorded like a product's. */
function RetailerLink({
  link,
  className,
  label,
  children,
}: {
  link: ShopSearchLink;
  className: string;
  /** The accessible name, when the visible text alone does not say where the link goes. */
  label?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={link.href}
      target="_blank"
      rel={relFor(link.linkMode)}
      aria-label={label}
      onClick={() => recordClick(link.clickToken)}
    >
      {children}
    </a>
  );
}

/**
 * One decoration: its title, where it goes, the products offered for it, one line of links to
 * retailers' own search results, then a line of its own for each retailer kept apart.
 */
function Group({ group, heading: Heading }: { group: ShopGroup; heading: 'h3' | 'h4' }) {
  const placementKey = group.anchorCategory
    ? (`shop.anchor.${group.anchorCategory}` as CopyKey)
    : null;
  return (
    <div className="shop-group" data-basis={group.basis}>
      <Heading className="shop-group__title">{group.title}</Heading>
      {placementKey ? (
        <p className="shop-group__placement">
          {t('shop.placement', { placement: tDynamic(placementKey, 'shop.anchor.wall') })}
        </p>
      ) : null}
      {group.options.length > 0 ? (
        <ul className="shop__cards">
          {group.options.map((option) => (
            <Option key={option.clickToken} option={option} />
          ))}
        </ul>
      ) : null}
      {group.searchLinks.length > 0 ? (
        <p className="shop-find">
          {/* Each link's accessible name repeats this label with the retailer's name. */}
          <span className="shop-find__label" aria-hidden="true">
            {t('shop.find.label')}
          </span>
          {group.searchLinks.map((link) => (
            <span key={link.clickToken} className="shop-find__item">
              <PaidLabels link={link} />
              <RetailerLink
                link={link}
                className="shop-link"
                label={`${t('shop.find.linkLabel', { merchant: link.merchantName })} (${t('shop.newTab')})`}
              >
                {link.merchantName}
              </RetailerLink>
            </span>
          ))}
        </p>
      ) : null}
      {group.separateLinks.map((link) => (
        <p key={link.clickToken} className="shop-separate">
          <PaidLabels link={link} />
          <RetailerLink link={link} className="shop-link">
            {t('shop.separate.link', { merchant: link.merchantName })}{' '}
            <span className="sr-only">({t('shop.newTab')})</span>
          </RetailerLink>
        </p>
      ))}
    </div>
  );
}

/**
 * The group as shown with one retailer chosen: options and search links of other retailers are
 * left out and separate links stay. A group with no option and no search link of the chosen
 * retailer is not shown, whatever separate links it has.
 */
function narrowGroup(group: ShopGroup, programKey: string | null): ShopGroup | null {
  if (programKey === null) return group;
  const options = group.options.filter((option) => option.programKey === programKey);
  const searchLinks = group.searchLinks.filter((link) => link.programKey === programKey);
  if (options.length === 0 && searchLinks.length === 0) return null;
  return { ...group, options, searchLinks };
}

/** "All" and one toggle per retailer of the panel; choosing the chosen one again shows all. */
function RetailerFilter({
  retailers,
  chosen,
  onChoose,
}: {
  retailers: ProductsPanel['retailers'];
  chosen: string | null;
  onChoose: (programKey: string | null) => void;
}) {
  const labelId = useId();
  return (
    <div className="shop__filter" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="shop__filter-label">
        {t('shop.filter.label')}
      </span>
      <button
        type="button"
        className="chip"
        aria-pressed={chosen === null}
        onClick={() => onChoose(null)}
      >
        {t('shop.filter.all')}
      </button>
      {retailers.map((retailer) => (
        <button
          key={retailer.programKey}
          type="button"
          className="chip"
          aria-pressed={chosen === retailer.programKey}
          onClick={() => onChoose(chosen === retailer.programKey ? null : retailer.programKey)}
        >
          {retailer.merchantName}
        </button>
      ))}
    </div>
  );
}

/** The affiliate and paid-link disclosure, before any link. */
function AffiliateDisclosure({ panel }: { panel: ProductsPanel }) {
  const keys = panel.disclosure.copyKeys;
  if (keys.length === 0) return null;
  return (
    <div className="shop__disclosure">
      {keys.map((key, index) => (
        <p key={key}>
          {tDynamic(key, 'commerce.disclosure.plain')}
          {index === 0 ? (
            <>
              {' '}
              <Link to="/affiliate-disclosure">{t('commerce.disclosure.more')}</Link>
            </>
          ) : null}
        </p>
      ))}
    </div>
  );
}

interface PanelProps {
  data: ProductsPanel;
  jobId: string;
  variant: Variant;
  project: Project;
}

/**
 * The panel's content from the server. `active` shows, in this order: the off-season line when
 * the holiday's window is not open, the disclosure, the retailer filter (two or more retailers),
 * the decorations the plan placed, the decorations typical of the look under their own heading,
 * and the fit note. `active` without groups, and `no_offers`, show one line without links;
 * `off_season` shows the off-season line alone.
 */
function ShopPanel({ data, jobId, variant, project }: PanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  /** The retailer chosen in the filter, for the preview it was chosen on. */
  const [choice, setChoice] = useState<{ jobId: string; programKey: string } | null>(null);

  useEffect(() => {
    const element = panelRef.current;
    if (data.panelState !== 'active' || !element || viewedPanels.has(jobId)) return;
    const report = () => {
      if (viewedPanels.has(jobId)) return;
      viewedPanels.add(jobId);
      const options = data.groups.flatMap((group) => group.options);
      const relationships = [...new Set(options.map((option) => option.relationship))];
      const searchLinkCount = data.groups.reduce(
        (sum, group) => sum + group.searchLinks.length + group.separateLinks.length,
        0,
      );
      analytics.track(
        'shop_panel_viewed',
        {
          panelState: data.panelState,
          cardCount: data.groups.length,
          optionCount: options.length,
          searchLinkCount,
          season: data.season,
          linkMode: data.linkMode,
          programs: data.disclosure.programs.filter((program) => SLUG.test(program)).slice(0, 20),
          relationships: relationships.slice(0, 20) as ProductRelationship[],
        },
        {
          holidayId: variant.holidayId,
          sceneType: project.sceneType,
          sourceKind: project.activeSource?.kind ?? null,
        },
      );
    };
    if (typeof IntersectionObserver === 'undefined') {
      report();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        report();
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [data, jobId, variant.holidayId, project.sceneType, project.activeSource?.kind]);

  const showFilter = data.retailers.length >= 2;
  const chosen =
    showFilter &&
    choice?.jobId === jobId &&
    data.retailers.some((retailer) => retailer.programKey === choice.programKey)
      ? choice.programKey
      : null;
  const shown = data.groups
    .map((group) => narrowGroup(group, chosen))
    .filter((group): group is ShopGroup => group !== null);
  const placed = shown.filter((group) => group.basis === 'placed');
  const typical = shown.filter((group) => group.basis === 'typical');
  const active = data.panelState === 'active' && data.groups.length > 0;
  const nothing =
    data.panelState === 'no_offers' || (data.panelState === 'active' && data.groups.length === 0);

  return (
    <div ref={panelRef} className="shop" data-state={data.panelState}>
      {nothing ? <p className="lede">{t('commerce.noOffers')}</p> : null}
      {data.panelState === 'off_season' ? (
        <p className="lede">
          {t('commerce.offSeason', { holiday: holidayName(variant.holidayId) })}
        </p>
      ) : null}
      {active ? (
        <>
          {data.season === 'off_season' ? (
            <p className="fine shop__season">
              {t('shop.offSeasonNote', { holiday: holidayName(variant.holidayId) })}
            </p>
          ) : null}
          <AffiliateDisclosure panel={data} />
          {showFilter ? (
            <RetailerFilter
              retailers={data.retailers}
              chosen={chosen}
              onChoose={(programKey) => setChoice(programKey ? { jobId, programKey } : null)}
            />
          ) : null}
          {placed.length > 0 ? (
            <div className="shop__groups">
              {placed.map((group) => (
                <Group key={`${group.basis}:${group.groupKey}`} group={group} heading="h3" />
              ))}
            </div>
          ) : null}
          {typical.length > 0 ? (
            <div className="shop__typical">
              <h3 className="shop__subheading">{t('shop.typical.heading')}</h3>
              <p className="fine shop__note">{t('shop.typical.note')}</p>
              <div className="shop__groups">
                {typical.map((group) => (
                  <Group key={`${group.basis}:${group.groupKey}`} group={group} heading="h4" />
                ))}
              </div>
            </div>
          ) : null}
          <p className="fine shop__fit">{t('commerce.panel.fitNote')}</p>
        </>
      ) : null}
    </div>
  );
}

type PanelLoad =
  | { jobId: string; data: ProductsPanel; error: null }
  | { jobId: string; data: null; error: string };

/**
 * "Shop the look" as a collapsed row under the result. Its products are requested only once the
 * row has been opened (then for each preview shown), and its summary counts the decorations once
 * they are known; the panel is marked busy while they load. Where the server hides the panel
 * (for example beside Google imagery without a covering grant) the row is left out, except when
 * the answer comes while the row is open or holds keyboard focus: then the row stays with one
 * line saying nothing matched, so it does not vanish under the person's focus. It is left out
 * entirely when commerce is off.
 */
export function ShopTheLook({
  variant,
  project,
  className,
}: {
  variant: Variant;
  project: Project;
  className?: string;
}) {
  const commerce = useAppStore((state) => state.experience?.capabilities.commerce ?? true);
  const [wanted, setWanted] = useState(false);
  const [load, setLoad] = useState<PanelLoad | null>(null);
  /** The preview whose hidden panel arrived while the row was open, so the row stays. */
  const [keptHiddenFor, setKeptHiddenFor] = useState<string | null>(null);
  const openRef = useRef(false);
  const focusedRef = useRef(false);
  const jobId = variant.renderJobId;

  useEffect(() => {
    if (!wanted) return;
    let active = true;
    getProducts(jobId)
      .then((data) => {
        if (!active) return;
        if (data.panelState === 'hidden' && (openRef.current || focusedRef.current)) {
          setKeptHiddenFor(jobId);
        }
        setLoad({ jobId, data, error: null });
      })
      .catch((failure: unknown) => {
        if (active) {
          setLoad({ jobId, data: null, error: inlineMessage(failure).message });
        }
      });
    return () => {
      active = false;
    };
  }, [jobId, wanted]);

  const current = load?.jobId === jobId ? load : null;
  const data = current?.data ?? null;
  const hidden = data?.panelState === 'hidden';
  if (!commerce || (hidden && keptHiddenFor !== jobId)) return null;
  const loading = wanted && !current;
  const count = data?.panelState === 'active' ? data.groups.length : 0;
  const summary =
    count === 0 ? null : count === 1 ? t('shop.summaryOne') : t('shop.summary', { n: count });

  return (
    <Disclosure
      label={t('shop.heading')}
      summary={summary}
      className={className}
      busy={loading}
      onFocusWithin={(inside) => {
        focusedRef.current = inside;
      }}
      onToggle={(open) => {
        openRef.current = open;
        if (open) setWanted(true);
      }}
    >
      {hidden ? <p className="lede">{t('commerce.noOffers')}</p> : null}
      {data && !hidden ? (
        <ShopPanel data={data} jobId={jobId} variant={variant} project={project} />
      ) : null}
      {current?.error ? (
        <p className="message message--error" role="alert">
          {current.error}
        </p>
      ) : null}
      {!current ? (
        <>
          <div className="indeterminate" aria-hidden="true" />
          <span className="sr-only">{t('common.loading')}</span>
        </>
      ) : null}
    </Disclosure>
  );
}
