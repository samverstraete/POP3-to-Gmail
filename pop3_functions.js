const POP3Client = require("mailpop3");

// --- POP3 helpers (promise wrappers) ---
function popConnect(account) {
	return new Promise((resolve, reject) => {
		const options = {
			ignoretlserrs: true,
			enabletls: !!account.tls,
			tlsDirectOpts: !!account.ssl,
			debug: false,
			timeout: account.timeout_ms || 30000,
		};

		const client = new POP3Client(account.port || 995, account.server, options);

		client.on("error", (err) => {
			reject(err);
		});

		client.on("connect", () => {
			client.login(account.username, account.password);
		});

		client.on("login", (status, rawdata) => {
			if (status) resolve(client);
			else reject(new Error("POP3 login failed: " + rawdata));
		});

		// callers will use retr/list/dele/quit
	});
}

function popStat(pop) {
	return new Promise((resolve, reject) => {
		pop.on("stat", function (status, data, rawdata) {
			if (status) resolve(data);
			else reject(new Error("POP3 STAT failed: " + rawdata));
		});
		pop.stat();
	});
}

function popRetr(pop, n) {
	return new Promise((resolve, reject) => {
		pop.on("retr", function (status, msgnumber, data, rawdata) {
			if (status) resolve(data);
			else
				reject(
					new Error(
						"POP3 RETR failed for message " + msgnumber + ": " + rawdata
					)
				);
		});
		pop.retr(n);
	});
}

function popDele(pop, n) {
	return new Promise((resolve, reject) => {
		pop.on("dele", function (status, msgnumber, rawdata) {
			if (status) resolve();
			else
				reject(
					new Error(
						"POP3 DELE failed for message " + msgnumber + ": " + rawdata
					)
				);
		});
		pop.dele(n);
	});
}

function popQuit(pop) {
	return new Promise((resolve) => {
		pop.on("quit", function (status, rawdata) {
			// ignore status
			resolve();
		});
		pop.quit();
	});
}

module.exports = {
	popConnect,
	popStat, 
	popRetr,
	popDele,
	popQuit,
};