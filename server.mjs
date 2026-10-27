// Backend lokal: menyajikan UI, menyimpan RPC (API key) di server, dan mengisi default otomatis.
// Private key wallet TIDAK pernah dikirim ke backend; penandatanganan tetap di browser.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

try { process.loadEnvFile(".env"); } catch {}
const PORT = Number(process.env.PORT ?? 3000);
const HOST = "127.0.0.1";
const dir = path.dirname(fileURLToPath(import.meta.url));
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
const PUBLIC_HOST = process.env.PUBLIC_HOST; // e.g. rescue.example.com or abc123.ngrok-free.app (comma-separated; "*.ngrok-free.app" = any subdomain)
// tolerant: strips quotes, https://, paths and trailing slashes, lowercases
const PUBLIC_HOSTS = (PUBLIC_HOST ?? "").split(",").map((x) => x.trim().toLowerCase().replace(/^["']|["']$/g, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
const hostAllowed = (h) => PUBLIC_HOSTS.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const hits = new Map();
const limited = (key, max, windowMs = 60_000) => {
  const now = Date.now(), a = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  a.push(now); hits.set(key, a); return a.length > max;
};
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k); }, 300_000).unref();
const clientIp = (req) => (TRUST_PROXY ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
const RESCUE_ABI = V ? V.parseAbi(["function rescue(address claimTarget,bytes claimData,address[] tokens,bool includeNative,address to,uint256 deadline,bytes sig)"]) : null;
// Public mode accepts ONLY rescue(...) on the delegated account (fee is fixed inside RescueFee) or delegation removal (data = 0x).
function validateTemplate(net, authority, data) {
  if (data === "0x") return; // removal: the delegate is already restricted to address(0)
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
const RPCS = { sepolia: process.env.SEPOLIA_RPC, base: process.env.BASE_RPC };

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
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

// Put your own icon next to server.mjs as favicon.ico / .png / .svg / .jpg / .webp (first one found is used)
const ICONS = [["favicon.ico", "image/x-icon"], ["favicon.png", "image/png"], ["favicon.svg", "image/svg+xml"], ["favicon.jpg", "image/jpeg"], ["favicon.webp", "image/webp"]];
const FALLBACK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🛟</text></svg>`;
http.createServer(async (req, res) => {
  try {
    // tolak Host/Origin asing (anti DNS-rebinding & situs lain yang memanggil proxy lokal ini)
    const host = req.headers.host ?? "";
    const isPublicHost = hostAllowed(host.toLowerCase());
    if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}` && !isPublicHost) { console.log(`[403] host rejected: "${host}" | allowed: localhost, 127.0.0.1${PUBLIC_HOSTS.length ? ", " + PUBLIC_HOSTS.join(", ") : " (PUBLIC_HOST is empty)"}`); return send(res, 403, { error: `host rejected: ${host}. Add it to PUBLIC_HOST in .env and restart the server.` }); }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}` && !(isPublicHost && origin === `https://${host}`)) return send(res, 403, { error: `origin rejected: ${origin}` });
    const ip = clientIp(req);

    const url = new URL(req.url, `http://${host}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html"))
      return send(res, 200, fs.readFileSync(path.join(dir, "index.html")), "text/html; charset=utf-8");

    if (req.method === "GET" && (url.pathname === "/favicon" || url.pathname === "/favicon.ico")) {
      const hit = ICONS.find(([name]) => fs.existsSync(path.join(dir, name))); // fixed filenames only (no user-controlled path)
      if (hit) return send(res, 200, fs.readFileSync(path.join(dir, hit[0])), hit[1]);
      return send(res, 200, FALLBACK_ICON, "image/svg+xml");
    }
    if (req.method === "GET" && url.pathname === "/vendor/bootstrap.css") {
      const f = path.join(dir, "node_modules/bootstrap/dist/css/bootstrap.min.css");
      if (!fs.existsSync(f)) return send(res, 404, { error: "bootstrap not installed. Run: npm install" });
      return send(res, 200, fs.readFileSync(f), "text/css; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/api/config")
      return send(res, 200, {
        networks: { sepolia: { available: !!RPCS.sepolia }, base: { available: !!RPCS.base } },
        sponsor: sponsor?.address ?? null,
        fee: PUBLIC_MODE ? { bps: FEE_BPS } : null,
        defaults: readConfig(),
        configError,
      });

    // Sponsor menandatangani & membayar gas di server; key wallet bocor tidak pernah sampai sini.
    if (req.method === "POST" && url.pathname === "/api/relay") {
      if (PUBLIC_MODE && limited("relay:" + ip, 6)) return send(res, 429, { error: "rate limit" });
      if (!sponsor) return send(res, 503, { error: "Relay disabled: set SPONSOR_PK in .env and run npm install" });
      const chunks = []; for await (const c of req) chunks.push(c);
      const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const net = b.net, a = b.authorization ?? {};
      if (!RPCS[net] || !CHAINS[net]) return send(res, 400, { error: "network unavailable" });
      if (!V.isAddress(b.to) || !V.isHex(b.data)) return send(res, 400, { error: "invalid to/data" });
      const authorizationList = [{ address: a.address, chainId: Number(a.chainId), nonce: Number(a.nonce), r: a.r, s: a.s, yParity: Number(a.yParity) }];
      // kunci: tujuan harus akun penanda tangan authorization, dan delegasinya hanya kontrak kita (atau address(0) untuk cleanup)
      const authority = await U.recoverAuthorizationAddress({ authorization: authorizationList[0] });
      if (V.getAddress(b.to) !== V.getAddress(authority)) return send(res, 403, { error: "to != authorization signer" });
      const ours = readConfig()[net]?.delegate;
      const okDelegates = [V.zeroAddress, ...(ours ? [V.getAddress(ours)] : [])];
      if (!okDelegates.includes(V.getAddress(a.address))) return send(res, 403, { error: `delegate not allowed on ${net}. Got: ${a.address} | config.json: ${ours || "(empty)"}. They must match.` });
      if (PUBLIC_MODE) { try { validateTemplate(net, authority, b.data); } catch (e) { return send(res, 403, { error: "template rejected: " + e.message }); } }
      const transport = V.http(RPCS[net]);
      const pub = V.createPublicClient({ chain: CHAINS[net], transport });
      if (b.mode === "simulate") {
        const gas = await pub.estimateGas({ account: sponsor.address, to: b.to, data: b.data, authorizationList });
        if (PUBLIC_MODE && gas > MAX_GAS) return send(res, 403, { error: `gas ${gas} exceeds cap ${MAX_GAS}` });
        return send(res, 200, { gas: gas.toString() });
      }
      if (b.mode === "send") {
        if (net === "base" && process.env.CONFIRM_MAINNET !== "yes") return send(res, 403, { error: "Mainnet: set CONFIRM_MAINNET=yes in .env and restart" });
        if (PUBLIC_MODE) {
          const g = await pub.estimateGas({ account: sponsor.address, to: b.to, data: b.data, authorizationList });
          if (g > MAX_GAS) return send(res, 403, { error: `gas ${g} exceeds cap ${MAX_GAS}` });
        }
        const wallet = V.createWalletClient({ account: sponsor, chain: CHAINS[net], transport });
        const hash = await wallet.sendTransaction({ to: b.to, data: b.data, authorizationList, maxPriorityFeePerGas: BigInt(process.env.PRIORITY_FEE_WEI ?? "10000000") });
        return send(res, 200, { hash });
      }
      return send(res, 400, { error: "mode must be simulate | send" });
    }

    const m = url.pathname.match(/^\/rpc\/(sepolia|base)$/);
    if (req.method === "POST" && m) {
      if (PUBLIC_MODE && limited("rpc:" + ip, 120)) return send(res, 429, { error: "rate limit" });
      const target = RPCS[m[1]];
      if (!target) return send(res, 503, { error: `RPC ${m[1]} not set in .env` });
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 1_000_000) return send(res, 413, { error: "too large" }); chunks.push(c); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const calls = Array.isArray(body) ? body : [body];
      const bad = calls.find((c) => !ALLOW.has(c?.method));
      if (bad) return send(res, 403, { error: `method not allowed: ${bad?.method}` });
      const up = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return send(res, up.status, await up.text());
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e.shortMessage ?? e.message ?? e) });
  }
}).listen(PORT, process.env.BIND ?? HOST, () => {
  console.log(`Rescue Console: http://${HOST}:${PORT}  (server.mjs versi 3)`);
  console.log(`Folder   : ${dir}`);
  console.log(PUBLIC_MODE ? `MODE     : PUBLIC (fixed ${FEE_BPS / 100}% fee on the claimed amount)` : "MODE     : private (no fee)");
  console.log(`Hosts    : localhost, 127.0.0.1${PUBLIC_HOSTS.length ? ", " + PUBLIC_HOSTS.join(", ") : " (no PUBLIC_HOST set)"}`);
  if (PUBLIC_HOSTS.length && !PUBLIC_MODE) console.log("WARNING  : PUBLIC_HOST is set but PUBLIC_MODE=false. Anyone with the URL can use your sponsor wallet and RPC key.");
  if (!fs.existsSync(path.join(dir, "node_modules/bootstrap/dist/css/bootstrap.min.css"))) console.log("NOTE: Bootstrap not installed. Run: npm install");
  const c = readConfig();
  if (configError) console.log("WARNING:", configError);
  console.log(`delegate : sepolia=${c.sepolia?.delegate || "(empty)"}  base=${c.base?.delegate || "(empty)"}`);
  console.log(`Icon     : ${ICONS.find(([n]) => fs.existsSync(path.join(dir, n)))?.[0] ?? "(none, built-in icon)"}`);
  console.log(`RPC      : sepolia=${RPCS.sepolia ? "OK" : "NOT SET"}  base=${RPCS.base ? "OK" : "NOT SET"}`);
  console.log(`sponsor  : ${sponsor?.address ?? "(disabled: check SPONSOR_PK / npm install)"}`);
});
