require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

const CHAIN_ID = Number(process.env.NEROX_CHAIN_ID || 31337);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true },
  },
  networks: {
    hardhat: {
      chainId: CHAIN_ID,
      // Demo nodes mine on every tx plus an interval block so time moves forward on-screen.
      mining: process.env.NEROX_INTERVAL_MINING ? { auto: true, interval: 1000 } : { auto: true },
      accounts: { count: 20, accountsBalance: "100000000000000000000000" },
    },
    base: { url: process.env.BASE_RPC || "http://127.0.0.1:8545", chainId: 31337 },
    ethereum: { url: process.env.ETH_RPC || "http://127.0.0.1:8546", chainId: 31338 },
  },
  mocha: { timeout: 120000 },
};
