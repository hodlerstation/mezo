// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title HstToken
 * @notice HodlerStation HST 온체인 원장 — 3종 sourceType sub-balance(PURCHASED/EARNED/CREDIT)
 *         + PURCHASED 락업 lot + CREDIT 만료 lot 을 온체인 state 로 보유한다.
 *
 * 설계:
 *   - 계정 = bytes32 accountId (= keccak256(userId)). custodial — 유저 지갑/가스 불필요.
 *   - operator(백엔드 서명자)만 mint/burn/move. HstTreasury 도 operator 로 등록.
 *   - aggregate-authoritative: _purchased/_earned/_credit 총액이 지출 권위값(O(1)).
 *     lot 배열은 redeem 적격성/쿨다운/만료 판정 메타. FIFO 소비는 operator 가 idx 전달 → 컨트랙트 검증.
 *   - 모든 상태 변화는 이벤트로 방출(백엔드 인덱서가 Postgres 미러 수화).
 *
 * ⚠ 테스트넷(GIWA/BSC) 데모용. 실자금 아님.
 */
contract HstToken {
    // ─── Roles ───────────────────────────────────────────────
    address public admin;
    mapping(address => bool) public isOperator;

    event AdminTransferred(address indexed prev, address indexed next);
    event OperatorSet(address indexed operator, bool enabled);

    modifier onlyAdmin() {
        require(msg.sender == admin, "HST: not admin");
        _;
    }
    modifier onlyOperator() {
        require(isOperator[msg.sender], "HST: not operator");
        _;
    }

    // ─── Sub-balances (aggregate = 권위값) ──────────────────────
    enum Source { PURCHASED, EARNED, CREDIT }

    mapping(bytes32 => uint256) private _purchased;
    mapping(bytes32 => uint256) private _earned;
    mapping(bytes32 => uint256) private _credit;
    uint256 public totalSupply;

    // 글로벌 sourceType 집계 (오프체인 /hst 분리 회계용). 모든 mutation 에서 갱신.
    uint256 public totalPurchased;
    uint256 public totalEarned;
    uint256 public totalCredit;

    // ─── Lots ────────────────────────────────────────────────
    struct PurchasedLot {
        uint128 amount;     // 남은 수량 (소진 시 0)
        uint64  mintedAt;   // 발행 시각 (7일 청약철회 윈도우 판정 — 값 산정은 오프체인)
        uint64  lockedUntil;// 쿨다운 종료(0 = 즉시 unlocked)
        uint128 usdtIn;     // 담보 USDT (환급 계산 메타)
    }
    struct CreditLot {
        uint128 amount;     // 남은 수량
        uint64  expiresAt;  // 만료 시각
    }

    mapping(bytes32 => PurchasedLot[]) private _pLots;
    mapping(bytes32 => uint256) private _pHead; // 소진 완료 lot skip 포인터
    mapping(bytes32 => CreditLot[]) private _cLots;
    mapping(bytes32 => uint256) private _cHead;

    // ─── Events (인덱서 소스) ───────────────────────────────────
    event CreditPurchased(bytes32 indexed acct, uint256 amount, uint64 lockedUntil, uint128 usdtIn, uint256 lotIndex);
    event CreditEarned(bytes32 indexed acct, uint256 amount);
    event CreditCredit(bytes32 indexed acct, uint256 amount, uint64 expiresAt, uint256 lotIndex);
    event Debited(bytes32 indexed acct, uint8 src, uint256 amount);
    event DebitedAuto(bytes32 indexed acct, uint256 fromCredit, uint256 fromPurchased, uint256 fromEarned);
    event Moved(bytes32 indexed from, bytes32 indexed to, uint8 src, uint256 amount);
    event LotConsumed(bytes32 indexed acct, uint256 lotIndex, uint256 amount);
    event LotExpired(bytes32 indexed acct, uint256 lotIndex, uint256 amount);

    constructor(address _admin) {
        require(_admin != address(0), "HST: zero admin");
        admin = _admin;
        emit AdminTransferred(address(0), _admin);
    }

    // ─── Role admin ──────────────────────────────────────────
    function transferAdmin(address next) external onlyAdmin {
        require(next != address(0), "HST: zero admin");
        emit AdminTransferred(admin, next);
        admin = next;
    }
    function setOperator(address op, bool enabled) external onlyAdmin {
        isOperator[op] = enabled;
        emit OperatorSet(op, enabled);
    }

    // ─── Credit (mint) — operator only ──────────────────────────
    function creditPurchased(bytes32 acct, uint256 amount, uint64 lockedUntil, uint128 usdtIn)
        external onlyOperator
    {
        require(amount > 0, "HST: zero amount");
        _purchased[acct] += amount;
        totalSupply += amount;
        totalPurchased += amount;
        _pLots[acct].push(PurchasedLot({
            amount: _toU128(amount),
            mintedAt: uint64(block.timestamp),
            lockedUntil: lockedUntil,
            usdtIn: usdtIn
        }));
        emit CreditPurchased(acct, amount, lockedUntil, usdtIn, _pLots[acct].length - 1);
    }

    function creditEarned(bytes32 acct, uint256 amount) external onlyOperator {
        require(amount > 0, "HST: zero amount");
        _earned[acct] += amount;
        totalSupply += amount;
        totalEarned += amount;
        emit CreditEarned(acct, amount);
    }

    function creditCredit(bytes32 acct, uint256 amount, uint64 expiresAt) external onlyOperator {
        require(amount > 0, "HST: zero amount");
        _credit[acct] += amount;
        totalSupply += amount;
        totalCredit += amount;
        _cLots[acct].push(CreditLot({ amount: _toU128(amount), expiresAt: expiresAt }));
        emit CreditCredit(acct, amount, expiresAt, _cLots[acct].length - 1);
    }

    // ─── Debit (burn) — operator only, aggregate O(1) ───────────
    function debit(bytes32 acct, Source src, uint256 amount) external onlyOperator {
        _debit(acct, src, amount);
    }

    function _debit(bytes32 acct, Source src, uint256 amount) internal {
        require(amount > 0, "HST: zero amount");
        if (src == Source.PURCHASED) {
            require(_purchased[acct] >= amount, "HST: insufficient purchased");
            _purchased[acct] -= amount;
            totalPurchased -= amount;
            _reducePurchasedLots(acct, amount);
        } else if (src == Source.EARNED) {
            require(_earned[acct] >= amount, "HST: insufficient earned");
            _earned[acct] -= amount;
            totalEarned -= amount;
        } else {
            require(_credit[acct] >= amount, "HST: insufficient credit");
            _credit[acct] -= amount;
            totalCredit -= amount;
            _reduceCreditLots(acct, amount);
        }
        totalSupply -= amount;
        emit Debited(acct, uint8(src), amount);
    }

    /**
     * @notice HST 우선순위 소비: CREDIT → PURCHASED → EARNED. aggregate 차감(O(1)).
     */
    function debitAuto(bytes32 acct, uint256 amount)
        external onlyOperator
        returns (uint256 fromCredit, uint256 fromPurchased, uint256 fromEarned)
    {
        require(amount > 0, "HST: zero amount");
        require(_purchased[acct] + _earned[acct] + _credit[acct] >= amount, "HST: insufficient balance");
        uint256 remaining = amount;

        uint256 c = _credit[acct];
        if (c > 0) {
            fromCredit = c >= remaining ? remaining : c;
            _credit[acct] = c - fromCredit;
            totalCredit -= fromCredit;
            remaining -= fromCredit;
            _reduceCreditLots(acct, fromCredit);
        }
        if (remaining > 0) {
            uint256 p = _purchased[acct];
            fromPurchased = p >= remaining ? remaining : p;
            _purchased[acct] = p - fromPurchased;
            totalPurchased -= fromPurchased;
            remaining -= fromPurchased;
            _reducePurchasedLots(acct, fromPurchased);
        }
        if (remaining > 0) {
            fromEarned = remaining; // 위 require 로 충분성 보장
            _earned[acct] -= fromEarned;
            totalEarned -= fromEarned;
            remaining = 0;
        }
        totalSupply -= amount;
        emit DebitedAuto(acct, fromCredit, fromPurchased, fromEarned);
    }

    // ─── Move (P2P / pool) — operator only ──────────────────────
    function move(bytes32 from, bytes32 to, Source src, uint256 amount) external onlyOperator {
        require(amount > 0, "HST: zero amount");
        if (src == Source.PURCHASED) {
            require(_purchased[from] >= amount, "HST: insufficient purchased");
            _purchased[from] -= amount;
            _reducePurchasedLots(from, amount);
            _purchased[to] += amount;
            // 이동분은 락 해제 상태(신규 lot, 즉시 unlocked)로 부여
            _pLots[to].push(PurchasedLot({ amount: _toU128(amount), mintedAt: uint64(block.timestamp), lockedUntil: 0, usdtIn: 0 }));
        } else if (src == Source.EARNED) {
            require(_earned[from] >= amount, "HST: insufficient earned");
            _earned[from] -= amount;
            _earned[to] += amount;
        } else {
            require(_credit[from] >= amount, "HST: insufficient credit");
            _credit[from] -= amount;
            _reduceCreditLots(from, amount);
            _credit[to] += amount;
            _cLots[to].push(CreditLot({ amount: _toU128(amount), expiresAt: 0 }));
        }
        emit Moved(from, to, uint8(src), amount);
    }

    // ─── Redeem: 특정 PURCHASED lot 소비 (FIFO, operator 가 idx 검증값 제출) ──
    function consumePurchasedLots(bytes32 acct, uint256[] calldata idx, uint256 amount) external onlyOperator {
        require(amount > 0, "HST: zero amount");
        require(_purchased[acct] >= amount, "HST: insufficient purchased");
        uint256 remaining = amount;
        uint256 prev = 0;
        bool first = true;
        PurchasedLot[] storage lots = _pLots[acct];
        for (uint256 i = 0; i < idx.length; i++) {
            uint256 li = idx[i];
            require(li < lots.length, "HST: bad lot idx");
            require(first || li > prev, "HST: idx not ascending");
            first = false;
            prev = li;
            PurchasedLot storage lot = lots[li];
            require(lot.amount > 0, "HST: lot empty");
            require(lot.lockedUntil == 0 || lot.lockedUntil <= block.timestamp, "HST: lot locked");
            uint256 take = lot.amount >= remaining ? remaining : lot.amount;
            lot.amount = uint128(lot.amount - take);
            remaining -= take;
            emit LotConsumed(acct, li, take);
            if (remaining == 0) break;
        }
        require(remaining == 0, "HST: idx underfilled");
        _purchased[acct] -= amount;
        totalPurchased -= amount;
        totalSupply -= amount;
        emit Debited(acct, uint8(Source.PURCHASED), amount);
        _advancePurchasedHead(acct);
    }

    // ─── CREDIT 만료 소각 (operator, 만료 lot idx 제출) ───────────
    function expireCreditLots(bytes32 acct, uint256[] calldata idx) external onlyOperator {
        CreditLot[] storage lots = _cLots[acct];
        uint256 burned = 0;
        for (uint256 i = 0; i < idx.length; i++) {
            uint256 li = idx[i];
            require(li < lots.length, "HST: bad lot idx");
            CreditLot storage lot = lots[li];
            if (lot.amount == 0) continue;
            require(lot.expiresAt != 0 && lot.expiresAt <= block.timestamp, "HST: lot not expired");
            uint256 amt = lot.amount;
            lot.amount = 0;
            burned += amt;
            emit LotExpired(acct, li, amt);
        }
        if (burned > 0) {
            require(_credit[acct] >= burned, "HST: credit underflow");
            _credit[acct] -= burned;
            totalCredit -= burned;
            totalSupply -= burned;
            emit Debited(acct, uint8(Source.CREDIT), burned);
        }
        _advanceCreditHead(acct);
    }

    // ─── Lot 감소 헬퍼 (FIFO, head 부터) ────────────────────────
    function _reducePurchasedLots(bytes32 acct, uint256 amount) internal {
        PurchasedLot[] storage lots = _pLots[acct];
        uint256 h = _pHead[acct];
        uint256 remaining = amount;
        while (remaining > 0 && h < lots.length) {
            uint256 la = lots[h].amount;
            if (la == 0) { h++; continue; }
            if (la <= remaining) {
                remaining -= la;
                lots[h].amount = 0;
                h++;
            } else {
                lots[h].amount = uint128(la - remaining);
                remaining = 0;
            }
        }
        _pHead[acct] = h;
        // remaining>0 이어도 aggregate 는 이미 호출부에서 차감됨 — lot 은 메타이므로 tolerate
    }

    function _reduceCreditLots(bytes32 acct, uint256 amount) internal {
        CreditLot[] storage lots = _cLots[acct];
        uint256 h = _cHead[acct];
        uint256 remaining = amount;
        while (remaining > 0 && h < lots.length) {
            uint256 la = lots[h].amount;
            if (la == 0) { h++; continue; }
            if (la <= remaining) {
                remaining -= la;
                lots[h].amount = 0;
                h++;
            } else {
                lots[h].amount = uint128(la - remaining);
                remaining = 0;
            }
        }
        _cHead[acct] = h;
    }

    function _advancePurchasedHead(bytes32 acct) internal {
        PurchasedLot[] storage lots = _pLots[acct];
        uint256 h = _pHead[acct];
        while (h < lots.length && lots[h].amount == 0) h++;
        _pHead[acct] = h;
    }
    function _advanceCreditHead(bytes32 acct) internal {
        CreditLot[] storage lots = _cLots[acct];
        uint256 h = _cHead[acct];
        while (h < lots.length && lots[h].amount == 0) h++;
        _cHead[acct] = h;
    }

    // ─── Views (ERC20-호환 스타일) ──────────────────────────────
    function balanceOf(bytes32 acct) public view returns (uint256) {
        return _purchased[acct] + _earned[acct] + _credit[acct];
    }
    function breakdownOf(bytes32 acct) external view returns (uint256 purchased, uint256 earned, uint256 credit) {
        return (_purchased[acct], _earned[acct], _credit[acct]);
    }
    /** 글로벌 sourceType 유통량 집계 (오프체인 /hst 분리 회계). */
    function globalBreakdown() external view returns (uint256 purchased, uint256 earned, uint256 credit) {
        return (totalPurchased, totalEarned, totalCredit);
    }
    /** PURCHASED 중 unlocked(환급가능) 잔량 + 가장 빠른 next unlock 시각. */
    function purchasedUnlocked(bytes32 acct) external view returns (uint256 unlocked, uint64 nextUnlockAt) {
        PurchasedLot[] storage lots = _pLots[acct];
        uint256 nextTs = type(uint64).max;
        for (uint256 i = _pHead[acct]; i < lots.length; i++) {
            PurchasedLot storage lot = lots[i];
            if (lot.amount == 0) continue;
            if (lot.lockedUntil == 0 || lot.lockedUntil <= block.timestamp) {
                unlocked += lot.amount;
            } else if (lot.lockedUntil < nextTs) {
                nextTs = lot.lockedUntil;
            }
        }
        nextUnlockAt = nextTs == type(uint64).max ? 0 : uint64(nextTs);
    }
    function purchasedLotCount(bytes32 acct) external view returns (uint256) { return _pLots[acct].length; }
    function creditLotCount(bytes32 acct) external view returns (uint256) { return _cLots[acct].length; }
    function purchasedLotAt(bytes32 acct, uint256 i) external view returns (PurchasedLot memory) { return _pLots[acct][i]; }
    function creditLotAt(bytes32 acct, uint256 i) external view returns (CreditLot memory) { return _cLots[acct][i]; }

    // 메타데이터 (explorer 표기)
    string public constant name = "HodlerStation HST";
    string public constant symbol = "HST";
    uint8 public constant decimals = 18;

    function _toU128(uint256 v) internal pure returns (uint128) {
        require(v <= type(uint128).max, "HST: u128 overflow");
        return uint128(v);
    }
}
