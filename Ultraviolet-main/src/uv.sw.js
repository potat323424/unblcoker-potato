/*globals __uv$config*/
// Users must import the config (and bundle) prior to importing uv.sw.js
// This is to allow us to produce a generic bundle with no hard-coded paths.

/**
 * @type {import('../uv').UltravioletCtor}
 */
const Ultraviolet = self.Ultraviolet;

const cspHeaders = [
    'cross-origin-embedder-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy',
    'content-security-policy',
    'content-security-policy-report-only',
    'expect-ct',
    'feature-policy',
    'origin-isolation',
    'strict-transport-security',
    'upgrade-insecure-requests',
    'x-content-type-options',
    'x-download-options',
    'x-frame-options',
    'x-permitted-cross-domain-policies',
    'x-powered-by',
    'x-xss-protection',
];
const emptyMethods = ['GET', 'HEAD'];

class UVServiceWorker extends Ultraviolet.EventEmitter {
    constructor(config = __uv$config) {
        super();
        if (!config.prefix) config.prefix = '/service/';
        this.config = config;
        /**
         * @type {InstanceType<Ultraviolet['BareClient']>}
         */
        this.bareClient = new Ultraviolet.BareClient();
    }
    /**
     *
     * @param {Event & {request: Request}} param0
     * @returns
     */
    route({ request }) {
        if (request.url.startsWith(location.origin + this.config.prefix)) return true;
        else return false;
    }
    /**
     *
     * @param {Event & {request: Request}} param0
     * @returns
     */
    async fetch({ request }) {
        /**
         * @type {string|void}
         */
        let fetchedURL;

        try {
            if (!request.url.startsWith(location.origin + this.config.prefix))
                return await fetch(request);

            const ultraviolet = new Ultraviolet(this.config);

            if (typeof this.config.construct === 'function') {
                this.config.construct(ultraviolet, 'service');
            }

            const db = await ultraviolet.cookie.db();

            ultraviolet.meta.origin = location.origin;
            ultraviolet.meta.base = ultraviolet.meta.url = new URL(
                ultraviolet.sourceUrl(request.url)
            );

            const requestCtx = new RequestContext(
                request,
                ultraviolet,
                !emptyMethods.includes(request.method.toUpperCase())
                    ? await request.blob()
                    : null
            );

            if (ultraviolet.meta.url.protocol === 'blob:') {
                requestCtx.blob = true;
                requestCtx.base = requestCtx.url = new URL(
                    requestCtx.url.pathname
                );
            }

            if (
                request.referrer &&
                request.referrer.startsWith(location.origin)
            ) {
                const referer = new URL(
                    ultraviolet.sourceUrl(request.referrer)
                );

                if (
                    requestCtx.headers.origin ||
                    (ultraviolet.meta.url.origin !== referer.origin &&
                        request.mode === 'cors')
                ) {
                    requestCtx.headers.origin = referer.origin;
                }

                requestCtx.headers.referer = referer.href;
            }

            const cookies = (await ultraviolet.cookie.getCookies(db)) || [];
            const cookieStr = ultraviolet.cookie.serialize(
                cookies,
                ultraviolet.meta,
                false
            );

            requestCtx.headers['user-agent'] = navigator.userAgent;

            if (cookieStr) requestCtx.headers.cookie = cookieStr;

            const reqEvent = new HookEvent(requestCtx, null, null);
            this.emit('request', reqEvent);

            if (reqEvent.intercepted) return reqEvent.returnValue;

            fetchedURL = requestCtx.blob
                ? 'blob:' + location.origin + requestCtx.url.pathname
                : requestCtx.url;

            const response = await this.bareClient.fetch(fetchedURL, {
                headers: requestCtx.headers,
                method: requestCtx.method,
                body: requestCtx.body,
                credentials: requestCtx.credentials,
                mode: requestCtx.mode,
                cache: requestCtx.cache,
                redirect: requestCtx.redirect,
            });

            const responseCtx = new ResponseContext(requestCtx, response);
            const resEvent = new HookEvent(responseCtx, null, null);

            this.emit('beforemod', resEvent);
            if (resEvent.intercepted) return resEvent.returnValue;

            for (const name of cspHeaders) {
                if (responseCtx.headers[name]) delete responseCtx.headers[name];
            }

            if (responseCtx.headers.location) {
                responseCtx.headers.location = ultraviolet.rewriteUrl(
                    responseCtx.headers.location
                );
            }

            // downloads
            if (request.destination === 'document') {
                const header = responseCtx.headers['content-disposition'];

                // validate header and test for filename
                if (!/\s*?((inline|attachment);\s*?)filename=/i.test(header)) {
                    // if filename= wasn't specified then maybe the remote specified to download this as an attachment?
                    // if it's invalid then we can still possibly test for the attachment/inline type
                    const type = /^\s*?attachment/i.test(header)
                        ? 'attachment'
                        : 'inline';

                    // set the filename
                    const [filename] = new URL(response.finalURL).pathname
                        .split('/')
                        .slice(-1);

                    responseCtx.headers[
                        'content-disposition'
                    ] = `${type}; filename=${JSON.stringify(filename)}`;
                }
            }

            if (responseCtx.headers['set-cookie']) {
                Promise.resolve(
                    ultraviolet.cookie.setCookies(
                        responseCtx.headers['set-cookie'],
                        db,
                        ultraviolet.meta
                    )
                ).then(() => {
                    self.clients.matchAll().then(function (clients) {
                        clients.forEach(function (client) {
                            client.postMessage({
                                msg: 'updateCookies',
                                url: ultraviolet.meta.url.href,
                            });
                        });
                    });
                });
                delete responseCtx.headers['set-cookie'];
            }

            if (responseCtx.body) {
                switch (request.destination) {
                    case 'script':
                    case 'worker':
                        {
                            // craft a JS-safe list of arguments
                            const scripts = [
                                ultraviolet.bundleScript,
                                ultraviolet.clientScript,
                                ultraviolet.configScript,
                                ultraviolet.handlerScript,
                            ]
                                .map((script) => JSON.stringify(script))
                                .join(',');
                            responseCtx.body = `if (!self.__uv && self.importScripts) { ${ultraviolet.createJsInject(
                                ultraviolet.cookie.serialize(
                                    cookies,
                                    ultraviolet.meta,
                                    true
                                ),
                                request.referrer
                            )} importScripts(${scripts}); }\n`;
                            responseCtx.body += ultraviolet.js.rewrite(
                                await response.text()
                            );
                        }
                        break;
                    case 'style':
                        responseCtx.body = ultraviolet.rewriteCSS(
                            await response.text()
                        );
                        break;
                    case 'iframe':
                    case 'document':
                        if (
                            isHtml(
                                ultraviolet.meta.url,
                                responseCtx.headers['content-type'] || ''
                            )
                        ) {
                            responseCtx.body = ultraviolet.rewriteHtml(
                                await response.text(),
                                {
                                    document: true,
                                    injectHead: ultraviolet.createHtmlInject(
                                        ultraviolet.handlerScript,
                                        ultraviolet.bundleScript,
                                        ultraviolet.clientScript,
                                        ultraviolet.configScript,
                                        ultraviolet.cookie.serialize(
                                            cookies,
                                            ultraviolet.meta,
                                            true
                                        ),
                                        request.referrer
                                    ),
                                }
                            );
                        }
                }
            }

            if (requestCtx.headers.accept === 'text/event-stream') {
                responseCtx.headers['content-type'] = 'text/event-stream';
            }
            if (crossOriginIsolated) {
                responseCtx.headers['Cross-Origin-Embedder-Policy'] =
                    'require-corp';
            }

            this.emit('response', resEvent);
            if (resEvent.intercepted) return resEvent.returnValue;

            return new Response(responseCtx.body, {
                headers: responseCtx.headers,
                status: responseCtx.status,
                statusText: responseCtx.statusText,
            });
        } catch (err) {
            if (!['document', 'iframe'].includes(request.destination))
                return new Response(undefined, { status: 500 });

            console.error(err);

            return renderError(err, fetchedURL);
        }
    }
    static Ultraviolet = Ultraviolet;
}

