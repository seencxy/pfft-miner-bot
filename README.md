# PFFT Miner Bot

CLI bot untuk mining/mint `https://pffthash.com/` (Pow Free Fair Mint) di Ethereum mainnet.

- Contract: `0xEFAd2Eab7172dDEbE5Ce7a41f5Ddf8fCcE4Ca0CB`
- PoW: `keccak256(solidityPacked(['bytes32','uint256'], [currentPowChallenge(wallet), nonce])) <= POW_TARGET()`
- Submit: `freeMint(uint256 powNonce)`

> Gunakan burner wallet. Jangan commit private key / `.env`.

## VPS install

```bash
apt update
apt install -y git curl screen
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v
npm -v
```

## Clone & install

```bash
cd /root
git clone https://github.com/bibnk/pfft-miner-bot.git
cd pfft-miner-bot
npm install
npm run selftest
```

## Config

```bash
export PFFT_RPC_URL="https://ethereum-rpc.publicnode.com"
export PFFT_PRIVATE_KEY="PRIVATE_KEY_BURNER_WALLET"
```

Optional gas:

```bash
export PFFT_WORKERS=4
```

## Cek status

```bash
node pfft-miner.mjs status --address 0xWalletKamu
```

## Dry-run dulu

Cari nonce valid tapi **tidak kirim transaksi**:

```bash
node pfft-miner.mjs mine --dry-run --count 1 --workers 4
```

## Real mining / mint

```bash
node pfft-miner.mjs mine --count 1 --workers 4
```

Dengan gas manual:

```bash
node pfft-miner.mjs mine --count 1 --workers 4 --max-fee-gwei 3 --priority-gwei 0.2
```

Infinite loop:

```bash
node pfft-miner.mjs mine --count 0 --workers 4
```

## Run pakai screen

```bash
cd /root/pfft-miner-bot
export PFFT_RPC_URL="RPC_ETH_KAMU"
export PFFT_PRIVATE_KEY="PRIVATE_KEY_BURNER_WALLET"
screen -S pfft -dm bash -lc 'node pfft-miner.mjs mine --count 0 --workers 4 2>&1 | tee -a /root/pfft-miner.log'
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

## Update VPS

```bash
cd /root/pfft-miner-bot
git pull
npm install
npm run selftest
```
