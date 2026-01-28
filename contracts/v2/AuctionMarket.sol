// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

contract AuctionMarket is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC721HolderUpgradeable
{
    struct Auction {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 startTime;
        uint256 duration;
        bool ended;
        // 起拍价“金额”和起拍价对应的币种（address(0) 表示 ETH）
        address startPayToken;
        uint256 startPrice;
        address highestBidder;
        address highestPayToken; // 最高出价对应的币种
        uint256 highestBid; // 最高出价“金额”
    }

    mapping(uint256 => Auction) public auctions;
    uint256 public nextAuctionId;

    // 价格喂价合约映射(paytoken => priceFeed)
    mapping(address => AggregatorV3Interface) public priceFeeds;

    uint256 private _platformFeeBP; // 平台手续费，单位：BP（1 BP = 0.01%）

    // 用户 => token(0=ETH) => 可提现金额
    mapping(address => mapping(address => uint256)) public pendingWithdrawals;

    event PriceFeedUpdated(
        address indexed payToken,
        address indexed priceFeedAddress
    );

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed nftContract,
        uint256 tokenId,
        uint256 startTime,
        uint256 duration,
        address startPayToken,
        uint256 startPrice
    );

    event BidPlaced(
        uint256 indexed auctionId,
        address indexed nftContract,
        uint256 tokenId,
        address indexed bidder,
        address highestPayToken,
        uint256 highestBid
    );

    event AuctionFinalized(
        uint256 indexed auctionId,
        address indexed nftContract,
        uint256 tokenId,
        address indexed winner,
        address highestPayToken,
        uint256 highestBid
    );

    event Withdrawn(
        address indexed user,
        address indexed token,
        uint256 amount
    );

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    function initialize(uint256 platformFeeBP) public initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __ERC721Holder_init();

        require(
            platformFeeBP >= 1 && platformFeeBP <= 1000,
            "platformFeeBP must be between 1 and 1000 (0.01%~10%)"
        );
        _platformFeeBP = platformFeeBP;

        nextAuctionId = 1;

        // 初始化价格喂价合约映射
        _initPriceFeeds();
    }

    // ===== 管理员功能 =====
    function setPriceFeed(
        address payToken,
        address priceFeedAddress
    ) external onlyOwner {
        require(priceFeedAddress != address(0), "priceFeedAddress is zero");
        priceFeeds[payToken] = AggregatorV3Interface(priceFeedAddress);
        emit PriceFeedUpdated(payToken, priceFeedAddress);
    }

    // ===== 用户功能：创建拍卖 =====
    function createAuction(
        address nftContract,
        uint256 tokenId,
        uint256 startPrice,
        uint256 duration,
        address startPayToken
    ) external nonReentrant returns (uint256) {
        require(nftContract != address(0), "nftContract cannot be null");
        // require(tokenId >= 0, "tokenId must be greater equal than zero");
        require(startPrice > 0, "startPrice must be greater than zero");
        require(duration > 0, "Duration must be greater than zero");
        require(
            address(priceFeeds[startPayToken]) != address(0),
            "payToken not supported"
        );

        IERC721 nft = IERC721(nftContract);
        require(
            nft.ownerOf(tokenId) == msg.sender,
            "You are not the owner of this NFT"
        );
        require(
            nft.getApproved(tokenId) == address(this) ||
                nft.isApprovedForAll(msg.sender, address(this)),
            "AuctionMarket not approved to manage this NFT"
        );

        uint256 auctionId = nextAuctionId++;
        auctions[auctionId] = Auction({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            startTime: block.timestamp,
            duration: duration,
            ended: false,
            startPayToken: startPayToken,
            startPrice: startPrice,
            highestBidder: address(0),
            highestPayToken: address(0),
            highestBid: 0
        });

        nft.safeTransferFrom(msg.sender, address(this), tokenId);

        emit AuctionCreated(
            auctionId,
            msg.sender,
            nftContract,
            tokenId,
            block.timestamp,
            duration,
            startPayToken,
            startPrice
        );
        return auctionId;
    }

    // ===== 用户功能：出价 =====
    function bid(
        uint256 auctionId,
        address payToken,
        uint256 amount
    ) external payable nonReentrant {
        Auction storage auction = auctions[auctionId];
        require(auction.seller != address(0), "Auction does not exist");
        require(
            block.timestamp < auction.startTime + auction.duration &&
                !auction.ended,
            "Auction has ended"
        );
        require(
            address(priceFeeds[payToken]) != address(0),
            "Unsupported payToken"
        );
        require(amount > 0, "Bid amount must be greater than zero");
        require(msg.sender != auction.seller, "Seller cannot bid");

        if (payToken == address(0)) {
            require(
                msg.value == amount,
                "Sent ETH amount does not match bid amount"
            );
        } else {
            require(msg.value == 0, "Do not send ETH when bidding with ERC20");
            require(
                IERC20(payToken).allowance(msg.sender, address(this)) >= amount,
                "ERC20 allowance not enough"
            );
        }

        // 计算当前“要被超过”的 USD 值：如果没人出价，就用起拍价；否则用最高出价
        uint256 currentUsd = _currentHighestUsd(auction);
        uint256 bidUsd = _toUsd(payToken, amount);

        require(bidUsd > currentUsd, "bid need > current highest (USD)");

        // ERC20 竞价：把 token 转进来
        if (payToken != address(0)) {
            bool ok = IERC20(payToken).transferFrom(
                msg.sender,
                address(this),
                amount
            );
            require(ok, "ERC20 transferFrom failed");
        }

        // 退款记账
        if (auction.highestBidder != address(0) && auction.highestBid > 0) {
            pendingWithdrawals[auction.highestBidder][
                auction.highestPayToken
            ] += auction.highestBid;
        }

        auction.highestBidder = msg.sender;
        auction.highestPayToken = payToken;
        auction.highestBid = amount;

        emit BidPlaced(
            auctionId,
            auction.nftContract,
            auction.tokenId,
            msg.sender,
            payToken,
            amount
        );
    }

    // ===== 用户功能：结束拍卖 =====
    function finalizeAuction(uint256 auctionId) external nonReentrant {
        Auction storage auction = auctions[auctionId];
        require(auction.seller != address(0), "Auction does not exist");
        require(
            block.timestamp >= auction.startTime + auction.duration &&
                !auction.ended,
            "Auction has ended"
        );

        auction.ended = true;

        IERC721 nft = IERC721(auction.nftContract);

        if (auction.highestBidder == address(0)) {
            // 没人出价，退回 NFT 给卖家
            nft.safeTransferFrom(
                address(this),
                auction.seller,
                auction.tokenId
            );

            emit AuctionFinalized(
                auctionId,
                auction.nftContract,
                auction.tokenId,
                address(0),
                address(0),
                0
            );
            return;
        }

        // 有人出价：把 NFT 给最高出价者，把钱给卖家（扣手续费）
        nft.safeTransferFrom(
            address(this),
            auction.highestBidder,
            auction.tokenId
        );

        uint256 platformFee = (auction.highestBid * _platformFeeBP) / 10000;
        uint256 sellerAmount = auction.highestBid - platformFee;

        if (auction.highestPayToken != address(0)) {
            // ERC20 支付
            IERC20 payToken = IERC20(auction.highestPayToken);
            require(
                payToken.transfer(auction.seller, sellerAmount),
                "Payment to seller failed"
            );
            // 平台手续费留在合约内，管理员可提取
        } else {
            // ETH 支付
            (bool successSeller, ) = auction.seller.call{value: sellerAmount}(
                ""
            );
            require(successSeller, "Payment to seller failed");
            // 平台手续费留在合约内，管理员可提取
        }

        emit AuctionFinalized(
            auctionId,
            auction.nftContract,
            auction.tokenId,
            auction.highestBidder,
            auction.highestPayToken,
            auction.highestBid
        );
    }

    // ===== 用户功能：拉取退款 =====
    function withdraw(address token) external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender][token];
        require(amount > 0, "No funds to withdraw");

        // 先清零再转账，防止重入
        pendingWithdrawals[msg.sender][token] = 0;

        if (token != address(0)) {
            IERC20 payToken = IERC20(token);
            require(
                payToken.transfer(msg.sender, amount),
                "ERC20 withdrawal failed"
            );
            emit Withdrawn(msg.sender, token, amount);
        } else {
            (bool success, ) = msg.sender.call{value: amount}("");
            require(success, "ETH withdrawal failed");
            emit Withdrawn(msg.sender, token, amount);
        }
    }

    // ===== 查询 & 费用 =====
    function getAuction(
        uint256 auctionId
    ) external view returns (Auction memory) {
        return auctions[auctionId];
    }

    function getPriceFeed(address payToken) external view returns (address) {
        AggregatorV3Interface feed = priceFeeds[payToken];
        return address(feed);
    }

    function getPlatformFeeBP() external view returns (uint256) {
        return _platformFeeBP;
    }

    function version() external pure virtual returns (string memory) {
        return "V1";
    }

    // ===== 内部工具函数 =====
    function _initPriceFeeds() internal {
        // 示例：初始化一些常见代币的价格喂价合约地址
        //Sepolia:
        priceFeeds[address(0)] = AggregatorV3Interface(
            0x694AA1769357215DE4FAC081bf1f309aDC325306
        ); // ETH/USD
        priceFeeds[
            0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
        ] = AggregatorV3Interface(0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E); // USDC/USD
    }

    // 统一把token的amount转换为USD（6小数位）
    function _toUsd(
        address payToken,
        uint256 amount
    ) internal view returns (uint256) {
        AggregatorV3Interface priceFeed = priceFeeds[payToken];
        require(
            address(priceFeed) != address(0),
            "No price feed for this token"
        );

        (, int256 priceRaw, , , ) = priceFeed.latestRoundData();
        require(priceRaw > 0, "Invalid price from price feed");
        uint256 price = uint256(priceRaw);
        uint256 feedDecimals = priceFeed.decimals();

        if (payToken == address(0)) {
            return (amount * uint256(price)) / (10 ** (18 + feedDecimals - 6)); // 转换为 6 小数位的 USD
        } else {
            IERC20Metadata token = IERC20Metadata(payToken);
            uint8 tokenDecimals = token.decimals();
            return
                (amount * uint256(price)) /
                (10 ** (tokenDecimals + feedDecimals - 6)); // 转换为 6 小数位的 USD
        }
    }

    function _currentHighestUsd(
        Auction storage a
    ) internal view returns (uint256) {
        if (a.highestBidder == address(0)) {
            return _toUsd(a.startPayToken, a.startPrice);
        }
        return _toUsd(a.highestPayToken, a.highestBid);
    }
}
