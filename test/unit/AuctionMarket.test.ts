import { expect } from "chai";
import { ZeroAddress } from "ethers";
import hre from "hardhat";

const { ethers, networkHelpers } = await hre.network.connect();

describe("AuctionMarket (Unit)", function () {
  async function deployFixture() {
    const [deployer, seller, bidder1, bidder2] = await ethers.getSigners();

    // Deploy mocks
    const MockV3 = await ethers.getContractFactory("MockV3Aggregator");
    // ETH/USD: decimals=8, price = 3000 * 1e8
    const ethFeed = await MockV3.deploy(8, 3000n * 10n ** 8n);
    await ethFeed.waitForDeployment();
    // USDC/USD: decimals=8, price = 1 * 1e8
    const usdcFeed = await MockV3.deploy(8, 1n * 10n ** 8n);
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
      ethFeed,
      usdcFeed,
      usdc,
      nft,
      market,
      proxy,
      proxiedMarket,
    };
  }

  describe("initialize()", function () {
    it("should set platformFeeBP, nextAuctionId and priceFeeds correctly", async function () {
      const { proxiedMarket, usdc, ethFeed, usdcFeed } =
        await networkHelpers.loadFixture(deployFixture);
      expect(await proxiedMarket.getPlatformFeeBP()).to.equal(250);
      expect(await proxiedMarket.nextAuctionId()).to.equal(1);
      expect(await proxiedMarket.priceFeeds(ZeroAddress)).to.equal(
        ethFeed.target,
      );
      expect(await proxiedMarket.priceFeeds(usdc.target)).to.equal(
        usdcFeed.target,
      );
    });

    it("should revert when platformFeePercentage out of range", async function () {
      const invalidFee = 1500; // 15%

      // Deploy AuctionMarket
      const AuctionMarket = await ethers.getContractFactory("AuctionMarket");
      const market = await AuctionMarket.deploy();
      await market.waitForDeployment();

      // Encode initialize call
      const invalidFeeInitializeCall =
        AuctionMarket.interface.encodeFunctionData(
          "initialize",
          [invalidFee], // 15% platform fee
        );

      //Deploy ERC1967Proxy
      const ERC1967Proxy = await ethers.getContractFactory(
        "ERC1967ProxyWrapper",
      );
      await expect(
        ERC1967Proxy.deploy(market.target, invalidFeeInitializeCall),
      ).to.be.revertedWith(
        "platformFeeBP must be between 1 and 1000 (0.01%~10%)",
      );
    });
  });

  describe("setPriceFeed()", function () {
    it("should revert when caller is not owner", async () => {
      const { seller, proxiedMarket } = await networkHelpers.loadFixture(
        deployFixture,
      );
      await expect(
        proxiedMarket
          .connect(seller)
          .setPriceFeed(ethers.ZeroAddress, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(
        proxiedMarket,
        "OwnableUnauthorizedAccount",
      );
    });

    it("should revert when priceFeedAddress is zero", async () => {
      const { proxiedMarket } = await networkHelpers.loadFixture(deployFixture);
      await expect(
        proxiedMarket.setPriceFeed(ethers.ZeroAddress, ethers.ZeroAddress),
      ).to.be.revertedWith("priceFeedAddress is zero");
    });

    it("should set mapping and emit event", async () => {
      const { proxiedMarket } = await networkHelpers.loadFixture(deployFixture);
      const MockV3 = await ethers.getContractFactory("MockV3Aggregator");
      const newFeed = await MockV3.deploy(8, 123n * 10n ** 8n);
      await newFeed.waitForDeployment();

      const tx = await proxiedMarket.setPriceFeed(
        ethers.ZeroAddress,
        newFeed.target,
      );
      await expect(tx)
        .to.emit(proxiedMarket, "PriceFeedUpdated")
        .withArgs(ethers.ZeroAddress, newFeed.target);

      expect(await proxiedMarket.priceFeeds(ethers.ZeroAddress)).to.eq(
        newFeed.target,
      );
    });
  });

  describe("createAuction()", function () {
    it("should create auction and transfers NFT into market", async () => {
      const { seller, nft, proxiedMarket } =
        await await networkHelpers.loadFixture(deployFixture);

      // Mint NFT to seller
      await nft.mint(seller.address);
      const tokenId = 0;

      await nft
        .connect(seller)
        .approve(await proxiedMarket.getAddress(), tokenId);

      const tx = await proxiedMarket.connect(seller).createAuction(
        await nft.getAddress(),
        tokenId,
        ethers.parseEther("1"), // startPrice
        3600, // duration
        ethers.ZeroAddress, // startPayToken = ETH
      );

      await expect(tx).to.emit(proxiedMarket, "AuctionCreated");

      const auctionId = 1;
      const a = await proxiedMarket.getAuction(auctionId);
      expect(a.seller).to.eq(seller.address);
      expect(a.nftContract).to.eq(await nft.getAddress());
      expect(a.tokenId).to.eq(tokenId);
      expect(a.duration).to.eq(3600);
      expect(a.startPayToken).to.eq(ethers.ZeroAddress);
      expect(a.startPrice).to.eq(ethers.parseEther("1"));
      expect(a.ended).to.eq(false);

      expect(await nft.ownerOf(tokenId)).to.eq(
        await proxiedMarket.getAddress(),
      );
      expect(await proxiedMarket.nextAuctionId()).to.eq(2);
    });

    it("should revert if payToken not supported", async () => {
      const { seller, nft, proxiedMarket } = await networkHelpers.loadFixture(
        deployFixture,
      );
      await nft.mint(seller.address);
      await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);

      await expect(
        proxiedMarket.connect(seller).createAuction(
          await nft.getAddress(),
          0,
          ethers.parseEther("1"),
          3600,
          "0x0000000000000000000000000000000000000001", // no feed
        ),
      ).to.be.revertedWith("payToken not supported");
    });

    it("should revert on invalid createAuction params (zero/owner/approval)", async () => {
      const { deployer, seller, nft, proxiedMarket } = await deployFixture();

      // zero nftContract
      await expect(
        proxiedMarket
          .connect(seller)
          .createAuction(
            ethers.ZeroAddress,
            0,
            ethers.parseEther("1"),
            3600,
            ethers.ZeroAddress,
          ),
      ).to.be.revertedWith("nftContract cannot be null");

      // mint NFT to seller
      await nft.mint(seller.address);

      // startPrice == 0
      await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);
      await expect(
        proxiedMarket
          .connect(seller)
          .createAuction(
            await nft.getAddress(),
            0,
            0,
            3600,
            ethers.ZeroAddress,
          ),
      ).to.be.revertedWith("startPrice must be greater than zero");

      // duration == 0
      await expect(
        proxiedMarket
          .connect(seller)
          .createAuction(
            await nft.getAddress(),
            0,
            ethers.parseEther("1"),
            0,
            ethers.ZeroAddress,
          ),
      ).to.be.revertedWith("Duration must be greater than zero");

      // not NFT owner
      await expect(
        proxiedMarket
          .connect(deployer)
          .createAuction(
            await nft.getAddress(),
            0,
            ethers.parseEther("1"),
            3600,
            ethers.ZeroAddress,
          ),
      ).to.be.revertedWith("You are not the owner of this NFT");

      // approval missing (revoke approve)
      await nft.connect(seller).approve(ethers.ZeroAddress, 0);
      await expect(
        proxiedMarket
          .connect(seller)
          .createAuction(
            await nft.getAddress(),
            0,
            ethers.parseEther("1"),
            3600,
            ethers.ZeroAddress,
          ),
      ).to.be.revert(ethers); // revert reason depends on ERC721 implementation
    });
  });

  describe("bid()", function () {
    it("should success; must match msg.value and it must be > current highest (USD)", async function () {
      const { seller, bidder1, proxiedMarket, nft } =
        await networkHelpers.loadFixture(deployFixture);

      await nft.mint(seller.address);
      await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);

      await proxiedMarket.connect(seller).createAuction(
        await nft.getAddress(),
        0,
        ethers.parseEther("1"), // start 1 ETH
        3600,
        ethers.ZeroAddress,
      );

      await expect(
        proxiedMarket
          .connect(bidder1)
          .bid(1, ethers.ZeroAddress, ethers.parseEther("1"), {
            value: ethers.parseEther("1"),
          }),
      ).to.be.revertedWith("bid need > current highest (USD)");

      const tx = await proxiedMarket
        .connect(bidder1)
        .bid(1, ethers.ZeroAddress, ethers.parseEther("1.1"), {
          value: ethers.parseEther("1.1"),
        });
      await expect(tx).to.emit(proxiedMarket, "BidPlaced");
    });

    it("should revert bid after auction ended", async () => {
      const { seller, bidder1, proxiedMarket, nft } =
        await networkHelpers.loadFixture(deployFixture);

      const DURATION = 10;

      await nft.mint(seller.address);
      await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);

      await proxiedMarket
        .connect(seller)
        .createAuction(
          await nft.getAddress(),
          0,
          ethers.parseEther("1"),
          DURATION,
          ethers.ZeroAddress,
        );

      await networkHelpers.time.increase(DURATION + 1);

      await expect(
        proxiedMarket
          .connect(bidder1)
          .bid(1, ethers.ZeroAddress, ethers.parseEther("1.1"), {
            value: ethers.parseEther("1.1"),
          }),
      ).to.be.revertedWith("Auction has ended");
    });

    it("should revert bid after auction finalized", async () => {
      const { seller, bidder1, proxiedMarket, nft } =
        await networkHelpers.loadFixture(deployFixture);

      const DURATION = 100;

      await nft.mint(seller.address);
      await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);

      await proxiedMarket
        .connect(seller)
        .createAuction(
          await nft.getAddress(),
          0,
          ethers.parseEther("1"),
          DURATION,
          ethers.ZeroAddress,
        );

      await proxiedMarket
        .connect(bidder1)
        .bid(1, ethers.ZeroAddress, ethers.parseEther("1.1"), {
          value: ethers.parseEther("1.1"),
        });

      await networkHelpers.time.increase(DURATION + 1);

      await proxiedMarket.finalizeAuction(1);

      await expect(
        proxiedMarket
          .connect(bidder1)
          .bid(1, ethers.ZeroAddress, ethers.parseEther("1.2"), {
            value: ethers.parseEther("1.2"),
          }),
      ).to.be.revertedWith("Auction has ended");
    });

    it("should revert if seller bids", async function () {
      const { seller, proxiedMarket, nft } = await networkHelpers.loadFixture(
        deployFixture,
      );
      await nft.mint(seller.address);
      await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);
      await proxiedMarket
        .connect(seller)
        .createAuction(
          await nft.getAddress(),
          0,
          ethers.parseEther("1"),
          3600,
          ethers.ZeroAddress,
        );

      await expect(
        proxiedMarket
          .connect(seller)
          .bid(1, ethers.ZeroAddress, ethers.parseEther("1.1"), {
            value: ethers.parseEther("1.1"),
          }),
      ).to.be.revertedWith("Seller cannot bid");
    });

    it("should refund previous bidder into pendingWithdrawals", async function () {
      const { seller, bidder1, bidder2, proxiedMarket, nft, usdc } =
        await networkHelpers.loadFixture(deployFixture);

      await nft.mint(seller.address);
      await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);
      // startPayToken = USDC token
      await proxiedMarket.connect(seller).createAuction(
        await nft.getAddress(),
        0,
        ethers.parseEther("1000"), // 1000 tokens => $1000
        3600,
        await usdc.getAddress(),
      );

      // transfer some usdc to bidders
      await usdc.transfer(bidder1.address, ethers.parseEther("5000"));
      await usdc.transfer(bidder2.address, ethers.parseEther("5000"));

      // bidder1 approves and bids 1100
      await usdc
        .connect(bidder1)
        .approve(await proxiedMarket.getAddress(), ethers.parseEther("1100"));
      await proxiedMarket
        .connect(bidder1)
        .bid(1, await usdc.getAddress(), ethers.parseEther("1100"));

      // bidder2 bids 1200 -> bidder1 should have pendingWithdrawals[bidder1][usdc] = 1100
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
    });

    it("should revert on basic bid validations (id/amount/payToken/msg.value/allowance)", async () => {
      const { seller, bidder1, proxiedMarket, nft, usdc } =
        await deployFixture();

      // auctionId not exist
      await expect(
        proxiedMarket
          .connect(bidder1)
          .bid(999, ethers.ZeroAddress, ethers.parseEther("1"), {
            value: ethers.parseEther("1"),
          }),
      ).to.be.revertedWith("Auction does not exist");

      // create an ETH auction
      await nft.mint(seller.address);
      await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);
      await proxiedMarket
        .connect(seller)
        .createAuction(
          await nft.getAddress(),
          0,
          ethers.parseEther("1"),
          3600,
          ethers.ZeroAddress,
        );

      // amount == 0
      await expect(
        proxiedMarket
          .connect(bidder1)
          .bid(1, ethers.ZeroAddress, 0, { value: 0 }),
      ).to.be.revertedWith("Bid amount must be greater than zero");

      // msg.value mismatch on ETH path
      await expect(
        proxiedMarket
          .connect(bidder1)
          .bid(1, ethers.ZeroAddress, ethers.parseEther("1.1"), {
            value: ethers.parseEther("1.0"),
          }),
      ).to.be.revertedWith("Sent ETH amount does not match bid amount");

      // unsupported payToken
      await expect(
        proxiedMarket
          .connect(bidder1)
          .bid(
            1,
            "0x0000000000000000000000000000000000000001",
            ethers.parseEther("1.1"),
            {
              value: ethers.parseEther("1.1"),
            },
          ),
      ).to.be.revertedWith("Unsupported payToken");

      // create an ERC20 (USDC) auction
      await nft.mint(seller.address);
      await nft.connect(seller).approve(await proxiedMarket.getAddress(), 1);
      await proxiedMarket
        .connect(seller)
        .createAuction(
          await nft.getAddress(),
          1,
          ethers.parseEther("1000"),
          3600,
          await usdc.getAddress(),
        );

      await usdc.transfer(bidder1.address, ethers.parseEther("2000"));

      // ERC20 path should not send ETH
      await usdc
        .connect(bidder1)
        .approve(await proxiedMarket.getAddress(), ethers.parseEther("1100"));
      await expect(
        proxiedMarket
          .connect(bidder1)
          .bid(2, await usdc.getAddress(), ethers.parseEther("1100"), {
            value: 1,
          }),
      ).to.be.revertedWith("Do not send ETH when bidding with ERC20");

      // allowance not enough
      await usdc.connect(bidder1).approve(await proxiedMarket.getAddress(), 0);
      await expect(
        proxiedMarket
          .connect(bidder1)
          .bid(2, await usdc.getAddress(), ethers.parseEther("1100")),
      ).to.be.revertedWith("ERC20 allowance not enough");
    });

    describe("finalizeAuction()", function () {
      it("should revert if auction not yet ended", async () => {
        const { seller, proxiedMarket, nft } = await networkHelpers.loadFixture(
          deployFixture,
        );

        const DURATION = 10;
        await nft.mint(seller.address);
        await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);
        await proxiedMarket
          .connect(seller)
          .createAuction(
            await nft.getAddress(),
            0,
            ethers.parseEther("1"),
            DURATION,
            ethers.ZeroAddress,
          );

        await expect(proxiedMarket.finalizeAuction(1)).to.be.revertedWith(
          "Auction has ended",
        );
      });

      it("should return NFT to seller when no bids", async () => {
        const { seller, proxiedMarket, nft } = await networkHelpers.loadFixture(
          deployFixture,
        );

        const DURATION = 10;
        await nft.mint(seller.address);
        await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);
        await proxiedMarket
          .connect(seller)
          .createAuction(
            await nft.getAddress(),
            0,
            ethers.parseEther("1"),
            DURATION,
            ethers.ZeroAddress,
          );

        await networkHelpers.time.increase(DURATION + 1);
        const tx = await proxiedMarket.finalizeAuction(1);
        await expect(tx).to.emit(proxiedMarket, "AuctionFinalized");

        expect(await nft.ownerOf(0)).to.eq(seller.address);
        const a = await proxiedMarket.getAuction(1);
        expect(a.ended).to.eq(true);
        expect(a.highestBidder).to.eq(ethers.ZeroAddress);
      });

      it("should transfers NFT to winner and pays seller minus fee when there are bids", async () => {
        const { seller, bidder1, proxiedMarket, nft } =
          await networkHelpers.loadFixture(deployFixture);

        const DURATION = 10;
        await nft.mint(seller.address);
        await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);
        await proxiedMarket
          .connect(seller)
          .createAuction(
            await nft.getAddress(),
            0,
            ethers.parseEther("1"),
            DURATION,
            ethers.ZeroAddress,
          );

        await proxiedMarket
          .connect(bidder1)
          .bid(1, ethers.ZeroAddress, ethers.parseEther("1.1"), {
            value: ethers.parseEther("1.1"),
          });

        const sellerBalBefore = await ethers.provider.getBalance(
          seller.address,
        );

        await networkHelpers.time.increase(DURATION + 1);
        const tx = await proxiedMarket.finalizeAuction(1);
        await tx.wait();

        expect(await nft.ownerOf(0)).to.eq(bidder1.address);

        // fee=250bp=2.5% => seller gets 97.5% of 1.1 ETH = 1.0725 ETH
        // 注意：seller 本次接收 ETH 无 gas（call 收款），所以余额增量应接近 1.0725
        const sellerBalAfter = await ethers.provider.getBalance(seller.address);
        const delta = sellerBalAfter - sellerBalBefore;
        expect(delta).to.eq(ethers.parseEther("1.0725"));
      });

      it("should revert when trying to finalize twice", async () => {
        const { seller, proxiedMarket, nft } = await networkHelpers.loadFixture(
          deployFixture,
        );

        const DURATION = 10;
        await nft.mint(seller.address);
        await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);
        await proxiedMarket
          .connect(seller)
          .createAuction(
            await nft.getAddress(),
            0,
            ethers.parseEther("1"),
            DURATION,
            ethers.ZeroAddress,
          );

        await networkHelpers.time.increase(DURATION + 1);
        await proxiedMarket.finalizeAuction(1);

        await expect(proxiedMarket.finalizeAuction(1)).to.be.revertedWith(
          "Auction has ended",
        );
      });
    });

    describe("withdraw()", function () {
      it("withdraws ERC20 pending refunds", async () => {
        const { seller, bidder1, bidder2, proxiedMarket, nft, usdc } =
          await networkHelpers.loadFixture(deployFixture);

        await nft.mint(seller.address);
        await nft.connect(seller).approve(await proxiedMarket.getAddress(), 0);
        await proxiedMarket
          .connect(seller)
          .createAuction(
            await nft.getAddress(),
            0,
            ethers.parseEther("1000"),
            3600,
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

        const balBefore = await usdc.balanceOf(bidder1.address);
        const tx = await proxiedMarket
          .connect(bidder1)
          .withdraw(await usdc.getAddress());
        await expect(tx).to.emit(proxiedMarket, "Withdrawn");
        const balAfter = await usdc.balanceOf(bidder1.address);
        expect(balAfter - balBefore).to.eq(ethers.parseEther("1100"));

        const pendingAfter = await proxiedMarket.pendingWithdrawals(
          bidder1.address,
          await usdc.getAddress(),
        );
        expect(pendingAfter).to.eq(0);
      });

      it("reverts if no funds", async () => {
        const { bidder1, proxiedMarket } = await networkHelpers.loadFixture(
          deployFixture,
        );
        await expect(
          proxiedMarket.connect(bidder1).withdraw(ethers.ZeroAddress),
        ).to.be.revertedWith("No funds to withdraw");
      });
    });
  });
});
