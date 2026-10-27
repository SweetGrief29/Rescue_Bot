# Rescue Console (EIP-7702)

Alat untuk menyelamatkan token airdrop dari wallet yang private key-nya bocor. Dalam **satu transaksi atomik** alat ini:

1. mendelegasikan wallet bocor ke kontrak penyelamat (EIP-7702),
2. menjalankan call klaim airdrop,
3. memindahkan token ke wallet aman,
4. lalu menghapus delegasi.

Gas dibayar oleh **wallet sponsor**, sehingga wallet bocor tidak perlu menerima ETH (yang biasanya langsung disedot bot pencuri). Private key wallet bocor hanya dipakai untuk menandatangani **di browser**, tidak pernah dikirim ke server.

> Gunakan hanya untuk wallet milik sendiri. Kontrak belum diaudit: uji di Sepolia sebelum memakai dana nyata.

---

## 1. Ringkasan file

| File                           | Fungsi                                                                                                                        | Rahasia? | Anda edit? |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| `.env`                         | Rahasia dan pengaturan server: **RPC Infura**, key sponsor, mode, domain publik. Dibuat dari `.env.example`.                  | **Ya**   | Ya         |
| `.env.example`                 | Contoh isi `.env` (tanpa nilai rahasia).                                                                                      | Tidak    | Tidak      |
| `config.json`                  | Pengaturan non-rahasia per jaringan: **alamat kontrak delegate**, token, target klaim, daftar `allowedTargets`.               | Tidak    | Ya         |
| `server.mjs`                   | Backend lokal: menyajikan halaman, meneruskan RPC (key Infura tersembunyi dari browser), relay sponsor, validasi mode publik. | Tidak    | Jarang     |
| `index.html`                   | Halaman web (UI). Penandatanganan terjadi di sini.                                                                            | Tidak    | Jarang     |
| `contracts/RescueDelegate.sol` | Kontrak **mode pribadi** (tanpa fee).                                                                                         | Tidak    | Tidak      |
| `contracts/RescueFee.sol`      | Kontrak **mode publik**: fee 20% dari hasil klaim, tetap di kontrak.                                                          | Tidak    | Tidak      |
| `contracts/MockAirdrop.sol`    | Token dan airdrop palsu untuk uji di Sepolia.                                                                                 | Tidak    | Tidak      |
| `test/RescueFee.t.sol`         | Tes Foundry untuk `RescueFee`.                                                                                                | Tidak    | Tidak      |
| `rescue.ts`                    | Versi baris perintah (CLI), hanya untuk mode pribadi.                                                                         | Tidak    | Tidak      |
| `package.json`                 | Dependensi dan perintah `npm`.                                                                                                | Tidak    | Tidak      |
| `favicon.*` (opsional)         | Ikon tab Anda sendiri, ditaruh sejajar `server.mjs`.                                                                          | Tidak    | Opsional   |

`.env` sudah masuk `.gitignore`. **Jangan pernah meng-commit atau membagikan `.env`.**

---

## 2. Menjalankan

Prasyarat: **Node.js 20.12 atau lebih baru** (disarankan 22 LTS). Cek dengan `node -v`.

```powershell
cd D:\Recall\Rescue_Bot
npm install
copy .env.example .env
notepad .env          # isi RPC Infura dan lainnya (lihat bagian 3)
notepad config.json   # isi alamat delegate dan lainnya (lihat bagian 4)
npm start
```

Buka **http://127.0.0.1:3000**. Saat server menyala, terminal mencetak ringkasan (mode, host yang diizinkan, ikon, status RPC, delegate, sponsor). Baca baris itu untuk memastikan konfigurasi terbaca.

Setiap kali Anda mengubah `.env` atau `server.mjs`, **restart server** (Ctrl+C lalu `npm start`). `config.json` dibaca ulang tiap permintaan: cukup muat ulang halaman (Ctrl+F5).

---

## 3. `.env`: RPC Infura dan pengaturan server

Salin `.env.example` menjadi `.env`, lalu isi. Berikut variabel yang dipakai **server** (`npm start`):

