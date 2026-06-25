# Prototyping

Deploy HTML prototypes to Google Cloud Storage and share URLs with the team.

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`)
- A GCP project with the Cloud Storage API enabled

## Setup

**1. Authenticate with GCP**

```bash
gcloud auth application-default login
```

**2. Install dependencies**

```bash
npm install
```

**3. Configure environment**

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable          | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `GCP_PROJECT_ID`  | Your GCP project ID (`gcloud config get-value project`)      |
| `GCS_BUCKET_NAME` | A globally unique bucket name, e.g. `prototypes-yourcompany` |
| `GCS_REGION`      | _(optional)_ Storage region, defaults to `us-central1`       |

The bucket is created automatically on first deploy with public read access.

> **Note:** If your GCP organization enforces "Public Access Prevention," you'll need to disable it for the project before deploying: GCP Console → Cloud Storage → Settings → Public access prevention.

## Adding a prototype

Place the prototype in its own folder under `prototypes/`:

```
prototypes/
  my-feature/
    index.html          ← served as-is
  another-feature/
    Wireframe.html      ← single HTML file, auto-renamed to index.html
    Wireframe_files/    ← assets folder uploaded alongside
  full-app/
    package.json        ← detected as a package; build runs before upload
    src/
    dist/               ← uploaded after build
```

Prototype types are detected automatically:

- **Single HTML file** (with optional asset folders) — uploaded as-is; a lone non-`index.html` file is renamed to `index.html` so the URL is clean.
- **Full package** — if `package.json` is present, `npm install && npm run build` runs first and the `dist/` (or `build/`) folder is uploaded.

## Including folders from other locations

To pull in prototypes stored outside this project (e.g. Claude project folders), create a `mockups.config.json` at the project root:

```json
{
  "sources": [
    {
      "path": "/Users/you/Documents/Claude/Projects/My Feature/prototype",
      "slug": "my-feature"
    },
    "/absolute/path/to/a-folder-of-mockups"
  ]
}
```

Each entry can be a plain path string or an object with `path` and an optional `slug`. The folder is auto-detected:

- **Single prototype** — if the folder itself contains `.html` files or a `package.json`, it's treated as one prototype. The `slug` (or the folder name if omitted) becomes the GCS prefix.
- **Container of prototypes** — otherwise, each subdirectory is treated as an individual prototype, exactly like `prototypes/`. `slug` is not applicable here.

Paths starting with `~/` are expanded to your home directory. The built-in `prototypes/` folder is always included first.

`mockups.config.json` is gitignored since paths are machine-specific.

If two sources produce a prototype with the same name, the first one wins and a warning is printed.

## Deploying

```bash
npm run deploy
```

The script syncs all source folders to GCS and prints URLs for anything that changed:

```
project-1... no changes
project-2... updated

Updated:
  project-2: https://storage.googleapis.com/your-bucket/project-2/index.html
```

## Removing a prototype

Delete the folder from its source directory and run `npm run deploy`. The script detects that the prefix no longer exists locally and removes it from the bucket.

## How it works

- Files are compared by MD5 checksum — only changed files are uploaded.
- Orphaned files within a prototype (renamed or deleted locally) are removed from the bucket.
- Prototype folders deleted locally are fully removed from the bucket on the next deploy.
- The bucket is created once with uniform public read access; subsequent deploys only touch objects.
