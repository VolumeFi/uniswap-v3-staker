import { ethers, waffle } from 'hardhat'
import { BigNumber } from 'ethers'
import { Fixture } from 'ethereum-waffle'
import { expect } from './shared'
import { UniswapV3Staker } from '../typechain/UniswapV3Staker'
import type { IUniswapV3Pool, TestERC20, IUniswapV3Factory } from '../typechain'
import { MockTimeUniswapV3Pool } from '../typechain/MockTimeUniswapV3Pool'
import { MockTimeUniswapV3PoolDeployer } from '../typechain/MockTimeUniswapV3PoolDeployer'
import { completeFixture } from './shared/fixtures'
import {
  expandTo18Decimals,
  FeeAmount,
  getPositionKey,
  getMaxTick,
  getMinTick,
  encodePriceSqrt,
  TICK_SPACINGS,
  createPoolFunctions,
  SwapFunction,
  MintFunction,
  getMaxLiquidityPerTick,
  FlashFunction,
  MaxUint128,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  SwapToPriceFunction,
} from './shared/utilities'

type UniswapV3Factory = any
type UniswapNFT = any

const { createFixtureLoader } = waffle
let loadFixture: ReturnType<typeof createFixtureLoader>

interface TokensFixture {
  token0: TestERC20
  token1: TestERC20
  token2: TestERC20
}

async function tokensFixture(): Promise<TokensFixture> {
  const tokenFactory = await ethers.getContractFactory('TestERC20')
  const tokenA = (await tokenFactory.deploy(
    BigNumber.from(2).pow(255)
  )) as TestERC20
  const tokenB = (await tokenFactory.deploy(
    BigNumber.from(2).pow(255)
  )) as TestERC20
  const tokenC = (await tokenFactory.deploy(
    BigNumber.from(2).pow(255)
  )) as TestERC20

  const [token0, token1, token2] = [
    tokenA,
    tokenB,
    tokenC,
  ].sort((tokenA, tokenB) =>
    tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? -1 : 1
  )

  return { token0, token1, token2 }
}

import { TestUniswapV3Callee } from '../typechain/TestUniswapV3Callee'
import { TestUniswapV3Router } from '../typechain/TestUniswapV3Router'
interface FactoryFixture {
  factory: UniswapV3Factory
}
async function factoryFixture(): Promise<FactoryFixture> {
  const factoryFactory = await ethers.getContractFactory('UniswapV3Factory')
  const factory = (await factoryFactory.deploy()) as UniswapV3Factory
  return { factory }
}

type TokensAndFactoryFixture = FactoryFixture & TokensFixture
interface PoolFixture extends TokensAndFactoryFixture {
  swapTargetCallee: TestUniswapV3Callee
  swapTargetRouter: TestUniswapV3Router
  createPool(
    fee: number,
    tickSpacing: number,
    firstToken?: TestERC20,
    secondToken?: TestERC20
  ): Promise<MockTimeUniswapV3Pool>
}

export const poolFixture: Fixture<PoolFixture> = async function (): Promise<PoolFixture> {
  const { factory } = await factoryFixture()
  const { token0, token1, token2 } = await tokensFixture()

  const MockTimeUniswapV3PoolDeployerFactory = await ethers.getContractFactory(
    'MockTimeUniswapV3PoolDeployer'
  )
  const MockTimeUniswapV3PoolFactory = await ethers.getContractFactory(
    'MockTimeUniswapV3Pool'
  )

  const calleeContractFactory = await ethers.getContractFactory(
    'TestUniswapV3Callee'
  )
  const routerContractFactory = await ethers.getContractFactory(
    'TestUniswapV3Router'
  )

  const swapTargetCallee = (await calleeContractFactory.deploy()) as TestUniswapV3Callee
  const swapTargetRouter = (await routerContractFactory.deploy()) as TestUniswapV3Router

  return {
    token0,
    token1,
    token2,
    factory,
    swapTargetCallee,
    swapTargetRouter,
    createPool: async (
      fee,
      tickSpacing,
      firstToken = token0,
      secondToken = token1
    ) => {
      const mockTimePoolDeployer = (await MockTimeUniswapV3PoolDeployerFactory.deploy()) as MockTimeUniswapV3PoolDeployer
      const tx = await mockTimePoolDeployer.deploy(
        factory.address,
        firstToken.address,
        secondToken.address,
        fee,
        tickSpacing
      )

      const receipt = await tx.wait()
      const poolAddress = receipt.events?.[0].args?.pool as string
      return MockTimeUniswapV3PoolFactory.attach(
        poolAddress
      ) as MockTimeUniswapV3Pool
    },
  }
}

