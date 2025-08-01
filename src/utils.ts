import * as fs from 'fs/promises';
import {
  BLESS_PAGE_IDENTIFIER,
  ChromeCDP,
  ChromePlaywright,
  ChromiumCDP,
  ChromiumPlaywright,
  Config,
  EdgeCDP,
  EdgePlaywright,
  FirefoxPlaywright,
  Request,
  WaitForEventOptions,
  WaitForFunctionOptions,
  WebKitPlaywright,
  codes,
  contentTypes,
  encodings,
  encryptionAlgo,
  encryptionSep,
} from '@browserless.io/browserless';
import playwright, { CDPSession } from 'playwright-core';
import { Duplex } from 'stream';
import { Page } from 'puppeteer-core';
import { ServerResponse } from 'http';
import crypto from 'crypto';
import debug from 'debug';
import { fileURLToPath } from 'url';
import gradient from 'gradient-string';
import { homedir } from 'os';
import micromatch from 'micromatch';
import path from 'path';

const isHTTP = (
  writeable: ServerResponse | Duplex,
): writeable is ServerResponse => {
  return (writeable as ServerResponse).writeHead !== undefined;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const getAuthHeaderToken = (header: string) => {
  if (header.startsWith('Basic')) {
    const username = header.split(/\s+/).pop() || '';
    const token = Buffer.from(username, 'base64').toString().replace(':', '');
    return token;
  }

  if (header.startsWith('Bearer')) {
    const [, token] = header.split(' ');
    return token;
  }

  return null;
};

/**
 * RegEx to match the Playwright version from the innitial request header.
 *
 * @example
 * const userAgent = "Playwright/1.43.1 (x64; windows 10.0) node/20.11";
 * userAgent.match(pwVersionRegex);
 * // ["Playwright/1.43", "1.43"]
 */
export const pwVersionRegex = /Playwright\/(\d+\.\d+)/;
export const buildDir: string = path.join(path.resolve(), 'build');
export const tsExtension = '.d.ts';
export const jsonExtension = '.json';
export const jsExtension = '.js';
export const isWin = process.platform === 'win32';

export const id = (): string => crypto.randomUUID();

/**
 * Normalizes a full-path by adding the `file://` protocol if needed.
 *
 * @param filepath - The file path to normalize.
 * @returns The normalized file path.
 */
export const normalizeFileProtocol = (filepath: string) => {
  if (isWin) {
    if (filepath.startsWith('file:///')) return filepath;

    return 'file:///' + filepath;
  }

  return filepath;
};

/**
 * Generates a random, Chromium-compliant page ID with "BLESS"
 * prepended. This prepended text signals to other parts of the
 * system that this is a Browserless-created ID so it can be appropriately
 * handled.
 *
 * @returns {string} A random Page ID
 */
export const pageID = (): string => {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const id = Array.from({ length: 32 - BLESS_PAGE_IDENTIFIER.length })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');

  return `${BLESS_PAGE_IDENTIFIER}${id}`;
};

export const createLogger = (domain: string): debug.Debugger => {
  return debug(`browserless.io:${domain}`);
};

const errorLog = createLogger('error');

export const dedent = (
  strings: string | string[],
  ...values: string[]
): string => {
  const raw = Array.isArray(strings) ? strings : [strings];

  let result = '';

  for (let i = 0; i < raw.length; i++) {
    result += raw[i]
      // join lines when there is a suppressed newline
      .replace(/\\\n[ \t]*/g, '')
      // handle escaped back-ticks
      .replace(/\\`/g, '`');

    if (i < values.length) {
      result += values[i];
    }
  }

  // now strip indentation
  const lines = result.split('\n');
  let mIndent: number | null = null;
  lines.forEach((l) => {
    const m = l.match(/^(\s+)\S+/);
    if (m) {
      const indent = m[1].length;
      if (!mIndent) {
        // this is the first indented line
        mIndent = indent;
      } else {
        mIndent = Math.min(mIndent, indent);
      }
    }
  });

  if (mIndent !== null) {
    const m = mIndent;
    result = lines.map((l) => (l[0] === ' ' ? l.slice(m) : l)).join('\n');
  }

  return (
    result
      // dedent eats leading and trailing whitespace too
      .trim()
      // handle escaped newlines at the end to ensure they don't get stripped too
      .replace(/\\n/g, '\n')
  );
};

export const isConnected = (connection: Duplex | ServerResponse): boolean =>
  isHTTP(connection) ? !!connection.socket?.writable : !!connection.writable;

export const writeResponse = (
  writeable: Duplex | ServerResponse,
  httpCode: keyof typeof codes,
  message: string,
  contentType: contentTypes = contentTypes.text,
): void => {
  if (!isConnected(writeable)) {
    return;
  }

  const httpMessage = codes[httpCode];
  const CTTHeader = `${contentType}; charset=${encodings.utf8}`;

  if (isHTTP(writeable)) {
    const response = writeable;
    if (!response.headersSent) {
      response.writeHead(httpMessage.code, { 'Content-Type': CTTHeader });
      response.end(message + '\n');
    }
    return;
  }

  const httpResponse = [
    httpMessage.message,
    `Content-Type: ${CTTHeader}`,
    'Content-Encoding: UTF-8',
    'Accept-Ranges: bytes',
    'Connection: keep-alive',
    '\r\n',
    message,
  ].join('\r\n');

  writeable.write(httpResponse);
  writeable.end();
  return;
};

export const jsonResponse = (
  response: ServerResponse,
  httpCode: keyof typeof codes = 200,
  json: unknown = {},
  allowNull = true,
): void => {
  const httpMessage = codes[httpCode];
  const CTTHeader = `${contentTypes.json}; charset=${encodings.utf8}`;

  if (!response.headersSent) {
    response.writeHead(httpMessage.code, { 'Content-Type': CTTHeader });
    response.end(removeNullStringify(json, allowNull));
    return;
  }

  return;
};

export const fetchJson = (
  url: string,
  init?: RequestInit | undefined,
): Promise<unknown> =>
  fetch(url, init).then((res) => {
    if (!res.ok) {
      throw res;
    }
    return res.json();
  });

export const getTokenFromRequest = (req: Request) => {
  const authHeader = req.headers['authorization'];
  const tokenParam = req.parsed.searchParams.get('token');
  return tokenParam ?? getAuthHeaderToken(authHeader || '');
};

// NOTE, if proxying request elsewhere, you must re-stream the body again
export const readRequestBody = async (
  req: Request,
  maxSize: number = 10485760,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const body: Uint8Array[] = [];
    let hasResolved = false;
    let totalSize = 0;

    const resolveOnce = (results: string) => {
      if (hasResolved) {
        return;
      }
      hasResolved = true;
      resolve(results);
    };

    const rejectOnce = (error: Error) => {
      if (hasResolved) {
        return;
      }
      hasResolved = true;
      reject(error);
    };

    req
      .on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > maxSize) {
          rejectOnce(
            new BadRequest(
              `Request payload size (${totalSize} bytes) exceeds maximum allowed size of ${maxSize} bytes`,
            ),
          );
          return;
        }
        body.push(chunk);
      })
      .on('end', () => {
        const final = Buffer.concat(body).toString();
        resolveOnce(final);
      })
      .on('aborted', () => {
        resolveOnce('');
      })
      .on('error', (error) => {
        rejectOnce(error);
      });
  });
};

