/**
 * Cloudflare Worker - CORS / Media Proxy
 *
 * Endpoint:
 *   /proxy?url=https://example.com/video.m3u8
 *
 * Examples:
 *   /proxy?url=https%3A%2F%2Fexample.com%2Fvideo.m3u8
 *   /proxy?url=https%3A%2F%2Fexample.com%2Fvideo.mpd
 *
 * Supported:
 *   - GET
 *   - HEAD
 *   - OPTIONS
 *   - CORS
 *   - HTTP Range requests
 *   - HLS .m3u8
 *   - DASH .mpd
 *   - TS / M4S / MP4 / AAC etc.
 *
 * The proxy does NOT proxy DRM license requests.
 */


/* =========================================================
   CONFIGURATION
========================================================= */

/*
 * Add the domains that you own or are authorized to proxy.
 *
 * Example:
 *
 * const ALLOWED_HOSTS = [
 *   "example.com",
 *   "cdn.example.com",
 *   "stream.example.net"
 * ];
 *
 * Subdomains are matched automatically.
 */

const ALLOWED_HOSTS = [
  // "your-domain.com",
  // "cdn.your-domain.com",
];


/*
 * Set this to true only if you intentionally want the Worker
 * to proxy arbitrary HTTP/HTTPS URLs.
 *
 * This is NOT recommended for a public Worker because it
 * creates an open proxy.
 */
const ALLOW_ALL_HOSTS = false;


/*
 * Proxy endpoint.
 */
const PROXY_PATH = "/proxy";


/*
 * Maximum manifest size that the Worker will rewrite.
 *
 * HLS/DASH manifests are normally small.
 */
const MAX_MANIFEST_SIZE = 5 * 1024 * 1024;


/* =========================================================
   CORS HEADERS
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
   MAIN WORKER
========================================================= */

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);

      /*
       * CORS preflight
       */
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS,
        });
      }


      /*
       * Only GET and HEAD are required for media playback.
       */
      if (
        request.method !== "GET" &&
        request.method !== "HEAD"
      ) {
        return jsonResponse(
          {
            error: "Method Not Allowed",
          },
          405
        );
      }


      /*
       * Root page.
       */
      if (url.pathname === "/" || url.pathname === "") {
        return new Response(
          getHomePage(),
          {
            status: 200,
            headers: {
              "Content-Type":
                "text/html; charset=UTF-8",
              ...CORS_HEADERS,
            },
          }
        );
      }


      /*
       * Proxy request.
       */
      if (url.pathname === PROXY_PATH) {
        return proxyRequest(request, url);
      }


      /*
       * Unknown endpoint.
       */
      return jsonResponse(
        {
          error: "Not Found",
          usage:
            "/proxy?url=https://your-authorized-domain.com/stream.m3u8",
        },
        404
      );

    } catch (error) {
      return jsonResponse(
        {
          error: "Worker Error",
          message: String(error),
        },
        500
      );
    }
  },
};


/* =========================================================
   PROXY REQUEST
========================================================= */

