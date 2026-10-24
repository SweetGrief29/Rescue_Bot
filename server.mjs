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
  catch (e) { configError = `config.json tidak bisa dibaca (${e.message}). Periksa tanda kutip/koma.`; return {}; }
};
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

http.createServer(async (req, res) => {
  try {
    // tolak Host/Origin asing (anti DNS-rebinding & situs lain yang memanggil proxy lokal ini)
    const host = req.headers.host ?? "";
    if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: "host ditolak" });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return send(res, 403, { error: "origin ditolak" });

    const url = new URL(req.url, `http://${host}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html"))
      return send(res, 200, fs.readFileSync(path.join(dir, "index.html")), "text/html; charset=utf-8");

    if (req.method === "GET" && url.pathname === "/api/config")
      return send(res, 200, {
        networks: { sepolia: { available: !!RPCS.sepolia }, base: { available: !!RPCS.base } },
        sponsor: sponsor?.address ?? null,
        defaults: readConfig(),
        configError,
      });

    // Sponsor menandatangani & membayar gas di server; key wallet bocor tidak pernah sampai sini.
    if (req.method === "POST" && url.pathname === "/api/relay") {
      if (!sponsor) return send(res, 503, { error: "Relay nonaktif: isi SPONSOR_PK di .env dan jalankan npm install" });
      const chunks = []; for await (const c of req) chunks.push(c);
      const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const net = b.net, a = b.authorization ?? {};
      if (!RPCS[net] || !CHAINS[net]) return send(res, 400, { error: "jaringan tidak tersedia" });
      if (!V.isAddress(b.to) || !V.isHex(b.data)) return send(res, 400, { error: "to/data tidak valid" });
      const authorizationList = [{ address: a.address, chainId: Number(a.chainId), nonce: Number(a.nonce), r: a.r, s: a.s, yParity: Number(a.yParity) }];
      // kunci: tujuan harus akun penanda tangan authorization, dan delegasinya hanya kontrak kita (atau address(0) untuk cleanup)
      const authority = await U.recoverAuthorizationAddress({ authorization: authorizationList[0] });
      if (V.getAddress(b.to) !== V.getAddress(authority)) return send(res, 403, { error: "to != penanda tangan authorization" });
      const ours = readConfig()[net]?.delegate;
      const okDelegates = [V.zeroAddress, ...(ours ? [V.getAddress(ours)] : [])];
      if (!okDelegates.includes(V.getAddress(a.address))) return send(res, 403, { error: `delegate tidak diizinkan di ${net}. Diterima: ${a.address} | Di config.json: ${ours || "(kosong)"}. Samakan keduanya (config.json -> "${net}" -> "delegate").` });
      const transport = V.http(RPCS[net]);
      const pub = V.createPublicClient({ chain: CHAINS[net], transport });
      if (b.mode === "simulate") {
        const gas = await pub.estimateGas({ account: sponsor.address, to: b.to, data: b.data, authorizationList });
        return send(res, 200, { gas: gas.toString() });
      }
      if (b.mode === "send") {
        if (net === "base" && process.env.CONFIRM_MAINNET !== "yes") return send(res, 403, { error: "Mainnet: set CONFIRM_MAINNET=yes di .env lalu restart server" });
        const wallet = V.createWalletClient({ account: sponsor, chain: CHAINS[net], transport });
        const hash = await wallet.sendTransaction({ to: b.to, data: b.data, authorizationList, maxPriorityFeePerGas: BigInt(process.env.PRIORITY_FEE_WEI ?? "10000000") });
        return send(res, 200, { hash });
      }
      return send(res, 400, { error: "mode harus simulate | send" });
    }

    const m = url.pathname.match(/^\/rpc\/(sepolia|base)$/);
    if (req.method === "POST" && m) {
      const target = RPCS[m[1]];
      if (!target) return send(res, 503, { error: `RPC ${m[1]} belum diisi di .env` });
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 1_000_000) return send(res, 413, { error: "terlalu besar" }); chunks.push(c); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const calls = Array.isArray(body) ? body : [body];
      const bad = calls.find((c) => !ALLOW.has(c?.method));
      if (bad) return send(res, 403, { error: `method tidak diizinkan: ${bad?.method}` });
      const up = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return send(res, up.status, await up.text());
    }
    send(res, 404, { error: "tidak ditemukan" });
  } catch (e) {
    send(res, 500, { error: String(e.shortMessage ?? e.message ?? e) });
  }
}).listen(PORT, HOST, () => {
  console.log(`Rescue Console: http://${HOST}:${PORT}  (server.mjs versi 3)`);
  console.log(`Folder   : ${dir}`);
  const c = readConfig();
  if (configError) console.log("PERINGATAN:", configError);
  console.log(`delegate : sepolia=${c.sepolia?.delegate || "(kosong)"}  base=${c.base?.delegate || "(kosong)"}`);
  console.log(`sponsor  : ${sponsor?.address ?? "(nonaktif: cek SPONSOR_PK / npm install)"}`);
});