export const safeParse = (maybeJson: string): unknown | null => {
  try {
    return JSON.parse(maybeJson);
  } catch {
    return null;
  }
};

export const removeNullStringify = (
  json: unknown,
  allowNull = true,
): string => {
  return JSON.stringify(
    json,
    (_key, value) => {
      if (allowNull) return value;
      if (value !== null) return value;
    },
    '  ',
  );
};

export const jsonOrString = (maybeJson: string): unknown | string =>
  safeParse(maybeJson) ?? maybeJson;

export const generateDataDir = async (
  sessionId: string = id(),
  config: Config,
): Promise<string> => {
  const baseDirectory = await config.getDataDir();
  const dataDirPath = path.join(
    baseDirectory,
    `browserless-data-dir-${sessionId}`,
  );

  if (await exists(dataDirPath)) {
    debug(`Data directory already exists, not creating "${dataDirPath}"`);
    return dataDirPath;
  }

  debug(`Generating user-data-dir at ${dataDirPath}`);

  await fs.mkdir(dataDirPath, { recursive: true }).catch((err) => {
    throw new ServerError(
      `Error creating data-directory "${dataDirPath}": ${err}`,
    );
  });

  return dataDirPath;
};

export const readBody = async (
  req: Request,
  maxSize: number = 10485760,
): Promise<ReturnType<typeof safeParse>> => {
  if (
    typeof req.body === 'string' &&
    (isBase64.test(req.body) || req.body.startsWith('{'))
  ) {
    return safeParse(convertIfBase64(req.body));
  }
  const body = await readRequestBody(req, maxSize);

  return req.headers['content-type']?.includes(contentTypes.json)
    ? safeParse(body)
    : body;
};

