import { DEFAULT_GITHUB_OWNER } from '../config/constants';
import portalHtml from './html/portal.html';
import speedTestHtml from './html/speed-test.html';

export function handleSpecialPages(path) {
	const html = path === 'speed-test' ? speedTestHtml : portalHtml;

	// Replace template variables
	const processedHtml = html.replace(/{{DEFAULT_GITHUB_OWNER}}/g, DEFAULT_GITHUB_OWNER);

	const headers = {
		'Content-Type': 'text/html',
		'Cache-Control': path === 'speed-test' ? 'no-store' : 'public, max-age=3600',
	};
	return new Response(processedHtml, { headers });
}
