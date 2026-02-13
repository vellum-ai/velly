#!/usr/bin/env bun

import crypto from "node:crypto";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function base64url(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function createJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 10 * 60,
    iss: appId,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey, "base64url");

  return `${signingInput}.${signature}`;
}

interface GitHubInstallation {
  id: number;
  account: {
    login: string;
  } | null;
}

interface GitHubAccessToken {
  token: string;
}

async function getInstallationToken(jwt: string): Promise<string> {
  const installationsRes = await fetch(
    "https://api.github.com/app/installations",
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (!installationsRes.ok) {
    throw new Error(
      `Failed to list installations: ${installationsRes.status} ${await installationsRes.text()}`
    );
  }

  const installations: GitHubInstallation[] = await installationsRes.json();
  const installation = installations.find(
    (i) => i.account && i.account.login === "vellum-ai"
  );

  if (!installation) {
    throw new Error(
      'No GitHub App installation found for the "vellum-ai" organization'
    );
  }

  const tokenRes = await fetch(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        repositories: ["vellum-assistant"],
      }),
    }
  );

  if (!tokenRes.ok) {
    throw new Error(
      `Failed to create installation token: ${tokenRes.status} ${await tokenRes.text()}`
    );
  }

  const tokenData: GitHubAccessToken = await tokenRes.json();
  return tokenData.token;
}

async function hatch(): Promise<void> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;

  if (!appId) {
    console.error("Error: GITHUB_APP_ID environment variable is required");
    process.exit(1);
  }

  if (!privateKey) {
    console.error(
      "Error: GITHUB_PRIVATE_KEY environment variable is required"
    );
    process.exit(1);
  }

  console.log("Generating GitHub App token...");
  const jwt = createJWT(appId, privateKey);
  const token = await getInstallationToken(jwt);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velly-"));
  const cloneDir = path.join(tmpDir, "vellum-assistant");
  const assistantDir = path.join(tmpDir, "assistant");

  try {
    console.log("Cloning vellum-assistant...");
    execSync(
      `git clone --depth 1 https://x-access-token:${token}@github.com/vellum-ai/vellum-assistant.git ${cloneDir}`,
      { stdio: "inherit" }
    );

    console.log("Extracting assistant directory...");
    fs.cpSync(path.join(cloneDir, "assistant"), assistantDir, {
      recursive: true,
    });
    fs.rmSync(cloneDir, { recursive: true, force: true });

    console.log("Installing dependencies...");
    execSync("bun install", { cwd: assistantDir, stdio: "inherit" });

    console.log("Starting assistant...");
    const child = spawn("bun", ["run", "src/index.ts"], {
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
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

const command = process.argv[2];

if (command === "hatch") {
  hatch();
} else {
  console.error("Usage: velly hatch");
  process.exit(1);
}
