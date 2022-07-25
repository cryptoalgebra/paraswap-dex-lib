import { Interface, JsonFragment } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import _ from 'lodash';
import {
  Token,
  Address,
  ExchangePrices,
  Log,
  AdapterExchangeParam,
  SimpleExchangeParam,
  PoolLiquidity,
  Logger,
} from '../../types';
import { SwapSide, NULL_ADDRESS, Network } from '../../constants';
import { StatefulEventSubscriber } from '../../stateful-event-subscriber';
import {
  wrapETH,
  getDexKeysWithNetwork,
  isETHAddress,
  prependWithOx,
  WethMap,
} from '../../utils';
import { IDex, IDexTxBuilder } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { Contract } from 'web3-eth-contract';
import {
  AlgebraData,
  PoolState,
  TickState,
  AlgebraParam,
  AlgebraPair,
  AlgebraPoolParam,
} from './types';
import { SimpleExchange } from '../simple-exchange';
import { AlgebraConfig, Adapters } from './config';
import AlgebraRouterABI from '../../abi/AlgebraRouter.json';
import AlgebraPoolABI from '../../abi/AlgebraRouter.json';
import AlgebraFactoryABI from '../../abi/AlgebraFactory.json';
import { nextTick } from 'process';
import { TickMath } from './tickMath';
import { SqrtPriceMath } from './sqrtPriceMath';
import { SwapMath } from './swapMath';
import { ZERO } from './internalConstants';
const MAX_TRACKED_POOLS = 1000;

const ALGEBRA_ROUTER_ADDRESS: { [network: number]: Address } = {
  137: '0x89D6B81A1Ef25894620D05ba843d83B0A296239e',
};

const subgraphTimeout = 1000 * 10;

enum AlgebraFunctions {
  exactInputSingle = 'exactInputSingle',
  exactOutputSingle = 'exactOutputSingle',
}

const interface = new Interface(AlgebraPoolABI);

export class AlgebraEventPool extends StatefulEventSubscriber<PoolState> {
  handlers: {
    [event: string]: (event: any, pool: PoolState, log: Log) => PoolState;
  } = {};

  logDecoder: (log: Log) => any;

  addressesSubscribed: string[];

  constructor(
    protected parentName: string,
    protected network: number,
    protected subgraphURL: string,
    protected dexHelper: IDexHelper,
    protected poolAddress: Address,
    protected token0: Token,
    protected token1: Token,
    logger: Logger,
  ) {
    super(
      parentName +
        ' ' +
        (token0.symbol || token0.address) +
        '-' +
        (token1.symbol || token1.address) +
        ' pool',
      logger,
    );

    this.logDecoder = (log: Log) => interface.parseLog(log);

    this.handlers['Swap'] = this.handleSwap.bind(this);
    this.handlers['ChangeFee'] = this.handleChangeFee.bind(this);
    this.handlers['Burn'] = this.handleBurn.bind(this);
    this.handlers['Mint'] = this.handleMint.bind(this);
    this.handlers['Initialize'] = this.handleInitialize.bind(this);
  }

  /**
   * The function is called everytime any of the subscribed
   * addresses release log. The function accepts the current
   * state, updates the state according to the log, and returns
   * the updated state.
   * @param state - Current state of event subscriber
   * @param log - Log released by one of the subscribed addresses
   * @returns Updates state of the event subscriber after the log
   */
  protected processLog(
    state: DeepReadonly<PoolState>,
    log: Readonly<Log>,
  ): DeepReadonly<PoolState> | null {
    try {
      const event = this.logDecoder(log);
      if (event.name in this.handlers) {
        return this.handlers[event.name](event, state, log);
      }
      return state;
    } catch (e) {
      this.logger.error(
        `Error_${this.parentName}_processLog could not parse the log with topic ${log.topics}:`,
        e,
      );
      return null;
    }
  }

  handleSwap(event: any, pool: PoolState, log: Log): PoolState {
    pool.currentTick = event.arg.tick;
    pool.currentLiquidity = event.arg.liquidity;
    return pool;
  }

