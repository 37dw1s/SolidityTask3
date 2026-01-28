import { expect } from "chai";
import { ZeroAddress } from "ethers";
import hre from "hardhat";

const { ethers, networkHelpers } = await hre.network.connect();

describe("AuctionMarketV2 (Unit)", function () {
  async function deployV1ProxyFixture() {
    const [deployer, seller, bidder1, bidder2] = await ethers.getSigners();

    // Deploy mocks
    const MockV3 = await ethers.getContractFactory("MockV3Aggregator");
    // ETH/USD: decimals=8, price = 3000 * 1e8
    const ethFeed = await MockV3.deploy(8, 3000n * 10n ** 8n);
    await ethFeed.waitForDeployment();
    // USDC/USD: decimals=8, price = 1 * 1e7
    const usdcFeed = await MockV3.deploy(8, 1n * 10n ** 7n);
    await usdcFeed.waitForDeployment();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const MockNFT = await ethers.getContractFactory("MockNFT");
    const nft = await MockNFT.deploy();
    await nft.waitForDeployment();

    // Deploy AuctionMarket
    const AuctionMarket = await ethers.getContractFactory("AuctionMarket");
    const marketV1 = await AuctionMarket.deploy();
    await marketV1.waitForDeployment();

    // Encode initialize call
    const initializeCall = marketV1.interface.encodeFunctionData(
      "initialize",
      [250], // 2.5% platform fee
    );

    //Deploy ERC1967Proxy
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967ProxyWrapper");
    const proxy = await ERC1967Proxy.deploy(marketV1.target, initializeCall);
    await proxy.waitForDeployment();

    // Attach market to proxy
    const proxiedMarket = AuctionMarket.attach(proxy.target);

    // Set local testing price feeds
    await proxiedMarket.setPriceFeed(ZeroAddress, ethFeed.target);
    await proxiedMarket.setPriceFeed(await usdc.getAddress(), usdcFeed.target);

    return {
      deployer,
      seller,
      bidder1,
      bidder2,
      ethFeed,
      usdcFeed,
      usdc,
      nft,
      marketV1,

      proxy,
      proxiedMarket,
    };
  }

  it("should keep state after upgrade; non-owner cannot upgrade", async () => {
    const {
      deployer,
      seller,
      bidder1,
      bidder2,
      usdc,
      nft,
      proxiedMarket,
      proxy,
    } = await networkHelpers.loadFixture(deployV1ProxyFixture);

    const DURATION = 10;

    // create USDC auction and generate some state: highestBid + pendingWithdrawals
    await nft.mint(seller.address);
    await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);

    await proxiedMarket
      .connect(seller)
      .createAuction(
        await nft.getAddress(),
        0,
        ethers.parseEther("1000"),
        DURATION,
        await usdc.getAddress(),
      );

    await usdc.transfer(bidder1.address, ethers.parseEther("5000"));
    await usdc.transfer(bidder2.address, ethers.parseEther("5000"));

    await usdc
      .connect(bidder1)
      .approve(await proxiedMarket.getAddress(), ethers.parseEther("1100"));
    await proxiedMarket
      .connect(bidder1)
      .bid(1, await usdc.getAddress(), ethers.parseEther("1100"));

    await usdc
      .connect(bidder2)
      .approve(await proxiedMarket.getAddress(), ethers.parseEther("1200"));
    await proxiedMarket
      .connect(bidder2)
      .bid(1, await usdc.getAddress(), ethers.parseEther("1200"));

    const pendingBefore = await proxiedMarket.pendingWithdrawals(
      bidder1.address,
      await usdc.getAddress(),
    );
    expect(pendingBefore).to.eq(ethers.parseEther("1100"));

    const aBefore = await proxiedMarket.getAuction(1);
    expect(aBefore.highestBidder).to.eq(bidder2.address);
    expect(aBefore.highestBid).to.eq(ethers.parseEther("1200"));

    // deploy V2 impl
    const AuctionMarketV2 = await ethers.getContractFactory("AuctionMarketV2");
    const marketV2 = await AuctionMarketV2.deploy();
    await marketV2.waitForDeployment();

    // non-owner upgrade should revert
    const proxiedMarketV2Invalid = AuctionMarketV2.attach(proxy.target);
    const emptyData = "0x";

    await expect(
      proxiedMarketV2Invalid
        .connect(bidder1)
        .upgradeToAndCall(marketV2.target, emptyData),
    ).to.be.revertedWithCustomError(
      proxiedMarketV2Invalid,
      "OwnableUnauthorizedAccount",
    );

    // owner upgrades
    const proxiedMarketV2 = AuctionMarketV2.attach(proxy.target);
    await (
      await proxiedMarketV2
        .connect(deployer)
        .upgradeToAndCall(marketV2.target, emptyData)
    ).wait();

    // state should remain
    const pendingAfter = await proxiedMarketV2.pendingWithdrawals(
      bidder1.address,
      await usdc.getAddress(),
    );
    expect(pendingAfter).to.eq(ethers.parseEther("1100"));

    const aAfter = await proxiedMarketV2.getAuction(1);
    expect(aAfter.highestBidder).to.eq(bidder2.address);
    expect(aAfter.highestBid).to.eq(ethers.parseEther("1200"));

    // finalize still works after upgrade
    await networkHelpers.time.increase(DURATION + 1);
    await proxiedMarketV2.finalizeAuction(1);

    expect(await nft.ownerOf(0)).to.eq(bidder2.address);
  });

  it("should returns V2", async () => {
    const AuctionMarketV2 = await ethers.getContractFactory("AuctionMarketV2");
    const v2 = await AuctionMarketV2.deploy();
    expect(await v2.version()).to.eq("V2");
  });
});
