/**
 * Cloudflare Worker - CORS Media Proxy
 *
 * Usage:
 *   /proxy/<ENCODED_TARGET_URL>
 *
 * Example:
 *   https://your-worker.workers.dev/proxy/https%3A%2F%2Fexample.com%2Fvideo.m3u8
 *
 * Supports:
 *   - HLS .m3u8
 *   - DASH .mpd
 *   - TS/AAC/MP4/fMP4 segments
 *   - HTTP Range requests
 *   - CORS
 *   - Relative URL rewriting inside manifests
 *
 * Hostname is automatically extracted from the target URL.
 */

const PROXY_PATH = "/proxy/";

const MAX_MANIFEST_SIZE = 5 * 1024 * 1024;

/* =========================================================
   CORS
========================================================= */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":
    "Range, Origin, Accept, Content-Type, User-Agent",
  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Length, Content-Range, Content-Type",
  "Access-Control-Max-Age": "86400",
};

/* =========================================================
   MAIN
========================================================= */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      /* -----------------------------------------------------
         OPTIONS
      ----------------------------------------------------- */

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS,
        });
      }

      /* -----------------------------------------------------
         Allowed methods
      ----------------------------------------------------- */

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: {
            ...CORS_HEADERS,
            Allow: "GET, HEAD, OPTIONS",
          },
        });
      }

      /* -----------------------------------------------------
         Home page
      ----------------------------------------------------- */

      if (url.pathname === "/" || url.pathname === "/proxy") {
        return new Response(
          `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Media Proxy</title>
<style>
body {
  font-family: Arial, sans-serif;
  background: #111;
  color: #fff;
  margin: 0;
  padding: 40px 20px;
}
.container {
  max-width: 800px;
  margin: auto;
}
h1 {
  margin-bottom: 10px;
}
input {
  width: 100%;
  box-sizing: border-box;
  padding: 14px;
  border-radius: 8px;
  border: 1px solid #444;
  background: #222;
  color: white;
  margin-top: 15px;
}
button {
  margin-top: 12px;
  padding: 12px 20px;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
pre {
  white-space: pre-wrap;
  word-break: break-all;
  background: #1c1c1c;
  padding: 15px;
  border-radius: 8px;
}
</style>
</head>

<body>

<div class="container">

<h1>Media Proxy</h1>

<p>
Enter an HLS, DASH or media URL.
</p>

<input
  id="target"
  type="text"
  placeholder="https://example.com/video.m3u8"
>

<button onclick="generate()">
Generate Proxy URL
</button>

<pre id="output"></pre>

</div>

<script>

function generate() {

  const target =
    document.getElementById("target").value.trim();

  if (!target) {
    document.getElementById("output").textContent =
      "Enter a URL.";
    return;
  }

  try {

    const parsed = new URL(target);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      throw new Error("Only HTTP and HTTPS URLs are supported.");
    }

    const proxy =
      location.origin +
      "/proxy/" +
      encodeURIComponent(target);

    document.getElementById("output").textContent =
      proxy;

  } catch (e) {

    document.getElementById("output").textContent =
      "Invalid URL: " + e.message;

  }

}

</script>

</body>
</html>`,
          {
            status: 200,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/html; charset=UTF-8",
            },
          }
        );
      }

      /* -----------------------------------------------------
         Proxy route
      ----------------------------------------------------- */

      if (
        url.pathname === PROXY_PATH.slice(0, -1) ||
        url.pathname.startsWith(PROXY_PATH)
      ) {
        return await proxyRequest(request, url);
      }

      return new Response("Not Found", {
        status: 404,
        headers: CORS_HEADERS,
      });

    } catch (error) {

      return new Response(
        "Worker Error: " + error.message,
        {
          status: 500,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain; charset=UTF-8",
          },
        }
      );
    }
  },
};


/* =========================================================
   PROXY REQUEST
========================================================= */

