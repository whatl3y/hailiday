import { z } from 'zod';
import type { NormalizedBox } from '@hailiday/core';
import type { ViewpointFraming, ViewpointJson } from '../../db/schema.js';
import type { StreetViewView } from '../types.js';

/**
 * Framing a Street View frame on one home: the geometry of a rectilinear frame (a direction for
 * every point and a point for every direction) and the view of a second frame from the same
 * panorama in which a box of the first fills the picture.
 */

/** The view geometry of a rectilinear frame: where it looks and its horizontal field of view. */
export interface FrameGeometry {
  heading: number;
  pitch: number;
  fov: number;
  width: number;
  height: number;
}

/** A direction from the panorama's center, in degrees (heading clockwise from north, pitch up). */
export interface ViewDirection {
  heading: number;
  pitch: number;
}

/** A point of a frame, 0 to 1 from the upper left. */
export interface FramePoint {
  u: number;
  v: number;
}

/** What `frameView` needs besides the view and the box. */
export interface FramingParams {
  /** Share of the frame left free on each side of the box's larger angular extent. */
  marginFraction: number;
  /** The narrowest field of view (degrees) a framed view takes. */
  minFovDeg: number;
  /** Share of the vertical slack (frame height not taken by the box) left under the box. */
  slackBelowShare: number;
}

/** A framed view: heading, pitch and fov rounded to one decimal, and the zoom over the view. */
export interface FramedView {
  heading: number;
  pitch: number;
  fov: number;
  /** How many times larger the box appears than in the view (ratio of focal lengths). */
  zoom: number;
}

