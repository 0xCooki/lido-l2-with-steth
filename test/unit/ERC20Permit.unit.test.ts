import hre, { ethers } from "hardhat";
import { assert } from "chai";
import { BigNumber } from "ethers";
import { unit, UnitTest } from "../../utils/testing";
import { wei } from "../../utils/wei";
import { makeDomainSeparator, signPermit, calculateTransferAuthorizationDigest, signEOAorEIP1271 } from "../../utils/testing/permit-helpers";
import testing from "../../utils/testing";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BaseContract, Overrides } from "@ethersproject/contracts";

import {
  TokenRateOracle__factory,
  OssifiableProxy__factory,
  ERC20RebasableBridgedPermit__factory,
  ERC1271PermitSignerMock__factory,
  ERC20BridgedPermit__factory,

} from "../../typechain";


type ContextType = Awaited<ReturnType<ReturnType<typeof ctxFactoryFactory>>>

const SIGNING_DOMAIN_VERSION = '2'  // aka token version, used in signing permit
const MAX_UINT256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

// derived from mnemonic: want believe mosquito cat design route voice cause gold benefit gospel bulk often attitude rural
const ACCOUNTS_AND_KEYS = [
  {
    address: '0xF4C028683CAd61ff284d265bC0F77EDd67B4e65A',
    privateKey: '0x5f7edf5892efb4a5cd75dedd496598f48e579b562a70eb1360474cc83a982987',
  },
  {
    address: '0x7F94c1F9e4BfFccc8Cd79195554E0d83a0a5c5f2',
    privateKey: '0x3fe2f6bd9dbc7d507a6cb95ec36a36787706617e34385292b66c74cd39874605',
  },
]

function getChainId() {
  return hre.network.config.chainId as number;
}

const getAccountsEOA = async () => {
  return {
    alice: ACCOUNTS_AND_KEYS[0],
    bob: ACCOUNTS_AND_KEYS[1],
  }
}

const getAccountsEIP1271 = async () => {
  const deployer = (await hre.ethers.getSigners())[0]
  const alice = await new ERC1271PermitSignerMock__factory(deployer).deploy()
  const bob = await new ERC1271PermitSignerMock__factory(deployer).deploy()
  return { alice, bob }
}