/**
 * Lists the path of Chromes (stable) install since
 * no library or utility out there does it including playwright.
 */
export const chromeExecutablePath = () => {
  if (process.platform === 'win32') {
    // Windows always includes the ProgramFiles variable in the environment
    return `${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`;
  }

  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  return '/usr/bin/google-chrome-stable';
};

export const edgeExecutablePath = () => {
  if (process.platform === 'win32') {
    // Windows always includes the ProgramFiles variable in the environment
    return `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`;
  }

  if (process.platform === 'darwin') {
    return '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  }

  return '/usr/bin/microsoft-edge-stable';
};

export const getRouteFiles = async (config: Config): Promise<string[][]> => {
  const routes = config.getRoutes();
  const foundRoutes: string[] = await fs
    .readdir(routes)
    .then((dirs) =>
      dirs.flatMap((d) => [
        path.join(routes, d, 'ws'),
        path.join(routes, d, 'http'),
      ]),
    )
    .catch(() => []);

  const [httpRouteFolders, wsRouteFolders] = foundRoutes.reduce(
    ([http, ws]: [string[], string[]], routePath) => {
      if (routePath.endsWith('http')) {
        http.push(routePath);
      }

      if (routePath.endsWith('ws')) {
        ws.push(routePath);
      }

      return [http, ws];
    },
    [[], []],
  );

  const [httpDirs, wsDirs] = await Promise.all([
    await Promise.all(
      httpRouteFolders.map((r) =>
        fs
          .readdir(r)
          .then((files) => files.map((f) => path.join(r, f)))
          .catch(() => []),
      ),
    ),
    await Promise.all(
      wsRouteFolders.map((r) =>
        fs
          .readdir(r)
          .then((files) => files.map((f) => path.join(r, f)))
          .catch(() => []),
      ),
    ),
  ]);

  return [httpDirs.flat(), wsDirs.flat()];
};

export const make404 = (...messages: string[]): string => {
  const [title, ...rest] = messages;

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Not Found</title>
    </head>
    <style>
    body {
      padding: 50px;
      width: 960px;
      margin: 0 auto;
    }
    pre {
      overflow-wrap: break-word;
      white-space: break-spaces;
    }
    </style>
    <body><div style="background-image: url(&quot;data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9JzMwMHB4JyB3aWR0aD0nMzAwcHgnICBmaWxsPSIjMDAwMDAwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGRhdGEtbmFtZT0i0KHQu9C+0LkgMSIgdmlld0JveD0iMCAwIDEyOCAxMjgiIHg9IjBweCIgeT0iMHB4Ij48dGl0bGU+aWNfcXVlc3Rpb25fbWFya193aW5kb3c8L3RpdGxlPjxjaXJjbGUgY3g9IjExNiIgY3k9IjEyIiByPSIyIj48L2NpcmNsZT48Y2lyY2xlIGN4PSIxMDgiIGN5PSIxMiIgcj0iMiI+PC9jaXJjbGU+PGNpcmNsZSBjeD0iMTAwIiBjeT0iMTIiIHI9IjIiPjwvY2lyY2xlPjxwYXRoIGQ9Ik0xMjEsMEg3QTcsNywwLDAsMCwwLDdWMTIxYTcsNywwLDAsMCw3LDdIMTIxYTcsNywwLDAsMCw3LTdWN0E3LDcsMCwwLDAsMTIxLDBaTTcsNEgxMjFhMywzLDAsMCwxLDMsM1YyMEg0VjdBMywzLDAsMCwxLDcsNFpNMTIxLDEyNEg3YTMsMywwLDAsMS0zLTNWMjRIMTI0VjEyMUEzLDMsMCwwLDEsMTIxLDEyNFoiPjwvcGF0aD48cGF0aCBkPSJNNjQsNDcuNTJhMTQsMTQsMCwwLDAtMTQsMTQsMiwyLDAsMCwwLDQsMCwxMCwxMCwwLDEsMSwyMCwwYzAsMy44My0yLjEyLDYuMS00LjgxLDlDNjYsNzQsNjIsNzguMjQsNjIsODYuMjNhMiwyLDAsMSwwLDQsMGMwLTYuNDEsMy05LjYsNi4xNC0xM0M3NSw3MC4xNSw3OCw2Nyw3OCw2MS41NEExNCwxNCwwLDAsMCw2NCw0Ny41MloiPjwvcGF0aD48Y2lyY2xlIGN4PSI2NCIgY3k9Ijk2LjIzIiByPSIyLjI1Ij48L2NpcmNsZT48L3N2Zz4=&quot;); background-repeat: no-repeat; height: 75px; background-size: contain; background-position: 50%;"></div>
      <pre style="font-size: 24px; font-weight: bold">404: ${title}</pre>
      <pre>${rest.join('\n')}</pre>
    </body>
    </html>
    `;
};

/**
 * Returns a Promise that will automatically resolve
 * after the provided number of milliseconds.
 *
 * @param {number} time
 * @returns {Promise}
 */
export const sleep = (time: number): Promise<void> =>
  new Promise((r) => setTimeout(r, time));

/**
 * Returns a boolean if a given filepath (directory or file)
 * exists in the file system. Uses stat internally.
 *
 * @param {string} path The file or folder path
 * @returns {boolean}
 */
export const exists = async (path: string): Promise<boolean> => {
  return !!(await fs.stat(path).catch(() => false));
};

/**
 * Returns a boolean if a given file, not directory,
 * exists in the file system. Uses stat internally.
 *
 * @param {string} path The file or folder path
 * @returns {boolean}
 */
export const fileExists = async (path: string): Promise<boolean> =>
  fs
    .stat(path)
    .then((stat) => stat.isFile())
    .catch(() => false);

const isBase64 =
  /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;

export const convertIfBase64 = (item: string): string =>
  isBase64.test(item) ? Buffer.from(item, 'base64').toString() : item;

export const availableBrowsers = Promise.all([
  exists(playwright.chromium.executablePath()),
  exists(playwright.firefox.executablePath()),
  exists(playwright.webkit.executablePath()),
  exists(chromeExecutablePath()),
  exists(edgeExecutablePath()),
]).then(
  ([chromiumExists, firefoxExists, webkitExists, chromeExists, edgeExists]) => {
    const availableBrowsers = [];

    if (chromiumExists) {
      availableBrowsers.push(ChromiumCDP, ChromiumPlaywright);
    }

    if (chromeExists) {
      availableBrowsers.push(ChromeCDP, ChromePlaywright);
    }

    if (firefoxExists) {
      availableBrowsers.push(FirefoxPlaywright);
    }

    if (webkitExists) {
      availableBrowsers.push(WebKitPlaywright);
    }

    if (edgeExists) {
      availableBrowsers.push(EdgeCDP, EdgePlaywright);
    }

    return availableBrowsers;
  },
);

export const queryParamsToObject = (
  params: URLSearchParams,
): Record<string, unknown> =>
  [...params.entries()].reduce(
    (accum, [key, value]) => {
      accum[key] =
        value === '' || value === undefined || value === null ? true : value;
      return accum;
    },
    {} as ReturnType<typeof queryParamsToObject>,
  );

// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const wrapUserFunction = (fn: string) => {
  // Handle async definitions
  if (fn.includes('async') || fn.includes('await')) {
    return new AsyncFunction(`await (${fn})(); return true`);
  }

  // Handle IIFE or anonymous functions
  if (fn.startsWith('function') || fn.startsWith('()')) {
    return `(${fn})()`;
  }

  // Simple statement-like functions
  return fn;
};

export const waitForFunction = async (
  page: Page,
  opts: WaitForFunctionOptions,
): Promise<void> => {
  const { fn, polling, timeout } = opts;
  const wrappedFn = wrapUserFunction(fn);
  // @ts-ignore objects are valid arguments into evaluate
  return page.waitForFunction(wrappedFn, { polling, timeout });
};

export const waitForEvent = async (
  page: Page,
  opts: WaitForEventOptions,
): Promise<void> => {
  const awaitEvent = async (event: string) => {
    await new Promise<void>((resolve) => {
      document.addEventListener(event, () => resolve(), { once: true });
      window.addEventListener(event, () => resolve(), { once: true });
    });
  };

  const timeout = opts.timeout || 30000;

  await Promise.race([
    page.evaluate(awaitEvent, opts.event),
    sleep(timeout).then(() => {
      throw new Timeout(`Timed out waiting for event "${opts.event}"'`);
    }),
  ]);
};

