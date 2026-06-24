import { Storage } from "@google-cloud/storage";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import "dotenv/config";

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const REGION = process.env.GCS_REGION ?? "us-central1";
const PROTOTYPES_DIR = join(__dirname, "prototypes");

if (!PROJECT_ID || !BUCKET_NAME) {
  console.error(
    "Error: GCP_PROJECT_ID and GCS_BUCKET_NAME must be set. Copy .env.example to .env.",
  );
  process.exit(1);
}

const storage = new Storage({ projectId: PROJECT_ID });
const bucket = storage.bucket(BUCKET_NAME);

// Resolve the email of the ADC principal so we can grant it write access on the bucket.
async function getAdcEmail(): Promise<string> {
  const client = await (storage as any).authClient.getClient();
  const { token } = await client.getAccessToken();
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${token}`,
  );
  const info = (await res.json()) as any;
  if (!info.email)
    throw new Error(
      "Could not resolve ADC email from token. Run: gcloud auth application-default login",
    );
  return info.email;
}

function md5Base64(filePath: string): string {
  return createHash("md5").update(readFileSync(filePath)).digest("base64");
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(fullPath));
    else results.push(fullPath);
  }
  return results;
}

async function ensureBucket(userEmail: string): Promise<void> {
  const [exists] = await bucket.exists();
  if (!exists) {
    await storage.createBucket(BUCKET_NAME!, {
      location: REGION,
      uniformBucketLevelAccess: true,
    });
    console.log(`Created bucket: gs://${BUCKET_NAME}\n`);
  }

  // Always (re)apply IAM so a fresh bucket or a misconfigured one both work.
  // - allUsers: public read for sharing URLs
  // - userEmail: admin so this script can upload and delete objects
  // Requires "Public Access Prevention" to be off (default for non-org GCP accounts).
  await Promise.all([
    bucket.iam.setPolicy({
      bindings: [
        { role: "roles/storage.objectViewer", members: ["allUsers"] },
        { role: "roles/storage.admin", members: [`user:${userEmail}`] },
      ],
    }),
    bucket.setMetadata({ labels: { owner: "michal", service: "claude" } }),
  ]);
}

interface SyncResult {
  changed: boolean;
  entryUrl: string | null;
}

async function syncPrototype(name: string): Promise<SyncResult> {
  const protoDir = join(PROTOTYPES_DIR, name);

  // Build if it's a package
  let sourceDir = protoDir;
  if (existsSync(join(protoDir, "package.json"))) {
    process.stdout.write(`  building...`);
    execSync("npm install --silent && npm run build --silent", {
      cwd: protoDir,
    });
    sourceDir = existsSync(join(protoDir, "dist"))
      ? join(protoDir, "dist")
      : join(protoDir, "build");
    process.stdout.write(" ");
  }

  // Collect local files and compute remote paths
  const localFiles = walkFiles(sourceDir);
  const rootHtmlFiles = readdirSync(sourceDir).filter((f) =>
    f.endsWith(".html"),
  );
  // A single non-index HTML file gets normalized to index.html on upload
  const singleHtml =
    rootHtmlFiles.length === 1 && !rootHtmlFiles.includes("index.html")
      ? rootHtmlFiles[0]
      : null;

  // localAbsPath -> gcsObjectName
  const fileMap = new Map<string, string>();
  for (const localPath of localFiles) {
    const rel = relative(sourceDir, localPath).replace(/\\/g, "/");
    const gcsName =
      singleHtml && rel === singleHtml
        ? `${name}/index.html`
        : `${name}/${rel}`;
    fileMap.set(localPath, gcsName);
  }

  // Fetch current GCS state for this prototype prefix
  const [gcsFiles] = await bucket.getFiles({ prefix: `${name}/` });
  const gcsMd5 = new Map<string, string>(
    gcsFiles.map((f) => [f.name, f.metadata.md5Hash as string]),
  );

  let changed = false;

  // Upload new or changed files
  for (const [localPath, gcsName] of fileMap) {
    if (md5Base64(localPath) !== gcsMd5.get(gcsName)) {
      await bucket.upload(localPath, { destination: gcsName });
      changed = true;
    }
    gcsMd5.delete(gcsName); // mark as handled
  }

  // Delete files that no longer exist locally
  for (const [gcsName] of gcsMd5) {
    await bucket.file(gcsName).delete();
    changed = true;
  }

  // Determine the entry point URL to display
  const gcsNames = [...fileMap.values()];
  const entryGcsName =
    gcsNames.find((n) => n === `${name}/index.html`) ??
    gcsNames.find(
      (n) => !n.slice(name.length + 1).includes("/") && n.endsWith(".html"),
    ) ??
    null;

  return {
    changed,
    entryUrl: entryGcsName
      ? `https://storage.googleapis.com/${BUCKET_NAME}/${entryGcsName}`
      : null,
  };
}

async function main() {
  const userEmail = await getAdcEmail();
  await ensureBucket(userEmail);

  const protoNames = readdirSync(PROTOTYPES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const protoSet = new Set(protoNames);

  // Remove GCS prefixes for locally deleted prototypes
  const [allGcsFiles] = await bucket.getFiles();
  const gcsProtoNames = new Set(
    allGcsFiles
      .map((f) => f.name.split("/")[0])
      .filter((n) => n && !protoSet.has(n)),
  );
  for (const name of gcsProtoNames) {
    console.log(`${name}... removed`);
    const [stale] = await bucket.getFiles({ prefix: `${name}/` });
    await Promise.all(stale.map((f) => f.delete()));
  }

  const updated: Array<{ name: string; url: string }> = [];

  for (const name of protoNames) {
    process.stdout.write(`${name}... `);
    const { changed, entryUrl } = await syncPrototype(name);
    if (!changed) {
      console.log("no changes");
    } else if (entryUrl) {
      console.log("updated");
      updated.push({ name, url: entryUrl });
    } else {
      console.log("updated (no HTML entry point found)");
    }
  }

  if (updated.length === 0 && gcsProtoNames.size === 0) {
    console.log("\nNothing changed.");
    return;
  }

  if (updated.length > 0) {
    console.log("\nUpdated:");
    for (const { name, url } of updated) {
      console.log(`  ${name}: ${url}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
