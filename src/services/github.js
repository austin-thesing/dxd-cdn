import { DEFAULT_GITHUB_OWNER, GITHUB_CACHE_TTL } from '../config/constants';
import { minifyContent } from './minification';

// Cache for GitHub data (in-memory, will reset on worker restart)
const GITHUB_CACHE = new Map();

export async function getCommit(repo, commit, env) {
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

export async function getLatestRelease(repo, env) {
	const cacheKey = `${DEFAULT_GITHUB_OWNER}/${repo}`;
	const now = Date.now();

	// Check cache first
	if (GITHUB_CACHE.has(cacheKey)) {
		const cached = GITHUB_CACHE.get(cacheKey);
		if (now - cached.timestamp < GITHUB_CACHE_TTL) {
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

export async function getFileFromGitHub(repo, version, filePath, env, ctx, shouldMinify = false) {
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

	return shouldMinify ? await minifyContent(content, extension) : content;
}
