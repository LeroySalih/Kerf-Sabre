import { describe, expect, it } from "vitest";
import { GIZMO, gizmoAngle, gizmoMatrix, gizmoPoints, hitGizmo } from "../src/gizmo";
import { apply } from "../src/geometry";

const P = { x: 300, y: 300 }; // pivot on screen
const near = (a: { x: number; y: number }, x: number, y: number) => {
  expect(a.x).toBeCloseTo(x, 9);
  expect(a.y).toBeCloseTo(y, 9);
};

describe("hitGizmo", () => {
  const g = gizmoPoints(P);
  it("finds each handle", () => {
    expect(hitGizmo(P, P)).toBe("move");
    expect(hitGizmo(P, g.scaleUniform)).toBe("scale");
    expect(hitGizmo(P, g.scaleX)).toBe("scale-x");
    expect(hitGizmo(P, g.scaleY)).toBe("scale-y");
    expect(hitGizmo(P, g.tipX)).toBe("move-x");
    expect(hitGizmo(P, g.tipY)).toBe("move-y");
    expect(hitGizmo(P, { x: P.x + 65, y: P.y + 2 })).toBe("move-x"); // shaft between scale square and tip
    expect(hitGizmo(P, { x: P.x - 1, y: P.y - 65 })).toBe("move-y");
    expect(hitGizmo(P, { x: P.x + GIZMO.ring, y: P.y })).toBe("rotate");
    expect(hitGizmo(P, { x: P.x - 74, y: P.y - 74 })).toBe("rotate"); // 74*sqrt2 ~ 104.6
  });
  it("misses everything else", () => {
    expect(hitGizmo(P, { x: 10, y: 10 })).toBeNull();
    expect(hitGizmo(P, { x: P.x + 60, y: P.y + 40 })).toBeNull();
    expect(hitGizmo(P, { x: P.x - 40, y: P.y })).toBeNull(); // the -X side has no handle
    expect(hitGizmo(P, { x: P.x + 150, y: P.y })).toBeNull(); // outside the ring
  });
  it("small handles win where they overlap the shaft", () => {
    expect(hitGizmo(P, { x: P.x + GIZMO.scaleAt, y: P.y + 1 })).toBe("scale-x");
  });
});

describe("gizmoMatrix", () => {
  const pivot = { x: 100, y: 100 };
  it("axis moves ignore the other axis", () => {
    const mx = gizmoMatrix("move-x", pivot, { x: 110, y: 100 }, { x: 135, y: 160 })!;
    near(apply(mx, { x: 0, y: 0 }), 25, 0);
    const my = gizmoMatrix("move-y", pivot, { x: 100, y: 110 }, { x: 150, y: 140 })!;
    near(apply(my, { x: 0, y: 0 }), 0, 30);
  });
  it("free move follows the cursor", () => {
    near(apply(gizmoMatrix("move", pivot, { x: 1, y: 1 }, { x: 4, y: 9 })!, { x: 0, y: 0 }), 3, 8);
  });
  it("axis scale keeps the pivot fixed and changes only that axis", () => {
    const m = gizmoMatrix("scale-x", pivot, { x: 150, y: 100 }, { x: 200, y: 100 })!; // 50 -> 100 away: x2
    near(apply(m, pivot), 100, 100);
    near(apply(m, { x: 150, y: 140 }), 200, 140);
  });
  it("uniform scale uses distance from the pivot", () => {
    const m = gizmoMatrix("scale", pivot, { x: 110, y: 110 }, { x: 130, y: 130 })!; // 3x as far
    near(apply(m, pivot), 100, 100);
    near(apply(m, { x: 110, y: 110 }), 130, 130);
  });
  it("dragging an axis scale through the pivot mirrors, and never collapses to zero", () => {
    const m = gizmoMatrix("scale-x", pivot, { x: 150, y: 100 }, { x: 50, y: 100 })!;
    near(apply(m, { x: 150, y: 100 }), 50, 100);
    const flat = gizmoMatrix("scale-x", pivot, { x: 150, y: 100 }, { x: 100, y: 100 })!;
    expect(Math.abs(flat[0])).toBeGreaterThan(0);
  });
  it("rotation keeps the pivot fixed and turns counter-clockwise", () => {
    const m = gizmoMatrix("rotate", pivot, { x: 200, y: 100 }, { x: 100, y: 200 })!; // east -> north = +90
    near(apply(m, pivot), 100, 100);
    near(apply(m, { x: 200, y: 100 }), 100, 200);
  });
  it("returns null when the drag started on the pivot", () => {
    expect(gizmoMatrix("scale", pivot, pivot, { x: 5, y: 5 })).toBeNull();
    expect(gizmoMatrix("scale-x", pivot, { x: 100, y: 50 }, { x: 5, y: 5 })).toBeNull();
  });
});

describe("gizmoAngle", () => {
  const pivot = { x: 0, y: 0 };
  it("takes the short way round across the +-180 seam", () => {
    expect(gizmoAngle(pivot, { x: -1, y: 0.01 }, { x: -1, y: -0.01 })).toBeCloseTo(1.146, 2); // counter-clockwise past the west axis, not -358.8
  });
  it("snaps to 15 degree steps when asked", () => {
    expect(gizmoAngle(pivot, { x: 1, y: 0 }, { x: Math.cos(0.3), y: Math.sin(0.3) }, { step: true })).toBe(15); // 17.2 -> 15
    expect(gizmoAngle(pivot, { x: 1, y: 0 }, { x: 0, y: 1 }, { step: true })).toBe(90);
  });
});
