#!/usr/bin/env node
import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const CONTRACT_ADDRESS = '0xEFAd2Eab7172dDEbE5Ce7a41f5Ddf8fCcE4Ca0CB';
const DEFAULT_RPC_URL = process.env.PFFT_RPC_URL || process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const ABI = [
  'function freeMint(uint256 powNonce) external',
  'function getInfo() view returns (uint256 currentMinted,uint256 remainingSupply,uint256 currentDecayRate,uint256 nextMintAmount)',
  'function calculateActualMint(uint256 requested) view returns (uint256)',
  'function BASE_MINT_AMOUNT() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function currentPowStage() view returns (uint256)',
  'function currentPowHexZeros() view returns (uint256)',
  'function POW_DIFFICULTY_BITS() view returns (uint256)',
  'function POW_DIFFICULTY_MULTIPLIER() view returns (uint256)',
  'function POW_TARGET() view returns (uint256)',
  'function MIN_MINT_AMOUNT() view returns (uint256)',
  'function currentPowChallenge(address user) view returns (bytes32)',
  'function minted(address user) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)'
];

function usage() {
  console.log(`PFFT miner bot

Usage:
  node pfft-miner.mjs status [--address 0x...]
  node pfft-miner.mjs mine [--count 1] [--workers 4] [--gpu] [--dry-run]
  node pfft-miner.mjs mine --multi-gpu [--count 0] [--cuda-bin PATH]
  node pfft-miner.mjs selftest

Env:
  PFFT_PRIVATE_KEY   Private key burner wallet for real mint
  PFFT_RPC_URL       Ethereum mainnet RPC URL (default publicnode)
  ETH_RPC_URL        Fallback RPC URL

Options:
  --count N          Number of successful mints, default 1, use 0 for infinite
  --workers N        Parallel CPU workers in this process, default CPU count-ish
  --gpu              Use CUDA solver ./build/pfft-cuda-miner (run make cuda first)
  --multi-gpu        Interactive multi-GPU CUDA mode with one wallet per GPU
  --cuda-bin PATH    Custom CUDA solver path
  --cuda-device N    Run CUDA solver on physical GPU index N
  --start N          GPU uint64 search start nonce, decimal or hex
  --start-random     Use random GPU search start nonce (default)
  --duplicate-retries N Retry when chain rejects an already used PoW nonce, default 5
  --gas-limit N      Manual gas limit for freeMint transactions
  --gas-buffer-percent N Add gas estimate buffer, default 50
  --dry-run          Find valid PoW nonce but do not send transaction
  --max-fee-gwei N   Optional maxFeePerGas override
  --priority-gwei N  Optional maxPriorityFeePerGas override
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    if (['dry-run', 'help', 'gpu', 'multi-gpu', 'start-random'].includes(key)) { args[key] = true; continue; }
    args[key] = argv[++i];
  }
  return args;
}

function fmtToken(v) {
  return Number(ethers.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function fmtRate(n) {
  if (!Number.isFinite(n)) return '- H/s';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MH/s`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} KH/s`;
  return `${n.toFixed(0)} H/s`;
}
function fmtEta(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${rm}m`;
}

function provider() {
  return new ethers.JsonRpcProvider(DEFAULT_RPC_URL, 1, { staticNetwork: true });
}
function readContract() {
  return new ethers.Contract(CONTRACT_ADDRESS, ABI, provider());
}
function normalizePrivateKey(pk) {
  const s = String(pk || '').trim();
  if (!s) throw new Error('Private key is required');
  return s.startsWith('0x') ? s : `0x${s}`;
}
function walletContractFromPrivateKey(pk) {
  const w = new ethers.Wallet(normalizePrivateKey(pk), provider());
  return { wallet: w, contract: new ethers.Contract(CONTRACT_ADDRESS, ABI, w) };
}
function walletContract() {
  const pk = process.env.PFFT_PRIVATE_KEY;
  if (!pk) throw new Error('Set PFFT_PRIVATE_KEY for mine command. Use burner wallet only.');
  return walletContractFromPrivateKey(pk);
}