| Variabel           | Isi                                           | Keterangan                                                                                                        |
| ------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SEPOLIA_RPC`      | `https://sepolia.infura.io/v3/<API_KEY>`      | RPC Sepolia (uji).                                                                                                |
| `BASE_RPC`         | `https://base-mainnet.infura.io/v3/<API_KEY>` | RPC Base mainnet.                                                                                                 |
| `SPONSOR_PK`       | `0x...` (64 hex)                              | Wallet sponsor milik server. Dipakai bila pengguna tidak punya wallet sponsor di browser. Isi saldo kecil saja.   |
| `PORT`             | `3000`                                        | Port server.                                                                                                      |
| `PUBLIC_MODE`      | `false` / `true`                              | **Pengubah mode** (lihat bagian 5).                                                                               |
| `MAX_GAS`          | `700000`                                      | Batas gas per transaksi sponsor (mode publik). Rescue uji memakai sekitar 560 ribu, jadi pertimbangkan `1000000`. |
| `PUBLIC_HOST`      | `domain-anda.com`                             | Domain yang diizinkan selain localhost. Bisa banyak (pisah koma) atau pola `*.ngrok-free.dev`.                    |
| `BIND`             | `127.0.0.1`                                   | Alamat yang didengarkan server. Biarkan bila memakai reverse proxy atau ngrok.                                    |
| `TRUST_PROXY`      | `false` / `true`                              | `true` bila di belakang ngrok atau reverse proxy (agar batas permintaan dihitung per pengunjung).                 |
| `CONFIRM_MAINNET`  | `no` / `yes`                                  | Relay server menolak kirim di Base kecuali `yes`.                                                                 |
| `PRIORITY_FEE_WEI` | `10000000`                                    | Tip gas (0,01 gwei). Naikkan di jaringan dengan tip minimum tinggi.                                               |

Variabel lain di `.env.example` (`NETWORK`, `LEAKED_PK`, `SAFE`, `DELEGATE`, `TOKEN`, `CLAIM`, `CLAIM_DATA`, `AMOUNT`, `ACTION`, `NATIVE_VALUE`, `DRY_RUN`) hanya dipakai oleh **CLI** (bagian 9). Kalau Anda hanya memakai web, abaikan.

Tips:

- Pakai API key Infura **baru**, dan jangan bagikan. Key yang pernah tertempel di chat atau layar sebaiknya diganti.
- Tanpa `SEPOLIA_RPC` / `BASE_RPC`, halaman tidak punya RPC (dengan CSP ketat, RPC publik diblokir). Terminal menampilkan `RPC : sepolia=OK base=NOT SET`.

---

## 4. `config.json`: alamat kontrak delegate dan lainnya

Berisi pengaturan non-rahasia. Struktur:

```json
{
  "safe": "",
  "sepolia": {
    "action": "claim_transfer",
    "delegate": "0xALAMAT_KONTRAK_DI_SEPOLIA",
    "token": "",
    "claim": "",
    "value": "0",
    "allowedTargets": []
  },
  "base": {
    "action": "claim_transfer",
    "delegate": "0xALAMAT_KONTRAK_DI_BASE",
    "token": "",
    "claim": "",
    "value": "0",
    "allowedTargets": ["0xKONTRAK_KLAIM_YANG_SUDAH_ANDA_PERIKSA"]
  }
}
```

