const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { google } = require("googleapis");
const authWaiters = new Map(); // pathname -> { oauth2Client, resolve, reject }
let logger = console; // default logger
let awaitingAuth = false;
let oauth2Client = new google.auth.OAuth2();
let gmail = null;

// --- Get the authorization URL for the OAuth2 client ---
function getAuthorizeUrl(redirectUri) {
	if (!awaitingAuth | !oauth2Client) return null;
	const scopes = [
		"https://www.googleapis.com/auth/gmail.modify",
		"https://www.googleapis.com/auth/gmail.labels",
	];
	oauth2Client.redirectUri = redirectUri;
	return oauth2Client.generateAuthUrl({
		access_type: "offline",
		scope: scopes,
		prompt: "consent",
		redirect_uri: redirectUri,
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

	const pathname = new URL(redirect_uri).pathname;
	oauth2Client = new google.auth.OAuth2(
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
					logger.info("Token refreshed.");
					// no need to save, this is done in the main loop
					gmail = google.gmail({ version: "v1", auth: oauth2Client });
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
	logger.warn("No token found — manual OAuth web flow required, go to the status page.");
	awaitingAuth = true;
	return new Promise((resolve, reject) => {
      authWaiters.set(pathname, { oauth2Client, resolve, reject });
      // the waiter will be removed by the server when it handles the callback
    });
}

// --- Gmail helpers ---

async function getOrCreateLabel(labelName) {
	if (!gmail) throw new Error("Gmail client not initialized");
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

async function importMessage(rawBytes, labelId) {
	if (!gmail) throw new Error("Gmail client not initialized");
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

// ---- Interface helpers ----

function setGfLogger(customLogger) {
	logger = customLogger;
}

function getAuthWaiter(pathname) {
	return authWaiters.get(pathname);
}

function deleteAuthWaiter(pathname) {
	authWaiters.delete(pathname);
	awaitingAuth = false;
}

function finishAuthWaiter(waiter, code) {
  // exchange code for token and resolve the original promise
  waiter.oauth2Client
    .getToken(code)
    .then(({ tokens }) => {
      waiter.oauth2Client.setCredentials(tokens);
      try {
		gmail = google.gmail({ version: "v1", auth: oauth2Client });
        waiter.resolve(waiter.oauth2Client);
      } catch (e) {}
    })
    .catch((err) => {
      try {
        waiter.reject(err);
      } catch (e) {}
    });
}

module.exports = {
	getOauthClient,
	getOrCreateLabel,
	importMessage,
	setGfLogger,
	getAuthWaiter,
	deleteAuthWaiter,
	getAuthorizeUrl,
	finishAuthWaiter,
};
