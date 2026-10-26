// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/** forge cheatcode 인터페이스 (최소). forge-std 의존 없이 테스트하기 위한 vendored 하네스. */
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
    function expectEmit() external;
    function expectEmit(bool, bool, bool, bool) external;
    function label(address, string calldata) external;
}

abstract contract MiniTest {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assertEq(uint) failed");
    }
    function assertEq(address a, address b) internal pure {
        require(a == b, "assertEq(address) failed");
    }
    function assertEq(uint256 a, uint256 b, string memory m) internal pure {
        require(a == b, m);
    }
    function assertTrue(bool c) internal pure {
        require(c, "assertTrue failed");
    }
    function assertTrue(bool c, string memory m) internal pure {
        require(c, m);
    }
    function assertFalse(bool c) internal pure {
        require(!c, "assertFalse failed");
    }
    function assertFalse(bool c, string memory m) internal pure {
        require(!c, m);
    }
}