self.UVServiceWorker = UVServiceWorker;

class ResponseContext {
    /**
     *
     * @param {RequestContext} request
     * @param {import("@mercuryworkshop/bare-mux").BareResponseFetch} response
     */
    constructor(request, response) {
        this.request = request;
        this.raw = response;
        this.ultraviolet = request.ultraviolet;
        this.headers = {};
        // eg set-cookie
        for (const key in response.rawHeaders)
            this.headers[key.toLowerCase()] = response.rawHeaders[key];
        this.status = response.status;
        this.statusText = response.statusText;
        this.body = response.body;
    }
    get url() {
        return this.request.url;
    }
    get base() {
        return this.request.base;
    }
    set base(val) {
        this.request.base = val;
    }
}

class RequestContext {
    /**
     *
     * @param {Request} request
     * @param {Ultraviolet} ultraviolet
     * @param {BodyInit} body
     */
    constructor(request, ultraviolet, body = null) {
        this.ultraviolet = ultraviolet;
        this.request = request;
        this.headers = Object.fromEntries(request.headers.entries());
        this.method = request.method;
        this.body = body || null;
        this.cache = request.cache;
        this.redirect = request.redirect;
        this.credentials = 'omit';
        this.mode = request.mode === 'cors' ? request.mode : 'same-origin';
        this.blob = false;
    }
    get url() {
        return this.ultraviolet.meta.url;
    }
    set url(val) {
        this.ultraviolet.meta.url = val;
    }
    get base() {
        return this.ultraviolet.meta.base;
    }
    set base(val) {
        this.ultraviolet.meta.base = val;
    }
}

