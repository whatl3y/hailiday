import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type {
  CardPrice,
  ProductCard,
  ProductsPanel,
  Project,
  ProductRelationship,
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

function Card({ card }: { card: ProductCard }) {
  const tracking = card.linkMode === 'tracking';
  const placementKey = card.anchorCategory
    ? (`shop.anchor.${card.anchorCategory}` as CopyKey)
    : null;
  return (
    <li className="product">
      <a
        className="product__link"
        href={card.href}
        target="_blank"
        rel={tracking ? 'noopener noreferrer sponsored' : 'noopener noreferrer'}
        onClick={() => {
          // Recorded with a keep-alive request; the merchant opens directly, no interstitial.
          void createClick(card.clickToken).catch(() => undefined);
        }}
      >
        <span className="product__meta">
          {tracking ? <span className="product__ad">{t('commerce.card.ad')}</span> : null}
          {card.sponsored ? (
            <span className="product__ad">{t('commerce.card.sponsored')}</span>
          ) : null}
          <span className="product__relationship">
            {tDynamic(card.relationshipLabelKey, 'commerce.relationship.similar')}
          </span>
        </span>
        <span className="product__title">{card.title}</span>
        {placementKey ? (
          <span className="product__placement">
            {t('shop.placement', { placement: tDynamic(placementKey, 'shop.anchor.wall') })}
          </span>
        ) : null}
        <span className="product__footer">
          <span className="product__merchant">
            {t('shop.merchant', { merchant: card.merchantName })}
          </span>
          <span className="product__price">{priceText(card.price)}</span>
          <Icon name="arrowRight" className="product__arrow" />
        </span>
        <span className="sr-only">({t('shop.newTab')})</span>
      </a>
    </li>
  );
}

/** The affiliate and paid-link disclosure, before any card. */
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
 * The panel's content from the server: `active` shows the disclosure first, then cards in our
 * own words and the fit note (or one line when nothing matched, never an empty panel of cards);
 * `no_offers` and `off_season` show one line without links.
 */
function ShopPanel({ data, jobId, variant, project }: PanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = panelRef.current;
    if (data.panelState !== 'active' || !element || viewedPanels.has(jobId)) return;
    const report = () => {
      if (viewedPanels.has(jobId)) return;
      viewedPanels.add(jobId);
      const relationships = [...new Set(data.items.map((item) => item.relationship))];
      analytics.track(
        'shop_panel_viewed',
        {
          panelState: data.panelState,
          cardCount: data.items.length,
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

  const organic = data.items.filter((item) => !item.sponsored);
  const sponsored = data.items.filter((item) => item.sponsored);
  const noCards =
    data.panelState === 'no_offers' || (data.panelState === 'active' && data.items.length === 0);

  return (
    <div ref={panelRef} className="shop" data-state={data.panelState}>
      {noCards ? <p className="lede">{t('commerce.noOffers')}</p> : null}
      {data.panelState === 'off_season' ? (
        <p className="lede">
          {t('commerce.offSeason', { holiday: holidayName(variant.holidayId) })}
        </p>
      ) : null}
      {data.panelState === 'active' && data.items.length > 0 ? (
        <>
          <AffiliateDisclosure panel={data} />
          <ul className="shop__cards">
            {organic.map((card) => (
              <Card key={card.clickToken} card={card} />
            ))}
          </ul>
          {sponsored.length > 0 ? (
            <>
              <h3 className="shop__subheading">{t('commerce.card.sponsored')}</h3>
              <ul className="shop__cards">
                {sponsored.map((card) => (
                  <Card key={card.clickToken} card={card} />
                ))}
              </ul>
            </>
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
 * row has been opened (then for each preview shown), and its summary counts the cards once they
 * are known; the panel is marked busy while they load. Where the server hides the panel (for
 * example beside Google imagery without a covering grant) the row is left out, except when the
 * answer comes while the row is open or holds keyboard focus: then the row stays with one line
 * saying nothing matched, so it does not vanish under the person's focus. It is left out
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
  const count = data?.panelState === 'active' ? data.items.length : 0;
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
