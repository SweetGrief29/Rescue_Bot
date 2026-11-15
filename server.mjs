// Backend lokal: menyajikan UI, menyimpan RPC (API key) di server, dan mengisi default otomatis.
// Private key wallet TIDAK pernah dikirim ke backend; penandatanganan tetap di browser.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
// .env dibaca dari folder server.mjs (bukan cwd), sama seperti config.json
try { process.loadEnvFile(path.join(dir, ".env")); } catch {}
const PORT = Number(process.env.PORT ?? 3000);
const HOST = "127.0.0.1";
// viem dimuat opsional agar server tetap jalan sebelum `npm install`
let V = null, A = null, U = null, C = null;
try { V = await import("viem"); A = await import("viem/accounts"); U = await import("viem/utils"); C = await import("viem/chains"); } catch {}
const CHAINS = C ? { sepolia: C.sepolia, base: C.base } : {};
let sponsor = null;
try { if (V && process.env.SPONSOR_PK) sponsor = A.privateKeyToAccount(process.env.SPONSOR_PK.startsWith("0x") ? process.env.SPONSOR_PK : `0x${process.env.SPONSOR_PK}`); } catch {}
// ---- mode publik: fee + validasi template + rate limit ----
const PUBLIC_MODE = process.env.PUBLIC_MODE === "true";
const FEE_BPS = 2000; // fixed 20%, must equal RescueFee.FEE_BPS (the UI verifies this against the contract)
const MAX_GAS = BigInt(process.env.MAX_GAS ?? "700000");
// Batas harga gas per transaksi sponsor di mode publik (gwei). Mencegah sponsor membayar mahal saat jaringan ramai.
const MAX_FEE_GWEI = process.env.MAX_FEE_GWEI ?? "5";
const MAX_FEE_WEI = V ? V.parseGwei(MAX_FEE_GWEI) : 0n;
const PRIORITY_FEE = BigInt(process.env.PRIORITY_FEE_WEI ?? "10000000");
const PUBLIC_HOST = process.env.PUBLIC_HOST; // e.g. rescue.example.com or abc123.ngrok-free.app (comma-separated; "*.ngrok-free.app" = any subdomain)
// tolerant: strips quotes, https://, paths and trailing slashes, lowercases
const PUBLIC_HOSTS = (PUBLIC_HOST ?? "").split(",").map((x) => x.trim().toLowerCase().replace(/^["']|["']$/g, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
// Domain publik hanya diterima di mode publik. Di mode pribadi relay tidak punya validasi,
// jadi server sama sekali tidak boleh bisa dijangkau dari luar.
const hostAllowed = (h) => PUBLIC_MODE && PUBLIC_HOSTS.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
const isLoopback = (a) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
// ---- batas request (mode publik). Semua bisa diatur di .env ----
const num = (name, def) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : def; };
const LIMITS = {
  reqPerMin: num("REQ_PER_MIN", 300),            // semua request (halaman, config, RPC) per IP per menit
  rpcPerMin: num("RPC_PER_MIN", 120),            // call JSON-RPC per IP per menit (tiap call di dalam batch dihitung)
  txPerMin: num("TX_PER_MIN", 10),               // eth_sendRawTransaction per IP per menit
  rpcGlobalPerMin: num("RPC_GLOBAL_PER_MIN", 1500), // call JSON-RPC dari SEMUA pengunjung per menit
  rpcPerDay: num("RPC_PER_DAY", 100000),         // call JSON-RPC dari SEMUA pengunjung per 24 jam (melindungi kuota Infura)
  relayPerMin: 6,
};
const DAY = 86_400_000;
// penghitung jendela tetap: take() menambah `cost` dan mengembalikan sisa detik bila batas terlampaui (0 = masih boleh)
const buckets = new Map();
const take = (key, cost, max, windowMs = 60_000) => {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t >= windowMs) { b = { t: now, n: 0, w: windowMs }; buckets.set(key, b); }
  if (b.n + cost > max) return Math.max(1, Math.ceil((b.t + windowMs - now) / 1000));
  b.n += cost; return 0;
};
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t >= b.w) buckets.delete(k); }, 300_000).unref();
const tooMany = (res, wait, what) => { res.setHeader("retry-after", String(wait)); return send(res, 429, { error: `rate limit (${what}). Try again in ${wait}s.` }); };
// Pakai entri TERAKHIR X-Forwarded-For: itu yang ditambahkan proxy kita (ngrok/reverse proxy).
// Entri pertama bisa diisi bebas oleh klien, sehingga rate limit bisa dilewati dengan IP palsu.
const clientIp = (req) => (TRUST_PROXY ? String(req.headers["x-forwarded-for"] ?? "").split(",").pop().trim() : "") || req.socket.remoteAddress || "?";
// Baca body JSON dengan batas ukuran; error membawa status HTTP untuk handler di bawah.
const httpError = (status, message) => Object.assign(new Error(message), { status });
async function readJson(req, max) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw httpError(413, "request body too large");
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw httpError(400, "invalid JSON body"); }
}
const RESCUE_ABI = V ? V.parseAbi(["function rescue(address claimTarget,bytes claimData,address[] tokens,bool includeNative,address to,uint256 deadline,bytes sig)"]) : null;
// Public mode accepts ONLY rescue(...) on the delegated account (fee is fixed inside RescueFee) or delegation removal (data = 0x).
function validateTemplate(net, authority, data) {
  if (data === "0x") return; // removal: checked separately (the account must currently be delegated to our contract)
  let d;
  try { d = V.decodeFunctionData({ abi: RESCUE_ABI, data }); } catch { throw new Error("only rescue(...) or delegation removal is allowed"); }
  const [claimTarget, , tokens, includeNative, to] = d.args;
  const self = V.getAddress(authority);
  if (tokens.length === 0 && !includeNative) throw new Error("nothing to sweep");
  if (tokens.length > 8) throw new Error("too many tokens");
  if (to === V.zeroAddress || V.getAddress(to) === self) throw new Error("bad recipient");
  if (claimTarget === V.zeroAddress) throw new Error("a claim call is required (fee is charged on the claimed amount)");
  const allowed = (readConfig()[net]?.allowedTargets ?? []).map((a) => V.getAddress(a));
  if (!allowed.includes(V.getAddress(claimTarget))) throw new Error("claim target not in allowedTargets (config.json)");
}
// Mode publik: delegate di config.json harus kontrak RescueFee dengan fee yang sama (hasil yang benar di-cache).
const FEE_ABI = V ? V.parseAbi(["function FEE_BPS() view returns (uint256)"]) : null;
const feeOk = new Set();
async function assertFeeContract(net, pub, delegate) {
  const k = net + ":" + delegate;
  if (feeOk.has(k)) return;
  let bps;
  try { bps = await pub.readContract({ address: delegate, abi: FEE_ABI, functionName: "FEE_BPS" }); }
  catch { throw new Error(`delegate ${delegate} on ${net} is not the RescueFee contract (public mode requires it). Fix config.json.`); }
  if (Number(bps) !== FEE_BPS) throw new Error(`fee mismatch on ${net}: contract ${bps} bps, server ${FEE_BPS} bps`);
  feeOk.add(k);
}
const RPCS = { sepolia: process.env.SEPOLIA_RPC, base: process.env.BASE_RPC };
// Jangan pernah membocorkan URL RPC (berisi API key Infura) lewat pesan error ke browser
const scrub = (s) => Object.values(RPCS).filter(Boolean).reduce((m, u) => m.split(u).join("<rpc>"), String(s)).replace(/infura\.io\/v3\/[0-9a-zA-Z]+/g, "infura.io/v3/<key>");

