const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");
const localtunnel = require("localtunnel");

const PORT = Number(process.env.PUBLIC_SITE_PORT || "3080");
const HAS_CUSTOM_SUBDOMAIN = Object.prototype.hasOwnProperty.call(process.env, "PUBLIC_SITE_SUBDOMAIN");
const DESIRED_SUBDOMAIN = HAS_CUSTOM_SUBDOMAIN
	? String(process.env.PUBLIC_SITE_SUBDOMAIN || "").trim()
	: "eventbotfuntime";
const URL_FILE_PATH = path.join(__dirname, "..", "public-site-url.txt");
const CLOUDFLARED_LOCAL_PATH = path.join(__dirname, "..", "bin", "cloudflared.exe");
const OPENSSH_PATH = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
const PUBLIC_SITE_PATH = "/site";
const PROBE_ATTEMPTS = 5;
const PROBE_DELAY_MS = 1500;

function writeUrlFile(url) {
	fs.writeFileSync(
		URL_FILE_PATH,
		[
			`Public URL: ${url}`,
			`Local URL: http://127.0.0.1:${PORT}/site`,
			`Updated: ${new Date().toLocaleString("ru-RU")}`
		].join("\n") + "\n",
		"utf8"
	);
}

function logHeader() {
	console.log("========================================");
	console.log(" Funtime Event Public Site Tunnel");
	console.log("========================================");
	console.log(`Local site: http://127.0.0.1:${PORT}/site`);
	console.log("");
}

async function openTunnel(subdomain) {
	return localtunnel({
		port: PORT,
		subdomain: subdomain || undefined
	});
}

function localSiteUrl() {
	return `http://127.0.0.1:${PORT}`;
}

function sleep(delayMs) {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function requestStatus(url) {
	return new Promise((resolve, reject) => {
		const request = https.get(
			url,
			{
				timeout: 10000,
				headers: {
					"User-Agent": "Mozilla/5.0"
				}
			},
			(response) => {
				response.resume();
				resolve(response.statusCode || 0);
			}
		);

		request.on("timeout", () => {
			request.destroy(new Error("Request timed out."));
		});
		request.on("error", reject);
	});
}

async function probePublicUrl(url) {
	for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
		try {
			const statusCode = await requestStatus(url);
			if (statusCode >= 200 && statusCode < 500 && statusCode !== 404) {
				return { ok: true, statusCode };
			}

			if (attempt === PROBE_ATTEMPTS) {
				return { ok: false, statusCode };
			}
		} catch (error) {
			if (attempt === PROBE_ATTEMPTS) {
				return { ok: false, error: error?.message || String(error) };
			}
		}

		await sleep(PROBE_DELAY_MS);
	}

	return { ok: false, error: "Unknown probe failure." };
}

async function closeTunnelSafe(tunnel) {
	if (!tunnel) {
		return;
	}

	try {
		await tunnel.close();
	} catch {
	}
}

function resolveCloudflaredExecutable() {
	const configuredPath = String(process.env.CLOUDFLARED_PATH || "").trim();
	if (configuredPath) {
		return configuredPath;
	}

	if (fs.existsSync(CLOUDFLARED_LOCAL_PATH)) {
		return CLOUDFLARED_LOCAL_PATH;
	}

	return "";
}

function createProcessTunnel(childProcess, closeMessage) {
	return {
		close: () => new Promise((resolve) => {
			if (childProcess.killed || childProcess.exitCode !== null) {
				resolve();
				return;
			}

			childProcess.once("exit", () => resolve());
			childProcess.kill("SIGTERM");
			setTimeout(() => {
				if (childProcess.exitCode === null) {
					childProcess.kill("SIGKILL");
				}
			}, 5000);
		}),
		onClose(handler) {
			childProcess.once("exit", handler);
		},
		logClose() {
			console.log(closeMessage);
		}
	};
}

async function openCloudflareQuickTunnel() {
	const executable = resolveCloudflaredExecutable();
	if (!executable) {
		throw new Error(
			`cloudflared was not found. Expected ${CLOUDFLARED_LOCAL_PATH} or env CLOUDFLARED_PATH.`
		);
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		const childProcess = spawn(
			executable,
			["tunnel", "--url", localSiteUrl()],
			{
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true
			}
		);

		const handleChunk = (chunk) => {
			const text = chunk.toString();
			process.stdout.write(text);

			const match = text.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
			if (!settled && match) {
				settled = true;
				resolve({
					tunnel: createProcessTunnel(childProcess, "Cloudflare tunnel closed."),
					publicUrl: `${match[0]}${PUBLIC_SITE_PATH}`,
					providerLabel: "Cloudflare Quick Tunnel"
				});
			}
		};

		childProcess.stdout.on("data", handleChunk);
		childProcess.stderr.on("data", handleChunk);
		childProcess.on("error", (error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
		});
		childProcess.on("exit", (code) => {
			if (!settled) {
				settled = true;
				reject(new Error(`cloudflared exited before sharing a URL (code ${code ?? "unknown"}).`));
			}
		});
	});
}

function resolveSshExecutable() {
	if (fs.existsSync(OPENSSH_PATH)) {
		return OPENSSH_PATH;
	}

	return "ssh";
}

