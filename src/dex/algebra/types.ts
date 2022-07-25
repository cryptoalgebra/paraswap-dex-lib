import { Address } from '../../types';
import { NumberAsString } from 'paraswap-core';
import { AlgebraEventPool } from './algebra';

export type PoolState = {
  ticks: TickState[];
  currentTick: number;
  currentLiquidity: bigint;
  fee: number;
};

export type TickState = {
  tickIdx: number;
  liquidityDelta: bigint;
  upper: boolean;
};

export type AlgebraPair = {
  token0: Address;
  token1: Address;
  pool?: AlgebraEventPool;
};

export type AlgebraData = {
  // ExactInputSingleParams
  fee: number;
  deadline?: number;
  sqrtPriceLimitX96?: NumberAsString;
};

export type DexParams = {
  subgraphURL: string;
  factoryAddress: Address;
  initCode: string;
};

export type AlgebraSellParam = {
  tokenIn: Address;
  tokenOut: Address;
  recipient: Address;
  deadline: number;
  fee: number;
  amountIn: NumberAsString;
  amountOutMinimum: NumberAsString;
  sqrtPriceLimitX96: NumberAsString;
};

export type AlgebraBuyParam = {
  tokenIn: Address;
  tokenOut: Address;
  recipient: Address;
  deadline: number;
  fee: number;
  amountOut: NumberAsString;
  amountInMaximum: NumberAsString;
  sqrtPriceLimitX96: NumberAsString;
};

export type AlgebraPoolParam = {
  token0: Address;
  token1: Address;
  ticks: TickState[];
  currentTick: number;
  currentLiquidity: bigint;
  fee: number;
};

export type AlgebraParam = AlgebraSellParam | AlgebraBuyParam;
