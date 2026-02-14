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

async function downloadAsset(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download artifact: ${res.status}`);
  }

  const buffer = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
}

async function hatch(): Promise<void> {
  console.log("Fetching latest release...");
  const release = await fetchLatestRelease();

  const assistantAsset = release.assets.find(
    (a) => a.name === "vellum-assistant.zip" || a.name === "assistant.zip"
  );

  if (!assistantAsset) {
    throw new Error(
      `No assistant artifact found in release ${release.tag_name}`
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velly-"));
  const zipPath = path.join(tmpDir, assistantAsset.name);
  const assistantDir = path.join(tmpDir, "assistant");

  try {
    console.log(
      `Downloading ${assistantAsset.name} from ${release.tag_name}...`
    );
    await downloadAsset(assistantAsset.browser_download_url, zipPath);

    console.log("Extracting assistant...");
    fs.mkdirSync(assistantDir, { recursive: true });
    execSync(`unzip -q "${zipPath}" -d "${assistantDir}"`, {
      stdio: "inherit",
    });
    fs.rmSync(zipPath);

    console.log("Installing dependencies...");
    execSync("bun install", { cwd: assistantDir, stdio: "inherit" });

    console.log("Starting assistant daemon...");
    const child = spawn("bun", ["run", "src/index.ts", "daemon", "start"], {
      cwd: assistantDir,
      stdio: "inherit",
    });

    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    process.on("SIGINT", () => forward("SIGINT"));
    process.on("SIGTERM", () => forward("SIGTERM"));

    child.on("exit", (code) => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      process.exit(code ?? 0);
    });
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
