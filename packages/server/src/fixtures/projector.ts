import { n, points, pxBox, unionPx, type PxBox } from './svg.js';

/**
 * A pinhole camera at (0, eyeHeight, 0) looking down +Z, used by the interior, entry and
 * balcony renderers. World units are meters; Y is up.
 */
export class Projector {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly f: number,
    readonly vx: number,
    readonly vy: number,
    readonly eye: number,
  ) {}

  p(X: number, Y: number, Z: number): [number, number] {
    const z = Math.max(0.15, Z);
    return [this.vx + (this.f * X) / z, this.vy - (this.f * (Y - this.eye)) / z];
  }

  /** Pixel size of `meters` at depth Z. */
  s(meters: number, Z: number): number {
    return (this.f * meters) / Math.max(0.15, Z);
  }

  /** Bounding box of projected points. */
  bbox(pts: readonly (readonly [number, number, number])[]): PxBox {
    const projected = pts.map(([X, Y, Z]) => this.p(X, Y, Z));
    return unionPx(projected.map(([x, y]) => pxBox(x, y, x, y))) as PxBox;
  }

  /** Bounding box of an axis-aligned 3D box. */
  boxOf(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): PxBox {
    return this.bbox([
      [x0, y0, z0],
      [x1, y0, z0],
      [x0, y1, z0],
      [x1, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x0, y1, z1],
      [x1, y1, z1],
    ]);
  }

  /** A polygon from 3D points. */
  poly(pts: readonly (readonly [number, number, number])[], fill: string, extra = ''): string {
    return `<polygon points="${points(pts.map(([X, Y, Z]) => this.p(X, Y, Z)))}" fill="${fill}"${extra}/>`;
  }

  line(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    stroke: string,
    width: number,
    extra = '',
  ): string {
    const [x1, y1] = this.p(a[0], a[1], a[2]);
    const [x2, y2] = this.p(b[0], b[1], b[2]);
    return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" stroke-width="${n(width)}" stroke-linecap="round"${extra}/>`;
  }

  /**
   * An axis-aligned solid with its visible faces: the front face (z0), the top or bottom face
   * depending on eye height, and the side face that faces the camera.
   */
  solid(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    colors: { front: string; top: string; side: string },
  ): string {
    const parts: string[] = [];
    if (x0 > 0) {
      parts.push(
        this.poly(
          [
            [x0, y0, z0],
            [x0, y1, z0],
            [x0, y1, z1],
            [x0, y0, z1],
          ],
          colors.side,
        ),
      );
    } else if (x1 < 0) {
      parts.push(
        this.poly(
          [
            [x1, y0, z0],
            [x1, y1, z0],
            [x1, y1, z1],
            [x1, y0, z1],
          ],
          colors.side,
        ),
      );
    }
    if (y1 < this.eye) {
      parts.push(
        this.poly(
          [
            [x0, y1, z0],
            [x1, y1, z0],
            [x1, y1, z1],
            [x0, y1, z1],
          ],
          colors.top,
        ),
      );
    } else if (y0 > this.eye) {
      parts.push(
        this.poly(
          [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y0, z1],
            [x0, y0, z1],
          ],
          colors.top,
        ),
      );
    }
    parts.push(
      this.poly(
        [
          [x0, y0, z0],
          [x1, y0, z0],
          [x1, y1, z0],
          [x0, y1, z0],
        ],
        colors.front,
      ),
    );
    return parts.join('');
  }
}
