//process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { OAuth2Client } = require("google-auth-library");
const { gmail } = require("@googleapis/gmail");
const logger = require("./logger");
const authWaiters = new Map(); // pathname -> { oauth2Client, resolve, reject }
let awaitingAuth = false;

class GmailClient {
  oauth2Client;
  gmail;
  tokenFile;
  requiresReauth;

  constructor(config) {
    this.requiresReauth = false;

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
      logger.info(`OAuth tokens received: refresh_token=${!!tokens.refresh_token}, access_token=${!!tokens.access_token}, expiry_date=${tokens.expiry_date || "n/a"}`);
      const persisted = this.oauth2Client.credentials || tokens;
      const merged = { ...persisted, ...tokens };
      if (merged.refresh_token || persisted.refresh_token) {
        try {
          writeFileSync(this.tokenFile, JSON.stringify(merged, null, 2));
          logger.info(`Saved Gmail token to ${this.tokenFile}`);
        } catch (err) {
          logger.warn("Failed to persist token: " + (err.message || err));
        }
      }
      if (tokens.refresh_token) {
        logger.info("Refresh token received for Gmail OAuth");
      }
      if (tokens.access_token) {
        logger.info("Gmail access token refreshed successfully");
      }
    });

    new Promise((resolve, reject) => {
      authWaiters.set("/oauthcallback", { oauth2Client: this.oauth2Client, resolve, reject });
      // the waiter will be removed by the server when it handles the callback
    })
      .then((tokens) => {
        logger.info("OAuth callback completed; applying new Gmail credentials");
        this.oauth2Client.setCredentials(tokens);
        this.requiresReauth = false;
        awaitingAuth = false;
      })
      .catch((err) => {
        logger.error("OAuth flow failed after tokens promise was rejected: " + (err.message || err));
      })
      .finally(() => {
        awaitingAuth = false;
      });
  }

  isAuthError(error) {
    const message = error?.message || error?.response?.data?.error || String(error || "");
    const code = error?.code || error?.status || error?.response?.status;
    const lower = message.toLowerCase();
    return (
      code === 401 ||
      code === 403 ||
      lower.includes("login required") ||
      lower.includes("invalid_grant") ||
      lower.includes("invalid credentials") ||
      lower.includes("unauthorized") ||
      lower.includes("token expired")
    );
  }

  async refreshAccessToken() {
    if (!this.oauth2Client) return false;

    if (!existsSync(this.tokenFile)) {
      logger.warn("No token file available for Gmail refresh; waiting for user OAuth login.");
      this.requiresReauth = true;
      awaitingAuth = true;
      return false;
    }

    let token;
    try {
      token = JSON.parse(readFileSync(this.tokenFile, "utf8"));
    } catch (e) {
      logger.warn("Failed to read Gmail token file during refresh: " + (e.message || e));
      this.requiresReauth = true;
      awaitingAuth = true;
      return false;
    }

    if (!token.refresh_token) {
      logger.warn(`Stored Gmail token is missing refresh_token; re-authentication is required.`);
      this.requiresReauth = true;
      awaitingAuth = true;
      return false;
    }

    this.oauth2Client.setCredentials(token);

    try {
      const accessToken = await this.oauth2Client.getAccessToken();
      logger.info(`Gmail refresh succeeded using the stored refresh token. Access token ready: ${Boolean(accessToken?.token)}`);
      this.requiresReauth = false;
      awaitingAuth = false;
      return true;
    } catch (err) {
      const lower = (err?.message || err?.response?.data?.error || String(err)).toLowerCase();
      if (lower.includes("invalid_grant") || lower.includes("invalid credentials") || lower.includes("login required")) {
        logger.warn("Stored Gmail refresh token is no longer valid; user re-authentication is required.");
        this.requiresReauth = true;
        awaitingAuth = true;
        return false;
      }

      logger.warn("Gmail refresh attempt failed, keeping the current refresh token for a later retry: " + (err.message || err));
      return false;
    }
  }

  async handleAuthFailure(error, context = "Gmail API") {
    if (!error || !this.isAuthError(error)) {
      return false;
    }

    const message = error?.message || error?.response?.data?.error || String(error || "");
    logger.warn(`${context}: Gmail auth rejected; retrying with the stored refresh token (${message})`);

    const refreshed = await this.refreshAccessToken();
    if (refreshed) {
      this.requiresReauth = false;
      awaitingAuth = false;
      return false;
    }

    return this.requiresReauth;
  }

  async authenticate() {
    if (!existsSync(this.tokenFile)) {
      logger.warn("No token file — OAuth web flow required, go to the status page.");
      awaitingAuth = true;
      this.requiresReauth = true;
      return { token: null };
    }
    let token;
    try {
      token = JSON.parse(readFileSync(this.tokenFile, "utf8"));
    } catch (e) {
      logger.warn("Failed to read token file: " + (e.message || e));
      this.requiresReauth = true;
      awaitingAuth = true;
      return { token: null };
    }
    if (!token.refresh_token) {
      logger.warn(`Token file ${this.tokenFile} is missing refresh_token; OAuth re-auth required.`);
      awaitingAuth = true;
      this.requiresReauth = true;
      return { token: null };
    }
    this.oauth2Client.setCredentials(token);
    try {
      const accessToken = await this.oauth2Client.getAccessToken();
      logger.info(`Gmail token refresh/validation succeeded. Access token ready: ${Boolean(accessToken?.token)}`);
      this.requiresReauth = false;
      awaitingAuth = false;
      return { token };
    } catch (err) {
      if (this.handleAuthFailure(err, "Gmail token refresh")) {
        logger.error("Refresh token revoked/expired or Gmail rejected access — re-login required.");
        return { token: null, err };
      }
      logger.warn("Token refresh failed (probably transient): " + (err.message || err));
      return { token: null, err };
    }
  }

  // --- Get the authorization URL for the OAuth2 client ---
  getAuthorizeUrl(redirectUri, secondhop) {
    if (!awaitingAuth || !this.oauth2Client) return null;
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

  async getOrCreateLabel(labelName, retry = true) {
    if (!this.gmail) throw new Error("Gmail client not initialized");
    try {
      const res = await this.gmail.users.labels.list({ userId: "me" });
      const labels = res.data.labels || [];
      const found = labels.find((l) => l.name === labelName);
      if (found) {
        logger.info(`Found existing Gmail label "${labelName}" => ${found.id}`);
        return found.id;
      }
      const created = await this.gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name: labelName,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });
      logger.info(`Created Gmail label "${labelName}" => ${created.data.id}`);
      return created.data.id;
    } catch (err) {
      const requiresReauth = await this.handleAuthFailure(err, `getOrCreateLabel(${labelName})`);
      if (requiresReauth) {
        throw new Error("Gmail reauthentication required");
      }
      if (retry) {
        logger.info(`Retrying Gmail label lookup after refresh for ${labelName}`);
        return this.getOrCreateLabel(labelName, false);
      }
      logger.error("Failed to get or create label: " + (err.message || err));
      throw err;
    }
  }

  async importMessage(rawBytes, labelId, retry = true) {
    if (!this.gmail) throw new Error("Gmail client not initialized");
    logger.info(`Importing a message into Gmail label ${labelId}`);
    try {
      // rawBytes: Buffer or string (CRLF)
      const rawB64 = Buffer.from(rawBytes).toString("base64url");
      const res = await this.gmail.users.messages.import({
        userId: "me",
        internalDateSource: "dateHeader",
        requestBody: { raw: rawB64, labelIds: [labelId, "INBOX", "UNREAD"] },
      });
      logger.info(`Gmail import completed: messageId=${res.data.id || "unknown"}, threadId=${res.data.threadId || "unknown"}`);
      return res.data;
    } catch (err) {
      const requiresReauth = await this.handleAuthFailure(err, "importMessage");
      if (requiresReauth) {
        throw new Error("Gmail reauthentication required");
      }
      if (retry) {
        logger.info(`Retrying Gmail import after refresh for label ${labelId}`);
        return this.importMessage(rawBytes, labelId, false);
      }
      logger.error("Failed to import message into Gmail: " + (err.message || err));
      throw err;
    }
  }
}

// ---- Interface helpers ----

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
  getAuthWaiter,
  finishAuthWaiter,
  GmailClient,
};
