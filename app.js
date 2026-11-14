// UI logic (dipindah dari index.html agar CSP bisa tanpa 'unsafe-inline' untuk skrip)
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
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
  privateKeyToAccount,
  generatePrivateKey,
  generateMnemonic,
  mnemonicToAccount,
  english,
} from "/vendor/viem.js"; // bundle lokal dari node_modules (npm run build), bukan CDN
// tip gas mengikuti PRIORITY_FEE_WEI di .env (dikirim lewat /api/config)
const prioFee = () => BigInt(CFG?.priorityFeeWei ?? "10000000");
const $ = (i) => {
  const e = document.getElementById(i);
  if (!e)
    throw new Error(
      `Element #${i} not found. index.html is incomplete or outdated.`,
    );
  return e;
};
const NETS = {
  sepolia: { id: 11155111, name: "Sepolia", ex: "https://sepolia.etherscan.io" },
  base: { id: 8453, name: "Base", ex: "https://basescan.org" },
};
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
]);
const SWEEP = parseAbi(["function sweepToken(address token,address to)"]);
const FEEREC = parseAbi([
  "function FEE_RECIPIENT() view returns (address)",
]);
const FEEBPS = parseAbi(["function FEE_BPS() view returns (uint256)"]);
const RESCUEABI = parseAbi([
  "function rescue(address claimTarget,bytes claimData,address[] tokens,bool includeNative,address to,uint256 deadline,bytes sig)",
]);
// Public (fee) mode: the strict RescueFee contract. Fee is fixed inside the contract.
async function preparePublic(c, DELEGATE) {
  const act = $("action").value;
  if (act !== "claim_transfer")
    throw new Error(
      "Only Claim & Transfer is available in public mode (the fee is charged on the claimed amount)",
    );
  if (($("value").value.trim() || "0") !== "0")
    throw new Error("Native value must be 0 in public mode");
  const SAFE = addr("safe"),
    TOKEN = addr("token");
  if (SAFE === c.leaked.address)
    throw new Error(
      "Safe wallet must differ from the compromised wallet",
    );
  let bps, feeRecipient;
  try {
    [bps, feeRecipient] = await Promise.all([
      c.pub.readContract({
        address: DELEGATE,
        abi: FEEBPS,
        functionName: "FEE_BPS",
      }),
      c.pub.readContract({
        address: DELEGATE,
        abi: FEEREC,
        functionName: "FEE_RECIPIENT",
      }),
    ]);
  } catch {
    throw new Error(
      "Delegate is not the RescueFee contract. Check config.json.",
    );
  }
  if (Number(bps) !== CFG.fee.bps)
    throw new Error(
      `Fee mismatch: contract ${bps} bps, server ${CFG.fee.bps} bps`,
    );
  if (getAddress(SAFE) === getAddress(feeRecipient))
    log(
      "Warning: the safe wallet equals the fee recipient, so fee and net amount both land in the same address.",
      "err",
    );
  let claimTarget = zeroAddress,
    claimData = "0x";
  if (act === "claim_transfer") {
    claimTarget = addr("claim");
    const cd = $("claimData").value.trim() || "0x";
    if (!isHex(cd)) throw new Error("Calldata is not hex");
    claimData = cd;
  }
  const tokens = [TOKEN],
    includeNative = false;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const digest = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "uint256,address,address,bytes32,bytes32,bool,address,uint256",
      ),
      [
        BigInt(c.n.id),
        c.leaked.address,
        claimTarget,
        keccak256(claimData),
        keccak256(
          encodeAbiParameters(parseAbiParameters("address[]"), [tokens]),
        ),
        includeNative,
        SAFE,
        deadline,
      ],
    ),
  );
  const sig = await c.leaked.signMessage({ message: { raw: digest } });
  const authorization = await c.wallet.signAuthorization({
    account: c.leaked,
    contractAddress: DELEGATE,
  });
  const data = encodeFunctionData({
    abi: RESCUEABI,
    functionName: "rescue",
    args: [
      claimTarget,
      claimData,
      tokens,
      includeNative,
      SAFE,
      deadline,
      sig,
    ],
  });
  return {
    SAFE,
    DELEGATE,
    TOKEN,
    authorization,
    data,
    feeBps: Number(bps),
    feeRecipient,
  };
}
const EXEC = parseAbi([
  "function execute((address target,uint256 value,bytes data)[] calls,uint256 deadline,bytes sig)",
]);
const BT = ["default", "inverse", "accent", "soft"];
function applyBtn(v) {
  if (!BT.includes(v)) v = "default";
  document.documentElement.setAttribute("data-btn", v);
  const bt = document.getElementById("btnTheme");
  if (bt) bt.value = v;
  try {
    localStorage.setItem("rescue.btn", v);
  } catch {}
}
let CFG = null,
  SP = null;