// hanya method JSON-RPC yang dibutuhkan UI
const ALLOW = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getCode", "eth_call", "eth_estimateGas",
  "eth_getTransactionCount", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_getBlockByNumber", "eth_sendRawTransaction", "eth_getTransactionReceipt", "eth_getTransactionByHash",
]);

let configError = null;
const readConfig = () => {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")); configError = null; return j; }
  catch (e) { configError = `config.json unreadable (${e.message}). Check quotes/commas.`; return {}; }
};
const send = (res, code, body, type = "application/json", cache = "no-store") => {
  res.writeHead(code, { "content-type": type, "cache-control": cache, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const isHexStr = (v) => typeof v === "string" && V.isHex(v);

// Put your own icon next to server.mjs as favicon.ico / .png / .svg / .jpg / .webp (first one found is used).
// Dibaca sekali saat start (ganti ikon = restart server).
const ICONS = [["favicon.ico", "image/x-icon"], ["favicon.png", "image/png"], ["favicon.svg", "image/svg+xml"], ["favicon.jpg", "image/jpeg"], ["favicon.webp", "image/webp"]];
const FALLBACK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🛟</text></svg>`;
const iconHit = ICONS.find(([name]) => fs.existsSync(path.join(dir, name)));
const ICON = iconHit ? { body: fs.readFileSync(path.join(dir, iconHit[0])), type: iconHit[1] } : { body: FALLBACK_ICON, type: "image/svg+xml" };
// Berkas statis dengan nama tetap (tanpa path dari pengguna)
const STATIC = {
  "/app.js": ["app.js", "text/javascript; charset=utf-8", "app.js missing next to server.mjs"],
  "/vendor/viem.js": ["vendor/viem.js", "text/javascript; charset=utf-8", "viem bundle missing. Run: npm install (or npm run build)"],
  "/vendor/bootstrap.css": ["node_modules/bootstrap/dist/css/bootstrap.min.css", "text/css; charset=utf-8", "bootstrap not installed. Run: npm install"],
};

http.createServer(async (req, res) => {
  try {
    // tolak Host/Origin asing (anti DNS-rebinding & situs lain yang memanggil proxy lokal ini)
    const host = req.headers.host ?? "";
    const isPublicHost = hostAllowed(host.toLowerCase());
    if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}` && !isPublicHost) {
      console.log(`[403] host rejected: "${host}" | allowed: localhost, 127.0.0.1${PUBLIC_MODE && PUBLIC_HOSTS.length ? ", " + PUBLIC_HOSTS.join(", ") : PUBLIC_HOSTS.length ? " (PUBLIC_HOST ignored: PUBLIC_MODE=false)" : " (PUBLIC_HOST is empty)"}`);
      return send(res, 403, { error: PUBLIC_MODE ? `host rejected: ${host}. Add it to PUBLIC_HOST in .env and restart the server.` : `host rejected: ${host}. Private mode only accepts localhost; set PUBLIC_MODE=true to serve other hosts.` });
    }
    // Mode pribadi: header Host bisa dipalsukan, jadi wajib juga koneksi loopback tanpa proxy di depannya
    if (!PUBLIC_MODE && (!isLoopback(req.socket.remoteAddress) || req.headers["x-forwarded-for"] || req.headers["forwarded"]))
      return send(res, 403, { error: "private mode is local-only (no proxy/tunnel). Set PUBLIC_MODE=true to serve other users." });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}` && !(isPublicHost && origin === `https://${host}`)) return send(res, 403, { error: `origin rejected: ${origin}` });
    const ip = clientIp(req);
    let wait;
    if (PUBLIC_MODE && (wait = take("req:" + ip, 1, LIMITS.reqPerMin))) return tooMany(res, wait, "too many requests");

    const url = new URL(req.url, `http://${host}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html"))
      return send(res, 200, fs.readFileSync(path.join(dir, "index.html")), "text/html; charset=utf-8");

    if (req.method === "GET" && (url.pathname === "/favicon" || url.pathname === "/favicon.ico"))
      return send(res, 200, ICON.body, ICON.type, "public, max-age=3600");
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [rel, type, missing] = STATIC[url.pathname], f = path.join(dir, rel);
      if (!fs.existsSync(f)) return send(res, 404, { error: missing });
      return send(res, 200, fs.readFileSync(f), type);
    }

    if (req.method === "GET" && url.pathname === "/api/config")
      return send(res, 200, {
        networks: { sepolia: { available: !!RPCS.sepolia }, base: { available: !!RPCS.base } },
        sponsor: sponsor?.address ?? null,
        fee: PUBLIC_MODE ? { bps: FEE_BPS } : null,
        priorityFeeWei: PRIORITY_FEE.toString(),
        defaults: readConfig(),
        configError,
      });

    // Sponsor menandatangani & membayar gas di server; key wallet bocor tidak pernah sampai sini.
    if (req.method === "POST" && url.pathname === "/api/relay") {
      if (PUBLIC_MODE && (wait = take("relay:" + ip, 1, LIMITS.relayPerMin))) return tooMany(res, wait, "relay");
      if (!sponsor) return send(res, 503, { error: "Relay disabled: set SPONSOR_PK in .env and run npm install" });
      const b = await readJson(req, 256_000);
      if (!b || typeof b !== "object") return send(res, 400, { error: "invalid body" });
      const net = b.net, a = b.authorization;
      if (!Object.hasOwn(RPCS, net) || !RPCS[net] || !CHAINS[net]) return send(res, 400, { error: "network unavailable" });
      if (!V.isAddress(b.to) || !isHexStr(b.data)) return send(res, 400, { error: "invalid to/data" });
      if (!a || typeof a !== "object" || !V.isAddress(a.address) || !isHexStr(a.r) || !isHexStr(a.s)
        || !Number.isSafeInteger(Number(a.chainId)) || !Number.isSafeInteger(Number(a.nonce)) || ![0, 1].includes(Number(a.yParity)))
        return send(res, 400, { error: "invalid authorization" });
      // authorization harus untuk jaringan ini (chainId 0 = semua jaringan juga ditolak)
      if (Number(a.chainId) !== CHAINS[net].id) return send(res, 400, { error: `authorization chainId must be ${CHAINS[net].id}` });
      const authorizationList = [{ address: a.address, chainId: Number(a.chainId), nonce: Number(a.nonce), r: a.r, s: a.s, yParity: Number(a.yParity) }];
      // kunci: tujuan harus akun penanda tangan authorization, dan delegasinya hanya kontrak kita (atau address(0) untuk cleanup)
      const authority = await U.recoverAuthorizationAddress({ authorization: authorizationList[0] });
      if (V.getAddress(b.to) !== V.getAddress(authority)) return send(res, 403, { error: "to != authorization signer" });
      const ours = readConfig()[net]?.delegate;
      const okDelegates = [V.zeroAddress, ...(ours && V.isAddress(ours) ? [V.getAddress(ours)] : [])];
      if (!okDelegates.includes(V.getAddress(a.address))) return send(res, 403, { error: `delegate not allowed on ${net}. Got: ${a.address} | config.json: ${ours || "(empty)"}. They must match.` });
      const removal = V.getAddress(a.address) === V.zeroAddress;
      if (removal !== (b.data === "0x")) return send(res, 403, { error: "delegation removal must use empty data, and rescue must delegate to our contract" });
      if (PUBLIC_MODE) { try { validateTemplate(net, authority, b.data); } catch (e) { return send(res, 403, { error: "template rejected: " + e.message }); } }
      const transport = V.http(RPCS[net]);
      const pub = V.createPublicClient({ chain: CHAINS[net], transport });
      // Authorization hanya berlaku bila nonce-nya = nonce akun saat ini dan akun itu EOA (atau sudah berdelegasi).
      // Bila tidak, node MELEWATI authorization tanpa error: simulasi "sukses" sebagai call kosong ke EOA,
      // dan sponsor membayar gas untuk transaksi yang tidak melakukan apa pun (bisa diulang tanpa batas).
      const [acctNonce, acctCode] = await Promise.all([
        pub.getTransactionCount({ address: authority, blockTag: "pending" }),
        pub.getCode({ address: authority }),
      ]);
      if (acctNonce !== Number(a.nonce)) return send(res, 409, { error: `authorization nonce ${a.nonce} does not match the wallet nonce ${acctNonce}. Reload and try again.` });
      const code = (acctCode ?? "0x").toLowerCase();
      if (code !== "0x" && !(code.startsWith("0xef0100") && code.length === 48)) return send(res, 403, { error: "account holds contract code, cannot be delegated" });
      if (PUBLIC_MODE && !removal) { try { await assertFeeContract(net, pub, V.getAddress(ours)); } catch (e) { return send(res, 403, { error: e.message }); } }
      if (PUBLIC_MODE && removal) {
        // sponsor hanya membayar penghapusan delegasi ke kontrak kita sendiri (mencegah spam transaksi gratis)
        if (!ours || code !== ("0xef0100" + V.getAddress(ours).slice(2)).toLowerCase())
          return send(res, 403, { error: "no delegation to our contract to remove" });
      }
      const estimate = async () => {
        const gas = await pub.estimateGas({ account: sponsor.address, to: b.to, data: b.data, authorizationList });
        if (PUBLIC_MODE && gas > MAX_GAS) throw httpError(403, `gas ${gas} exceeds cap ${MAX_GAS}`);
        return gas;
      };
      if (b.mode === "simulate") return send(res, 200, { gas: (await estimate()).toString() });
      if (b.mode === "send") {
        if (net === "base" && process.env.CONFIRM_MAINNET !== "yes") return send(res, 403, { error: "Mainnet: set CONFIRM_MAINNET=yes in .env and restart" });
        const g = await estimate();
        const fees = await pub.estimateFeesPerGas();
        let maxFeePerGas = fees.maxFeePerGas, maxPriorityFeePerGas = PRIORITY_FEE;
        if (maxPriorityFeePerGas > maxFeePerGas) maxFeePerGas = maxPriorityFeePerGas + fees.maxFeePerGas;
        if (PUBLIC_MODE && maxFeePerGas > MAX_FEE_WEI) return send(res, 503, { error: `gas price too high right now (${V.formatGwei(maxFeePerGas)} gwei > cap ${MAX_FEE_GWEI}). Try again later.` });
        // batas gas eksplisit: estimasi + 20%, tidak melebihi MAX_GAS di mode publik
        let gas = (g * 12n) / 10n;
        if (PUBLIC_MODE && gas > MAX_GAS) gas = MAX_GAS;
        const wallet = V.createWalletClient({ account: sponsor, chain: CHAINS[net], transport });
        const hash = await wallet.sendTransaction({ to: b.to, data: b.data, authorizationList, gas, maxFeePerGas, maxPriorityFeePerGas });
        return send(res, 200, { hash });
      }
      return send(res, 400, { error: "mode must be simulate | send" });
    }

    const m = url.pathname.match(/^\/rpc\/(sepolia|base)$/);
    if (req.method === "POST" && m) {
      const target = RPCS[m[1]];
      if (!target) return send(res, 503, { error: `RPC ${m[1]} not set in .env` });
      const body = await readJson(req, 1_000_000);
      const calls = Array.isArray(body) ? body : [body];
      if (calls.length === 0 || calls.length > 50) return send(res, 400, { error: "batch must have 1-50 calls" });
      const bad = calls.find((c) => !ALLOW.has(c?.method));
      if (bad) return send(res, 403, { error: `method not allowed: ${bad?.method}` });
      if (PUBLIC_MODE) {
        // tiap call di dalam batch dihitung, jadi batch tidak bisa dipakai untuk melewati batas
        const n = calls.length, tx = calls.filter((c) => c.method === "eth_sendRawTransaction").length;
        if ((wait = take("rpc:" + ip, n, LIMITS.rpcPerMin))) return tooMany(res, wait, "RPC calls per minute");
        if (tx && (wait = take("tx:" + ip, tx, LIMITS.txPerMin))) return tooMany(res, wait, "transactions per minute");
        if ((wait = take("rpc:*", n, LIMITS.rpcGlobalPerMin))) return tooMany(res, wait, "service is busy");
        if ((wait = take("rpc:day", n, LIMITS.rpcPerDay, DAY))) { console.log(`[429] daily RPC limit reached (${LIMITS.rpcPerDay}); resets in ${Math.ceil(wait / 60)} min`); return tooMany(res, wait, "daily service limit reached"); }
      }
      const up = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      return send(res, up.status, scrub(await up.text()));
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e.status === 413) { res.setHeader("connection", "close"); res.on("finish", () => req.destroy()); } // sisa body tidak dibaca
    if (!e.status) console.error("[500]", scrub(e.message ?? e));
    send(res, e.status ?? 500, { error: scrub(e.shortMessage ?? e.message ?? e) });
  }
}).listen(PORT, process.env.BIND ?? HOST, () => {
  const bind = process.env.BIND ?? HOST;
  console.log(`Rescue Console: http://${HOST}:${PORT}  (server.mjs versi 4)`);
  console.log(`Folder   : ${dir}`);
  console.log(PUBLIC_MODE ? `MODE     : PUBLIC (fixed ${FEE_BPS / 100}% fee on the claimed amount, gas cap ${MAX_GAS}, fee cap ${MAX_FEE_GWEI} gwei)` : "MODE     : private (no fee, local-only)");
  console.log(`Hosts    : localhost, 127.0.0.1${PUBLIC_MODE && PUBLIC_HOSTS.length ? ", " + PUBLIC_HOSTS.join(", ") : ""}`);
  if (PUBLIC_MODE) console.log(`Limits   : per IP/min: ${LIMITS.reqPerMin} requests, ${LIMITS.rpcPerMin} RPC calls, ${LIMITS.txPerMin} tx | all users: ${LIMITS.rpcGlobalPerMin} RPC/min, ${LIMITS.rpcPerDay} RPC/day`);
  if (PUBLIC_MODE && PUBLIC_HOSTS.length && !TRUST_PROXY) console.log("WARNING  : TRUST_PROXY=false behind a tunnel/proxy means ALL visitors share one per-IP limit. Set TRUST_PROXY=true when using ngrok or a reverse proxy.");
  if (PUBLIC_HOSTS.length && !PUBLIC_MODE) console.log("NOTE     : PUBLIC_HOST is ignored because PUBLIC_MODE=false (private mode only answers local requests).");
  if (!PUBLIC_MODE && !isLoopback(bind) && bind !== "localhost") console.log(`NOTE     : BIND=${bind}, but private mode still rejects non-local connections.`);
  if (!fs.existsSync(path.join(dir, "node_modules/bootstrap/dist/css/bootstrap.min.css"))) console.log("NOTE: Bootstrap not installed. Run: npm install");
  if (!fs.existsSync(path.join(dir, "vendor/viem.js"))) console.log("WARNING  : vendor/viem.js missing, the page cannot load. Run: npm install (or npm run build)");
  const c = readConfig();
  if (configError) console.log("WARNING:", configError);
  console.log(`delegate : sepolia=${c.sepolia?.delegate || "(empty)"}  base=${c.base?.delegate || "(empty)"}`);
  if (PUBLIC_MODE) for (const n of ["sepolia", "base"]) if (RPCS[n] && !(c[n]?.allowedTargets ?? []).length) console.log(`WARNING  : allowedTargets for ${n} is empty, every public rescue on ${n} will be rejected.`);
  console.log(`Icon     : ${iconHit?.[0] ?? "(none, built-in icon)"}`);
  console.log(`RPC      : sepolia=${RPCS.sepolia ? "OK" : "NOT SET"}  base=${RPCS.base ? "OK" : "NOT SET"}`);
  console.log(`sponsor  : ${sponsor?.address ?? "(disabled: check SPONSOR_PK / npm install)"}`);
  // mode publik: periksa sekali saat start bahwa delegate tiap jaringan memang RescueFee
  if (PUBLIC_MODE && V) for (const n of ["sepolia", "base"]) {
    const d = c[n]?.delegate;
    if (!RPCS[n] || !d || !V.isAddress(d)) continue;
    assertFeeContract(n, V.createPublicClient({ chain: CHAINS[n], transport: V.http(RPCS[n]) }), V.getAddress(d))
      .then(() => console.log(`contract : ${n} delegate is RescueFee (${FEE_BPS / 100}% fee) OK`))
      .catch((e) => console.log(`WARNING  : ${scrub(e.message)}`));
  }
});