const rad = (degrees: number) => (degrees * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;
const round1 = (value: number) => Math.round(value * 10) / 10;

/** A heading in [0, 360) (one already in range is returned as it is). */
export function normalizeHeading(heading: number): number {
  if (heading >= 0 && heading < 360) return heading;
  const normalized = ((heading % 360) + 360) % 360;
  return normalized >= 360 ? 0 : normalized;
}

/** The signed difference `a - b` of two headings, in [-180, 180). */
function headingDelta(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/** Focal length of a frame in frame widths. */
function focalOf(fov: number): number {
  return 0.5 / Math.tan(rad(fov) / 2);
}

/** The direction of a point of a frame (`u` and `v` 0 to 1 from the upper left). */
export function directionOf(view: FrameGeometry, u: number, v: number): ViewDirection {
  const f = focalOf(view.fov);
  const aspect = view.height / view.width;
  const x = u - 0.5;
  const y = (0.5 - v) * aspect;
  const z = f;
  const p = rad(view.pitch);
  // The camera ray tilted up by the view's pitch.
  const y1 = y * Math.cos(p) + z * Math.sin(p);
  const z1 = -y * Math.sin(p) + z * Math.cos(p);
  return {
    heading: normalizeHeading(view.heading + deg(Math.atan2(x, z1))),
    pitch: deg(Math.atan2(y1, Math.hypot(x, z1))),
  };
}

/** Where a direction lands in a frame (`u` and `v` from the upper left), or null behind it. */
export function pointOf(view: FrameGeometry, direction: ViewDirection): FramePoint | null {
  const h = rad(direction.heading - view.heading);
  const t = rad(direction.pitch);
  // Unit vector in the untilted camera: x right, y up, z forward.
  const x = Math.cos(t) * Math.sin(h);
  const y = Math.sin(t);
  const z = Math.cos(t) * Math.cos(h);
  const p = rad(view.pitch);
  const yc = y * Math.cos(p) - z * Math.sin(p);
  const zc = y * Math.sin(p) + z * Math.cos(p);
  if (zc <= 0) return null;
  const f = focalOf(view.fov);
  const aspect = view.height / view.width;
  return { u: 0.5 + (f * x) / zc, v: 0.5 - (f * yc) / zc / aspect };
}

/**
 * The heading that puts `box` ([x0, y0, x1, y1] normalized on `view`) in the middle of the frame:
 * the angular middle of the box's left and right sides at its mid-height, rounded to one decimal
 * in [0, 360), with the signed turn from the view's heading in [-180, 180).
 */
export function aimAt(
  view: FrameGeometry,
  box: NormalizedBox,
): { heading: number; turnDeg: number } {
  const [x0, y0, x1, y1] = box;
  const cy = (y0 + y1) / 2;
  const left = directionOf(view, x0, cy);
  const right = directionOf(view, x1, cy);
  const heading = normalizeHeading(
    round1(normalizeHeading(left.heading + headingDelta(right.heading, left.heading) / 2)),
  );
  return { heading, turnDeg: headingDelta(heading, view.heading) };
}

/** How many times the field of view is widened at most to bring the box's corners inside. */
const CORNER_FIT_PASSES = 40;

/**
 * The view of `box` ([x0, y0, x1, y1] normalized on `view`) from the same panorama: aimed at the
 * middle of the box's horizontal extent; with the field of view that leaves `marginFraction` of
 * the frame free on each side of the box's larger angular extent (width, or height on the frame's
 * aspect), never narrower than `minFovDeg` and never wider than the view; and pitched so that
 * `slackBelowShare` of the vertical room the box leaves lies under it. A box away from the
 * view's center is keystoned in the re-aimed view, so its corners are then projected into it and
 * the field of view is widened (pitch following) until every corner lies at least half the
 * margin inside the frame, never wider than the view. Heading in [0, 360), pitch within
 * [-90, 90], all three rounded to one decimal; `zoom` is the focal-length ratio of the unrounded
 * field of view to the view's.
 */
export function frameView(
  view: FrameGeometry,
  box: NormalizedBox,
  params: FramingParams,
): FramedView {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const left = directionOf(view, x0, cy);
  const right = directionOf(view, x1, cy);
  const top = directionOf(view, cx, y0);
  const bottom = directionOf(view, cx, y1);
  const wide = Math.abs(headingDelta(right.heading, left.heading));
  const tall = top.pitch - bottom.pitch;
  const aspect = view.height / view.width;
  const fill = 1 - 2 * params.marginFraction;
  const fitWide = 2 * deg(Math.atan(Math.tan(rad(wide) / 2) / fill));
  const fitTall = 2 * deg(Math.atan(Math.tan(rad(tall) / 2) / fill / aspect));
  const { heading } = aimAt(view, box);
  const viewAt = (fov: number) => {
    const vertical = 2 * deg(Math.atan(Math.tan(rad(fov) / 2) * aspect));
    const slack = Math.max(0, vertical - tall);
    const pitch = (top.pitch + bottom.pitch) / 2 + slack * (0.5 - params.slackBelowShare);
    return {
      heading,
      pitch: Math.min(90, Math.max(-90, round1(pitch))),
      fov: Math.min(view.fov, round1(fov)),
    };
  };
  const corners = [
    directionOf(view, x0, y0),
    directionOf(view, x1, y0),
    directionOf(view, x0, y1),
    directionOf(view, x1, y1),
  ];
  const cornerMargin = params.marginFraction / 2;
  // How far the corner nearest an edge lies from the frame's center, as a share of the half
  // frame on that axis (1 at the edge); Infinity when a corner is behind the camera.
  const reach = (framed: FrameGeometry) => {
    let worst = 0;
    for (const corner of corners) {
      const point = pointOf(framed, corner);
      if (!point) return Infinity;
      worst = Math.max(worst, Math.abs(point.u - 0.5) * 2, Math.abs(point.v - 0.5) * 2);
    }
    return worst;
  };
  const allowed = 1 - 2 * cornerMargin;
  let fov = Math.min(view.fov, Math.max(params.minFovDeg, fitWide, fitTall));
  let framed = viewAt(fov);
  for (let pass = 0; pass < CORNER_FIT_PASSES && framed.fov < view.fov; pass += 1) {
    const worst = reach({ ...view, ...framed });
    if (worst <= allowed) break;
    // Widening scales every offset from the center by the ratio of the half-angle tangents.
    const needed = Number.isFinite(worst)
      ? 2 * deg(Math.atan((Math.tan(rad(framed.fov) / 2) * worst) / allowed))
      : view.fov;
    fov = Math.min(view.fov, Math.max(needed, fov + 0.1));
    framed = viewAt(fov);
  }
  return {
    ...framed,
    zoom: Math.tan(rad(view.fov) / 2) / Math.tan(rad(fov) / 2),
  };
}

const unit = z.number().min(0).max(1);
const BoxSchema = z.tuple([unit, unit, unit, unit]);
const recorded = {
  promptVersion: z.string(),
  model: z.string(),
  framedAt: z.string(),
};
/** The turn of a frame taken from the road toward its home, recorded with the framing. */
const ReaimSchema = z.object({
  heading: z.number().min(0).lt(360),
  box: BoxSchema,
  promptVersion: z.string(),
});

/** A recorded framing, as read back from a viewpoint. */
export const ViewpointFramingSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('framed'),
    heading: z.number().min(0).lt(360),
    pitch: z.number().min(-90).max(90),
    fov: z.number().positive().max(120),
    box: BoxSchema,
    zoom: z.number().positive(),
    displayIssuedAt: z.string().optional(),
    reason: z.enum(['small_gain', 'refused_framed']).optional(),
    reaim: ReaimSchema.optional(),
    ...recorded,
  }),
  z.object({
    status: z.literal('kept'),
    reason: z.enum(['no_home', 'ambiguous', 'small_gain', 'refused_framed']),
    box: BoxSchema.nullable(),
    ...recorded,
  }),
]);

