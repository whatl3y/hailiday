import { describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import type { ViewpointJson } from '../../db/schema.js';
import { loadFixtureData } from '../../fixtures/data.js';
import { fixturePanoramaGeometry, referenceView } from '../../fixtures/street-view.js';
import { PIPELINE_DEFAULTS } from '../../pipeline/versions.js';
import { createFixtureStreetViewProvider } from './fixture.js';
import {
  ViewpointFramingSchema,
  aimAt,
  directionOf,
  frameView,
  framedViewOf,
  framingOf,
  normalizeHeading,
  pointOf,
  wideViewOf,
  type FrameGeometry,
} from './framing.js';

const PARAMS = {
  marginFraction: PIPELINE_DEFAULTS.framing.marginFraction,
  minFovDeg: PIPELINE_DEFAULTS.framing.minFovDeg,
  slackBelowShare: PIPELINE_DEFAULTS.framing.slackBelowShare,
};

const square = (heading: number, pitch: number, fov: number): FrameGeometry => ({
  heading,
  pitch,
  fov,
  width: 640,
  height: 640,
});

/** Where the middle of each edge of `box` (seen in `view`) lands in the framed view. */
function edgesIn(view: FrameGeometry, box: NormalizedBox, framed: FrameGeometry) {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const at = (u: number, v: number) => {
    const point = pointOf(framed, directionOf(view, u, v));
    if (!point) throw new Error('behind the camera');
    return point;
  };
  return {
    left: at(x0, cy).u,
    right: at(x1, cy).u,
    top: at(cx, y0).v,
    bottom: at(cx, y1).v,
  };
}

/** Projects the corners of `box` into the framed view. */
function cornersIn(view: FrameGeometry, box: NormalizedBox, framed: FrameGeometry) {
  const [x0, y0, x1, y1] = box;
  return [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([u, v]) => pointOf(framed, directionOf(view, u as number, v as number)));
}

describe('framing a box of a Street View frame', () => {
  it('gives the recorded views of the two live cases', () => {
    const wilmette = square(6, 1.7, 60);
    const wilmetteBox: NormalizedBox = [0.165, 0.26, 0.495, 0.615];
    const first = frameView(wilmette, wilmetteBox, PARAMS);
    // Widened by a tenth of a degree from 26.8 so the home's upper outer corner keeps half the
    // margin.
    expect({ ...first, zoom: undefined }).toEqual({
      heading: 355.2,
      pitch: 5.1,
      fov: 26.9,
      zoom: undefined,
    });
    expect(first.zoom).toBeCloseTo(2.413678051773062, 12);
    const levittown = square(267.4, 2.4, 60);
    const levittownBox: NormalizedBox = [0.287, 0.31, 0.69, 0.595];
    const second = frameView(levittown, levittownBox, PARAMS);
    expect({ ...second, zoom: undefined }).toEqual({
      heading: 266.7,
      pitch: 4.2,
      fov: 31.1,
      zoom: undefined,
    });
    expect(second.zoom).toBeCloseTo(2.078101177858391, 12);
  });

  it('puts the box inside the framed view with about the margin on its larger extent', () => {
    const cases: [FrameGeometry, NormalizedBox][] = [
      [square(6, 1.7, 60), [0.165, 0.26, 0.495, 0.615]],
      [square(267.4, 2.4, 60), [0.287, 0.31, 0.69, 0.595]],
      [square(120, 0, 75), [0.3, 0.35, 0.7, 0.55]],
    ];
    for (const [view, box] of cases) {
      const framed = { ...view, ...frameView(view, box, PARAMS) };
      for (const corner of cornersIn(view, box, framed)) {
        expect(corner).not.toBeNull();
        expect(corner!.u).toBeGreaterThan(0);
        expect(corner!.u).toBeLessThan(1);
        expect(corner!.v).toBeGreaterThan(0);
        expect(corner!.v).toBeLessThan(1);
      }
      const edges = edgesIn(view, box, framed);
      const horizontalMargin = Math.min(edges.left, 1 - edges.right);
      const verticalMargin = Math.min(edges.top, 1 - edges.bottom);
      // The binding extent keeps about the margin (rounding to a tenth of a degree moves it a little).
      expect(Math.min(horizontalMargin, verticalMargin)).toBeGreaterThan(0.06);
      expect(Math.min(horizontalMargin, verticalMargin)).toBeLessThan(0.1);
      // The ground before the home gets more of the vertical room than the sky above it.
      expect(1 - edges.bottom).toBeGreaterThanOrEqual(edges.top - 0.01);
    }
  });

  it('maps points to directions and back', () => {
    const views = [
      square(0, 0, 60),
      square(359.5, 4.8, 72.2),
      square(90, -10, 30),
      { heading: 200, pitch: 12, fov: 90, width: 640, height: 400 },
    ];
    for (const view of views) {
      for (const [u, v] of [
        [0.5, 0.5],
        [0.1, 0.2],
        [0.9, 0.85],
        [0.3, 0.7],
        [0, 1],
      ] as const) {
        const back = pointOf(view, directionOf(view, u, v));
        expect(back).not.toBeNull();
        expect(back!.u).toBeCloseTo(u, 9);
        expect(back!.v).toBeCloseTo(v, 9);
      }
    }
    const center = directionOf(square(10, 3, 60), 0.5, 0.5);
    expect(center.heading).toBeCloseTo(10, 9);
    expect(center.pitch).toBeCloseTo(3, 9);
    // A direction behind the camera lands nowhere.
    expect(pointOf(square(0, 0, 60), { heading: 180, pitch: 0 })).toBeNull();
  });

  it('frames a box at the frame edge toward that edge', () => {
    const view = square(100, 2, 60);
    const box: NormalizedBox = [0, 0.3, 0.4, 0.75];
    const framed = frameView(view, box, PARAMS);
    expect(framed.heading).toBeLessThan(100);
    expect(framed.fov).toBeLessThan(60);
    const edges = edgesIn(view, box, { ...view, ...framed });
    // Centered across, and its height (the larger extent) keeps the margin.
    expect(edges.left).toBeCloseTo(1 - edges.right, 2);
    expect(edges.left).toBeGreaterThan(PARAMS.marginFraction);
    expect(edges.top).toBeCloseTo(PARAMS.marginFraction, 1);
  });

  it('widens the view until the corners of a box at the frame side lie inside it', () => {
    const view = square(10, 2, 90);
    const box: NormalizedBox = [0, 0.3, 0.3, 0.7];
    const framed = { ...view, ...frameView(view, box, PARAMS) };
    expect(framed.fov).toBeLessThan(view.fov);
    // Every corner keeps at least half the margin, though re-aiming keystones the box.
    for (const corner of cornersIn(view, box, framed)) {
      expect(corner).not.toBeNull();
      for (const value of [corner!.u, corner!.v]) {
        expect(value).toBeGreaterThanOrEqual(PARAMS.marginFraction / 2);
        expect(value).toBeLessThanOrEqual(1 - PARAMS.marginFraction / 2);
      }
    }
    // Never wider than the view.
    expect(frameView(square(10, 2, 90), [0, 0, 0.6, 1], PARAMS).fov).toBeLessThanOrEqual(90);
  });

  it('fits a tall narrow box by its height', () => {
    const view = square(45, 3, 60);
    const box: NormalizedBox = [0.45, 0.1, 0.55, 0.85];
    const framed = frameView(view, box, PARAMS);
    const edges = edgesIn(view, box, { ...view, ...framed });
    expect(edges.top).toBeCloseTo(PARAMS.marginFraction, 1);
    expect(1 - edges.bottom).toBeCloseTo(PARAMS.marginFraction, 1);
    expect(edges.right - edges.left).toBeLessThan(0.3);
  });

  it('never narrows below the minimum field of view nor widens beyond the view', () => {
    const view = square(30, 2, 60);
    const small = frameView(view, [0.48, 0.48, 0.52, 0.52], PARAMS);
    expect(small.fov).toBe(PARAMS.minFovDeg);
    expect(small.zoom).toBeCloseTo(Math.tan(Math.PI / 6) / Math.tan(Math.PI / 18), 9);
    const whole = frameView(view, [0, 0, 1, 1], PARAMS);
    expect(whole.fov).toBe(60);
    expect(whole.zoom).toBe(1);
    // A view already narrower than the minimum keeps its own field of view.
    expect(frameView(square(30, 2, 15), [0.4, 0.4, 0.6, 0.6], PARAMS).fov).toBe(15);
  });

  it('keeps headings in [0, 360) across north', () => {
    const right = frameView(square(359, 2, 60), [0.6, 0.3, 0.9, 0.7], PARAMS);
    expect(right.heading).toBeGreaterThan(0);
    expect(right.heading).toBeLessThan(20);
    const left = frameView(square(1, 2, 60), [0.1, 0.3, 0.4, 0.7], PARAMS);
    expect(left.heading).toBeGreaterThan(340);
    expect(left.heading).toBeLessThan(360);
    // A box centered on north is aimed at 0, never 360.
    expect(frameView(square(0, 2, 60), [0.4, 0.3, 0.6, 0.7], PARAMS).heading).toBe(0);
    expect(normalizeHeading(-0.5)).toBe(359.5);
    expect(normalizeHeading(720)).toBe(0);
  });

  it('frames a box of a non-square frame on that frame', () => {
    const view = { heading: 210, pitch: 1, fov: 80, width: 640, height: 400 };
    const box: NormalizedBox = [0.35, 0.2, 0.6, 0.8];
    const framed = { ...view, ...frameView(view, box, PARAMS) };
    for (const corner of cornersIn(view, box, framed)) {
      expect(corner!.u).toBeGreaterThan(0);
      expect(corner!.u).toBeLessThan(1);
      expect(corner!.v).toBeGreaterThan(0);
      expect(corner!.v).toBeLessThan(1);
    }
    // The box is taller than the frame's aspect: its height binds.
    const edges = edgesIn(view, box, framed);
    expect(edges.top).toBeCloseTo(PARAMS.marginFraction, 1);
    expect(Math.min(edges.left, 1 - edges.right)).toBeGreaterThan(PARAMS.marginFraction);
  });
});

describe('aiming a frame at a box', () => {
  it('turns to the angular middle of the box at its mid-height', () => {
    expect(aimAt(square(109.9, 10, 90), [0.83, 0.3, 1, 0.7])).toEqual({
      heading: 149.5,
      turnDeg: expect.closeTo(39.6, 9),
    });
    expect(aimAt(square(10, 3.8, 90), [0, 0.3, 0.2, 0.7])).toEqual({
      heading: 332,
      turnDeg: expect.closeTo(-38, 9),
    });
    expect(aimAt(square(200, 0, 90), [0, 0.2, 0.97, 0.8])).toEqual({
      heading: 199.1,
      turnDeg: expect.closeTo(-0.9, 9),
    });
    // A box centered on north is aimed at 0, never 360.
    expect(aimAt(square(0, 2, 60), [0.4, 0.3, 0.6, 0.7]).heading).toBe(0);
  });

  it('gives the heading the framed view of the same box takes', () => {
    const cases: [FrameGeometry, NormalizedBox][] = [
      [square(6, 1.7, 60), [0.165, 0.26, 0.495, 0.615]],
      [square(267.4, 2.4, 60), [0.287, 0.31, 0.69, 0.595]],
      [square(120, 0, 75), [0.3, 0.35, 0.7, 0.55]],
      [square(100, 2, 60), [0, 0.3, 0.4, 0.75]],
      [square(10, 2, 90), [0, 0.3, 0.3, 0.7]],
      [square(359, 2, 60), [0.6, 0.3, 0.9, 0.7]],
      [square(1, 2, 60), [0.1, 0.3, 0.4, 0.7]],
      [{ heading: 210, pitch: 1, fov: 80, width: 640, height: 400 }, [0.35, 0.2, 0.6, 0.8]],
    ];
    for (const [view, box] of cases) {
      expect(aimAt(view, box).heading).toBe(frameView(view, box, PARAMS).heading);
    }
  });
});

describe('a recorded framing', () => {
  const viewpoint: ViewpointJson = {
    panoId: 'pano-road',
    heading: 109.9,
    headingMode: 'road',
    pitch: 3.8,
    fov: 90,
    width: 640,
    height: 640,
    source: 'outdoor',
    captureGranularity: 'month',
    fetchedAt: null,
    sourceCheckedAt: null,
  };
  const recorded = {
    promptVersion: 'frame-2026.11.0',
    model: 'm',
    framedAt: '2026-11-13T00:00:00Z',
  };
  const reaim = {
    heading: 149.6,
    box: [0.842, 0.395, 1, 0.647] as NormalizedBox,
    promptVersion: 'frame-road-2026.11.0',
  };

  it('reads the records of an aimed frame as before', () => {
    const framed = {
      status: 'framed',
      heading: 355.2,
      pitch: 5.1,
      fov: 26.8,
      box: [0.165, 0.26, 0.495, 0.615],
      zoom: 2.423,
      displayIssuedAt: '2026-11-13T00:00:00Z',
      ...recorded,
    };
    expect(ViewpointFramingSchema.parse(framed)).toEqual(framed);
    const kept = { status: 'kept', reason: 'small_gain', box: [0, 0, 1, 1], ...recorded };
    expect(ViewpointFramingSchema.parse(kept)).toEqual(kept);
  });

  it('reads a re-aim and the reason of a frame at zoom 1', () => {
    const zoomed = {
      status: 'framed' as const,
      heading: 152.5,
      pitch: 1,
      fov: 33.3,
      box: [0.401, 0.395, 0.652, 0.647] as NormalizedBox,
      zoom: 3.34,
      reaim,
      ...recorded,
    };
    expect(framingOf({ framing: zoomed })).toEqual(zoomed);
    const filled = {
      status: 'framed' as const,
      heading: 149.6,
      pitch: 3.8,
      fov: 90,
      box: [0.05, 0.1, 0.95, 0.9] as NormalizedBox,
      zoom: 1,
      reason: 'small_gain' as const,
      reaim,
      ...recorded,
    };
    expect(framingOf({ framing: filled })).toEqual(filled);
    expect(framingOf({ framing: { ...filled, reason: 'refused_framed' } })).toMatchObject({
      reason: 'refused_framed',
      reaim,
    });
    // A re-aim without the prompt of its first call, or a reason a framed record never takes,
    // does not read.
    const { promptVersion: _dropped, ...withoutVersion } = reaim;
    expect(framingOf({ framing: { ...zoomed, reaim: withoutVersion } as never })).toBeNull();
    expect(framingOf({ framing: { ...filled, reaim: { ...reaim, heading: 360 } } })).toBeNull();
    expect(framingOf({ framing: { ...filled, reason: 'no_home' } as never })).toBeNull();
  });

  it('gives the wide frame the framing was decided on, and the frame it shows', () => {
    expect(wideViewOf(viewpoint)).toEqual(framedViewOf(viewpoint));
    const zoomed: ViewpointJson = {
      ...viewpoint,
      framing: {
        status: 'framed',
        heading: 152.5,
        pitch: 1,
        fov: 33.3,
        box: [0.401, 0.395, 0.652, 0.647],
        zoom: 3.34,
        reaim,
        ...recorded,
      },
    };
    expect(wideViewOf(zoomed)).toEqual({
      panoId: 'pano-road',
      heading: 149.6,
      pitch: 3.8,
      fov: 90,
      width: 640,
      height: 640,
    });
    // Without a re-aim the wide frame is the viewpoint's own view, also when framed.
    const { reaim: _none, ...aimed } = zoomed.framing as Extract<
      ViewpointJson['framing'],
      { status: 'framed' }
    >;
    expect(wideViewOf({ ...viewpoint, framing: aimed })).toEqual(framedViewOf(viewpoint));
    // A framed record at zoom 1 is fetched and shown at its own view.
    const filled: ViewpointJson = {
      ...viewpoint,
      framing: {
        status: 'framed',
        heading: 149.6,
        pitch: 3.8,
        fov: 90,
        box: [0.05, 0.1, 0.95, 0.9],
        zoom: 1,
        reason: 'small_gain',
        reaim,
        ...recorded,
      },
    };
    expect(framedViewOf(filled)).toEqual(wideViewOf(filled));
    expect(framedViewOf(filled)).toMatchObject({ heading: 149.6, pitch: 3.8, fov: 90 });
  });
});

describe('the view of a viewpoint', () => {
  const viewpoint: ViewpointJson = {
    panoId: 'pano-1',
    heading: 6,
    headingMode: 'point',
    pitch: 1.7,
    fov: 60,
    width: 640,
    height: 640,
    source: 'outdoor',
    captureGranularity: 'month',
    fetchedAt: null,
    sourceCheckedAt: null,
  };
  const recorded = {
    promptVersion: 'frame-2026.11.0',
    model: 'm',
    framedAt: '2026-11-11T00:00:00Z',
  };

  it('is the framed view once framed, else the viewpoint own view', () => {
    expect(framedViewOf(viewpoint)).toEqual({
      panoId: 'pano-1',
      heading: 6,
      pitch: 1.7,
      fov: 60,
      width: 640,
      height: 640,
    });
    const framed: ViewpointJson = {
      ...viewpoint,
      framing: {
        status: 'framed',
        heading: 355.2,
        pitch: 5.1,
        fov: 26.8,
        box: [0.165, 0.26, 0.495, 0.615],
        zoom: 2.423,
        ...recorded,
      },
    };
    expect(framedViewOf(framed)).toEqual({
      panoId: 'pano-1',
      heading: 355.2,
      pitch: 5.1,
      fov: 26.8,
      width: 640,
      height: 640,
    });
    const kept: ViewpointJson = {
      ...viewpoint,
      framing: { status: 'kept', reason: 'small_gain', box: [0, 0, 1, 1], ...recorded },
    };
    expect(framedViewOf(kept)).toMatchObject({ heading: 6, pitch: 1.7, fov: 60 });
    expect(framingOf(kept)?.status).toBe('kept');
    // A framing that cannot be read is ignored.
    const broken = { ...viewpoint, framing: { status: 'framed', heading: 'north' } } as never;
    expect(framedViewOf(broken)).toMatchObject({ heading: 6, pitch: 1.7, fov: 60 });
    expect(framingOf(broken)).toBeNull();
  });
});

describe('the fixture Street View frame of a framed view', () => {
  it('zooms in on the home: other pixels, and the geometry follows the view', async () => {
    const data = loadFixtureData();
    const found = data.panorama('fxSvOldQuarryRoa19p1Sv');
    expect(found).toBeDefined();
    const reference = referenceView(found!.place, found!.panorama);
    const wide = { panoId: 'fxSvOldQuarryRoa19p1Sv', ...reference, width: 640, height: 640 };
    const wideGeometry = fixturePanoramaGeometry(wide);
    const facade = wideGeometry?.targetFacade;
    expect(facade).toBeDefined();
    const framed = { ...wide, ...frameView(wide, facade!, PARAMS) };
    expect(framed.fov).toBeLessThan(wide.fov);
    const framedGeometry = fixturePanoramaGeometry(framed);
    const framedFacade = framedGeometry?.targetFacade;
    expect(framedFacade).toBeDefined();
    const area = (box: NormalizedBox) => (box[2] - box[0]) * (box[3] - box[1]);
    expect(area(framedFacade!)).toBeGreaterThan(area(facade!) * 1.2);

    const provider = createFixtureStreetViewProvider({
      publicBaseUrl: 'http://localhost',
      sessionSecret: 'framing-test-secret-0123456789abcdef',
    });
    const [widePixels, framedPixels] = await Promise.all([
      provider.fetchTransient(wide),
      provider.fetchTransient(framed),
    ]);
    expect(framedPixels.checksum).not.toBe(widePixels.checksum);
    expect(framedPixels.width).toBe(640);
  });
});
