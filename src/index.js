/**
 * DXD CDN Worker
 *
 * A custom CDN implementation for serving files from GitHub repositories.
 * Supports versioning, minification, and compression.
 *
 * Source: https://github.com/${DEFAULT_GITHUB_OWNER}/dxd-cdn
 * Author: Austin Thesing
 * License: MIT
 *
 * Features:
 * - Serves files from GitHub repositories with version control
 * - Supports commit hashes and release tags
 * - Automatic minification for JS and CSS files
 * - R2 caching for improved performance
 * - Compression for script/link requests
 * - Browser-friendly file previews
 */

const CONTENT_TYPES = {
	js: 'application/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	html: 'text/html; charset=utf-8',
	json: 'application/json; charset=utf-8',
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
	txt: 'text/plain; charset=utf-8',
	md: 'text/markdown; charset=utf-8',
	xml: 'text/xml; charset=utf-8',
	yaml: 'text/yaml; charset=utf-8',
	yml: 'text/yaml; charset=utf-8',
};

// Compression helper function
async function compress(content, type) {
	if (typeof content === 'string') {
		content = new TextEncoder().encode(content);
	} else if (content instanceof Response) {
		content = new Uint8Array(await content.arrayBuffer());
	} else if (content instanceof ArrayBuffer) {
		content = new Uint8Array(content);
	}

	if (type === 'gzip') {
		const cs = new CompressionStream('gzip');
		const writer = cs.writable.getWriter();
		writer.write(content);
		writer.close();
		return new Response(cs.readable).arrayBuffer();
	}
	return content;
}

// Minification support
const terser = require('terser');
const CleanCSS = require('clean-css');

// File types that should be previewed in browser
const PREVIEW_TYPES = new Set([
	'pdf',
	'html',
	'htm',
	'jpg',
	'jpeg',
	'png',
	'gif',
	'svg',
	'webp',
	'js',
	'css',
	'json',
	'txt',
	'md',
	'xml',
	'yaml',
	'yml',
]);

// Default GitHub owner
const DEFAULT_GITHUB_OWNER = 'austin-thesing';

// Cache for GitHub data (in-memory, will reset on worker restart)
const GITHUB_CACHE = new Map();
const CACHE_TTL = 300000; // 5 minutes in milliseconds

async function minifyContent(content, extension) {
	switch (extension) {
		case 'js':
			try {
				const result = await terser.minify(content);
				return result.code;
			} catch (error) {
				console.error('JS minification failed:', error);
				return content;
			}
		case 'css':
			try {
				const result = new CleanCSS().minify(content);
				return result.styles;
			} catch (error) {
				console.error('CSS minification failed:', error);
				return content;
			}
		default:
			return content;
	}
}

async function getCommit(repo, commit, env) {
	// Support both short and full hashes
	const response = await fetch(`https://api.github.com/repos/${DEFAULT_GITHUB_OWNER}/${repo}/commits/${commit}`, {
		headers: {
			'User-Agent': 'DXD-CDN',
			Authorization: `token ${env.GITHUB_TOKEN}`,
		},
	});

	if (!response.ok) {
		throw new Error('Invalid commit hash');
	}

	const data = await response.json();
	return {
		fullHash: data.sha,
		shortHash: commit,
	};
}

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