/**
 * Scrolls through the web-page to trigger any lazy-loaded
 * assets to load up. Currently doesn't support infinite-loading
 * pages as they'll increase the length of the page.
 *
 * @param page Page
 */
export const scrollThroughPage = async (page: Page) => {
  const viewport = (await page.viewport()) || {
    height: 480,
    width: 640,
  }; // default Puppeteer viewport

  await page.evaluate((bottomThreshold) => {
    const scrollInterval = 100;
    const scrollStep = Math.floor(window.innerHeight / 2);

    function bottomPos() {
      return window.pageYOffset + window.innerHeight;
    }

    return new Promise((resolve) => {
      function scrollDown() {
        window.scrollBy(0, scrollStep);

        if (document.body.scrollHeight - bottomPos() < bottomThreshold) {
          window.scrollTo(0, 0);
          setTimeout(resolve, 500);
          return;
        }

        setTimeout(scrollDown, scrollInterval);
      }

      scrollDown();
    });
  }, viewport.height);
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
// eslint-disable-next-line @typescript-eslint/no-empty-function
export const noop = (): void => {};

export const once = <A extends unknown[], R, T>(
  fn: (this: T, ...arg: A) => R,
): ((this: T, ...arg: A) => R | undefined) => {
  let done = false;
  return function (this: T, ...args: A) {
    return done ? void 0 : ((done = true), fn.apply(this, args));
  };
};

export const getRandomNegativeInt = (): number => {
  return Math.floor(Math.random() * 1000000000) * -1;
};

/**
 * Converts an inbound req.url string to a valid URL object.
 * Handles cases where browserless might be behind a path or reverse proxy.
 *
 * @param url The inbound url, generally req.url
 * @param config The config object
 * @returns The full URL object
 */
export const convertPathToURL = (url: string, config: Config): URL => {
  const external = config.getExternalAddress();
  const fullInboundURL = new URL(url, external).href;
  const internalPath = fullInboundURL.replace(external, '');

  return new URL(internalPath, config.getServerAddress());
};

export const makeExternalURL = (
  externalAddress: string,
  ...parts: string[]
): string => {
  const externalURL = new URL(externalAddress);

  return new URL(path.join(externalURL.pathname, ...parts), externalAddress)
    .href;
};

export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
    this.message = message;
    errorLog(this.message);
  }
}