| Kunci            | Arti                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegate`       | **Alamat kontrak penyelamat yang sudah Anda deploy**, satu per jaringan. Wajib. Mode pribadi memakai `RescueDelegate`, mode publik memakai `RescueFee`.                             |
| `token`          | Alamat token airdrop (terisi otomatis di form).                                                                                                                                     |
| `claim`          | Alamat kontrak klaim (terisi otomatis di form).                                                                                                                                     |
| `action`         | Default pilihan Action Type. Di mode publik hanya `claim_transfer`.                                                                                                                 |
| `value`          | Native value default (ETH) untuk call klaim. Harus `0` di mode publik.                                                                                                              |
| `allowedTargets` | **Mode publik:** daftar kontrak klaim yang boleh dipanggil lewat relay. Isi hanya kontrak yang sudah Anda tinjau (fungsi klaimnya harus membayar `msg.sender`, bukan alamat bebas). |
| `safe`           | Wallet aman bawaan. Di **mode publik diabaikan** (tidak diisi otomatis ke pengguna); biarkan kosong.                                                                                |

Pastikan JSON valid (tanda kutip ganda, tanpa koma berlebih). Kalau rusak, terminal dan console browser (F12) menampilkan pesan `config.json unreadable`.

---

## 5. Mengubah mode: pribadi vs publik

|                       | **Mode pribadi**                        | **Mode publik**                                               |
| --------------------- | --------------------------------------- | ------------------------------------------------------------- |
| `PUBLIC_MODE`         | `false`                                 | `true`                                                        |
| Kontrak di `delegate` | `RescueDelegate`                        | `RescueFee`                                                   |
| Fee                   | Tidak ada                               | **20% dari hasil klaim**, ke wallet penerima fee              |
| Action Type di UI     | Claim & Transfer, Transfer only, Custom | Hanya Claim & Transfer                                        |
| Validasi relay        | Dasar                                   | Template ketat, `allowedTargets`, batas gas, batas permintaan |
| Cocok untuk           | Memakai sendiri di PC Anda              | Layanan untuk orang lain (misalnya lewat ngrok)               |

**Langkah beralih mode** (semuanya wajib, karena kontrak harus cocok dengan mode):

1. Deploy kontrak yang sesuai (bagian 6) di jaringan yang dipakai.
2. Isi `delegate` di `config.json` dengan alamat kontrak itu. Untuk mode publik, isi juga `allowedTargets`.
3. Ubah `PUBLIC_MODE` di `.env`.
4. Restart `npm start`, lalu muat ulang halaman (Ctrl+F5).
5. Cek terminal: `MODE : PUBLIC (...)` atau `MODE : private (no fee)`.

Kontrak dan mode yang tidak cocok menghasilkan error (mis. `Delegate is not the RescueFee contract` atau transaksi gagal). Kalau semua token masuk ke wallet safe tanpa fee, kemungkinan besar server masih di mode pribadi atau `delegate` masih kontrak lama.

### Aturan fee mode publik

- Fee **20% dari hasil klaim** (saldo sesudah klaim dikurangi saldo sebelumnya). Saldo yang sudah ada sebelum klaim ikut dipindahkan ke wallet safe **tanpa fee**.
- Persentase tertulis tetap di kontrak, dan **penerima fee ditentukan saat deploy** (tidak bisa diubah setelahnya).
- Call klaim wajib, dan transaksi dibatalkan bila tidak ada fee yang terkumpul (dibatalkan saat simulasi, sebelum membayar gas).
- Hanya token yang diisi di kolom Token yang disapu.
- Batas yang tidak bisa ditutup: pemegang private key selalu bisa menandatangani delegasi lain dan membayar gas sendiri. Fee dijamin untuk transaksi yang lewat sponsor dan relay Anda.

---

## 6. Deploy kontrak

Kompilator Solidity **0.8.24 atau lebih baru**, dengan OpenZeppelin (`@openzeppelin/contracts`). Di Remix, impor OpenZeppelin dikenali otomatis.

| Kontrak                    | Argumen konstruktor                                      | Untuk            |
| -------------------------- | -------------------------------------------------------- | ---------------- |
| `RescueDelegate`           | (tidak ada)                                              | Mode pribadi     |
| `RescueFee`                | `feeRecipient`: **alamat wallet Anda yang menerima fee** | Mode publik      |
| `MockToken`, `MockAirdrop` | `MockAirdrop(tokenAddress, 100e18)`                      | Uji Sepolia saja |

Foundry:

```bash
forge install OpenZeppelin/openzeppelin-contracts
forge create contracts/RescueFee.sol:RescueFee --rpc-url $RPC --private-key $PK --constructor-args 0xWALLET_PENERIMA_FEE
```

Setelah deploy:

- Verifikasi source di explorer (Etherscan/BaseScan).
- Untuk `RescueFee`, cek `FEE_RECIPIENT()` dan `FEE_BPS()` (harus `2000`) di explorer.
- Isi alamatnya di `config.json` untuk jaringan yang sesuai.
- Kontrak harus di-deploy **sekali per jaringan**; alamatnya berbeda di tiap jaringan.

Uji Sepolia dengan kontrak uji: deploy `MockToken`, `MockAirdrop`, kirim token ke airdrop, lalu `CLAIM_DATA` untuk `claim()` adalah `0x4e71d92d`.

---

## 7. Memakai UI

1. Pilih jaringan di bagian atas (Sepolia untuk uji, Base untuk mainnet).
2. Tab **Sponsor Wallet**: klik _Generate Wallet_, lalu **kirim ETH di jaringan yang dipilih** ke alamat sponsor (banner menunjukkan jaringannya). Simpan recovery phrase. Wallet ini tersimpan di `localStorage` browser, jadi cadangkan sebelum mendanai dan isi saldo seperlunya saja.
3. Tab **Rescue Wallet**: isi
   - **Compromised key**: private key wallet bocor (dikosongkan setiap halaman dimuat),
   - **Safe wallet**: tujuan token (di mode publik harus diisi pengguna sendiri),
   - **Target contract** dan **Raw calldata**: kontrak klaim dan calldata fungsi klaim,
   - **Token Address**: token yang akan dipindahkan,
   - **Native value**: biasanya `0`.
4. Centang _I own this compromised wallet_, lalu **Execute**. Alur: persiapan, simulasi, satu konfirmasi (di mode publik menampilkan persen dan penerima fee), kirim, lalu hapus delegasi otomatis.

Prioritas sponsor: wallet sponsor di browser dipakai lebih dulu. Bila tidak ada, dipakai `SPONSOR_PK` dari server (lewat relay).

Jumlah token selalu **seluruh saldo (all)**.

---

## 8. Membuka ke publik (ngrok atau domain)

1. `ngrok http 3000`, salin domain dari baris `Forwarding` **tanpa `https://`** (contoh `tummy-laptop-recipient.ngrok-free.dev`).
2. Di `.env`:
   ```
   PUBLIC_MODE=true
   PUBLIC_HOST=tummy-laptop-recipient.ngrok-free.dev
   TRUST_PROXY=true
   ```
   Atau `PUBLIC_HOST=*.ngrok-free.dev` agar tidak perlu diganti saat domain berubah.