async function getFileFromGitHub(repo, version, filePath, env, ctx, shouldMinify = false, request) {
	let targetVersion = version;
	let actualVersion = version;
	let isCommit = false;

	if (version === 'latest') {
		const release = await getLatestRelease(repo, env);
		targetVersion = release.tag_name;
		actualVersion = targetVersion;
	} else if (version.length >= 7) {
		try {
			const commit = await getCommit(repo, version, env);
			targetVersion = commit.fullHash;
			actualVersion = version.substring(0, 7);
			isCommit = true;
		} catch (error) {
			targetVersion = version;
			actualVersion = version;
		}
	}

	if (!isCommit) {
		targetVersion = targetVersion.replace(/^v/, '');
	}

	const rawUrl = isCommit
		? `https://raw.githubusercontent.com/${DEFAULT_GITHUB_OWNER}/${repo}/${targetVersion}/${filePath}`
		: `https://raw.githubusercontent.com/${DEFAULT_GITHUB_OWNER}/${repo}/v${targetVersion}/${filePath}`;

	const response = await fetch(rawUrl, {
		headers: {
			'User-Agent': 'DXD-CDN',
			Authorization: `token ${env.GITHUB_TOKEN}`,
		},
	});

	if (!response.ok) {
		throw new Error('Failed to fetch file from GitHub');
	}

	const content = await response.text();
	const extension = filePath.split('.').pop().toLowerCase();
	const processedContent = shouldMinify ? await minifyContent(content, extension) : content;

	const r2Key = `${repo}/${actualVersion}/${filePath}${shouldMinify ? '.min' : ''}`;
	ctx.waitUntil(
		(async () => {
			try {
				await env.CDN_BUCKET.put(r2Key, processedContent, {
					httpMetadata: {
						contentType: CONTENT_TYPES[extension] || 'text/plain; charset=utf-8',
					},
				});
				console.log(`Cached ${r2Key} in R2`);
			} catch (error) {
				console.error(`Failed to cache ${r2Key} in R2:`, error);
			}
		})()
	);

	// Only compress if specifically requested by a script/link tag
	const acceptHeader = request.headers.get('Accept') || '';
	const isScriptRequest =
		acceptHeader.includes('application/javascript') || acceptHeader.includes('text/javascript') || acceptHeader.includes('text/css');

	// Prepare response with optional compression
	let responseContent = processedContent;
	const headers = {
		'Content-Type': CONTENT_TYPES[extension] || 'text/plain; charset=utf-8',
		Vary: 'Accept-Encoding, Accept',
		'X-Content-Type-Options': 'nosniff',
		'Content-Disposition': 'inline',
	};

	// Only compress if it's a script/link request and client supports gzip
	if (isScriptRequest && request.headers.get('Accept-Encoding')?.includes('gzip')) {
		const compressedContent = await compress(responseContent, 'gzip');
		if (compressedContent) {
			responseContent = compressedContent;
			headers['Content-Encoding'] = 'gzip';
		}
	}

	return new Response(responseContent, { headers });
}

// HTML template for the converter portal
const PORTAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DXD CDN URL Converter</title>
    <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
