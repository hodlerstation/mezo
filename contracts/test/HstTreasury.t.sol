// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { MiniTest } from "./utils/MiniTest.sol";
import { HstToken } from "../src/HstToken.sol";
import { HstTreasury } from "../src/HstTreasury.sol";
import { MockUSDT } from "./mocks/MockUSDT.sol";

contract HstTreasuryTest is MiniTest {
    MockUSDT internal usdt;
    HstToken internal hst;
    HstTreasury internal treasury;

    address internal admin = address(0xA11CE);
    address internal operator = address(this);
    address internal payout = address(0xCAFE);
    bytes32 internal acct = keccak256("user-1");

    function setUp() public {
        usdt = new MockUSDT();
        hst = new HstToken(admin);
        treasury = new HstTreasury(admin, address(usdt), address(hst), 6);

        vm.startPrank(admin);
        hst.setOperator(address(treasury), true); // treasury 가 토큰 mint/burn
        treasury.setOperator(operator, true); // 테스트 = 백엔드 operator
        vm.stopPrank();

        // operator 에 USDT 지급 + approve + 담보 예치 1000 USDT
        usdt.mint(operator, 1000e6);
        usdt.approve(address(treasury), type(uint256).max);
        treasury.deposit(1000e6);
    }

    function test_depositCapacity() public view {
        assertEq(treasury.totalDeposited(), 1000e18);
        assertEq(usdt.balanceOf(address(treasury)), 1000e6);
    }

    // ── 담보 발행 (1% 수수료) ──
    function test_collateralizedMint() public {
        uint256 hstOut = treasury.collateralizedMint(acct, 100e6, 100, 0); // 1% fee
        assertEq(hstOut, 99e18);
        (uint256 p,,) = hst.breakdownOf(acct);
        assertEq(p, 99e18);
        assertEq(treasury.totalMinted(), 99e18);
        assertTrue(treasury.isBalanced(), "invariant after mint");
    }

    function test_undercollateralizedReverts() public {
        HstTreasury fresh = new HstTreasury(admin, address(usdt), address(hst), 6);
        vm.startPrank(admin);
        hst.setOperator(address(fresh), true);
        fresh.setOperator(operator, true);
        vm.stopPrank();
        // 담보 예치 없음 → 발행 거부
        vm.expectRevert();
        fresh.collateralizedMint(acct, 100e6, 0, 0);
    }

    // ── Foundation 발행/분배 ──
    function test_foundationMintAndDistribute() public {
        treasury.mintToFoundation(100e18);
        assertEq(treasury.foundationBalance(), 100e18);
        assertEq(treasury.totalMinted(), 100e18);

        treasury.distributeEarnedFromFoundation(acct, 40e18);
        assertEq(treasury.foundationBalance(), 60e18);
        (, uint256 e,) = hst.breakdownOf(acct);
        assertEq(e, 40e18);
        assertEq(treasury.totalMinted(), 100e18, "distribute doesn't mint");
        assertTrue(treasury.isBalanced());
    }

    function test_distributeOrMintEarned() public {
        // foundation 재고 없음 → 신규 발행 경로
        treasury.distributeOrMintEarned(acct, 30e18);
        (, uint256 e,) = hst.breakdownOf(acct);
        assertEq(e, 30e18);
        assertEq(treasury.totalMinted(), 30e18);
        assertTrue(treasury.isBalanced());
    }

    // ── 유저 소비 → Foundation 회수 ──
    function test_consumeUserHst() public {
        treasury.distributeOrMintEarned(acct, 100e18);
        (uint256 fc, uint256 fp, uint256 fe) = treasury.consumeUserHst(acct, 30e18);
        assertEq(fc + fp + fe, 30e18);
        assertEq(treasury.foundationBalance(), 30e18, "consumed to foundation");
        assertEq(hst.balanceOf(acct), 70e18);
        assertTrue(treasury.isBalanced(), "invariant after consume");
    }

    // ── lockup / unlock ──
    function test_lockUnlock() public {
        treasury.distributeOrMintEarned(acct, 100e18);
        treasury.lockFromUser(acct, 40e18);
        assertEq(treasury.lockupBalance(), 40e18);
        assertEq(hst.balanceOf(acct), 60e18);
        assertTrue(treasury.isBalanced());

        treasury.unlockToUserEarned(acct, 40e18);
        assertEq(treasury.lockupBalance(), 0);
        assertEq(hst.balanceOf(acct), 100e18);
        assertTrue(treasury.isBalanced());
    }

    // ── 리딤 (PURCHASED burn + USDT 환급) ──
    function test_redeemPurchased() public {
        treasury.collateralizedMint(acct, 100e6, 0, 0); // 100e18 purchased, lot 0 unlocked
        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;
        treasury.redeemPurchased(acct, 100e18, payout, 100e6, idx);
        assertEq(hst.balanceOf(acct), 0);
        assertEq(treasury.totalMinted(), 0);
        assertEq(usdt.balanceOf(payout), 100e6, "usdt paid out");
        assertTrue(treasury.isBalanced(), "invariant after redeem");
    }

    function test_redeemPayoutExceedsBurnReverts() public {
        treasury.collateralizedMint(acct, 100e6, 0, 0);
        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;
        vm.expectRevert(); // payout 101 USDT > 100 HST burn
        treasury.redeemPurchased(acct, 100e18, payout, 101e6, idx);
    }

    // ── 유저 직접 민팅 헬퍼 (담보 검사) ──
    function test_mintPurchasedToUser() public {
        treasury.mintPurchasedToUser(acct, 50e18, 0);
        (uint256 p,,) = hst.breakdownOf(acct);
        assertEq(p, 50e18);
        assertEq(treasury.totalMinted(), 50e18);
        assertTrue(treasury.isBalanced());
    }

    function test_mintCreditToUser() public {
        treasury.mintCreditToUser(acct, 20e18, uint64(block.timestamp + 30 days));
        (,, uint256 c) = hst.breakdownOf(acct);
        assertEq(c, 20e18);
        assertEq(treasury.totalMinted(), 20e18);
        assertTrue(treasury.isBalanced());
    }

    function test_mintPurchasedUndercollateralizedReverts() public {
        HstTreasury fresh = new HstTreasury(admin, address(usdt), address(hst), 6);
        vm.startPrank(admin);
        hst.setOperator(address(fresh), true);
        fresh.setOperator(operator, true);
        vm.stopPrank();
        vm.expectRevert(); // 담보 없음
        fresh.mintPurchasedToUser(acct, 10e18, 0);
    }

    // ── 순수 소각 (totalMinted 감소) ──
    function test_burnFromUser() public {
        treasury.distributeOrMintEarned(acct, 100e18);
        assertEq(treasury.totalMinted(), 100e18);
        treasury.burnFromUser(acct, HstToken.Source.EARNED, 40e18);
        assertEq(treasury.totalMinted(), 60e18);
        assertEq(hst.balanceOf(acct), 60e18);
        assertTrue(treasury.isBalanced(), "invariant after burn");
    }

    // ── operator gating ──
    function test_nonOperatorCannotMint() public {
        vm.prank(payout);
        vm.expectRevert();
        treasury.collateralizedMint(acct, 100e6, 0, 0);
    }
}
