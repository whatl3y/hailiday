import type { RoomType } from '@holiday/core';
import { Projector } from './projector.js';
import {
  AnchorCollector,
  DAYLIGHT,
  NO_EXISTING_DECOR,
  NO_QUALITY_FLAGS,
  type FixtureSceneGeometry,
  type RenderedScene,
} from './scene.js';
import { Rng, SvgBuilder, darken, lighten, mix, n, normBoxes, pxBox, type PxBox } from './svg.js';

/** Procedural room parameters (heroes.json `procedural.room`, examples.json generic scenes). */
export interface RoomParams {
  roomType: RoomType;
  wallColor: string;
  trimColor: string;
  floorColor: string;
  ceiling?: 'flat' | 'beamed';
  windowCount?: number;
  tableShape?: string;
  tableColor?: string | null;
  chairCount?: number;
  chairColor?: string | null;
  sideboard?: boolean;
  mantel?: boolean;
  chandelier?: boolean;
  rugColor?: string;
  sofaColor?: string;
  openFloorBesideWindow?: boolean;
  shelf?: boolean;
}

export interface RoomRenderInput {
  room: RoomParams;
  width: number;
  height: number;
  seed: string;
  /** Vanishing point x as a fraction of the width (default 0.5). */
  focalX?: number;
  /** Eye level as a fraction of the height (default 0.42). */
  eyeY?: number;
  /** Width of the back wall as a fraction of the image width (default 0.6). */
  backWallFraction?: number;
  /** Food drawn on the table for a dinner hero. */
  dinner?: 'thanksgiving' | null;
}

const RW = 6.4;
const RH = 3.0;
const ZB = 9.4;
const ZN = 0.8;
const EYE = 1.45;

