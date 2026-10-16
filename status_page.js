const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");
const logger = require("./logger");

function getLogDirectory() {
    const fileTransport = logger.transports.find((transport) => transport && typeof transport.dirname === "string" && transport.dirname.length > 0);
    if (fileTransport) return fileTransport.dirname;
    return logger.DEFAULT_LOG_DIR || process.env.LOG_DIR || globalThis.logDir;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function readRecentLogLines(maxLines = 80) {
    const targetLogDir = getLogDirectory();
    if (!targetLogDir || !existsSync(targetLogDir)) {
        logger.debug(`Skipping recent log reads because the Winston log directory is unavailable: ${targetLogDir || "<unset>"}`);
        return [];
    }

    const fileTransport = logger.transports.find((transport) => transport && typeof transport.filename === "string");
    const filenamePattern = fileTransport
        ? fileTransport.filename
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/%DATE%/g, ".+")
        : "\.log";

    let files = readdirSync(targetLogDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && new RegExp(`${filenamePattern}(?:\\.gz)?$`, "i").test(entry.name))
        .map((entry) => ({
            name: entry.name,
            path: path.join(targetLogDir, entry.name),
            mtimeMs: statSync(path.join(targetLogDir, entry.name)).mtimeMs,
        }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const lines = [];
    for (const file of files) {
        if (lines.length >= maxLines) break;
        try {
            if (/\.gz$/i.test(file.name)) continue;
            const content = readFileSync(file.path, "utf8");
            const fileLines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
            for (const line of fileLines) {
                lines.push(line);
                if (lines.length >= maxLines) break;
            }
        } catch (err) {
            logger.warn(`Unable to read Winston log file ${file.path}: ${err.message}`);
        }
    }
    return lines.slice(-maxLines);
}

function renderRedirectPage(message = "Authentication successful!") {
    return `<!DOCTYPE html><html>
        <head><meta http-equiv="refresh" content="5; url=/status"></head>
        <body>${escapeHtml(message)} Redirecting to the <a href="/status">status page</a>.</body>
    </html>`;
}

function renderStatusPage({
    data,
    tokenPath,
    oauthLink,
    statusMessage = "",
}) {
    const updatedAt = new Date(data.updatedAt || Date.now()).toString();
    const accounts = data.accounts || {};
    const logLines = readRecentLogLines(80);
    const hasToken = existsSync(tokenPath);
    const logHtml = logLines.length
        ? logLines.map((line) => `<div class="log-line">${escapeHtml(line)}</div>`).join("")
        : '<div class="empty-state">No log output available yet.</div>';

    let statsRows = "";
    for (const [name, value] of Object.entries(accounts)) {
        const ls = value.last_sync
            ? `${new Date(value.last_sync.time).toString()} | <span class="badge bg-info text-dark">${escapeHtml(value.last_sync.status)}</span>` + (value.last_sync.message ? ` - ${escapeHtml(value.last_sync.message)}` : "")
            : "n/a";
        statsRows += `<tr><td>${escapeHtml(name)}</td><td>${ls}</td><td>${Number(value.counts?.day ?? 0)}</td><td>${Number(value.counts?.week ?? 0)}</td><td>${Number(value.counts?.month ?? 0)}</td><td>${Number(value.counts?.year ?? 0)}</td><td>${Number(value.counts?.total ?? 0)}</td></tr>`;
    }
    if (!statsRows) {
        statsRows = `<tr><td colspan="7" class="text-muted">No account statistics available yet.</td></tr>`;
    }

    const alertHtml = statusMessage
        ? `<div id="statusAlert" class="alert alert-warning" role="alert">${escapeHtml(statusMessage)}</div>`
        : `<div id="statusAlert" class="alert alert-warning d-none" role="alert" style="display:none;"></div>`;

    return `<!DOCTYPE html>
<html>
    <head>
        <title>POP3->Gmail status</title>
        <meta charset="utf-8">
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB" crossorigin="anonymous">
        <style>
            body { background: #f5f7fb; }
            .container { padding-top: 2rem; padding-bottom: 2rem; }
            .card { border: 1px solid rgba(0,0,0,0.08); box-shadow: 0 0.5rem 1.25rem rgba(31,45,61,0.08); }
            .log-panel { max-height: 420px; overflow: auto; background: #101826; color: #dfe7ff; font-family: Consolas, "Courier New", monospace; font-size: 0.82rem; line-height: 1.5; border-radius: 0.5rem; }
            .log-line { border-bottom: 1px solid rgba(255,255,255,0.08); padding: 0.2rem 0.45rem; white-space: pre-wrap; word-break: break-word; }
            .empty-state { color: #b7c0db; padding: 0.6rem 0.4rem; }
            .table td, .table th { vertical-align: middle; }
        </style>
    </head>
    <body>
        <div class="container">
            ${alertHtml}
            <h2>Status</h2>
            <p>Updated: ${escapeHtml(updatedAt)}</p>
            ${oauthLink ? `<div class="alert alert-primary" role="alert"><strong>Waiting for OAuth authorization:</strong> <a href="${escapeHtml(oauthLink)}">Click here</a></div>` : ""}
            ${hasToken ? `<div id="tokenDelete" class="mb-3"><button class="btn btn-danger" onclick="postAction({deleteToken: true})">Delete Token</button></div>` : ""}

            <h3>Statistics</h3>
            <table class="table table-striped table-bordered align-middle bg-white">
                <thead>
                    <tr><th>Account</th><th>Last Sync</th><th>Day</th><th>Week</th><th>Month</th><th>Year</th><th>Total</th></tr>
                </thead>
                <tbody>${statsRows}</tbody>
            </table>

            <div class="card">
                <div class="card-header d-flex justify-content-between align-items-center">
                    <strong>Recent logs</strong>
                    <span class="badge bg-secondary">${logLines.length} lines</span>
                </div>
                <div class="card-body p-2">
                    <div class="log-panel">${logHtml}</div>
                </div>
            </div>
        </div>
        <script>
            async function postAction(payload) {
                try {
                    const resp = await fetch('/status', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(payload)
                    });
                    const data = await resp.json();
                    const el = document.getElementById('statusAlert');
                    if (!el) return;
                    el.textContent = data.message;
                    el.style.display = 'block';
                    el.classList.remove('d-none');
                } catch (err) {
                    console.log('Request failed: ' + (err.message || err));
                }
            }
        </script>
    </body>
</html>`;
}

module.exports = {
    escapeHtml,
    readRecentLogLines,
    renderRedirectPage,
    renderStatusPage,
};
