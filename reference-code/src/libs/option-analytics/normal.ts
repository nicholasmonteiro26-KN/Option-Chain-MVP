/** Standard normal distribution; erfc by W. J. Cody's rational Chebyshev approximation (~1e-15). */

const A = [3.1611237438705656, 113.86415415105016, 377.485237685302, 3209.3775891384694, 0.18577770618460315];
const B = [23.601290952344122, 244.02463793444417, 1282.6165260773723, 2844.236833439171];
const C = [0.5641884969886701, 8.883149794388377, 66.11919063714163, 298.6351381974001, 881.952221241769,
  1712.0476126340708, 2051.0783778260716, 1230.339354797997, 2.1531153547440383e-8];
const D = [15.744926110709835, 117.6939508913125, 537.1811018620099, 1621.3895745666903, 3290.7992357334597,
  4362.619090143247, 3439.3676741437216, 1230.339354803749];
const P = [0.3053266349612323, 0.36034489994980445, 0.12578172611122926, 0.016083785148742275,
  0.0006587491615298378, 0.016315387137302097];
const Q = [2.568520192289822, 1.872952849923460, 0.5279051029514284, 0.06051834131244132, 0.0023352049762686918];

const SQRPI = 0.5641895835477563; // 1/sqrt(pi)
const THRESH = 0.46875;

function erfcCody(x: number): number {
  const y = Math.abs(x);
  if (y <= THRESH) {
    const ysq = y > 1.11e-16 ? y * y : 0;
    let xnum = A[4]! * ysq;
    let xden = ysq;
    for (let i = 0; i < 3; i++) {
      xnum = (xnum + A[i]!) * ysq;
      xden = (xden + B[i]!) * ysq;
    }
    return 1 - (x * (xnum + A[3]!)) / (xden + B[3]!);
  }
  let result: number;
  if (y <= 4) {
    let xnum = C[8]! * y;
    let xden = y;
    for (let i = 0; i < 7; i++) {
      xnum = (xnum + C[i]!) * y;
      xden = (xden + D[i]!) * y;
    }
    result = (xnum + C[7]!) / (xden + D[7]!);
  } else if (y >= 26.543) {
    result = 0;
  } else {
    const ysq = 1 / (y * y);
    let xnum = P[5]! * ysq;
    let xden = ysq;
    for (let i = 0; i < 4; i++) {
      xnum = (xnum + P[i]!) * ysq;
      xden = (xden + Q[i]!) * ysq;
    }
    result = (ysq * (xnum + P[4]!)) / (xden + Q[4]!);
    result = (SQRPI - result) / y;
  }
  const ysq = Math.trunc(y * 16) / 16;
  const del = (y - ysq) * (y + ysq);
  result = Math.exp(-ysq * ysq) * Math.exp(-del) * result;
  return x < 0 ? 2 - result : result;
}

export function normCdf(x: number): number {
  return 0.5 * erfcCody(-x * Math.SQRT1_2);
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
