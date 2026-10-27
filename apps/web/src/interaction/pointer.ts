export interface Point {
  x: number;
  y: number;
}
export interface Target extends Point {
  id: number;
  radius: number;
}

/** Segment/circle distance prevents fast swipes from skipping cells between frames. */
export function crossedTargets(from: Point, to: Point, targets: Target[]): number[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  return targets
    .filter((target) => {
      const t =
        lengthSquared === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, ((target.x - from.x) * dx + (target.y - from.y) * dy) / lengthSquared),
            );
      const nearestX = from.x + t * dx;
      const nearestY = from.y + t * dy;
      return (nearestX - target.x) ** 2 + (nearestY - target.y) ** 2 <= target.radius ** 2;
    })
    .map((target) => target.id);
}
