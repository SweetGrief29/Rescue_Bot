// Entry untuk bundle viem lokal (vendor/viem.js) yang dipakai index.html.
// Halaman memegang private key, jadi pustaka disajikan dari node_modules sendiri, bukan CDN.
// Tambahkan nama di sini bila index.html mengimpor fungsi viem baru, lalu jalankan: npm run build
export {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  parseEther,
  formatUnits,
  formatEther,
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  getAddress,
  isAddress,
  isHex,
  zeroAddress,
  toHex,
  serializeTransaction,
} from "viem";
export {
  privateKeyToAccount,
  generatePrivateKey,
  generateMnemonic,
  mnemonicToAccount,
  english,
} from "viem/accounts";
