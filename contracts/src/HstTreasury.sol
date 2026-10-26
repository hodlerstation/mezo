// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { HstToken } from "./HstToken.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/**
 * @title HstTreasury
 * @notice HST 담보/발행 회계 — USDT 담보를 보관하고, `totalMinted <= totalDeposited`
 *         (미담보 발행 금지) 불변식을 컨트랙트 레벨에서 강제한다.
 *
 * 회계 모델 (DB HstTreasury 와 1:1):
 *   - totalDeposited : USDT 담보 총량 (18-dec 정규화) = 발행 가능 한도
 *   - totalMinted    : 발행된 HST 총량
 *   - foundationBalance : Foundation 재고 HST (운영 자산, 유저 잔고 아님)
 *   - lockupBalance  : 크리에이터 토큰 담보로 잠긴 HST
 *   불변식: totalMinted == hst.totalSupply() + foundationBalance + lockupBalance
 *          그리고 totalMinted <= totalDeposited
 *
 * 모든 mint/burn 은 HstToken 을 호출 → Treasury 는 HstToken 의 operator 로 등록되어야 함.
 * 오프체인(수수료 bps·할인·ETH 오라클·한도)은 operator 가 계산해 인자로 전달.
 *
 * ⚠ 테스트넷 데모용. 실자금 아님.
 */
