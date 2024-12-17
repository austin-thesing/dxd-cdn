import { CONTENT_TYPES } from '../config/constants';
import { compress } from '../utils/compression';
import { getFileFromGitHub } from '../services/github';

export async function handleR2Response(r2Object, extension, request) {
	const acceptHeader = request.headers.get('Accept') || '';
	const isScriptRequest =
		acceptHeader.includes('application/javascript') || acceptHeader.includes('text/javascript') || acceptHeader.includes('text/css');

	// Determine if it's a text file
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

export async function handleGitHubResponse(repo, version, filePath, env, ctx, shouldMinify, request) {
	const content = await getFileFromGitHub(repo, version, filePath, env, ctx, shouldMinify);
	const extension = filePath.split('.').pop().toLowerCase();

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

	// Only compress for script/link tags that accept gzip
	const acceptHeader = request.headers.get('Accept') || '';
	const isScriptRequest =
		acceptHeader.includes('application/javascript') || acceptHeader.includes('text/javascript') || acceptHeader.includes('text/css');

	let responseBody = content;
	if (isScriptRequest && request.headers.get('Accept-Encoding')?.includes('gzip')) {
		const compressedContent = await compress(content, 'gzip');
		if (compressedContent) {
			responseBody = compressedContent;
			headers.set('Content-Encoding', 'gzip');
		}
	}

	return new Response(responseBody, { headers });
}
