import type { NormalizedBox } from '@holiday/core';
import { Projector } from './projector.js';
import {
  AnchorCollector,
  DAYLIGHT,
  NO_EXISTING_DECOR,
  NO_QUALITY_FLAGS,
  type FixtureSceneGeometry,
  type RenderedScene,
} from './scene.js';
import {
  Rng,
  SvgBuilder,
  darken,
  isBrickColor,
  lighten,
  n,
  normBox,
  normBoxes,
  type PxBox,
} from './svg.js';

/** Apartment entry parameters (examples.json generic scenes). */
export interface EntryParams {
  wallColor: string;
  floorColor: string;
  doorColor: string;
  doorFrameColor: string;
  alcove?: boolean;
  numberPlate?: boolean;
  sconce?: boolean;
  planter?: boolean;
  banister?: boolean;
  neighborDoorVisible?: boolean;
}

/** Balcony parameters (examples.json generic scenes). */
export interface BalconyParams {
  railingStyle: 'metal_bars' | 'glass_panels' | string;
  railingColor: string;
  floorColor: string;
  wallColor: string;
  doorType: 'sliding_glass' | 'french_doors' | string;
  planter?: boolean;
  view?: 'city' | 'trees' | string;
  neighborBalconyVisible?: boolean;
}

/** Draws a unit door seen from the corridor or stoop, with exact geometry. */
export function renderApartmentEntry(input: {
  entry: EntryParams;
  width: number;
  height: number;
  seed: string;
}): RenderedScene {
  const { entry, width: W, height: H } = input;
  const rng = new Rng(input.seed);
  const svg = new SvgBuilder(W, H, 'e');
  const zw = 5.2;
  const f = (0.95 * W * zw) / 6.0;
  const pr = new Projector(W, H, f, W * 0.5, H * 0.4, 1.55);
  const anchors = new AnchorCollector(W, H);
  const wall = entry.wallColor;
  const brick = isBrickColor(wall);
  const lights: PxBox[] = [];
  const preserve: FixtureSceneGeometry['preserveRegions'] = [];
  const neighbors: NormalizedBox[] = [];
  const doorZ = entry.alcove ? zw + 1.0 : zw;
  const stoop = entry.banister ?? false;
  const floorY = stoop ? 0.6 : 0;
  const lw = (m: number, z: number) => Math.max(0.6, pr.s(m, z));

  // Back wall, floor and ceiling.
  svg.add(`<rect width="${W}" height="${H}" fill="${lighten(wall, 0.55)}"/>`);
  svg.add(
    pr.poly(
      [
        [-6, -1, zw],
        [6, -1, zw],
        [6, 4.2, zw],
        [-6, 4.2, zw],
      ],
      `url(#${svg.linear([
        [0, lighten(wall, 0.05)],
        [1, darken(wall, 0.08)],
      ])})`,
    ),
  );
  if (brick) {
    for (let y = -0.5; y < 4.2; y += 0.09) {
      svg.add(
        pr.line([-6, y, zw], [6, y, zw], lighten(wall, 0.3), lw(0.008, zw), ' opacity="0.6"'),
      );
      const offset = Math.round(y / 0.09) % 2 === 0 ? 0 : 0.11;
      for (let x = -6 + offset; x < 6; x += 0.22)
        svg.add(
          pr.line(
            [x, y, zw],
            [x, y + 0.09, zw],
            lighten(wall, 0.25),
            lw(0.006, zw),
            ' opacity="0.5"',
          ),
        );
    }
  }
  // Alcove side walls.
  const doorX = 0;
  if (entry.alcove) {
    svg.add(
      pr.poly(
        [
          [-1.0, -1, zw],
          [-1.0, -1, doorZ],
          [-1.0, 2.8, doorZ],
          [-1.0, 2.8, zw],
        ],
        darken(wall, 0.16),
      ),
    );
    svg.add(
      pr.poly(
        [
          [1.0, -1, zw],
          [1.0, -1, doorZ],
          [1.0, 2.8, doorZ],
          [1.0, 2.8, zw],
        ],
        darken(wall, 0.1),
      ),
    );
    svg.add(
      pr.poly(
        [
          [-1.0, 2.8, zw],
          [1.0, 2.8, zw],
          [1.0, 2.8, doorZ],
          [-1.0, 2.8, doorZ],
        ],
        darken(wall, 0.22),
      ),
    );
    svg.add(
      pr.poly(
        [
          [-1.0, -1, doorZ],
          [1.0, -1, doorZ],
          [1.0, 2.8, doorZ],
          [-1.0, 2.8, doorZ],
        ],
        wall,
      ),
    );
  }
  // Floor (or the stoop landing and steps).
  const floor = entry.floorColor;
  if (stoop) {
    svg.add(
      pr.poly(
        [
          [-8, -1, 1.0],
          [8, -1, 1.0],
          [8, -1, zw],
          [-8, -1, zw],
        ],
        '#8F959A',
      ),
    );
    svg.add(
      pr.poly(
        [
          [-1.5, floorY, zw - 1.6],
          [1.5, floorY, zw - 1.6],
          [1.5, floorY, doorZ],
          [-1.5, floorY, doorZ],
        ],
        floor,
      ),
    );
    const steps: PxBox[] = [];
    for (let k = 0; k < 4; k += 1) {
      const y = floorY - (k + 1) * 0.4;
      const z = zw - 1.6 - k * 0.32;
      svg.add(
        pr.poly(
          [
            [-1.2, y + 0.4, z],
            [1.2, y + 0.4, z],
            [1.2, y, z],
            [-1.2, y, z],
          ],
          darken(floor, 0.18),
        ),
      );
      svg.add(
        pr.poly(
          [
            [-1.2, y, z],
            [1.2, y, z],
            [1.2, y, z - 0.32],
            [-1.2, y, z - 0.32],
          ],
          floor,
        ),
      );
      steps.push(pr.boxOf(-1.2, 1.2, y, y + 0.4, z - 0.32, z));
    }
    // Iron banisters down both sides of the steps.
    for (const side of [-1, 1]) {
      const x = side * 1.3;
      svg.add(
        pr.line(
          [x, floorY + 0.95, zw - 1.6],
          [x, floorY - 1.6 + 0.95, zw - 1.6 - 1.28],
          '#1F1F1F',
          lw(0.05, zw - 2),
        ),
      );
      for (let k = 0; k <= 6; k += 1) {
        const t = k / 6;
        const z = zw - 1.6 - 1.28 * t;
        const yTop = floorY + 0.95 - 1.6 * t;
        svg.add(pr.line([x, yTop, z], [x, yTop - 0.95, z], '#1F1F1F', lw(0.02, z)));
      }
      anchors.add(
        'banister',
        pr.boxOf(x - 0.05, x + 0.05, floorY - 1.6, floorY + 1.0, zw - 2.9, zw - 1.6),
        0.9,
      );
    }
  } else {
    svg.add(
      pr.poly(
        [
          [-6, floorY, 1.2],
          [6, floorY, 1.2],
          [6, floorY, doorZ],
          [-6, floorY, doorZ],
        ],
        `url(#${svg.linear([
          [0, darken(floor, 0.05)],
          [1, lighten(floor, 0.08)],
        ])})`,
      ),
    );
    for (let x = -6; x < 6; x += 0.45)
      svg.add(
        pr.line(
          [x, floorY, 1.2],
          [x, floorY, zw],
          darken(floor, 0.15),
          lw(0.01, 3),
          ' opacity="0.6"',
        ),
      );
    for (let z = 1.4; z < zw; z += 0.45)
      svg.add(
        pr.line(
          [-6, floorY, z],
          [6, floorY, z],
          darken(floor, 0.15),
          lw(0.01, z),
          ' opacity="0.6"',
        ),
      );
    svg.add(
      pr.poly(
        [
          [-6, floorY, zw],
          [6, floorY, zw],
          [6, floorY + 0.12, zw],
          [-6, floorY + 0.12, zw],
        ],
        darken(wall, 0.2),
      ),
    );
  }

  // Door and frame.
  const frame = pr.boxOf(doorX - 0.68, doorX + 0.68, floorY, floorY + 2.32, doorZ, doorZ);
  svg.add(
    pr.poly(
      [
        [doorX - 0.68, floorY, doorZ],
        [doorX + 0.68, floorY, doorZ],
        [doorX + 0.68, floorY + 2.32, doorZ],
        [doorX - 0.68, floorY + 2.32, doorZ],
      ],
      entry.doorFrameColor,
    ),
  );
  const door = pr.boxOf(doorX - 0.5, doorX + 0.5, floorY, floorY + 2.15, doorZ, doorZ);
  svg.add(
    pr.poly(
      [
        [doorX - 0.5, floorY, doorZ],
        [doorX + 0.5, floorY, doorZ],
        [doorX + 0.5, floorY + 2.15, doorZ],
        [doorX - 0.5, floorY + 2.15, doorZ],
      ],
      entry.doorColor,
    ),
  );
  for (const [x0, y0, x1, y1] of [
    [-0.38, 1.2, -0.04, 2.0],
    [0.04, 1.2, 0.38, 2.0],
    [-0.38, 0.15, -0.04, 1.05],
    [0.04, 0.15, 0.38, 1.05],
  ] as const) {
    svg.add(
      pr.poly(
        [
          [doorX + x0, floorY + y0, doorZ],
          [doorX + x1, floorY + y0, doorZ],
          [doorX + x1, floorY + y1, doorZ],
          [doorX + x0, floorY + y1, doorZ],
        ],
        darken(entry.doorColor, 0.18),
      ),
    );
  }
  const [kx, ky] = pr.p(doorX + 0.38, floorY + 1.0, doorZ);
  svg.add(`<circle cx="${n(kx)}" cy="${n(ky)}" r="${n(pr.s(0.04, doorZ))}" fill="#C9A227"/>`);
  if (!stoop) {
    svg.add(
      pr.poly(
        [
          [doorX - 0.45, floorY + 0.01, doorZ - 0.75],
          [doorX + 0.45, floorY + 0.01, doorZ - 0.75],
          [doorX + 0.45, floorY + 0.01, doorZ - 0.1],
          [doorX - 0.45, floorY + 0.01, doorZ - 0.1],
        ],
        '#6B5B4B',
      ),
    );
  }
  anchors.add('unit_door', door, 0.97);
  anchors.add('door_frame', frame, 0.95);

  if (entry.numberPlate) {
    const plate = pr.boxOf(
      doorX + 0.78,
      doorX + 1.0,
      floorY + 1.45,
      floorY + 1.62,
      doorZ - 0.001,
      doorZ - 0.001,
    );
    svg.add(
      `<rect x="${n(plate.x0)}" y="${n(plate.y0)}" width="${n(plate.x1 - plate.x0)}" height="${n(plate.y1 - plate.y0)}" fill="#B08D57"/>`,
    );
    const box = normBox(plate, W, H);
    if (box) preserve.push({ kind: 'house_number', box });
  }
  const wallZ = entry.alcove ? zw : doorZ;
  if (entry.sconce) {
    const sx = entry.alcove ? -1.35 : -0.95;
    const sb = pr.boxOf(sx - 0.1, sx + 0.1, floorY + 1.7, floorY + 2.1, wallZ, wallZ);
    svg.add(
      `<rect x="${n(sb.x0)}" y="${n(sb.y0)}" width="${n(sb.x1 - sb.x0)}" height="${n(sb.y1 - sb.y0)}" rx="${n((sb.x1 - sb.x0) * 0.3)}" fill="#2B2B2B"/>`,
    );
    svg.add(
      `<rect x="${n(sb.x0 + 2)}" y="${n(sb.y0 + (sb.y1 - sb.y0) * 0.2)}" width="${n(sb.x1 - sb.x0 - 4)}" height="${n((sb.y1 - sb.y0) * 0.6)}" fill="#F7E7BC"/>`,
    );
    lights.push(sb);
  }
  if (entry.planter) {
    const z = wallZ - 0.4;
    svg.add(
      pr.solid(1.05, 1.5, floorY, floorY + 0.5, z - 0.22, z + 0.22, {
        front: '#3D3F42',
        top: '#2B2B2B',
        side: '#333538',
      }),
    );
    const [cx, cy] = pr.p(1.27, floorY + 0.85, z);
    const r = pr.s(0.3, z);
    svg.add(
      `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="#2F5A2C"/><circle cx="${n(cx - r * 0.3)}" cy="${n(cy - r * 0.3)}" r="${n(r * 0.6)}" fill="#3F7238"/>`,
    );
    anchors.add('planter', pr.boxOf(1.05, 1.5, floorY, floorY + 1.15, z, z), 0.92);
  }
  if (entry.neighborDoorVisible) {
    const nb = pr.boxOf(-3.6, -2.6, 0, 2.15, zw, zw);
    svg.add(
      pr.poly(
        [
          [-3.75, 0, zw],
          [-2.45, 0, zw],
          [-2.45, 2.3, zw],
          [-3.75, 2.3, zw],
        ],
        entry.doorFrameColor,
      ),
    );
    svg.add(
      pr.poly(
        [
          [-3.6, 0, zw],
          [-2.6, 0, zw],
          [-2.6, 2.15, zw],
          [-3.6, 2.15, zw],
        ],
        rng.pick(['#6D2E46', '#2E4A62', '#4A3B2C']),
      ),
    );
    const box = normBox(nb, W, H);
    if (box) neighbors.push(box);
  }
  // Open floor beside the door and blank wall on the right.
  anchors.add(
    'floor_area',
    pr.boxOf(0.75, 1.0 + (entry.planter ? 0 : 0.6), floorY, floorY + 0.7, wallZ - 0.5, wallZ - 0.5),
    0.9,
  );
  anchors.add('wall', pr.boxOf(1.1, 2.4, floorY + 1.3, floorY + 2.3, wallZ, wallZ), 0.88);
  svg.add(
    `<rect width="${W}" height="${H}" fill="url(#${svg.radial(
      [
        [0.5, '#000000', 0],
        [1, '#000000', 0.25],
      ],
      0.5,
      0.45,
      0.75,
    )})"/>`,
  );

  const doorBox = normBox(door, W, H);
  return {
    svg: svg.toString(),
    geometry: {
      width: W,
      height: H,
      sceneType: 'apartment_entry',
      targetFacadeAmbiguous: false,
      anchors: anchors.build(0.3),
      preserveRegions: preserve,
      accessRegions: doorBox ? [{ kind: 'door', box: doorBox }] : [],
      hazards: [],
      existingDecorations: NO_EXISTING_DECOR,
      peopleBoxes: [],
      protectedBlurRegions: [],
      lighting: DAYLIGHT,
      seasonCues: { snowVisible: false, foliage: 'unknown' },
      qualityFlags: NO_QUALITY_FLAGS,
      windows: [],
      neighborFacades: neighbors,
      lightSources: normBoxes(lights, W, H),
    },
  };
}

