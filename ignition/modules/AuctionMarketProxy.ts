import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const AuctionMarketProxyModule = buildModule(
  "AuctionMarketProxyModule",
  (m) => {
    const platformFee = m.getParameter("platformFee", 250); // 2.5%

    // 1) deploy AuctionMarket V1 impl
    const implV1 = m.contract("AuctionMarket");

    const initData = m.encodeFunctionCall(implV1, "initialize", [platformFee]);

    // 2) deploy proxy
    const proxy = m.contract("ERC1967ProxyWrapper", [implV1, initData]);

    // 3) attach V1 ABI to proxy
    const proxiedMarket = m.contractAt("AuctionMarket", proxy, {
      id: "proxiedMarket",
    });

    return { implV1, proxy, proxiedMarket };
  },
);

export default AuctionMarketProxyModule;
// npx hardhat ignition deploy ignition/modules/AuctionMarketProxy.ts --deployment-id local-v1
// npx hardhat ignition deploy ignition/modules/AuctionMarketProxy.ts --network sepolia --deployment-id sepolia-v1 --parameters ignition/parameters/sepolia.json

// npx hardhat ignition verify sepolia-v1