  handleChangeFee(event: any, pool: PoolState, log: Log): PoolState {
    pool.fee = event.args.Fee;
    return pool;
  }

  getTickIdx(tick: number, ticks: TickState[]): number {
    let left: number = 0;
    let right: number = ticks.length - 1;

    while (left <= right) {
      const mid: number = Math.floor((left + right) / 2);

      if (ticks[mid].tickIdx === tick) return mid;
      if (tick < ticks[mid].tickIdx) right = mid - 1;
      else left = mid + 1;
    }

    return -1;
  }

  handleBurn(event: any, pool: PoolState, log: Log): PoolState {
    const burntLiquidity = BigInt(event.args.amount.toString());
    const bottomTick = event.args.bottomTick;
    const topTick = event.args.topTick;
    const bottomTickIdx = this.getTickIdx(bottomTick, pool.ticks);
    const topTickIdx = this.getTickIdx(topTick, pool.ticks);
    if (pool.ticks[bottomTickIdx].upper) {
      pool.ticks[bottomTickIdx].liquidityDelta += burntLiquidity;
    } else {
      pool.ticks[bottomTickIdx].liquidityDelta -= burntLiquidity;
    }
    if (pool.ticks[topTickIdx].upper) {
      pool.ticks[topTickIdx].liquidityDelta -= burntLiquidity;
    } else {
      pool.ticks[topTickIdx].liquidityDelta += burntLiquidity;
    }

    if (pool.ticks[bottomTickIdx].liquidityDelta == BigInt('0')) {
      pool.ticks.slice(bottomTickIdx, 1);
    }
    if (pool.ticks[topTickIdx].liquidityDelta == BigInt('0')) {
      pool.ticks.slice(topTickIdx, 1);
    }
    if (pool.currentTick < topTick && pool.currentTick > bottomTick) {
      pool.currentLiquidity -= burntLiquidity;
    }
    return pool;
  }

  handleMint(event: any, pool: PoolState, log: Log): PoolState {
    const addedLiquidity = BigInt(event.args.amount.toString());
    const bottomTick = event.args.bottomTick;
    const topTick = event.args.topTick;
    const bottomTickIdx = this.getTickIdx(bottomTick, pool.ticks);
    const topTickIdx = this.getTickIdx(topTick, pool.ticks);
    if (bottomTickIdx == -1) {
      pool.ticks.push(bottomTick);
    } else {
      if (pool.ticks[bottomTickIdx].upper) {
        pool.ticks[bottomTickIdx].liquidityDelta -= addedLiquidity;
      } else {
        pool.ticks[bottomTickIdx].liquidityDelta += addedLiquidity;
      }
    }
    if (topTickIdx == -1) {
      pool.ticks.push(topTick);
    } else {
      if (pool.ticks[topTickIdx].upper) {
        pool.ticks[topTickIdx].liquidityDelta += addedLiquidity;
      } else {
        pool.ticks[topTickIdx].liquidityDelta -= addedLiquidity;
      }
    }
    pool.ticks.sort(function (a, b) {
      return a.tickIdx - b.tickIdx;
    });
    if (pool.currentTick < topTick && pool.currentTick > bottomTick) {
      pool.currentLiquidity += addedLiquidity;
    }
    return pool;
  }

  handleInitialize(event: any, pool: PoolState, log: Log): PoolState {
    pool.fee = 500;
    pool.currentTick = event.args.tick;
    return pool;
  }