function permitTestsSuit(unitInstance: UnitTest<ContextType>) {
  unitInstance
    .test('eip712Domain() is correct', async (ctx) => {
      const token = ctx.contracts.rebasableProxied
      const [, name, version, chainId, verifyingContract, ,] = await token.eip712Domain()

      assert.equal(name, ctx.constants.name)
      assert.equal(version, SIGNING_DOMAIN_VERSION)
      assert.isDefined(hre.network.config.chainId)
      assert.equal(chainId.toNumber(), getChainId())
      assert.equal(verifyingContract, token.address)
    })

    .test('DOMAIN_SEPARATOR() is correct', async (ctx) => {
      const token = ctx.contracts.rebasableProxied
      const domainSeparator = makeDomainSeparator(ctx.constants.name, SIGNING_DOMAIN_VERSION, getChainId(), token.address)
      assert.equal(await ctx.contracts.rebasableProxied.DOMAIN_SEPARATOR(), domainSeparator)
    })

    .test('grants allowance when a valid permit is given', async (ctx) => {
      const token = ctx.contracts.rebasableProxied

      const { owner, spender, deadline } = ctx.permitParams
      let { value } = ctx.permitParams
      // create a signed permit to grant Bob permission to spend Alice's funds
      // on behalf, and sign with Alice's key
      let nonce = 0
      const charlie = ctx.accounts.user2

      let { v, r, s } = await signPermit(owner.address, owner, spender.address, value, deadline, nonce, ctx.domainSeparator)

      // check that the allowance is initially zero
      assert.equalBN(await token.allowance(owner.address, spender.address), BigNumber.from(0))
      // check that the next nonce expected is zero
      assert.equalBN(await token.nonces(owner.address), BigNumber.from(0))
      // check domain separator
      assert.equal(await token.DOMAIN_SEPARATOR(), ctx.domainSeparator)

      // a third-party, Charlie (not Alice) submits the permit
      // TODO: handle unpredictable gas limit somehow better than setting it to a random constant
        const tx = await permit(
          token,
          charlie,
          owner.address,
          spender.address,
          value,
          deadline,
          v, r, s,
          ctx.constants.usePermitMethodWithSignature,
          { gasLimit: '0xffffff' }
        );

      // check that allowance is updated
      assert.equalBN(await token.allowance(owner.address, spender.address), BigNumber.from(value))
      await assert.emits(token, tx, 'Approval', [owner.address, spender.address, value])
      assert.equalBN(await token.nonces(owner.address), BigNumber.from(1))


      // increment nonce
      nonce = 1
      value = 4e5
        ; ({ v, r, s } = await signPermit(owner.address, owner, spender.address, value, deadline, nonce, ctx.domainSeparator))

      // submit the permit
      const tx2 = await permit(
        token,
        charlie,
        owner.address,
        spender.address,
        value,
        deadline,
        v, r, s,
        ctx.constants.usePermitMethodWithSignature
      );

      // check that allowance is updated
      assert.equalBN(await token.allowance(owner.address, spender.address), BigNumber.from(value))
      assert.emits(token, tx2, 'Approval', [owner.address, spender.address, BigNumber.from(value)])
      assert.equalBN(await token.nonces(owner.address), BigNumber.from(2))
    })


    .test('reverts if the signature does not match given parameters', async (ctx) => {
      const { owner, spender, value, nonce, deadline } = ctx.permitParams
      const token = ctx.contracts.rebasableProxied
      const charlie = ctx.accounts.user2

      // create a signed permit
      const { v, r, s } = await signPermit(owner.address, owner, spender.address, value, deadline, nonce, ctx.domainSeparator)

      // try to cheat by claiming the approved amount + 1
      await assert.revertsWith(
        permit(token,
          charlie,
          owner.address,
          spender.address,
          value + 1, // pass more than signed value
          deadline,
          v,
          r,
          s,
          ctx.constants.usePermitMethodWithSignature
        ),
        'ErrorInvalidSignature()'
      )

      // check that msg is incorrect even if claim the approved amount - 1
      await assert.revertsWith(
        permit(
          token,
          charlie,
          owner.address,
          spender.address,
          value - 1, // pass less than signed
          deadline,
          v,
          r,
          s,
          ctx.constants.usePermitMethodWithSignature
        ),
        'ErrorInvalidSignature()'
      )
    })

    .test('reverts if the signature is not signed with the right key', async (ctx) => {
      const { owner, spender, value, nonce, deadline } = ctx.permitParams
      const token = ctx.contracts.rebasableProxied
      const spenderSigner = await hre.ethers.getSigner(spender.address)
      const charlie = ctx.accounts.user2

      // create a signed permit to grant Bob permission to spend
      // Alice's funds on behalf, but sign with Bob's key instead of Alice's
      const { v, r, s } = await signPermit(owner.address, spender, spender.address, value, deadline, nonce, ctx.domainSeparator)

      // try to cheat by submitting the permit that is signed by a
      // wrong person
      await assert.revertsWith(
        permit(token, charlie, owner.address, spender.address, value, deadline, v, r, s, ctx.constants.usePermitMethodWithSignature),
        'ErrorInvalidSignature()'
      )

      await testing.impersonate(spender.address)
      await testing.setBalance(spender.address, wei.toBigNumber(wei`10 ether`))

      // even Bob himself can't call permit with the invalid sig
      await assert.revertsWith(
        permit(token, spenderSigner, owner.address, spender.address, value, deadline, v, r, s, ctx.constants.usePermitMethodWithSignature),
        'ErrorInvalidSignature()'
      )
    })

    .test('reverts if the permit is expired', async (ctx) => {
      const token = ctx.contracts.rebasableProxied
      const { owner, spender, value, nonce } = ctx.permitParams
      const charlie = ctx.accounts.user2

      // create a signed permit that already invalid
      const deadline = ((await hre.ethers.provider.getBlock('latest')).timestamp - 1).toString()
      const { v, r, s } = await signPermit(owner.address, owner, spender.address, value, deadline, nonce, ctx.domainSeparator)

      // try to submit the permit that is expired
      await assert.revertsWith(
        permit(token, charlie, owner.address, spender.address, value, deadline, v, r, s, ctx.constants.usePermitMethodWithSignature, { gasLimit: '0xffffff' }),
        'ErrorDeadlineExpired()'
      )

      {
        // create a signed permit that valid for 1 minute (approximately)
        const deadline1min = ((await hre.ethers.provider.getBlock('latest')).timestamp + 60).toString()
        const { v, r, s } = await signPermit(owner.address, owner, spender.address, value, deadline1min, nonce, ctx.domainSeparator)
        const tx = await permit(token, charlie, owner.address, spender.address, value, deadline1min, v, r, s, ctx.constants.usePermitMethodWithSignature)

        assert.equalBN(await token.nonces(owner.address), BigNumber.from(1))
        assert.emits(token, tx, 'Approval', [owner, spender, BigNumber.from(value)])
      }
    })

    .test('reverts if the nonce given does not match the next nonce expected', async (ctx) => {
      const token = ctx.contracts.rebasableProxied
      const { owner, spender, value, deadline } = ctx.permitParams
      const charlie = ctx.accounts.user2
      const nonce = 1
      // create a signed permit
      const { v, r, s } = await signPermit(owner.address, owner, spender.address, value, deadline, nonce, ctx.domainSeparator)
      // check that the next nonce expected is 0, not 1
      assert.equalBN(await token.nonces(owner.address), BigNumber.from(0))

      // try to submit the permit
      await assert.revertsWith(
        permit(token, charlie, owner.address, spender.address, value, deadline, v, r, s, ctx.constants.usePermitMethodWithSignature),
        'ErrorInvalidSignature()'
      )
    })

    .test('reverts if the permit has already been used', async (ctx) => {
      const token = ctx.contracts.rebasableProxied
      const { owner, spender, value, nonce, deadline } = ctx.permitParams
      const charlie = ctx.accounts.user2
      // create a signed permit
      const { v, r, s } = await signPermit(owner.address, owner, spender.address, value, deadline, nonce, ctx.domainSeparator)

      // submit the permit
      await permit(token, charlie, owner.address, spender.address, value, deadline, v, r, s, ctx.constants.usePermitMethodWithSignature)

      // try to submit the permit again
      await assert.revertsWith(
        permit(token, charlie, owner.address, spender.address, value, deadline, v, r, s, ctx.constants.usePermitMethodWithSignature),
        'ErrorInvalidSignature()'
      )

      await testing.impersonate(owner.address)
      await testing.setBalance(owner.address, wei.toBigNumber(wei`10 ether`))

      // try to submit the permit again from Alice herself
      await assert.revertsWith(
        permit(token, await hre.ethers.getSigner(owner.address), owner.address, spender.address, value, deadline, v, r, s, ctx.constants.usePermitMethodWithSignature),
        'ErrorInvalidSignature()'
      )
    })

    .test('reverts if the permit has a nonce that has already been used by the signer', async (ctx) => {
      const token = ctx.contracts.rebasableProxied
      const { owner, spender, value, nonce, deadline } = ctx.permitParams
      const charlie = ctx.accounts.user2
      // create a signed permit
      const permit0 = await signPermit(owner.address, owner, spender.address, value, deadline, nonce, ctx.domainSeparator)

      // submit the permit
      await permit(token, charlie, owner.address, spender.address, value, deadline, permit0.v, permit0.r, permit0.s, ctx.constants.usePermitMethodWithSignature)

      // create another signed permit with the same nonce, but
      // with different parameters
      const permit2 = await signPermit(owner.address, owner, spender.address, 1e6, deadline, nonce, ctx.domainSeparator)

      // try to submit the permit again
      await assert.revertsWith(
        permit(token, charlie, owner.address, spender.address, 1e6, deadline, permit2.v, permit2.r, permit2.s, ctx.constants.usePermitMethodWithSignature),
        'ErrorInvalidSignature()'
      )
    })

    .test('reverts if the permit includes invalid approval parameters', async (ctx) => {
      const token = ctx.contracts.rebasableProxied
      const { owner, value, nonce, deadline } = ctx.permitParams
      const charlie = ctx.accounts.user2
      // create a signed permit that attempts to grant allowance to the
      // zero address
      const spender = hre.ethers.constants.AddressZero
      const { v, r, s } = await signPermit(owner.address, owner, spender, value, deadline, nonce, ctx.domainSeparator)

      // try to submit the permit with invalid approval parameters
      await assert.revertsWith(
        permit(token, charlie, owner.address, spender, value, deadline, v, r, s, ctx.constants.usePermitMethodWithSignature),
        'ErrorAccountIsZeroAddress()'
      )
    })

    .test('reverts if the permit is not for an approval', async (ctx) => {
      const token = ctx.contracts.rebasableProxied
      const charlie = ctx.accounts.user2
      const { owner: from, spender: to, value, deadline: validBefore } = ctx.permitParams
      // create a signed permit for a transfer
      const validAfter = '0'
      const nonce = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      const digest = calculateTransferAuthorizationDigest(
        from.address,
        to.address,
        value,
        validAfter,
        validBefore,
        nonce,
        ctx.domainSeparator
      )
      const { v, r, s } = await signEOAorEIP1271(digest, from)

      // try to submit the transfer permit
      await assert.revertsWith(
        permit(token, charlie, from.address, to.address, value, validBefore, v, r, s, ctx.constants.usePermitMethodWithSignature),
        'ErrorInvalidSignature()'
      )
    })

    .run();
}

