import hre from "hardhat";

const { ethers } = await hre.network.connect();

const MARKET_PROXY = process.env.SEPOLIA_MARKET_PROXY!;
const NFT_ADDR = process.env.SEPOLIA_NFT!;

async function main() {
  const [seller, bidder1] = await ethers.getSigners();
  const market = await ethers.getContractAt("AuctionMarketV2", MARKET_PROXY);
  const nft = await ethers.getContractAt("MockNFT", NFT_ADDR);

  console.log("seller:", seller.address);
  console.log("bidder1:", bidder1.address);
  console.log("market proxy:", MARKET_PROXY);
  console.log("nft:", NFT_ADDR);

  // 1) 基础只读验证
  console.log("owner:", await market.owner());
  console.log("platformFeeBP:", (await market.getPlatformFeeBP()).toString());
  console.log("version:", await market.version());

  // 2) mint NFT -> approve market
  const mintTx = await nft.mint(seller.address);
  const nftReceipt = await mintTx.wait();

  let tokenId: bigint | undefined;

  for (const log of nftReceipt!.logs) {
    try {
      const parsed = nft.interface.parseLog(log);
      if (parsed?.name === "Transfer") {
        tokenId = parsed.args.tokenId as bigint;
        break;
      }
    } catch {
      // ignore
    }
  }

  if (tokenId === undefined) {
    throw new Error("Mint tx has no Transfer event; cannot determine tokenId");
  }

  await (await nft.approve(MARKET_PROXY, tokenId)).wait();
  console.log("mint+approve ok, tokenId:", tokenId.toString());

  // 如果你的 MockNFT tokenId 从 0 自增，通常第一个就是 0
  // const tokenId = 0;

  await (await nft.approve(MARKET_PROXY, tokenId)).wait();
  console.log("mint+approve ok, tokenId:", tokenId);

  // 3) createAuction（ETH-only）
  // payToken 用 address(0) 代表 ETH
  const duration = 120; // 2 分钟
  const startPrice = ethers.parseEther("0.01");

  const tx = await market.createAuction(
    NFT_ADDR,
    tokenId,
    startPrice,
    duration,
    ethers.ZeroAddress, // ETH
  );
  const auctionReceipt = await tx.wait();
  console.log("createAuction tx:", auctionReceipt?.hash);

  let auctionId: bigint | undefined;

  for (const log of auctionReceipt!.logs) {
    try {
      const parsed = market.interface.parseLog(log);
      if (parsed?.name === "AuctionCreated") {
        auctionId = parsed.args.auctionId as bigint;
        break;
      }
    } catch {
      // ignore
    }
  }

  if (auctionId === undefined) {
    throw new Error("Cannot parse auctionId from createAuction receipt");
  }

  console.log("auctionId:", auctionId.toString());

  // 4) bid with ETH（value 传入）
  const bidAmount = ethers.parseEther("0.02");
  const bidTx = await market
    .connect(bidder1)
    .bid(auctionId, ethers.ZeroAddress, bidAmount, { value: bidAmount });
  await bidTx.wait();
  console.log("bid ok:", bidAmount.toString());

  // 5) 验证状态
  const a = await market.getAuction(auctionId);
  console.log("highestBid:", a.highestBid.toString());
  console.log("highestBidder:", a.highestBidder);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

// npx hardhat run scripts/SmokeETHSepolia.ts --network sepolia
