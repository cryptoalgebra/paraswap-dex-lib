import JSBI from 'jsbi';
import { ZERO, MaxUint256 } from './internalConstants';

const TWO = JSBI.BigInt(2);
const POWERS_OF_2 = [128, 64, 32, 16, 8, 4, 2, 1].map(
  (pow: number): [number, JSBI] => [
    pow,
    JSBI.exponentiate(TWO, JSBI.BigInt(pow)),
  ],
);

export function mostSignificantBit(x: JSBI): number | null {
  if (JSBI.LE(x, ZERO) || JSBI.GT(x, MaxUint256)) return null;

  let msb = 0;
  for (const [power, min] of POWERS_OF_2) {
    if (JSBI.greaterThanOrEqual(x, min)) {
      x = JSBI.signedRightShift(x, JSBI.BigInt(power));
      msb += power;
    }
  }
  return msb;
}
