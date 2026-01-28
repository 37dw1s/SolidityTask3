import { expect } from "chai";
import { ZeroAddress } from "ethers";
import hre from "hardhat";

const { ethers, networkHelpers } = await hre.network.connect();

describe("AuctionMarket (Integration)", function () {
  async function deployFixture() {
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
    const market = await AuctionMarket.deploy();
    await market.waitForDeployment();

    // Encode initialize call
    const initializeCall = AuctionMarket.interface.encodeFunctionData(
      "initialize",
      [250], // 2.5% platform fee
    );
    //Deploy ERC1967Proxy
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967ProxyWrapper");
    const proxy = await ERC1967Proxy.deploy(market.target, initializeCall);
    await proxy.waitForDeployment();

    // Attach AuctionMarket interface to proxy address
    const proxiedMarket = AuctionMarket.attach(proxy.target);

    // Set local testing price feeds
    await proxiedMarket.setPriceFeed(ZeroAddress, ethFeed.target);
    await proxiedMarket.setPriceFeed(await usdc.getAddress(), usdcFeed.target);

    return {
      deployer,
      seller,
      bidder1,
      bidder2,
      market,
      proxiedMarket,
      nft,
      usdc,
    };
  }

  it("ETH flow: mint->approve->create->bids(ETH)->finalize->refund withdraw", async () => {
    const { seller, bidder1, bidder2, proxiedMarket, nft } =
      await networkHelpers.loadFixture(deployFixture);

    const DURATION = 10;

    // seller mint
    await nft.mint(seller.address);
    const tokenId = 0;
    await nft
      .connect(seller)
      .approve(await proxiedMarket.getAddress(), tokenId);

    // create
    await proxiedMarket
      .connect(seller)
      .createAuction(
        await nft.getAddress(),
        tokenId,
        ethers.parseEther("1"),
        DURATION,
        ethers.ZeroAddress,
      );

    // bidder1 bids 1.1 ETH
    await proxiedMarket
      .connect(bidder1)
      .bid(1, ethers.ZeroAddress, ethers.parseEther("1.1"), {
        value: ethers.parseEther("1.1"),
      });

    // bidder2 bids 1.2 ETH -> bidder1 refundable 1.1 ETH
    await proxiedMarket
      .connect(bidder2)
      .bid(1, ethers.ZeroAddress, ethers.parseEther("1.2"), {
        value: ethers.parseEther("1.2"),
      });

    const pending = await proxiedMarket.pendingWithdrawals(
      bidder1.address,
      ethers.ZeroAddress,
    );
    expect(pending).to.eq(ethers.parseEther("1.1"));

    // end and finalize
    await networkHelpers.time.increase(DURATION + 1);
    await proxiedMarket.finalizeAuction(1);

    expect(await nft.ownerOf(tokenId)).to.eq(bidder2.address);

    // bidder1 withdraw ETH
    const balBefore = await ethers.provider.getBalance(bidder1.address);
    const tx = await proxiedMarket
      .connect(bidder1)
      .withdraw(ethers.ZeroAddress);
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed * receipt!.gasPrice;

    const balAfter = await ethers.provider.getBalance(bidder1.address);
    expect(balAfter - balBefore + gas).to.eq(ethers.parseEther("1.1"));
  });

  it("ERC20 flow: mint->approve->create(USDC)->bids->finalize->refund withdraw", async () => {
    const { seller, bidder1, bidder2, proxiedMarket, nft, usdc } =
      await networkHelpers.loadFixture(deployFixture);

    const DURATION = 10;

    await nft.mint(seller.address);
    const tokenId = 0;
    await nft
      .connect(seller)
      .approve(await proxiedMarket.getAddress(), tokenId);

    await usdc.transfer(bidder1.address, ethers.parseEther("10000"));
    await usdc.transfer(bidder2.address, ethers.parseEther("10000"));

    await proxiedMarket
      .connect(seller)
      .createAuction(
        await nft.getAddress(),
        tokenId,
        ethers.parseEther("1000"),
        DURATION,
        await usdc.getAddress(),
      );

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

    const pending = await proxiedMarket.pendingWithdrawals(
      bidder1.address,
      await usdc.getAddress(),
    );
    expect(pending).to.eq(ethers.parseEther("1100"));

    await networkHelpers.time.increase(DURATION + 1);
    await proxiedMarket.finalizeAuction(1);

    expect(await nft.ownerOf(tokenId)).to.eq(bidder2.address);

    const balBefore = await usdc.balanceOf(bidder1.address);
    await proxiedMarket.connect(bidder1).withdraw(await usdc.getAddress());
    const balAfter = await usdc.balanceOf(bidder1.address);

    expect(balAfter - balBefore).to.eq(ethers.parseEther("1100"));
  });
});
