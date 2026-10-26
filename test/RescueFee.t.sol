// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Foundry tests (needs forge-std, OpenZeppelin and a Foundry version with EIP-7702 cheatcodes).
import "forge-std/Test.sol";
import {RescueFee} from "../contracts/RescueFee.sol";
import {MockToken, MockAirdrop} from "../contracts/MockAirdrop.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract RescueFeeTest is Test {
    RescueFee impl;
    MockToken token;
    MockAirdrop airdrop;
    uint256 pk = 0xA11CE;
    address account;
    address feeTo = address(0xFEE);
    address safe = address(0x5AFE);
    address sponsor = address(0xBEEF);

    function setUp() public {
        impl = new RescueFee(feeTo);
        token = new MockToken();
        airdrop = new MockAirdrop(token, 100e18);
        token.transfer(address(airdrop), 1_000e18);
        account = vm.addr(pk);
    }

    function _tokens() internal view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(token);
    }

    function _sig(uint256 key, address claimTarget, bytes memory cd, address[] memory t, bool nativ, address to, uint256 dl)
        internal view returns (bytes memory)
    {
        bytes32 raw = keccak256(abi.encode(block.chainid, account, claimTarget, keccak256(cd), keccak256(abi.encode(t)), nativ, to, dl));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, MessageHashUtils.toEthSignedMessageHash(raw));
        return abi.encodePacked(r, s, v);
    }

    function test_fee_is_exactly_20_percent() public {
        bytes memory cd = abi.encodeCall(MockAirdrop.claim, ());
        uint256 dl = block.timestamp + 300;
        bytes memory sig = _sig(pk, address(airdrop), cd, _tokens(), false, safe, dl);
        vm.signAndAttachDelegation(address(impl), pk);
        vm.prank(sponsor);
        RescueFee(payable(account)).rescue(address(airdrop), cd, _tokens(), false, safe, dl, sig);
        assertEq(token.balanceOf(feeTo), 20e18);
        assertEq(token.balanceOf(safe), 80e18);
        assertEq(token.balanceOf(account), 0);
    }

    function test_replay_reverts() public {
        bytes memory cd = abi.encodeCall(MockAirdrop.claim, ());
        uint256 dl = block.timestamp + 300;
        bytes memory sig = _sig(pk, address(airdrop), cd, _tokens(), false, safe, dl);
        vm.signAndAttachDelegation(address(impl), pk);
        RescueFee(payable(account)).rescue(address(airdrop), cd, _tokens(), false, safe, dl, sig);
        vm.expectRevert(RescueFee.Used.selector);
        RescueFee(payable(account)).rescue(address(airdrop), cd, _tokens(), false, safe, dl, sig);
    }

    function test_wrong_signer_reverts() public {
        bytes memory cd = abi.encodeCall(MockAirdrop.claim, ());
        uint256 dl = block.timestamp + 300;
        bytes memory sig = _sig(0xB0B, address(airdrop), cd, _tokens(), false, safe, dl);
        vm.signAndAttachDelegation(address(impl), pk);
        vm.expectRevert(RescueFee.BadSigner.selector);
        RescueFee(payable(account)).rescue(address(airdrop), cd, _tokens(), false, safe, dl, sig);
    }

    function test_expired_reverts() public {
        bytes memory cd = abi.encodeCall(MockAirdrop.claim, ());
        uint256 dl = block.timestamp - 1;
        bytes memory sig = _sig(pk, address(airdrop), cd, _tokens(), false, safe, dl);
        vm.signAndAttachDelegation(address(impl), pk);
        vm.expectRevert(RescueFee.Expired.selector);
        RescueFee(payable(account)).rescue(address(airdrop), cd, _tokens(), false, safe, dl, sig);
    }

    function test_claim_cannot_target_swept_token() public {
        // transfer-without-fee attempt: claim call aimed directly at the token being swept
        bytes memory cd = abi.encodeWithSignature("transfer(address,uint256)", safe, 1);
        uint256 dl = block.timestamp + 300;
        bytes memory sig = _sig(pk, address(token), cd, _tokens(), false, safe, dl);
        vm.signAndAttachDelegation(address(impl), pk);
        vm.expectRevert(RescueFee.BadParams.selector);
        RescueFee(payable(account)).rescue(address(token), cd, _tokens(), false, safe, dl, sig);
    }

    function test_direct_call_to_implementation_reverts() public {
        bytes memory cd = abi.encodeCall(MockAirdrop.claim, ());
        uint256 dl = block.timestamp + 300;
        bytes memory sig = _sig(pk, address(airdrop), cd, _tokens(), false, safe, dl);
        vm.expectRevert(RescueFee.BadSigner.selector); // signer must equal address(this), which is the implementation here
        impl.rescue(address(airdrop), cd, _tokens(), false, safe, dl, sig);
    }
}