function ctxFactoryFactory(
  name: string,
  symbol: string,
  isRebasable: boolean,
  usePermitMethodWithSignature: boolean,
  signingAccountsFuncFactory: typeof getAccountsEIP1271 | typeof getAccountsEOA
) {
  return async () => {
    const decimalsToSet = 18;
    const decimals = BigNumber.from(10).pow(decimalsToSet);
    const tokenRate = BigNumber.from('1164454276599657236000000000');
    const premintShares = wei.toBigNumber(wei`100 ether`);
    const premintTokens = tokenRate.mul(premintShares).div(decimals);

    const [
      deployer,
      owner,
      recipient,
      spender,
      holder,
      stranger,
      user1,
      user2,
      messenger,
      l1TokenRatePusher
    ] = await hre.ethers.getSigners();

    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [hre.ethers.constants.AddressZero],
    });

    const zero = await hre.ethers.getSigner(hre.ethers.constants.AddressZero);

    const rebasableProxied = await tokenProxied(
      name,
      symbol,
      decimalsToSet,
      tokenRate,
      isRebasable,
      messenger.address,
      l1TokenRatePusher.address,
      owner,
      deployer,
      holder
    );

    const { alice, bob } = await signingAccountsFuncFactory();

    return {
      accounts: { deployer, owner, recipient, spender, holder, stranger, zero, user1, user2 },
      constants: { name, symbol, decimalsToSet, decimals, premintShares, premintTokens, tokenRate, usePermitMethodWithSignature },
      contracts: { rebasableProxied },
      permitParams: {
        owner: alice,
        spender: bob,
        value: 6e6,
        nonce: 0,
        deadline: MAX_UINT256,
      },
      domainSeparator: makeDomainSeparator(name, SIGNING_DOMAIN_VERSION, getChainId(), rebasableProxied.address),
    };
  }
}