export class TooManyRequests extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooManyRequests';
    this.message = message;
    errorLog(this.message);
  }
}

export class ServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerError';
    this.message = message;
    errorLog(this.message);
  }
}
export class Unauthorized extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Unauthorized';
    this.message = message;
    errorLog(this.message);
  }
}
export class NotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFound';
    this.message = message;
    errorLog(this.message);
  }
}
export class Timeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Timeout';
    this.message = message;
    errorLog(this.message);
  }
}

export const bestAttemptCatch =
  (bestAttempt: boolean) =>
  (err: Error): void => {
    if (bestAttempt) return;
    throw err;
  };

export const parseBooleanParam = (
  params: URLSearchParams,
  name: string,
  defaultValue: boolean,
) => {
  const value = params.get(name);

  if (value === null) {
    return defaultValue;
  }

  // ?param format (no specified value)
  if (value === '' || value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return defaultValue;
};

export const parseNumberParam = (
  params: URLSearchParams,
  name: string,
  defaultValue: number,
) => {
  const value = params.get(name);

  if (value === null) {
    return defaultValue;
  }

  // ?param format (no specified value)
  if (value === '') {
    return defaultValue;
  }

  const numb = +value;

  if (isNaN(numb)) {
    return defaultValue;
  }

  return numb;
};

export const parseStringParam = (
  params: URLSearchParams,
  name: string,
  defaultValue: string,
): string => {
  const value = params.get(name);

  if (value === null) {
    return defaultValue;
  }

  return value;
};

export const encrypt = (text: string, secret: Buffer) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(encryptionAlgo, secret, iv);
  const encrypted = cipher.update(text, 'utf8', 'hex');

  return [
    encrypted + cipher.final('hex'),
    Buffer.from(iv).toString('hex'),
  ].join(encryptionSep);
};

