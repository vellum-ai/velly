#!/usr/bin/env bun

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "vellum-ai/velly";
const INSTALL_DIR = path.join(os.homedir(), ".local", "share", "vellum");

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (!res.ok) {
    throw new Error(
      `Failed to fetch latest release: ${res.status} ${await res.text()}`
    );
  }

  return res.json();
}

const NOT_FOUND_STATUS = 404;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadAsset(
  url: string,
  destPath: string,
  name: string
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      fs.writeFileSync(destPath, Buffer.from(buffer));
      return;
    }

    if (RETRYABLE_STATUS_CODES.has(res.status) && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `Failed to download ${name} (HTTP ${res.status}), retrying in ${delay / 1_000}s (attempt ${attempt}/${MAX_RETRIES})...`
      );
      await sleep(delay);
      continue;
    }

    const err = new Error(
      `Failed to download ${name}: HTTP ${res.status}`
    );
    (err as Error & { statusCode: number }).statusCode = res.status;
    throw err;
  }
}

function findAssetOrThrow(
  release: GitHubRelease,
  prefix: string
): GitHubAsset {
  const asset = release.assets.find((a) => a.name.startsWith(prefix));
  if (!asset) {
    throw new Error(
      `No ${prefix} artifact found in release ${release.tag_name}`
    );
  }
  return asset;
}

async function extractAsset(
  url: string,
  tmpDir: string,
  name: string
): Promise<string> {
  const zipPath = path.join(tmpDir, `${name}.zip`);
  const destDir = path.join(tmpDir, name);

  await downloadAsset(url, zipPath, name);

  console.log(`Extracting ${name}...`);
  fs.mkdirSync(destDir, { recursive: true });
  execSync(`unzip -q "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
  fs.rmSync(zipPath);

  console.log(`Installing ${name} dependencies...`);
  execSync("bun install", { cwd: destDir, stdio: "inherit" });

  return destDir;
}

function linkBun(): void {
  const bunPath = execSync("which bun", { encoding: "utf-8" }).trim();
  const binDir = path.join(os.homedir(), ".local", "bin");
  const linkPath = path.join(binDir, "bun");

  fs.mkdirSync(binDir, { recursive: true });

  if (bunPath !== linkPath) {
    fs.copyFileSync(bunPath, linkPath);
    fs.chmodSync(linkPath, 0o755);
    console.log(`Linked bun to ${linkPath}`);
  }
}

function linkVellumCli(assistantDir: string): void {
  const entryPoint = path.join(assistantDir, "src", "index.ts");
  const binDir = path.join(os.homedir(), ".local", "bin");
  const bunPath = path.join(binDir, "bun");
  const wrapper = `#!/bin/bash\nexec "${bunPath}" run "${entryPoint}" "$@"\n`;
  const linkPath = path.join(binDir, "vellum");

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(linkPath, wrapper, { mode: 0o755 });
  console.log(`Linked vellum CLI to ${linkPath}`);
}

function is404Error(err: unknown): boolean {
  if (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode: number }).statusCode === NOT_FOUND_STATUS
  ) {
    return true;
  }
  const message = (err as Error).message || "";
  return message.includes("404");
}

function recoverFromHatchFailure(): void {
  console.log("Attempting recovery via gcloud...");
  execSync(
    "gcloud compute scp web/public/install.sh vargas-jr:/tmp/install.sh --zone=us-central1-a --project=vellum-nonprod",
    { stdio: "inherit" }
  );
  execSync(
    'gcloud compute ssh dvargas@vargas-jr --zone=us-central1-a --project=vellum-nonprod --command="source /tmp/install.sh"',
    { stdio: "inherit" }
  );
  console.log("Recovery completed successfully.");
}

async function hatch(): Promise<void> {
  console.log("Fetching latest release...");
  const release = await fetchLatestRelease();

  const assistantAsset = findAssetOrThrow(release, "assistant");
  const gatewayAsset = findAssetOrThrow(release, "gateway");

  if (fs.existsSync(INSTALL_DIR)) {
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  try {
    console.log(`Downloading assets from ${release.tag_name}...`);
    const [assistantDir, gatewayDir] = await Promise.all([
      extractAsset(
        assistantAsset.browser_download_url,
        INSTALL_DIR,
        "assistant"
      ),
      extractAsset(gatewayAsset.browser_download_url, INSTALL_DIR, "gateway"),
    ]);

    linkBun();
    linkVellumCli(assistantDir);

    console.log("Starting assistant daemon...");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "bun",
        ["run", "src/index.ts", "daemon", "start"],
        {
          cwd: assistantDir,
          stdio: "inherit",
          env: { ...process.env, RUNTIME_HTTP_PORT: "7821" },
        }
      );
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Daemon start exited with code ${code}`));
      });
      child.on("error", reject);
    });

    console.log("Starting gateway...");
    const vellumDir = path.join(os.homedir(), ".vellum");
    fs.mkdirSync(vellumDir, { recursive: true });
    const gatewayLogPath = path.join(vellumDir, "http-gateway.log");
    const logFd = fs.openSync(gatewayLogPath, "a");
    const gatewayChild = spawn("bun", ["run", "src/index.ts"], {
      cwd: gatewayDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    gatewayChild.unref();
    fs.closeSync(logFd);
  } catch (err) {
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
    if (is404Error(err)) {
      console.warn(
        `Download failed with 404, falling back to gcloud recovery...`
      );
      recoverFromHatchFailure();
      return;
    }
    throw err;
  }
}

const command = process.argv[2];

if (command === "hatch") {
  hatch().catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
} else {
  console.error("Usage: velly hatch");
  process.exit(1);
}