async function proxyRequest(request, workerUrl) {

  /*
   * Get target URL.
   */
  const targetString =
    workerUrl.searchParams.get("url");

  if (!targetString) {
    return jsonResponse(
      {
        error: "Missing url parameter",
        example:
          "/proxy?url=https://example.com/video.m3u8",
      },
      400
    );
  }


  /*
   * Parse target URL.
   */
  let targetUrl;

  try {
    targetUrl = new URL(targetString);
  } catch {
    return jsonResponse(
      {
        error: "Invalid target URL",
      },
      400
    );
  }


  /*
   * Only HTTP and HTTPS.
   */
  if (
    targetUrl.protocol !== "https:" &&
    targetUrl.protocol !== "http:"
  ) {
    return jsonResponse(
      {
        error:
          "Only HTTP and HTTPS URLs are allowed",
      },
      400
    );
  }


  /*
   * Prevent local/private protocols.
   */
  if (
    targetUrl.hostname === "localhost" ||
    targetUrl.hostname === "127.0.0.1" ||
    targetUrl.hostname === "::1"
  ) {
    return jsonResponse(
      {
        error: "Local addresses are not allowed",
      },
      403
    );
  }


  /*
   * Check domain allowlist.
   */
  if (!isAllowedHost(targetUrl.hostname)) {
    return jsonResponse(
      {
        error: "Target host is not allowed",
        host: targetUrl.hostname,
      },
      403
    );
  }


  /*
   * Build upstream headers.
   */
  const upstreamHeaders = new Headers();


  /*
   * Preserve Range requests.
   *
   * This is important for:
   *   MP4
   *   M4S
   *   DASH segments
   *   video seeking
   */
  const range =
    request.headers.get("Range");

  if (range) {
    upstreamHeaders.set("Range", range);
  }


  /*
   * Preserve Accept.
   */
  const accept =
    request.headers.get("Accept");

  if (accept) {
    upstreamHeaders.set("Accept", accept);
  }


  /*
   * Preserve Accept-Encoding where appropriate.
   */
  const acceptEncoding =
    request.headers.get("Accept-Encoding");

  if (acceptEncoding) {
    upstreamHeaders.set(
      "Accept-Encoding",
      acceptEncoding
    );
  }


  /*
   * Do not forward browser Origin/Host/Cookie headers.
   *
   * This avoids accidentally leaking browser credentials
   * to the upstream server.
   */
  const upstreamRequest = new Request(
    targetUrl.toString(),
    {
      method: request.method,
      headers: upstreamHeaders,
      redirect: "follow",
    }
  );


  /*
   * Fetch upstream.
   */
  let response;

  try {
    response = await fetch(
      upstreamRequest
    );
  } catch (error) {
    return jsonResponse(
      {
        error: "Upstream request failed",
        message: String(error),
      },
      502
    );
  }


  /*
   * Copy response headers.
   */
  const responseHeaders =
    new Headers();


  /*
   * Headers useful for media playback.
   */
  const headersToCopy = [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "Cache-Control",
    "ETag",
    "Last-Modified",
    "Expires",
    "Content-Encoding",
  ];


  for (const header of headersToCopy) {
    const value =
      response.headers.get(header);

    if (value !== null) {
      responseHeaders.set(
        header,
        value
      );
    }
  }


  /*
   * Add CORS.
   */
  for (const [key, value] of Object.entries(
    CORS_HEADERS
  )) {
    responseHeaders.set(
      key,
      value
    );
  }


  /*
   * Detect content type.
   */
  const contentType =
    (
      response.headers.get(
        "Content-Type"
      ) || ""
    ).toLowerCase();


  const pathname =
    targetUrl.pathname.toLowerCase();


  const isHls =
    contentType.includes(
      "application/vnd.apple.mpegurl"
    ) ||
    contentType.includes(
      "application/x-mpegurl"
    ) ||
    pathname.endsWith(".m3u8");


  const isDash =
    contentType.includes(
      "application/dash+xml"
    ) ||
    pathname.endsWith(".mpd");


  /*
   * Rewrite HLS/DASH manifests.
   *
   * This is necessary because a manifest can contain
   * relative URLs pointing directly to the upstream CDN.
   */
  if (
    (isHls || isDash) &&
    request.method === "GET"
  ) {
    return rewriteManifest(
      response,
      targetUrl,
      workerUrl,
      isHls
    );
  }


  /*
   * Normal media response.
   *
   * The body is streamed directly through Cloudflare.
   */
  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    }
  );
}


/* =========================================================
   MANIFEST REWRITER
========================================================= */