</head>
<body class="bg-gray-100 min-h-screen">
    <div class="container mx-auto px-4 py-8 max-w-3xl">
        <h1 class="text-3xl font-bold text-gray-800 mb-8">DXD CDN URL Converter</h1>
        
        <div class="bg-white rounded-lg shadow-md p-6">
            <div class="mb-6">
                <label class="block text-gray-700 text-sm font-bold mb-2" for="github-url">
                    GitHub File URL
                </label>
                <input type="text" id="github-url" 
                    class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="https://github.com/austin-thesing/repo/blob/main/src/file.js">
            </div>

            <div class="mb-6">
                <label class="block text-gray-700 text-sm font-bold mb-2">Options</label>
                <div class="space-y-2">
                    <label class="flex items-center">
                        <input type="checkbox" id="minify" class="form-checkbox h-4 w-4 text-blue-600">
                        <span class="ml-2 text-gray-700">Minify output (.min)</span>
                    </label>
                </div>
            </div>

            <div class="mb-6">
                <label class="block text-gray-700 text-sm font-bold mb-2">Version Type</label>
                <div class="space-y-2">
                    <label class="flex items-center">
                        <input type="radio" name="version-type" value="commit" class="form-radio h-4 w-4 text-blue-600" checked>
                        <span class="ml-2 text-gray-700">Use commit</span>
                    </label>
                    <label class="flex items-center">
                        <input type="radio" name="version-type" value="release" class="form-radio h-4 w-4 text-blue-600">
                        <span class="ml-2 text-gray-700">Use release version</span>
                    </label>
                    <label class="flex items-center">
                        <input type="radio" name="version-type" value="latest" class="form-radio h-4 w-4 text-blue-600">
                        <span class="ml-2 text-gray-700">Use latest release</span>
                    </label>
                </div>
            </div>

            <div id="version-selector" class="mb-6">
                <label class="block text-gray-700 text-sm font-bold mb-2">Select Version</label>
                <select id="version-select" 
                    class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">Paste a GitHub URL above to load versions...</option>
                </select>
            </div>

            <button id="convert" 
                class="w-full bg-blue-500 text-white font-bold py-2 px-4 rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50">
                Generate CDN URL
            </button>

            <div id="result" class="mt-6 hidden">
                <label class="block text-gray-700 text-sm font-bold mb-2">CDN URL</label>
                <div class="flex">
                    <input type="text" id="cdn-url" readonly
                        class="flex-1 px-3 py-2 border border-gray-300 rounded-l-md bg-gray-50">
                    <button id="copy" 
                        class="px-4 py-2 bg-gray-200 text-gray-700 font-medium rounded-r-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500">
                        Copy
                    </button>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentRepo = '';
        let commits = [];
        let releases = [];

        async function fetchVersions(owner, repo) {
            try {
                // Fetch commits
                const commitsResponse = await fetch(\`https://api.github.com/repos/\${owner}/\${repo}/commits?per_page=10\`);
                commits = await commitsResponse.json();

                // Fetch releases
                const releasesResponse = await fetch(\`https://api.github.com/repos/\${owner}/\${repo}/releases\`);
                releases = await releasesResponse.json();

                updateVersionSelector();
            } catch (error) {
                console.error('Error fetching versions:', error);
            }
        }

        function updateVersionSelector() {
            const select = document.getElementById('version-select');
            const versionType = document.querySelector('input[name="version-type"]:checked').value;
            
            select.innerHTML = '';
            
            if (versionType === 'commit') {
                commits.forEach(commit => {
                    const shortHash = commit.sha.substring(0, 7);
                    const message = commit.commit.message.split('\\n')[0];
                    const option = document.createElement('option');
                    option.value = shortHash;
                    option.textContent = \`\${shortHash} - \${message}\`;
                    select.appendChild(option);
                });
            } else if (versionType === 'release') {
                releases.forEach(release => {
                    const option = document.createElement('option');
                    option.value = release.tag_name;
                    option.textContent = \`\${release.tag_name} - \${release.name || 'No title'}\`;
                    select.appendChild(option);
                });
            }

            // Show/hide version selector based on version type
            const versionSelector = document.getElementById('version-selector');
            versionSelector.classList.toggle('hidden', versionType === 'latest');
        }

        // Handle GitHub URL input with debounce
        let debounceTimer;
        document.getElementById('github-url').addEventListener('input', async (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                const url = e.target.value;
                const match = url.match(/github\\.com\\/([^\\/]+)\\/([^\\/]+)/);
                
                if (match && match[2] !== currentRepo) {
                    currentRepo = match[2].replace(/\\.git$/, ''); // Remove .git if present
                    await fetchVersions('${DEFAULT_GITHUB_OWNER}', currentRepo);
                }
            }, 500); // Wait 500ms after typing stops
        });

        // Handle version type change
        document.querySelectorAll('input[name="version-type"]').forEach(radio => {
            radio.addEventListener('change', updateVersionSelector);
        });

        document.getElementById('convert').addEventListener('click', async () => {
            const githubUrl = document.getElementById('github-url').value;
            const shouldMinify = document.getElementById('minify').checked;
            const versionType = document.querySelector('input[name="version-type"]:checked').value;
            
            try {
                // Parse GitHub URL
                const urlParts = githubUrl.match(/github\\.com\\/([^\\/]+)\\/([^\\/]+)(?:\\/blob\\/([^\\/]+))?\\/(.+)/);
                if (!urlParts) {
                    throw new Error('Invalid GitHub URL format');
                }

                const [, owner, repoWithGit, , path] = urlParts;
                const repo = repoWithGit.replace(/\\.git$/, ''); // Remove .git if present
                
                if (owner !== '${DEFAULT_GITHUB_OWNER}') {
                    throw new Error('Repository must be under ${DEFAULT_GITHUB_OWNER}');
                }

                // Get version
                let version;
                if (versionType === 'latest') {
                    version = 'latest';
                } else {
                    const selectedVersion = document.getElementById('version-select').value;
                    if (!selectedVersion) {
                        throw new Error('Please select a version');
                    }
                    version = selectedVersion;
                }

                // Construct CDN URL
                let cdnPath = path;
                if (shouldMinify) {
                    const ext = path.split('.').pop();
                    if (ext === 'js' || ext === 'css') {
                        cdnPath = path.replace('.' + ext, '.min.' + ext);
                    }
                }

                const cdnUrl = \`https://cdn.designxdevelop.com/\${repo}/\${version}/\${cdnPath}\`;

                // Show result
                document.getElementById('result').classList.remove('hidden');
                document.getElementById('cdn-url').value = cdnUrl;
            } catch (error) {
                alert(error.message);
            }
        });

        document.getElementById('copy').addEventListener('click', () => {
            const cdnUrl = document.getElementById('cdn-url');
            cdnUrl.select();
            document.execCommand('copy');
            const button = document.getElementById('copy');
            button.textContent = 'Copied!';
            setTimeout(() => {
                button.textContent = 'Copy';
            }, 2000);
        });
    </script>
</body>
</html>`;

export default {
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);
			const path = url.pathname.slice(1);

			// Serve the converter portal at /convert
			if (path === 'convert') {
				return new Response(PORTAL_HTML, {
					headers: {
						'Content-Type': 'text/html',
						'Cache-Control': 'public, max-age=3600',
					},
				});
			}

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
			let filePath = pathParts.slice(2).join('/');

			// Check if .min version is requested
			const shouldMinify = filePath.endsWith('.min.js') || filePath.endsWith('.min.css');
			if (shouldMinify) {
				filePath = filePath.replace('.min', '');
			}

			if (!repo || !version || !filePath) {
				return new Response('Invalid path format. Use: /repo/version/file-path', { status: 400 });
			}

			let response;
			const extension = filePath.split('.').pop().toLowerCase();
			const contentType = CONTENT_TYPES[extension] || 'application/octet-stream';

			try {
				// First try R2 bucket with exact path (including .min if requested)
				const r2Path = `${repo}/${version}/${filePath}${shouldMinify ? '.min' : ''}`;
				let r2Object = await env.CDN_BUCKET.get(r2Path);

				// If version is 'latest', also check R2 for the actual version
				if (!r2Object && version === 'latest') {
					const release = await getLatestRelease(repo, env);
					const latestVersion = release.tag_name;
					const latestPath = `${repo}/${latestVersion}/${filePath}${shouldMinify ? '.min' : ''}`;
					r2Object = await env.CDN_BUCKET.get(latestPath);
				}

				if (r2Object) {
					const extension = filePath.split('.').pop().toLowerCase();
					const acceptHeader = request.headers.get('Accept') || '';
					const isScriptRequest =
						acceptHeader.includes('application/javascript') ||
						acceptHeader.includes('text/javascript') ||
						acceptHeader.includes('text/css');

					let responseContent = await r2Object.text();

					const headers = {
						'Content-Type': CONTENT_TYPES[extension] || 'text/plain; charset=utf-8',
						Vary: 'Accept-Encoding, Accept',
						'X-Content-Type-Options': 'nosniff',
						'Content-Disposition': 'inline',
					};

					// Only compress if it's a script/link request and client supports gzip
					if (isScriptRequest && request.headers.get('Accept-Encoding')?.includes('gzip')) {
						const compressedContent = await compress(responseContent, 'gzip');
						if (compressedContent) {
							responseContent = compressedContent;
							headers['Content-Encoding'] = 'gzip';
						}
					}

					response = new Response(responseContent, { headers });
					console.log(`Served ${r2Path} from R2`);
				} else {
					response = await getFileFromGitHub(repo, version, filePath, env, ctx, shouldMinify, request);
					console.log(`Served ${r2Path} from GitHub`);
				}

				// Add CORS and caching headers
				const finalHeaders = new Headers(response.headers);
				finalHeaders.set('Cache-Control', 'public, max-age=31536000');
				finalHeaders.set('Access-Control-Allow-Origin', '*');

				return new Response(response.body, { headers: finalHeaders });
			} catch (error) {
				return new Response(`File not found: ${error.message}`, { status: 404 });
			}
		} catch (error) {
			return new Response(`Error: ${error.message}`, { status: 500 });
		}
	},
};