/** Draws a furnished room in one-point perspective and returns the SVG plus exact geometry. */
export function renderRoom(input: RoomRenderInput): RenderedScene {
  const { room, width: W, height: H } = input;
  const rng = new Rng(input.seed);
  const svg = new SvgBuilder(W, H, 'r');
  const f = ((input.backWallFraction ?? 0.6) * W * ZB) / RW;
  const pr = new Projector(W, H, f, (input.focalX ?? 0.5) * W, (input.eyeY ?? 0.42) * H, EYE);
  const anchors = new AnchorCollector(W, H);
  const windows: PxBox[] = [];
  const lights: PxBox[] = [];
  const wall = room.wallColor;
  const trim = room.trimColor;
  const roomType = room.roomType;
  const dining = roomType === 'dining_room';
  const living = roomType === 'living_room';
  const lw = (m: number, z: number) => Math.max(0.6, pr.s(m, z));

  // ---- shell -------------------------------------------------------------------------------
  const ceiling = lighten(wall, 0.72);
  svg.add(
    pr.poly(
      [
        [-RW / 2, RH, ZN],
        [RW / 2, RH, ZN],
        [RW / 2, RH, ZB],
        [-RW / 2, RH, ZB],
      ],
      ceiling,
    ),
  );
  if (room.ceiling === 'beamed') {
    for (let z = ZN + 0.6; z < ZB; z += 1.3) {
      svg.add(
        pr.poly(
          [
            [-RW / 2, RH - 0.2, z],
            [RW / 2, RH - 0.2, z],
            [RW / 2, RH - 0.2, z + 0.24],
            [-RW / 2, RH - 0.2, z + 0.24],
          ],
          '#4A3324',
        ),
      );
      svg.add(
        pr.poly(
          [
            [-RW / 2, RH - 0.2, z],
            [RW / 2, RH - 0.2, z],
            [RW / 2, RH, z],
            [-RW / 2, RH, z],
          ],
          '#5E422F',
        ),
      );
    }
  }
  const backFill = `url(#${svg.linear([
    [0, lighten(wall, 0.06)],
    [1, darken(wall, 0.06)],
  ])})`;
  svg.add(
    pr.poly(
      [
        [-RW / 2, 0, ZB],
        [RW / 2, 0, ZB],
        [RW / 2, RH, ZB],
        [-RW / 2, RH, ZB],
      ],
      backFill,
    ),
  );
  svg.add(
    pr.poly(
      [
        [-RW / 2, 0, ZN],
        [-RW / 2, 0, ZB],
        [-RW / 2, RH, ZB],
        [-RW / 2, RH, ZN],
      ],
      darken(wall, 0.14),
    ),
  );
  svg.add(
    pr.poly(
      [
        [RW / 2, 0, ZN],
        [RW / 2, 0, ZB],
        [RW / 2, RH, ZB],
        [RW / 2, RH, ZN],
      ],
      darken(wall, 0.08),
    ),
  );
  // Wainscot panels on every wall.
  const panel = mix(trim, wall, 0.35);
  svg.add(
    pr.poly(
      [
        [-RW / 2, 0, ZB],
        [RW / 2, 0, ZB],
        [RW / 2, 0.95, ZB],
        [-RW / 2, 0.95, ZB],
      ],
      panel,
    ),
  );
  svg.add(
    pr.poly(
      [
        [-RW / 2, 0, ZN],
        [-RW / 2, 0, ZB],
        [-RW / 2, 0.95, ZB],
        [-RW / 2, 0.95, ZN],
      ],
      darken(panel, 0.14),
    ),
  );
  svg.add(
    pr.poly(
      [
        [RW / 2, 0, ZN],
        [RW / 2, 0, ZB],
        [RW / 2, 0.95, ZB],
        [RW / 2, 0.95, ZN],
      ],
      darken(panel, 0.08),
    ),
  );
  for (let x = -RW / 2 + 0.6; x < RW / 2; x += 0.8) {
    svg.add(
      pr.poly(
        [
          [x - 0.3, 0.18, ZB],
          [x + 0.3, 0.18, ZB],
          [x + 0.3, 0.8, ZB],
          [x - 0.3, 0.8, ZB],
        ],
        'none',
        ` stroke="${darken(panel, 0.15)}" stroke-width="${n(lw(0.02, ZB))}"`,
      ),
    );
  }
  for (let z = ZN + 0.4; z < ZB; z += 0.9) {
    for (const side of [-1, 1]) {
      const x = (side * RW) / 2;
      svg.add(
        pr.poly(
          [
            [x, 0.18, z],
            [x, 0.18, z + 0.65],
            [x, 0.8, z + 0.65],
            [x, 0.8, z],
          ],
          'none',
          ` stroke="${darken(panel, 0.24)}" stroke-width="${n(lw(0.02, z))}"`,
        ),
      );
    }
  }
  // Chair rail and crown molding.
  svg.add(pr.line([-RW / 2, 0.95, ZB], [RW / 2, 0.95, ZB], trim, lw(0.04, ZB)));
  svg.add(pr.line([-RW / 2, 0.95, ZN], [-RW / 2, 0.95, ZB], trim, lw(0.04, 3)));
  svg.add(pr.line([RW / 2, 0.95, ZN], [RW / 2, 0.95, ZB], trim, lw(0.04, 3)));
  svg.add(
    pr.poly(
      [
        [-RW / 2, RH - 0.14, ZB],
        [RW / 2, RH - 0.14, ZB],
        [RW / 2, RH, ZB],
        [-RW / 2, RH, ZB],
      ],
      trim,
    ),
  );
  svg.add(
    pr.poly(
      [
        [-RW / 2, RH - 0.14, ZN],
        [-RW / 2, RH - 0.14, ZB],
        [-RW / 2, RH, ZB],
        [-RW / 2, RH, ZN],
      ],
      darken(trim, 0.1),
    ),
  );
  svg.add(
    pr.poly(
      [
        [RW / 2, RH - 0.14, ZN],
        [RW / 2, RH - 0.14, ZB],
        [RW / 2, RH, ZB],
        [RW / 2, RH, ZN],
      ],
      darken(trim, 0.06),
    ),
  );

  // Floor with boards.
  const floor = room.floorColor;
  svg.add(
    pr.poly(
      [
        [-RW / 2, 0, ZN],
        [RW / 2, 0, ZN],
        [RW / 2, 0, ZB],
        [-RW / 2, 0, ZB],
      ],
      `url(#${svg.linear([
        [0, darken(floor, 0.12)],
        [1, lighten(floor, 0.06)],
      ])})`,
    ),
  );
  for (let x = -RW / 2; x <= RW / 2; x += 0.16) {
    svg.add(pr.line([x, 0, ZN], [x, 0, ZB], darken(floor, 0.22), lw(0.008, 3), ' opacity="0.7"'));
  }
  for (let i = 0; i < 90; i += 1) {
    const x = -RW / 2 + Math.floor(rng.range(0, RW / 0.16)) * 0.16;
    const z = rng.range(ZN, ZB);
    svg.add(
      pr.line([x, 0, z], [x + 0.16, 0, z], darken(floor, 0.25), lw(0.006, z), ' opacity="0.6"'),
    );
  }
  // Baseboards.
  svg.add(
    pr.poly(
      [
        [-RW / 2, 0, ZB],
        [RW / 2, 0, ZB],
        [RW / 2, 0.12, ZB],
        [-RW / 2, 0.12, ZB],
      ],
      trim,
    ),
  );

  // ---- windows on the back wall ---------------------------------------------------------------
  const count = Math.max(0, room.windowCount ?? 2);
  const winXs: number[] = [];
  if (living) {
    for (let i = 0; i < count; i += 1) winXs.push(0.9 + i * 1.35);
  } else {
    const span = RW - 2.0;
    for (let i = 0; i < count; i += 1)
      winXs.push(-span / 2 + ((i + 0.5) * span) / Math.max(1, count));
  }
  const drape = mix(room.rugColor ?? '#9B8B74', '#F2EAD8', 0.35);
  for (const wx of winXs) {
    const ww = 1.05;
    const z = ZB - 0.01;
    const glass = pr.boxOf(wx - ww / 2, wx + ww / 2, 0.95, 2.5, z, z);
    svg.add(
      `<rect x="${n(glass.x0)}" y="${n(glass.y0)}" width="${n(glass.x1 - glass.x0)}" height="${n(glass.y1 - glass.y0)}" fill="url(#${svg.linear(
        [
          [0, '#9CC3E4'],
          [0.65, '#DCEBF5'],
          [1, '#B7C9A4'],
        ],
      )})"/>`,
    );
    // Garden beyond the glass.
    const gh = glass.y1 - glass.y0;
    for (let k = 0; k < 6; k += 1) {
      const cx = glass.x0 + ((k + 0.5) / 6) * (glass.x1 - glass.x0);
      svg.add(
        `<circle cx="${n(cx)}" cy="${n(glass.y0 + gh * 0.72)}" r="${n(gh * rng.range(0.12, 0.2))}" fill="${rng.pick(['#7FA36A', '#6E965C', '#8DB178'])}" opacity="0.8"/>`,
      );
    }
    svg.add(
      `<rect x="${n(glass.x0)}" y="${n(glass.y0 + gh * 0.82)}" width="${n(glass.x1 - glass.x0)}" height="${n(gh * 0.18)}" fill="#9DB386"/>`,
    );
    const t = 0.1;
    const frame = pr.boxOf(wx - ww / 2 - t, wx + ww / 2 + t, 0.85, 2.6, z, z);
    for (const [x0, x1] of [
      [wx - ww / 2 - t, wx - ww / 2],
      [wx + ww / 2, wx + ww / 2 + t],
    ] as const) {
      svg.add(
        pr.poly(
          [
            [x0, 0.85, z],
            [x1, 0.85, z],
            [x1, 2.6, z],
            [x0, 2.6, z],
          ],
          trim,
        ),
      );
    }
    svg.add(
      pr.poly(
        [
          [wx - ww / 2 - t, 2.5, z],
          [wx + ww / 2 + t, 2.5, z],
          [wx + ww / 2 + t, 2.6, z],
          [wx - ww / 2 - t, 2.6, z],
        ],
        trim,
      ),
    );
    svg.add(
      pr.poly(
        [
          [wx - ww / 2 - t - 0.05, 0.85, z],
          [wx + ww / 2 + t + 0.05, 0.85, z],
          [wx + ww / 2 + t + 0.05, 0.95, z],
          [wx - ww / 2 - t - 0.05, 0.95, z],
        ],
        lighten(trim, 0.1),
      ),
    );
    svg.add(pr.line([wx, 0.95, z], [wx, 2.5, z], trim, lw(0.04, z)));
    for (const y of [1.47, 1.98])
      svg.add(pr.line([wx - ww / 2, y, z], [wx + ww / 2, y, z], trim, lw(0.035, z)));
    windows.push(glass);
    anchors.add('interior_window', frame, 0.95);
    // Drapes.
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? wx - ww / 2 - 0.45 : wx + ww / 2 + 0.05;
      const x1 = x0 + 0.4;
      svg.add(
        pr.poly(
          [
            [x0, 0.05, z - 0.05],
            [x1, 0.05, z - 0.05],
            [x1, 2.75, z - 0.05],
            [x0, 2.75, z - 0.05],
          ],
          `url(#${svg.linear(
            [
              [0, drape],
              [0.5, lighten(drape, 0.15)],
              [1, darken(drape, 0.12)],
            ],
            { x1: 0, y1: 0, x2: 1, y2: 0 },
          )})`,
        ),
      );
      for (let k = 1; k < 4; k += 1)
        svg.add(
          pr.line(
            [x0 + k * 0.1, 0.05, z - 0.05],
            [x0 + k * 0.1, 2.75, z - 0.05],
            darken(drape, 0.18),
            lw(0.012, z),
            ' opacity="0.6"',
          ),
        );
    }
    svg.add(
      pr.line(
        [wx - ww / 2 - 0.55, 2.78, z - 0.06],
        [wx + ww / 2 + 0.55, 2.78, z - 0.06],
        '#7A5A2C',
        lw(0.03, z),
      ),
    );
  }

  // ---- wall art (left wall) and blank wall anchor ------------------------------------------------
  const artZ0 = 3.6;
  const artZ1 = 5.4;
  svg.add(
    pr.poly(
      [
        [-RW / 2 + 0.01, 1.35, artZ0],
        [-RW / 2 + 0.01, 1.35, artZ1],
        [-RW / 2 + 0.01, 2.3, artZ1],
        [-RW / 2 + 0.01, 2.3, artZ0],
      ],
      '#B08D57',
    ),
  );
  svg.add(
    pr.poly(
      [
        [-RW / 2 + 0.02, 1.42, artZ0 + 0.1],
        [-RW / 2 + 0.02, 1.42, artZ1 - 0.1],
        [-RW / 2 + 0.02, 2.23, artZ1 - 0.1],
        [-RW / 2 + 0.02, 2.23, artZ0 + 0.1],
      ],
      `url(#${svg.linear([
        [0, '#C9D6DD'],
        [0.55, '#E8D9B8'],
        [1, '#7D8F5C'],
      ])})`,
    ),
  );
  svg.add(
    pr.poly(
      [
        [-RW / 2 + 0.03, 1.42, artZ0 + 0.1],
        [-RW / 2 + 0.03, 1.42, artZ1 - 0.1],
        [-RW / 2 + 0.03, 1.75, artZ1 - 0.4],
        [-RW / 2 + 0.03, 1.9, artZ0 + 0.9],
        [-RW / 2 + 0.03, 1.7, artZ0 + 0.3],
      ],
      '#6B7D4F',
      ' opacity="0.85"',
    ),
  );
  anchors.add(
    'wall',
    pr.bbox([
      [-RW / 2, 1.2, 6.2],
      [-RW / 2, 2.5, 8.6],
    ]),
    0.88,
  );

  // ---- rug -------------------------------------------------------------------------------------
  const rug = room.rugColor ?? '#9C8B76';
  const rugX = dining ? 2.1 : 1.9;
  const rugZ0 = dining ? 2.4 : 3.2;
  const rugZ1 = dining ? 8.3 : 7.6;
  svg.add(
    pr.poly(
      [
        [-rugX, 0.005, rugZ0],
        [rugX, 0.005, rugZ0],
        [rugX, 0.005, rugZ1],
        [-rugX, 0.005, rugZ1],
      ],
      rug,
    ),
  );
  svg.add(
    pr.poly(
      [
        [-rugX + 0.25, 0.006, rugZ0 + 0.25],
        [rugX - 0.25, 0.006, rugZ0 + 0.25],
        [rugX - 0.25, 0.006, rugZ1 - 0.25],
        [-rugX + 0.25, 0.006, rugZ1 - 0.25],
      ],
      'none',
      ` stroke="${lighten(rug, 0.3)}" stroke-width="${n(lw(0.05, 4))}"`,
    ),
  );

  // ---- living room: fireplace and mantel ------------------------------------------------------------
  if (room.mantel) {
    const fx = -0.9;
    const z0 = ZB - 0.32;
    svg.add(
      pr.poly(
        [
          [fx - 1.2, 0, ZB - 0.6],
          [fx + 1.2, 0, ZB - 0.6],
          [fx + 1.2, 0, ZB],
          [fx - 1.2, 0, ZB],
        ],
        '#8C8478',
      ),
    );
    svg.add(
      pr.solid(fx - 1.0, fx + 1.0, 0, 1.22, z0, ZB, {
        front: trim,
        top: lighten(trim, 0.05),
        side: darken(trim, 0.12),
      }),
    );
    svg.add(
      pr.poly(
        [
          [fx - 0.55, 0.0, z0 - 0.001],
          [fx + 0.55, 0.0, z0 - 0.001],
          [fx + 0.55, 0.85, z0 - 0.001],
          [fx - 0.55, 0.85, z0 - 0.001],
        ],
        '#2A2522',
      ),
    );
    svg.add(
      pr.poly(
        [
          [fx - 0.45, 0.05, z0 - 0.002],
          [fx + 0.45, 0.05, z0 - 0.002],
          [fx + 0.45, 0.75, z0 - 0.002],
          [fx - 0.45, 0.75, z0 - 0.002],
        ],
        '#14110F',
      ),
    );
    for (let k = 0; k < 3; k += 1)
      svg.add(
        pr.line(
          [fx - 0.3 + k * 0.05, 0.12, z0 + 0.1],
          [fx + 0.3 - k * 0.05, 0.2 + k * 0.03, z0 + 0.1],
          '#5A3D28',
          lw(0.07, z0),
        ),
      );
    const shelfZ0 = ZB - 0.45;
    svg.add(
      pr.solid(fx - 1.2, fx + 1.2, 1.22, 1.32, shelfZ0, ZB, {
        front: darken(trim, 0.05),
        top: lighten(trim, 0.08),
        side: darken(trim, 0.15),
      }),
    );
    // Mirror above.
    svg.add(
      pr.poly(
        [
          [fx - 0.7, 1.55, ZB - 0.02],
          [fx + 0.7, 1.55, ZB - 0.02],
          [fx + 0.7, 2.55, ZB - 0.02],
          [fx - 0.7, 2.55, ZB - 0.02],
        ],
        '#B8964F',
      ),
    );
    svg.add(
      pr.poly(
        [
          [fx - 0.6, 1.63, ZB - 0.03],
          [fx + 0.6, 1.63, ZB - 0.03],
          [fx + 0.6, 2.47, ZB - 0.03],
          [fx - 0.6, 2.47, ZB - 0.03],
        ],
        `url(#${svg.linear([
          [0, '#DCE3E6'],
          [1, '#A9B3B8'],
        ])})`,
      ),
    );
    anchors.add('mantel', pr.boxOf(fx - 1.2, fx + 1.2, 1.2, 1.36, shelfZ0, shelfZ0), 0.95);
  }

  // ---- shelf -------------------------------------------------------------------------------------
  if (room.shelf || (!dining && !living)) {
    const sx0 = living ? -RW / 2 + 0.01 : 0.3;
    if (living) {
      // A bookcase on the left wall.
      const z0 = 6.0;
      const z1 = 7.6;
      svg.add(
        pr.poly(
          [
            [sx0, 0, z0],
            [sx0, 0, z1],
            [sx0, 2.2, z1],
            [sx0, 2.2, z0],
          ],
          darken(trim, 0.1),
        ),
      );
      for (const y of [0.55, 1.1, 1.65]) {
        svg.add(
          pr.poly(
            [
              [sx0 + 0.3, y, z0],
              [sx0 + 0.3, y, z1],
              [sx0 + 0.3, y + 0.04, z1],
              [sx0 + 0.3, y + 0.04, z0],
            ],
            trim,
          ),
        );
        for (let z = z0 + 0.08; z < z1 - 0.1; z += 0.09) {
          if (rng.next() < 0.2) continue;
          const h = rng.range(0.25, 0.42);
          svg.add(
            pr.poly(
              [
                [sx0 + 0.25, y + 0.04, z],
                [sx0 + 0.25, y + 0.04, z + 0.07],
                [sx0 + 0.25, y + 0.04 + h, z + 0.07],
                [sx0 + 0.25, y + 0.04 + h, z],
              ],
              rng.pick(['#7A2E2E', '#2E4A62', '#C9A227', '#3F5E40', '#D8CBB0', '#5A4636']),
            ),
          );
        }
      }
      anchors.add(
        'shelf',
        pr.bbox([
          [sx0 + 0.3, 1.65, z0],
          [sx0 + 0.3, 2.1, z1],
        ]),
        0.9,
      );
    } else {
      const z = ZB - 0.25;
      svg.add(
        pr.solid(sx0, sx0 + 1.6, 1.62, 1.68, z, ZB, {
          front: trim,
          top: lighten(trim, 0.05),
          side: darken(trim, 0.1),
        }),
      );
      svg.add(
        pr.solid(sx0 + 0.2, sx0 + 0.45, 1.68, 1.95, z + 0.05, z + 0.2, {
          front: '#C7B7A0',
          top: '#D6C8B3',
          side: '#A99A83',
        }),
      );
      anchors.add('shelf', pr.boxOf(sx0, sx0 + 1.6, 1.6, 1.98, z, z), 0.9);
    }
  }

  // ---- sideboard (right wall) ---------------------------------------------------------------------
  if (room.sideboard) {
    const x0 = RW / 2 - 0.5;
    const z0 = 5.6;
    const z1 = 7.8;
    const wood = darken(room.tableColor ?? '#6B4A33', 0.05);
    svg.add(
      pr.solid(x0, RW / 2, 0.12, 0.9, z0, z1, {
        front: darken(wood, 0.1),
        top: lighten(wood, 0.12),
        side: wood,
      }),
    );
    for (let k = 1; k < 3; k += 1) {
      const z = z0 + ((z1 - z0) * k) / 3;
      svg.add(
        pr.line([x0 - 0.001, 0.18, z], [x0 - 0.001, 0.84, z], darken(wood, 0.3), lw(0.015, z)),
      );
    }
    svg.add(
      pr.line([x0 - 0.001, 0.62, z0], [x0 - 0.001, 0.62, z1], darken(wood, 0.3), lw(0.012, 6)),
    );
    svg.add(
      pr.solid(x0 + 0.05, RW / 2 - 0.05, 0, 0.12, z0 + 0.05, z0 + 0.12, {
        front: darken(wood, 0.35),
        top: wood,
        side: darken(wood, 0.3),
      }),
    );
    anchors.add('sideboard', pr.boxOf(x0, RW / 2, 0.85, 0.95, z0, z1), 0.94);
  }

  // ---- living room furniture -------------------------------------------------------------------------
  if (living) {
    const sofa = room.sofaColor ?? '#5E6E73';
    const x0 = -RW / 2 + 0.05;
    svg.add(
      pr.solid(x0, x0 + 0.95, 0.1, 0.45, 2.8, 5.4, {
        front: darken(sofa, 0.15),
        top: lighten(sofa, 0.08),
        side: sofa,
      }),
    );
    svg.add(
      pr.solid(x0, x0 + 0.3, 0.45, 0.95, 2.8, 5.4, {
        front: darken(sofa, 0.2),
        top: lighten(sofa, 0.05),
        side: darken(sofa, 0.05),
      }),
    );
    for (const z of [2.8, 5.15])
      svg.add(
        pr.solid(x0, x0 + 0.95, 0.1, 0.65, z, z + 0.25, {
          front: darken(sofa, 0.12),
          top: lighten(sofa, 0.1),
          side: darken(sofa, 0.02),
        }),
      );
    for (let k = 0; k < 3; k += 1) {
      const z = 3.15 + k * 0.65;
      svg.add(
        pr.solid(x0 + 0.28, x0 + 0.45, 0.45, 0.88, z, z + 0.55, {
          front: lighten(sofa, 0.06),
          top: lighten(sofa, 0.15),
          side: lighten(sofa, 0.1),
        }),
      );
    }
    // Coffee table and a floor lamp.
    svg.add(
      pr.solid(-0.6, 0.6, 0.3, 0.42, 4.2, 5.2, {
        front: '#6B4A33',
        top: '#8A6440',
        side: '#5A3E2B',
      }),
    );
    svg.add(pr.line([-2.1, 0, 6.2], [-2.1, 1.55, 6.2], '#2B2B2B', lw(0.03, 6.2)));
    svg.add(
      pr.poly(
        [
          [-2.32, 1.5, 6.2],
          [-1.88, 1.5, 6.2],
          [-1.95, 1.85, 6.2],
          [-2.25, 1.85, 6.2],
        ],
        '#F2E6CC',
      ),
    );
    lights.push(pr.boxOf(-2.32, -1.88, 1.5, 1.85, 6.2, 6.2));
    // Open floor beside the window for a tree.
    if (room.openFloorBesideWindow !== false) {
      anchors.add('floor_area', pr.boxOf(1.6, 3.0, 0, 2.3, 8.4, 8.4), 0.92);
    }
    // A potted plant in the far corner.
    svg.add(
      pr.solid(-RW / 2 + 0.3, -RW / 2 + 0.7, 0, 0.45, ZB - 0.7, ZB - 0.3, {
        front: '#B5653F',
        top: '#5A3D28',
        side: '#9A5233',
      }),
    );
    const [px0, py0] = pr.p(-RW / 2 + 0.5, 1.0, ZB - 0.5);
    for (let k = 0; k < 10; k += 1) {
      svg.add(
        `<ellipse cx="${n(px0 + rng.jitter(pr.s(0.35, ZB)))}" cy="${n(py0 + rng.jitter(pr.s(0.4, ZB)))}" rx="${n(pr.s(0.18, ZB))}" ry="${n(pr.s(0.07, ZB))}" fill="${rng.pick(['#3F6B3A', '#4F7F3F', '#2F5A2C'])}" transform="rotate(${n(rng.range(-50, 50))} ${n(px0)} ${n(py0)})"/>`,
      );
    }
  }

  // ---- dining table, chairs and place settings ------------------------------------------------------
  const tableX = 0.95;
  const tableZ0 = 3.0;
  const tableZ1 = 7.7;
  const tableTop = 0.76;
  const chairColor = room.chairColor ?? '#4A3324';
  const seatsPerSide = Math.max(
    0,
    Math.floor(((room.chairCount ?? 0) - (room.chairCount && room.chairCount > 4 ? 1 : 0)) / 2),
  );
  const seatZs: number[] = [];
  for (let i = 0; i < seatsPerSide; i += 1)
    seatZs.push(tableZ0 + 0.9 + ((i + 0.5) * (tableZ1 - tableZ0 - 1.5)) / seatsPerSide);
  const drawChair = (side: number, z: number) => {
    const xo = side * 1.55;
    const xi = side * 1.18;
    const [a, b] = side < 0 ? [xo, xi] : [xi, xo];
    svg.add(
      pr.solid(a, b, 0.44, 0.5, z - 0.22, z + 0.22, {
        front: darken(chairColor, 0.15),
        top: lighten(chairColor, 0.1),
        side: chairColor,
      }),
    );
    svg.add(
      pr.poly(
        [
          [xo, 0.5, z - 0.2],
          [xo, 0.5, z + 0.2],
          [xo, 1.08, z + 0.2],
          [xo, 1.08, z - 0.2],
        ],
        darken(chairColor, 0.05),
      ),
    );
    svg.add(
      pr.poly(
        [
          [xo, 0.62, z - 0.14],
          [xo, 0.62, z + 0.14],
          [xo, 0.98, z + 0.14],
          [xo, 0.98, z - 0.14],
        ],
        lighten(chairColor, 0.12),
      ),
    );
    for (const dz of [-0.18, 0.18])
      svg.add(pr.line([xi, 0, z + dz], [xi, 0.44, z + dz], darken(chairColor, 0.25), lw(0.04, z)));
  };
  if (dining && room.tableShape !== 'none') {
    const wood = room.tableColor ?? '#7A5233';
    // Head chair at the far end.
    if ((room.chairCount ?? 0) > 4) {
      const z = tableZ1 + 0.45;
      svg.add(
        pr.solid(-0.25, 0.25, 0.44, 0.5, z - 0.2, z + 0.2, {
          front: darken(chairColor, 0.15),
          top: lighten(chairColor, 0.1),
          side: chairColor,
        }),
      );
      svg.add(
        pr.poly(
          [
            [-0.24, 0.5, z + 0.2],
            [0.24, 0.5, z + 0.2],
            [0.24, 1.12, z + 0.2],
            [-0.24, 1.12, z + 0.2],
          ],
          chairColor,
        ),
      );
    }
    for (const z of [...seatZs].reverse()) {
      drawChair(-1, z);
      drawChair(1, z);
    }
    // Legs, apron and top.
    for (const [lx, lz] of [
      [-tableX + 0.08, tableZ0 + 0.1],
      [tableX - 0.08, tableZ0 + 0.1],
      [-tableX + 0.08, tableZ1 - 0.1],
      [tableX - 0.08, tableZ1 - 0.1],
    ] as const) {
      svg.add(
        pr.solid(lx - 0.05, lx + 0.05, 0, tableTop - 0.06, lz - 0.05, lz + 0.05, {
          front: darken(wood, 0.3),
          top: wood,
          side: darken(wood, 0.2),
        }),
      );
    }
    svg.add(
      pr.solid(-tableX, tableX, tableTop - 0.07, tableTop, tableZ0, tableZ1, {
        front: darken(wood, 0.25),
        top: `url(#${svg.linear([
          [0, lighten(wood, 0.12)],
          [1, darken(wood, 0.05)],
        ])})`,
        side: darken(wood, 0.18),
      }),
    );
    for (let x = -tableX + 0.12; x < tableX; x += 0.17)
      svg.add(
        pr.line(
          [x, tableTop + 0.001, tableZ0],
          [x, tableTop + 0.001, tableZ1],
          darken(wood, 0.12),
          lw(0.006, 5),
          ' opacity="0.6"',
        ),
      );
    // Place settings.
    for (const z of seatZs) {
      for (const side of [-1, 1]) {
        const [cx, cy] = pr.p(side * 0.6, tableTop + 0.002, z);
        const rx = pr.s(0.15, z);
        const ry =
          rx *
          ((pr.p(0, tableTop, z - 0.15)[1] - pr.p(0, tableTop, z + 0.15)[1]) / (2 * rx) || 0.3);
        svg.add(
          `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx * 1.05)}" ry="${n(Math.max(1, ry))}" fill="#E9E2D3"/>`,
        );
        svg.add(
          `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx * 0.72)}" ry="${n(Math.max(0.7, ry * 0.7))}" fill="#FBF8F1"/>`,
        );
        const [gx, gy] = pr.p(side * 0.42, tableTop, z - 0.22);
        const gr = pr.s(0.035, z);
        svg.add(
          `<rect x="${n(gx - gr)}" y="${n(gy - gr * 5)}" width="${n(gr * 2)}" height="${n(gr * 2.6)}" fill="#E6F0F5" opacity="0.65"/>`,
        );
        svg.add(
          `<line x1="${n(gx)}" y1="${n(gy - gr * 2.4)}" x2="${n(gx)}" y2="${n(gy)}" stroke="#DCE6EA" stroke-width="${n(Math.max(0.5, gr * 0.3))}" opacity="0.8"/>`,
        );
      }
    }
    anchors.add(
      'dining_table',
      pr.boxOf(-tableX, tableX, tableTop, tableTop, tableZ0, tableZ1),
      0.96,
    );
    if (input.dinner === 'thanksgiving') drawThanksgivingDinner(svg, pr, rng, tableTop);
  }

  // ---- chandelier -----------------------------------------------------------------------------------
  if (room.chandelier) {
    const z = dining ? 5.4 : 5.0;
    svg.add(pr.line([0, RH, z], [0, 2.35, z], '#5B4A2E', lw(0.02, z)));
    const [cx, cy] = pr.p(0, 2.2, z);
    const rx = pr.s(0.55, z);
    svg.add(
      `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(rx * 0.22)}" fill="none" stroke="#B08D57" stroke-width="${n(lw(0.03, z))}"/>`,
    );
    svg.add(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(pr.s(0.08, z))}" fill="#B08D57"/>`);
    for (let k = 0; k < 6; k += 1) {
      const a = (k / 6) * Math.PI * 2;
      const bx = cx + Math.cos(a) * rx;
      const by = cy + Math.sin(a) * rx * 0.22;
      svg.add(
        `<rect x="${n(bx - pr.s(0.02, z))}" y="${n(by - pr.s(0.12, z))}" width="${n(pr.s(0.04, z))}" height="${n(pr.s(0.12, z))}" fill="#F4EEDD"/>`,
      );
      svg.add(
        `<ellipse cx="${n(bx)}" cy="${n(by - pr.s(0.16, z))}" rx="${n(pr.s(0.03, z))}" ry="${n(pr.s(0.05, z))}" fill="#FFE7A8"/>`,
      );
      lights.push(
        pxBox(bx - pr.s(0.06, z), by - pr.s(0.22, z), bx + pr.s(0.06, z), by - pr.s(0.1, z)),
      );
    }
  }

  // Soft light from the windows and a vignette.
  svg.add(
    `<rect width="${W}" height="${H}" fill="url(#${svg.radial(
      [
        [0, '#FFF6E0', 0.18],
        [0.6, '#FFF6E0', 0],
        [1, '#000000', 0.2],
      ],
      input.focalX ?? 0.5,
      0.35,
      0.8,
    )})"/>`,
  );

  const geometry: FixtureSceneGeometry = {
    width: W,
    height: H,
    sceneType: 'interior',
    roomType,
    targetFacadeAmbiguous: false,
    anchors: anchors.build(0.3),
    preserveRegions: [],
    accessRegions: [],
    hazards: [],
    existingDecorations: NO_EXISTING_DECOR,
    peopleBoxes: [],
    protectedBlurRegions: [],
    lighting: DAYLIGHT,
    seasonCues: { snowVisible: false, foliage: 'unknown' },
    qualityFlags: NO_QUALITY_FLAGS,
    windows: normBoxes(windows, W, H),
    neighborFacades: [],
    lightSources: normBoxes(lights, W, H),
  };
  return { svg: svg.toString(), geometry };
}

