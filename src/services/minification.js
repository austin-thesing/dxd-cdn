const terser = require('terser');
const CleanCSS = require('clean-css');

export async function minifyContent(content, extension) {
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