/** The framing recorded on a viewpoint, or null when none is (or it cannot be read). */
export function framingOf(
  viewpoint: Pick<ViewpointJson, 'framing'> | null | undefined,
): ViewpointFraming | null {
  if (!viewpoint || viewpoint.framing === undefined || viewpoint.framing === null) return null;
  const parsed = ViewpointFramingSchema.safeParse(viewpoint.framing);
  return parsed.success ? (parsed.data as ViewpointFraming) : null;
}

/** Whether a framing was recorded on a viewpoint (framed or kept: either is final). */
export function viewpointFramed(viewpoint: Pick<ViewpointJson, 'framing'> | null): boolean {
  return viewpoint?.framing !== undefined && viewpoint.framing !== null;
}

/**
 * The view a Street View viewpoint's frame is fetched and shown at: the framed view once the
 * source was zoomed in on its home, else the viewpoint's own view. The viewpoint's own heading,
 * pitch and fov stay its identity.
 */
export function framedViewOf(
  viewpoint: Pick<
    ViewpointJson,
    'panoId' | 'heading' | 'pitch' | 'fov' | 'width' | 'height' | 'framing'
  >,
): StreetViewView {
  const framing = framingOf(viewpoint);
  const framed = framing?.status === 'framed' ? framing : null;
  return {
    panoId: viewpoint.panoId,
    heading: framed ? framed.heading : viewpoint.heading,
    pitch: framed ? framed.pitch : viewpoint.pitch,
    fov: framed ? framed.fov : viewpoint.fov,
    width: viewpoint.width,
    height: viewpoint.height,
  };
}

/**
 * The view of the wide frame a framing was decided on: the viewpoint's own view, turned to
 * `framing.reaim.heading` (same panorama, pitch, fov and size) when the framing records a re-aim.
 */
export function wideViewOf(
  viewpoint: Pick<
    ViewpointJson,
    'panoId' | 'heading' | 'pitch' | 'fov' | 'width' | 'height' | 'framing'
  >,
): StreetViewView {
  const framing = framingOf(viewpoint);
  const reaim = framing?.status === 'framed' ? framing.reaim : undefined;
  return {
    panoId: viewpoint.panoId,
    heading: reaim ? reaim.heading : viewpoint.heading,
    pitch: viewpoint.pitch,
    fov: viewpoint.fov,
    width: viewpoint.width,
    height: viewpoint.height,
  };
}