function drawThanksgivingDinner(svg: SvgBuilder, pr: Projector, rng: Rng, top: number): void {
  const at = (x: number, z: number) => pr.p(x, top + 0.002, z);
  // Roast turkey on a platter toward the near end.
  const tz = 4.15;
  const [px, py] = at(0, tz);
  const pw = pr.s(0.42, tz);
  svg.add(
    `<ellipse cx="${n(px)}" cy="${n(py)}" rx="${n(pw)}" ry="${n(pw * 0.34)}" fill="#F3EEE4" stroke="#C9B78F" stroke-width="${n(Math.max(1, pw * 0.03))}"/>`,
  );
  svg.add(
    `<ellipse cx="${n(px)}" cy="${n(py - pw * 0.06)}" rx="${n(pw * 0.62)}" ry="${n(pw * 0.38)}" fill="#7A3E17"/>`,
  );
  svg.add(
    `<ellipse cx="${n(px)}" cy="${n(py - pw * 0.14)}" rx="${n(pw * 0.55)}" ry="${n(pw * 0.32)}" fill="url(#${svg.radial(
      [
        [0, '#E3A55A'],
        [0.6, '#B76A2A'],
        [1, '#7A3E17'],
      ],
      0.4,
      0.3,
      0.7,
    )})"/>`,
  );
  for (const side of [-1, 1]) {
    svg.add(
      `<ellipse cx="${n(px + side * pw * 0.52)}" cy="${n(py - pw * 0.02)}" rx="${n(pw * 0.2)}" ry="${n(pw * 0.12)}" fill="#A9602A" transform="rotate(${side * 25} ${n(px + side * pw * 0.52)} ${n(py)})"/>`,
    );
    svg.add(
      `<circle cx="${n(px + side * pw * 0.7)}" cy="${n(py + pw * 0.02)}" r="${n(pw * 0.05)}" fill="#F6F0E2"/>`,
    );
  }
  svg.add(
    `<ellipse cx="${n(px - pw * 0.15)}" cy="${n(py - pw * 0.3)}" rx="${n(pw * 0.2)}" ry="${n(pw * 0.08)}" fill="#F5D9A8" opacity="0.55"/>`,
  );
  for (let k = 0; k < 9; k += 1) {
    const a = (k / 9) * Math.PI * 2;
    svg.add(
      `<circle cx="${n(px + Math.cos(a) * pw * 0.78)}" cy="${n(py + Math.sin(a) * pw * 0.24)}" r="${n(pw * 0.06)}" fill="${k % 3 === 0 ? '#E07A1F' : '#5D8A3A'}"/>`,
    );
  }
  // Side dishes around the table.
  const dishes: [number, number, string, string][] = [
    [-0.45, 3.55, '#F6EFD9', '#E8D9A8'],
    [0.45, 3.6, '#8E1B2B', '#B3283C'],
    [-0.5, 4.8, '#4E7A34', '#6E9A4A'],
    [0.5, 4.75, '#D9A441', '#E9BE62'],
    [-0.42, 6.7, '#C46A2B', '#E08A44'],
    [0.42, 6.75, '#F6EFD9', '#E8D9A8'],
  ];
  for (const [x, z, fill, highlight] of dishes) {
    const [cx, cy] = at(x, z);
    const r = pr.s(0.14, z);
    svg.add(
      `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(r)}" ry="${n(r * 0.42)}" fill="#FBF8F1" stroke="#D8CDB6" stroke-width="${n(Math.max(0.6, r * 0.05))}"/>`,
    );
    svg.add(
      `<ellipse cx="${n(cx)}" cy="${n(cy - r * 0.08)}" rx="${n(r * 0.78)}" ry="${n(r * 0.3)}" fill="${fill}"/>`,
    );
    for (let k = 0; k < 5; k += 1)
      svg.add(
        `<circle cx="${n(cx + rng.jitter(r * 0.45))}" cy="${n(cy - r * 0.1 + rng.jitter(r * 0.12))}" r="${n(r * 0.1)}" fill="${highlight}"/>`,
      );
  }
  // A pumpkin pie and a bread basket.
  const [pcx, pcy] = at(0.05, 7.05);
  const pr2 = pr.s(0.16, 7.05);
  svg.add(
    `<ellipse cx="${n(pcx)}" cy="${n(pcy)}" rx="${n(pr2)}" ry="${n(pr2 * 0.4)}" fill="#C9883E"/>`,
  );
  svg.add(
    `<ellipse cx="${n(pcx)}" cy="${n(pcy - pr2 * 0.05)}" rx="${n(pr2 * 0.82)}" ry="${n(pr2 * 0.32)}" fill="#C8642A"/>`,
  );
  const [bx, by] = at(-0.05, 5.6);
  const br = pr.s(0.13, 5.6);
  svg.add(
    `<ellipse cx="${n(bx)}" cy="${n(by)}" rx="${n(br)}" ry="${n(br * 0.45)}" fill="#A0763F"/>`,
  );
  for (let k = 0; k < 4; k += 1)
    svg.add(
      `<ellipse cx="${n(bx + (k - 1.5) * br * 0.4)}" cy="${n(by - br * 0.2)}" rx="${n(br * 0.25)}" ry="${n(br * 0.16)}" fill="#D9A45A"/>`,
    );
}