async function proxyRequest(request, workerUrl) {

  /* -------------------------------------------------------
     Extract encoded target URL
  ------------------------------------------------------- */

  let encodedTarget =
    workerUrl.pathname.slice(PROXY_PATH.length);

  if (!encodedTarget) {

    return new Response(
      "Missing target URL.",
      {
        status: 400,
        headers: CORS_HEADERS,
      }
    );
  }

  /* -------------------------------------------------------
     Decode target
  ------------------------------------------------------- */

  let targetString;

  try {

    targetString = decodeURIComponent(encodedTarget);

  } catch {

    return new Response(
      "Invalid encoded target URL.",
      {
        status: 400,
        headers: CORS_HEADERS,
      }
    );
  }

  /* -------------------------------------------------------
     Parse target URL
  ------------------------------------------------------- */

  let targetUrl;

  try {

    targetUrl = new URL(targetString);

  } catch {

    return new Response(
      "Invalid target URL.",
      {
        status: 400,
        headers: CORS_HEADERS,
      }
    );
  }

  /* =======================================================
     AUTOMATIC HOSTNAME EXTRACTION
  ======================================================= */

  const hostname =
    targetUrl.hostname.toLowerCase();

  /*
   * The hostname is now automatically available here.
   *
   * Example:
   *
   * target:
   * https://abc.example.com/live/test.m3u8
   *
   * hostname:
   * abc.example.com
   */

  console.log(
    "Automatic target hostname:",
    hostname
  );

  /* -------------------------------------------------------
     Protocol validation
  ------------------------------------------------------- */

  if (
    targetUrl.protocol !== "http:" &&
    targetUrl.protocol !== "https:"
  ) {

    return new Response(
      "Only HTTP and HTTPS URLs are allowed.",
      {
        status: 400,
        headers: CORS_HEADERS,
      }
    );
  }

  /* -------------------------------------------------------
     Block localhost / internal targets
  ------------------------------------------------------- */

  if (isBlockedHostname(hostname)) {

    return new Response(
      "Target hostname is not allowed.",
      {
        status: 403,
        headers: CORS_HEADERS,
      }
    );
  }

  /* =======================================================
     AUTOMATIC HOST "ALLOWLIST"
  =======================================================

     No manual ALLOWED_HOSTS array is required.

     The hostname is obtained directly from targetUrl.

     IMPORTANT:
     This means the Worker can proxy arbitrary public
     HTTP/HTTPS hosts. It is therefore not a security
     allowlist.

     If you later want a restricted proxy, replace this
     automatic behavior with a fixed allowlist.
  ======================================================= */

  const ALLOWED_HOSTS = new Set();

  ALLOWED_HOSTS.add(hostname);

  /*
   * This gives you the automatically detected host if you
   * want to use it elsewhere in the script.
   */

  console.log(
    "Allowed host:",
    [...ALLOWED_HOSTS]
  );

 /* -------------------------------------------------------
     Request headers (Optimized to match working proxies)
  ------------------------------------------------------- */

  const upstreamHeaders = new Headers();

  /* 1. Intelligent Referer / Origin handling */
  const targetOrigin = `${targetUrl.protocol}//${targetUrl.host}`;
  
  // If you want to use the target's host as origin, but fallback or strip if needed:
  upstreamHeaders.set("Origin", targetOrigin);
  
  // For many streaming sites, they want the referer to look like it came from the main app or be clean:
  const customReferer = request.headers.get("Referer");
  if (customReferer) {
    upstreamHeaders.set("Referer", customReferer);
  } else {
    upstreamHeaders.set("Referer", targetOrigin + "/");
  }

  /* 2. Range request support */
  const range = request.headers.get("Range");
  if (range) {
    upstreamHeaders.set("Range", range);
  }

  /* 3. Accept headers */
  upstreamHeaders.set("Accept", request.headers.get("Accept") || "*/*");
  
  const acceptEncoding = request.headers.get("Accept-Encoding");
  if (acceptEncoding) {
    upstreamHeaders.set("Accept-Encoding", acceptEncoding);
  }

  /* 4. User-Agent */
  const userAgent = request.headers.get("User-Agent");
  upstreamHeaders.set(
    "User-Agent", 
    userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  /* 5. Browser Sec-Fetch metadata (helps bypass advanced WAF checks) */
  upstreamHeaders.set("Sec-Fetch-Site", "cross-site");
  upstreamHeaders.set("Sec-Fetch-Mode", "cors");
  upstreamHeaders.set("Sec-Fetch-Dest", "empty");
  /* -------------------------------------------------------
     Fetch upstream
  ------------------------------------------------------- */

  let upstreamResponse;

  try {

    upstreamResponse =
      await fetch(targetUrl.toString(), {
        method: request.method,

        headers: upstreamHeaders,

        redirect: "follow",

        cf: {
          cacheTtl: 0,
          cacheEverything: false,
        },
      });

  } catch (error) {

    return new Response(
      "Upstream request failed: " +
      error.message,
      {
        status: 502,
        headers: CORS_HEADERS,
      }
    );
  }

  /* -------------------------------------------------------
     HEAD
  ------------------------------------------------------- */

  if (request.method === "HEAD") {

    return createProxyResponse(
      null,
      upstreamResponse
    );
  }

  /* -------------------------------------------------------
     Detect content type
  ------------------------------------------------------- */

  const contentType =
    (
      upstreamResponse.headers.get(
        "Content-Type"
      ) || ""
    ).toLowerCase();

  const pathname =
    targetUrl.pathname.toLowerCase();

  const isHLS =
    contentType.includes(
      "application/vnd.apple.mpegurl"
    ) ||
    contentType.includes(
      "application/x-mpegurl"
    ) ||
    pathname.endsWith(".m3u8");

  const isDASH =
    contentType.includes(
      "application/dash+xml"
    ) ||
    pathname.endsWith(".mpd");

  /* -------------------------------------------------------
     Manifest
  ------------------------------------------------------- */

  if (isHLS || isDASH) {

    const contentLength =
      parseInt(
        upstreamResponse.headers.get(
          "Content-Length"
        ) || "0",
        10
      );

    if (
      contentLength > MAX_MANIFEST_SIZE
    ) {

      return new Response(
        "Manifest is too large.",
        {
          status: 413,
          headers: CORS_HEADERS,
        }
      );
    }

    let manifestText;

    try {

      manifestText =
        await upstreamResponse.text();

    } catch (error) {

      return new Response(
        "Unable to read manifest: " +
        error.message,
        {
          status: 502,
          headers: CORS_HEADERS,
        }
      );
    }

    let rewritten;

    if (isHLS) {

      rewritten =
        rewriteHLSManifest(
          manifestText,
          targetUrl,
          workerUrl.origin
        );

    } else {

      rewritten =
        rewriteDASHManifest(
          manifestText,
          targetUrl,
          workerUrl.origin
        );
    }

    const headers =
      new Headers(CORS_HEADERS);

    headers.set(
      "Content-Type",
      contentType ||
      (
        isHLS
          ? "application/vnd.apple.mpegurl"
          : "application/dash+xml"
      )
    );

    headers.set(
      "Cache-Control",
      "no-cache, no-store, must-revalidate"
    );

    return new Response(
      rewritten,
      {
        status: upstreamResponse.status,
        headers,
      }
    );
  }

  /* -------------------------------------------------------
     Normal media / segment
  ------------------------------------------------------- */

  return createProxyResponse(
    upstreamResponse.body,
    upstreamResponse
  );
}


/* =========================================================
   CREATE PROXY RESPONSE
========================================================= */

function createProxyResponse(
  body,
  upstreamResponse
) {

  const headers =
    new Headers(CORS_HEADERS);

  const copyHeaders = [
    "Accept-Ranges",
    "Content-Length",
    "Content-Range",
    "Content-Type",
    "Content-Disposition",
    "ETag",
    "Last-Modified",
    "Cache-Control",
    "Expires",
  ];

  for (const name of copyHeaders) {

    const value =
      upstreamResponse.headers.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  /*
   * Always expose range-related headers.
   */

  headers.set(
    "Access-Control-Expose-Headers",
    [
      "Accept-Ranges",
      "Content-Length",
      "Content-Range",
      "Content-Type",
      "Content-Disposition",
      "ETag",
      "Last-Modified",
    ].join(", ")
  );

  return new Response(
    body,
    {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    }
  );
}


/* =========================================================
   HLS MANIFEST REWRITER
========================================================= */

function rewriteHLSManifest(
  manifest,
  manifestUrl,
  workerOrigin
) {

  /*
   * Rewrite URI="..."
   *
   * Example:
   *
   * URI="segment/key.key"
   *
   * becomes:
   *
   * URI="https://worker/proxy/..."
   */

  manifest =
    manifest.replace(
      /URI="([^"]+)"/gi,
      (match, uri) => {

        const absolute =
          resolveUrl(
            uri,
            manifestUrl
          );

        if (!absolute) {
          return match;
        }

        const proxy =
          makeProxyUrl(
            absolute,
            workerOrigin
          );

        return `URI="${proxy}"`;
      }
    );

  /*
   * Rewrite normal URI lines.
   */

  const lines =
    manifest.split(/\r?\n/);

  const rewritten =
    lines.map(line => {

      const trimmed =
        line.trim();

      if (!trimmed) {
        return line;
      }

      /*
       * Don't modify comments.
       */

      if (trimmed.startsWith("#")) {
        return line;
      }

      const absolute =
        resolveUrl(
          trimmed,
          manifestUrl
        );

      if (!absolute) {
        return line;
      }

      return makeProxyUrl(
        absolute,
        workerOrigin
      );
    });

  return rewritten.join("\n");
}


