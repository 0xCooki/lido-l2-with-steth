// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.10;

/// @dev A copy of UnstructuredRefStorage.sol library from Lido on Ethereum protocol.
///      https://github.com/lidofinance/lido-dao/blob/master/contracts/0.8.9/lib/UnstructuredRefStorage.sol
library UnstructuredRefStorage {
    function storageMapAddressMapAddressUint256(bytes32 _position) internal pure returns (
        mapping(address => mapping(address => uint256)) storage result
    ) {
        assembly { result.slot := _position }
    }

    function storageMapAddressAddressUint256(bytes32 _position) internal pure returns (
        mapping(address => uint256) storage result
    ) {
        assembly { result.slot := _position }
    }
}
