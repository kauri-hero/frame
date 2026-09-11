export enum ApprovalType {
  OtherChainApproval = 'approveOtherChain',
  GasLimitApproval = 'approveGasLimit'
}

const NETWORK_PRESETS = {
  ethereum: {
    default: {
      local: 'direct'
    },
    1:        { pylon: 'wss://evm.pylon.link/mainnet',          public: 'wss://ethereum.publicnode.com' },
    10:       { pylon: 'wss://evm.pylon.link/optimism',         public: 'wss://optimism.publicnode.com' },
    137:      { pylon: 'wss://evm.pylon.link/polygon',          public: 'wss://polygon-bor.publicnode.com' },
    8453:     { pylon: 'wss://evm.pylon.link/base',             public: 'wss://base.publicnode.com' },
    42161:    { pylon: 'wss://evm.pylon.link/arbitrum',         public: 'wss://arbitrum-one.publicnode.com' },
    84532:    { pylon: 'wss://evm.pylon.link/base-sepolia',     public: 'wss://base-sepolia.publicnode.com' },
    11155111: { pylon: 'wss://evm.pylon.link/sepolia',          public: 'wss://ethereum-sepolia.publicnode.com' },
    11155420: { pylon: 'wss://evm.pylon.link/optimism-sepolia', public: 'wss://optimism-sepolia.publicnode.com' }
  }
}


const ADDRESS_DISPLAY_CHARS = 8
const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000'
const MAX_HEX = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

export { NETWORK_PRESETS, ADDRESS_DISPLAY_CHARS, NATIVE_CURRENCY, MAX_HEX }