async function rewriteManifest(
  response,
  targetUrl,
  workerUrl,
  isHls
) {

  /*
   * Read manifest.
   */
  const contentLength =
    Number(
      response.headers.get(
        "Content-Length"
      ) || 0
    );


  /*
   * Avoid processing unexpectedly large files.
   */
  if (
    contentLength > MAX_MANIFEST_SIZE
  ) {
    return new Response(
      response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: {
          ...Object.fromEntries(
            response.headers
          ),
          ...CORS_HEADERS,
        },
      }
    );
  }


  let text;

  try {
    text = await response.text();
  } catch {
    return new Response(
      "Unable to read manifest",
      {
        status: 502,
        headers: {
          "Content-Type":
            "text/plain; charset=UTF-8",
          ...CORS_HEADERS,
        },
      }
    );
  }


  /*
   * Protect against very large manifests even when
   * Content-Length was not supplied.
   */
  if (
    text.length > MAX_MANIFEST_SIZE
  ) {
    return new Response(
      text,
      {
        status: response.status,
        headers: {
          "Content-Type":
            response.headers.get(
              "Content-Type"
            ) ||
            (
              isHls
                ? "application/vnd.apple.mpegurl"
                : "application/dash+xml"
            ),
          ...CORS_HEADERS,
        },
      }
    );
  }


  let rewritten;

  if (isHls) {
    rewritten =
      rewriteHlsManifest(
        text,
        targetUrl,
        workerUrl
      );
  } else {
    rewritten =
      rewriteDashManifest(
        text,
        targetUrl,
        workerUrl
      );
  }


  const outputType =
    response.headers.get(
      "Content-Type"
    ) ||
    (
      isHls
        ? "application/vnd.apple.mpegurl"
        : "application/dash+xml"
    );


  const headers = {
    "Content-Type": outputType,
    ...CORS_HEADERS,
  };


  /*
   * Do not retain the original Content-Length because
   * the manifest size changed after rewriting.
   */
  headers["Cache-Control"] =
    response.headers.get(
      "Cache-Control"
    ) || "no-cache";


  return new Response(
    rewritten,
    {
      status: response.status,
      headers,
    }
  );
}


/* =========================================================
   HLS MANIFEST
========================================================= */

function rewriteHlsManifest(
  text,
  baseUrl,
  workerUrl
) {

  /*
   * Rewrite URI="..." attributes.
   *
   * Used by:
   *
   * #EXT-X-KEY
   * #EXT-X-MAP
   * #EXT-X-MEDIA
   * etc.
   */
  text = text.replace(
    /URI="([^"]+)"/gi,
    (match, uri) => {

      /*
       * Do not modify data URLs.
       */
      if (
        uri.startsWith("data:")
      ) {
        return match;
      }


      const absolute =
        resolveUrl(
          uri,
          baseUrl
        );


      if (!absolute) {
        return match;
      }


      return `URI="${makeProxyUrl(
        absolute,
        workerUrl
      )}"`;
    }
  );


  /*
   * Rewrite ordinary HLS URI lines.
   *
   * Examples:
   *
   * segment.ts
   * video/segment1.m4s
   * https://cdn.example.com/a.ts
   */
  const lines =
    text.split(/\r?\n/);


  const output = [];


  for (const line of lines) {

    const trimmed =
      line.trim();


    /*
     * Comments/tags remain unchanged.
     */
    if (
      trimmed === "" ||
      trimmed.startsWith("#")
    ) {
      output.push(line);
      continue;
    }


    /*
     * Resolve media URI.
     */
    const absolute =
      resolveUrl(
        trimmed,
        baseUrl
      );


    if (!absolute) {
      output.push(line);
      continue;
    }


    output.push(
      makeProxyUrl(
        absolute,
        workerUrl
      )
    );
  }


  return output.join("\n");
}


/* =========================================================
   DASH MPD MANIFEST
========================================================= */