async function openLocalhostRunTunnel() {
	const executable = resolveSshExecutable();

	return new Promise((resolve, reject) => {
		let settled = false;
		let bufferedStdout = "";
		const childProcess = spawn(
			executable,
			[
				"-o", "StrictHostKeyChecking=no",
				"-o", "ServerAliveInterval=60",
				"-o", "ExitOnForwardFailure=yes",
				"-R", `80:127.0.0.1:${PORT}`,
				"nokey@localhost.run",
				"--",
				"--output", "json"
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true
			}
		);

		const parseStdout = () => {
			const lines = bufferedStdout.split(/\r?\n/);
			bufferedStdout = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}

				try {
					const event = JSON.parse(line);
					if (
						!settled
						&& event?.event === "tcpip-forward"
						&& event?.status === "success"
						&& event?.address
					) {
						settled = true;
						resolve({
							tunnel: createProcessTunnel(childProcess, "localhost.run tunnel closed."),
							publicUrl: `https://${event.address}${PUBLIC_SITE_PATH}`,
							providerLabel: "localhost.run"
						});
					}
				} catch {
				}
			}
		};

		childProcess.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			process.stdout.write(text);
			bufferedStdout += text;
			parseStdout();
		});
		childProcess.stderr.on("data", (chunk) => {
			process.stdout.write(chunk.toString());
		});
		childProcess.on("error", (error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
		});
		childProcess.on("exit", (code) => {
			if (!settled) {
				settled = true;
				reject(new Error(`localhost.run tunnel exited before sharing a URL (code ${code ?? "unknown"}).`));
			}
		});
	});
}

async function main() {
	logHeader();

	let tunnel;
	let publicUrl = "";
	let providerLabel = "LocalTunnel";
	if (DESIRED_SUBDOMAIN) {
		try {
			tunnel = await openTunnel(DESIRED_SUBDOMAIN);
			console.log(`Requested custom subdomain: ${DESIRED_SUBDOMAIN}`);
		} catch (error) {
			console.log(`Custom subdomain "${DESIRED_SUBDOMAIN}" is unavailable.`);
			console.log("Falling back to a random public address...");
			console.log("");
			tunnel = await openTunnel("");
		}
	} else {
		console.log("Starting with a random public address...");
		console.log("");
		tunnel = await openTunnel("");
	}

	publicUrl = `${tunnel.url}${PUBLIC_SITE_PATH}`;
	let probe = await probePublicUrl(publicUrl);

	if (!probe.ok) {
		console.log(`Public probe failed for ${publicUrl}${probe.statusCode ? ` (status ${probe.statusCode})` : ""}.`);
		console.log("Recreating tunnel with a fresh public address...");
		console.log("");
		await closeTunnelSafe(tunnel);
		tunnel = await openTunnel("");
		publicUrl = `${tunnel.url}${PUBLIC_SITE_PATH}`;
		probe = await probePublicUrl(publicUrl);
	}

	if (!probe.ok) {
		console.log(
			`LocalTunnel failed: ${publicUrl}${probe.statusCode ? ` (status ${probe.statusCode})` : ""}${probe.error ? ` - ${probe.error}` : ""}`
		);
		console.log("Switching to Cloudflare Quick Tunnel...");
		console.log("");
		await closeTunnelSafe(tunnel);
		const cloudflareTunnel = await openCloudflareQuickTunnel();
		tunnel = cloudflareTunnel.tunnel;
		publicUrl = cloudflareTunnel.publicUrl;
		providerLabel = cloudflareTunnel.providerLabel;
		probe = await probePublicUrl(publicUrl);
		if (!probe.ok) {
			console.log(
				`${providerLabel} failed: ${publicUrl}${probe.statusCode ? ` (status ${probe.statusCode})` : ""}${probe.error ? ` - ${probe.error}` : ""}`
			);
			console.log("Switching to localhost.run...");
			console.log("");
			await closeTunnelSafe(tunnel);
			const localhostRunTunnel = await openLocalhostRunTunnel();
			tunnel = localhostRunTunnel.tunnel;
			publicUrl = localhostRunTunnel.publicUrl;
			providerLabel = localhostRunTunnel.providerLabel;
			probe = await probePublicUrl(publicUrl);
			if (!probe.ok) {
				throw new Error(
					`${providerLabel} opened but public URL did not respond correctly: ${publicUrl}${probe.statusCode ? ` (status ${probe.statusCode})` : ""}${probe.error ? ` - ${probe.error}` : ""}`
				);
			}
		}
	}

	writeUrlFile(publicUrl);

	console.log(`Provider: ${providerLabel}`);
	console.log(`Share this URL: ${publicUrl}`);
	console.log(`Saved to: ${URL_FILE_PATH}`);
	console.log("");
	console.log("Keep this window open while people use the site.");
	console.log("Press Ctrl+C to stop the public link.");

	if (typeof tunnel.on === "function") {
		tunnel.on("close", () => {
			console.log("");
			console.log("Public tunnel closed.");
		});
	} else if (typeof tunnel.onClose === "function") {
		tunnel.onClose(() => {
			console.log("");
			tunnel.logClose();
		});
	}

	const shutdown = async () => {
		try {
			await tunnel.close();
		} finally {
			process.exit(0);
		}
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error("Failed to start public tunnel:", error?.message || error);
	process.exit(1);
});
