#!/usr/bin/env node

/*
* MAIN FILE FOR POP3 TO GMAIL IMPORTER
* see README.md for usage information
*/
"use strict";

const { existsSync, mkdirSync, readFileSync, unlink } = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const url = require("node:url");

const { parse } = require("yaml");
const { popConnect, popStat, popRetr, popDele, popQuit } = require("./pop3_functions");
const { GmailClient } = require("./gmail_functions");
const { renderRedirectPage, renderStatusPage } = require("./status_page");
// stats store will be created after loading config so we can pass a path from config
let stats = null;
const { StatsStore } = require("./stats_store");
const logger = require("./logger");
const destroyer = require("server-destroy");
let httpServer = null;
let gmailclient = null;

// --- Utility & config ---

function loadConfig(fp) {
    const txt = readFileSync(fp, "utf8");
    const cfg = parse(txt);
    // sanity defaults
    if (!cfg.gmail) {
        cfg.gmail = {
            client_secrets_file: "credentials.json",
            token_file: "token.json",
        };
    }
    return cfg;
}

let shuttingDown = false;
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- HTTP server stuff ---

// Start a simple status HTTP server (idempotent). Exposes:
// - GET /oauthcallback?code=...&state=... -> handles OAuth callbacks if registered
// - GET /status -> simple HTML table
function startStatusServer(statsStore, port, secondhop) {
    if (httpServer) return httpServer;
    const p = Number(port || process.env.STATUS_PORT || 3000);
    httpServer = http.createServer((req, res) => {
        try {
            const reqUrl = new url.URL(req.url, `http://localhost:${p}`);
            // OAuth callback handling: if someone registered a waiter for this pathname,
            // let the waiter handle it (it contains resolve/reject).
            if (reqUrl.pathname === "/oauthcallback") {
                const waiter = gmailClient.getAuthWaiter();
                const code = reqUrl.searchParams.get("code");
                const error = reqUrl.searchParams.get("error");
                if (error) {
                    res.statusCode = 400;
                    res.end("Authentication failed: " + error);
                    try {
                        waiter.reject(new Error("OAuth error: " + error));
                    } catch (e) {}
                    logger.warn(`OAuth error on callback: ${error}`);
                    return;
                }
                res.end(renderRedirectPage("Authentication successful!"));
                gmailClient.finishAuthWaiter(waiter, code);
                logger.info("OAuth authentication successful via callback");
                return;
            }

            if (reqUrl.pathname === "/status") {
                const cfg = loadConfig(process.argv[2]);
                const tokenPath = cfg.gmail.token_file;

                if (req.method === "POST") {
                    let body = "";
                    req.on("data", (d) => (body += d));
                    req.on("end", () => {
                        try {
                            const postData = JSON.parse(body);
                            if (postData.deleteToken) {
                                unlink(tokenPath, (err) => {
                                    if (err) {
                                        res.statusCode = 500;
                                        res.setHeader("Content-Type", "application/json");
                                        res.end(JSON.stringify({ ok: false, message: "Error deleting token: " + (err.message || err) }));
                                    } else {
                                        res.setHeader("Content-Type", "application/json");
                                        res.end(JSON.stringify({ ok: true, message: "Token deleted. Restart the application to re-authenticate." }));
                                    }
                                });
                                return;
                            }
                            res.statusCode = 400;
                            res.setHeader("Content-Type", "application/json");
                            res.end(JSON.stringify({ ok: false, message: "Unknown action" }));
                        } catch (e) {
                            res.statusCode = 400;
                            res.setHeader("Content-Type", "application/json");
                            res.end(JSON.stringify({ ok: false, message: "Invalid JSON" }));
                        }
                    });
                    return;
                }

                if (statsStore && typeof statsStore.getAllStats === "function") {
                    const data = statsStore.getAllStats();
                    const host = String(req.headers.host || "localhost");
                    const callbackUrl = `http://${host}/oauthcallback`;
                    let redirectUri;
                    let redirectParam;

                    if (host.includes("localhost") || host.includes("127.0.0.1")) {
                        redirectUri = callbackUrl;
                        redirectParam = "";
                    } else {
                        redirectParam = Buffer.from(`SECONDHOPLINK${callbackUrl}`, "utf8").toString("base64");
                        redirectUri = secondhop;
                    }

                    let oauthLink = null;
                    if (gmailclient) {
                        const newurl = gmailclient.getAuthorizeUrl(redirectUri, redirectParam);
                        oauthLink = newurl || null;
                    }

                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.end(
                        renderStatusPage({
                        data,
                        tokenPath,
                        oauthLink,
                        }),
                    );
                    return;
                }

                res.statusCode = 500;
                res.end("Stats store not available");
                logger.error("Status server: stats store not available");
                return;
            }

            res.statusCode = 404;
            res.end(`<!DOCTYPE html><html>
                <head><meta http-equiv="refresh" content="5; url=/status"></head>
                <body>Not found! Redirecting to the <a href="/status">status page</a>.</body>
            </html>`);
            logger.warn(`Status server: unknown request for ${req.url}`);
        } catch (e) {
            res.statusCode = 500;
            res.end("Server error");
            logger.error(`Status server error: ${e.message || e}`);
        }
    }).listen(p, () => {
        logger.info(`Status server listening on http://localhost:${p}/status`);
    });

    destroyer(httpServer);
    return httpServer;
}

