# NFT 拍卖市场（可升级 · UUPS / ERC1967）

一个支持 **NFT 拍卖 + ERC20 支付 + 价格预言机 + 可升级代理架构** 的完整智能合约项目，基于 Hardhat + TypeScript + Ignition 构建，支持本地与 Sepolia 测试网部署，包含完整的单元测试、集成测试与 Smoke Test。

---

## 一、项目特性

- ✅ NFT 拍卖创建 / 出价 / 结算
- ✅ ERC20（如 USDC）支付
- ✅ Chainlink 价格预言机换算
- ✅ ERC1967 + UUPS 可升级架构
- ✅ Hardhat Ignition 自动化部署
- ✅ 本地 + Sepolia 测试网完整流程
- ✅ 单元测试 + 集成测试 + Smoke Test
- ✅ 合约自动验证（Etherscan）

---

## 二、项目结构

```
contracts/
├── AuctionMarket.sol          # V1 拍卖市场逻辑合约（UUPS）
├── AuctionMarketV2.sol        # V2 升级逻辑合约
├── ERC1967ProxyWrapper.sol    # ERC1967 代理合约
├── mocks/
│   ├── MockUSDC.sol
│   ├── MockNFT.sol
│   └── MockV3Aggregator.sol

ignition/
└── modules/
    ├── AuctionMarketProxyModule.ts
    └── AuctionMarketUpgradeV2Module.ts

scripts/
├── AuctionMarketProxy.ts
├── AuctionMarketUpgradeV2.ts
├── MockNFT.ts
└── smoke.ts

deploy-config/
└── sepolia.json

test/
├── unit/
│   └── AuctionMarket.unit.ts
└── integration/
    └── AuctionMarket.integration.ts
```

---

## 三、系统架构

### 调用流程

```
用户
  ↓
ERC1967 Proxy
  ↓ delegatecall
AuctionMarket / AuctionMarketV2 (实现合约)
```

### 关键组件

| 模块                | 说明               |
| ------------------- | ------------------ |
| AuctionMarket.sol   | 拍卖核心逻辑（V1） |
| AuctionMarketV2.sol | 升级版本           |
| ERC1967ProxyWrapper | 标准代理合约       |
| UUPSUpgradeable     | 升级入口与权限控制 |
| Mock 合约           | 测试与开发         |

---

## 四、功能说明

### 核心功能

- 创建拍卖（NFT 托管）
- ERC20 出价（transferFrom）
- 最小加价校验
- 拍卖结束结算
- NFT 转移
- 卖家收款
- 平台手续费
- 价格预言机换算 USD 价值
- 可升级（upgradeTo / upgradeToAndCall）

### 安全设计

- ReentrancyGuard 防重入
- Ownable 权限控制
- 存储布局保护
- 时间与价格校验
- Allowance 校验

---

## 五、Sepolia 部署参数说明

文件：`deploy-config/sepolia.json`

```json
{
  "AuctionMarketProxyModule": {
    "platformFee": 300
  },
  "AuctionMarketUpgradeV2Module": {
    "platformFee": 300,
    "proxyAddress": "0x..."
  }
}
```

说明：

- `platformFee = 300` → 平台手续费 3%（基数 10000）
- `proxyAddress` → 已部署代理合约地址（升级用）

---

## 六、环境变量配置（.env）

在项目根目录创建 `.env` 文件（务必加入 `.gitignore`）：

```bash
# RPC
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/xxxx

# 账户私钥
SEPOLIA_PRIVATE_KEY=0x...
SEPOLIA_BIDDER_PRIVATE_KEY=0x...

# Etherscan
ETHERSCAN_API_KEY=xxxx

# 已部署地址
SEPOLIA_MARKET_PROXY=0x...
SEPOLIA_NFT=0x...
```

---

## 七、安装与编译

```bash
npm install
npx hardhat compile
```

---

## 八、测试

### 1. 运行全部测试

```bash
npx hardhat test
```

### 2. 仅运行单元测试

```bash
npx hardhat test test/unit
```

### 3. 仅运行集成测试

```bash
npx hardhat test test/integration
```

### 4. 覆盖率报告

```bash
npx hardhat coverage
# 或
npx hardhat test --coverage
```

---

## 九、Ignition 部署流程

### 1. 本地部署

#### 启动节点

```bash
npx hardhat node
```

#### 部署 MockNFT

```bash
npx hardhat ignition deploy ignition/modules/MockNFT.ts \
  --network sepolia \
  --deployment-id sepolia-nft
```

---

### 2. Sepolia 部署 V1 + Proxy

```bash
npx hardhat ignition deploy ignition/modules/AuctionMarketProxy.ts \
  --network sepolia \
  --deployment-id sepolia-v1 \
  --parameters ignition/parameters/sepolia.json
```

---

### 3. Sepolia 升级到 V2

```bash
npx hardhat ignition deploy ignition/modules/AuctionMarketUpgradeV2.ts \
  --network sepolia \
  --deployment-id sepolia-v2 \
  --parameters ignition/parameters/sepolia.json
```

---

## 十、合约验证（Etherscan）

### 自动验证（Ignition）

```bash
npx hardhat ignition deploy ignition/modules/AuctionMarketProxyModule.ts \
  --network sepolia \
  --parameters deploy-config/sepolia.json \
  --verify
```

升级模块：

```bash
npx hardhat ignition deploy ignition/modules/AuctionMarketUpgradeV2Module.ts \
  --network sepolia \
  --parameters deploy-config/sepolia.json \
  --verify
```

---

### 手动验证（可选）

```bash
npx hardhat verify --network sepolia <IMPLEMENTATION_ADDRESS>
```

---

## 十一、Smoke Test（普通脚本）

假设脚本：`scripts/smoke.ts`

### 本地运行

```bash
npx hardhat run scripts/SmokeETHSepolia.ts --network localhost
```

### Sepolia 运行

```bash
npx hardhat run scripts/SmokeETHSepolia.ts --network sepolia
```

Smoke Test 通常包含：

- 读取代理合约
- 创建拍卖
- 出价
- 结算
- 校验余额和 NFT 所有权

---

## 十二、升级注意事项

### 存储布局规则

- ❌ 不删除旧变量
- ❌ 不改变变量顺序
- ✅ 只在末尾追加新变量

### 升级权限控制

```solidity
function _authorizeUpgrade(address newImpl)
    internal
    override
    onlyOwner
{}
```

建议：

- 使用多签钱包作为 owner
- 或引入 Timelock

---

## 十三、推荐扩展

- ABI 文档
- Auction 结构体说明
- 事件索引说明
- 前端交互示例（ethers.js）
- Gas 优化报告
- 安全审计说明

---

## License

MIT

---
