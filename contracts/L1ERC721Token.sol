// SPDX-License-Identifier: Alt-Research-License-1.0
// Copyright Alt Research Ltd. 2023. All rights reserved.
//
// You acknowledge and agree that Alt Research Ltd. ("Alt Research") (or Alt
// Research's licensors) own all legal rights, titles and interests in and to the
// work, software, application, source code, documentation and any other documents

pragma solidity ^0.8.0;

import "@alt-research/alt-contracts/contracts/rollup/token/L1ERC721.sol";

contract L1ERC721Token is L1ERC721 {
    mapping(uint256 => uint256) public levels;

    string private URI;
    string private extension;

    event NFTLeveledUp(uint256 tokenId, uint256 newLevel);

    function initialize(
        address bridgeAddress,
        string memory name,
        string memory symbol,
        string memory baseURI,
        string memory ext
    ) public initializer {
        __L1ERC721_init(name, symbol);
        setBridge(bridgeAddress);
        setBaseURI(baseURI, ext);
    }

    // Evolv functions
    function setBaseURI(string memory _URI, string memory _ext) internal virtual{
        URI = _URI;
        extension = _ext;
    }

    function _baseURI() internal virtual override view returns (string memory) {
        return URI;
    }

    function tokenURI(uint256 tokenId) public view virtual override returns (string memory){
        string memory baseWithTokenID = super.tokenURI(tokenId);
        return bytes(baseWithTokenID).length > 0 ? string(abi.encodePacked(baseWithTokenID , extension)) : "";
    }

    function _finalizeRollup(KeyValuePair[] memory pairs, bytes32)
        internal
        virtual
        override
    {
        // Use a local variable to hold the loop computation result.
        uint256 curBurnCount = 0;
        for (uint256 i = 0; i < pairs.length; i++) {
            uint256 tokenId = abi.decode(pairs[i].key, (uint256));
            (address account, uint256 level) = abi.decode(
                pairs[i].value,
                (address, uint256)
            );

            if (account == address(0)) {
                curBurnCount += 1;
            } else {
                _mint(account, tokenId);
                levels[tokenId] = level;
            }
        }
        _incrementTotalMinted(pairs.length);
        _incrementTotalBurned(curBurnCount);
    }
}
