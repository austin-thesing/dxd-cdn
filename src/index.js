/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const CONTENT_TYPES = {
	js: 'application/javascript',
	css: 'text/css',
	html: 'text/html',
	json: 'application/json',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	webp: 'image/webp',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	eot: 'application/vnd.ms-fontobject',
	pdf: 'application/pdf',
};

// File types that should be previewed in browser
const PREVIEW_TYPES = new Set(['pdf', 'html', 'htm', 'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp']);

// Default GitHub owner
const DEFAULT_GITHUB_OWNER = 'austin-thesing';

// Cache for GitHub release data (in-memory, will reset on worker restart)
const GITHUB_CACHE = new Map();
const CACHE_TTL = 300000; // 5 minutes in milliseconds

async function getLatestRelease(repo, env) {
	const cacheKey = `${DEFAULT_GITHUB_OWNER}/${repo}`;
	const now = Date.now();

	// Check cache first
	if (GITHUB_CACHE.has(cacheKey)) {
		const cached = GITHUB_CACHE.get(cacheKey);
		if (now - cached.timestamp < CACHE_TTL) {
			return cached.data;
		}
	}

	// Fetch latest release from GitHub
	const response = await fetch(`https://api.github.com/repos/${DEFAULT_GITHUB_OWNER}/${repo}/releases/latest`, {
		headers: {
			'User-Agent': 'DXD-CDN',
			Authorization: `token ${env.GITHUB_TOKEN}`,
		},
	});

	if (!response.ok) {
		throw new Error('Failed to fetch release data from GitHub');
	}

	const data = await response.json();

	// Cache the result
	GITHUB_CACHE.set(cacheKey, {
		timestamp: now,
		data: data,
	});

	return data;
}

async function getFileFromGitHub(repo, version, filePath, env) {
	let targetVersion = version;
	let actualVersion = version;

	if (version === 'latest') {
		const release = await getLatestRelease(repo, env);
		targetVersion = release.tag_name;
		actualVersion = targetVersion;
	}

	// Remove 'v' prefix if present
	targetVersion = targetVersion.replace(/^v/, '');

	// Construct raw GitHub URL
	const rawUrl = `https://raw.githubusercontent.com/${DEFAULT_GITHUB_OWNER}/${repo}/v${targetVersion}/${filePath}`;

	const response = await fetch(rawUrl, {
		headers: {
			'User-Agent': 'DXD-CDN',
		},
	});

	if (!response.ok) {
		throw new Error('Failed to fetch file from GitHub');
	}

	// Clone the response before using it (since response.body can only be used once)
	const clonedResponse = response.clone();

	// Store in R2 asynchronously using the simplified path format
	const r2Key = `${repo}/${actualVersion}/${filePath}`;
	ctx.waitUntil(
		(async () => {
			try {
				const arrayBuffer = await clonedResponse.arrayBuffer();
				await env.CDN_BUCKET.put(r2Key, arrayBuffer, {
					httpMetadata: {
						contentType: response.headers.get('content-type'),
					},
				});
				console.log(`Cached ${r2Key} in R2`);
			} catch (error) {
				console.error(`Failed to cache ${r2Key} in R2:`, error);
			}
		})()
	);

	return response;
}

export default {
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);
			const path = url.pathname.slice(1); // Remove leading slash
			const forceDownload = url.searchParams.get('download') === 'true';

			if (!path) {
				return new Response('Not Found', { status: 404 });
			}

			// Parse path components: /:repo/:version/:file
			const pathParts = path.split('/');
			if (pathParts.length < 3) {
				return new Response('Invalid path format. Use: /repo/version/file-path', { status: 400 });
			}

			const repo = pathParts[0];
			const version = pathParts[1];
			const filePath = pathParts.slice(2).join('/');

			if (!repo || !version || !filePath) {
				return new Response('Invalid path format. Use: /repo/version/file-path', { status: 400 });
			}

			let response;
			const extension = filePath.split('.').pop().toLowerCase();
			const contentType = CONTENT_TYPES[extension] || 'application/octet-stream';

			try {
				// First try R2 bucket with exact path
				let r2Object = await env.CDN_BUCKET.get(path);

				// If version is 'latest', also check R2 for the actual version
				if (!r2Object && version === 'latest') {
					const release = await getLatestRelease(repo, env);
					const latestVersion = release.tag_name;
					const latestPath = `${repo}/${latestVersion}/${filePath}`;
					r2Object = await env.CDN_BUCKET.get(latestPath);
				}

				if (r2Object) {
					response = new Response(r2Object.body);
					console.log(`Served ${path} from R2`);
				} else {
					response = await getFileFromGitHub(repo, version, filePath, env);
					console.log(`Served ${path} from GitHub`);
				}
			} catch (error) {
				return new Response(`File not found: ${error.message}`, { status: 404 });
			}

			// Prepare headers
			const headers = new Headers({
				'Content-Type': contentType,
				'Cache-Control': 'public, max-age=31536000',
				'Access-Control-Allow-Origin': '*',
			});

			// Set Content-Disposition
			if (forceDownload) {
				headers.set('Content-Disposition', `attachment; filename="${filePath.split('/').pop()}"`);
			} else if (PREVIEW_TYPES.has(extension)) {
				headers.set('Content-Disposition', 'inline');
			}

			// Create new response with our headers
			return new Response(response.body, { headers });
		} catch (error) {
			return new Response(`Error: ${error.message}`, { status: 500 });
		}
	},
};