function randomUint256() {
  return BigInt('0x' + randomBytes(32).toString('hex'));
}
function randomUint64() {
  return BigInt('0x' + randomBytes(8).toString('hex'));
}
function parseBigIntArg(value, name) {
  if (value === undefined) throw new Error(`${name} requires a value`);
  const s = String(value);
  if (/^0x[0-9a-f]+$/i.test(s) || /^[0-9]+$/.test(s)) return BigInt(s);
  throw new Error(`${name} must be a decimal or hex integer`);
}
function parseUint64Arg(value, name) {
  const v = parseBigIntArg(value, name);
  if (v < 0n || v > ((1n << 64n) - 1n)) throw new Error(`${name} must fit uint64`);
  return v;
}
function parseNonNegativeIntegerArg(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}
function parsePositiveBigIntArg(value, name) {
  const v = parseBigIntArg(value, name);
  if (v <= 0n) throw new Error(`${name} must be greater than zero`);
  return v;
}
function powHash(challenge, nonce) {
  // Matches site worker: ethers.solidityPackedKeccak256(['bytes32','uint256'], [challenge, nonce])
  return BigInt(ethers.solidityPackedKeccak256(['bytes32', 'uint256'], [challenge, nonce]));
}
function validPow(challenge, nonce, target) {
  return powHash(challenge, nonce) <= BigInt(target);
}

async function status(address) {
  const c = readContract();
  const [info, base, target, bits, stage, zeros] = await Promise.all([
    c.getInfo(), c.BASE_MINT_AMOUNT(), c.POW_TARGET(), c.POW_DIFFICULTY_BITS(),
    c.currentPowStage().catch(() => null), c.currentPowHexZeros().catch(() => null)
  ]);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`RPC: ${DEFAULT_RPC_URL}`);
  console.log(`Minted: ${fmtToken(info.currentMinted)} PFFT`);
  console.log(`Remaining: ${fmtToken(info.remainingSupply)} PFFT`);
  console.log(`Next mint quote: ${fmtToken(info.nextMintAmount)} PFFT`);
  console.log(`Base request: ${fmtToken(base)} PFFT`);
  console.log(`PoW target: ${target.toString()}`);
  console.log(`Difficulty: ${bits.toString()}-bit${stage !== null ? ` stage ${Number(stage) + 1}/5` : ''}${zeros !== null ? ` hexZeros ${zeros}` : ''}`);
  const expected = Number((2n ** 256n) / (BigInt(target) + 1n));
  console.log(`Expected tries: ${expected.toLocaleString()}`);
  if (address) {
    const [minted, bal, challenge] = await Promise.all([c.minted(address), c.balanceOf(address), c.currentPowChallenge(address)]);
    console.log(`Wallet: ${address}`);
    console.log(`Wallet minted: ${fmtToken(minted)} PFFT`);
    console.log(`Wallet balance: ${fmtToken(bal)} PFFT`);
    console.log(`Current challenge: ${challenge}`);
  }
}

async function findNonce({ challenge, target, workers = 1, reportMs = 2000 }) {
  target = BigInt(target);
  let attempts = 0n;
  let solved = null;
  const started = Date.now();
  const loops = Array.from({ length: workers }, async (_, id) => {
    let local = 0n;
    while (!solved) {
      const nonce = randomUint256();
      local++;
      if ((local & 0x3fffn) === 0n) attempts += 0x4000n;
      if (validPow(challenge, nonce, target)) {
        attempts += local & 0x3fffn;
        solved = { nonce, worker: id };
        return;
      }
      if ((local % 4096n) === 0n) await new Promise(r => setImmediate(r));
    }
  });
  const timer = setInterval(() => {
    const elapsed = Date.now() - started;
    const rate = Number(attempts) / Math.max(elapsed / 1000, 0.001);
    const expected = Number((2n ** 256n) / (target + 1n));
    const eta = rate > 0 ? Math.max(0, (expected - Number(attempts)) / rate * 1000) : NaN;
    process.stdout.write(`\rAttempts ${attempts.toLocaleString()} | ${fmtRate(rate)} | ETA avg ${fmtEta(eta)}   `);
  }, reportMs);
  await Promise.race(loops.map(p => p.then(() => true)));
  clearInterval(timer);
  process.stdout.write('\n');
  return { ...solved, attempts, elapsedMs: Date.now() - started };
}