async function tokenProxied(
  name: string,
  symbol: string,
  decimalsToSet: number,
  tokenRate: BigNumber,
  isRebasable: boolean,
  messenger: string,
  l1TokenRatePusher: string,
  owner: SignerWithAddress,
  deployer: SignerWithAddress,
  holder: SignerWithAddress) {

  if (isRebasable) {
    const wrappedToken = await new ERC20BridgedPermit__factory(deployer).deploy(
      "WstETH Test Token",
      "WstETH",
      SIGNING_DOMAIN_VERSION,
      decimalsToSet,
      owner.address
    );
    const tokenRateOracleImpl = await new TokenRateOracle__factory(deployer).deploy(
      messenger,
      owner.address,
      l1TokenRatePusher,
      86400,
      86400,
      500,
      86400*3,
      3600
    );
    const provider = await hre.ethers.provider;
    const blockNumber = await provider.getBlockNumber();
    const blockTimestamp = (await provider.getBlock(blockNumber)).timestamp;

    const tokenRateOracleProxy = await new OssifiableProxy__factory(
      deployer
    ).deploy(
      tokenRateOracleImpl.address,
      deployer.address,
      tokenRateOracleImpl.interface.encodeFunctionData("initialize", [
        deployer.address,
        tokenRate,
        blockTimestamp
      ])
    );

    const tokenRateOracle = TokenRateOracle__factory.connect(
      tokenRateOracleProxy.address,
      deployer
    );

    const rebasableTokenImpl = await new ERC20RebasableBridgedPermit__factory(deployer).deploy(
      name,
      symbol,
      SIGNING_DOMAIN_VERSION,
      decimalsToSet,
      wrappedToken.address,
      tokenRateOracle.address,
      owner.address
    );

    const l2TokensProxy = await new OssifiableProxy__factory(deployer).deploy(
      rebasableTokenImpl.address,
      deployer.address,
      ERC20RebasableBridgedPermit__factory.createInterface().encodeFunctionData("initialize", [
        name,
        symbol,
        SIGNING_DOMAIN_VERSION
      ])
    );

    const rebasableProxied = ERC20RebasableBridgedPermit__factory.connect(
      l2TokensProxy.address,
      holder
    );

    return rebasableProxied;
  }

  const wrappedToken = await new ERC20BridgedPermit__factory(deployer).deploy(
    name,
    symbol,
    SIGNING_DOMAIN_VERSION,
    decimalsToSet,
    owner.address
  );

  const l2TokensProxy = await new OssifiableProxy__factory(deployer).deploy(
    wrappedToken.address,
    deployer.address,
    ERC20BridgedPermit__factory.createInterface().encodeFunctionData("initialize", [
      name,
      symbol,
      SIGNING_DOMAIN_VERSION
    ])
  );

  const nonRebasableProxied = ERC20BridgedPermit__factory.connect(
    l2TokensProxy.address,
    holder
  );

  return nonRebasableProxied;
}

