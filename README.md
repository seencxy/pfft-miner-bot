# PFFT Miner Bot

CLI bot untuk mining/mint `https://pffthash.com/` (Pow Free Fair Mint) di Ethereum mainnet.

- Contract: `0xEFAd2Eab7172dDEbE5Ce7a41f5Ddf8fCcE4Ca0CB`
- PoW: `keccak256(solidityPacked(['bytes32','uint256'], [currentPowChallenge(wallet), nonce])) <= POW_TARGET()`
- Submit: `freeMint(uint256 powNonce)`
- GPU mode: CUDA solver untuk NVIDIA RTX, termasuk 1x RTX 5090.

> Gunakan burner wallet. Jangan commit private key / `.env`.

## Fresh VPS GPU install — 1x RTX 5090

```bash
apt update
apt install -y git curl screen build-essential make
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Cek GPU/CUDA dari image provider
nvidia-smi
nvcc --version || true
```

Kalau `nvcc` belum ada, install CUDA toolkit sesuai image Ubuntu/provider. Di Vast biasanya pilih image CUDA dev/runtime yang sudah ada `nvcc`; kalau belum:

```bash
apt install -y nvidia-cuda-toolkit || true
```

## Clone & install

```bash
cd /root
git clone https://github.com/bibnk/pfft-miner-bot.git
cd pfft-miner-bot
npm install
npm run selftest
```

## Build CUDA solver

```bash
cd /root/pfft-miner-bot
make cuda
# hasil binary:
ls -lh build/pfft-cuda-miner
```

Jika `-arch=native` gagal di nvcc lama, edit `Makefile` ganti:

```makefile
-arch=native
```

menjadi salah satu:

```makefile
-arch=sm_120
```

atau fallback:

```makefile
-gencode arch=compute_120,code=sm_120
```

RTX 5090 / Blackwell butuh CUDA baru. VPS kamu tertulis Max CUDA 13.2, jadi seharusnya cocok.

## Config

```bash
export PFFT_RPC_URL="https://ethereum-rpc.publicnode.com"
export PFFT_PRIVATE_KEY="PRIVATE_KEY_BURNER_WALLET"
```

Disarankan pakai RPC premium/low latency, bukan public RPC.

## Cek status

```bash
node pfft-miner.mjs status --address 0xWalletKamu
```

## Dry-run GPU dulu

Cari nonce valid pakai RTX 5090 tapi **tidak kirim transaksi**:

```bash
node pfft-miner.mjs mine --gpu --dry-run --count 1
```

## Real GPU mining / mint

```bash
node pfft-miner.mjs mine --gpu --count 1
```

Dengan gas manual:

```bash
node pfft-miner.mjs mine --gpu --count 1 --max-fee-gwei 3 --priority-gwei 0.2
```

Pilih GPU langsung dari command line:

```bash
node pfft-miner.mjs mine --gpu --count 0 --cuda-device 0
node pfft-miner.mjs mine --gpu --count 0 --cuda-device 1
```

Mode interaktif multi-GPU dalam satu terminal:

```bash
node pfft-miner.mjs mine --multi-gpu --fund-mnemonic --count 0 --cuda-bin ./build/pfft-cuda-miner --start-random
```

Bot akan menjalankan `nvidia-smi -L`, menanyakan jumlah GPU yang dipakai, meminta satu funding private key dan satu target mnemonic, lalu meminta start index dan jumlah ETH untuk tiap GPU wallet. Setelah transfer ETH ke wallet hasil derivasi mnemonic selesai, bot langsung memakai wallet tersebut untuk mining.

Default path mnemonic:

```text
m/44'/60'/0'/0/{index}
```

Jika tidak memakai `--fund-mnemonic`, multi-GPU mode akan menanyakan apakah ingin memakai funding private key + mnemonic. Jawab `n` untuk mode lama: input private key berbeda untuk tiap GPU.

Jika salah satu wallet terkena `Exceed per address limit`, GPU tersebut otomatis mengambil index mnemonic berikutnya, mengirim ETH amount yang sama dari funding wallet, lalu lanjut mining dengan wallet baru.

## Fund wallets from mnemonic

Standalone ETH distribution, without starting miners:

```bash
node pfft-miner.mjs fund-wallets
```

The command asks for the funding private key, target mnemonic, mnemonic start index, wallet count, and ETH amount per wallet. It previews all target addresses and requires typing `SEND` before broadcasting.

Dry-run without sending:

```bash
node pfft-miner.mjs fund-wallets --start-index 0 --wallet-count 8 --amount-eth 0.01 --dry-run
```

Secrets can also be provided through env vars:

```bash
export PFFT_FUNDER_PRIVATE_KEY="PRIVATE_KEY_WITH_ETH"
export PFFT_TARGET_MNEMONIC="word1 word2 ..."
node pfft-miner.mjs fund-wallets --start-index 8 --wallet-count 8 --amount-eth 0.01
```

Bot otomatis menambahkan buffer 20% di atas `estimateGas` untuk menghindari transaksi gagal karena gas limit terlalu mepet. Override manual jika perlu:

```bash
node pfft-miner.mjs mine --gpu --count 1 --gas-limit 200000
node pfft-miner.mjs mine --gpu --count 1 --gas-buffer-percent 100
```

GPU mode memakai start nonce uint64 acak secara default supaya miner tidak terus mencari di range yang sama dengan miner lain. Flag `--start-random` juga diterima:

```bash
node pfft-miner.mjs mine --gpu --count 1 --start-random
```

Untuk benchmark/reproducible test, start bisa dipatok manual:

```bash
node pfft-miner.mjs mine --gpu --dry-run --count 1 --start 0
```

Jika contract menolak dengan `Duplicate POW nonce`, bot otomatis mencari nonce baru sampai 5 kali. Ubah limit retry:

```bash
node pfft-miner.mjs mine --gpu --count 1 --duplicate-retries 10
```

Mint berkali-kali:

```bash
# mint 5x lalu stop
node pfft-miner.mjs mine --gpu --count 5

# infinite loop: mint terus sampai screen/process distop
node pfft-miner.mjs mine --gpu --count 0

# shortcut npm infinite loop
npm run mine:gpu
```

Helper script infinite loop:

```bash
./start-gpu-loop.sh
```

Atur jumlah mint lewat env:

```bash
PFFT_COUNT=10 ./start-gpu-loop.sh
```

## Run screen infinite GPU

```bash
cd /root/pfft-miner-bot
export PFFT_RPC_URL="RPC_ETH_KAMU"
export PFFT_PRIVATE_KEY="PRIVATE_KEY_BURNER_WALLET"

screen -S pfft -dm bash -lc './start-gpu-loop.sh'
```

Cek log:

```bash
tail -f /root/pfft-miner.log
```

Attach:

```bash
screen -r pfft
```

Stop:

```bash
screen -S pfft -X quit
```

## CPU fallback

Kalau CUDA build belum siap:

```bash
node pfft-miner.mjs mine --dry-run --count 1 --workers 4
node pfft-miner.mjs mine --count 1 --workers 4
```

## Update VPS

```bash
cd /root/pfft-miner-bot
git pull
npm install
make cuda
npm run selftest
```
