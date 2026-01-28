import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("MockNftModule", (m) => {
  const nft = m.contract("MockNFT", [], { id: "nft" });
  return { nft };
});
// npx hardhat ignition deploy ignition/modules/MockNFT.ts --network sepolia --deployment-id sepolia-nft

// npx hardhat ignition verify sepolia-nft --network sepolia
