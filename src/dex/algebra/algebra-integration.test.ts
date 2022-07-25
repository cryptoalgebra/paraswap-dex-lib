import dotenv from 'dotenv';
dotenv.config();

import { DummyDexHelper } from '../../dex-helper/index';
import { Network, SwapSide } from '../../constants';
import { Algebra } from './algebra';
import {
  checkPoolPrices,
  checkPoolsLiquidity,
  checkConstantPoolPrices,
} from '../../../tests/utils';
import { Tokens } from '../../../tests/constants-e2e';

/*
  README
  ======

  This test script adds tests for Algebra general integration
  with the DEX interface. The test cases below are example tests.
  It is recommended to add tests which cover Algebra specific
  logic.

  You can run this individual test script by running:
  `npx jest src/dex/<dex-name>/<dex-name>-integration.test.ts`

  (This comment should be removed from the final implementation)
*/

const network = Network.MAINNET;
const TokenASymbol = 'TokenASymbol';
const TokenA = Tokens[network][TokenASymbol];

const TokenBSymbol = 'TokenBSymbol';
const TokenB = Tokens[network][TokenBSymbol];

const amounts = [
  BigInt('0'),
  BigInt('1000000000000000000'),
  BigInt('2000000000000000000'),
];

const dexKey = 'Algebra';

describe('Algebra', function () {
  it('getPoolIdentifiers and getPricesVolume SELL', async function () {
    const dexHelper = new DummyDexHelper(network);
    const blocknumber = await dexHelper.provider.getBlockNumber();
    const algebra = new Algebra(network, dexKey, dexHelper);

    await algebra.initializePricing(blocknumber);

    const pools = await algebra.getPoolIdentifiers(
      TokenA,
      TokenB,
      SwapSide.SELL,
      blocknumber,
    );
    console.log(`${TokenASymbol} <> ${TokenBSymbol} Pool Identifiers: `, pools);

    expect(pools.length).toBeGreaterThan(0);

    const poolPrices = await algebra.getPricesVolume(
      TokenA,
      TokenB,
      amounts,
      SwapSide.SELL,
      blocknumber,
      pools,
    );
    console.log(`${TokenASymbol} <> ${TokenBSymbol} Pool Prices: `, poolPrices);

    expect(poolPrices).not.toBeNull();
    if (algebra.hasConstantPriceLargeAmounts) {
      checkConstantPoolPrices(poolPrices!, amounts, dexKey);
    } else {
      checkPoolPrices(poolPrices!, amounts, SwapSide.SELL, dexKey);
    }
  });

  it('getPoolIdentifiers and getPricesVolume BUY', async function () {
    const dexHelper = new DummyDexHelper(network);
    const blocknumber = await dexHelper.provider.getBlockNumber();
    const algebra = new Algebra(network, dexKey, dexHelper);

    await algebra.initializePricing(blocknumber);

    const pools = await algebra.getPoolIdentifiers(
      TokenA,
      TokenB,
      SwapSide.BUY,
      blocknumber,
    );
    console.log(`${TokenASymbol} <> ${TokenBSymbol} Pool Identifiers: `, pools);

    expect(pools.length).toBeGreaterThan(0);

    const poolPrices = await algebra.getPricesVolume(
      TokenA,
      TokenB,
      amounts,
      SwapSide.BUY,
      blocknumber,
      pools,
    );
    console.log(`${TokenASymbol} <> ${TokenBSymbol} Pool Prices: `, poolPrices);

    expect(poolPrices).not.toBeNull();
    if (algebra.hasConstantPriceLargeAmounts) {
      checkConstantPoolPrices(poolPrices!, amounts, dexKey);
    } else {
      checkPoolPrices(poolPrices!, amounts, SwapSide.BUY, dexKey);
    }
  });

  it('getTopPoolsForToken', async function () {
    const dexHelper = new DummyDexHelper(network);
    const algebra = new Algebra(network, dexKey, dexHelper);

    const poolLiquidity = await algebra.getTopPoolsForToken(TokenA.address, 10);
    console.log(`${TokenASymbol} Top Pools:`, poolLiquidity);

    if (!algebra.hasConstantPriceLargeAmounts) {
      checkPoolsLiquidity(poolLiquidity, TokenA.address, dexKey);
    }
  });
});