/** Draws a balcony seen from one end, with exact geometry. */
export function renderBalcony(input: {
  balcony: BalconyParams;
  width: number;
  height: number;
  seed: string;
}): RenderedScene {
  const { balcony, width: W, height: H } = input;
  const rng = new Rng(input.seed);
  const svg = new SvgBuilder(W, H, 'b');
  const zr = 4.2;
  const f = (0.9 * W * zr) / 4.2;
  const pr = new Projector(W, H, f, W * 0.55, H * 0.42, 1.55);
  const anchors = new AnchorCollector(W, H);
  const neighbors: NormalizedBox[] = [];
  const windows: PxBox[] = [];
  const lw = (m: number, z: number) => Math.max(0.6, pr.s(m, z));
  const xL = -1.5;
  const xR = 2.6;

  // View beyond the railing.
  svg.add(
    `<rect width="${W}" height="${H}" fill="url(#${svg.linear([
      [0, '#6FA3D6'],
      [0.55, '#BFD9EE'],
      [1, '#E8EEF0'],
    ])})"/>`,
  );
  const horizon = pr.p(0, -6, 60)[1];
  if (balcony.view === 'city') {
    for (let x = -0.05 * W; x < W * 1.05;) {
      const bw = rng.range(0.04, 0.09) * W;
      const bh = rng.range(0.08, 0.3) * H;
      const color = rng.pick(['#8A97A6', '#9AA6B2', '#7D8A99', '#A7B1BB']);
      svg.add(
        `<rect x="${n(x)}" y="${n(horizon - bh)}" width="${n(bw)}" height="${n(bh + H)}" fill="${color}"/>`,
      );
      for (let wy = horizon - bh + 6; wy < horizon; wy += 9) {
        for (let wx = x + 4; wx < x + bw - 6; wx += 9)
          svg.add(
            `<rect x="${n(wx)}" y="${n(wy)}" width="4" height="5" fill="#C9D6E2" opacity="0.6"/>`,
          );
      }
      x += bw + rng.range(0, 0.02) * W;
    }
  } else {
    for (let x = -0.05 * W; x < W * 1.05;) {
      const r = rng.range(0.04, 0.08) * W;
      svg.add(
        `<circle cx="${n(x)}" cy="${n(horizon - r * 0.4)}" r="${n(r)}" fill="${rng.pick(['#4F7F3F', '#5F9147', '#3E6B35', '#6E9A4C'])}"/>`,
      );
      x += r * 0.9;
    }
    svg.add(`<rect x="0" y="${n(horizon)}" width="${W}" height="${H}" fill="#6E9A4C"/>`);
  }

  // Neighbor balcony beyond the divider on the right.
  if (balcony.neighborBalconyVisible) {
    const nb = pr.boxOf(xR + 0.2, xR + 3.5, -0.3, 1.1, zr + 0.4, zr + 0.4);
    svg.add(
      pr.poly(
        [
          [xR + 0.2, -0.3, zr + 0.4],
          [xR + 3.5, -0.3, zr + 0.4],
          [xR + 3.5, 1.1, zr + 0.4],
          [xR + 0.2, 1.1, zr + 0.4],
        ],
        darken(balcony.wallColor, 0.15),
      ),
    );
    for (let x = xR + 0.3; x < xR + 3.5; x += 0.14)
      svg.add(
        pr.line([x, 0.05, zr + 0.4], [x, 1.05, zr + 0.4], balcony.railingColor, lw(0.02, zr)),
      );
    const box = normBox(nb, W, H);
    if (box) neighbors.push(box);
  }

  // Floor.
  svg.add(
    pr.poly(
      [
        [xL, 0, 0.6],
        [xR, 0, 0.6],
        [xR, 0, zr],
        [xL, 0, zr],
      ],
      balcony.floorColor,
    ),
  );
  for (let x = xL; x < xR; x += 0.14)
    svg.add(
      pr.line(
        [x, 0, 0.6],
        [x, 0, zr],
        darken(balcony.floorColor, 0.2),
        lw(0.008, 2),
        ' opacity="0.6"',
      ),
    );
  // Building wall with the door on the left.
  svg.add(
    pr.poly(
      [
        [xL, 0, 0.3],
        [xL, 0, zr + 0.1],
        [xL, 3.0, zr + 0.1],
        [xL, 3.0, 0.3],
      ],
      `url(#${svg.linear(
        [
          [0, darken(balcony.wallColor, 0.18)],
          [1, balcony.wallColor],
        ],
        { x1: 0, y1: 0, x2: 1, y2: 0 },
      )})`,
    ),
  );
  const dz0 = 1.1;
  const dz1 = 2.9;
  svg.add(
    pr.poly(
      [
        [xL + 0.01, 0, dz0 - 0.1],
        [xL + 0.01, 0, dz1 + 0.1],
        [xL + 0.01, 2.35, dz1 + 0.1],
        [xL + 0.01, 2.35, dz0 - 0.1],
      ],
      '#E9E5DC',
    ),
  );
  svg.add(
    pr.poly(
      [
        [xL + 0.02, 0.05, dz0],
        [xL + 0.02, 0.05, dz1],
        [xL + 0.02, 2.25, dz1],
        [xL + 0.02, 2.25, dz0],
      ],
      `url(#${svg.linear([
        [0, '#9DB7CC'],
        [1, '#4F6375'],
      ])})`,
    ),
  );
  if (balcony.doorType === 'french_doors') {
    for (const z of [(dz0 + dz1) / 2])
      svg.add(pr.line([xL + 0.03, 0.05, z], [xL + 0.03, 2.25, z], '#E9E5DC', lw(0.06, z)));
    for (const y of [0.8, 1.5])
      svg.add(pr.line([xL + 0.03, y, dz0], [xL + 0.03, y, dz1], '#E9E5DC', lw(0.03, 2)));
  } else {
    svg.add(
      pr.line(
        [xL + 0.03, 0.05, (dz0 + dz1) / 2],
        [xL + 0.03, 2.25, (dz0 + dz1) / 2],
        '#5A5A5A',
        lw(0.05, 2),
      ),
    );
  }
  windows.push(
    pr.bbox([
      [xL, 0.05, dz0],
      [xL, 2.25, dz1],
    ]),
  );
  anchors.add(
    'door_frame',
    pr.bbox([
      [xL, 0, dz0 - 0.1],
      [xL, 2.35, dz1 + 0.1],
    ]),
    0.93,
  );
  anchors.add(
    'wall',
    pr.bbox([
      [xL, 0.9, dz1 + 0.3],
      [xL, 2.3, zr - 0.1],
    ]),
    0.86,
  );

  // Railing along the far edge and the right side.
  const rail = balcony.railingColor;
  const railH = 1.05;
  if (balcony.railingStyle === 'glass_panels') {
    svg.add(
      pr.poly(
        [
          [xL, 0.05, zr],
          [xR, 0.05, zr],
          [xR, railH - 0.05, zr],
          [xL, railH - 0.05, zr],
        ],
        '#D7E6EE',
        ' opacity="0.45"',
      ),
    );
    svg.add(
      pr.poly(
        [
          [xR, 0.05, 0.6],
          [xR, 0.05, zr],
          [xR, railH - 0.05, zr],
          [xR, railH - 0.05, 0.6],
        ],
        '#D7E6EE',
        ' opacity="0.4"',
      ),
    );
    for (let x = xL; x <= xR; x += 1.0)
      svg.add(pr.line([x, 0, zr], [x, railH, zr], rail, lw(0.03, zr)));
  } else {
    for (let x = xL + 0.1; x < xR; x += 0.12)
      svg.add(pr.line([x, 0.05, zr], [x, railH, zr], rail, lw(0.018, zr)));
    for (let z = 0.8; z < zr; z += 0.12)
      svg.add(pr.line([xR, 0.05, z], [xR, railH, z], rail, lw(0.018, z)));
  }
  svg.add(
    pr.poly(
      [
        [xL, railH, zr - 0.04],
        [xR, railH, zr - 0.04],
        [xR, railH + 0.06, zr],
        [xL, railH + 0.06, zr],
      ],
      darken(rail, 0.05),
    ),
  );
  svg.add(
    pr.line([xR, railH + 0.03, 0.6], [xR, railH + 0.03, zr], darken(rail, 0.05), lw(0.05, 1.5)),
  );
  anchors.add('balcony_railing', pr.boxOf(xL + 0.2, xR, 0, railH + 0.08, zr, zr), 0.95);
  // Planter in the far left corner.
  if (balcony.planter) {
    svg.add(
      pr.solid(xL + 0.15, xL + 0.75, 0, 0.45, zr - 0.6, zr - 0.15, {
        front: '#B5653F',
        top: '#5A3D28',
        side: '#9A5233',
      }),
    );
    const [cx, cy] = pr.p(xL + 0.45, 0.75, zr - 0.4);
    const r = pr.s(0.3, zr);
    for (let k = 0; k < 7; k += 1)
      svg.add(
        `<circle cx="${n(cx + rng.jitter(r))}" cy="${n(cy + rng.jitter(r * 0.5))}" r="${n(r * 0.45)}" fill="${rng.pick(['#3F6B3A', '#4F7F3F', '#5F9147'])}"/>`,
      );
    anchors.add('planter', pr.boxOf(xL + 0.15, xL + 0.75, 0, 1.0, zr - 0.6, zr - 0.6), 0.92);
  }
  anchors.add('balcony_floor', pr.boxOf(0.4, 2.3, 0, 1.0, zr - 0.5, zr - 0.5), 0.9);

  svg.add(
    `<rect width="${W}" height="${H}" fill="url(#${svg.radial(
      [
        [0.55, '#000000', 0],
        [1, '#000000', 0.2],
      ],
      0.5,
      0.45,
      0.75,
    )})"/>`,
  );

  const doorBox = normBox(
    pr.bbox([
      [xL, 0, dz0],
      [xL, 2.25, dz1],
    ]),
    W,
    H,
  );
  return {
    svg: svg.toString(),
    geometry: {
      width: W,
      height: H,
      sceneType: 'balcony',
      targetFacadeAmbiguous: false,
      anchors: anchors.build(0.3),
      preserveRegions: [],
      accessRegions: doorBox ? [{ kind: 'door', box: doorBox }] : [],
      hazards: [],
      existingDecorations: NO_EXISTING_DECOR,
      peopleBoxes: [],
      protectedBlurRegions: [],
      lighting: DAYLIGHT,
      seasonCues: { snowVisible: false, foliage: balcony.view === 'trees' ? 'leafy' : 'unknown' },
      qualityFlags: { ...NO_QUALITY_FLAGS, multipleBuildings: balcony.view === 'city' },
      windows: normBoxes(windows, W, H),
      neighborFacades: neighbors,
      lightSources: [],
    },
  };
}