export const decrypt = (encryptedText: string, secret: Buffer) => {
  const [encrypted, iv] = encryptedText.toString().split(encryptionSep);
  if (!iv) throw new ServerError('Bad or invalid encrypted format');
  const decipher = crypto.createDecipheriv(
    encryptionAlgo,
    secret,
    Buffer.from(iv, 'hex'),
  );
  return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
};

interface RequestInitTimeout extends RequestInit {
  timeout?: number;
}

export const fetchTimeout = async (
  input: RequestInfo | URL,
  initWithTimeout?: RequestInitTimeout,
) => {
  if (!initWithTimeout) return await fetch(input);
  const { timeout, ...init } = initWithTimeout;

  if (!timeout) return await fetch(input, init);

  const controller = new AbortController();
  const id = setTimeout(
    () => controller.abort(new Error(`TimeoutError`)),
    timeout,
  );
  let res;

  try {
    res = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(id);
  }
  return res;
};

export const untildify = (path: string) => {
  const homeDir = homedir();

  return homeDir ? path.replace(/^~(?=$|\/|\\)/, homeDir) : path;
};

export const printLogo = (docsLink: string, debugURL?: string | boolean) => `
---------------------------------------------------------
| browserless.io
| To read documentation and more, load in your browser:
|
| OpenAPI: ${docsLink}
| Full Documentation: https://docs.browserless.io/ ${
  /*prettier-ignore*/
  debugURL ? `
| Debbuger: ${debugURL}`  : ""
}
---------------------------------------------------------
${gradient(
  '#ff1a8c',
  '#ffea00',
)(`

█▓▒
████▒
████▒
████▒   ▒██▓▒
████▒   ▒████
████▒   ▒████
████▒   ▒████
████▒   ▒████
████▒   ▒████
████▒   ▒██████▓▒
████▒   ▒██████████▒
████▒   ▒██████▓████
████▒   ▒█▓▓▒  ▒████
████▒          ▒████
████▒       ▒▓██████
████▒   ▒▓████████▓▒
████▓▓████████▓▒
██████████▓▒
  ▓███▓▒

`)}`;

export const getCDPClient = (page: Page): CDPSession => {
  // @ts-ignore using internal CDP client
  const c = page._client;

  return typeof c === 'function' ? c.call(page) : c;
};

export const ublockLitePath = path.join(
  __dirname,
  '..',
  'extensions',
  'ublocklite',
);

export const isMatch = (text: string, pattern: string) => {
  return micromatch.isMatch(text, pattern, { bash: true });
};

/**
 * Sanitizes a URL by redacting the token parameter for safe logging.
 * Preserves other query parameters for debugging purposes.
 *
 * @param url The URL string to sanitize
 * @returns The sanitized URL string with token redacted
 */
export const sanitizeUrlForLogging = (url: string): string => {
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const urlObj = new URL(url);
      if (urlObj.searchParams.has('token')) {
        urlObj.searchParams.set('token', '[REDACTED]');
      }
      return urlObj.toString();
    }
    
    const urlObj = new URL(url, 'http://localhost');
    if (urlObj.searchParams.has('token')) {
      urlObj.searchParams.set('token', '[REDACTED]');
    }
    return urlObj.pathname + urlObj.search;
  } catch {
    return url;
  }
};
