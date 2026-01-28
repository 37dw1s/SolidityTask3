// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./AuctionMarket.sol";

contract AuctionMarketV2 is AuctionMarket {
    function version() external pure override returns (string memory) {
        return "V2";
    }
}
