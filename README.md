# Rescue Console (EIP-7702)

1. `npm install`
2. Salin `.env.example` ke `.env`: isi `SEPOLIA_RPC`, `BASE_RPC`, `SPONSOR_PK` (API key Infura BARU).
3. Deploy `contracts/RescueDelegate.sol` (Sepolia dan Base), isi alamatnya di `config.json` (`delegate`), beserta `safe`, `token`, `claim`, `claimData`.
4. `npm start` lalu buka http://127.0.0.1:3000 . Yang diisi manual hanya private key wallet bocor.
5. Urutan: Cek -> Simulasi -> Kirim -> Hapus delegasi. Uji dulu di Sepolia. Mainnet butuh `CONFIRM_MAINNET=yes` di `.env`.

CLI alternatif: `npm run check | rescue | cleanup` (membaca `.env`, lihat `.env.example`).
Jalankan server hanya saat dibutuhkan, di PC lokal. Jangan di-host publik.
