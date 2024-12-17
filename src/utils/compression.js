export async function compress(content, type) {
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
