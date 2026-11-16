import sharp from 'sharp';
import { DELIVERED_CREDIT, IPTC_DIGITAL_SOURCE_TYPE } from '../versions.js';

/** The visible disclosure label burned into downloads and share cards. */
export const AI_PREVIEW_LABEL = 'AI preview';
/** The product wordmark on share cards. */
export const WORDMARK = 'Hailiday';

const FONT = 'DejaVu Sans, Helvetica, Arial, sans-serif';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The XMP packet written on delivered files: IPTC digital source type ("Edited using Generative
 * AI") and the credit line. No location, device or personal metadata.
 */
export function deliveredXmp(): string {
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about=""',
    ' xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"',
    ' xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"',
    ` Iptc4xmpExt:DigitalSourceType="${IPTC_DIGITAL_SOURCE_TYPE}"`,
    ` photoshop:Credit="${escapeXml(DELIVERED_CREDIT)}"/>`,
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('');
}

/** SVG of a rounded label badge sized relative to the image. */
function badgeSvg(width: number, height: number, text: string, scale = 1): Buffer {
  const fontSize = Math.max(11, Math.round(Math.min(width, height) * 0.028 * scale));
  const padX = Math.round(fontSize * 0.6);
  const padY = Math.round(fontSize * 0.4);
  const textWidth = Math.round(text.length * fontSize * 0.58);
  const w = textWidth + padX * 2;
  const h = fontSize + padY * 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${Math.round(h / 3)}" fill="#111111" fill-opacity="0.72"/><text x="${padX}" y="${padY + fontSize * 0.86}" font-family="${FONT}" font-size="${fontSize}" fill="#ffffff">${escapeXml(text)}</text></svg>`,
  );
}

/** The corner a burned-in "AI preview" mark occupies. */
export type PreviewMarkCorner = 'lower-right' | 'upper-left';

/**
 * Where the "AI preview" mark goes (experience spec, AI preview badge placement): lower right,
 * unless the image is a Street View frame, whose burned-in attribution holds both lower corners
 * (the Google logo at the lower left, the copyright at the lower right); then upper left.
 */
export function previewMarkCorner(sourceKind: string): PreviewMarkCorner {
  return sourceKind === 'street_view' ? 'upper-left' : 'lower-right';
}

/**
 * The image with a small "AI preview" mark burned into a corner (`lower-right` by default;
 * `upper-left` for Street View-origin images, see `previewMarkCorner`).
 */
export async function burnPreviewMark(
  image: Uint8Array,
  options: { corner?: PreviewMarkCorner } = {},
): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const badge = badgeSvg(width, height, AI_PREVIEW_LABEL);
  const badgeMeta = await sharp(badge).metadata();
  const margin = Math.round(Math.min(width, height) * 0.02);
  const upperLeft = options.corner === 'upper-left';
  return sharp(image)
    .composite([
      {
        input: badge,
        left: upperLeft ? margin : Math.max(0, width - (badgeMeta.width ?? 0) - margin),
        top: upperLeft ? margin : Math.max(0, height - (badgeMeta.height ?? 0) - margin),
      },
    ])
    .toBuffer();
}

/** Adds an attribution band below the image (Street View-origin downloads and cards). */
export async function addAttributionBand(image: Uint8Array, text: string): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 1024;
  const band = Math.max(24, Math.round(width * 0.035));
  const fontSize = Math.round(band * 0.5);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${band}"><rect width="${width}" height="${band}" fill="#ffffff"/><text x="${Math.round(band * 0.4)}" y="${Math.round(band * 0.68)}" font-family="${FONT}" font-size="${fontSize}" fill="#3c4043">${escapeXml(text)}</text></svg>`,
  );
  return sharp(image)
    .extend({ bottom: band, background: '#ffffff' })
    .composite([{ input: svg, left: 0, top: meta.height ?? 0 }])
    .toBuffer();
}

/** Encodes a delivered JPEG: quality 90, progressive, sRGB, the provenance XMP and nothing else. */
export async function encodeDelivered(image: Uint8Array, quality = 90): Promise<Buffer> {
  return sharp(image)
    .toColourspace('srgb')
    .removeAlpha()
    .jpeg({ quality, progressive: true, chromaSubsampling: '4:4:4' })
    .withXmp(deliveredXmp())
    .toBuffer();
}

/** Share card size (Open Graph and LinkedIn minimum 1200×627 at 1.91:1). */
export const SHARE_CARD_SIZE = { width: 1200, height: 630 } as const;

/**
 * Composes the 1200×630 share card from the shared after image: the image padded (never cropped)
 * onto a dark field, the "AI preview" label in a corner of the image area (`markCorner`, lower
 * right by default; upper left for Street View-origin images, whose burned-in logo and copyright
 * hold both lower corners), the wordmark and, for Street View-origin variants, the attribution
 * line. Encoded as JPEG well under 5 MB.
 */
export async function composeShareCard(
  after: Uint8Array,
  options: { attribution?: string | null; quality?: number; markCorner?: PreviewMarkCorner } = {},
): Promise<Buffer> {
  const { width, height } = SHARE_CARD_SIZE;
  const footer = 44;
  const imageArea = { width, height: height - footer };
  const fitted = await sharp(after)
    .resize(imageArea.width, imageArea.height, {
      fit: 'contain',
      background: { r: 18, g: 22, b: 28 },
    })
    .toBuffer();
  const badge = badgeSvg(width, height, AI_PREVIEW_LABEL, 1.1);
  const badgeMeta = await sharp(badge).metadata();
  // The fitted image is centered; the mark sits inside its corner, not on the padding.
  const fittedMeta = await sharp(after).metadata();
  const scale = Math.min(
    imageArea.width / (fittedMeta.width ?? imageArea.width),
    imageArea.height / (fittedMeta.height ?? imageArea.height),
  );
  const shown = Math.round((fittedMeta.width ?? imageArea.width) * scale);
  const shownHeight = Math.round((fittedMeta.height ?? imageArea.height) * scale);
  const imageLeft = Math.max(0, Math.floor((imageArea.width - shown) / 2));
  const imageTop = Math.max(0, Math.floor((imageArea.height - shownHeight) / 2));
  const upperLeft = options.markCorner === 'upper-left';
  const badgeLeft = upperLeft ? imageLeft + 18 : imageLeft + shown - (badgeMeta.width ?? 0) - 18;
  const badgeTop = upperLeft ? imageTop + 14 : imageArea.height - (badgeMeta.height ?? 0) - 14;
  const footerSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${footer}"><rect width="${width}" height="${footer}" fill="#12161c"/><text x="24" y="29" font-family="${FONT}" font-size="20" font-weight="bold" fill="#ffffff">${escapeXml(WORDMARK)}</text>${
      options.attribution
        ? `<text x="${width - 24}" y="28" text-anchor="end" font-family="${FONT}" font-size="15" fill="#d6d9de">${escapeXml(options.attribution)}</text>`
        : ''
    }</svg>`,
  );
  return sharp({
    create: { width, height, channels: 3, background: { r: 18, g: 22, b: 28 } },
  })
    .composite([
      { input: fitted, left: 0, top: 0 },
      {
        input: badge,
        left: Math.max(0, Math.min(width - (badgeMeta.width ?? 0), badgeLeft)),
        top: Math.max(0, Math.min(imageArea.height - (badgeMeta.height ?? 0), badgeTop)),
      },
      { input: footerSvg, left: 0, top: imageArea.height },
    ])
    .jpeg({ quality: options.quality ?? 85, progressive: true })
    .toBuffer();
}
