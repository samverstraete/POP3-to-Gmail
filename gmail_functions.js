//process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { OAuth2Client } = require("google-auth-library");
const { gmail } = require("@googleapis/gmail");
const authWaiters = new Map(); // pathname -> { oauth2Client, resolve, reject }
let logger = console; // default logger
let awaitingAuth = false;

class GmailClient {
  oauth2Client;
  gmail;
  tokenFile;

  constructor(config) {
    // Load credentials
    const credFile = config.gmail.client_secrets_file;
    this.tokenFile = config.gmail.token_file;

    if (!existsSync(credFile)) throw new Error(`Missing credentials file: ${credFile}`);

    const credsRaw = JSON.parse(readFileSync(credFile));
    // Handle either installed or web client JSON shapes
    const o = credsRaw.installed || credsRaw.web;
    if (!o) throw new Error('Invalid credentials JSON (expected "installed" or "web" object)');

    const client_id = o.client_id;
    const client_secret = o.client_secret;
    const redirect_uri = o.redirect_uris && o.redirect_uris[0];
    if (!redirect_uri) throw new Error("No redirect_uri found in credentials");

    // Initialize the OAuth2 client
    this.oauth2Client = new OAuth2Client(client_id, client_secret, redirect_uri);
    // Initialize the Gmail API client with the OAuth2 client as auth
    this.gmail = gmail({
      version: "v1",
      auth: this.oauth2Client,
      //proxy: "http://127.0.0.1:8080",
    });

    // Listen for token events to save new tokens as they are refreshed or obtained
    this.oauth2Client.on("tokens", (tokens) => {
      if (tokens.refresh_token) {
        // persist token if refreshed
        try {
          writeFileSync(this.tokenFile, JSON.stringify(tokens, null, 2));
          logger.info(`Saved token to ${this.tokenFile}`);
        } catch (err) {
          logger.warn("Failed to persist token: " + (err.message || err));
        }
        logger.info("Refresh token: " + tokens.refresh_token);
      }
      logger.info("Access token: " + tokens.access_token);
    });

    new Promise((resolve, reject) => {
      authWaiters.set("/oauthcallback", { oauth2Client: this.oauth2Client, resolve, reject });
      // the waiter will be removed by the server when it handles the callback
    })
      .then((tokens) => {
        this.oauth2Client.setCredentials(tokens);
      })
      .catch((err) => {
        logger.error("OAuth flow failed after tokens promise was rejected: " + (err.message || err));
      })
      .finally(() => {
        awaitingAuth = false;
      });
  }

  async authenticate() {
    if (!existsSync(this.tokenFile)) {
      logger.warn("No token file — OAuth web flow required, go to the status page.");
      awaitingAuth = true;
      return { token: null };
    }
    let token;
    try {
      token = JSON.parse(readFileSync(this.tokenFile, "utf8"));
    } catch (e) {
      logger.warn("Failed to read token file: " + (e.message || e));
      return { token: null };
    }
    if (!token.refresh_token) {
      awaitingAuth = true;
      return { token: null };
    }
    this.oauth2Client.setCredentials(token);
    try {
      await this.oauth2Client.getAccessToken(); // refreshes if needed, keeps refresh_token
      return { token };
    } catch (err) {
      const code = err?.response?.data?.error;
      if (code === "invalid_grant") {
        logger.error("Refresh token revoked/expired (invalid_grant) — re-login needed.");
        awaitingAuth = true;
      } else {
        logger.warn("Token refresh failed (probably transient): " + (err.message || err));
      }
      return { token: null, err };
    }
  }

  // --- Get the authorization URL for the OAuth2 client ---
  getAuthorizeUrl(redirectUri, secondhop) {
    if (!awaitingAuth | !this.oauth2Client) return null;
    const scopes = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.labels"];
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

  async getOrCreateLabel(labelName) {
    if (!this.gmail) throw new Error("Gmail client not initialized");
    try {
      const res = await this.gmail.users.labels.list({ userId: "me" });
      const labels = res.data.labels || [];
      const found = labels.find((l) => l.name === labelName);
      if (found) return found.id;
      const created = await this.gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name: labelName,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });
      return created.data.id;
    } catch (err) {
      logger.error("Failed to get or create label: " + (err.message || err));
      throw err;
    }
  }

  async importMessage(rawBytes, labelId) {
    if (!this.gmail) throw new Error("Gmail client not initialized");
    // rawBytes: Buffer or string (CRLF)
    const rawB64 = Buffer.from(rawBytes).toString("base64url");
    const res = await this.gmail.users.messages.import({
      userId: "me",
      internalDateSource: "dateHeader",
      requestBody: { raw: rawB64, labelIds: [labelId, "INBOX", "UNREAD"] },
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
  finishAuthWaiter,
  GmailClient,
};