function uint256Hex(v) {
  let h = BigInt(v).toString(16);
  if (h.length > 64) throw new Error('uint256 too large');
  return '0x' + h.padStart(64, '0');
}

function errorText(err) {
  return [
    err?.shortMessage,
    err?.reason,
    err?.message,
    err?.info?.error?.message,
    err?.error?.message,
    err?.data?.message
  ].filter(Boolean).join('\n');
}

function isDuplicatePowNonceError(err) {
  return /Duplicate POW nonce/i.test(errorText(err));
}

function isOutOfGasError(err) {
  const receiptGasUsed = err?.receipt?.gasUsed;
  const txGasLimit = err?.transaction?.gasLimit;
  return receiptGasUsed !== undefined && txGasLimit !== undefined && receiptGasUsed === txGasLimit;
}

function txHashFromError(err) {
  return err?.receipt?.hash || err?.transaction?.hash;
}

function withGasBuffer(estimatedGas, bufferPercent) {
  return estimatedGas + (estimatedGas * BigInt(bufferPercent)) / 100n;
}

function defaultLog(message = '') {
  console.log(message);
}

function prefixedLog(label) {
  return (message = '') => console.log(`[${label}] ${message}`);
}

function writeChunkWithPrefix(stream, label, chunk) {
  if (!label) {
    stream.write(chunk);
    return;
  }
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line) stream.write(`[${label}] ${line}\n`);
  }
}

function captureCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function detectCudaDevices() {
  const out = await captureCommand('nvidia-smi', ['-L']);
  const devices = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^GPU\s+(\d+):\s+(.+?)(?:\s+\(UUID:.*)?$/);
    if (m) devices.push({ index: Number(m[1]), name: m[2].trim() });
  }
  if (devices.length === 0) throw new Error('No NVIDIA GPUs detected from nvidia-smi -L');
  return devices;
}

async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

class MutedOutput extends Writable {
  constructor() {
    super();
    this.muted = false;
  }

  _write(chunk, encoding, callback) {
    if (!this.muted) process.stdout.write(chunk, encoding);
    callback();
  }
}

async function promptSecret(question) {
  const output = new MutedOutput();
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const promise = rl.question(question);
    output.muted = true;
    const answer = await promise;
    process.stdout.write('\n');
    return answer.trim();
  } finally {
    output.muted = false;
    rl.close();
  }
}

async function promptGpuCount(devices) {
  while (true) {
    const answer = await promptLine(`How many GPUs to start? [1-${devices.length}, default ${devices.length}]: `);
    const count = answer === '' ? devices.length : Number(answer);
    if (Number.isInteger(count) && count >= 1 && count <= devices.length) return count;
    console.log(`Enter a number from 1 to ${devices.length}.`);
  }
}

async function promptWalletContractForDevice(device) {
  while (true) {
    const pk = await promptSecret(`Private key for GPU ${device.index} (${device.name}): `);
    try {
      const wc = walletContractFromPrivateKey(pk);
      console.log(`GPU ${device.index} wallet: ${wc.wallet.address}`);
      return wc;
    } catch {
      console.log('Invalid private key, try again.');
    }
  }
}

async function findNonceGpu({ challenge, target, bin, start, cudaDevice, label, log = defaultLog }) {
  bin ||= process.env.PFFT_CUDA_BIN || './build/pfft-cuda-miner';
  if (!existsSync(bin)) throw new Error(`CUDA solver not found: ${bin}. Build with: make cuda`);
  const targetBig = BigInt(target);
  const targetHex = uint256Hex(target);
  const startNonce = start === undefined ? randomUint64() : parseUint64Arg(start, '--start');
  const env = cudaDevice === undefined
    ? process.env
    : { ...process.env, CUDA_VISIBLE_DEVICES: String(cudaDevice) };
  log(`CUDA solver: ${bin}`);
  if (cudaDevice !== undefined) log(`CUDA device: ${cudaDevice}`);
  log(`GPU start: ${startNonce.toString()}`);
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, [challenge, targetHex, '--start', startNonce.toString()], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { writeChunkWithPrefix(process.stderr, label, d); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`CUDA solver exited ${code}`));
      const line = out.trim().split(/\s+/).pop();
      if (!line || !/^\d+$/.test(line)) return reject(new Error(`CUDA solver returned invalid nonce: ${out}`));
      const nonce = BigInt(line);
      if (!validPow(challenge, nonce, targetBig)) return reject(new Error(`CUDA solver returned nonce that does not satisfy target: ${nonce}`));
      resolve({ nonce, worker: 'cuda', attempts: 0n, elapsedMs: Date.now() - started });
    });
  });
}

