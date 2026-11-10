import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import type {
  CardPrice,
  ProductCard,
  ProductsPanel,
  Project,
  ProductRelationship,
  Variant,
} from '@holiday/core';
import { analytics } from '../../analytics';
import { createClick, getProducts } from '../../api/endpoints';
import { holidayName, t, tDynamic, type CopyKey } from '../../copy';
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

function Disclosure({ panel }: { panel: ProductsPanel }) {
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

/**
 * Shop the look beneath the result: the panel state comes from the server. `active` shows the
 * disclosure first, then cards in our own words and the fit note; `no_offers` and `off_season`
 * show one line without links; `hidden` renders nothing (for example beside Google imagery
 * without a covering grant). There is never an empty panel of cards.
 */
export function ShopTheLook({ variant, project }: { variant: Variant; project: Project }) {
  const id = useId();
  const [panel, setPanel] = useState<{ jobId: string; data: ProductsPanel } | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const jobId = variant.renderJobId;

  useEffect(() => {
    let active = true;
    getProducts(jobId)
      .then((data) => {
        if (active) setPanel({ jobId, data });
      })
      .catch(() => {
        if (active) setPanel(null);
      });
    return () => {
      active = false;
    };
  }, [jobId]);

  const data = panel?.jobId === jobId ? panel.data : null;

  useEffect(() => {
    const element = sectionRef.current;
    if (!data || data.panelState !== 'active' || !element || viewedPanels.has(jobId)) return;
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

  if (!data || data.panelState === 'hidden') return null;
  if (data.panelState === 'active' && data.items.length === 0) return null;

  const organic = data.items.filter((item) => !item.sponsored);
  const sponsored = data.items.filter((item) => item.sponsored);

  return (
    <section
      ref={sectionRef}
      className="shop"
      aria-labelledby={`${id}-heading`}
      data-state={data.panelState}
    >
      <h2 id={`${id}-heading`} className="shop__heading">
        {t('shop.heading')}
      </h2>
      {data.panelState === 'active' ? <Disclosure panel={data} /> : null}
      {data.panelState === 'no_offers' ? <p className="lede">{t('commerce.noOffers')}</p> : null}
      {data.panelState === 'off_season' ? (
        <p className="lede">
          {t('commerce.offSeason', { holiday: holidayName(variant.holidayId) })}
        </p>
      ) : null}
      {data.panelState === 'active' ? (
        <>
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
    </section>
  );
}
