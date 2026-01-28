import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const AuctionMarketProxyModule = buildModule("AuctionMarketProxy", (m) => {
  // 你也可以改成 m.getParameter(...)，部署时用参数文件传入
  const platformFee = m.getParameter("platformFee", 250); // 2.5%

  // 1) 部署 V1 impl
  const implV1 = m.contract("AuctionMarket");

  // 2) 部署 proxy（你的 ERC1967ProxyWrapper 构造是 (impl, initData)）
  const proxy = m.contract("ERC1967ProxyWrapper", [implV1, "0x"]);

  // 3) 用 V1 ABI attach proxy，并 initialize
  const proxiedMarket = m.contractAt("AuctionMarket", proxy);
  m.call(proxiedMarket, "initialize", [platformFee]);

  return { implV1, proxy, proxiedMarket };
});

export default AuctionMarketProxyModule;