function isHtml(url, contentType = '') {
    return (
        (
            Ultraviolet.mime.contentType(contentType || url.pathname) ||
            'text/html'
        ).split(';')[0] === 'text/html'
    );
}

class HookEvent {
    #intercepted;
    #returnValue;
    constructor(data = {}, target = null, that = null) {
        this.#intercepted = false;
        this.#returnValue = null;
        this.data = data;
        this.target = target;
        this.that = that;
    }
    get intercepted() {
        return this.#intercepted;
    }
    get returnValue() {
        return this.#returnValue;
    }
    respondWith(input) {
        this.#returnValue = input;
        this.#intercepted = true;
    }
}

/**
 *
 * @param {string} trace
 * @param {string} fetchedURL
 * @returns
 */
function errorTemplate(
    trace,
    fetchedURL,
) {
    // turn script into a data URI so we don't have to escape any HTML values
    const script = `
        errorTrace.value = ${JSON.stringify(trace)};
        fetchedURL.textContent = ${JSON.stringify(fetchedURL)};
        for (const node of document.querySelectorAll("#uvHostname")) node.textContent = ${JSON.stringify(
            location.hostname
        )};
        reload.addEventListener("click", () => location.reload());
        uvVersion.textContent = ${JSON.stringify(
            process.env.ULTRAVIOLET_VERSION
        )};
    `

    return (
        `<!DOCTYPE html>
        <html>
        <head>
        <meta charset='utf-8' />
        <title>Error</title>
        <style>
        * { background-color: white }
        </style>
        </head>
        <body>
        <h1 id='errorTitle'>Error processing your request</h1>
        <hr />
        <p>Failed to load <b id="fetchedURL"></b></p>
        <p id="errorMessage">Internal Server Error</p>
        <textarea id="errorTrace" cols="40" rows="10" readonly></textarea>
        <p>Try:</p>
        <ul>
        <li>Checking your internet connection</li>
        <li>Verifying you entered the correct address</li>
        <li>Clearing the site data</li>
        <li>Contacting <b id="uvHostname"></b>'s administrator</li>
        <li>Verify the server isn't censored</li>
        </ul>
        <p>If you're the administrator of <b id="uvHostname"></b>, try:</p>
        <ul>
        <li>Restarting your server</li>
        <li>Updating Ultraviolet</li>
        <li>Troubleshooting the error on the <a href="https://github.com/titaniumnetwork-dev/Ultraviolet" target="_blank">GitHub repository</a></li>
        </ul>
        <button id="reload">Reload</button>
        <hr />
        <p><i>Ultraviolet v<span id="uvVersion"></span></i></p>
        <script src="${
            'data:application/javascript,' + encodeURIComponent(script)
        }"></script>
        </body>
        </html>
        `
    );
}

/**
 *
 * @param {unknown} err
 * @param {string} fetchedURL
 */
function renderError(err, fetchedURL) {
    let headers = {
        'content-type': 'text/html',
    };
    if (crossOriginIsolated) {
        headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    }

    return new Response(
        errorTemplate(
            String(err),
            fetchedURL
        ),
        {
            status: 500,
            headers: headers
        }
    );
}
