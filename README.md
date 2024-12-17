# DXD CDN

A custom CDN implementation using Cloudflare Workers and R2 storage to serve files from GitHub repositories. Supports versioning, minification, and compression.

## Features

- 🌍 Global CDN via Cloudflare's edge network
- 📦 Serves files from public and private GitHub repositories
- 🏷️ Version control support (releases and commit hashes)
- 🔄 Automatic minification for JS and CSS files
- 💾 R2 caching for improved performance
- 🗜️ Automatic compression for script/link requests
- 👀 Browser-friendly file previews

## Setup Instructions

### 1. Cloudflare Setup

1. Create a Cloudflare account if you don't have one
2. Install Wrangler CLI:
   ```bash
   npm install -g wrangler
   ```
3. Login to Cloudflare via Wrangler:
   ```bash
   wrangler login
   ```

### 2. R2 Bucket Setup

1. Create an R2 bucket in Cloudflare Dashboard:

   - Go to R2 section
   - Click "Create bucket"
   - Name it \`dxd-cdn\` (or update wrangler.toml if using a different name)

2. Update wrangler.toml with your bucket details (already configured if using default name)

### 3. GitHub Token Setup

1. Create a GitHub Personal Access Token:

   - Go to GitHub.com → Settings → Developer Settings → Personal Access Tokens → Tokens (classic)
   - Click "Generate new token (classic)"
   - Select scopes:
     - For public repos: \`public_repo\`
     - For private repos: \`repo\` (full control)
   - Copy the generated token

2. Add the token to your worker:
   ```bash
   wrangler secret put GITHUB_TOKEN
   ```
   When prompted, paste your GitHub token

### 4. Custom Domain Setup (Optional)

1. Add your domain in Cloudflare Dashboard:

   - Go to Workers & Pages
   - Select your worker
   - Click "Add Custom Domain"
   - Follow the prompts to add your domain

2. Update wrangler.toml with your domain:
   ```toml
   routes = [
       { pattern = "your-domain.com", custom_domain = true }
   ]
   ```

## Deployment

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

## Usage

### URL Format

\`\`\`
https://your-domain.com/[repo-name]/[version]/[file-path]
\`\`\`

Where:

- \`repo-name\`: Name of your GitHub repository
- \`version\`: Can be:
  - \`latest\` for latest release
  - A specific release tag (e.g., \`v1.0.0\`)
  - A commit hash (full or short, e.g., \`a1b2c3d\`)
- \`file-path\`: Path to the file in the repository

### Examples

```
# Latest version
https://your-domain.com/my-project/latest/dist/script.js

# Specific version
https://your-domain.com/my-project/v1.0.0/dist/script.js

# Specific commit
https://your-domain.com/my-project/a1b2c3d/dist/script.js

# Minified version (add .min before extension)
https://your-domain.com/my-project/latest/dist/script.min.js
```

### URL Converter Tool

Visit \`https://your-domain.com/convert\` for a web interface to generate CDN URLs from GitHub URLs.

## Development

1. Run locally:
   ```bash
   npm run dev
   ```
2. Make changes to \`src/index.js\`
3. Deploy changes:
   ```bash
   npm run deploy
   ```

## Environment Variables

- \`GITHUB_TOKEN\`: GitHub Personal Access Token (required)
- No other environment variables needed

## Limitations

- Only serves files from repositories under specified GitHub account
- Minification only supported for JS and CSS files
- R2 storage limits based on your Cloudflare plan
- GitHub API rate limits apply when fetching new files
