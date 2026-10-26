// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { MiniTest } from "./utils/MiniTest.sol";
import { HstToken } from "../src/HstToken.sol";

contract HstTokenTest is MiniTest {
    HstToken internal token;
    address internal admin = address(0xA11CE);
    address internal operator = address(this);
    address internal stranger = address(0xBEEF);
    bytes32 internal acct = keccak256("user-1");
    bytes32 internal acct2 = keccak256("user-2");

    function setUp() public {
        token = new HstToken(admin);
        vm.prank(admin);
        token.setOperator(operator, true);
    }

    // ── credit / breakdown ──
    function test_creditAndBreakdown() public {
        token.creditPurchased(acct, 100e18, 0, 100e6);
        token.creditEarned(acct, 50e18);
        token.creditCredit(acct, 30e18, uint64(block.timestamp + 1 days));
        assertEq(token.balanceOf(acct), 180e18);
        (uint256 p, uint256 e, uint256 c) = token.breakdownOf(acct);
        assertEq(p, 100e18);
        assertEq(e, 50e18);
        assertEq(c, 30e18);
        assertEq(token.totalSupply(), 180e18);
    }

    // ── debitAuto 우선순위: CREDIT → PURCHASED → EARNED ──
    function test_debitAutoPriority() public {
        token.creditCredit(acct, 30e18, uint64(block.timestamp + 1 days));
        token.creditPurchased(acct, 100e18, 0, 0);
        token.creditEarned(acct, 50e18);
        (uint256 fc, uint256 fp, uint256 fe) = token.debitAuto(acct, 120e18);
        assertEq(fc, 30e18, "credit first");
        assertEq(fp, 90e18, "then purchased");
        assertEq(fe, 0, "earned untouched");
        (uint256 p, uint256 e, uint256 c) = token.breakdownOf(acct);
        assertEq(p, 10e18);
        assertEq(e, 50e18);
        assertEq(c, 0);
        assertEq(token.balanceOf(acct), 60e18);
    }

    function test_debitAutoSpillsToEarned() public {
        token.creditCredit(acct, 10e18, uint64(block.timestamp + 1 days));
        token.creditPurchased(acct, 20e18, 0, 0);
        token.creditEarned(acct, 40e18);
        (uint256 fc, uint256 fp, uint256 fe) = token.debitAuto(acct, 55e18);
        assertEq(fc, 10e18);
        assertEq(fp, 20e18);
        assertEq(fe, 25e18);
        assertEq(token.balanceOf(acct), 15e18);
    }

    function test_debitAutoInsufficientReverts() public {
        token.creditEarned(acct, 10e18);
        vm.expectRevert();
        token.debitAuto(acct, 1000e18);
    }

    // ── debit per source ──
    function test_debitSource() public {
        token.creditEarned(acct, 100e18);
        token.debit(acct, HstToken.Source.EARNED, 40e18);
        (, uint256 e,) = token.breakdownOf(acct);
        assertEq(e, 60e18);
        assertEq(token.totalSupply(), 60e18);
    }

    function test_debitInsufficientReverts() public {
        token.creditEarned(acct, 10e18);
        vm.expectRevert();
        token.debit(acct, HstToken.Source.EARNED, 100e18);
    }

    // ── operator gating ──
    function test_nonOperatorCannotMint() public {
        vm.prank(stranger);
        vm.expectRevert();
        token.creditEarned(acct, 10e18);
    }

    // ── move ──
    function test_move() public {
        token.creditEarned(acct, 100e18);
        token.move(acct, acct2, HstToken.Source.EARNED, 40e18);
        (, uint256 e1,) = token.breakdownOf(acct);
        (, uint256 e2,) = token.breakdownOf(acct2);
        assertEq(e1, 60e18);
        assertEq(e2, 40e18);
        assertEq(token.totalSupply(), 100e18, "supply preserved on move");
    }

    // ── consumePurchasedLots (FIFO redeem) ──
    function test_consumePurchasedLotsFifo() public {
        token.creditPurchased(acct, 30e18, 0, 0);
        token.creditPurchased(acct, 40e18, 0, 0);
        token.creditPurchased(acct, 50e18, 0, 0);
        uint256[] memory idx = new uint256[](2);
        idx[0] = 0;
        idx[1] = 1;
        token.consumePurchasedLots(acct, idx, 70e18);
        (uint256 p,,) = token.breakdownOf(acct);
        assertEq(p, 50e18);
        assertEq(token.totalSupply(), 50e18);
    }

    function test_consumeLockedLotReverts() public {
        token.creditPurchased(acct, 30e18, uint64(block.timestamp + 1000), 0);
        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;
        vm.expectRevert();
        token.consumePurchasedLots(acct, idx, 30e18);
    }

    function test_consumeNonAscendingIdxReverts() public {
        token.creditPurchased(acct, 30e18, 0, 0);
        token.creditPurchased(acct, 40e18, 0, 0);
        uint256[] memory idx = new uint256[](2);
        idx[0] = 1;
        idx[1] = 0;
        vm.expectRevert();
        token.consumePurchasedLots(acct, idx, 70e18);
    }

    function test_consumeUnderfilledReverts() public {
        token.creditPurchased(acct, 30e18, 0, 0);
        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;
        vm.expectRevert(); // idx 커버 30 < 요청 50
        token.consumePurchasedLots(acct, idx, 50e18);
    }

    // ── purchasedUnlocked ──
    function test_purchasedUnlocked() public {
        token.creditPurchased(acct, 30e18, 0, 0); // unlocked
        uint64 lockTs = uint64(block.timestamp + 100);
        token.creditPurchased(acct, 40e18, lockTs, 0); // locked
        (uint256 unlocked, uint64 nextAt) = token.purchasedUnlocked(acct);
        assertEq(unlocked, 30e18);
        assertEq(uint256(nextAt), uint256(lockTs));
    }

    // ── CREDIT 만료 ──
    function test_expireCreditLots() public {
        uint64 exp = uint64(block.timestamp + 10);
        token.creditCredit(acct, 25e18, exp);
        vm.warp(block.timestamp + 20);
        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;
        token.expireCreditLots(acct, idx);
        (,, uint256 c) = token.breakdownOf(acct);
        assertEq(c, 0);
        assertEq(token.balanceOf(acct), 0);
    }

    // ── 글로벌 sourceType 집계 ──
    function test_globalBreakdown() public {
        token.creditPurchased(acct, 100e18, 0, 0);
        token.creditEarned(acct2, 60e18);
        token.creditCredit(acct, 30e18, uint64(block.timestamp + 1 days));
        (uint256 gp, uint256 ge, uint256 gc) = token.globalBreakdown();
        assertEq(gp, 100e18);
        assertEq(ge, 60e18);
        assertEq(gc, 30e18);
        // debitAuto 후 집계 감소
        token.debitAuto(acct, 120e18); // credit 30 + purchased 90
        (gp, ge, gc) = token.globalBreakdown();
        assertEq(gp, 10e18);
        assertEq(ge, 60e18);
        assertEq(gc, 0);
        assertEq(gp + ge + gc, token.totalSupply());
    }

    function test_expireNotExpiredReverts() public {
        token.creditCredit(acct, 25e18, uint64(block.timestamp + 1000));
        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;
        vm.expectRevert();
        token.expireCreditLots(acct, idx);
    }
}
