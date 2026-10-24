// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Hanya untuk uji di Sepolia: token palsu + airdrop palsu dengan fungsi claim().
contract MockToken {
    string public symbol = "TEST";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    constructor() { balanceOf[msg.sender] = 1_000_000e18; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
}

contract MockAirdrop {
    MockToken public token;
    uint256 public amount;
    mapping(address => bool) public claimed;
    constructor(MockToken t, uint256 a) { token = t; amount = a; }
    function claim() external {
        require(!claimed[msg.sender], "sudah klaim");
        claimed[msg.sender] = true;
        token.transfer(msg.sender, amount);
    }
}
