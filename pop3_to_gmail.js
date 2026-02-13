#!/usr/bin/env node

/*
* MAIN FILE FOR POP3 TO GMAIL IMPORTER
* see README.md for usage information
*/
"use strict";

const { existsSync, mkdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const url = require("node:url");

const { parse } = require("yaml");
const { popConnect, popStat, popRetr, popDele, popQuit } = require("./pop3_functions.js");
const { setGfLogger, getAuthWaiter, finishAuthWaiter, GmailClient } = require("./gmail_functions.js");
// stats store will be created after loading config so we can pass a path from config
let stats = null;
const { StatsStore } = require("./stats_store.js");
const destroyer = require("server-destroy");
let httpServer = null;
let gmailclient = null;

const { createLogger, format, transports } = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");
//const { log } = require("node:console");

const DEFAULT_LOG_DIR = path.normalize(process.env.LOG_DIR || "./logs");
if (!existsSync(DEFAULT_LOG_DIR))
	mkdirSync(DEFAULT_LOG_DIR, { recursive: true });

const logger = createLogger({
	level: "info",
	format: format.combine(
		format.timestamp(),
		format.printf(
			(info) => `${info.timestamp} ${info.level.toUpperCase()}: ${info.message}`
		)
	),
	transports: [
		new transports.Console(),
		new DailyRotateFile({
			dirname: DEFAULT_LOG_DIR,
			filename: "pop3_to_gmail-%DATE%.log",
			datePattern: "YYYY-MM-DD",
			zippedArchive: true,
			maxSize: "20m",
			maxFiles: "14d",
		}),
	],
	exitOnError: false,
});

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
			// let the waiter handle it (it contains oauth2Client + resolve/reject).
			const waiter = getAuthWaiter(reqUrl.pathname);
			if (waiter) {
				const code = reqUrl.searchParams.get('code');
				const error = reqUrl.searchParams.get('error');
				if (error) {
					res.statusCode = 400;
					res.end('Authentication failed: ' + error);
					try { waiter.reject(new Error('OAuth error: ' + error)); } catch(e){}
					logger.warn(`OAuth error on callback: ${error}`);
					return;
				}
				res.end(`<!DOCTYPE html><html>
					<head><meta http-equiv="refresh" content="5; url=/status"></head>
					<body>Authentication successful! Redirecting to the <a href="/status">status page</a>.</body>
					</html>`);
				finishAuthWaiter(waiter, code);
				logger.info('OAuth authentication successful via callback');
				return;
			}
			else if (reqUrl.pathname === '/status') {
				if (statsStore && typeof statsStore.getAllStats === 'function') {
					const data = statsStore.getAllStats();
					res.setHeader('Content-Type', 'text/html; charset=utf-8');
					let html = `<html>
						<head>
							<title>POP3->Gmail status</title>
							<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB" crossorigin="anonymous">
						</head>
						<body><div class="container">
							<h2>Status</h2>
							<p>Updated: ${new Date(data.updatedAt || Date.now()).toString()}</p>`;

					// Construct the desired redirect URI. If the host is local (localhost or 127.0.0.1)
					// use the callback directly so the OAuth flow returns to the running service.
					// Otherwise build a remote redirect helper and pass the base64-encoded
					// local callback as the 'data' parameter.
					const host = req.headers.host;
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
					
					if (gmailclient) {
						const newurl = gmailclient.getAuthorizeUrl(redirectUri, redirectParam);
						if (newurl) {
							html += `<div class="alert alert-primary" role="alert"><strong>Waiting for OAuth authorization:</strong> <a href="${newurl}">Click here</a></div>`;
						}
					}
                    
					html += `<h2>Statistics</h2>
						<table class="table">
							<tr><th>Account</th><th>Last Sync</th><th>Day</th><th>Week</th><th>Month</th><th>Year</th><th>Total</th></tr>`;
					const accounts = data.accounts || {};
					for (const [k,v] of Object.entries(accounts)) {
						const ls = v.last_sync ? `${new Date(v.last_sync.time).toString()} | <span class="badge bg-info text-dark">${v.last_sync.status}</span>` + (v.last_sync.message?` - ${v.last_sync.message}`:'') : 'n/a';
						html += `<tr><td>${k}</td><td>${ls}</td><td>${v.counts.day}</td><td>${v.counts.week}</td><td>${v.counts.month}</td><td>${v.counts.year}</td><td>${v.counts.total}</td></tr>`;
					}
					html += '</table></div></body></html>';
					res.end(html);
					return;
				} else {
					res.statusCode = 500;
					res.end('Stats store not available');
					logger.error('Status server: stats store not available');
					return;
				}
			}
			res.statusCode = 404;
			res.end(`<!DOCTYPE html><html>
					<head><meta http-equiv="refresh" content="5; url=/status"></head>
					<body>Not found! Redirecting to the <a href="/status">status page</a>.</body>
					</html>`);
			logger.warn(`Status server: unknown request for ${req.url}`);
		} catch (e) {
			res.statusCode = 500;
			res.end('Server error');
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
	const labelId = await gmailclient.getOrCreateLabel(labelName);
	logger.info(`Label ${labelName} => ${labelId}`);

	let pop;
	try {
		pop = await popConnect(account);
	} catch (err) {
		logger.error(`POP3 connect/login failed for ${account.name}: ${err.message || err}`);
		stats.recordSyncStatus(account.name, 'fail', err.message || String(err));
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
			}
		}
		stats.recordSyncStatus(account.name, 'success', null);
	} catch (err) {
		logger.error(`POP3 stat or retrieval failed for ${account.name}: ${err.message || err}`);
		stats.recordSyncStatus(account.name, 'fail', err.message || String(err));
	} finally {
		await popQuit(pop);
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
	const logDir = cfg.log_dir || DEFAULT_LOG_DIR;

	logger.info("Starting pop3_to_gmail");
	logger.info(`Log directory: ${logDir}`);
	logger.info(`Using config: ${cfgPath}`);
	setGfLogger(logger); // pass logger to gmail_functions.js
	if (!Array.isArray(cfg.accounts) || cfg.accounts.length === 0) {
		logger.warn("No accounts defined in config. Exiting.");
		process.exit(2);
	}

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
		gmailclient = new GmailClient(cfg);

		const auth = await gmailclient.authenticate();
		
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
