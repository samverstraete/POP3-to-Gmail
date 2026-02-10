const { existsSync, readFileSync } = require("node:fs");
const { google } = require("googleapis");
const authWaiters = new Map(); // pathname -> { oauth2Client, resolve, reject }
let logger = console; // default logger
let awaitingAuth = false;


class GmailClient {
	oauth2Client;
	gmail;

	constructor(config) {
		// Load credentials
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

		// Initialize the OAuth2 client
		this.oauth2Client = new google.auth.OAuth2(
			client_id,
			client_secret,
			redirect_uri
		);

		// Initialize the Gmail API client with the OAuth2 client as auth
		this.gmail = google.gmail({ version: "v1", auth: this.oauth2Client });

		// Listen for token events to save new tokens as they are refreshed or obtained
		this.oauth2Client.on("tokens", (tokens) => {
			if (tokens.refresh_token) {
				// persist token if refreshed
				try {
					const tokenFile = cfg.gmail && cfg.gmail.token_file ? cfg.gmail.token_file : "token.json";
					writeFileSync(tokenFile, JSON.stringify(tokens, null, 2));
					logger.info(`Saved token to ${tokenFile}`);
				} catch (err) {
					logger.warn("Failed to persist token: " + (err.message || err));
				}
				logger.info("Refresh token: " + tokens.refresh_token);
			}
			logger.info("Access token: " + tokens.access_token);
		});

		// Load token if present
		if (existsSync(tokenFile)) {
			try {
				const token = JSON.parse(readFileSync(tokenFile));
				this.oauth2Client.setCredentials(token);
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
						const res = this.oauth2Client.getAccessToken();
						if (res.token) { 
							this.oauth2Client.setCredentials({ access_token: res.token });
							logger.info("Token refreshed.");
							// no need to save, this is done in the main loop
							this.gmail = google.gmail({ version: "v1", auth: this.oauth2Client }); 
						} else {
							logger.warn("Refresh attempt did not return a new token: " + JSON.stringify(res.res));
						}
					} catch (e) {
						logger.warn("Refresh attempt failed: " + (e.message || e));
					}
				}
				return this;
			} catch (e) {
				logger.warn("Failed to load token file: " + (e.message || e));
			}
		}

		// No token: start web OAuth flow
		logger.warn("No token found — manual OAuth web flow required, go to the status page.");
		awaitingAuth = true;
		const callback = new Promise((resolve, reject) => {
			authWaiters.set("/oauthcallback", { oauth2Client: this.oauth2Client, resolve, reject });
			// the waiter will be removed by the server when it handles the callback
		});
		callback.then((tokens) => {
			this.oauth2Client.setCredentials(tokens);
			this.gmail = google.gmail({ version: "v1", auth: this.oauth2Client });
		}).catch((err) => {
			logger.error("OAuth flow failed after tokens promise was rejected: " + (err.message || err));
		});
	}

	// --- Get the authorization URL for the OAuth2 client ---
	getAuthorizeUrl(redirectUri, secondhop) {
		if (!awaitingAuth | !this.oauth2Client) return null;
		const scopes = [
			"https://www.googleapis.com/auth/gmail.modify",
			"https://www.googleapis.com/auth/gmail.labels",
		];
		this.oauth2Client.redirectUri = redirectUri;
		return this.oauth2Client.generateAuthUrl({
			access_type: "offline",
			scope: scopes,
			prompt: "consent",
			redirect_uri: redirectUri,
			state: secondhop,
		});
	}

	// --- Gmail helpers ---

	getOrCreateLabel(labelName) {
		if (!this.gmail) throw new Error("Gmail client not initialized");
		const res = this.gmail.users.labels.list({ userId: "me" });
		const labels = res.data.labels || [];
		const found = labels.find((l) => l.name === labelName);
		if (found) return found.id;
		const created = this.gmail.users.labels.create({
			userId: "me",
			requestBody: {
				name: labelName,
				labelListVisibility: "labelShow",
				messageListVisibility: "show",
			},
		});
		return created.data.id;
	}

	importMessage(rawBytes, labelId) {
		if (!this.gmail) throw new Error("Gmail client not initialized");
		// rawBytes: Buffer or string (CRLF)
		const rawB64 = Buffer.from(rawBytes).toString("base64url");
		const res = this.gmail.users.messages.import({
			userId: "me",
			internalDateSource: "dateHeader",
			requestBody: {
				raw: rawB64,
				labelIds: [labelId, "INBOX", "UNREAD"],
			},
		});
		return res.data;
	}

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
    .then(({ tokens }) => waiter.resolve(tokens))
    .catch((err) => waiter.reject(err));
}

module.exports = {
	setGfLogger,
	getAuthWaiter,
	deleteAuthWaiter,
	finishAuthWaiter,
	GmailClient,
};
