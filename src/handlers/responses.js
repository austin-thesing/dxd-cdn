import { CONTENT_TYPES } from '../config/constants';
import { compress } from '../utils/compression';
import { getFileFromGitHub } from '../services/github';
import { captureError } from '../config/sentry';

export async function handleR2Response(r2Object, extension, request) {
	try {
		const acceptHeader = request.headers.get('Accept') || '';
		const isScriptRequest =
			acceptHeader.includes('application/javascript') || acceptHeader.includes('text/javascript') || acceptHeader.includes('text/css');

		// Determine if it's a text file
		const isTextFile =
			extension in CONTENT_TYPES &&
			(CONTENT_TYPES[extension].includes('text') ||
				CONTENT_TYPES[extension].includes('javascript') ||
				CONTENT_TYPES[extension].includes('json'));

		// Check if file is already minified
		const isMinified = r2Object.key.includes('.min.');

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

		// Only compress for script/link tags that accept gzip and aren't already minified
		if (isScriptRequest && !isMinified && request.headers.get('Accept-Encoding')?.includes('gzip')) {
			try {
				const compressedContent = await compress(responseBody, 'gzip');
				if (compressedContent) {
					responseBody = compressedContent;
					headers.set('Content-Encoding', 'gzip');
				}
			} catch (error) {
				captureError(error, {
					tags: {
						type: 'compression_error',
						extension,
						isMinified: String(isMinified),
					},
					extra: {
						key: r2Object.key,
						contentType: headers.get('Content-Type'),
					},
				});
				// Continue without compression on error
			}
		}

		return new Response(responseBody, { headers });
	} catch (error) {
		captureError(error, {
			tags: {
				type: 'r2_response_error',
				extension,
			},
			extra: {
				key: r2Object.key,
			},
		});
		throw error; // Re-throw to maintain original error handling
	}
}

export async function handleGitHubResponse(repo, version, filePath, env, ctx, shouldMinify, request) {
	try {
		const content = await getFileFromGitHub(repo, version, filePath, env, ctx, shouldMinify);
		const extension = filePath.split('.').pop().toLowerCase();
		const isMinified = filePath.includes('.min.');

		// Determine if it's a text file
		const isTextFile =
			extension in CONTENT_TYPES &&
			(CONTENT_TYPES[extension].includes('text') ||
				CONTENT_TYPES[extension].includes('javascript') ||
				CONTENT_TYPES[extension].includes('json'));

		const headers = new Headers({
			'Content-Type': CONTENT_TYPES[extension] || 'text/plain; charset=utf-8',
			'X-Served-From': 'GitHub',
			'Cache-Control': 'public, max-age=31536000, immutable',
			'CDN-Cache-Control': 'max-age=31536000',
			'Cloudflare-CDN-Cache-Control': 'max-age=31536000',
			'Access-Control-Allow-Origin': '*',
		});

		// Add preload hints for common resources
		if (filePath.endsWith('.js')) {
			headers.set('Link', '</style.css>; rel=preload; as=style, </script.js>; rel=preload; as=script');
		}

		// Only compress for script/link tags that accept gzip and aren't already minified
		const acceptHeader = request.headers.get('Accept') || '';
		const isScriptRequest =
			acceptHeader.includes('application/javascript') || acceptHeader.includes('text/javascript') || acceptHeader.includes('text/css');

		let responseBody = content;
		if (isScriptRequest && !isMinified && request.headers.get('Accept-Encoding')?.includes('gzip')) {
			try {
				const compressedContent = await compress(content, 'gzip');
				if (compressedContent) {
					responseBody = compressedContent;
					headers.set('Content-Encoding', 'gzip');
				}
			} catch (error) {
				captureError(error, {
					tags: {
						type: 'compression_error',
						extension,
						isMinified: String(isMinified),
					},
					extra: {
						repo,
						version,
						filePath,
						contentType: headers.get('Content-Type'),
					},
				});
				// Continue without compression on error
			}
		}

		return new Response(responseBody, { headers });
	} catch (error) {
		captureError(error, {
			tags: {
				type: 'github_response_error',
				extension: filePath.split('.').pop().toLowerCase(),
			},
			extra: {
				repo,
				version,
				filePath,
				shouldMinify,
			},
		});
		throw error; // Re-throw to maintain original error handling
	}
}
