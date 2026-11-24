'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

(async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-wait-'));
    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: null,
        userDataDir: profile,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = (await browser.pages())[0];
        await page.goto('https://web.whatsapp.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        // wait until the login shell is fully rendered
        await page.waitForFunction(
            () =>
                Boolean(
                    window.Debug?.VERSION &&
                    document.querySelector(
                        '[data-testid="link-device-qr-code"]',
                    ),
                ),
            { timeout: 30000 },
        );

        const actualProbe = (pairingRequested) => {
            const socket = window.require?.('WAWebSocketModel')?.Socket;
            const state = socket?.state;

            if (state) {
                if (
                    state === 'OPENING' ||
                    state === 'UNLAUNCHED' ||
                    state === 'PAIRING'
                ) {
                    return false;
                }
                return {
                    need: state === 'UNPAIRED' || state === 'UNPAIRED_IDLE',
                    state,
                    source: 'socket',
                };
            }

            if (!location.pathname.startsWith('/login')) return false;

            const conn = window.require?.('WAWebConnModel')?.Conn;
            const refReady = conn?.ref !== undefined && conn?.ref !== null;
            const qrUi = Boolean(
                document.querySelector('[data-testid="link-device-qr-code"]'),
            );
            const phoneUi = Boolean(
                document.querySelector(
                    '[data-testid="link_device_qr_phone_number_link"], [data-testid="link_device_qr_phone_number_shortcut_link"]',
                ),
            );
            const pairingApi = Boolean(
                window.require?.('WAWebAltDeviceLinkingApi'),
            );

            if (pairingRequested) {
                if (pairingApi && (phoneUi || conn)) {
                    return {
                        need: true,
                        state: null,
                        source: 'login_page_pairing',
                    };
                }
                return false;
            }

            if (refReady && qrUi) {
                return { need: true, state: null, source: 'login_page_qr' };
            }

            return false;
        };

        const probes = {
            version: () => Boolean(window.Debug?.VERSION),
            pathname: () => location.pathname,
            qrUi: () =>
                Boolean(
                    document.querySelector(
                        '[data-testid="link-device-qr-code"]',
                    ),
                ),
            requireType: () => typeof window.require,
            socketModule: () => {
                try {
                    const m = window.require?.('WAWebSocketModel');
                    return m === undefined
                        ? 'undefined'
                        : m === null
                          ? 'null'
                          : typeof m;
                } catch (err) {
                    return 'throw:' + err.message;
                }
            },
            connRef: () =>
                Boolean(window.require?.('WAWebConnModel')?.Conn?.ref != null),
            combined: () =>
                Boolean(
                    location.pathname.startsWith('/login') &&
                    document.querySelector(
                        '[data-testid="link-device-qr-code"]',
                    ) &&
                    window.require?.('WAWebConnModel')?.Conn?.ref != null,
                ),
            truthyObject: () => ({
                need: true,
                state: null,
                source: 'test',
            }),
        };

        for (const [name, fn] of Object.entries(probes)) {
            const viaEvaluate = await page
                .evaluate(fn)
                .catch((e) => 'ERR ' + e.message);
            let viaWait;
            try {
                const handle = await page.waitForFunction(fn, {
                    timeout: 4000,
                    polling: 250,
                });
                viaWait = await handle.jsonValue();
                await handle.dispose();
            } catch (err) {
                viaWait = 'ERR ' + err.message;
            }
            console.log(
                name,
                'evaluate=',
                JSON.stringify(viaEvaluate),
                'wait=',
                JSON.stringify(viaWait),
            );
        }

        // Exact call shape used by Client.inject().
        const controller = new AbortController();
        try {
            const evaluated = await page.evaluate(actualProbe, false);
            const handle = await page.waitForFunction(
                actualProbe,
                {
                    timeout: 5000,
                    signal: controller.signal,
                    polling: 250,
                },
                false,
            );
            const value = await handle.jsonValue();
            await handle.dispose();
            console.log(
                'actualProbe evaluate=',
                JSON.stringify(evaluated),
                'wait=',
                JSON.stringify(value),
            );
        } catch (err) {
            console.log('actualProbe ERR', err.message);
        }
    } finally {
        await browser.close().catch(() => {});
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
        console.log('profile cleaned:', !fs.existsSync(profile));
    }
})().catch((e) => {
    console.error('FAIL', e);
    process.exitCode = 1;
});
