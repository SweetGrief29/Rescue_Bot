// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Strict public rescue delegate (EIP-7702).
/// The only way out of the account through this contract is `rescue`:
///  1. record the balance of every listed asset,
///  2. run ONE claim call (target must be non-zero),
///  3. charge FEE_BPS of what the claim ADDED (balance after - balance before) to FEE_RECIPIENT,
///  4. sweep the whole balance of each listed asset: fee to FEE_RECIPIENT, the rest to `to`.
/// Balances held before the claim are swept without fee. If no fee is earned the call reverts.
/// No arbitrary batch, no fee parameter, no setter, no owner. Fee and recipient are fixed at deploy.
/// Note: a key holder can always bypass any contract by signing a different delegation
/// themselves; the fee is enforced for transactions sponsored through the service relay.
contract RescueFee {
    uint256 public constant FEE_BPS = 2000; // 20% of the claimed amount, fixed
    uint256 private constant BPS = 10_000;
    uint256 private constant MAX_TOKENS = 8;
    address public immutable FEE_RECIPIENT;
    bytes32 private constant USED_SLOT = keccak256("rescue.fee.used.v1");

    struct Req {
        address claimTarget;
        bytes claimData;
        address[] tokens;
        bool includeNative;
        address to;
        uint256 deadline;
    }

    error Expired();
    error BadParams();
    error BadSigner();
    error Used();
    error ClaimFailed();
    error NoFee();
    error TransferFailed(address asset);

    event FeeCharged(address indexed account, address indexed asset, uint256 fee, uint256 net, address to);

    constructor(address feeRecipient) {
        require(feeRecipient != address(0), "zero recipient");
        FEE_RECIPIENT = feeRecipient;
    }

    receive() external payable {}

    // NFT receivers: without these, ERC721/ERC1155 claims to the delegated account revert.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external pure returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    /// @param claimTarget contract called first (required)
    /// @param tokens ERC-20s to sweep; the fee applies to the amount the claim added
    /// @param includeNative also sweep ETH (fee on ETH the claim added)
    function rescue(
        address claimTarget,
        bytes calldata claimData,
        address[] calldata tokens,
        bool includeNative,
        address to,
        uint256 deadline,
        bytes calldata sig
    ) external {
        Req memory r = Req(claimTarget, claimData, tokens, includeNative, to, deadline);
        _check(r);
        _authorize(r, sig);
        _run(r);
    }

    function _check(Req memory r) private view {
        if (block.timestamp > r.deadline) revert Expired();
        if (r.claimTarget == address(0) || r.claimTarget == address(this) || r.claimTarget == FEE_RECIPIENT) revert BadParams();
        if (r.to == address(0) || r.to == address(this)) revert BadParams();
        uint256 n = r.tokens.length;
        if (n > MAX_TOKENS || (n == 0 && !r.includeNative)) revert BadParams();
        for (uint256 i; i < n; ++i) {
            // the claim call must not be a direct call to a listed token (e.g. a transfer without fee)
            if (r.tokens[i] == r.claimTarget || r.tokens[i] == address(0)) revert BadParams();
        }
    }

    function _authorize(Req memory r, bytes calldata sig) private {
        bytes32 tokensHash = keccak256(abi.encode(r.tokens));
        bytes32 dataHash = keccak256(r.claimData);
        // address(this) is the compromised account when executed through the 7702 delegation
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(this), r.claimTarget, dataHash, tokensHash, r.includeNative, r.to, r.deadline))
        );
        if (ECDSA.recover(digest, sig) != address(this)) revert BadSigner();
        mapping(bytes32 => bool) storage used = _used();
        if (used[digest]) revert Used();
        used[digest] = true; // effects before external calls
    }

    function _run(Req memory r) private {
        uint256 n = r.tokens.length;
        uint256[] memory before = new uint256[](n);
        for (uint256 i; i < n; ++i) before[i] = _balanceOf(r.tokens[i]);
        uint256 nativeBefore = address(this).balance;

        (bool ok, bytes memory ret) = r.claimTarget.call(r.claimData);
        if (!ok) {
            if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
            revert ClaimFailed();
        }

        bool charged;
        for (uint256 i; i < n; ++i) {
            if (_sweepToken(r.tokens[i], before[i], r.to)) charged = true;
        }
        if (r.includeNative && _sweepNative(nativeBefore, r.to)) charged = true;
        if (!charged) revert NoFee();
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || ret.length < 32) revert TransferFailed(token);
        return abi.decode(ret, (uint256));
    }

    function _sweepToken(address token, uint256 balanceBefore, address to) private returns (bool charged) {
        uint256 bal = _balanceOf(token);
        if (bal == 0) return false;
        uint256 gain = bal > balanceBefore ? bal - balanceBefore : 0;
        uint256 fee = (gain * FEE_BPS) / BPS;
        _transfer(token, FEE_RECIPIENT, fee);
        _transfer(token, to, bal - fee);
        emit FeeCharged(address(this), token, fee, bal - fee, to);
        return fee > 0;
    }

    function _transfer(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed(token);
    }

    function _sweepNative(uint256 balanceBefore, address to) private returns (bool charged) {
        uint256 bal = address(this).balance;
        if (bal == 0) return false;
        uint256 gain = bal > balanceBefore ? bal - balanceBefore : 0;
        uint256 fee = (gain * FEE_BPS) / BPS;
        if (fee > 0) {
            (bool okFee,) = FEE_RECIPIENT.call{value: fee}("");
            if (!okFee) revert TransferFailed(address(0));
        }
        (bool ok,) = to.call{value: bal - fee}("");
        if (!ok) revert TransferFailed(address(0));
        emit FeeCharged(address(this), address(0), fee, bal - fee, to);
        return fee > 0;
    }

    function _used() private pure returns (mapping(bytes32 => bool) storage m) {
        bytes32 s = USED_SLOT;
        assembly { m.slot := s }
    }
}
