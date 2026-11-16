import type { BuildingForm, NormalizedBox, PreserveRegion } from '@hailiday/core';
import { signedAngleDelta } from '../providers/geo.js';
import type { HouseParams } from './data.js';
import {
  AnchorCollector,
  DAYLIGHT,
  NO_QUALITY_FLAGS,
  type FixtureSceneGeometry,
  type RenderedScene,
} from './scene.js';
import {
  Rng,
  SvgBuilder,
  darken,
  escapeXml,
  isBrickColor,
  lighten,
  mix,
  n,
  normBox,
  normBoxes,
  points,
  pxBox,
  rasterize,
  unionPx,
  type PxBox,
} from './svg.js';

/** A pinhole camera looking at a frontal facade. World units are meters. */
export interface HouseCamera {
  width: number;
  height: number;
  /** Focal length in pixels. */
  f: number;
  /** Image x of the optical axis. */
  axisX: number;
  /** Image y of the horizon. */
  horizonY: number;
  cameraHeight: number;
  /** Depth of the facade plane from the camera. */
  distance: number;
  /** World x of the facade center (0 when the camera aims at it). */
  lateral: number;
}

/** View parameters of a Street View-style frame. */
export interface StreetViewFrame {
  heading: number;
  fov: number;
  pitch: number;
  width: number;
  height: number;
}

/**
 * The camera for a Street View frame: the facade's center lies on the bearing from the
 * panorama to the target at the panorama distance; heading, fov and pitch aim the frame.
 */
export function streetViewCamera(
  frame: StreetViewFrame,
  panorama: { distanceM: number; bearingToTargetDeg: number },
  cameraHeight = 2.5,
): HouseCamera {
  const f = frame.width / 2 / Math.tan(((frame.fov / 2) * Math.PI) / 180);
  const delta = signedAngleDelta(frame.heading, panorama.bearingToTargetDeg);
  const distance = Math.max(3, panorama.distanceM);
  const lateral =
    Math.abs(delta) >= 80 ? Math.sign(delta) * 1000 : distance * Math.tan((delta * Math.PI) / 180);
  return {
    width: frame.width,
    height: frame.height,
    f,
    axisX: frame.width / 2,
    horizonY: frame.height / 2 + f * Math.tan((frame.pitch * Math.PI) / 180),
    cameraHeight,
    distance,
    lateral,
  };
}

/** Default facade width per house style when building geometry is unknown. */
export const DEFAULT_FACADE_WIDTH_M: Record<HouseParams['style'], number> = {
  colonial: 13,
  bungalow: 11,
  cape_cod: 10.5,
  farmhouse: 14,
  ranch: 16,
  townhouse_row: 5.5,
  apartment_block: 30,
};

/** A camera that frames the house for art-directed crops (heroes). */
export function framedHouseCamera(
  width: number,
  height: number,
  house: HouseParams,
  options: { focalX: number; focalY: number; houseWidthFraction: number; distance?: number },
): HouseCamera {
  const facade = DEFAULT_FACADE_WIDTH_M[house.style];
  const distance = options.distance ?? 16;
  const f = (options.houseWidthFraction * width * distance) / facade;
  const cameraHeight = 1.7;
  // The door center (about 1.7 m up on the porch) lands on the focal point.
  const horizonY = options.focalY * height + (f * (1.7 - cameraHeight)) / distance;
  return {
    width,
    height,
    f,
    axisX: options.focalX * width,
    horizonY,
    cameraHeight,
    distance,
    lateral: 0,
  };
}

export interface HouseRenderInput {
  house: HouseParams;
  camera: HouseCamera;
  facadeWidthM?: number | null;
  /** Burned-in attribution text, for example `© 2025 Google`; null for a clean frame. */
  watermark?: string | null;
  seed: string;
  /** Draw no road-side clutter (heroes). */
  clean?: boolean;
}

const SEASON_SKY = {
  summer: ['#5E9BD3', '#9CC6EA', '#DCEEFA'],
  autumn: ['#6C9FCF', '#A8C8E2', '#EEEDE6'],
  winter: ['#9DB0C2', '#C3CFDA', '#E9EDF1'],
} as const;

const SEASON_LAWN = {
  summer: ['#5F8F3E', '#76A64B', '#8BB959'],
  autumn: ['#6E8A47', '#83994F', '#9AAE5E'],
  winter: ['#DCE3EA', '#ECF0F4', '#F8FAFC'],
} as const;

const LEAVES = {
  summer: ['#2F5A2C', '#3E6B35', '#4F7F3F', '#5F9147', '#77A852'],
  autumn: ['#8A3B22', '#B5502A', '#D07A2E', '#E0A53D', '#C9C04A', '#9C6A2A'],
  winter: ['#5E5148'],
} as const;

const NEIGHBOR_COLORS = ['#D8D2C3', '#B9C5CB', '#C7B49A', '#A9B6A3', '#D9C8B4', '#9FAFBC'];