contract HstTreasury {
    address public admin;
    mapping(address => bool) public isOperator;

    IERC20 public immutable usdt;
    HstToken public immutable hst;
    /** 10 ** (18 - usdtDecimals). USDT(6dec) → HST(18dec) 정규화 배율. */
    uint256 public immutable scale;

    uint256 public totalDeposited; // 18-dec
    uint256 public totalMinted; // 18-dec
    uint256 public foundationBalance; // 18-dec
    uint256 public lockupBalance; // 18-dec

    event AdminTransferred(address indexed prev, address indexed next);
    event OperatorSet(address indexed operator, bool enabled);
    event Deposited(address indexed from, uint256 usdtAmount, uint256 totalDeposited);
    event Minted(bytes32 indexed acct, uint256 hstOut, uint256 usdtIn, uint16 feeBps);
    event FoundationMinted(uint256 amount, uint256 foundationBalance);
    event FoundationDistributed(bytes32 indexed acct, uint256 amount, uint8 src);
    event ConsumedToFoundation(bytes32 indexed acct, uint256 amount, uint256 foundationBalance);
    event LockedFromUser(bytes32 indexed acct, uint256 amount, uint256 lockupBalance);
    event UnlockedToUser(bytes32 indexed acct, uint256 amount, uint256 lockupBalance);
    event Redeemed(bytes32 indexed acct, uint256 hstIn, uint256 usdtOut, address payoutTo);
    event UsdtWithdrawn(address indexed to, uint256 usdtAmount);

    modifier onlyAdmin() {
        require(msg.sender == admin, "TRE: not admin");
        _;
    }
    modifier onlyOperator() {
        require(isOperator[msg.sender], "TRE: not operator");
        _;
    }

    constructor(address _admin, address _usdt, address _hst, uint8 _usdtDecimals) {
        require(_admin != address(0) && _usdt != address(0) && _hst != address(0), "TRE: zero addr");
        require(_usdtDecimals <= 18, "TRE: bad decimals");
        admin = _admin;
        usdt = IERC20(_usdt);
        hst = HstToken(_hst);
        scale = 10 ** (18 - _usdtDecimals);
        emit AdminTransferred(address(0), _admin);
    }

    function transferAdmin(address next) external onlyAdmin {
        require(next != address(0), "TRE: zero admin");
        emit AdminTransferred(admin, next);
        admin = next;
    }
    function setOperator(address op, bool enabled) external onlyAdmin {
        isOperator[op] = enabled;
        emit OperatorSet(op, enabled);
    }

    // ─── 담보 예치 ─────────────────────────────────────────────
    /** USDT 담보 예치 → 발행 한도 증가. caller 는 사전 approve 필요. */
    function deposit(uint256 usdtAmount) external onlyOperator {
        require(usdtAmount > 0, "TRE: zero amount");
        require(usdt.transferFrom(msg.sender, address(this), usdtAmount), "TRE: usdt pull fail");
        totalDeposited += usdtAmount * scale;
        emit Deposited(msg.sender, usdtAmount, totalDeposited);
    }

    // ─── 담보 발행 (USDT→HST 민팅) ──────────────────────────────
    function collateralizedMint(bytes32 acct, uint256 usdtIn, uint16 feeBps, uint64 lockedUntil)
        external onlyOperator
        returns (uint256 hstOut)
    {
        require(usdtIn > 0, "TRE: zero amount");
        require(feeBps <= 10000, "TRE: bad fee");
        uint256 gross = usdtIn * scale;
        uint256 fee = (gross * feeBps) / 10000;
        hstOut = gross - fee; // 1:1 페그 - 수수료
        require(hstOut > 0, "TRE: zero out");
        require(totalMinted + hstOut <= totalDeposited, "TRE: undercollateralized");
        totalMinted += hstOut;
        hst.creditPurchased(acct, hstOut, lockedUntil, _toU128(usdtIn));
        emit Minted(acct, hstOut, usdtIn, feeBps);
        _checkInvariant();
    }

    // ─── Foundation 발행/분배 ──────────────────────────────────
    function mintToFoundation(uint256 amount) external onlyOperator {
        require(amount > 0, "TRE: zero amount");
        require(totalMinted + amount <= totalDeposited, "TRE: undercollateralized");
        totalMinted += amount;
        foundationBalance += amount;
        emit FoundationMinted(amount, foundationBalance);
        _checkInvariant();
    }

    function distributeEarnedFromFoundation(bytes32 acct, uint256 amount) external onlyOperator {
        require(amount > 0 && foundationBalance >= amount, "TRE: foundation short");
        foundationBalance -= amount;
        hst.creditEarned(acct, amount);
        emit FoundationDistributed(acct, amount, uint8(HstToken.Source.EARNED));
        _checkInvariant();
    }

    function distributeCreditFromFoundation(bytes32 acct, uint256 amount, uint64 expiresAt) external onlyOperator {
        require(amount > 0 && foundationBalance >= amount, "TRE: foundation short");
        foundationBalance -= amount;
        hst.creditCredit(acct, amount, expiresAt);
        emit FoundationDistributed(acct, amount, uint8(HstToken.Source.CREDIT));
        _checkInvariant();
    }

    /** 신규 발행 없이 유저에게 EARNED 지급 — Foundation 재고 부족 시 신규 발행(담보 한도 검사). */
    function distributeOrMintEarned(bytes32 acct, uint256 amount) external onlyOperator {
        require(amount > 0, "TRE: zero amount");
        uint256 fromFoundation = amount <= foundationBalance ? amount : foundationBalance;
        uint256 toMint = amount - fromFoundation;
        if (toMint > 0) {
            require(totalMinted + toMint <= totalDeposited, "TRE: undercollateralized");
            totalMinted += toMint;
        }
        if (fromFoundation > 0) foundationBalance -= fromFoundation;
        hst.creditEarned(acct, amount);
        emit FoundationDistributed(acct, amount, uint8(HstToken.Source.EARNED));
        _checkInvariant();
    }

    /** 유저에게 PURCHASED 신규 발행 (담보 한도 검사 + totalMinted 증가). 구매/스왑민팅/환불 경로. */
    function mintPurchasedToUser(bytes32 acct, uint256 amount, uint64 lockedUntil) external onlyOperator {
        require(amount > 0, "TRE: zero amount");
        require(totalMinted + amount <= totalDeposited, "TRE: undercollateralized");
        totalMinted += amount;
        hst.creditPurchased(acct, amount, lockedUntil, 0);
        emit FoundationDistributed(acct, amount, uint8(HstToken.Source.PURCHASED));
        _checkInvariant();
    }

    /** 유저에게 CREDIT 신규 발행 (담보 한도 검사 + totalMinted 증가). 월 분배/미션 크레딧 경로. */
    function mintCreditToUser(bytes32 acct, uint256 amount, uint64 expiresAt) external onlyOperator {
        require(amount > 0, "TRE: zero amount");
        require(totalMinted + amount <= totalDeposited, "TRE: undercollateralized");
        totalMinted += amount;
        hst.creditCredit(acct, amount, expiresAt);
        emit FoundationDistributed(acct, amount, uint8(HstToken.Source.CREDIT));
        _checkInvariant();
    }

    /** 유저 잔고 소각 (totalMinted 감소, 불변식 유지). 리딤(EARNED)·전환·만료 등 순수 소각 경로. */
    function burnFromUser(bytes32 acct, HstToken.Source src, uint256 amount) external onlyOperator {
        require(amount > 0, "TRE: zero amount");
        hst.debit(acct, src, amount);
        totalMinted -= amount;
        emit ConsumedToFoundation(acct, amount, foundationBalance); // 재사용 (foundation 미변경)
        _checkInvariant();
    }

    // ─── 유저 소비 → Foundation 회수 ────────────────────────────
    function consumeUserHst(bytes32 acct, uint256 amount)
        external onlyOperator
        returns (uint256 fromCredit, uint256 fromPurchased, uint256 fromEarned)
    {
        require(amount > 0, "TRE: zero amount");
        (fromCredit, fromPurchased, fromEarned) = hst.debitAuto(acct, amount);
        foundationBalance += amount;
        emit ConsumedToFoundation(acct, amount, foundationBalance);
        _checkInvariant();
    }

    // ─── 크리에이터 토큰 담보 lock/unlock ──────────────────────
    function lockFromUser(bytes32 acct, uint256 amount) external onlyOperator {
        require(amount > 0, "TRE: zero amount");
        hst.debitAuto(acct, amount);
        lockupBalance += amount;
        emit LockedFromUser(acct, amount, lockupBalance);
        _checkInvariant();
    }

    function unlockToUserEarned(bytes32 acct, uint256 amount) external onlyOperator {
        require(amount > 0 && lockupBalance >= amount, "TRE: lockup short");
        lockupBalance -= amount;
        hst.creditEarned(acct, amount);
        emit UnlockedToUser(acct, amount, lockupBalance);
        _checkInvariant();
    }

    // ─── 리딤 (PURCHASED burn + USDT 환급) ──────────────────────
    function redeemPurchased(
        bytes32 acct,
        uint256 hstAmount,
        address payoutTo,
        uint256 payoutUsdt,
        uint256[] calldata lotIdx
    ) external onlyOperator {
        require(hstAmount > 0, "TRE: zero amount");
        require(payoutTo != address(0), "TRE: zero payout");
        require(payoutUsdt * scale <= hstAmount, "TRE: payout exceeds burn");
        hst.consumePurchasedLots(acct, lotIdx, hstAmount);
        totalMinted -= hstAmount;
        if (payoutUsdt > 0) {
            totalDeposited -= payoutUsdt * scale;
            require(usdt.transfer(payoutTo, payoutUsdt), "TRE: usdt payout fail");
        }
        emit Redeemed(acct, hstAmount, payoutUsdt, payoutTo);
        _checkInvariant();
    }

    /** 운영 수익(수수료) USDT 인출 — 담보 미배정분만. */
    function withdrawUsdt(address to, uint256 usdtAmount) external onlyAdmin {
        require(to != address(0) && usdtAmount > 0, "TRE: bad withdraw");
        // 담보로 배정된 USDT(totalDeposited 대비)는 남겨야 함
        uint256 bal = usdt.balanceOf(address(this));
        uint256 backing = totalDeposited / scale;
        require(bal >= backing + usdtAmount, "TRE: would breach backing");
        require(usdt.transfer(to, usdtAmount), "TRE: usdt withdraw fail");
        emit UsdtWithdrawn(to, usdtAmount);
    }

    // ─── Views ─────────────────────────────────────────────────
    function isBalanced() public view returns (bool) {
        return totalMinted == hst.totalSupply() + foundationBalance + lockupBalance
            && totalMinted <= totalDeposited;
    }

    function treasuryState()
        external view
        returns (
            uint256 _totalDeposited,
            uint256 _totalMinted,
            uint256 _foundationBalance,
            uint256 _lockupBalance,
            uint256 _hstSupply,
            bool _isBalanced
        )
    {
        return (
            totalDeposited,
            totalMinted,
            foundationBalance,
            lockupBalance,
            hst.totalSupply(),
            isBalanced()
        );
    }

    // ─── Internal ──────────────────────────────────────────────
    /** 불변식 강제: minted == supply + foundation + lockup, minted <= deposited. */
    function _checkInvariant() internal view {
        require(
            totalMinted == hst.totalSupply() + foundationBalance + lockupBalance,
            "TRE: invariant broken (minted != supply+foundation+lockup)"
        );
        require(totalMinted <= totalDeposited, "TRE: invariant broken (minted > deposited)");
    }

    function _toU128(uint256 v) internal pure returns (uint128) {
        require(v <= type(uint128).max, "TRE: u128 overflow");
        return uint128(v);
    }
}
