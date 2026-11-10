import type { CopyKey } from '../../copy';

export const LEGAL_PAGES = {
  terms: { path: '/terms', title: 'legal.terms.title', summary: 'legal.terms.summary' },
  privacy: { path: '/privacy', title: 'legal.privacy.title', summary: 'legal.privacy.summary' },
  contentPolicy: {
    path: '/content-policy',
    title: 'legal.contentPolicy.title',
    summary: 'legal.contentPolicy.summary',
  },
  aiDisclosure: {
    path: '/ai-disclosure',
    title: 'legal.aiDisclosure.title',
    summary: 'legal.aiDisclosure.summary',
  },
  affiliateDisclosure: {
    path: '/affiliate-disclosure',
    title: 'legal.affiliateDisclosure.title',
    summary: 'legal.affiliateDisclosure.summary',
  },
  accessibility: {
    path: '/accessibility',
    title: 'legal.accessibility.title',
    summary: 'legal.accessibility.summary',
  },
  dmca: { path: '/dmca', title: 'legal.dmca.title', summary: 'legal.dmca.summary' },
  contact: { path: '/contact', title: 'legal.contact.title', summary: 'legal.contact.summary' },
} as const satisfies Record<string, { path: string; title: CopyKey; summary: CopyKey }>;

export type LegalPageId = keyof typeof LEGAL_PAGES;
