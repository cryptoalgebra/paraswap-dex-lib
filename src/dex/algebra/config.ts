import { DexParams } from './types';
import { DexConfigMap } from '../../types';
import { Network, SwapSide } from '../../constants';

export const AlgebraConfig: DexConfigMap<DexParams> = {
  Algebra: {
    [Network.POLYGON]: {
      subgraphURL:
        'https://api.thegraph.com/subgraphs/name/iliaazhel/fuzzyswap',
      factoryAddress: '0x8C1EB1e5325049B412B7E71337116BEF88a29b3A',
      initCode:
        '0x6f8da21644d39435fbc8337b1031e14292c1d5a0042041eb303b6145c64c0a16',
    },
  },
};

export const Adapters: {
  [chainId: number]: { name: string; index: number }[];
} = {
  [Network.POLYGON]: [
    {
      name: 'PolygonAdapter01',
      index: 11,
    },
  ],
};
