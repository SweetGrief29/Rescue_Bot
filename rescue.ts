import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, getAddress, isAddress, isHex, zeroAddress,
  encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters,
  parseUnits, parseEther, formatUnits, formatEther, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, sepolia } from "viem/chains";

// ---------- util env ----------
const env = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`Env ${n} belum diisi`);
  return v;
};
const envAddr = (n: string): Address => {
  const v = env(n);
  if (!isAddress(v)) throw new Error(`Env ${n} bukan alamat valid`);
  return getAddress(v);
};
const envKey = (n: string): Hex => {
  let v = env(n);
  if (!v.startsWith("0x")) v = `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`Env ${n} bukan private key valid`);
  return v as Hex;
};

// ---------- jaringan ----------
const NETWORKS = {
  sepolia: { chain: sepolia, rpcEnv: "SEPOLIA_RPC", explorer: "https://sepolia.etherscan.io" },
  base:    { chain: base,    rpcEnv: "BASE_RPC",    explorer: "https://basescan.org" },
} as const;
const NET = (process.env.NETWORK ?? "sepolia").toLowerCase() as keyof typeof NETWORKS;
const cfg = NETWORKS[NET];
if (!cfg) throw new Error("NETWORK harus 'sepolia' atau 'base'");

const MODE = process.argv[2] ?? "check"; // check | rescue | cleanup
const ACTION = (process.env.ACTION ?? "claim_transfer").toLowerCase(); // claim_transfer | transfer | custom
const DRY_RUN = process.env.DRY_RUN !== "false";
const PRIORITY_FEE = BigInt(process.env.PRIORITY_FEE_WEI ?? "10000000");

const RPC = env(cfg.rpcEnv);
const compromised = privateKeyToAccount(envKey("LEAKED_PK"));
const sponsor = privateKeyToAccount(envKey("SPONSOR_PK"));
const pub = createPublicClient({ chain: cfg.chain, transport: http(RPC) });
const client = createWalletClient({ account: sponsor, chain: cfg.chain, transport: http(RPC) });

const ERC20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const SWEEP = parseAbi(["function sweepToken(address token, address to)"]);
const EXEC = parseAbi([
  "function execute((address target,uint256 value,bytes data)[] calls, uint256 deadline, bytes sig)",
]);

// ---------- delegasi 7702 ----------
const parseDelegation = (code?: Hex): Address | null =>
  code && code.toLowerCase().startsWith("0xef0100") && code.length === 48
    ? getAddress(`0x${code.slice(8)}`)
    : null;

async function currentDelegation(): Promise<Address | null> {
  const code = await pub.getCode({ address: compromised.address });
  if (code && code !== "0x" && !parseDelegation(code))
    throw new Error("Wallet berisi kontrak biasa (bukan delegasi 7702). Berhenti.");
  return parseDelegation(code);
}

async function guardChain() {
  const id = await pub.getChainId();
  if (id !== cfg.chain.id) throw new Error(`RPC chain ID ${id} tidak cocok dengan ${NET} (${cfg.chain.id})`);
}

// ---------- mode: check ----------
async function check() {
  console.log(`Jaringan : ${NET}`);
  console.log(`Wallet bocor : ${compromised.address}  ${formatEther(await pub.getBalance({ address: compromised.address }))} ETH`);
  const sb = await pub.getBalance({ address: sponsor.address });
  console.log(`Sponsor      : ${sponsor.address}  ${formatEther(sb)} ETH${sb === 0n ? "  <- kosong, danai dulu" : ""}`);
  const d = await currentDelegation();
  console.log(`Delegasi aktif: ${d ?? "tidak ada"}`);
  if (process.env.TOKEN && isAddress(process.env.TOKEN)) {
    const t = getAddress(process.env.TOKEN);
    const [sym, dec] = await Promise.all([
      pub.readContract({ address: t, abi: ERC20, functionName: "symbol" }).catch(() => "?"),
      pub.readContract({ address: t, abi: ERC20, functionName: "decimals" }),
    ]);
    const holders: [string, Address | undefined][] = [
      ["wallet bocor", compromised.address],
      ["SAFE", process.env.SAFE && isAddress(process.env.SAFE) ? getAddress(process.env.SAFE) : undefined],
    ];
    for (const [label, a] of holders) {
      if (!a) continue;
      const bal = await pub.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [a] });
      console.log(`Saldo ${sym} ${label}: ${formatUnits(bal, dec)}`);
    }
  }
}

// ---------- mode: rescue ----------
async function rescue() {
  if (!["claim_transfer", "transfer", "custom"].includes(ACTION))
    throw new Error("ACTION harus: claim_transfer | transfer | custom");
  const DELEGATE = envAddr("DELEGATE");
  const dc = await pub.getCode({ address: DELEGATE });
  if (!dc || dc === "0x") throw new Error("DELEGATE belum ter-deploy di jaringan ini");

  let SAFE: Address | null = null, TOKEN: Address | null = null, dec = 18;
  if (ACTION !== "custom") {
    SAFE = envAddr("SAFE");
    TOKEN = envAddr("TOKEN");
    if (SAFE === compromised.address) throw new Error("SAFE tidak boleh sama dengan wallet bocor");
    dec = await pub.readContract({ address: TOKEN, abi: ERC20, functionName: "decimals" });
  }

  const calls: { target: Address; value: bigint; data: Hex }[] = [];
  if (ACTION !== "transfer") {
    const cd = process.env.CLAIM_DATA ?? "0x";
    if (!isHex(cd)) throw new Error("CLAIM_DATA bukan hex valid");
    calls.push({ target: envAddr("CLAIM"), value: parseEther(process.env.NATIVE_VALUE ?? "0"), data: cd });
  }
  if (ACTION !== "custom") {
    const am = env("AMOUNT").toLowerCase(); // angka (satuan token) atau "all"
    if (am === "all") {
      calls.push({
        target: compromised.address, value: 0n,
        data: encodeFunctionData({ abi: SWEEP, functionName: "sweepToken", args: [TOKEN!, SAFE!] }),
      });
    } else {
      const amount = parseUnits(am, dec);
      if (amount <= 0n) throw new Error("AMOUNT harus > 0 (atau isi all)");
      calls.push({
        target: TOKEN!, value: 0n,
        data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [SAFE!, amount] }),
      });
    }
  }
  if (!calls.length) throw new Error("Tidak ada call");

  const existing = await currentDelegation();
  console.log(
    existing === null ? "Delegasi saat ini: tidak ada"
    : existing === DELEGATE ? "Delegasi saat ini: sudah ke kontrak kita"
    : `Delegasi saat ini: ${existing}  (AKAN DITIMPA ke ${DELEGATE})`,
  );

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const callsHash = keccak256(
    encodeAbiParameters(parseAbiParameters("(address target,uint256 value,bytes data)[]"), [calls]),
  );
  const digest = keccak256(
    encodeAbiParameters(parseAbiParameters("uint256,address,bytes32,uint256"),
      [BigInt(cfg.chain.id), compromised.address, callsHash, deadline]),
  );
  const sig = await compromised.signMessage({ message: { raw: digest } });
  const authorization = await client.signAuthorization({ account: compromised, contractAddress: DELEGATE });
  const data = encodeFunctionData({ abi: EXEC, functionName: "execute", args: [calls, deadline, sig] });

  const gas = await pub.estimateGas({
    account: sponsor.address, to: compromised.address, data, authorizationList: [authorization],
  });
  console.log(`Simulasi OK (${ACTION}, ${calls.length} call), estimasi gas: ${gas}`);

  if (DRY_RUN) return console.log("DRY_RUN=true -> tidak mengirim. Set DRY_RUN=false untuk kirim.");
  if (NET === "base" && process.env.CONFIRM_MAINNET !== "yes")
    throw new Error("Mainnet: set CONFIRM_MAINNET=yes untuk mengirim transaksi nyata");

  const bal = () => pub.readContract({ address: TOKEN!, abi: ERC20, functionName: "balanceOf", args: [SAFE!] });
  const before = SAFE && TOKEN ? await bal() : 0n;
  const hash = await client.sendTransaction({
    to: compromised.address, data, authorizationList: [authorization], maxPriorityFeePerGas: PRIORITY_FEE,
  });
  console.log(`tx: ${hash}\n${cfg.explorer}/tx/${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaksi gagal");

  const after = await currentDelegation();
  console.log(after === DELEGATE ? "Delegasi sekarang: kontrak kita (OK)" : `PERINGATAN delegasi sekarang: ${after}`);
  if (SAFE && TOKEN) console.log(`Saldo SAFE bertambah: ${formatUnits((await bal()) - before, dec)}`);
  console.log("Berikutnya: `npm run cleanup`, lalu berhenti memakai wallet bocor.");
}

// ---------- mode: cleanup ----------
async function cleanup() {
  const existing = await currentDelegation();
  console.log("Delegasi saat ini:", existing ?? "tidak ada");
  if (!existing) return;
  const authorization = await client.signAuthorization({ account: compromised, contractAddress: zeroAddress });
  await pub.estimateGas({ account: sponsor.address, to: compromised.address, data: "0x", authorizationList: [authorization] });
  if (DRY_RUN) return console.log("DRY_RUN=true -> simulasi OK, tidak mengirim.");
  if (NET === "base" && process.env.CONFIRM_MAINNET !== "yes")
    throw new Error("Mainnet: set CONFIRM_MAINNET=yes untuk mengirim transaksi nyata");
  const hash = await client.sendTransaction({
    to: compromised.address, data: "0x", authorizationList: [authorization], maxPriorityFeePerGas: PRIORITY_FEE,
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`tx: ${hash}\nDelegasi sekarang:`, (await currentDelegation()) ?? "tidak ada (bersih)");
}

(async () => {
  await guardChain();
  if (MODE === "check") await check();
  else if (MODE === "rescue") await rescue();
  else if (MODE === "cleanup") await cleanup();
  else throw new Error("Mode: check | rescue | cleanup");
})().catch((e) => { console.error("✗", e.shortMessage ?? e.message ?? e); process.exit(1); });