function parseMineOptions(args, forceGpu = false) {
  const count = args.count === undefined ? 1 : parseNonNegativeIntegerArg(args.count, '--count');
  const workers = args.workers ? Math.max(1, parseNonNegativeIntegerArg(args.workers, '--workers')) : Math.max(1, Math.min(8, Number(process.env.PFFT_WORKERS || 4)));
  const duplicateRetries = args['duplicate-retries'] === undefined ? 5 : parseNonNegativeIntegerArg(args['duplicate-retries'], '--duplicate-retries');
  const gasBufferPercent = args['gas-buffer-percent'] === undefined ? 50 : parseNonNegativeIntegerArg(args['gas-buffer-percent'], '--gas-buffer-percent');
  const manualGasLimit = args['gas-limit'] === undefined ? undefined : parsePositiveBigIntArg(args['gas-limit'], '--gas-limit');
  const cudaDevice = args['cuda-device'] === undefined ? undefined : parseNonNegativeIntegerArg(args['cuda-device'], '--cuda-device');
  const dryRun = !!args['dry-run'];
  const useGpu = forceGpu || !!args.gpu;
  if (args.start !== undefined && args['start-random']) throw new Error('Use either --start or --start-random, not both');
  const fixedGpuStart = args.start === undefined ? undefined : parseUint64Arg(args.start, '--start');
  return {
    count,
    workers,
    duplicateRetries,
    gasBufferPercent,
    manualGasLimit,
    cudaDevice,
    dryRun,
    useGpu,
    fixedGpuStart,
    cudaBin: args['cuda-bin'],
    maxFeeGwei: args['max-fee-gwei'],
    priorityGwei: args['priority-gwei']
  };
}

async function runMineLoop({ options, wallet, contract, cudaDevice = options.cudaDevice, label, log = defaultLog }) {
  log(`Wallet: ${wallet.address}`);
  log(`Contract: ${CONTRACT_ADDRESS}`);
  log(`Mode: ${options.dryRun ? 'dry-run (no tx)' : 'real mint'}`);
  let done = 0;
  while (options.count === 0 || done < options.count) {
    let duplicateFailures = 0;
    while (true) {
      const [challenge, target] = await Promise.all([contract.currentPowChallenge(wallet.address), contract.POW_TARGET()]);
      log(`\nChallenge: ${challenge}`);
      log(`Target: ${target.toString()}`);
      const gpuStart = options.useGpu
        ? (options.fixedGpuStart !== undefined && duplicateFailures === 0 ? options.fixedGpuStart : randomUint64())
        : undefined;
      const found = options.useGpu
        ? await findNonceGpu({ challenge, target, bin: options.cudaBin, start: gpuStart, cudaDevice, label, log })
        : await findNonce({ challenge, target, workers: options.workers });
      const rate = Number(found.attempts) / Math.max(found.elapsedMs / 1000, 0.001);
      log(`Solved nonce: ${found.nonce.toString()}`);
      log(`Worker: ${found.worker} | Attempts: ${found.attempts.toLocaleString()} | Rate: ${fmtRate(rate)}`);
      if (options.dryRun) {
        log('Dry-run: transaction not sent.');
        done++;
        break;
      }
      const overrides = {};
      if (options.maxFeeGwei) overrides.maxFeePerGas = ethers.parseUnits(String(options.maxFeeGwei), 'gwei');
      if (options.priorityGwei) overrides.maxPriorityFeePerGas = ethers.parseUnits(String(options.priorityGwei), 'gwei');
      try {
        if (options.manualGasLimit !== undefined) {
          overrides.gasLimit = options.manualGasLimit;
          log(`Gas limit: ${overrides.gasLimit.toString()} (manual)`);
        } else {
          const estimatedGas = await contract.freeMint.estimateGas(found.nonce, overrides);
          overrides.gasLimit = withGasBuffer(estimatedGas, options.gasBufferPercent);
          log(`Gas estimate: ${estimatedGas.toString()} | limit: ${overrides.gasLimit.toString()} (+${options.gasBufferPercent}%)`);
        }
        const tx = await contract.freeMint(found.nonce, overrides);
        log(`Tx sent: ${tx.hash}`);
        const rcpt = await tx.wait();
        if (rcpt.status !== 1) throw new Error(`Mint tx failed: ${tx.hash}`);
        log(`Mint confirmed: block ${rcpt.blockNumber}`);
        done++;
        break;
      } catch (err) {
        if (isDuplicatePowNonceError(err) && duplicateFailures < options.duplicateRetries) {
          duplicateFailures++;
          log(`Duplicate POW nonce rejected; retrying with a new search start (${duplicateFailures}/${options.duplicateRetries}).`);
          continue;
        }
        if (isOutOfGasError(err)) {
          const hash = txHashFromError(err);
          const suffix = hash ? ` Tx: ${hash}` : '';
          throw new Error(`Mint transaction exhausted its gas limit. Increase --gas-limit or --gas-buffer-percent.${suffix}`);
        }
        throw err;
      }
    }
  }
}