/// permit with signature parameter
permitTestsSuit(
  unit("ERC20RebasableBridgedPermit with EIP1271 (contract) signing. Uses permit function with signature parameter.",
    ctxFactoryFactory(
      "Liquid staked Ether 2.0",
      "stETH",
      true,
      true,
      getAccountsEIP1271
    )
  )
);

permitTestsSuit(
  unit("ERC20RebasableBridgedPermit with ECDSA (EOA) signing. Uses permit function with signature parameter.",
    ctxFactoryFactory(
      "Liquid staked Ether 2.0",
      "stETH",
      true,
      true,
      getAccountsEOA
    )
  )
);

permitTestsSuit(
  unit("ERC20BridgedPermit with EIP1271 (contract) signing. Uses permit function with signature parameter.",
    ctxFactoryFactory(
      "Wrapped liquid staked Ether 2.0",
      "wstETH",
      false,
      true,
      getAccountsEIP1271
    )
  )
);

permitTestsSuit(
  unit("ERC20BridgedPermit with ECDSA (EOA) signing. Uses permit function with signature parameter.",
    ctxFactoryFactory(
      "Wrapped liquid staked Ether 2.0",
      "WstETH",
      false,
      true,
      getAccountsEOA
    )
  )
);

/// permit with v,r,s params
permitTestsSuit(
  unit("ERC20RebasableBridgedPermit with EIP1271 (contract) signing. Uses permit function with v,r,s params",
    ctxFactoryFactory(
      "Liquid staked Ether 2.0",
      "stETH",
      true,
      false,
      getAccountsEIP1271
    )
  )
);

permitTestsSuit(
  unit("ERC20RebasableBridgedPermit with ECDSA (EOA) signing. Uses permit function with v,r,s params",
    ctxFactoryFactory(
      "Liquid staked Ether 2.0",
      "stETH",
      true,
      false,
      getAccountsEOA
    )
  )
);

permitTestsSuit(
  unit("ERC20BridgedPermit with EIP1271 (contract) signing. Uses permit function with v,r,s params",
    ctxFactoryFactory(
      "Wrapped liquid staked Ether 2.0",
      "wstETH",
      false,
      false,
      getAccountsEIP1271
    )
  )
);

permitTestsSuit(
  unit("ERC20BridgedPermit with ECDSA (EOA) signing. Uses permit function with v,r,s params",
    ctxFactoryFactory(
      "Wrapped liquid staked Ether 2.0",
      "WstETH",
      false,
      false,
      getAccountsEOA
    )
  )
);

async function permit(
  token: BaseContract,
  signer: SignerWithAddress,
  owner: string,
  spender: string,
  value: number,
  deadline: string,
  v: string | number,
  r: string,
  s: string,
  functionWithSignature: boolean,
  overrides: Overrides & { from?: string | Promise<string>} = {}) {
    if(functionWithSignature) {
      const signature = ethers.utils.solidityPack(["bytes32", "bytes32", "uint8"], [r, s, v])
      return await token.connect(signer)["permit(address,address,uint256,uint256,bytes)"](owner, spender, value, deadline, signature, overrides);
    } else {
      return await token.connect(signer)["permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"](owner, spender, value, deadline, v, r, s, overrides);
    }
}
