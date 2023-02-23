// SPDX-License-Identifier: Alt-Research-License-1.0
// Copyright Alt Research Ltd. 2023. All rights reserved.
//
// You acknowledge and agree that Alt Research Ltd. ("Alt Research") (or Alt
// Research's licensors) own all legal rights, titles and interests in and to the
// work, software, application, source code, documentation and any other documents

pragma solidity ^0.8.0;

import "@alt-research/alt-contracts/contracts/rollup/token/L2ERC721.sol";
import "@openzeppelin/contracts/utils/Counters.sol";

contract L2ERC721Token is L2ERC721 {
    event ConfigurationSet(uint256 _count,
                    uint256 _start,
                    uint256 _end,
                    uint256 _max_claimable,
                    string URI,
                    string ext);
    event NFTClaimed(uint256 tokenId, address owner);

    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    using Counters for Counters.Counter;
    Counters.Counter private _tokenIds;

    string private URI;
    string private extension;

    uint256 private maxSupply; // total nfts to be minted
    uint256 private startTime;
    uint256 private endTime;
    uint256 private mintLimit;

    mapping (address => uint256) public totalMintedByMinter;

    mapping(uint256 => uint256) public levels;

    function initialize(
        address bridgeAddress,
        string memory name,
        string memory symbol,
        address wallet,
        address oracle,
        uint256 _maxSupply,
        uint256 _startTimeIn,
        uint256 _endTimeIn,
        uint256 _mintLimit,
        string memory _URI,
        string memory _ext
    ) public initializer {
        require(_startTimeIn < _endTimeIn, "Airdrop Timings not applicable");
        __L2ERC721_init(name, symbol);
        setBridge(bridgeAddress);

        _setupRole(DEFAULT_ADMIN_ROLE, wallet);
        _setupRole(ORACLE_ROLE, oracle);
        _setupRole(ROLLUP_ADMIN_ROLE, wallet);

        maxSupply = _maxSupply;
        startTime = block.number + _startTimeIn;
        endTime = block.number + _endTimeIn;
        mintLimit = _mintLimit;

        setBaseURI(_URI, _ext);

        emit ConfigurationSet(_maxSupply, startTime, endTime, _mintLimit, _URI, _ext);
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

    function claimNFT() public {
        _mintNFTForUser(msg.sender);
    }

    function mintNFTForUser(address user) public {
        require(hasRole(ORACLE_ROLE, _msgSender()), "Sender not authorized");
        _mintNFTForUser(user);
    }

    function _mintNFTForUser(address user) internal {
        require(totalMintedByMinter[user] < mintLimit, "NFT already claimed");
        require(startTime <= block.number && endTime >= block.number, "Sales time not applicable");
        uint256 newNFTId = _tokenIds.current() + 1;
        require(newNFTId <= maxSupply, "No NFT to mint");

        totalMintedByMinter[user]++;

        _tokenIds.increment();
        _safeMint(user, newNFTId);

        emit NFTClaimed(newNFTId, user);
    }

    function levelUp(uint256 tokenId) public {
        // require(hasRole(ORACLE_ROLE, _msgSender()), "Sender not authorized");
        require(_exists(tokenId), "invalid token ID");
        uint256 level = levels[tokenId] + 1;
        levels[tokenId] = level;

        StateContext memory ctx = _getWriteContext();
        _emitStateChange(
            ctx,
            abi.encode(tokenId),
            abi.encode(ownerOf(tokenId), level)
        );
        _saveContext(ctx);
    }

    function _afterTokenTransfer(
        address,
        address to,
        uint256 tokenId,
        uint256
    ) internal virtual override {
        StateContext memory ctx = _getWriteContext();
        _emitStateChange(
            ctx,
            abi.encode(tokenId),
            abi.encode(to, levels[tokenId])
        );
        _saveContext(ctx);
    }
}

