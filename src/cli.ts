#!/usr/bin/env bun

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "vellum-ai/velly";

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

    throw new Error(
      `Failed to download ${name}: HTTP ${res.status}`
    );
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

async function hatch(): Promise<void> {
  console.log("Fetching latest release...");
  const release = await fetchLatestRelease();

  const assistantAsset = findAssetOrThrow(release, "assistant");
  const gatewayAsset = findAssetOrThrow(release, "gateway");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velly-"));

  try {
    console.log(`Downloading assets from ${release.tag_name}...`);
    const [assistantDir, gatewayDir] = await Promise.all([
      extractAsset(
        assistantAsset.browser_download_url,
        tmpDir,
        "assistant"
      ),
      extractAsset(gatewayAsset.browser_download_url, tmpDir, "gateway"),
    ]);

    console.log("Starting assistant daemon...");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "bun",
        ["run", "src/index.ts", "daemon", "start"],
        { cwd: assistantDir, stdio: "inherit" }
      );
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Daemon start exited with code ${code}`));
      });
      child.on("error", reject);
    });

    console.log("Starting gateway...");
    const vellumLogDir = path.join(os.homedir(), ".vellum", "data", "logs");
    fs.mkdirSync(vellumLogDir, { recursive: true });
    const logFd = fs.openSync(path.join(vellumLogDir, "vellum.log"), "a");
    const gatewayChild = spawn("bun", ["run", "src/index.ts"], {
      cwd: gatewayDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    gatewayChild.unref();
    fs.closeSync(logFd);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
