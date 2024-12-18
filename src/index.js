import { handleR2Response, handleGitHubResponse } from './handlers/responses';
import { getLatestRelease } from './services/github';
import { handleSpecialPages } from './templates/pages';
import { CONTENT_TYPES } from './config/constants';

export default {
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);
			const path = url.pathname.slice(1);

			// Handle favicon requests
			if (path === 'favicon.ico') {
				return new Response(null, { status: 204 });
			}

			// Handle special pages
			if (path === 'speed-test' || path === 'convert') {
				return handleSpecialPages(path);
			}

			// Handle root URL
			if (!path) {
				return new Response('DXD CDN is running', {
					status: 200,
					headers: {
						'Content-Type': 'text/plain',
						'Cache-Control': 'public, max-age=3600',
					},
				});
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
				console.error('File fetch error:', {
					error: error.message,
					stack: error.stack,
					repo,
					version,
					filePath,
					extension,
					shouldMinify,
				});
				return new Response(`File not found: ${error.message}`, { status: 404 });
			}
		} catch (error) {
			console.error('CDN Error:', {
				error: error.message,
				stack: error.stack,
				url: request.url,
				method: request.method,
				path: new URL(request.url).pathname,
			});

			return new Response(`Error: ${error.message}`, { status: 500 });
		}
	},
};
