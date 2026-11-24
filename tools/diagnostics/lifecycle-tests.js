'use strict';

/**
 * Real-browser lifecycle tests for the login bootstrap fix.
 * Never prints QR payloads, pairing codes, cookies, or phone numbers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Client, LocalAuth } = require('../..');

const START = Date.now();
const results = [];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: label }), ms);
    });
    return Promise.race([
        promise.then(
            (value) => ({ value }),
            (error) => ({ error: String(error?.message ?? error) }),
        ),
        timeout,
    ]).finally(() => clearTimeout(timer));
}

async function waitFor(fn, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const value = await fn();
            if (value) return value;
        } catch {
            // page may be navigating
        }
        await sleep(250);
    }
    throw new Error(`waitFor timed out: ${label}`);
}

function makeClient(root, clientId, extra = {}) {
    const state = { qr: 0, code: 0, ready: 0, authenticated: 0 };
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId,
            dataPath: path.join(root, 'auth'),
        }),
        authTimeoutMs: extra.authTimeoutMs ?? 30000,
        webVersionCache: { type: 'none' },
        userAgent: false,
        ...(extra.pairing
            ? {
                  pairWithPhoneNumber: {
                      phoneNumber: extra.pairing,
                      showNotification: false,
                      intervalMs: 180000,
                  },
              }
            : {}),
        puppeteer: {
            headless: true,
            defaultViewport: null,
            ...(process.env.WWJS_DIAG_CHROME
                ? { executablePath: process.env.WWJS_DIAG_CHROME }
                : {}),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
            ],
        },
    });
    client.on('qr', (qr) => {
        state.qr++;
        state.lastQrLength = typeof qr === 'string' ? qr.length : null;
    });
    client.on('code', (code) => {
        state.code++;
        state.lastCodeLength = typeof code === 'string' ? code.length : null;
    });
    client.on('ready', () => state.ready++);
    client.on('authenticated', () => state.authenticated++);
    return { client, state };
}

async function cleanup(client, root) {
    try {
        await Promise.race([client.destroy(), sleep(15000)]);
    } catch {
        // best-effort
    }
    try {
        await client.destroy();
    } catch {
        // idempotency is asserted separately where relevant
    }
    const browserClosed = client.pupBrowser?.isConnected?.() === false;
    try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 8 });
    } catch {
        // best-effort
    }
    return { browserClosed, profileCleaned: !fs.existsSync(root) };
}

const tests = {
    async normalQrNoDuplicates() {
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'wwjs-life-normal-'),
        );
        const { client, state } = makeClient(root, 'normal');
        let initOutcome = 'pending';
        const init = withTimeout(client.initialize(), 90000, 'initialize');
        await waitFor(() => state.qr > 0, 60000, 'first qr');
        await sleep(8000);
        const afterWaitQr = state.qr;
        const clean = await cleanup(client, root);
        initOutcome = await init;
        return {
            qrEvents: afterWaitQr,
            duplicateInSameDocument: afterWaitQr > 1,
            lastQrLength: state.lastQrLength,
            init: initOutcome,
            ...clean,
        };
    },

    async destroyDuringInjection() {
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'wwjs-life-destroy-'),
        );
        const { client, state } = makeClient(root, 'destroy');
        const init = withTimeout(client.initialize(), 60000, 'initialize');
        await waitFor(() => client.pupPage, 20000, 'pupPage');
        await sleep(1500);
        const destroyStart = Date.now();
        let firstDestroy = null;
        try {
            await client.destroy();
            firstDestroy = 'resolved';
        } catch (err) {
            firstDestroy = `rejected:${err.message}`;
        }
        let secondDestroy = null;
        try {
            await client.destroy();
            secondDestroy = 'resolved';
        } catch (err) {
            secondDestroy = `rejected:${err.message}`;
        }
        const initOutcome = await init;
        const destroyMs = Date.now() - destroyStart;
        const browserClosed = client.pupBrowser?.isConnected?.() === false;
        // destroy() must not delete the LocalAuth profile; only logout() does.
        const profilePreservedAfterDestroy = fs.existsSync(root);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 8 });
        return {
            initOutcome,
            firstDestroy,
            secondDestroy,
            destroyMs,
            browserClosed,
            profilePreservedAfterDestroy,
            profileCleanedAfterManualRm: !fs.existsSync(root),
            qrEvents: state.qr,
        };
    },

    async navigationDuringInjection() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-life-nav-'));
        const { client, state } = makeClient(root, 'nav');
        const originalInject = client.inject.bind(client);
        let injectCalls = 0;
        client.inject = (...args) => {
            injectCalls++;
            return originalInject(...args);
        };
        const init = withTimeout(client.initialize(), 90000, 'initialize');
        await waitFor(() => state.qr > 0, 60000, 'first qr');
        const qrBeforeReload = state.qr;
        const injectCallsBeforeReload = injectCalls;
        await client.pupPage.reload({
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await waitFor(
            () => state.qr > qrBeforeReload,
            60000,
            'qr after reload',
        );
        const clean = await cleanup(client, root);
        const initOutcome = await init;
        return {
            injectCallsBeforeReload,
            injectCallsTotal: injectCalls,
            qrBeforeReload,
            qrAfterReload: state.qr,
            init: initOutcome,
            ...clean,
        };
    },

    async localAuthPreservedOnRuntimeFailure() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-life-auth-'));
        const sessionDir = path.join(root, 'auth', 'session-preserve');
        fs.mkdirSync(sessionDir, { recursive: true });
        const marker = path.join(sessionDir, 'marker.txt');
        fs.writeFileSync(marker, 'keep-me');

        const { client } = makeClient(root, 'preserve', {
            authTimeoutMs: 1,
        });
        const init = withTimeout(client.initialize(), 60000, 'initialize');
        const initOutcome = await init;
        const markerAfterFailure = fs.existsSync(marker);
        await client.destroy().catch(() => {});
        const markerAfterDestroy = fs.existsSync(marker);
        const browserClosed = client.pupBrowser?.isConnected?.() === false;
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 8 });
        return {
            initOutcome,
            markerAfterFailure,
            markerAfterDestroy,
            browserClosed,
            profileCleaned: !fs.existsSync(root),
        };
    },

    async multiClientIsolation() {
        const rootA = fs.mkdtempSync(
            path.join(os.tmpdir(), 'wwjs-life-multi-a-'),
        );
        const rootB = fs.mkdtempSync(
            path.join(os.tmpdir(), 'wwjs-life-multi-b-'),
        );
        // Start A first, then start B while A is still live. WhatsApp throttles
        // simultaneous cold login sessions from one IP, so concurrency here
        // tests isolation without racing two initial page loads.
        const a = makeClient(rootA, 'multi-a', { authTimeoutMs: 60000 });
        const b = makeClient(rootB, 'multi-b', { authTimeoutMs: 60000 });
        const initA = withTimeout(a.client.initialize(), 120000, 'init-a');
        let waitError = null;
        try {
            await waitFor(() => a.state.qr > 0, 60000, 'qr a');
        } catch (err) {
            waitError = err.message;
        }
        const initB = withTimeout(b.client.initialize(), 120000, 'init-b');
        try {
            await waitFor(() => b.state.qr > 0, 60000, 'qr b');
        } catch (err) {
            waitError = (waitError ? waitError + '; ' : '') + err.message;
        }
        const qrA = a.state.qr;
        const qrB = b.state.qr;
        const lenA = a.state.lastQrLength;
        const lenB = b.state.lastQrLength;
        const cleanA = await cleanup(a.client, rootA);
        const cleanB = await cleanup(b.client, rootB);
        const outcomeA = await initA;
        const outcomeB = await initB;
        return {
            qrA,
            qrB,
            lenA,
            lenB,
            waitError,
            outcomeA,
            outcomeB,
            cleanA,
            cleanB,
        };
    },
};

(async () => {
    const onlyIndex = process.argv.indexOf('--only');
    const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
    for (const [name, fn] of Object.entries(tests)) {
        if (only && name !== only) continue;
        const testStart = Date.now();
        try {
            const result = await fn();
            results.push({
                name,
                status: 'completed',
                durationMs: Date.now() - testStart,
                ...result,
            });
        } catch (err) {
            results.push({
                name,
                status: 'error',
                durationMs: Date.now() - testStart,
                error: String(err?.message ?? err),
            });
        }
        console.error(`[lifecycle] ${name} done @${Date.now() - START}ms`);
    }
    console.log('LIFECYCLE_RESULT ' + JSON.stringify(results));
})().catch((err) => {
    console.log(
        'LIFECYCLE_HARNESS_ERROR ' +
            JSON.stringify({
                message: String(err?.message ?? err),
                stack: String(err?.stack ?? '')
                    .split('\n')
                    .slice(0, 8),
            }),
    );
    process.exitCode = 1;
});