  /**
   * The function generates state using on-chain calls. This
   * function is called to regenrate state if the event based
   * system fails to fetch events and the local state is no
   * more correct.
   * @param blockNumber - Blocknumber for which the state should
   * should be generated
   * @returns state of the event subsriber at blocknumber
   */
  async generateState(blockNumber: number): Promise<Readonly<PoolState>> {
    if (!this.subgraphURL) return;

    const fetchTickDataQuery = `query allV3Ticks($poolAddress: String!, $block: Int) {
      ticks(block:{number: $block}, first: 1000, where: { poolAddress: $poolAddress, liquidity_gt: 0 }, orderBy: tickIdx) {
        tickIdx
        liquidityNet
        price0
        price1
        upper
      }
      pools(block:{number: $block}, where: { poolAddress: $poolAddress}) {
        token0
        token1
        fee
        liquidity
        tick
      }
    }`;

    const { data } = await this.dexHelper.httpRequest.post(
      this.subgraphURL,
      {
        fetchTickDataQuery,
        variables: {
          poolAddress: this.poolAddress.toLowerCase(),
          block: blockNumber,
        },
      },
      subgraphTimeout,
    );

    if (!(data && data.pools && data.ticks))
      throw new Error("Couldn't fetch the pools from the subgraph");

    let ticks: TickState[];
    for (let i = 0; i < data.ticks.length; i++) {
      ticks.push({
        tickIdx: data.ticks[i].tickIdx,
        liquidityDelta: data.ticks[i].liquidityNet,
        upper: data.ticks[i].upper,
      });
    }

    let pool: PoolState = {
      ticks: ticks,
      currentTick: data.pools[0].tick,
      currentLiquidity: data.pools[0].liquidity,
      fee: data.pools[0].fee,
    };

    return pool;
  }
}