async function mineMultiGpu(args) {
  if (args['cuda-device'] !== undefined) throw new Error('Use either --multi-gpu or --cuda-device, not both');
  const options = parseMineOptions(args, true);
  const devices = await detectCudaDevices();
  console.log(`Detected ${devices.length} NVIDIA GPU(s):`);
  for (const d of devices) console.log(`  GPU ${d.index}: ${d.name}`);
  const count = await promptGpuCount(devices);
  const selected = devices.slice(0, count);
  console.log('Enter one private key per GPU. Private keys are used in memory only and are not saved.');
  const workers = [];
  for (const device of selected) {
    const wc = await promptWalletContractForDevice(device);
    workers.push({ device, ...wc });
  }
  console.log(`Starting ${workers.length} GPU miner(s). Count is ${options.count === 0 ? 'infinite' : options.count} per GPU.`);
  const results = await Promise.all(workers.map(({ device, wallet, contract }) => {
    const label = `GPU ${device.index}`;
    return runMineLoop({ options, wallet, contract, cudaDevice: device.index, label, log: prefixedLog(label) })
      .then(() => true)
      .catch(err => {
        console.error(`[${label}] ERROR: ${err.shortMessage || err.reason || err.message || String(err)}`);
        return false;
      });
  }));
  if (results.some(ok => !ok)) throw new Error('One or more GPU miners stopped with errors');
}

async function mine(args) {
  if (args['multi-gpu']) return mineMultiGpu(args);
  const options = parseMineOptions(args);
  const { wallet, contract } = walletContract();
  return runMineLoop({ options, wallet, contract });
}

async function selftest() {
  const challenge = '0x' + '11'.repeat(32);
  const nonce = 123456789n;
  const h = ethers.solidityPackedKeccak256(['bytes32', 'uint256'], [challenge, nonce]);
  if (powHash(challenge, nonce) !== BigInt(h)) throw new Error('powHash mismatch');
  if (!validPow(challenge, nonce, 2n ** 256n - 1n)) throw new Error('validPow high target failed');
  if (validPow(challenge, nonce, 0n) !== (BigInt(h) === 0n)) throw new Error('validPow zero target failed');
  console.log('selftest ok');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || (args.help ? 'help' : 'status');
  if (cmd === 'help' || args.help) return usage();
  if (cmd === 'status') return status(args.address || process.env.PFFT_ADDRESS);
  if (cmd === 'mine') return mine(args);
  if (cmd === 'selftest') return selftest();
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch(err => {
  console.error('ERROR:', err.shortMessage || err.reason || err.message || String(err));
  process.exit(1);
});
