// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { HstToken } from "../src/HstToken.sol";
import { HstTreasury } from "../src/HstTreasury.sol";

interface VmBroadcast {
    function startBroadcast() external;
    function stopBroadcast() external;
    function envAddress(string calldata) external view returns (address);
    function envOr(string calldata, address) external view returns (address);
    function envOr(string calldata, uint256) external view returns (uint256);
}

/**
 * HstToken + HstTreasury 배포 + operator 배선.
 *
 * 사용 (GIWA):
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url $GIWA_RPC_URL --broadcast --private-key $KEY \
 *     --verify --verifier blockscout --verifier-url https://sepolia-explorer.giwa.io/api
 *
 * 사용 (Mezo Testnet, 담보 = MUSD 18 dec):
 *   HST_ADMIN=<operator> HST_USDT=0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 HST_USDT_DECIMALS=18 \
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url https://rpc.test.mezo.org --broadcast --private-key $KEY \
 *     --verify --verifier blockscout --verifier-url https://api.explorer.test.mezo.org/api
 *
 * env:
 *   HST_ADMIN         : admin/operator 주소 (백엔드 HST_OPERATOR 지갑)
 *   HST_USDT          : 담보 토큰 컨트랙트 (GIWA 테스트 USDT / Mezo MUSD)
 *   HST_USDT_DECIMALS : 담보 토큰 decimals (기본 6 — GIWA TUSDT. Mezo MUSD 는 18)
 */
contract Deploy {
    VmBroadcast constant vm = VmBroadcast(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function run() external returns (address token, address treasury) {
        address admin = vm.envAddress("HST_ADMIN");
        address usdt = vm.envAddress("HST_USDT");
        uint256 decimals = vm.envOr("HST_USDT_DECIMALS", uint256(6));
        require(decimals <= 18, "Deploy: collateral decimals > 18");

        vm.startBroadcast();
        HstToken _token = new HstToken(admin);
        HstTreasury _treasury = new HstTreasury(admin, usdt, address(_token), uint8(decimals));
        // treasury 가 토큰을 mint/burn 할 수 있도록 operator 등록
        _token.setOperator(address(_treasury), true);
        // admin(=백엔드 operator) 도 직접 operator 로 (데모/통합테스트)
        _token.setOperator(admin, true);
        _treasury.setOperator(admin, true);
        vm.stopBroadcast();

        return (address(_token), address(_treasury));
    }
}