/* =========================================================
   DASH MANIFEST REWRITER
========================================================= */

function rewriteDASHManifest(
  manifest,
  manifestUrl,
  workerOrigin
) {

  /*
   * media=""
   */

  manifest =
    manifest.replace(
      /(media|initialization|sourceURL|index)="([^"]+)"/gi,
      (match, attribute, value) => {

        const absolute =
          resolveUrl(
            value,
            manifestUrl
          );

        if (!absolute) {
          return match;
        }

        const proxy =
          makeProxyUrl(
            absolute,
            workerOrigin
          );

        return `${attribute}="${proxy}"`;
      }
    );

  /*
   * BaseURL
   */

  manifest =
    manifest.replace(
      /(<BaseURL[^>]*>)([\s\S]*?)(<\/BaseURL>)/gi,
      (match, open, value, close) => {

        const clean =
          value.trim();

        if (!clean) {
          return match;
        }

        const absolute =
          resolveUrl(
            clean,
            manifestUrl
          );

        if (!absolute) {
          return match;
        }

        const proxy =
          makeProxyUrl(
            absolute,
            workerOrigin
          );

        return (
          open +
          proxy +
          close
        );
      }
    );

  return manifest;
}


/* =========================================================
   RESOLVE URL
========================================================= */

function resolveUrl(
  value,
  baseUrl
) {

  try {

    /*
     * Ignore data URLs.
     */

    if (
      value.startsWith("data:")
    ) {
      return null;
    }

    /*
     * Ignore blob URLs.
     */

    if (
      value.startsWith("blob:")
    ) {
      return null;
    }

    const resolved =
      new URL(
        value,
        baseUrl
      );

    if (
      resolved.protocol !== "http:" &&
      resolved.protocol !== "https:"
    ) {
      return null;
    }

    /*
     * Block internal hosts in rewritten URLs too.
     */

    if (
      isBlockedHostname(
        resolved.hostname
      )
    ) {
      return null;
    }

    return resolved.toString();

  } catch {

    return null;
  }
}


