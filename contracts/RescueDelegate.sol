// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Delegate EIP-7702 minimal untuk rescue wallet yang private key-nya bocor.
/// Hanya menjalankan batch call yang ditandatangani oleh akun itu sendiri,
/// jadi sponsor gas tidak bisa mengubah isi transaksi.
contract RescueDelegate {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    // slot khusus agar tidak bentrok dengan storage delegasi lain
    bytes32 private constant USED_SLOT = keccak256("rescue.delegate.used.v1");

    error Expired();
    error BadSigner();
    error Used();
    error CallFailed(uint256 index);

    receive() external payable {}

    // Penerima NFT: tanpa ini, klaim/mint ERC721/ERC1155 ke wallet berdelegasi akan revert.
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

    function execute(Call[] calldata calls, uint256 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert Expired();

        // Saat dijalankan lewat delegasi 7702, address(this) = wallet bocor.
        // Jika dipanggil langsung ke kontrak implementasi, signer tidak akan pernah cocok.
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(this), keccak256(abi.encode(calls)), deadline))
        );
        if (ECDSA.recover(digest, sig) != address(this)) revert BadSigner();

        mapping(bytes32 => bool) storage used = _used();
        if (used[digest]) revert Used();
        used[digest] = true;

        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                // teruskan alasan revert dari kontrak tujuan agar mudah di-debug
                if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
                revert CallFailed(i);
            }
        }
    }

    /// Kirim seluruh saldo token ke `to`. Hanya bisa dipanggil lewat batch (self-call).
    function sweepToken(address token, address to) external {
        require(msg.sender == address(this), "only self");
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok && ret.length >= 32, "balanceOf failed");
        (ok,) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, abi.decode(ret, (uint256))));
        require(ok, "transfer failed");
    }

    function _used() private pure returns (mapping(bytes32 => bool) storage m) {
        bytes32 s = USED_SLOT;
        assembly { m.slot := s }
    }
}
