// clipper-lib (Angus Johnson's Clipper, JavaScript port) ships no types; this declares only what the editor uses.
declare module "clipper-lib" {
  export interface IntPoint { X: number; Y: number }
  const ClipperLib: {
    ClipperOffset: new (miterLimit?: number, arcTolerance?: number) => {
      AddPath(path: IntPoint[], joinType: number, endType: number): void;
      Execute(solution: IntPoint[][], delta: number): void;
    };
    JoinType: { jtSquare: number; jtRound: number; jtMiter: number };
    EndType: { etClosedPolygon: number; etClosedLine: number; etOpenButt: number; etOpenSquare: number; etOpenRound: number };
    Paths: new () => IntPoint[][];
  };
  export default ClipperLib;
}
