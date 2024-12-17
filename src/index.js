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

	// Store in R2 with text content type for both regular and minified versions
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

	const headers = {
		'Content-Type': CONTENT_TYPES[extension] || 'text/plain; charset=utf-8',
		Vary: 'Accept-Encoding, Accept',
		'X-Content-Type-Options': 'nosniff',
		'Content-Disposition': 'inline',
	};

	// Only compress if specifically requested by a script/link tag
	const acceptHeader = request.headers.get('Accept') || '';
	const isScriptRequest =
		acceptHeader.includes('application/javascript') || acceptHeader.includes('text/javascript') || acceptHeader.includes('text/css');

	if (isScriptRequest && request.headers.get('Accept-Encoding')?.includes('gzip')) {
		const compressedContent = await compress(processedContent, 'gzip');
		if (compressedContent) {
			headers['Content-Encoding'] = 'gzip';
			return new Response(compressedContent, { headers });
		}
	}

	return new Response(processedContent, { headers });
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
            <!-- Tab Buttons -->
            <div class="flex mb-6 border-b">
                <button id="github-tab" class="px-4 py-2 text-sm font-medium text-blue-600 border-b-2 border-blue-600">
                    GitHub URL
                </button>
                <button id="jsdelivr-tab" class="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700">
                    JSDelivr URL
                </button>
            </div>

            <!-- GitHub URL Input -->
            <div id="github-form">
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
            </div>

            <!-- JSDelivr URL Input -->
            <div id="jsdelivr-form" class="hidden">
                <div class="mb-6">
                    <label class="block text-gray-700 text-sm font-bold mb-2" for="jsdelivr-url">
                        JSDelivr URL
                    </label>
                    <input type="text" id="jsdelivr-url" 
                        class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="https://cdn.jsdelivr.net/gh/austin-thesing/repo@version/file.js">
                    <p class="mt-2 text-sm text-gray-500">Example: https://cdn.jsdelivr.net/gh/austin-thesing/utm-cookie@2319025/params.min.js</p>
                </div>
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

        // Tab switching
        document.getElementById('github-tab').addEventListener('click', () => {
            document.getElementById('github-tab').classList.add('text-blue-600', 'border-b-2', 'border-blue-600');
            document.getElementById('jsdelivr-tab').classList.remove('text-blue-600', 'border-b-2', 'border-blue-600');
            document.getElementById('github-form').classList.remove('hidden');
            document.getElementById('jsdelivr-form').classList.add('hidden');
        });

        document.getElementById('jsdelivr-tab').addEventListener('click', () => {
            document.getElementById('jsdelivr-tab').classList.add('text-blue-600', 'border-b-2', 'border-blue-600');
            document.getElementById('github-tab').classList.remove('text-blue-600', 'border-b-2', 'border-blue-600');
            document.getElementById('jsdelivr-form').classList.remove('hidden');
            document.getElementById('github-form').classList.add('hidden');
        });

        document.getElementById('convert').addEventListener('click', async () => {
            try {
                let cdnUrl;
                
                if (!document.getElementById('github-form').classList.contains('hidden')) {
                    // Handle GitHub URL conversion
                    const githubUrl = document.getElementById('github-url').value;
                    const shouldMinify = document.getElementById('minify').checked;
                    const versionType = document.querySelector('input[name="version-type"]:checked').value;
                    
                    // Parse GitHub URL
                    const urlParts = githubUrl.match(/github\\.com\\/([^\\/]+)\\/([^\\/]+)(?:\\/blob\\/([^\\/]+))?\\/(.+)/);
                    if (!urlParts) {
                        throw new Error('Invalid GitHub URL format');
                    }

                    const [, owner, repoWithGit, , path] = urlParts;
                    const repo = repoWithGit.replace(/\\.git$/, '');
                    
                    if (owner !== '${DEFAULT_GITHUB_OWNER}') {
                        throw new Error('Repository must be under ${DEFAULT_GITHUB_OWNER}');
                    }

                    let version;
                    if (versionType === 'latest') {
                        version = 'latest';
                    } else {
                        version = document.getElementById('version-select').value;
                        if (!version) {
                            throw new Error('Please select a version');
                        }
                    }

                    let cdnPath = path;
                    if (shouldMinify) {
                        const ext = path.split('.').pop();
                        if (ext === 'js' || ext === 'css') {
                            cdnPath = path.replace('.' + ext, '.min.' + ext);
                        }
                    }

                    cdnUrl = \`https://cdn.designxdevelop.com/\${repo}/\${version}/\${cdnPath}\`;
                } else {
                    // Handle JSDelivr URL conversion
                    const jsdelivrUrl = document.getElementById('jsdelivr-url').value;
                    const match = jsdelivrUrl.match(/cdn\\.jsdelivr\\.net\\/gh\\/${DEFAULT_GITHUB_OWNER}\\/([^\\/]+)@([^\\/]+)\\/(.+)/);
                    
                    if (!match) {
                        throw new Error('Invalid JSDelivr URL format or not from ${DEFAULT_GITHUB_OWNER}');
                    }

                    const [, repo, version, path] = match;
                    cdnUrl = \`https://cdn.designxdevelop.com/\${repo}/\${version}/\${path}\`;
                }

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

const SPEED_TEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CDN Speed Test</title>
    <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
</head>
<body class="bg-gray-100 min-h-screen">
    <div class="container mx-auto px-4 py-8 max-w-3xl">
        <h1 class="text-3xl font-bold text-gray-800 mb-8">CDN Speed Test</h1>
        
        <div class="bg-white rounded-lg shadow-md p-6">
            <div class="mb-6">
                <label class="block text-gray-700 text-sm font-bold mb-2" for="jsdelivr-url">
                    JSDelivr URL
                </label>
                <input type="text" id="jsdelivr-url" 
                    class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="https://cdn.jsdelivr.net/gh/austin-thesing/repo@version/file.js">
            </div>

            <div class="mb-6">
                <label class="block text-gray-700 text-sm font-bold mb-2">Test Options</label>
                <div class="space-y-2">
                    <label class="flex items-center">
                        <input type="number" id="test-count" value="5" min="1" max="10"
                            class="w-20 px-2 py-1 border border-gray-300 rounded-md">
                        <span class="ml-2 text-gray-700">Number of tests to run</span>
                    </label>
                </div>
            </div>

            <button id="run-test" 
                class="w-full bg-blue-500 text-white font-bold py-2 px-4 rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50">
                Run Speed Test
            </button>

            <div id="results" class="mt-6 hidden">
                <h2 class="text-xl font-bold text-gray-800 mb-4">Test Results</h2>
                
                <div class="grid grid-cols-2 gap-4">
                    <!-- JSDelivr Results -->
                    <div class="p-4 border rounded-lg">
                        <h3 class="font-bold text-lg mb-2">JSDelivr</h3>
                        <div id="jsdelivr-results">
                            <div class="space-y-2">
                                <p>DNS: <span id="jsdelivr-dns" class="font-mono">-</span></p>
                                <p>Connect: <span id="jsdelivr-connect" class="font-mono">-</span></p>
                                <p>TTFB: <span id="jsdelivr-ttfb" class="font-mono">-</span></p>
                                <p>Download: <span id="jsdelivr-download" class="font-mono">-</span></p>
                                <p>Total: <span id="jsdelivr-total" class="font-mono">-</span></p>
                                <p>Server: <span id="jsdelivr-server" class="font-mono text-sm">-</span></p>
                                <p>Cache: <span id="jsdelivr-cache" class="font-mono text-sm">-</span></p>
                                <p>Size: <span id="jsdelivr-size" class="font-mono text-sm">-</span></p>
                            </div>
                        </div>
                    </div>

                    <!-- DXD CDN Results -->
                    <div class="p-4 border rounded-lg">
                        <h3 class="font-bold text-lg mb-2">DXD CDN</h3>
                        <div id="dxd-results">
                            <div class="space-y-2">
                                <p>DNS: <span id="dxd-dns" class="font-mono">-</span></p>
                                <p>Connect: <span id="dxd-connect" class="font-mono">-</span></p>
                                <p>TTFB: <span id="dxd-ttfb" class="font-mono">-</span></p>
                                <p>Download: <span id="dxd-download" class="font-mono">-</span></p>
                                <p>Total: <span id="dxd-total" class="font-mono">-</span></p>
                                <p>Server: <span id="dxd-server" class="font-mono text-sm">-</span></p>
                                <p>Cache: <span id="dxd-cache" class="font-mono text-sm">-</span></p>
                                <p>Size: <span id="dxd-size" class="font-mono text-sm">-</span></p>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="mt-4">
                    <h3 class="font-bold text-lg mb-2">Summary</h3>
                    <div id="summary" class="p-4 border rounded-lg">
                        <p class="text-lg font-semibold" id="winner">-</p>
                        <p class="text-sm text-gray-600" id="difference">-</p>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function measureTiming(url) {
            const start = performance.now();
            const response = await fetch(url + '?t=' + Date.now(), {
                method: 'GET',
                mode: 'cors',
            });
            const end = performance.now();
            
            // Get server location and cache status from headers
            const server = response.headers.get('cf-ray')?.split('-')[1] || 
                          response.headers.get('server-timing') || 
                          'Unknown';
            
            const cacheStatus = response.headers.get('cf-cache-status') || 
                               response.headers.get('x-cache') ||
                               'Unknown';

            const fileSize = response.headers.get('content-length') || 'Unknown';

            // Get performance data
            const entry = performance.getEntriesByName(url).pop();
            const timing = {
                dns: entry ? entry.domainLookupEnd - entry.domainLookupStart : 0,
                connect: entry ? entry.connectEnd - entry.connectStart : 0,
                ttfb: entry ? entry.responseStart - entry.requestStart : 0,
                download: entry ? entry.responseEnd - entry.responseStart : 0,
                total: end - start,
                server: server,
                cache: cacheStatus,
                size: formatFileSize(fileSize)
            };

            // Clear performance buffer
            performance.clearResourceTimings();
            
            return timing;
        }

        function formatFileSize(bytes) {
            if (bytes === 'Unknown') return bytes;
            bytes = parseInt(bytes);
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        function formatTime(ms) {
            return \`\${ms.toFixed(2)}ms\`;
        }

        function updateResults(cdn, results) {
            document.getElementById(\`\${cdn}-dns\`).textContent = formatTime(results.dns);
            document.getElementById(\`\${cdn}-connect\`).textContent = formatTime(results.connect);
            document.getElementById(\`\${cdn}-ttfb\`).textContent = formatTime(results.ttfb);
            document.getElementById(\`\${cdn}-download\`).textContent = formatTime(results.download);
            document.getElementById(\`\${cdn}-total\`).textContent = formatTime(results.total);
            document.getElementById(\`\${cdn}-server\`).textContent = results.server;
            document.getElementById(\`\${cdn}-cache\`).textContent = results.cache;
            document.getElementById(\`\${cdn}-size\`).textContent = results.size;
        }

        async function runTest() {
            const jsdelivrUrl = document.getElementById('jsdelivr-url').value;
            if (!jsdelivrUrl) {
                alert('Please enter a JSDelivr URL');
                return;
            }

            // Convert to DXD CDN URL
            const match = jsdelivrUrl.match(/cdn\\.jsdelivr\\.net\\/gh\\/${DEFAULT_GITHUB_OWNER}\\/([^\\/]+)@([^\\/]+)\\/(.+)/);
            if (!match) {
                alert('Invalid JSDelivr URL format');
                return;
            }

            const [, repo, version, path] = match;
            const dxdUrl = \`https://cdn.designxdevelop.com/\${repo}/\${version}/\${path}\`;

            document.getElementById('results').classList.remove('hidden');
            document.getElementById('run-test').disabled = true;
            document.getElementById('run-test').textContent = 'Running Tests...';

            const testCount = parseInt(document.getElementById('test-count').value) || 5;
            let jsdelivrTotal = { dns: 0, connect: 0, ttfb: 0, download: 0, total: 0 };
            let dxdTotal = { dns: 0, connect: 0, ttfb: 0, download: 0, total: 0 };
            let jsdelivrServer, dxdServer, jsdelivrCache, dxdCache, jsdelivrSize, dxdSize;

            // Clear browser DNS and connection cache
            await clearBrowserCache();

            // Warm up both CDNs and wait longer to ensure caches are primed
            console.log('Warming up CDNs...');
            const warmupJsdelivr = await measureTiming(jsdelivrUrl);
            await new Promise(resolve => setTimeout(resolve, 2000));
            const warmupDxd = await measureTiming(dxdUrl);
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Store initial cache and size information
            jsdelivrCache = warmupJsdelivr.cache;
            dxdCache = warmupDxd.cache;
            jsdelivrSize = warmupJsdelivr.size;
            dxdSize = warmupDxd.size;

            // Run the actual tests with delays between each test
            for (let i = 0; i < testCount; i++) {
                // Add a random delay between tests (2-4 seconds)
                const delay = 2000 + Math.random() * 2000;
                await new Promise(resolve => setTimeout(resolve, delay));

                // Alternate between CDNs to be fair
                const [timing1, timing2] = i % 2 === 0 
                    ? [await measureTiming(jsdelivrUrl), await measureTiming(dxdUrl)]
                    : [await measureTiming(dxdUrl), await measureTiming(jsdelivrUrl)];

                // Sum up results for the correct CDN
                if (i % 2 === 0) {
                    addTiming(jsdelivrTotal, timing1);
                    addTiming(dxdTotal, timing2);
                } else {
                    addTiming(dxdTotal, timing1);
                    addTiming(jsdelivrTotal, timing2);
                }

                // Store server locations
                jsdelivrServer = timing1.server;
                dxdServer = timing2.server;

                // Update progress
                document.getElementById('run-test').textContent = 
                    \`Running Tests... \${Math.round(((i + 1) / testCount) * 100)}%\`;
            }

            // Calculate averages
            Object.keys(jsdelivrTotal).forEach(key => {
                if (key !== 'server') {
                    jsdelivrTotal[key] /= testCount;
                    dxdTotal[key] /= testCount;
                }
            });

            // Set the final results
            jsdelivrTotal.server = jsdelivrServer;
            jsdelivrTotal.cache = jsdelivrCache;
            jsdelivrTotal.size = jsdelivrSize;
            dxdTotal.server = dxdServer;
            dxdTotal.cache = dxdCache;
            dxdTotal.size = dxdSize;

            // Update results display
            updateResults('jsdelivr', jsdelivrTotal);
            updateResults('dxd', dxdTotal);

            // Show summary with more detailed information
            const diff = jsdelivrTotal.total - dxdTotal.total;
            const winner = diff > 0 ? 'DXD CDN' : 'JSDelivr';
            const percentage = Math.abs((diff / jsdelivrTotal.total) * 100);

            const summary = document.getElementById('summary');
            summary.innerHTML = \`
                <p class="text-lg font-semibold">🏆 \${winner} was faster!</p>
                <p class="text-sm text-gray-600">Average difference: \${formatTime(Math.abs(diff))} (\${percentage.toFixed(1)}%)</p>
                <p class="text-sm text-gray-600 mt-2">Cache Status: JSDelivr (\${jsdelivrCache}) | DXD (\${dxdCache})</p>
                <p class="text-sm text-gray-600">Server Location: JSDelivr (\${jsdelivrServer}) | DXD (\${dxdServer})</p>
                <p class="text-sm text-gray-600">File Size: JSDelivr (\${jsdelivrSize}) | DXD (\${dxdSize})</p>
            \`;

            document.getElementById('run-test').disabled = false;
            document.getElementById('run-test').textContent = 'Run Speed Test';
        }

        // Helper function to add timing results
        function addTiming(total, timing) {
            Object.keys(total).forEach(key => {
                if (key !== 'server' && key !== 'cache' && key !== 'size') {
                    total[key] += timing[key];
                }
            });
        }

        // Helper function to clear browser cache
        async function clearBrowserCache() {
            if (window.caches) {
                try {
                    const keys = await window.caches.keys();
                    await Promise.all(keys.map(key => window.caches.delete(key)));
                } catch (e) {
                    console.warn('Failed to clear browser cache:', e);
                }
            }
            // Clear performance data
            performance.clearResourceTimings();
            // Clear DNS cache by adding a timestamp to the URL
            return new Promise(resolve => setTimeout(resolve, 1000));
        }

        document.getElementById('run-test').addEventListener('click', runTest);
    </script>
</body>
</html>`;

export default {
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);
			const path = url.pathname.slice(1);

			// Handle special pages
			if (path === 'speed-test' || path === 'convert') {
				return handleSpecialPages(path);
			}

			if (!path) {
				return new Response('Not Found', { status: 404 });
			}

			// Try to get from cache first with ETag support
			const cache = caches.default;
			const cacheKey = new Request(url.toString(), request);
			let response = await cache.match(cacheKey);

			// Check if we have a fresh cache hit
			if (response) {
				const etag = request.headers.get('If-None-Match');
				if (etag && response.headers.get('ETag') === etag) {
					return new Response(null, { status: 304 });
				}
				response = new Response(response.body, response);
				response.headers.set('CF-Cache-Status', 'HIT');
				return response;
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

			const extension = filePath.split('.').pop().toLowerCase();

			try {
				// First try R2 bucket with exact path
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
					response = await handleR2Response(r2Object, extension, request);
				} else {
					response = await handleGitHubResponse(repo, version, filePath, env, ctx, shouldMinify, request);
				}

				// Set aggressive caching headers
				const headers = new Headers(response.headers);
				headers.set('Cache-Control', 'public, max-age=31536000, immutable');
				headers.set('Access-Control-Allow-Origin', '*');
				headers.set('CF-Cache-Status', r2Object ? 'R2_HIT' : 'R2_MISS');

				// Add ETag for caching
				const etag = `"${repo}-${version}-${filePath}-${Date.now()}"`;
				headers.set('ETag', etag);

				// Create final response
				response = new Response(response.body, {
					headers,
					status: response.status,
					statusText: response.statusText,
				});

				// Cache in Cloudflare's edge with ETag
				ctx.waitUntil(cache.put(cacheKey, response.clone()));

				return response;
			} catch (error) {
				return new Response(`File not found: ${error.message}`, { status: 404 });
			}
		} catch (error) {
			return new Response(`Error: ${error.message}`, { status: 500 });
		}
	},
};

async function handleR2Response(r2Object, extension, request) {
	const acceptHeader = request.headers.get('Accept') || '';
	const isScriptRequest =
		acceptHeader.includes('application/javascript') || acceptHeader.includes('text/javascript') || acceptHeader.includes('text/css');

	// Determine if it's a text file (including .min.js and .min.css)
	const isTextFile =
		extension in CONTENT_TYPES &&
		(CONTENT_TYPES[extension].includes('text') ||
			CONTENT_TYPES[extension].includes('javascript') ||
			CONTENT_TYPES[extension].includes('json'));

	// Always get text content for text files
	let responseBody;
	if (isTextFile) {
		// Force text content for browser viewing
		responseBody = await r2Object.text();
	} else {
		responseBody = r2Object.body;
	}

	let headers = new Headers({
		'Content-Type': CONTENT_TYPES[extension] || 'text/plain; charset=utf-8',
		Vary: 'Accept-Encoding, Accept',
		'X-Content-Type-Options': 'nosniff',
		'Content-Disposition': 'inline',
		ETag: r2Object.httpEtag,
		'Last-Modified': r2Object.uploaded.toUTCString(),
		'Cache-Control': 'public, max-age=31536000, immutable',
		'CDN-Cache-Control': 'max-age=31536000',
		'Cloudflare-CDN-Cache-Control': 'max-age=31536000',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Expose-Headers': 'Content-Length, Content-Type, ETag',
	});

	// Only compress for script/link tags that accept gzip
	if (isScriptRequest && request.headers.get('Accept-Encoding')?.includes('gzip')) {
		const compressedContent = await compress(responseBody, 'gzip');
		if (compressedContent) {
			responseBody = compressedContent;
			headers.set('Content-Encoding', 'gzip');
		}
	}

	return new Response(responseBody, { headers });
}

async function handleGitHubResponse(repo, version, filePath, env, ctx, shouldMinify, request) {
	const response = await getFileFromGitHub(repo, version, filePath, env, ctx, shouldMinify, request);
	const extension = filePath.split('.').pop().toLowerCase();

	// Determine if it's a text file
	const isTextFile =
		extension in CONTENT_TYPES &&
		(CONTENT_TYPES[extension].includes('text') ||
			CONTENT_TYPES[extension].includes('javascript') ||
			CONTENT_TYPES[extension].includes('json'));

	// Always get text content for text files
	let responseBody;
	if (isTextFile) {
		responseBody = await response.text();
	} else {
		responseBody = response.body;
	}

	const headers = new Headers(response.headers);
	headers.set('X-Served-From', 'GitHub');
	headers.set('Cache-Control', 'public, max-age=31536000, immutable');
	headers.set('CDN-Cache-Control', 'max-age=31536000');
	headers.set('Cloudflare-CDN-Cache-Control', 'max-age=31536000');
	headers.set('Access-Control-Allow-Origin', '*');

	// Add preload hints for common resources
	if (filePath.endsWith('.js')) {
		headers.set('Link', '</style.css>; rel=preload; as=style, </script.js>; rel=preload; as=script');
	}

	return new Response(responseBody, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}

function handleSpecialPages(path) {
	const html = path === 'speed-test' ? SPEED_TEST_HTML : PORTAL_HTML;
	const headers = {
		'Content-Type': 'text/html',
		'Cache-Control': path === 'speed-test' ? 'no-store' : 'public, max-age=3600',
	};
	return new Response(html, { headers });
}