/** Draws the house, its lot and surroundings, and returns the SVG plus exact geometry. */
export function renderHouse(input: HouseRenderInput): RenderedScene {
  const { house, camera } = input;
  const {
    width: W,
    height: H,
    f,
    axisX,
    horizonY,
    cameraHeight: hc,
    distance: d,
    lateral,
  } = camera;
  const rng = new Rng(input.seed);
  const svg = new SvgBuilder(W, H, 'h');
  const anchors = new AnchorCollector(W, H);
  const season = house.season;
  const winter = season === 'winter';

  const P = (X: number, Y: number, Z: number): [number, number] => {
    const z = Math.max(0.25, Z);
    return [axisX + (f * (lateral + X)) / z, horizonY - (f * (Y - hc)) / z];
  };
  const R = (X0: number, X1: number, Y0: number, Y1: number, Z: number): PxBox => {
    const [x0, y0] = P(X0, Y1, Z);
    const [x1, y1] = P(X1, Y0, Z);
    return pxBox(x0, y0, x1, y1);
  };
  const groundY = (Z: number) => horizonY + (f * hc) / Math.max(0.25, Z);
  const rect = (b: PxBox, fill: string, extra = '') =>
    `<rect x="${n(b.x0)}" y="${n(b.y0)}" width="${n(b.x1 - b.x0)}" height="${n(b.y1 - b.y0)}" fill="${fill}"${extra}/>`;
  const poly = (pts: [number, number][], fill: string, extra = '') =>
    `<polygon points="${points(pts)}" fill="${fill}"${extra}/>`;
  const line = (a: [number, number], b: [number, number], stroke: string, w: number, extra = '') =>
    `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" stroke="${stroke}" stroke-width="${n(w)}"${extra}/>`;
  const px = (meters: number, Z: number) => (f * meters) / Math.max(0.25, Z);

  // ---- dimensions --------------------------------------------------------------------
  const style = house.style;
  const Wf = Math.max(4, input.facadeWidthM ?? DEFAULT_FACADE_WIDTH_M[style]);
  const floorY = style === 'apartment_block' || style === 'townhouse_row' ? 0.9 : 0.6;
  const storyH = 3;
  const wallH = floorY + house.stories * storyH + 0.2;
  const flat = house.roofShape === 'flat' || style === 'apartment_block';
  const rise = flat
    ? 0
    : style === 'cape_cod'
      ? 4.6
      : style === 'ranch'
        ? 2.3
        : style === 'bungalow'
          ? 2.7
          : house.roofShape === 'hip'
            ? 3.3
            : 4.1;
  const overhang = flat ? 0 : 0.45;
  const roofDepth = 3.8;
  const doorX =
    style === 'ranch'
      ? -Wf * 0.12
      : style === 'townhouse_row'
        ? -Wf * 0.18
        : house.garage
          ? -Wf * 0.08
          : 0;
  const stepsW = house.porch === 'none' ? 1.6 : 1.8;
  const porchDepth = house.porch === 'full' ? 2.4 : house.porch === 'stoop' ? 1.3 : 0.4;
  const Zf = d - porchDepth;
  const stepsFrontZ = house.porch === 'none' ? d - 0.75 : Zf - 0.66;
  const Zs = Math.max(1.2, d - house.setbackMeters);
  const bottomZ = H > horizonY ? (f * hc) / (H - horizonY) : 0.5;
  const brick = isBrickColor(house.bodyColor);
  const body = house.bodyColor;
  const trim = house.trimColor;
  const roofColor = house.roofColor;

  // ---- sky --------------------------------------------------------------------------
  const sky = SEASON_SKY[season];
  svg.add(
    `<rect width="${W}" height="${n(Math.max(0, horizonY) + 4)}" fill="url(#${svg.linear([
      [0, sky[0]],
      [0.6, sky[1]],
      [1, sky[2]],
    ])})"/>`,
  );
  const cloudBlur = svg.blur(Math.max(2, W * 0.012));
  const cloudParts: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const cx = rng.range(-0.1, 1.1) * W;
    const cy = rng.range(0.05, 0.42) * Math.max(10, horizonY);
    const rw = rng.range(0.08, 0.2) * W;
    cloudParts.push(
      `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rw)}" ry="${n(rw * 0.22)}" fill="#ffffff" opacity="${winter ? 0.55 : 0.75}"/>`,
      `<ellipse cx="${n(cx + rw * 0.35)}" cy="${n(cy - rw * 0.08)}" rx="${n(rw * 0.5)}" ry="${n(rw * 0.2)}" fill="#ffffff" opacity="0.6"/>`,
    );
  }
  svg.add(`<g filter="url(#${cloudBlur})">${cloudParts.join('')}</g>`);

  // ---- distant tree line ---------------------------------------------------------------
  const farZ = d + 45;
  const tl: string[] = [];
  const farColors =
    season === 'autumn'
      ? ['#7D6B45', '#8E5F3A', '#6F7349', '#9A7B42']
      : winter
        ? ['#8C8F93', '#7E8389', '#9AA0A6']
        : ['#4B6B47', '#567A4F', '#3F5E40'];
  for (let x = -0.05 * W; x < W * 1.05;) {
    const r = px(rng.range(2.5, 5), farZ);
    tl.push(
      `<circle cx="${n(x)}" cy="${n(groundY(farZ) - r * rng.range(0.4, 1))}" r="${n(r)}" fill="${rng.pick(farColors)}"/>`,
    );
    x += r * rng.range(0.7, 1.2);
  }
  svg.add(`<g opacity="0.85">${tl.join('')}</g>`);
  svg.add(
    rect(
      pxBox(0, groundY(farZ) - px(2, farZ), W, groundY(farZ) + 2),
      mix(sky[2], farColors[0] as string, 0.35),
      ' opacity="0.5"',
    ),
  );

  // ---- ground ---------------------------------------------------------------------------
  const lawn = SEASON_LAWN[season];
  svg.add(
    rect(
      pxBox(0, groundY(farZ), W, H),
      `url(#${svg.linear([
        [0, lawn[0]],
        [0.5, lawn[1]],
        [1, lawn[2]],
      ])})`,
    ),
  );
  // Mowing stripes and grass texture.
  const grass: string[] = [];
  if (!winter) {
    for (let k = 0; k < 9; k += 1) {
      const z0 = Zs + 0.5 + k * 3;
      const z1 = z0 + 1.5;
      if (groundY(z1) > H) continue;
      grass.push(
        rect(pxBox(0, groundY(z1), W, groundY(z0)), lighten(lawn[1], 0.08), ' opacity="0.35"'),
      );
    }
    for (let i = 0; i < 520; i += 1) {
      const z = rng.range(Math.max(bottomZ, 1), d + 4);
      const gy = groundY(z);
      if (gy > H + 4) continue;
      const gx = rng.range(0, W);
      const len = px(rng.range(0.06, 0.14), z);
      grass.push(
        line(
          [gx, gy],
          [gx + rng.jitter(len * 0.4), gy - len],
          rng.pick([darken(lawn[1], 0.18), lighten(lawn[2], 0.15)]),
          Math.max(0.5, len * 0.18),
          ' opacity="0.5"',
        ),
      );
    }
  } else {
    for (let i = 0; i < 60; i += 1) {
      const z = rng.range(Math.max(bottomZ, 1), d + 4);
      const gy = groundY(z);
      grass.push(
        `<ellipse cx="${n(rng.range(0, W))}" cy="${n(gy)}" rx="${n(px(rng.range(0.3, 0.9), z))}" ry="${n(px(0.035, z))}" fill="#C4CFDA" opacity="0.35"/>`,
      );
    }
  }
  if (season === 'autumn') {
    for (let i = 0; i < 260; i += 1) {
      const z = rng.range(Math.max(bottomZ, 1), d + 3);
      const r = px(rng.range(0.05, 0.09), z);
      grass.push(
        `<ellipse cx="${n(rng.range(0, W))}" cy="${n(groundY(z))}" rx="${n(r)}" ry="${n(r * 0.55)}" fill="${rng.pick(LEAVES.autumn)}" opacity="0.85"/>`,
      );
    }
  }
  svg.add(`<g>${grass.join('')}</g>`);

  // Sidewalk, curb and road (only the parts in front of the camera).
  const sidewalkFar = Zs;
  const sidewalkNear = Zs - 1.6;
  if (sidewalkNear > 0.3) {
    svg.add(
      rect(
        pxBox(0, groundY(sidewalkFar), W, groundY(sidewalkNear)),
        winter ? '#DADFE4' : '#CBC6BC',
      ),
    );
    for (let k = 0; k < 40; k += 1) {
      const xw = -30 + k * 1.5;
      svg.add(
        line(P(xw, 0, sidewalkFar), P(xw, 0, sidewalkNear), '#B3ADA2', Math.max(0.5, px(0.02, Zs))),
      );
    }
    svg.add(rect(pxBox(0, groundY(sidewalkNear), W, groundY(sidewalkNear - 0.18)), '#A9A49B'));
    svg.add(
      rect(
        pxBox(0, groundY(sidewalkNear - 0.18), W, H + 2),
        `url(#${svg.linear([
          [0, '#6A6D71'],
          [1, '#4E5155'],
        ])})`,
      ),
    );
  }

  // Walkway from the steps to the sidewalk.
  const walkFar = stepsFrontZ;
  const walkNear = Math.max(Zs, 0.4);
  const walkL = doorX - 0.65;
  const walkR = doorX + 0.65;
  let walkwayBox: PxBox | null = null;
  if (walkFar > walkNear) {
    const pts = [
      P(walkL, 0, walkFar),
      P(walkR, 0, walkFar),
      P(walkR, 0, walkNear),
      P(walkL, 0, walkNear),
    ];
    svg.add(poly(pts, winter ? '#C9C6C0' : '#D6D0C4'));
    for (let z = walkFar - 0.9; z > walkNear; z -= 0.9) {
      svg.add(line(P(walkL, 0, z), P(walkR, 0, z), '#B9B2A4', Math.max(0.5, px(0.025, z))));
    }
    walkwayBox = unionPx([
      pxBox(pts[0][0], pts[0][1], pts[2][0], pts[2][1]),
      pxBox(pts[3][0], pts[3][1], pts[1][0], pts[1][1]),
    ]);
  }
  // Driveway to the garage.
  if (house.garage && walkFar > walkNear) {
    const gx0 = Wf / 2 - 3.6;
    const gx1 = Wf / 2 - 0.3;
    svg.add(
      poly(
        [P(gx0, 0, d), P(gx1, 0, d), P(gx1 + 0.4, 0, walkNear), P(gx0 - 0.2, 0, walkNear)],
        winter ? '#CFCFCC' : '#C3BEB4',
      ),
    );
  }

  // ---- neighbors (detached, behind) ------------------------------------------------------
  const neighborFacades: NormalizedBox[] = [];
  const preserve: PreserveRegion[] = [];
  const drawSimpleHouse = (
    cx: number,
    z: number,
    w: number,
    stories: number,
    color: string,
    side: number,
  ) => {
    const wh = 0.6 + stories * 3;
    const b = R(cx - w / 2, cx + w / 2, 0, wh, z);
    const parts: string[] = [rect(b, color)];
    for (let y = 0.8; y < wh; y += 0.22) {
      parts.push(
        line(
          P(cx - w / 2, y, z),
          P(cx + w / 2, y, z),
          darken(color, 0.1),
          Math.max(0.4, px(0.015, z)),
          ' opacity="0.5"',
        ),
      );
    }
    const roofPts: [number, number][] = [
      P(cx - w / 2 - 0.4, wh, z - 0.4),
      P(cx + w / 2 + 0.4, wh, z - 0.4),
      P(cx + w / 2 + 0.4, wh + 2.6, z + 4),
      P(cx - w / 2 - 0.4, wh + 2.6, z + 4),
    ];
    parts.push(poly(roofPts, winter ? '#E8ECEF' : darken(color, 0.55)));
    for (let s = 0; s < stories; s += 1) {
      for (let i = 0; i < 3; i += 1) {
        const wx = cx - w / 2 + (i + 0.5) * (w / 3);
        const wb = R(wx - 0.5, wx + 0.5, 0.6 + s * 3 + 0.9, 0.6 + s * 3 + 2.3, z);
        parts.push(
          rect(pxBox(wb.x0 - 2, wb.y0 - 2, wb.x1 + 2, wb.y1 + 2), '#F2EFE8'),
          rect(wb, '#5C6B78'),
        );
      }
    }
    svg.add(`<g>${parts.join('')}</g>`);
    const fb = unionPx([b, pxBox(roofPts[2][0], roofPts[2][1], roofPts[0][0], roofPts[0][1])]);
    const nb = fb ? normBox(fb, W, H) : null;
    if (nb) neighborFacades.push(nb);
    return side;
  };
  if (style !== 'townhouse_row') {
    if (house.neighborLeft)
      drawSimpleHouse(-(Wf / 2 + 5 + 5), d + 2, 10, 2, rng.pick(NEIGHBOR_COLORS), -1);
    if (house.neighborRight)
      drawSimpleHouse(Wf / 2 + 5 + 5.5, d + 2.5, 11, 2, rng.pick(NEIGHBOR_COLORS), 1);
  }

  // ---- the house ------------------------------------------------------------------------
  const houseParts: string[] = [];
  const add = (markup: string) => houseParts.push(markup);
  const lineW = (meters: number) => Math.max(0.5, px(meters, d));

  // Attached neighbors in the same facade plane (row houses).
  if (style === 'townhouse_row') {
    const colors = ['#9C4A3A', '#C9B79C', '#6E6A5E', '#B7A58A', '#8FA7B5'];
    for (const side of [-1, 1]) {
      for (let k = 1; k <= 3; k += 1) {
        const cx = side * Wf * k;
        const color = colors[(k + (side > 0 ? 2 : 0)) % colors.length] as string;
        const nb = R(cx - Wf / 2, cx + Wf / 2, 0, wallH, d);
        add(rect(nb, color));
        for (let y = floorY + 0.2; y < wallH; y += 0.16)
          add(
            line(
              P(cx - Wf / 2, y, d),
              P(cx + Wf / 2, y, d),
              darken(color, 0.12),
              lineW(0.012),
              ' opacity="0.45"',
            ),
          );
        add(rect(R(cx - Wf / 2, cx + Wf / 2, wallH, wallH + 0.6, d), darken(color, 0.25)));
        for (let s = 0; s < house.stories; s += 1) {
          for (const wxo of [-Wf * 0.22, Wf * 0.22]) {
            if (s === 0 && wxo < 0) continue;
            const wb = R(
              cx + wxo - 0.5,
              cx + wxo + 0.5,
              floorY + s * 3 + 0.9,
              floorY + s * 3 + 2.4,
              d,
            );
            add(
              rect(
                pxBox(
                  wb.x0 - lineW(0.1),
                  wb.y0 - lineW(0.1),
                  wb.x1 + lineW(0.1),
                  wb.y1 + lineW(0.1),
                ),
                '#EFE8DA',
              ),
            );
            add(rect(wb, '#4F5D69'));
          }
        }
        const db = R(cx - Wf * 0.22 - 0.5, cx - Wf * 0.22 + 0.5, floorY, floorY + 2.2, d);
        add(rect(db, rng.pick(['#1F3B2D', '#33475B', '#5A2A2A', '#2B2B2B'])));
        add(rect(R(cx - Wf * 0.22 - 0.9, cx - Wf * 0.22 + 0.9, 0, floorY, d - 0.9), '#9A948B'));
        const box = normBox(R(cx - Wf / 2, cx + Wf / 2, 0, wallH + 0.6, d), W, H);
        if (box) neighborFacades.push(box);
      }
    }
  }

  const bodyBox = R(-Wf / 2, Wf / 2, 0, wallH, d);
  add(rect(bodyBox, body));
  // Siding or brick texture.
  if (brick) {
    const row = 0.16;
    for (let y = floorY; y < wallH; y += row) {
      add(
        line(
          P(-Wf / 2, y, d),
          P(Wf / 2, y, d),
          lighten(body, 0.35),
          lineW(0.012),
          ' opacity="0.55"',
        ),
      );
      if (px(row, d) > 4) {
        const offset = Math.round((y - floorY) / row) % 2 === 0 ? 0 : 0.12;
        for (let x = -Wf / 2 + offset; x < Wf / 2; x += 0.24) {
          add(
            line(P(x, y, d), P(x, y + row, d), lighten(body, 0.3), lineW(0.01), ' opacity="0.45"'),
          );
        }
      }
    }
    for (let i = 0; i < 120; i += 1) {
      const bx = rng.range(-Wf / 2, Wf / 2);
      const by = rng.range(floorY, wallH);
      add(
        rect(
          R(bx, bx + 0.22, by, by + 0.07, d),
          rng.pick([darken(body, 0.12), lighten(body, 0.08)]),
          ' opacity="0.5"',
        ),
      );
    }
  } else {
    for (let y = floorY + 0.2; y < wallH; y += 0.2) {
      add(
        line(
          P(-Wf / 2, y, d),
          P(Wf / 2, y, d),
          darken(body, 0.14),
          lineW(0.016),
          ' opacity="0.55"',
        ),
      );
      add(
        line(
          P(-Wf / 2, y - 0.02, d),
          P(Wf / 2, y - 0.02, d),
          lighten(body, 0.25),
          lineW(0.008),
          ' opacity="0.4"',
        ),
      );
    }
  }
  // Foundation.
  add(rect(R(-Wf / 2, Wf / 2, 0, floorY, d), '#8F8A82'));
  for (let x = -Wf / 2; x < Wf / 2; x += 0.6)
    add(line(P(x, 0, d), P(x, floorY, d), '#77736C', lineW(0.012)));
  // Corner boards.
  add(rect(R(-Wf / 2, -Wf / 2 + 0.16, floorY, wallH, d), trim));
  add(rect(R(Wf / 2 - 0.16, Wf / 2, floorY, wallH, d), trim));
  // Sunlight from the upper left.
  add(
    rect(
      bodyBox,
      `url(#${svg.linear(
        [
          [0, '#ffffff', 0.12],
          [0.5, '#ffffff', 0],
          [1, '#000000', 0.1],
        ],
        { x1: 0, y1: 0, x2: 1, y2: 0 },
      )})`,
    ),
  );

  // ---- windows ----------------------------------------------------------------------------
  const windowGlass: PxBox[] = [];
  const winW = style === 'ranch' || style === 'bungalow' ? 1.3 : 1.0;
  const winH = style === 'ranch' ? 1.3 : 1.55;
  const garageX0 = Wf / 2 - 3.6;
  const drawWindow = (cx: number, yb: number, w: number, h: number, z: number, upper: boolean) => {
    const t = 0.12;
    const frame = R(cx - w / 2 - t, cx + w / 2 + t, yb - t, yb + h + t, z);
    const glass = R(cx - w / 2, cx + w / 2, yb, yb + h, z);
    if (house.shutters && style !== 'apartment_block') {
      const shutter = mix(house.doorColor, '#2a2a2a', 0.35);
      for (const side of [-1, 1]) {
        const sx0 = side < 0 ? cx - w / 2 - t - w * 0.42 : cx + w / 2 + t;
        const sb = R(sx0, sx0 + w * 0.42, yb - t, yb + h + t, z);
        add(rect(sb, shutter));
        for (let y = yb; y < yb + h; y += 0.12)
          add(
            line(
              P(sx0 + 0.05, y, z),
              P(sx0 + w * 0.42 - 0.05, y, z),
              darken(shutter, 0.35),
              lineW(0.012),
            ),
          );
      }
    }
    add(rect(frame, trim));
    add(
      rect(
        glass,
        `url(#${svg.linear([
          [0, '#B9CEDD'],
          [0.45, '#6E8296'],
          [1, '#2F3C49'],
        ])})`,
      ),
    );
    // Curtains and a reflection streak.
    add(
      rect(
        pxBox(glass.x0, glass.y0, glass.x0 + (glass.x1 - glass.x0) * 0.22, glass.y1),
        '#EDE5D3',
        ' opacity="0.45"',
      ),
    );
    add(
      rect(
        pxBox(glass.x1 - (glass.x1 - glass.x0) * 0.22, glass.y0, glass.x1, glass.y1),
        '#EDE5D3',
        ' opacity="0.45"',
      ),
    );
    add(
      poly(
        [
          [glass.x0 + (glass.x1 - glass.x0) * 0.25, glass.y0],
          [glass.x0 + (glass.x1 - glass.x0) * 0.45, glass.y0],
          [glass.x0 + (glass.x1 - glass.x0) * 0.1, glass.y1],
          [glass.x0 - (glass.x1 - glass.x0) * 0.1, glass.y1],
        ],
        '#ffffff',
        ' opacity="0.16"',
      ),
    );
    // Muntins.
    const cols = style === 'colonial' || style === 'cape_cod' || style === 'farmhouse' ? 3 : 2;
    const rows = style === 'colonial' || style === 'cape_cod' || style === 'farmhouse' ? 4 : 2;
    for (let c = 1; c < cols; c += 1) {
      const x = cx - w / 2 + (c * w) / cols;
      add(line(P(x, yb, z), P(x, yb + h, z), trim, lineW(0.035)));
    }
    for (let r = 1; r < rows; r += 1) {
      const y = yb + (r * h) / rows;
      add(
        line(P(cx - w / 2, y, z), P(cx + w / 2, y, z), trim, lineW(r === rows / 2 ? 0.06 : 0.035)),
      );
    }
    // Sill.
    add(
      rect(
        R(cx - w / 2 - t - 0.08, cx + w / 2 + t + 0.08, yb - t - 0.06, yb - t, z),
        lighten(trim, 0.1),
      ),
    );
    add(
      rect(
        R(cx - w / 2 - t - 0.08, cx + w / 2 + t + 0.08, yb - t - 0.1, yb - t - 0.06, z),
        '#000000',
        ' opacity="0.15"',
      ),
    );
    windowGlass.push(glass);
    anchors.add('window_frame', frame, upper ? 0.92 : 0.94);
  };
  const perFloor = house.windowsPerFloor;
  for (let s = 0; s < house.stories; s += 1) {
    const yb = floorY + s * storyH + 0.85;
    for (let i = 0; i < perFloor; i += 1) {
      const cx = -Wf / 2 + ((i + 0.5) * Wf) / perFloor;
      if (style === 'townhouse_row' && s === 0 && Math.abs(cx - doorX) < 1.2) continue;
      if (s === 0 && Math.abs(cx - doorX) < winW / 2 + 0.9) continue;
      if (s === 0 && house.garage && cx + winW / 2 > garageX0 - 0.2) continue;
      if (style === 'farmhouse' && s === house.stories - 1 && Math.abs(cx) < 1.5) continue;
      drawWindow(cx, yb, winW, winH, d, s > 0);
    }
  }

  // ---- garage -----------------------------------------------------------------------------
  if (house.garage) {
    const gb = R(garageX0, Wf / 2 - 0.4, 0, 2.4, d);
    add(rect(pxBox(gb.x0 - lineW(0.15), gb.y0 - lineW(0.15), gb.x1 + lineW(0.15), gb.y1), trim));
    add(rect(gb, lighten(trim, 0.05)));
    for (let k = 1; k < 4; k += 1)
      add(
        line(
          P(garageX0, (k * 2.4) / 4, d),
          P(Wf / 2 - 0.4, (k * 2.4) / 4, d),
          darken(trim, 0.2),
          lineW(0.03),
        ),
      );
    for (let k = 0; k < 4; k += 1) {
      const x = garageX0 + 0.25 + k * 0.75;
      add(rect(R(x, x + 0.55, 1.85, 2.2, d), '#56636E'));
    }
  }

  // ---- door -----------------------------------------------------------------------------
  const doorW = 1.0;
  const doorH = 2.2;
  const doorBox = R(doorX - doorW / 2, doorX + doorW / 2, floorY, floorY + doorH, d);
  const transom = style === 'colonial' || style === 'farmhouse' || style === 'townhouse_row';
  const frameTop = floorY + doorH + (transom ? 0.55 : 0.18);
  const frameBox = R(
    doorX - doorW / 2 - 0.22,
    doorX + doorW / 2 + 0.22,
    floorY,
    frameTop + 0.12,
    d,
  );
  add(rect(frameBox, trim));
  add(
    rect(
      R(doorX - doorW / 2 - 0.3, doorX + doorW / 2 + 0.3, frameTop, frameTop + 0.16, d),
      lighten(trim, 0.08),
    ),
  );
  if (transom) {
    const tb = R(doorX - doorW / 2, doorX + doorW / 2, floorY + doorH + 0.08, frameTop - 0.05, d);
    add(rect(tb, '#56687A'));
    for (let k = 1; k < 4; k += 1)
      add(
        line(
          [tb.x0 + ((tb.x1 - tb.x0) * k) / 4, tb.y0],
          [tb.x0 + ((tb.x1 - tb.x0) * k) / 4, tb.y1],
          trim,
          lineW(0.03),
        ),
      );
  }
  add(rect(doorBox, house.doorColor));
  for (const [ix0, iy0, ix1, iy1] of [
    [0.14, 0.07, 0.46, 0.45],
    [0.54, 0.07, 0.86, 0.45],
    [0.14, 0.53, 0.46, 0.93],
    [0.54, 0.53, 0.86, 0.93],
  ] as const) {
    const pb = pxBox(
      doorBox.x0 + (doorBox.x1 - doorBox.x0) * ix0,
      doorBox.y0 + (doorBox.y1 - doorBox.y0) * iy0,
      doorBox.x0 + (doorBox.x1 - doorBox.x0) * ix1,
      doorBox.y0 + (doorBox.y1 - doorBox.y0) * iy1,
    );
    add(rect(pb, darken(house.doorColor, 0.18)));
    add(
      rect(
        pxBox(pb.x0, pb.y0, pb.x1, pb.y0 + Math.max(0.6, (pb.y1 - pb.y0) * 0.08)),
        lighten(house.doorColor, 0.2),
        ' opacity="0.7"',
      ),
    );
  }
  const [kx, ky] = P(doorX + doorW / 2 - 0.13, floorY + 1.0, d);
  add(`<circle cx="${n(kx)}" cy="${n(ky)}" r="${n(Math.max(0.8, px(0.045, d)))}" fill="#C9A227"/>`);
  anchors.add('front_door', doorBox, 0.97);
  anchors.add('door_frame', frameBox, 0.95);
  // Sconce beside the door and the house-number plaque.
  const sconce = R(
    doorX - doorW / 2 - 0.55,
    doorX - doorW / 2 - 0.35,
    floorY + 1.55,
    floorY + 1.95,
    d,
  );
  add(rect(sconce, '#2B2B2B'));
  add(
    rect(
      pxBox(
        sconce.x0 + 1,
        sconce.y0 + (sconce.y1 - sconce.y0) * 0.25,
        sconce.x1 - 1,
        sconce.y1 - 1,
      ),
      '#F3E2B3',
      ' opacity="0.8"',
    ),
  );
  const plaque = R(
    doorX + doorW / 2 + 0.35,
    doorX + doorW / 2 + 0.7,
    floorY + 1.55,
    floorY + 1.75,
    d,
  );
  add(rect(plaque, '#2A2A2A'));
  add(
    rect(
      pxBox(plaque.x0 + 1, plaque.y0 + 1, plaque.x1 - 1, plaque.y1 - 1),
      'none',
      ` stroke="#C9A227" stroke-width="${n(lineW(0.015))}"`,
    ),
  );
  const plaqueBox = normBox(plaque, W, H);
  if (plaqueBox) preserve.push({ kind: 'house_number', box: plaqueBox });
  const lightSources: NormalizedBox[] = [];
  const sconceBox = normBox(sconce, W, H);
  if (sconceBox) lightSources.push(sconceBox);

  // ---- roof -------------------------------------------------------------------------------
  const roofParts: string[] = [];
  let roofTop: number;
  let ridgeBox: PxBox | null;
  let eaveBox: PxBox | null;
  const ez = d - overhang;
  if (flat) {
    const cornice = R(-Wf / 2 - 0.2, Wf / 2 + 0.2, wallH, wallH + 0.35, d - 0.2);
    roofParts.push(rect(R(-Wf / 2, Wf / 2, wallH, wallH + 0.8, d), darken(body, 0.08)));
    roofParts.push(rect(cornice, trim));
    roofParts.push(
      rect(
        pxBox(cornice.x0, cornice.y1, cornice.x1, cornice.y1 + Math.max(1, px(0.12, d))),
        '#000000',
        ' opacity="0.2"',
      ),
    );
    const top = R(-Wf / 2, Wf / 2, wallH + 0.7, wallH + 0.85, d);
    roofParts.push(rect(top, lighten(trim, 0.05)));
    ridgeBox = R(-Wf / 2, Wf / 2, wallH + 0.6, wallH + 0.95, d);
    eaveBox = R(-Wf / 2 - 0.2, Wf / 2 + 0.2, wallH - 0.05, wallH + 0.4, d - 0.2);
    roofTop = top.y0;
    if (winter)
      roofParts.push(
        rect(pxBox(top.x0, top.y0 - Math.max(1, px(0.1, d)), top.x1, top.y0), '#F4F7FA'),
      );
  } else {
    const inset =
      house.roofShape === 'hip' || style === 'ranch' || style === 'bungalow' ? rise * 0.95 : 0;
    const rz = d + roofDepth;
    const eL = P(-Wf / 2 - overhang, wallH, ez);
    const eR = P(Wf / 2 + overhang, wallH, ez);
    const rR = P(Wf / 2 + overhang - inset, wallH + rise, rz);
    const rL = P(-Wf / 2 - overhang + inset, wallH + rise, rz);
    // Chimney behind the ridge line.
    if (style === 'colonial' || style === 'cape_cod' || style === 'farmhouse') {
      const cz = d + roofDepth * 0.7;
      const cy0 = wallH + rise * 0.72;
      const cb = R(Wf / 2 - 2.0, Wf / 2 - 1.2, cy0, wallH + rise + 1.1, cz);
      roofParts.push(rect(cb, '#8B4A3A'));
      for (let y = cy0; y < wallH + rise + 1.1; y += 0.25)
        roofParts.push(
          line(
            P(Wf / 2 - 2.0, y, d + roofDepth * 0.7),
            P(Wf / 2 - 1.2, y, d + roofDepth * 0.7),
            '#6E3A2E',
            Math.max(0.4, px(0.015, d)),
          ),
        );
      roofParts.push(
        rect(
          R(
            Wf / 2 - 2.08,
            Wf / 2 - 1.12,
            wallH + rise + 1.0,
            wallH + rise + 1.18,
            d + roofDepth * 0.7,
          ),
          '#5E5A55',
        ),
      );
    }
    const roofFill = `url(#${svg.linear([
      [0, lighten(roofColor, 0.18)],
      [1, darken(roofColor, 0.12)],
    ])})`;
    roofParts.push(poly([eL, eR, rR, rL], roofFill));
    // Shingle courses.
    const courses = Math.max(4, Math.round(rise / 0.28));
    for (let k = 1; k < courses; k += 1) {
      const t = k / courses;
      const a: [number, number] = [eL[0] + (rL[0] - eL[0]) * t, eL[1] + (rL[1] - eL[1]) * t];
      const b: [number, number] = [eR[0] + (rR[0] - eR[0]) * t, eR[1] + (rR[1] - eR[1]) * t];
      roofParts.push(
        line(a, b, darken(roofColor, 0.3), Math.max(0.5, px(0.02, d)), ' opacity="0.55"'),
      );
      const tabs = Math.max(6, Math.round((b[0] - a[0]) / Math.max(4, px(0.5, d))));
      for (let j = 0; j < tabs; j += 1) {
        if (rng.next() < 0.35) continue;
        const tt = (j + (k % 2) * 0.5) / tabs;
        const x = a[0] + (b[0] - a[0]) * tt;
        const y = a[1] + (b[1] - a[1]) * tt;
        const nextT = (k + 1) / courses;
        const ya = eL[1] + (rL[1] - eL[1]) * nextT;
        roofParts.push(
          line(
            [x, y],
            [x, y + (ya - eL[1] - (y - eL[1])) * 0.9],
            darken(roofColor, 0.25),
            Math.max(0.4, px(0.012, d)),
            ' opacity="0.4"',
          ),
        );
      }
    }
    if (winter) {
      const snowT = 0.3;
      const sL: [number, number] = [
        eL[0] + (rL[0] - eL[0]) * snowT,
        eL[1] + (rL[1] - eL[1]) * snowT,
      ];
      const sR: [number, number] = [
        eR[0] + (rR[0] - eR[0]) * snowT,
        eR[1] + (rR[1] - eR[1]) * snowT,
      ];
      const wave: [number, number][] = [];
      for (let k = 0; k <= 12; k += 1) {
        const t = k / 12;
        wave.push([
          sL[0] + (sR[0] - sL[0]) * t,
          sL[1] + (sR[1] - sL[1]) * t + rng.jitter(px(0.15, d)),
        ]);
      }
      roofParts.push(poly([...wave, rR, rL], '#F3F6F9'));
      roofParts.push(
        poly(
          [...wave, rR, rL],
          `url(#${svg.linear([
            [0, '#ffffff', 0],
            [1, '#B8C6D4', 0.35],
          ])})`,
        ),
      );
    }
    // Ridge cap and fascia.
    roofParts.push(line(rL, rR, darken(roofColor, 0.35), Math.max(1, px(0.08, rz))));
    const fasciaL = P(-Wf / 2 - overhang, wallH - 0.22, ez);
    const fasciaR = P(Wf / 2 + overhang, wallH - 0.22, ez);
    roofParts.push(poly([eL, eR, fasciaR, fasciaL], trim));
    roofParts.push(
      rect(
        pxBox(bodyBox.x0, fasciaL[1], bodyBox.x1, fasciaL[1] + Math.max(1, px(0.45, d))),
        `url(#${svg.linear([
          [0, '#000000', 0.28],
          [1, '#000000', 0],
        ])})`,
      ),
    );
    ridgeBox = pxBox(
      rL[0],
      rL[1] - Math.max(2, px(0.25, rz)),
      rR[0],
      rR[1] + Math.max(2, px(0.25, rz)),
    );
    eaveBox = pxBox(
      eL[0],
      eL[1] - Math.max(2, px(0.2, d)),
      eR[0],
      fasciaR[1] + Math.max(2, px(0.12, d)),
    );
    roofTop = Math.min(rL[1], rR[1]);
    // Cape Cod dormers.
    if (style === 'cape_cod') {
      for (const dx of [-Wf * 0.24, Wf * 0.24]) {
        const dz = d + 1.4;
        const yb = wallH + 0.9;
        const face = R(dx - 0.9, dx + 0.9, yb, yb + 1.5, dz);
        roofParts.push(rect(face, body));
        roofParts.push(
          poly(
            [
              P(dx - 1.1, yb + 1.5, dz - 0.1),
              P(dx + 1.1, yb + 1.5, dz - 0.1),
              P(dx, yb + 2.3, dz - 0.1),
            ],
            winter ? '#F2F5F8' : roofColor,
          ),
        );
        roofParts.push(
          poly(
            [
              P(dx - 0.95, yb + 1.5, dz - 0.1),
              P(dx + 0.95, yb + 1.5, dz - 0.1),
              P(dx, yb + 2.15, dz - 0.1),
            ],
            trim,
          ),
        );
        houseParts.push(roofParts.splice(0).join(''));
        drawWindow(dx, yb + 0.25, 0.8, 1.0, dz, true);
      }
    }
  }
  // Front gable over the center (farmhouse) or over the porch (bungalow).
  if (style === 'farmhouse' && !flat) {
    const gz = d - 0.15;
    const gl = P(-2.8, wallH, gz);
    const gr = P(2.8, wallH, gz);
    const ga = P(0, wallH + 2.6, gz);
    roofParts.push(
      poly(
        [
          P(-3.1, wallH - 0.1, gz - 0.1),
          P(3.1, wallH - 0.1, gz - 0.1),
          P(0, wallH + 2.85, gz - 0.1),
        ],
        winter ? '#F3F6F9' : roofColor,
      ),
    );
    roofParts.push(poly([gl, gr, ga], body));
    for (let y = wallH + 0.2; y < wallH + 2.4; y += 0.2) {
      const t = (y - wallH) / 2.6;
      roofParts.push(
        line(
          P(-2.8 * (1 - t), y, gz),
          P(2.8 * (1 - t), y, gz),
          darken(body, 0.14),
          lineW(0.016),
          ' opacity="0.55"',
        ),
      );
    }
    const ab = R(-0.45, 0.45, wallH + 0.5, wallH + 1.4, gz);
    roofParts.push(
      rect(pxBox(ab.x0 - 2, ab.y0 - 2, ab.x1 + 2, ab.y1 + 2), trim),
      rect(ab, '#56687A'),
    );
  }
  add(roofParts.join(''));
  if (ridgeBox) anchors.add('roofline', ridgeBox, 0.94);
  if (eaveBox) anchors.add('eaves', eaveBox, 0.95);

  // ---- porch ------------------------------------------------------------------------------
  const porchParts: string[] = [];
  const padd = (markup: string) => porchParts.push(markup);
  let stepsBox: PxBox | null;
  const railBoxes: PxBox[] = [];
  const columnBoxes: PxBox[] = [];
  const treadColor = winter ? '#E4E8EC' : '#BDB5A6';
  const riserColor = '#9E968A';
  const drawSteps = (cx: number, w: number, zTop: number, topY: number) => {
    const risers = Math.max(1, Math.round(topY / 0.2));
    const rh = topY / risers;
    const depth = 0.32;
    let z = zTop;
    const boxes: PxBox[] = [];
    for (let k = 0; k < risers; k += 1) {
      const yTop = topY - k * rh;
      const riser = R(cx - w / 2, cx + w / 2, yTop - rh, yTop, z);
      padd(rect(riser, riserColor));
      boxes.push(riser);
      if (k < risers - 1) {
        const tread: [number, number][] = [
          P(cx - w / 2, yTop - rh, z),
          P(cx + w / 2, yTop - rh, z),
          P(cx + w / 2, yTop - rh, z - depth),
          P(cx - w / 2, yTop - rh, z - depth),
        ];
        padd(poly(tread, treadColor));
        boxes.push(pxBox(tread[0][0], tread[0][1], tread[2][0], tread[2][1]));
      }
      z -= depth;
    }
    return unionPx(boxes);
  };
  const drawRail = (x0: number, x1: number, z: number, y0: number, y1: number, color: string) => {
    if (x1 - x0 < 0.3) return;
    padd(rect(R(x0, x1, y1 - 0.09, y1, z), color));
    padd(rect(R(x0, x1, y0, y0 + 0.07, z), color));
    for (let x = x0 + 0.1; x < x1 - 0.05; x += 0.14)
      padd(rect(R(x - 0.022, x + 0.022, y0 + 0.07, y1 - 0.09, z), color));
    const box = R(x0, x1, y0, y1, z);
    railBoxes.push(box);
  };
  const drawColumn = (x: number, z: number, y0: number, y1: number) => {
    const cb = R(x - 0.13, x + 0.13, y0, y1, z);
    padd(
      rect(
        cb,
        `url(#${svg.linear(
          [
            [0, darken(trim, 0.12)],
            [0.4, lighten(trim, 0.1)],
            [1, darken(trim, 0.22)],
          ],
          { x1: 0, y1: 0, x2: 1, y2: 0 },
        )})`,
      ),
    );
    padd(rect(R(x - 0.2, x + 0.2, y1 - 0.12, y1, z), trim));
    padd(rect(R(x - 0.19, x + 0.19, y0, y0 + 0.12, z), trim));
    columnBoxes.push(R(x - 0.2, x + 0.2, y0, y1, z));
  };
  if (house.porch === 'full') {
    const pw = Math.max(
      4.2,
      Wf *
        (style === 'farmhouse'
          ? 1
          : style === 'bungalow'
            ? 0.9
            : style === 'colonial'
              ? 0.62
              : style === 'ranch'
                ? 0.45
                : 0.55),
    );
    const xl = Math.max(-Wf / 2, doorX - pw / 2);
    const xr = Math.min(Wf / 2, doorX + pw / 2);
    const roofY = 3.0;
    const topY = Math.min(3.9, wallH - 0.1);
    // Shade on the facade under the porch roof.
    padd(
      rect(
        R(xl, xr, floorY, roofY, d),
        `url(#${svg.linear([
          [0, '#000000', 0.32],
          [1, '#000000', 0.08],
        ])})`,
      ),
    );
    // Floor.
    padd(
      poly(
        [P(xl, floorY, d), P(xr, floorY, d), P(xr, floorY, Zf), P(xl, floorY, Zf)],
        winter ? '#CFC7BB' : '#A68A6A',
      ),
    );
    padd(rect(R(xl, xr, 0, floorY, Zf), '#D6CEC0'));
    for (let x = xl + 0.15; x < xr; x += 0.3)
      padd(line(P(x, 0.05, Zf), P(x, floorY - 0.05, Zf), '#B9AF9F', Math.max(0.4, px(0.02, Zf))));
    // Columns.
    const columnXs = new Set<number>([
      xl + 0.18,
      xr - 0.18,
      doorX - stepsW / 2 - 0.2,
      doorX + stepsW / 2 + 0.2,
    ]);
    if (xr - xl > 9) {
      columnXs.add((xl + doorX - stepsW / 2) / 2);
      columnXs.add((xr + doorX + stepsW / 2) / 2);
    }
    const sortedColumns = [...columnXs].sort((a, b) => a - b);
    // Rails between columns, leaving the step opening.
    for (let i = 0; i < sortedColumns.length - 1; i += 1) {
      const a = sortedColumns[i] as number;
      const b = sortedColumns[i + 1] as number;
      if (a < doorX && b > doorX) continue;
      drawRail(a + 0.15, b - 0.15, Zf + 0.12, floorY, floorY + 0.95, lighten(trim, 0.02));
    }
    for (const x of sortedColumns) drawColumn(x, Zf + 0.12, floorY, roofY);
    // Porch roof.
    padd(
      poly(
        [
          P(xl - 0.25, roofY + 0.4, Zf),
          P(xr + 0.25, roofY + 0.4, Zf),
          P(xr + 0.25, topY, d),
          P(xl - 0.25, topY, d),
        ],
        winter ? '#EEF2F5' : roofColor,
      ),
    );
    padd(rect(R(xl - 0.25, xr + 0.25, roofY, roofY + 0.4, Zf), trim));
    padd(rect(R(xl - 0.25, xr + 0.25, roofY - 0.05, roofY, Zf), '#000000', ' opacity="0.25"'));
    if (style === 'bungalow' && !flat) {
      const gz = Zf - 0.05;
      padd(
        poly(
          [
            P(doorX - 2.4, roofY + 0.4, gz),
            P(doorX + 2.4, roofY + 0.4, gz),
            P(doorX, roofY + 2.0, gz),
          ],
          winter ? '#EEF2F5' : roofColor,
        ),
      );
      padd(
        poly(
          [
            P(doorX - 2.1, roofY + 0.42, gz),
            P(doorX + 2.1, roofY + 0.42, gz),
            P(doorX, roofY + 1.75, gz),
          ],
          trim,
        ),
      );
      padd(
        poly(
          [
            P(doorX - 1.8, roofY + 0.5, gz),
            P(doorX + 1.8, roofY + 0.5, gz),
            P(doorX, roofY + 1.5, gz),
          ],
          body,
        ),
      );
    }
    stepsBox = drawSteps(doorX, stepsW, Zf, floorY);
  } else if (house.porch === 'stoop') {
    const lz = d - 1.3;
    padd(
      poly(
        [
          P(doorX - 1.0, floorY, d),
          P(doorX + 1.0, floorY, d),
          P(doorX + 1.0, floorY, lz),
          P(doorX - 1.0, floorY, lz),
        ],
        '#B5AD9F',
      ),
    );
    padd(rect(R(doorX - 1.0, doorX + 1.0, 0, floorY, lz), '#9A9286'));
    stepsBox = drawSteps(doorX, stepsW, lz, floorY);
    // Portico.
    const roofY = floorY + 2.75;
    for (const side of [-1, 1]) drawColumn(doorX + side * 0.95, lz + 0.15, floorY, roofY);
    padd(rect(R(doorX - 1.15, doorX + 1.15, roofY, roofY + 0.25, lz + 0.1), trim));
    padd(
      poly(
        [
          P(doorX - 1.2, roofY + 0.25, lz + 0.1),
          P(doorX + 1.2, roofY + 0.25, lz + 0.1),
          P(doorX, roofY + 0.95, lz + 0.1),
        ],
        winter ? '#EEF2F5' : roofColor,
      ),
    );
    padd(
      poly(
        [
          P(doorX - 1.0, roofY + 0.27, lz + 0.05),
          P(doorX + 1.0, roofY + 0.27, lz + 0.05),
          P(doorX, roofY + 0.82, lz + 0.05),
        ],
        trim,
      ),
    );
    // Iron handrails along the steps.
    for (const side of [-1, 1]) {
      const x = doorX + side * (stepsW / 2 + 0.05);
      const top = P(x, floorY + 0.9, lz);
      const bottom = P(x, 0.85, lz - 0.66);
      padd(line(top, bottom, '#1E1E1E', Math.max(1, px(0.05, lz))));
      for (let k = 0; k <= 4; k += 1) {
        const t = k / 4;
        const zz = lz - 0.66 * t;
        const yy = floorY + 0.9 - (floorY + 0.05) * t;
        padd(line(P(x, yy, zz), P(x, yy - 0.85, zz), '#1E1E1E', Math.max(0.6, px(0.025, zz))));
      }
      railBoxes.push(
        pxBox(
          Math.min(top[0], bottom[0]) - 3,
          top[1],
          Math.max(top[0], bottom[0]) + 3,
          P(x, 0, lz - 0.66)[1],
        ),
      );
    }
  } else {
    const slab = R(doorX - 0.8, doorX + 0.8, 0, floorY, d - 0.4);
    padd(
      poly(
        [
          P(doorX - 0.8, floorY, d),
          P(doorX + 0.8, floorY, d),
          P(doorX + 0.8, floorY, d - 0.4),
          P(doorX - 0.8, floorY, d - 0.4),
        ],
        treadColor,
      ),
    );
    padd(rect(slab, riserColor));
    stepsBox = pxBox(slab.x0, P(0, floorY, d)[1], slab.x1, slab.y1);
  }
  for (const box of railBoxes) anchors.add('porch_rail', box, 0.93);
  if (stepsBox) anchors.add('porch_steps', stepsBox, 0.95);
  for (const box of columnBoxes) anchors.add('column', box, 0.92);

  // ---- planters and shrubs ------------------------------------------------------------------
  const greenery: string[] = [];
  const planterBoxes: PxBox[] = [];
  if (house.porch !== 'none') {
    const pz = stepsFrontZ + 0.15;
    for (const side of [-1, 1]) {
      const x = doorX + side * (stepsW / 2 + 0.7);
      const urn = [
        P(x - 0.26, 0, pz),
        P(x + 0.26, 0, pz),
        P(x + 0.36, 0.55, pz),
        P(x - 0.36, 0.55, pz),
      ];
      greenery.push(
        `<ellipse cx="${n(P(x, 0, pz)[0])}" cy="${n(P(x, 0, pz)[1])}" rx="${n(px(0.5, pz))}" ry="${n(px(0.12, pz))}" fill="#000000" opacity="0.2"/>`,
      );
      greenery.push(poly(urn, '#3D3F42'));
      greenery.push(rect(R(x - 0.4, x + 0.4, 0.5, 0.6, pz), '#2E3033'));
      const [bx, by] = P(x, 0.98, pz);
      const br = px(0.42, pz);
      greenery.push(`<circle cx="${n(bx)}" cy="${n(by)}" r="${n(br)}" fill="#2F5A2C"/>`);
      greenery.push(
        `<circle cx="${n(bx - br * 0.25)}" cy="${n(by - br * 0.25)}" r="${n(br * 0.6)}" fill="#3F7238" opacity="0.8"/>`,
      );
      if (winter)
        greenery.push(
          `<ellipse cx="${n(bx)}" cy="${n(by - br * 0.55)}" rx="${n(br * 0.8)}" ry="${n(br * 0.35)}" fill="#F4F7FA"/>`,
        );
      const box = pxBox(P(x - 0.45, 0, pz)[0], by - br, P(x + 0.45, 0, pz)[0], P(x, 0, pz)[1]);
      planterBoxes.push(box);
    }
  }
  const shrubZ = d - 0.45;
  const porchSpan = house.porch === 'full' ? Math.max(4.2, Wf * 0.6) / 2 + 0.4 : 1.5;
  for (let x = -Wf / 2 + 0.6; x < Wf / 2 - 0.4; x += 1.25) {
    if (Math.abs(x - doorX) < porchSpan) continue;
    if (house.garage && x > garageX0 - 0.4) continue;
    const [sx, sy] = P(x, 0.45, shrubZ);
    const r = px(rng.range(0.5, 0.65), shrubZ);
    const color =
      season === 'autumn' && rng.next() < 0.3
        ? '#A33B26'
        : rng.pick(['#2F5A2C', '#355E3B', '#3B6636']);
    greenery.push(
      `<ellipse cx="${n(sx)}" cy="${n(sy)}" rx="${n(r * 1.15)}" ry="${n(r)}" fill="${color}"/>`,
    );
    greenery.push(
      `<ellipse cx="${n(sx - r * 0.3)}" cy="${n(sy - r * 0.3)}" rx="${n(r * 0.6)}" ry="${n(r * 0.45)}" fill="${lighten(color, 0.15)}" opacity="0.7"/>`,
    );
    if (winter)
      greenery.push(
        `<ellipse cx="${n(sx)}" cy="${n(sy - r * 0.6)}" rx="${n(r)}" ry="${n(r * 0.4)}" fill="#F4F7FA"/>`,
      );
  }
  for (const box of planterBoxes) anchors.add('planter', box, 0.92);
  if (walkwayBox)
    anchors.add(
      'walkway_edge',
      pxBox(walkwayBox.x0 - 6, walkwayBox.y0, walkwayBox.x1 + 6, walkwayBox.y1),
      0.9,
    );
  // Lawn anchor: the open lawn left of the walkway.
  const lawnNear = Math.max(Zs + 0.6, bottomZ + 0.2);
  const lawnFar = stepsFrontZ - 0.6;
  if (lawnFar - lawnNear > 1.5 && house.style !== 'townhouse_row') {
    const a = P(-Wf / 2 + 0.5, 0, lawnFar);
    const b = P(doorX - 1.6, 0, lawnNear);
    anchors.add('lawn', pxBox(a[0], a[1], b[0], b[1]), 0.9);
  }

  // ---- existing decorations -----------------------------------------------------------------
  const existingBoxes: PxBox[] = [];
  const existing: string[] = [];
  if (house.existingDecor === 'halloween') {
    const pz = stepsFrontZ + 0.2;
    for (const side of [-1, 1]) {
      const x = doorX + side * (stepsW / 2 - 0.35);
      const [cx, cy] = P(x, 0.33, pz + 0.4);
      const r = px(0.2, pz);
      existing.push(
        `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(r * 1.2)}" ry="${n(r)}" fill="#E07A1F"/>`,
      );
      existing.push(
        `<rect x="${n(cx - r * 0.1)}" y="${n(cy - r * 1.3)}" width="${n(r * 0.2)}" height="${n(r * 0.4)}" fill="#4A6B2A"/>`,
      );
      existingBoxes.push(pxBox(cx - r * 1.3, cy - r * 1.4, cx + r * 1.3, cy + r));
    }
    // A strand of orange lights already on the porch fascia or door frame.
    const y = house.porch === 'full' ? 3.2 : floorY + doorH + 0.4;
    const z = house.porch === 'full' ? Zf - 0.05 : d - 0.05;
    const x0 = doorX - (house.porch === 'full' ? 2.2 : 0.8);
    const x1 = doorX + (house.porch === 'full' ? 2.2 : 0.8);
    const strand: [number, number][] = [];
    for (let k = 0; k <= 16; k += 1) {
      const t = k / 16;
      strand.push(P(x0 + (x1 - x0) * t, y - 0.12 * Math.sin(Math.PI * ((t * 4) % 1)), z));
    }
    existing.push(
      `<polyline points="${points(strand)}" fill="none" stroke="#2A2A2A" stroke-width="${n(Math.max(0.6, px(0.02, z)))}"/>`,
    );
    for (const [sx, sy] of strand)
      existing.push(
        `<circle cx="${n(sx)}" cy="${n(sy + px(0.05, z))}" r="${n(Math.max(0.8, px(0.045, z)))}" fill="#FF9A2E"/>`,
      );
    const sb = unionPx(strand.map(([sx, sy]) => pxBox(sx - 2, sy - 2, sx + 2, sy + px(0.12, z))));
    if (sb) existingBoxes.push(sb);
  }

  // ---- compose the house group ----------------------------------------------------------------
  const houseGroup = [...houseParts, ...porchParts, ...greenery, ...existing].join('');
  if (house.blurredHouse) {
    svg.add(`<g filter="url(#${svg.blur(Math.max(3, W * 0.014))})">${houseGroup}</g>`);
  } else {
    svg.add(`<g>${houseGroup}</g>`);
  }

  // ---- fence --------------------------------------------------------------------------------
  if (house.fence && !input.clean && Zs + 0.3 > bottomZ) {
    const fz = Zs + 0.3;
    const fence: string[] = [];
    const color = winter ? '#F2F2EE' : '#F5F3EC';
    for (const [x0, x1] of [
      [-Wf / 2 - 10, doorX - 0.75],
      [doorX + 0.75, Wf / 2 + 10],
    ] as const) {
      for (let x = x0; x < x1; x += 0.13) {
        const [ax, ay] = P(x, 0.95, fz);
        const [bx, by] = P(x + 0.08, 0, fz);
        if (bx < -10 || ax > W + 10) continue;
        const tip = px(0.06, fz);
        fence.push(
          poly(
            [
              [ax, ay],
              [bx, ay],
              [bx, by],
              [ax, by],
            ],
            color,
          ),
        );
        fence.push(
          poly(
            [
              [ax, ay],
              [(ax + bx) / 2, ay - tip],
              [bx, ay],
            ],
            color,
          ),
        );
        fence.push(line([bx, ay], [bx, by], '#C9C5BA', Math.max(0.4, px(0.012, fz))));
      }
      fence.push(rect(R(x0, x1, 0.25, 0.32, fz - 0.02), '#E4E1D8'));
      fence.push(rect(R(x0, x1, 0.7, 0.77, fz - 0.02), '#E4E1D8'));
    }
    svg.add(`<g>${fence.join('')}</g>`);
  }

  // ---- parked car ---------------------------------------------------------------------------
  let carBox: PxBox | null = null;
  if (house.parkedCar && !input.clean) {
    const cz = Math.max(Zs - 3.2, bottomZ + 2.5);
    if (cz > 1.5) {
      const cx = doorX + 3.4;
      const color = rng.pick(['#7A8B99', '#3D4A5C', '#B03A2E', '#C9CDD2', '#2E2E2E']);
      const carParts: string[] = [];
      carParts.push(
        `<ellipse cx="${n(P(cx, 0, cz)[0])}" cy="${n(P(cx, 0, cz)[1])}" rx="${n(px(2.6, cz))}" ry="${n(px(0.2, cz))}" fill="#000000" opacity="0.3"/>`,
      );
      carParts.push(
        poly(
          [
            P(cx - 2.3, 0.35, cz),
            P(cx + 2.3, 0.35, cz),
            P(cx + 2.3, 0.85, cz),
            P(cx + 1.9, 1.0, cz),
            P(cx - 2.2, 1.0, cz),
            P(cx - 2.35, 0.75, cz),
          ],
          color,
        ),
      );
      carParts.push(
        poly(
          [
            P(cx - 1.25, 1.0, cz),
            P(cx + 1.15, 1.0, cz),
            P(cx + 0.7, 1.45, cz),
            P(cx - 0.85, 1.45, cz),
          ],
          darken(color, 0.1),
        ),
      );
      carParts.push(
        poly(
          [
            P(cx - 1.1, 1.03, cz),
            P(cx - 0.1, 1.03, cz),
            P(cx - 0.1, 1.38, cz),
            P(cx - 0.75, 1.38, cz),
          ],
          '#3A4752',
        ),
      );
      carParts.push(
        poly(
          [P(cx, 1.03, cz), P(cx + 1.0, 1.03, cz), P(cx + 0.62, 1.38, cz), P(cx, 1.38, cz)],
          '#3A4752',
        ),
      );
      carParts.push(
        line(
          P(cx - 2.3, 0.7, cz),
          P(cx + 2.3, 0.7, cz),
          lighten(color, 0.3),
          Math.max(0.6, px(0.03, cz)),
          ' opacity="0.7"',
        ),
      );
      for (const wx of [cx - 1.45, cx + 1.45]) {
        const [wcx, wcy] = P(wx, 0.33, cz);
        carParts.push(
          `<circle cx="${n(wcx)}" cy="${n(wcy)}" r="${n(px(0.34, cz))}" fill="#1C1C1C"/>`,
        );
        carParts.push(
          `<circle cx="${n(wcx)}" cy="${n(wcy)}" r="${n(px(0.17, cz))}" fill="#9AA0A6"/>`,
        );
      }
      svg.add(`<g>${carParts.join('')}</g>`);
      carBox = R(cx - 2.4, cx + 2.4, 0, 1.5, cz);
      anchors.occluder(carBox);
    }
  }

  // ---- trees ---------------------------------------------------------------------------------
  const treeSides =
    house.trees === 'both'
      ? [-1, 1]
      : house.trees === 'left'
        ? [-1]
        : house.trees === 'right'
          ? [1]
          : [];
  for (const side of treeSides) {
    const tx = side * (Wf / 2 + 2.4);
    const tz = d - 1.6;
    const tree: string[] = [];
    const [gx, gy] = P(tx, 0, tz);
    tree.push(
      `<ellipse cx="${n(gx + px(1.2, tz))}" cy="${n(gy)}" rx="${n(px(3.2, tz))}" ry="${n(px(0.5, tz))}" fill="#000000" opacity="${winter ? 0.08 : 0.18}"/>`,
    );
    const trunkTop = P(tx, 5.2, tz);
    tree.push(
      poly(
        [P(tx - 0.28, 0, tz), P(tx + 0.28, 0, tz), P(tx + 0.16, 5.2, tz), P(tx - 0.16, 5.2, tz)],
        '#5A4636',
      ),
    );
    tree.push(
      line(
        P(tx - 0.1, 0.4, tz),
        P(tx - 0.06, 4.8, tz),
        '#7A6450',
        Math.max(0.5, px(0.06, tz)),
        ' opacity="0.6"',
      ),
    );
    const crownCenter = P(tx, 7.4, tz);
    const crownR = px(3.6, tz);
    if (winter) {
      const branch = (x: number, y: number, angle: number, len: number, depth: number) => {
        if (depth === 0 || len < 1) return;
        const x2 = x + Math.cos(angle) * len;
        const y2 = y - Math.sin(angle) * len;
        tree.push(line([x, y], [x2, y2], '#5E5148', Math.max(0.5, depth * px(0.035, tz))));
        if (depth <= 2)
          tree.push(
            line(
              [x, y - 0.6],
              [x2, y2 - 0.6],
              '#F2F5F8',
              Math.max(0.4, depth * px(0.015, tz)),
              ' opacity="0.8"',
            ),
          );
        branch(x2, y2, angle + rng.range(0.25, 0.55), len * rng.range(0.62, 0.75), depth - 1);
        branch(x2, y2, angle - rng.range(0.25, 0.55), len * rng.range(0.62, 0.75), depth - 1);
      };
      branch(trunkTop[0], trunkTop[1], Math.PI / 2 + rng.jitter(0.1), px(2.4, tz), 6);
    } else {
      const all = LEAVES[season];
      const base =
        season === 'autumn'
          ? rng.pick(['#C8602A', '#D9962F', '#B5432A', '#CDAA3A'])
          : rng.pick(all);
      const clumps: { x: number; y: number; r: number }[] = [];
      for (let i = 0; i < 150; i += 1) {
        const a = rng.range(0, Math.PI * 2);
        const rr = Math.sqrt(rng.next()) * crownR * 0.95;
        clumps.push({
          x: crownCenter[0] + Math.cos(a) * rr * 1.05,
          y: crownCenter[1] + Math.sin(a) * rr * 0.88,
          r: crownR * rng.range(0.1, 0.19),
        });
      }
      clumps.sort((a, b) => a.y - b.y);
      // Dark underside mass, then sunlit clumps shaded by height and side.
      tree.push(
        `<ellipse cx="${n(crownCenter[0])}" cy="${n(crownCenter[1] + crownR * 0.1)}" rx="${n(crownR * 0.95)}" ry="${n(crownR * 0.8)}" fill="${darken(base, 0.45)}"/>`,
      );
      for (const clump of clumps) {
        const vertical = (clump.y - (crownCenter[1] - crownR)) / (2 * crownR);
        const horizontal = (clump.x - (crownCenter[0] - crownR)) / (2 * crownR);
        const tone = mix(rng.next() < 0.3 ? rng.pick(all) : base, base, 0.4);
        const shade = 0.42 * vertical + 0.2 * horizontal - 0.12;
        const color = shade > 0 ? darken(tone, shade) : lighten(tone, -shade);
        tree.push(
          `<circle cx="${n(clump.x)}" cy="${n(clump.y)}" r="${n(clump.r)}" fill="${color}"/>`,
        );
        tree.push(
          `<circle cx="${n(clump.x - clump.r * 0.25)}" cy="${n(clump.y - clump.r * 0.3)}" r="${n(clump.r * 0.55)}" fill="${lighten(color, 0.14)}" opacity="0.55"/>`,
        );
      }
      anchors.occluder(
        pxBox(
          crownCenter[0] - crownR * 0.9,
          crownCenter[1] - crownR * 0.9,
          crownCenter[0] + crownR * 0.9,
          crownCenter[1] + crownR * 0.8,
        ),
      );
    }
    svg.add(`<g>${tree.join('')}</g>`);
  }

  // ---- atmosphere and attribution ---------------------------------------------------------------
  svg.add(
    `<rect width="${W}" height="${H}" fill="url(#${svg.radial(
      [
        [0.55, '#000000', 0],
        [1, '#000000', 0.22],
      ],
      0.5,
      0.5,
      0.75,
    )})"/>`,
  );
  let attributionRegion: NormalizedBox | undefined;
  if (input.watermark) {
    const size = Math.max(9, H * 0.024);
    const textW = input.watermark.length * size * 0.58;
    const x = W - textW - size * 0.8;
    const y = H - size * 0.8;
    svg.add(
      `<text x="${n(x + 1)}" y="${n(y + 1)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${n(size)}" fill="#000000" opacity="0.35">${escapeXml(input.watermark)}</text>`,
    );
    svg.add(
      `<text x="${n(x)}" y="${n(y)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${n(size)}" fill="#ffffff" opacity="0.85">${escapeXml(input.watermark)}</text>`,
    );
    attributionRegion =
      normBox(
        pxBox(x - size * 0.4, y - size * 1.2, x + textW + size * 0.5, y + size * 0.5),
        W,
        H,
      ) ?? undefined;
  }

  // ---- geometry ------------------------------------------------------------------------------
  const targetPx = unionPx(
    [
      bodyBox,
      pxBox(bodyBox.x0, roofTop, bodyBox.x1, bodyBox.y0),
      ...(eaveBox ? [eaveBox] : []),
      ...(stepsBox ? [stepsBox] : []),
      ...planterBoxes,
    ].filter(Boolean),
  ) as PxBox;
  const targetFacade = normBox(targetPx, W, H) ?? undefined;
  const accessRegions: FixtureSceneGeometry['accessRegions'] = [];
  const doorNorm = normBox(doorBox, W, H);
  if (doorNorm) accessRegions.push({ kind: 'door', box: doorNorm });
  if (stepsBox) {
    const sb = normBox(stepsBox, W, H);
    if (sb) accessRegions.push({ kind: 'steps', box: sb });
  }
  if (walkwayBox) {
    const wb = normBox(walkwayBox, W, H);
    if (wb) accessRegions.push({ kind: 'walkway', box: wb });
  }
  const existingNorm = normBoxes(existingBoxes, W, H);
  for (const box of existingNorm) preserve.push({ kind: 'existing_decor', box });
  const carNorm = carBox ? normBox(carBox, W, H) : null;
  if (carNorm) preserve.push({ kind: 'vehicle', box: carNorm });
  if (attributionRegion) preserve.push({ kind: 'logo', box: attributionRegion });

  const buildingForm: BuildingForm =
    style === 'townhouse_row' ? 'attached' : style === 'apartment_block' ? 'other' : 'detached';
  const geometry: FixtureSceneGeometry = {
    width: W,
    height: H,
    sceneType: 'house_exterior',
    buildingForm,
    ...(targetFacade ? { targetFacade } : {}),
    targetFacadeAmbiguous: !targetFacade,
    anchors: anchors.build(),
    preserveRegions: preserve,
    accessRegions,
    hazards: [],
    existingDecorations:
      existingNorm.length > 0
        ? { present: true, holidayGuess: 'halloween', density: 'medium', boxes: existingNorm }
        : { present: false, density: 'none', boxes: [] },
    peopleBoxes: [],
    protectedBlurRegions:
      house.blurredHouse && targetFacade ? [{ kind: 'house', box: targetFacade }] : [],
    lighting: DAYLIGHT,
    seasonCues: {
      snowVisible: winter,
      foliage: winter ? 'bare' : season === 'autumn' ? 'mixed' : 'leafy',
    },
    qualityFlags: {
      ...NO_QUALITY_FLAGS,
      multipleBuildings: neighborFacades.length > 0,
      blur: house.blurredHouse,
      tooFar: d > 45,
    },
    windows: normBoxes(windowGlass, W, H),
    ...(attributionRegion ? { attributionRegion } : {}),
    neighborFacades,
    lightSources,
  };
  return { svg: svg.toString(), geometry };
}

/** Renders a house to JPEG bytes plus its geometry. */
export async function renderHouseImage(
  input: HouseRenderInput,
  options: { quality?: number } = {},
): Promise<{ image: Buffer; geometry: FixtureSceneGeometry }> {
  const scene = renderHouse(input);
  return {
    image: await rasterize(scene.svg, { quality: options.quality ?? 90 }),
    geometry: scene.geometry,
  };
}
