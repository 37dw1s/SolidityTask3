// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockV3Aggregator {
    uint8 public decimals;
    int256 public latestAnswer;

    constructor(uint8 _decimals, int256 _initialAnswer) {
        decimals = _decimals;
        latestAnswer = _initialAnswer;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256 answer, uint256, uint256, uint80)
    {
        return (0, latestAnswer, 0, 0, 0);
    }

    function updateAnswer(int256 newAnswer) external {
        latestAnswer = newAnswer;
    }
}