const SK = "rescue.sponsor.v1";
const log = (m, c = "") => {
  const d = document.createElement("div");
  d.className = c;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${m}`;
  $("log").append(d);
  $("log").scrollTop = 1e9;
};
const KEYRE = /^0x[0-9a-fA-F]{64}$/;
const key = (i) => {
  let v = $(i).value.trim();
  if (!v.startsWith("0x")) v = "0x" + v;
  if (!KEYRE.test(v)) throw new Error("Invalid private key: " + i);
  return v;
};
const addr = (i) => {
  const v = $(i).value.trim();
  if (!isAddress(v)) throw new Error("Invalid address: " + i);
  return getAddress(v);
};
const delegOf = (c) =>
  c && c.toLowerCase().startsWith("0xef0100") && c.length === 48
    ? getAddress("0x" + c.slice(8))
    : null;
const fmt = (v) => {
  const [i, d = ""] = formatEther(v).split(".");
  return i + "." + d.padEnd(6, "0").slice(0, 6);
};
try {
  const raw = localStorage.getItem(SK);
  if (raw) {
    const o = JSON.parse(raw);
    if (KEYRE.test(o.pk)) SP = o;
  }
} catch {}
const saveSP = () => {
  try {
    SP
      ? localStorage.setItem(SK, JSON.stringify(SP))
      : localStorage.removeItem(SK);
  } catch {
    log("Warning: localStorage blocked, wallet will not be saved", "err");
  }
};

// ---------- jaringan & konteks ----------
function netCtx() {
  const net = $("net").value,
    n = NETS[net];
  // CSP connect-src 'self': hanya RPC lewat backend (/rpc/<net>) yang bisa dihubungi
  if (!CFG?.networks?.[net]?.available)
    throw new Error(
      `RPC for ${net} is not set. Fill ${net === "base" ? "BASE_RPC" : "SEPOLIA_RPC"} in .env and restart the server.`,
    );
  const rpc = location.origin + "/rpc/" + net;
  const chain = {
    id: n.id,
    name: n.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  };
  return {
    net,
    n,
    rpc,
    chain,
    pub: createPublicClient({ chain, transport: http(rpc) }),
  };
}
function ctx() {
  const b = netCtx(),
    leaked = privateKeyToAccount(key("leakedPk"));
  const local = SP ? privateKeyToAccount(SP.pk) : null,
    relay = !local && !!CFG?.sponsor;
  if (!local && !relay)
    throw new Error(
      "No sponsor wallet. Open the Sponsor Wallet tab and click Generate Wallet.",
    );
  const sponsor = local ?? { address: CFG.sponsor };
  return {
    ...b,
    relay,
    leaked,
    sponsor,
    wallet: createWalletClient({
      ...(local ? { account: local } : {}),
      chain: b.chain,
      transport: http(b.rpc),
    }),
  };
}
const ser = (a) => ({
  address: a.address,
  chainId: a.chainId,
  nonce: a.nonce,
  r: a.r,
  s: a.s,
  yParity: a.yParity,
});
async function relayCall(c, mode, data, a) {
  const r = await fetch("/api/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      net: $("net").value,
      mode,
      to: c.leaked.address,
      data,
      authorization: ser(a),
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "relay failed");
  return j;
}
async function guard(c) {
  const id = await c.pub.getChainId();
  if (id !== c.n.id)
    throw new Error(
      `RPC chain ID ${id} does not match ${c.n.name} (${c.n.id})`,
    );
}
async function current(c) {
  const code = await c.pub.getCode({ address: c.leaked.address });
  if (code && code !== "0x" && !delegOf(code))
    throw new Error(
      "Wallet holds regular contract code, not a 7702 delegation. Stopped.",
    );
  return delegOf(code);
}
async function run(f) {
  document
    .querySelectorAll("button:not(.tab)")
    .forEach((b) => (b.disabled = true));
  try {
    await f();
  } catch (e) {
    log("✗ " + (e.shortMessage || e.message), "err");
  } finally {
    document
      .querySelectorAll("button:not(.tab)")
      .forEach((b) => (b.disabled = false));
  }
}

// ---------- saldo ----------
function renderChain() {
  const net = $("net").value,
    n = NETS[net],
    test = net === "sepolia";
  $("chainBanner").className =
    "alert mt-3 " + (test ? "alert-warning" : "alert-primary");
  $("chainBanner").textContent = test
    ? `Active: ${n.name} Testnet (Chain ID ${n.id}). Fund with Sepolia ETH from a faucet.`
    : `Active: ${n.name} Mainnet (Chain ID ${n.id}). Real ETH. Send ETH on ${n.name}, not Ethereum mainnet.`;
  $("spChain").value = `${n.name} (Chain ID ${n.id}), gas token: ETH`;
  $("netName").textContent = n.name;
  const a = SP ? privateKeyToAccount(SP.pk).address : null;
  $("spLink").hidden = !a;
  if (a) $("spLink").href = `${n.ex}/address/${a}`;
}
async function refresh() {
  let b;
  try {
    renderChain();
    b = netCtx();
  } catch (e) {
    $("spHint").textContent = "Network setup failed: " + e.message;
    return;
  }
  try {
    const sa = SP ? privateKeyToAccount(SP.pk).address : CFG?.sponsor;
    if (sa) {
      const bal = await b.pub.getBalance({ address: sa });
      $("spBal").value = fmt(bal) + " ETH";
      $("spHint").textContent =
        bal === 0n
          ? `Empty on ${b.n.name}. Send ETH on ${b.n.name} to the sponsor address.`
          : "";
    }
  } catch (e) {
    $("spHint").textContent =
      "Failed to read sponsor balance: " + (e.shortMessage || e.message);
  }
  try {
    const k = $("leakedPk").value.trim(),
      kk = k.startsWith("0x") ? k : "0x" + k;
    if (KEYRE.test(kk)) {
      const la = privateKeyToAccount(kk).address;
      $("leakInfo").textContent =
        `${la} | ${fmt(await b.pub.getBalance({ address: la }))} ETH on ${b.n.name}`;
    } else $("leakInfo").textContent = "";
  } catch (e) {
    $("leakInfo").textContent =
      "Failed to read compromised wallet balance: " +
      (e.shortMessage || e.message);
  }
}
function renderSP() {
  const has = !!SP,
    a = has ? privateKeyToAccount(SP.pk).address : null;
  $("spEmpty").hidden = has;
  $("spBox").hidden = !has;
  $("spBtns").hidden = !has;
  if (has) {
    $("spAddr").value = a;
    $("spPk").value = SP.pk;
    $("spMn").value = SP.mnemonic || "(none, imported from key)";
  }
  $("beNote").textContent = CFG?.sponsor
    ? `Backend sponsor active (${CFG.sponsor}); used when no local wallet exists.`
    : "";
  refresh();
}

// ---------- sponsor wallet ----------
function newWallet() {
  if (
    SP &&
    !confirm(
      "The old sponsor wallet will be removed. Make sure it is empty or backed up. Continue?",
    )
  )
    return;
  const m = generateMnemonic(english),
    pk = toHex(mnemonicToAccount(m).getHdKey().privateKey);
  SP = { pk, mnemonic: m };
  saveSP();
  renderSP();
  log("New sponsor wallet: " + privateKeyToAccount(pk).address, "ok");
}
$("gen").onclick = newWallet;
$("gen2").onclick = newWallet;
$("del").onclick = () => {
  if (
    !confirm(
      "Delete the sponsor wallet? Remaining funds are lost without the recovery phrase.",
    )
  )
    return;
  SP = null;
  saveSP();
  renderSP();
  log("Sponsor wallet deleted");
};
$("refresh").onclick = refresh;
document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.dataset?.copy)
    navigator.clipboard
      .writeText($(t.dataset.copy).value)
      .then(() => {
        const o = t.textContent;
        t.textContent = "Copied";
        setTimeout(() => (t.textContent = o), 1200);
      })
      .catch(() => log("Copy failed", "err"));
  if (t.dataset?.show) {
    const i = $(t.dataset.show);
    i.type = i.type === "password" ? "text" : "password";
    t.textContent = i.type === "text" ? "Hide" : "Show";
  }
});
document.querySelectorAll(".tab").forEach(
  (b) =>
    (b.onclick = () => {
      document
        .querySelectorAll(".tab")
        .forEach((x) => x.classList.toggle("active", x === b));
      $("t-sponsor").hidden = b.dataset.t !== "sponsor";
      $("t-rescue").hidden = b.dataset.t !== "rescue";
    }),
);
$("net").onchange = () => {
  applyDefaults();
  renderChain();
  refresh();
};
let tm;
$("leakedPk").oninput = () => {
  clearTimeout(tm);
  tm = setTimeout(refresh, 500);
};
setInterval(() => {
  if (!document.hidden) refresh();
}, 20000);

// ---------- rescue ----------
async function prepare(c) {
  const act = $("action").value,
    dv = $("delegate").value.trim();
  if (!isAddress(dv))
    throw new Error(
      `No delegate set for ${c.n.name}. Add "${$("net").value}" -> "delegate" in config.json, then reload.`,
    );
  const DELEGATE = getAddress(dv);
  if (CFG?.fee) return await preparePublic(c, DELEGATE);
  // mode pribadi: RescueDelegate, tanpa fee
  const dc = await c.pub.getCode({ address: DELEGATE });
  if (!dc || dc === "0x")
    throw new Error("Delegate contract not deployed on this network");
  const calls = [];
  let SAFE = null,
    TOKEN = null;
  if (act !== "custom") {
    SAFE = addr("safe");
    TOKEN = addr("token");
    if (SAFE === c.leaked.address)
      throw new Error(
        "Safe wallet must differ from the compromised wallet",
      );
  }
  if (act !== "transfer") {
    const cd = $("claimData").value.trim() || "0x";
    if (!isHex(cd)) throw new Error("Calldata is not hex");
    calls.push({
      target: addr("claim"),
      value: parseEther($("value").value.trim() || "0"),
      data: cd,
    });
  }
  if (act !== "custom")
    // jumlah selalu seluruh saldo (all)
    calls.push({
      target: c.leaked.address,
      value: 0n,
      data: encodeFunctionData({
        abi: SWEEP,
        functionName: "sweepToken",
        args: [TOKEN, SAFE],
      }),
    });
  if (!calls.length) throw new Error("No calls");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const ch = keccak256(
    encodeAbiParameters(
      parseAbiParameters("(address target,uint256 value,bytes data)[]"),
      [calls],
    ),
  );
  const digest = keccak256(
    encodeAbiParameters(
      parseAbiParameters("uint256,address,bytes32,uint256"),
      [BigInt(c.n.id), c.leaked.address, ch, deadline],
    ),
  );
  const sig = await c.leaked.signMessage({ message: { raw: digest } });
  const authorization = await c.wallet.signAuthorization({
    account: c.leaked,
    contractAddress: DELEGATE,
  });
  const data = encodeFunctionData({
    abi: EXEC,
    functionName: "execute",
    args: [calls, deadline, sig],
  });
  return {
    SAFE,
    DELEGATE,
    TOKEN,
    authorization,
    data,
    feeBps: null,
    feeRecipient: null,
  };
}
const est = async (c, p) =>
  c.relay
    ? BigInt(
        (await relayCall(c, "simulate", p.data, p.authorization)).gas,
      )
    : c.pub.estimateGas({
        account: c.sponsor.address,
        to: c.leaked.address,
        data: p.data,
        authorizationList: [p.authorization],
      });
async function removeDelegation(c) {
  const d = await current(c);
  if (!d) return log("No active delegation");
  const a = await c.wallet.signAuthorization({
    account: c.leaked,
    contractAddress: zeroAddress,
  });
  const h = c.relay
    ? (await relayCall(c, "send", "0x", a)).hash
    : await c.wallet.sendTransaction({
        to: c.leaked.address,
        data: "0x",
        authorizationList: [a],
        maxPriorityFeePerGas: prioFee(),
      });
  await c.pub.waitForTransactionReceipt({ hash: h });
  log("✓ Delegation removed: " + h, "ok");
}
$("exec").onclick = () =>
  run(async () => {
    if (!$("own").checked)
      throw new Error("Confirm wallet ownership first");
    const c = ctx();
    await guard(c);
    if (
      !c.relay &&
      (await c.pub.getBalance({ address: c.sponsor.address })) === 0n
    )
      throw new Error(
        `Sponsor balance is 0 on ${c.n.name}. Fund ${c.sponsor.address} first.`,
      );
    log("1/4 Preparing...");
    const d0 = await current(c);
    if (d0) log("Existing delegation " + d0 + " will be overwritten");
    const p = await prepare(c);
    log("2/4 Simulating...");
    const g = await est(c, p);
    log("✓ Simulation OK. Gas estimate: " + g, "ok");
    if (
      !confirm(
        `Send a REAL transaction on ${c.n.name}?` +
          (p.feeBps != null
            ? `
Service fee: ${p.feeBps / 100}% of the claimed amount -> ${p.feeRecipient}`
            : "\nNo service fee (private mode)") +
          `
Tokens go to: ${p.SAFE ?? "-"}`,
      )
    )
      return log("Cancelled");
    log("3/4 Sending...");
    const hash = c.relay
      ? (await relayCall(c, "send", p.data, p.authorization)).hash
      : await c.wallet.sendTransaction({
          to: c.leaked.address,
          data: p.data,
          authorizationList: [p.authorization],
          maxPriorityFeePerGas: prioFee(),
        });
    log("tx: " + hash + "  " + c.n.ex + "/tx/" + hash);
    const r = await c.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("Transaction failed");
    log("✓ Rescue transaction confirmed", "ok");
    if (p.TOKEN && p.SAFE)
      try {
        const [dec, sym, bal] = await Promise.all([
          c.pub.readContract({
            address: p.TOKEN,
            abi: ERC20,
            functionName: "decimals",
          }),
          c.pub
            .readContract({
              address: p.TOKEN,
              abi: ERC20,
              functionName: "symbol",
            })
            .catch(() => "token"),
          c.pub.readContract({
            address: p.TOKEN,
            abi: ERC20,
            functionName: "balanceOf",
            args: [p.SAFE],
          }),
        ]);
        log(
          `${sym} balance (safe wallet): ${formatUnits(bal, dec)}`,
          "ok",
        );
      } catch {}
    log("4/4 Removing delegation...");
    try {
      await removeDelegation(c);
    } catch (e) {
      log(
        "Delegation removal failed (rescue itself succeeded): " +
          (e.shortMessage || e.message),
        "err",
      );
    }
    log("Done. Stop using the compromised wallet.", "ok");
    refresh();
  });

// ---------- backend & default ----------
function applyDefaults() {
  if (!CFG) return;
  const d = CFG.defaults || {},
    nd = d[$("net").value] || {};
  // public mode: never prefill the destination; every user must enter their own safe wallet
  if (d.safe && !CFG?.fee) $("safe").value = d.safe;
  $("delegate").value = nd.delegate || "";
  $("claim").value = nd.claim || "";
  $("token").value = nd.token || "";
  $("value").value = nd.value || "0";
  $("action").value = nd.action || "claim_transfer";
  for (const o of $("action").options)
    if (o.value !== "claim_transfer") o.disabled = !!CFG?.fee;
  $("claimData").value = "";
}
// selalu mulai bersih: calldata, private key, centang kepemilikan (tidak dipulihkan browser)
$("claimData").value = "";
$("leakedPk").value = "";
$("own").checked = false;
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});
{
  const bt = document.getElementById("btnTheme");
  if (bt) bt.onchange = () => applyBtn(bt.value);
}
{
  let v = "default";
  try {
    v = localStorage.getItem("rescue.btn") || "default";
  } catch {}
  applyBtn(v);
}
renderSP();
fetch("/api/config")
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => {
    if (!j) {
      console.warn("Backend not connected. Run npm start.");
      log("Service unavailable. Please try again later.", "err");
      return;
    }
    CFG = j;
    applyDefaults();
    if (j.fee) {
      $("feeInfo").hidden = false;
      $("feeInfo").textContent =
        `Service fee: ${j.fee.bps / 100}% of the claimed amount (fixed in the contract).`;
    }
    if (!j.fee)
      console.warn(
        "Mode: PRIVATE (no fee). Set PUBLIC_MODE=true in .env and restart the server to enable the fee.",
      );
    if (j.configError) console.error(j.configError);
    renderSP();
  })
  .catch(() => {
    console.warn("Backend not connected. Run npm start.");
    log("Service unavailable. Please try again later.", "err");
  });
window.addEventListener("load", () => {
  try {
    if (
      !getComputedStyle(document.documentElement).getPropertyValue(
        "--bs-body-font-family",
      )
    )
      log(
        "Bootstrap CSS not loaded (fallback styles in use). Run npm install, then restart the server. Check http://localhost:3000/vendor/bootstrap.css",
        "err",
      );
  } catch {}
});
log(
  "Ready. Generate a sponsor wallet, fund it, then open Rescue Wallet.",
);
