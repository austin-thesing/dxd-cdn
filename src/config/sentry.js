import * as Sentry from '@sentry/node';

export function initSentry(env) {
	Sentry.init({
		dsn: env.SENTRY_DSN,
		environment: env.ENVIRONMENT || 'production',
		tracesSampleRate: 0.1, // Adjust based on your traffic
		beforeSend(event) {
			// Don't send 404s to Sentry
			if (event.level === 'error' && event.extra?.status === 404) {
				return null;
			}
			return event;
		},
	});
}

export function captureError(error, { tags = {}, extra = {} } = {}) {
	Sentry.withScope((scope) => {
		scope.setTags(tags);
		scope.setExtras(extra);
		Sentry.captureException(error);
	});
}

export function captureMessage(message, { level = 'info', tags = {}, extra = {} } = {}) {
	Sentry.withScope((scope) => {
		scope.setLevel(level);
		scope.setTags(tags);
		scope.setExtras(extra);
		Sentry.captureMessage(message);
	});
}
