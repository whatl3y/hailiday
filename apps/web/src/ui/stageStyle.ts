import type { CSSProperties } from 'react';

/**
 * The custom properties a stage reads its picture's size from (`--stage-w`, `--stage-h`), as
 * plain numbers. The server-rendered share page writes the same two properties.
 */
export function stageStyle(width: number, height: number): CSSProperties {
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;
  return { '--stage-w': String(w), '--stage-h': String(h) } as CSSProperties;
}