// --- Main processing for a single account ---

async function processAccount(account, gmailclient) {
    logger.info(`Processing account: ${account.name}`);

    // mark sync started
    stats.recordSyncStatus(account.name, 'started', null);

    // ensure label exists
    const labelName = account.label || account.name;
    logger.info(`Ensuring Gmail label for ${account.name}: ${labelName}`);
    const labelId = await gmailclient.getOrCreateLabel(labelName);
    logger.info(`Label ${labelName} => ${labelId}`);

    let pop;
    try {
        logger.info(`Connecting to POP3 account ${account.name} (${account.server}:${account.port})`);
        pop = await popConnect(account);
        logger.info(`POP3 connection established for ${account.name}`);
    } catch (err) {
        logger.error(`POP3 connect/login failed for ${account.name}: ${err.message || err}`);
        stats.recordSyncStatus(account.name, "fail", err.message || String(err));
        return;
    }

    try {
        const stat = await popStat(pop);
        const count = stat.count || 0;
        logger.info(`Account ${account.name} has ${count} messages.`);

        for (let i = 1; i <= count; i++) {
            if (shuttingDown) break;
            try {
                logger.info(`Retrieving message #${i} from ${account.name}`);
                const raw = await popRetr(pop, i);

                // poplib returns string with CRLF separators already; ensure Buffer
                const rawBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "binary");

                // import into Gmail
                const result = await gmailclient.importMessage(rawBuf, labelId);
                if (result && result.id) {
                    logger.info(`Imported message => Gmail ID ${result.id}. Deleting POP message #${i}`);
                    await popDele(pop, i);
                    stats.recordImport(account.name);
                } else {
                    logger.warn(`Import returned no id for account ${account.name} POP#${i}: ${JSON.stringify(result)}`);
                }
            } catch (err) {
                logger.error(`Failed processing POP#${i} for ${account.name}: ${err.message || err}`);
                if (err.message === "Gmail reauthentication required" || gmailclient.requiresReauth) {
                    logger.warn(`Stopping sync for ${account.name} because Gmail requires re-authentication`);
                    break;
                }
            }
        }

        logger.info(`Finished processing POP3 account ${account.name}; marking sync as successful`);
        stats.recordSyncStatus(account.name, "success", null);
    } catch (err) {
        logger.error(`POP3 stat or retrieval failed for ${account.name}: ${err.message || err}`);
        stats.recordSyncStatus(account.name, "fail", err.message || String(err));
    } finally {
        try {
            await popQuit(pop);
            logger.info(`POP3 session closed for ${account.name}`);
        } catch (quitErr) {
            logger.warn(`POP3 quit for ${account.name} failed: ${quitErr.message || quitErr}`);
        }
    }
}

// --- Main loop & graceful shutdown ---

