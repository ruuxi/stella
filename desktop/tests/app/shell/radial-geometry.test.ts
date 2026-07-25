import { describe, expect, it } from "vitest";
import {
  RADIAL_CENTER,
  RADIAL_DEAD_ZONE_RADIUS,
  RADIAL_WEDGE_COUNT,
  getWedgeIndexAt,
  getWedgeContentPosition,
} from "@/shared/lib/radial-geometry";

const C = RADIAL_CENTER;

// Wedge 0 *starts* at 12 o'clock and each spans 90° clockwise, so the wedges
// occupy quadrants and their centres are the diagonals, not the compass
// points: 0 upper-right, 1 lower-right, 2 lower-left, 3 upper-left.
describe("getWedgeIndexAt", () => {
  it("maps each quadrant to its wedge", () => {
    expect(getWedgeIndexAt(C + 70, C - 70, C, C)).toBe(0); // upper right
    expect(getWedgeIndexAt(C + 70, C + 70, C, C)).toBe(1); // lower right
    expect(getWedgeIndexAt(C - 70, C + 70, C, C)).toBe(2); // lower left
    expect(getWedgeIndexAt(C - 70, C - 70, C, C)).toBe(3); // upper left
  });

  it("resolves the axis boundaries to the clockwise-following wedge", () => {
    expect(getWedgeIndexAt(C, C - 100, C, C)).toBe(0); // 12 o'clock
    expect(getWedgeIndexAt(C + 100, C, C, C)).toBe(1); // 3 o'clock
    expect(getWedgeIndexAt(C, C + 100, C, C)).toBe(2); // 6 o'clock
    expect(getWedgeIndexAt(C - 100, C, C, C)).toBe(3); // 9 o'clock
  });

  it("returns null inside the dead zone so a release there dismisses", () => {
    expect(getWedgeIndexAt(C, C, C, C)).toBeNull();
    expect(getWedgeIndexAt(C + RADIAL_DEAD_ZONE_RADIUS - 1, C, C, C)).toBeNull();
  });

  it("selects as soon as the cursor clears the dead zone", () => {
    expect(getWedgeIndexAt(C + RADIAL_DEAD_ZONE_RADIUS, C, C, C)).toBe(1);
  });

  it("has no outer bound — a far flick still selects", () => {
    expect(getWedgeIndexAt(C + 5000, C + 5000, C, C)).toBe(1);
    expect(getWedgeIndexAt(C + 5000, C - 5000, C, C)).toBe(0);
  });

  it("splits neighbouring wedges either side of an axis", () => {
    // Just clockwise of 12 o'clock is wedge 0; just anticlockwise is wedge 3.
    expect(getWedgeIndexAt(C + 2, C - 100, C, C)).toBe(0);
    expect(getWedgeIndexAt(C - 2, C - 100, C, C)).toBe(3);
  });

  it("only ever returns a valid wedge index", () => {
    for (let deg = 0; deg < 360; deg += 7) {
      const rad = (deg * Math.PI) / 180;
      const index = getWedgeIndexAt(
        C + 90 * Math.cos(rad),
        C + 90 * Math.sin(rad),
        C,
        C,
      );
      expect(index).not.toBeNull();
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(RADIAL_WEDGE_COUNT);
    }
  });

  it("is relative to the passed centre, not the dial's own", () => {
    // Dial raised at an arbitrary press point: the quadrants follow it.
    expect(getWedgeIndexAt(470, 330, 400, 400)).toBe(0);
    expect(getWedgeIndexAt(470, 470, 400, 400)).toBe(1);
  });
});

describe("getWedgeContentPosition", () => {
  it("places each wedge's label on its quadrant's diagonal", () => {
    const [upperRight, lowerRight, lowerLeft, upperLeft] = [0, 1, 2, 3].map(
      getWedgeContentPosition,
    );
    expect(upperRight!.x).toBeGreaterThan(C);
    expect(upperRight!.y).toBeLessThan(C);
    expect(lowerRight!.x).toBeGreaterThan(C);
    expect(lowerRight!.y).toBeGreaterThan(C);
    expect(lowerLeft!.x).toBeLessThan(C);
    expect(lowerLeft!.y).toBeGreaterThan(C);
    expect(upperLeft!.x).toBeLessThan(C);
    expect(upperLeft!.y).toBeLessThan(C);
  });

  it("puts each label inside the wedge that hit-tests to the same index", () => {
    for (let i = 0; i < RADIAL_WEDGE_COUNT; i += 1) {
      const { x, y } = getWedgeContentPosition(i);
      expect(getWedgeIndexAt(x, y, C, C)).toBe(i);
    }
  });

  it("sits in the annulus band, between the inner and outer radius", () => {
    for (let i = 0; i < RADIAL_WEDGE_COUNT; i += 1) {
      const { x, y } = getWedgeContentPosition(i);
      const distance = Math.hypot(x - C, y - C);
      expect(distance).toBeGreaterThan(40);
      expect(distance).toBeLessThan(125);
    }
  });
});