describe('UniswapV3Staker', () => {
  const wallets = waffle.provider.getWallets()
  const [wallet, ...otherWallets] = wallets

  let factory: UniswapV3Factory
  let nft: UniswapNFT
  let staker: UniswapV3Staker
  let rewardToken

  let token0: TestERC20
  let token1: TestERC20
  let token2: TestERC20

  let pool: MockTimeUniswapV3Pool

  let swapTarget: TestUniswapV3Callee

  let swapToLowerPrice: SwapToPriceFunction
  let swapToHigherPrice: SwapToPriceFunction
  let swapExact0For1: SwapFunction
  let swap0ForExact1: SwapFunction
  let swapExact1For0: SwapFunction
  let swap1ForExact0: SwapFunction

  let feeAmount: number
  let tickSpacing: number

  let minTick: number
  let maxTick: number

  let mint: MintFunction
  let flash: FlashFunction

  let loadFixture: ReturnType<typeof createFixtureLoader>
  // let createPool: ThenArg<ReturnType<typeof poolFixture>>['createPool']
  let createPool

  const uniswapFixture: Fixture<{
    factory: UniswapV3Factory
    nft: UniswapNFT
  }> = async (wallets, provider) => {
    return await completeFixture(wallets, provider)
  }

  before('create fixture loader', async () => {
    loadFixture = createFixtureLoader(wallets)
    ;({ factory, nft } = await loadFixture(uniswapFixture))
  })

  beforeEach('deploy fixture', async () => {
    ;({
      token0,
      token1,
      token2,
      factory,
      createPool,
      swapTargetCallee: swapTarget,
    } = await loadFixture(poolFixture))

    const oldCreatePool = createPool
    createPool = async (_feeAmount, _tickSpacing) => {
      const pool = await oldCreatePool(_feeAmount, _tickSpacing)
      ;({
        swapToLowerPrice,
        swapToHigherPrice,
        swapExact0For1,
        swap0ForExact1,
        swapExact1For0,
        swap1ForExact0,
        mint,
        flash,
      } = createPoolFunctions({
        token0,
        token1,
        swapTarget,
        pool,
      }))
      minTick = getMinTick(_tickSpacing)
      maxTick = getMaxTick(_tickSpacing)
      feeAmount = _feeAmount
      tickSpacing = _tickSpacing
      return pool
    }

    // default to the 30 bips pool
    pool = await createPool(FeeAmount.MEDIUM, TICK_SPACINGS[FeeAmount.MEDIUM])
  })

  describe('#initialize', async () => {
    it('deploys', async () => {
      const stakerFactory = await ethers.getContractFactory('UniswapV3Staker')
      staker = (await stakerFactory.deploy(
        factory.address,
        nft.address
      )) as UniswapV3Staker
      expect(staker.address).to.be.a.string
    })
  })

  describe('#createIncentive', async () => {
    describe('happy path', () => {
      it('transfers the right amount of rewardToken', async () => {
        // staker.createIncentive()
      })
      it('emits IncentiveCreated()')
    })
    describe('should fail if', () => {
      it('already has an incentive with those params')
      it('claim deadline not gte end time')
      it('end time not gte start time')
      it('rewardToken is 0 address')
      it('totalReward is 0 or an invalid amount')
      it('rewardToken cannot be transferred')
      // Maybe: it('fails if maybe: fails if pool is not a uniswap v3 pool?')
    })
  })

  describe('#endIncentive', async () => {
    describe('should fail if ', () => {
      it('block.timestamp <= claim deadline')
      it('incentive does not exist')
    })
    describe('works and', () => {
      it('deletes incentives[key]')
      it('deletes even if the transfer fails (re-entrancy vulnerability check)')
    })
  })

  describe('_getIncentiveId', () => {
    it('test various inputs')
  })

  describe('#depositToken', () => {
    describe('that are successful', () => {
      it('emit a Deposited event')
      it('actually transfers the NFT to the contract')
      it('respond to the onERC721Received function')
      it('creates deposits[tokenId] = Deposit struct')
      describe('deposit struct', () => {
        it('numberOfStakes is 0')
        it('owner is msg.sender')
      })
    })

    describe('that fail', () => {
      it('does not emit an event')
      it('does not create a deposit struct in deposits')
    })

    describe('paranoia edge cases', () => {
      /*
      Other possible cases to consider:
        * What if make nft.safeTransferFrom is adversarial in some way?
        * What happens if the nft.safeTransferFrom call fails
        * What if tokenId is invalid
        * What happens if I call deposit() twice with the same tokenId?
        * Ownership checks around tokenId? Can you transfer something that is not yours?

      */
    })
  })

  describe('#withdrawToken', () => {
    describe('happy path', () => {
      it('emits a withdrawal event')
      it('does the safeTransferFrom and transfers ownership')
      it('prevents you from withdrawing twice')
    })
    /*
    Consider:
      you cannot withdraw a token if
        it is not yours
        number of stakes != 0
      paranoia:
        could there be something insecure in nonfungiblePositionManager.ownerOf(tokenId)?
        delegate calls to withdraw?
        it goes through even if the NFT is janky / invalid / adversarial
      */
  })

  describe('#stakeToken', () => {
    /*
    happy path
      it sets the Stake struct inside of stakes
        the Stake.secondsPerLiquidity is set correctly
        the pool address is saved on the stake
      it is done on the right tokenId,incentiveId
      numberOfStakes is incremented by 1
    you cannot stake if
      you are not the owner of the deposit
    paranoia:
      what if it's
        before the start time
        after endTime?
        past the claimDeadline?
        the specified params are incorrect and
          the pool doesn't exist
          the pool exists but something else is fishy
        the NFT is adversarial
      */
  })

  describe('#unstakeToken', () => {
    /*
    checks that
      you are the owner of the deposit
      there exists a stake for that key
      there is non-zero secondsPerLiquidity
    effects:
      decrements numberOfStakes by 1
      it transfers the right amoutn of the reward token
      calculations
        it gets the right secondsPerLiquidity
        totalSecondsUnclaimed
          doesn't overflow
          check the math everywhere
        it emits an Unstaked() event
      you cannt unstake if
        you have not staked
      paranoia:
        what if reward cannot be transferred
        what if it's a big number and we risk overflowing
    */
  })

  describe('#getPositionDetails', () => {
    it('gets called on the nonfungiblePositionManager')
    it('the PoolKey is correct')
    it('the correct address is computed')
    it('the ticks are correct')
    it('the liquidity number is correct')
  })
})