async function main() {
    if (process.argv.length < 3) {
        console.error("Usage: node pop3_to_gmail.js data/config.yaml");
        process.exit(1);
    }
    const cfgPath = process.argv[2];
    const cfg = loadConfig(cfgPath);
    // create the stats store based on config (cfg.stats_file) or environment variable
    const statsFile = cfg.stats_file || process.env.STATS_FILE;
    stats = new StatsStore(statsFile);
    logger.info(`Stats file: ${stats.filePath || statsFile || 'default'}`);
    const intervalMinutes = Math.max(1, Number(cfg.check_interval_minutes || 5));

    logger.info("Starting pop3_to_gmail");
    logger.info(`Log directory: ${logger.DEFAULT_LOG_DIR}`);
    logger.info(`Using config: ${cfgPath}`);
    if (!Array.isArray(cfg.accounts) || cfg.accounts.length === 0) {
        logger.warn("No accounts defined in config. Exiting.");
        process.exit(2);
    }

    logger.info("Starting a new Gmail client instance");
    gmailclient = new GmailClient(cfg);

    // Start status server on the OAuth redirect port if possible so the
    // status page and the OAuth callback share the same listener.
    try {
        const credFile = cfg.gmail && cfg.gmail.client_secrets_file ? cfg.gmail.client_secrets_file : "credentials.json";
        let redirectPort = cfg.status_port || process.env.STATUS_PORT;
        let redirectHelperBase = process.env.REDIRECT_HELPER_URL;
        if (existsSync(credFile)) {
            try {
                const raw = JSON.parse(readFileSync(credFile, "utf8"));
                const o = raw.installed || raw.web;
                if (o && Array.isArray(o.redirect_uris) && o.redirect_uris.length > 0) {
                    try {
                        const ru = new url.URL(o.redirect_uris[0]);
                        if (!redirectHelperBase) redirectHelperBase = o.redirect_uris[0];
                        if (!redirectPort) redirectPort = ru.port ? Number(ru.port) : ru.protocol === "http:" ? 80 : 443;
                    } catch (e) { } // ignore
                }
            } catch (e) { } // ignore parse errors
        }
        // fallback
        if (!redirectPort) redirectPort = 3000;
        if (!redirectHelperBase) redirectHelperBase = `http://localhost:${redirectPort}/oauthcallback`;
        startStatusServer(stats, redirectPort, redirectHelperBase);
    } catch (e) {
        logger.warn('Failed to start status server: ' + (e.message || e));
    }

    // Setup shutdown handlers
    process.on("SIGINT", () => {
        logger.info("SIGINT received");
        shuttingDown = true;
        if (httpServer) httpServer.destroy();
    });
    process.on("SIGTERM", () => {
        logger.info("SIGTERM received");
        shuttingDown = true;
        if (httpServer) httpServer.destroy();
    });

    while (!shuttingDown) {
        const auth = await gmailclient.authenticate();
        logger.info(`Gmail auth result for cycle: tokenPresent=${Boolean(auth?.token)}, requiresReauth=${Boolean(gmailclient.requiresReauth)}`);
        
        // the main per-account processing loop
        if (auth.token) {
            for (const account of cfg.accounts) {
                if (shuttingDown) break;
                try {
                    await processAccount(account, gmailclient);
                } catch (err) {
                    logger.error("Error processing account: " + (err.message || err));
                }
            }
        } else {
            logger.warn("Skipping POP3 import cycle because Gmail authentication is not ready. Complete OAuth in the status page or fix the token file.");
        }

        if (shuttingDown) break;
        logger.info(`Sleeping ${intervalMinutes} minute(s)...`);
        // sleep but wake early if shuttingDown
        const sleepMs = intervalMinutes * 60000;
        const step = 1000;
        let slept = 0;
        while (slept < sleepMs && !shuttingDown) {
            await wait(step);
            slept += step;
        }
    }

    logger.info("Shutting down main loop. Bye.");
    process.exit(0);
}

main().catch((err) => {
    logger.error("Fatal error: " + (err.stack || err));
    process.exit(1);
});
