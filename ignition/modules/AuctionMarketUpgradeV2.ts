import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("AuctionMarketUpgradeV2Module", (m) => {
  // 关键：传入已部署的 proxy 地址
  const proxy = m.getParameter("proxyAddress");

  const implV2 = m.contract("AuctionMarketV2");
  const proxiedMarketV2 = m.contractAt("AuctionMarketV2", proxy, {
    id: "proxiedMarketV2",
  });

  m.call(proxiedMarketV2, "upgradeToAndCall", [implV2, "0x"]);

  return { implV2, proxiedMarketV2 };
});
// npx hardhat ignition deploy ignition/modules/AuctionMarketUpgradeV2.ts --deployment-id local-v2
// npx hardhat ignition deploy ignition/modules/AuctionMarketUpgradeV2.ts --network sepolia --deployment-id sepolia-v2 --parameters ignition/parameters/sepolia.json
