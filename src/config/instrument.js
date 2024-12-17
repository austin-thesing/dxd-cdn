import * as Sentry from '@sentry/node';

Sentry.init({
	dsn: 'https://a357a719af4885f965696d8770cb5e8d@o4507981524762624.ingest.us.sentry.io/4507981524762624',
	tracesSampleRate: 0.1,
	beforeSend(event) {
		// Don't send 404s to Sentry
		if (event.level === 'error' && event.extra?.status === 404) {
			return null;
		}
		return event;
	},
});

export default Sentry;