3. Restart server. Terminal menampilkan `Hosts : localhost, 127.0.0.1, <domain>`.

**Jangan membuka server dalam mode pribadi**: siapa pun dengan URL bisa memakai wallet sponsor dan kuota Infura Anda tanpa fee dan tanpa validasi. Mode publik menyalakan rate limit (6 permintaan relay dan 120 permintaan RPC per menit per IP), batas gas, validasi template, dan fee.

Isi `config.json` untuk mode publik: `delegate` = alamat `RescueFee`, `allowedTargets` terisi, `safe` kosong. Saldo `SPONSOR_PK` cukup kecil.

---

## 9. CLI (opsional)

`rescue.ts` adalah versi baris perintah untuk **mode pribadi** (memakai `RescueDelegate`, bukan `RescueFee`). Variabel yang dibaca: `NETWORK`, `LEAKED_PK`, `SPONSOR_PK`, `SAFE`, `DELEGATE`, `TOKEN`, `CLAIM`, `CLAIM_DATA`, `AMOUNT`, `ACTION`, `NATIVE_VALUE`, `DRY_RUN`, `CONFIRM_MAINNET`, `PRIORITY_FEE_WEI`.

```powershell
npm run check      # saldo, delegasi aktif (tidak mengirim apa pun)
npm run rescue     # DRY_RUN=true = hanya simulasi; false = kirim
npm run cleanup    # hapus delegasi
```

Selalu mulai dengan `NETWORK=sepolia` dan `DRY_RUN=true`. Untuk Base nyata: `NETWORK=base`, `DRY_RUN=false`, `CONFIRM_MAINNET=yes`.

---

## 10. Tampilan: Bootstrap, favicon, CSP

- **Bootstrap** dimuat lokal dari `node_modules` lewat `/vendor/bootstrap.css`. Bila tampilan polos, jalankan `npm install` dan restart. Tanpa Bootstrap, gaya cadangan dipakai.
- **Favicon sendiri**: taruh `favicon.ico` / `.png` / `.svg` / `.jpg` / `.webp` sejajar `server.mjs`, lalu restart. Tanpa file, ikon bawaan dipakai. Bila belum berubah, tutup tab atau coba jendela penyamaran (cache Chrome).
- **CSP** ada di tag `<meta http-equiv="Content-Security-Policy">` di `index.html`. Bila Anda mengubahnya, pertahankan `img-src 'self' data:` (ikon, tanda centang, panah dropdown) dan `connect-src 'self'` (minimal, agar RPC lewat backend).

