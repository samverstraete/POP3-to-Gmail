const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { google } = require("googleapis");
const url = require("node:url");
let logger = console; // default logger
let authorizeUrl = null;
const authWaiters = new Map(); // pathname -> { oauth2Client, resolve, reject }

// Start the authentication and register a waiter for the OAuth2 callback
// expects redirectUri like "http://host:3000/oauth2callback"
async function authenticate(oauth2Client, scopes, redirectUri) {
	// If a persistent status server is running on the redirect port, register
	// a one-time waiter so the server can handle the callback while continuing
	// to serve the status page. 
	const parsed = new url.URL(redirectUri);
	const pathname = parsed.pathname;
	authorizeUrl = oauth2Client.generateAuthUrl({
		access_type: "offline",
		scope: scopes,
		prompt: "consent",
	});

	// register waiter and return a promise that resolves when server handler processes the callback
	return new Promise((resolve, reject) => {
		authWaiters.set(pathname, { oauth2Client, resolve, reject });
		logger.info("Please open the following URL in your browser to authorize the application:");
		logger.info(authorizeUrl);
		// the waiter will be removed by the server when it handles the callback
	});
}

// --- OAuth web flow & token persistence ---
async function getOauthClient(config) {
	const credFile = config.gmail.client_secrets_file;
	const tokenFile = config.gmail.token_file;

	if (!existsSync(credFile))
		throw new Error(`Missing credentials file: ${credFile}`);

	const credsRaw = JSON.parse(readFileSync(credFile));
	// Handle either installed or web client JSON shapes
	const o = credsRaw.installed || credsRaw.web;
	if (!o)
		throw new Error('Invalid credentials JSON (expected "installed" or "web" object)');

	const client_id = o.client_id;
	const client_secret = o.client_secret;
	const redirect_uri = o.redirect_uris && o.redirect_uris[0];
	if (!redirect_uri) throw new Error("No redirect_uri found in credentials");

	const oauth2Client = new google.auth.OAuth2(
		client_id,
		client_secret,
		redirect_uri
	);

	// load token if present
	if (existsSync(tokenFile)) {
		try {
			const token = JSON.parse(readFileSync(tokenFile));
			oauth2Client.setCredentials(token);
			// Optionally attempt to refresh proactively if nearly expired and refresh_token present
			if (
				token.refresh_token &&
				token.expiry_date &&
				token.expiry_date - Date.now() < 60000
			) {
				logger.info("Access token is expiring soon — attempting refresh...");
				try {
					// google-auth-library exposes refreshToken method via getRequestHeaders or so;
					// using setCredentials + getAccessToken will refresh transparently in many versions
					const res = await oauth2Client.getAccessToken();
					// if getAccessToken succeeded, persist any new credentials
					const newCreds = oauth2Client.credentials || token;
					writeFileSync(tokenFile, JSON.stringify(newCreds, null, 2));
					logger.info("Token refreshed and saved.");
				} catch (e) {
					logger.warn("Refresh attempt failed: " + (e.message || e));
				}
			}
			return oauth2Client;
		} catch (e) {
			logger.warn(
				"Failed to load token file, will perform full auth: " + (e.message || e)
			);
		}
	}

	// No token: start web OAuth flow
	logger.info("No token found — starting OAuth web flow.");
	const scopes = [
		"https://www.googleapis.com/auth/gmail.modify",
		"https://www.googleapis.com/auth/gmail.labels",
	];

	const authClient = await authenticate(oauth2Client, scopes, redirect_uri);
	// persist token
	try {
		const tokens = oauth2Client.credentials || {};
		writeFileSync(tokenFile, JSON.stringify(tokens, null, 2));
		logger.info(`Saved token to ${tokenFile}`);
	} catch (e) {
		logger.warn("Failed to save token: " + (e.message || e));
	}
	return authClient;
}

// --- Gmail helpers ---
async function getOrCreateLabel(gmail, labelName) {
	const res = await gmail.users.labels.list({ userId: "me" });
	const labels = res.data.labels || [];
	const found = labels.find((l) => l.name === labelName);
	if (found) return found.id;
	const created = await gmail.users.labels.create({
		userId: "me",
		requestBody: {
			name: labelName,
			labelListVisibility: "labelShow",
			messageListVisibility: "show",
		},
	});
	return created.data.id;
}

async function importMessage(gmail, rawBytes, labelId) {
	// rawBytes: Buffer or string (CRLF)
	const rawB64 = Buffer.from(rawBytes).toString("base64url");
	const res = await gmail.users.messages.import({
		userId: "me",
		internalDateSource: "dateHeader",
		requestBody: {
			raw: rawB64,
			labelIds: [labelId, "INBOX", "UNREAD"],
		},
	});
	return res.data;
}

function setGfLogger(customLogger) {
	logger = customLogger;
}

function getAuthWaiter(pathname) {
	return authWaiters.get(pathname);
}

function deleteAuthWaiter(pathname) {
	authWaiters.delete(pathname);
	authorizeUrl = null;
}

function getAuthorizeUrl() {
	return authorizeUrl;
}

module.exports = {
	getOauthClient,
	getOrCreateLabel,
	importMessage,
	setGfLogger,
	getAuthWaiter,
	deleteAuthWaiter,
	getAuthorizeUrl,
};