function rewriteDashManifest(
  text,
  baseUrl,
  workerUrl
) {

  /*
   * Rewrite XML attributes containing URLs.
   *
   * Handles common DASH attributes:
   *
   * media=""
   * initialization=""
   * sourceURL=""
   * index=""
   */
  text = text.replace(
    /(\b(?:media|initialization|sourceURL|index)=")([^"]+)(")/gi,
    (match, prefix, value, suffix) => {

      /*
       * Template URLs may contain:
       *
       * $Number$
       * $RepresentationID$
       *
       * These are still valid URL templates.
       */
      const absolute =
        resolveUrl(
          value,
          baseUrl
        );


      if (!absolute) {
        return match;
      }


      return (
        prefix +
        makeProxyUrl(
          absolute,
          workerUrl
        ) +
        suffix
      );
    }
  );


  /*
   * Rewrite <BaseURL>...</BaseURL>.
   *
   * This is important for DASH manifests that use:
   *
   * <BaseURL>https://cdn.example.com/video/</BaseURL>
   */
  text = text.replace(
    /(<BaseURL[^>]*>)([^<]+)(<\/BaseURL>)/gi,
    (match, prefix, value, suffix) => {

      const absolute =
        resolveUrl(
          value.trim(),
          baseUrl
        );


      if (!absolute) {
        return match;
      }


      return (
        prefix +
        makeProxyUrl(
          absolute,
          workerUrl
        ) +
        suffix
      );
    }
  );


  return text;
}


/* =========================================================
   URL HELPERS
========================================================= */

function resolveUrl(
  value,
  baseUrl
) {

  try {

    /*
     * Ignore unsupported schemes.
     */
    if (
      value.startsWith(
        "data:"
      ) ||
      value.startsWith(
        "blob:"
      )
    ) {
      return null;
    }


    return new URL(
      value,
      baseUrl
    ).toString();

  } catch {
    return null;
  }
}


/*
 * Build Worker proxy URL.
 */
function makeProxyUrl(
  target,
  workerUrl
) {

  const proxy =
    new URL(
      PROXY_PATH,
      workerUrl.origin
    );


  proxy.searchParams.set(
    "url",
    target
  );


  return proxy.toString();
}


/* =========================================================
   DOMAIN ALLOWLIST
========================================================= */

function isAllowedHost(
  hostname
) {

  /*
   * Explicitly enabled open proxy.
   */
  if (ALLOW_ALL_HOSTS) {
    return true;
  }


  const host =
    hostname.toLowerCase();


  /*
   * Exact or subdomain match.
   */
  return ALLOWED_HOSTS.some(
    allowed => {

      const domain =
        allowed
          .toLowerCase()
          .replace(
            /^\.+/,
            ""
          );


      return (
        host === domain ||
        host.endsWith(
          "." + domain
        )
      );
    }
  );
}


/* =========================================================
   JSON RESPONSE
========================================================= */

function jsonResponse(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",
        ...CORS_HEADERS,
      },
    }
  );
}


/* =========================================================
   HOME PAGE
========================================================= */

function getHomePage() {

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1">
<title>Media CORS Proxy</title>

<style>

body {
  font-family: Arial, sans-serif;
  max-width: 900px;
  margin: 40px auto;
  padding: 20px;
  line-height: 1.5;
}

h1 {
  margin-bottom: 10px;
}

input {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  font-size: 15px;
  margin: 10px 0;
}

button {
  padding: 12px 20px;
  font-size: 15px;
  cursor: pointer;
}

pre {
  background: #f4f4f4;
  padding: 15px;
  border-radius: 8px;
  overflow-wrap: anywhere;
}

.note {
  padding: 12px;
  background: #fff3cd;
  border-radius: 8px;
}

</style>
</head>

<body>

<h1>Media CORS Proxy</h1>

<p>
Authorized media URL:
</p>

<input
  id="source"
  placeholder="https://your-domain.com/video.m3u8"
>

<button onclick="generate()">
Generate Proxy URL
</button>

<pre id="result">Waiting...</pre>

<div class="note">
Use this proxy only with media servers and URLs that
you own or are authorized to proxy.
</div>

<script>

function generate() {

  const source =
    document.getElementById("source").value.trim();

  const result =
    document.getElementById("result");

  if (!source) {
    result.textContent =
      "Please enter a URL.";
    return;
  }

  try {

    const proxy =
      window.location.origin +
      "/proxy?url=" +
      encodeURIComponent(source);

    result.textContent = proxy;

  } catch (e) {

    result.textContent =
      "Invalid URL.";

  }
}

</script>

</body>
</html>`;
}