---

## 11. Biaya gas

Satu rescue uji memakai sekitar **560 ribu gas**. Biaya USD = `gas × harga gas (gwei) × 10⁻⁹ × harga ETH`. Di Sepolia tidak bernilai uang. Di mainnet sangat bergantung jaringan: L2 seperti Base jauh lebih murah daripada Ethereum mainnet saat ramai. Sponsor menanggung gas, jadi pastikan fee (20% dari klaim) lebih besar dari biaya gas; klaim yang terlalu kecil bisa merugi.

---

## 12. Pemecahan masalah

| Gejala                                                         | Penyebab dan solusi                                                                                                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 host rejected: <domain>`                                  | Domain belum ada di `PUBLIC_HOST`. Isi domain lengkap (tanpa `https://`), restart server.                                                                                                    |
| `delegate not allowed on <net>` (dari relay)                   | `delegate` di `config.json` kosong atau beda dari yang dipakai. Samakan, pastikan JSON valid, muat ulang halaman.                                                                            |
| `No delegate set for <net>`                                    | `delegate` untuk jaringan itu kosong di `config.json`.                                                                                                                                       |
| Token 100% masuk ke wallet safe, tanpa fee                     | Server masih mode pribadi (`PUBLIC_MODE` belum `true` atau server belum di-restart), atau `delegate` masih kontrak lama. Cek baris `MODE` di terminal. Bisa juga wallet safe = penerima fee. |
| `Delegate is not the RescueFee contract`                       | `delegate` bukan kontrak `RescueFee`. Deploy `RescueFee` dan perbarui `config.json`.                                                                                                         |
| `Fee mismatch: contract X bps, server Y bps`                   | Kontrak bukan versi 20%. Deploy ulang versi yang benar.                                                                                                                                      |
| `Only Claim & Transfer is available in public mode`            | Mode publik hanya mendukung klaim. Pilih Claim & Transfer.                                                                                                                                   |
| `claim target not in allowedTargets`                           | Tambahkan kontrak klaim ke `allowedTargets` (jaringan yang sesuai).                                                                                                                          |
| `gas ... exceeds cap`                                          | Naikkan `MAX_GAS` di `.env`, lalu restart.                                                                                                                                                   |
| `Sponsor balance is 0 on <net>`                                | Kirim ETH di jaringan itu ke alamat sponsor.                                                                                                                                                 |
| `Service unavailable` di log                                   | Backend tidak terhubung. Pastikan `npm start` berjalan. Detail ada di console (F12).                                                                                                         |
| Banyak error `violates connect-src` di console                 | RPC jaringan itu belum diisi di `.env` (lihat baris `RPC` di terminal). Isi, restart.                                                                                                        |
| `Element #... not found`                                       | `index.html` tidak lengkap atau versi lama. Ganti dengan versi terbaru.                                                                                                                      |
| Tampilan polos, tanda centang tidak muncul                     | Bootstrap belum termuat (`npm install`) atau CSP tanpa `img-src`.                                                                                                                            |
| Favicon tidak berubah                                          | Cek baris `Icon` di terminal, restart server, lalu Ctrl+F5 atau jendela penyamaran.                                                                                                          |
| `Cannot find module` / `process.loadEnvFile is not a function` | Jalankan `npm install` atau perbarui Node ke 20.12 atau lebih baru.                                                                                                                          |

---

## 13. Daftar periksa keamanan

- [ ] `.env` tidak pernah di-commit atau dibagikan; API key Infura baru.
- [ ] Wallet sponsor hanya berisi ETH secukupnya.
- [ ] Mode publik (`PUBLIC_MODE=true`) aktif sebelum membuka ke internet.
- [ ] `allowedTargets` hanya berisi kontrak klaim yang sudah diperiksa.
- [ ] Kontrak diverifikasi di explorer dan **diaudit** sebelum memegang dana orang lain.
- [ ] Tes `test/RescueFee.t.sol` dijalankan di Foundry (`forge test`), dan kasus penolakan relay diuji di Sepolia.
- [ ] Ganti pustaka dari `esm.sh` ke salinan lokal bila akan dipakai luas (halaman ini memegang private key).
- [ ] Pertimbangkan aspek hukum dan kepercayaan sebelum membuka layanan yang meminta private key atau memungut fee.