export class Algebra
  extends SimpleExchange
  implements IDex<AlgebraData, AlgebraParam>
{
  pairs: { [key: string]: AlgebraPair } = {};

  readonly hasConstantPriceLargeAmounts = false;
  factory: Contract;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(AlgebraConfig);
  static dexKeys = ['algebra'];

  exchangeRouterInterface: Interface;
  needWrapNative = true;

  logger: Logger;

  constructor(
    protected network: Network,
    protected dexKey: string,
    protected dexHelper: IDexHelper,
    protected adapters = Adapters[network],
    protected router = router[network],
    protected subgraphURL: string = AlgebraConfig[dexKey][network].subgraphURL,
    protected initCode: string = AlgebraConfig[dexKey][network].initCode,
    protected factoryAddress: Address = AlgebraConfig[dexKey][network]
      .factoryAddress, // TODO: add any additional optional params to support other fork DEXes
  ) {
    super(dexHelper.augustusAddress, dexHelper.provider);
    this.logger = dexHelper.getLogger(dexKey);
    this.exchangeRouterInterface = new Interface(
      AlgebraRouterABI as JsonFragment[],
    );
    this.factory = new dexHelper.web3Provider.eth.Contract(
      AlgebraFactoryABI as any,
      factoryAddress,
    );
  }

  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return this.adapters;
  }

  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    const from = wrapETH(srcToken, this.network);
    const to = wrapETH(destToken, this.network);

    if (from.address.toLowerCase() === to.address.toLowerCase()) {
      return [];
    }

    const tokenAddress = [from.address.toLowerCase(), to.address.toLowerCase()]
      .sort((a, b) => (a > b ? 1 : -1))
      .join('_');

    const poolIdentifier = `${this.dexKey}_${tokenAddress}`;
    return [poolIdentifier];
  }

  async getBuyPrice(poolState: PoolState, destAmount: bigint): Promise<bigint> {
    const { currentTick, currentLiquidity, fee, ticks } = poolState;
    const amountIn = destAmount;
    let amountOut = ZERO;
    while (destAmount > 0) {
      let sqrtRatioCurrentX96 = TickMath.getSqrtRatioAtTick(currentTick);
      let sqrtRatioTargetX96 = SqrtPriceMath.getNextSqrtPriceFromInput;
      const [sqrtPrice, stepAmountIn, stepAmountOut] = SwapMath.computeSwapStep(
        sqrtRatioCurrentX96,
        sqrtRatioTargetX96,
        currentLiquidity,
        destAmount,
        fee,
      );
      destAmount -= stepAmountIn;
      sqrtRatioCurrentX96 = sqrtPrice;
      amountOut += stepAmountOut;
    }

    return amountIn / amountOut;
  }

  async getSellPrice(poolState: PoolState, srcAmount: bigint): Promise<bigint> {
    const { currentTick, currentLiquidity, fee, ticks } = poolState;
    const amountIn = srcAmount;
    let amountOut = ZERO;
    while (srcAmount > 0) {
      let sqrtRatioCurrentX96 = TickMath.getSqrtRatioAtTick(currentTick);
      let sqrtRatioTargetX96 = SqrtPriceMath.getNextSqrtPriceFromInput;
      const [sqrtPrice, stepAmountIn, stepAmountOut] = SwapMath.computeSwapStep(
        sqrtRatioCurrentX96,
        sqrtRatioTargetX96,
        currentLiquidity,
        destAmount,
        fee,
      );
      srcAmount -= stepAmountIn;
      sqrtRatioCurrentX96 = sqrtPrice;
      amountOut += stepAmountOut;
    }

    return amountIn / amountOut;
  }

  private async findPair(from: Token, to: Token) {
    if (from.address.toLowerCase() === to.address.toLowerCase()) return null;
    const [token0, token1] =
      from.address.toLowerCase() < to.address.toLowerCase()
        ? [from, to]
        : [to, from];

    await this.addPoolIfNeccesary();
    const key = `${token0.address.toLowerCase()}-${token1.address.toLowerCase()}`;
    let pair = this.pairs[key];
    if (pair) return pair;
    const exchange = await this.factory.methods
      .getPair(token0.address, token1.address)
      .call();
    if (exchange === NULL_ADDRESS) {
      pair = { token0, token1 };
    } else {
      pair = { token0, token1, exchange };
    }
    this.pairs[key] = pair;
    return pair;
  }

  private async addPoolIfNeccesary(pair: AlgebraPair, blockNumber: number) {}

  async getPairState(
    from: Token,
    to: Token,
    blockNumber: number,
  ): Promise<AlgebraPoolParam | null> {}

  // Returns pool prices for amounts.
  // If limitPools is defined only pools in limitPools
  // should be used. If limitPools is undefined then
  // any pools can be used.
  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<AlgebraData>> {
    try {
      const from = wrapETH(srcToken, this.network);
      const to = wrapETH(destToken, this.network);

      if (from.address.toLowerCase() === to.address.toLowerCase()) {
        return null;
      }

      const tokenAddress = [
        from.address.toLowerCase(),
        to.address.toLowerCase(),
      ]
        .sort((a, b) => (a > b ? 1 : -1))
        .join('_');

      const poolIdentifier = `${this.dexKey}_${tokenAddress}`;

      if (limitPools && limitPools.every(p => p !== poolIdentifier))
        return null;

      const pairParam = await this.getPairState(from, to, blockNumber);

      if (!pairParam) return null;

      const unitAmount = getBigIntPow(
        side == SwapSide.BUY ? to.decimals : from.decimals,
      );
      const unit =
        side == SwapSide.BUY
          ? await this.getBuyPrice(pairParam, unitAmount)
          : await this.getSellPrice(pairParam, unitAmount);

      if (!unit) return null;

      const prices =
        side == SwapSide.BUY
          ? await Promise.all(
              amounts.map(amount => this.getBuyPrice(pairParam, amount)),
            )
          : await Promise.all(
              amounts.map(amount => this.getSellPrice(pairParam, amount)),
            );

      // As Algebra just has one pool per token pair
      return [
        {
          prices: prices,
          unit: unit,
          data: {
            router: this.router,
            path: [from.address.toLowerCase(), to.address.toLowerCase()],
            factory: this.factoryAddress,
            initCode: this.initCode,
            pools: [
              {
                address: pairParam.exchange,
                fee: parseInt(pairParam.fee),
                direction: pairParam.direction,
              },
            ],
          },
          exchange: this.dexKey,
          poolIdentifier,
          gasCost: this.poolGasCost,
          poolAddresses: [pairParam.exchange],
        },
      ];
    } catch (e) {
      if (blockNumber === 0)
        this.logger.error(
          `Error_getPricesVolume: Aurelius block manager not yet instantiated`,
        );
      this.logger.error(`Error_getPrices:`, e);
      return null;
    }
  }

  // Encode params required by the exchange adapter
  // Used for multiSwap, buy & megaSwap
  // Hint: abiCoder.encodeParameter() couls be useful
  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: AlgebraData,
    side: SwapSide,
  ): AdapterExchangeParam {
    const { fee, deadline, sqrtPriceLimitX96 } = data;
    const payload = this.abiCoder.encodeParameter(
      {
        ParentStruct: {
          deadline: 'uint256',
          sqrtPriceLimitX96: 'uint160',
        },
      },
      {
        deadline: deadline || this.getDeadline(),
        sqrtPriceLimitX96: sqrtPriceLimitX96 || 0,
      },
    );

    return {
      targetExchange: ALGEBRA_ROUTER_ADDRESS[this.network], // warning
      payload,
      networkFee: '0', // warning
    };
  }

  // Encode call data used by simpleSwap like routers
  // Used for simpleSwap & simpleBuy
  // Hint: this.buildSimpleParamWithoutWETHConversion
  // could be useful
  async getSimpleParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: AlgebraData,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    const swapFunction =
      side === SwapSide.SELL
        ? AlgebraFunctions.exactInputSingle
        : AlgebraFunctions.exactOutputSingle;
    const swapFunctionParams: AlgebraParam =
      side === SwapSide.SELL
        ? {
            tokenIn: srcToken,
            tokenOut: destToken,
            fee: data.fee,
            recipient: this.augustusAddress,
            deadline: data.deadline || this.getDeadline(),
            amountIn: srcAmount,
            amountOutMinimum: destAmount,
            sqrtPriceLimitX96: data.sqrtPriceLimitX96 || '0',
          }
        : {
            tokenIn: srcToken,
            tokenOut: destToken,
            fee: data.fee,
            recipient: this.augustusAddress,
            deadline: data.deadline || this.getDeadline(),
            amountOut: destAmount,
            amountInMaximum: srcAmount,
            sqrtPriceLimitX96: data.sqrtPriceLimitX96 || '0',
          };
    const swapData = this.exchangeRouterInterface.encodeFunctionData(
      swapFunction,
      [swapFunctionParams],
    );

    return this.buildSimpleParamWithoutWETHConversion(
      srcToken,
      srcAmount,
      destToken,
      destAmount,
      swapData,
      ALGEBRA_ROUTER_ADDRESS[this.network], // warning
    );
  }

  // Returns list of top pools based on liquidity. Max
  // limit number pools should be returned.
  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    if (!this.subgraphURL) return [];

    const query = `
      query ($token: Bytes!, $count: Int) {
        pools0: pools(first: $count, orderBy: totalValueLockedUSD, orderDirection: desc, where: {token0: $token, liquidity_gt: 0}) {
        id
        token0 {
          id
          decimals
        }
        token1 {
          id
          decimals
        }
        totalValueLockedUSD
      }
      pools1: pools(first: $count, orderBy: totalValueLockedUSD, orderDirection: desc, where: {token1: $token, liquidity_gt: 0}) {
        id
        token0 {
          id
          decimals
        }
        token1 {
          id
          decimals
        }
        totalValueLockedUSD
      }
    }`;

    const { data } = await this.dexHelper.httpRequest.post(
      this.subgraphURL,
      {
        query,
        variables: { token: tokenAddress.toLowerCase(), limit },
      },
      subgraphTimeout,
    );

    if (!(data && data.pools0 && data.pools1))
      throw new Error("Couldn't fetch the pools from the subgraph");

    const pools0 = _.map(data.pools0, pool => ({
      exchange: this.dexKey,
      address: pool.id.toLowerCase(),
      connectorTokens: [
        {
          address: pool.token1.id.toLowerCase(),
          decimals: parseInt(pool.token1.decimals),
        },
      ],
      liquidityUSD: parseFloat(pool.totalValueLockedUSD),
    }));

    const pools1 = _.map(data.pools1, pool => ({
      exchange: this.dexKey,
      address: pool.id.toLowerCase(),
      connectorTokens: [
        {
          address: pool.token0.id.toLowerCase(),
          decimals: parseInt(pool.token0.decimals),
        },
      ],
      liquidityUSD: parseFloat(pool.totalValueLockedUSD),
    }));

    const pools = _.slice(
      _.sortBy(_.concat(pools0, pools1), [pool => -1 * pool.liquidityUSD]),
      0,
      limit,
    );

    return pools;
  }
}