/* =========================================================
   MAKE PROXY URL
========================================================= */

function makeProxyUrl(
  target,
  workerOrigin
) {

  return (
    workerOrigin +
    PROXY_PATH +
    encodeURIComponent(target)
  );
}


/* =========================================================
   BLOCKED HOSTNAME CHECK
========================================================= */

function isBlockedHostname(
  hostname
) {

  const host =
    hostname
      .toLowerCase()
      .replace(/\.$/, "");

  /* localhost */

  if (
    host === "localhost" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }

  /* IPv4 loopback */

  if (
    host === "127.0.0.1" ||
    host.startsWith("127.")
  ) {
    return true;
  }

  /* IPv4 0.0.0.0 */

  if (
    host === "0.0.0.0"
  ) {
    return true;
  }

  /* IPv6 loopback */

  if (
    host === "::1" ||
    host === "[::1]"
  ) {
    return true;
  }

  /* IPv4 private ranges */

  if (
    isPrivateIPv4(host)
  ) {
    return true;
  }

  /* IPv6 private/local */

  if (
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  ) {
    return true;
  }

  return false;
}


/* =========================================================
   PRIVATE IPv4
========================================================= */

function isPrivateIPv4(
  host
) {

  const parts =
    host.split(".");

  if (parts.length !== 4) {
    return false;
  }

  const numbers =
    parts.map(Number);

  if (
    numbers.some(
      n =>
        !Number.isInteger(n) ||
        n < 0 ||
        n > 255
    )
  ) {
    return false;
  }

  const [
    a,
    b,
    c,
    d
  ] = numbers;

  /* 10.0.0.0/8 */

  if (a === 10) {
    return true;
  }

  /* 172.16.0.0/12 */

  if (
    a === 172 &&
    b >= 16 &&
    b <= 31
  ) {
    return true;
  }

  /* 192.168.0.0/16 */

  if (
    a === 192 &&
    b === 168
  ) {
    return true;
  }

  /* 169.254.0.0/16 */

  if (
    a === 169 &&
    b === 254
  ) {
    return true;
  }

  /* 100.64.0.0/10 */

  if (
    a === 100 &&
    b >= 64 &&
    b <= 127
  ) {
    return true;
  }

  return false;
}
