/**
 * Cloudflare Worker
 * CORS / HLS / DASH Media Proxy
 *
 * URL FORMAT:
 *
 * /proxy/ENCODED_TARGET_URL
 *
 * Example:
 *
 * https://YOUR-WORKER.workers.dev/proxy/https%3A%2F%2Fexample.com%2Flive%2Fmaster.m3u8
 *
 * Supports:
 * - GET
 * - HEAD
 * - OPTIONS
 * - CORS
 * - Range requests
 * - HLS .m3u8
 * - DASH .mpd
 * - TS
 * - M4S
 * - MP4
 * - AAC
 * - Other media responses
 *
 * Use only with domains/streams you own or are authorized
 * to proxy.
 */


/* =========================================================
   CONFIGURATION
========================================================= */

/*
 * Add your authorized domains here.
 *
 * Example:
 *
 * const ALLOWED_HOSTS = [
 *   "livestream2.sunnxt.com",
      "livestream.sunnxt.com",
      "livestream1.sunnxt.com",
      "livestream3.sunnxt.com",
 *   "cdn.example.com",
 * ];
 *
 * Subdomains are also accepted.
 */

const ALLOWED_HOSTS = [
  // "your-domain.com",
  // "cdn.your-domain.com",
];


/*
 * Keep false for a controlled proxy.
 *
 * If true, any HTTP/HTTPS hostname can be requested,
 * creating an open proxy.
 *
 * Not recommended for a public Worker.
 */

const ALLOW_ALL_HOSTS = false;


/*
 * Proxy path.
 */

const PROXY_PATH = "/proxy/";


/*
 * Maximum manifest size to process.
 */

const MAX_MANIFEST_SIZE = 5 * 1024 * 1024;


/* =========================================================
   CORS HEADERS
========================================================= */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",

  "Access-Control-Allow-Methods":
    "GET, HEAD, OPTIONS",

  "Access-Control-Allow-Headers":
    "Range, Origin, Accept, Content-Type, User-Agent",

  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Length, Content-Range, Content-Type",

  "Access-Control-Max-Age":
    "86400",
};


/* =========================================================
   WORKER
========================================================= */

export default {

  async fetch(request) {

    try {

      const workerUrl =
        new URL(request.url);


      /* -----------------------------------------------------
         OPTIONS / CORS PREFLIGHT
      ----------------------------------------------------- */

      if (
        request.method === "OPTIONS"
      ) {

        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS,
        });

      }


      /* -----------------------------------------------------
         ONLY GET / HEAD
      ----------------------------------------------------- */

      if (
        request.method !== "GET" &&
        request.method !== "HEAD"
      ) {

        return jsonResponse(
          {
            error:
              "Method Not Allowed",
          },
          405
        );

      }


      /* -----------------------------------------------------
         HOME PAGE
      ----------------------------------------------------- */

      if (
        workerUrl.pathname === "/" ||
        workerUrl.pathname === ""
      ) {

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


      /* -----------------------------------------------------
         PROXY
      ----------------------------------------------------- */

      if (
        workerUrl.pathname.startsWith(
          PROXY_PATH
        )
      ) {

        return proxyRequest(
          request,
          workerUrl
        );

      }


      /* -----------------------------------------------------
         NOT FOUND
      ----------------------------------------------------- */

      return jsonResponse(
        {
          error: "Not Found",

          usage:
            "/proxy/ENCODED_TARGET_URL",
        },
        404
      );


    } catch (error) {

      return jsonResponse(
        {
          error:
            "Worker Error",

          message:
            String(error),
        },
        500
      );

    }

  },

};


/* =========================================================
   PROXY REQUEST
========================================================= */

async function proxyRequest(
  request,
  workerUrl
) {


  /* -------------------------------------------------------
     EXTRACT ENCODED TARGET URL
  ------------------------------------------------------- */

  const pathname =
    workerUrl.pathname;


  if (
    !pathname.startsWith(
      PROXY_PATH
    )
  ) {

    return jsonResponse(
      {
        error:
          "Invalid proxy path",
      },
      400
    );

  }


  /*
   * Everything after /proxy/
   * is the encoded target URL.
   *
   * Example:
   *
   * /proxy/https%3A%2F%2Fexample.com%2Fvideo.m3u8
   */

  const encodedTarget =
    pathname.substring(
      PROXY_PATH.length
    );


  if (!encodedTarget) {

    return jsonResponse(
      {
        error:
          "Missing target URL",

        usage:
          "/proxy/ENCODED_TARGET_URL",
      },
      400
    );

  }


  /* -------------------------------------------------------
     DECODE TARGET
  ------------------------------------------------------- */

  let targetString;

  try {

    targetString =
      decodeURIComponent(
        encodedTarget
      );

  } catch {

    return jsonResponse(
      {
        error:
          "Invalid encoded target URL",
      },
      400
    );

  }


  /* -------------------------------------------------------
     PARSE TARGET
  ------------------------------------------------------- */

  let targetUrl;

  try {

    targetUrl =
      new URL(
        targetString
      );

  } catch {

    return jsonResponse(
      {
        error:
          "Invalid target URL",

        target:
          targetString,
      },
      400
    );

  }


  /* -------------------------------------------------------
     ALLOW HTTP / HTTPS ONLY
  ------------------------------------------------------- */

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


  /* -------------------------------------------------------
     BLOCK LOCAL ADDRESSES
  ------------------------------------------------------- */

  const hostname =
    targetUrl.hostname.toLowerCase();


  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  ) {

    return jsonResponse(
      {
        error:
          "Local addresses are not allowed",
      },
      403
    );

  }


  /* -------------------------------------------------------
     DOMAIN ALLOWLIST
  ------------------------------------------------------- */

  if (
    !isAllowedHost(
      hostname
    )
  ) {

    return jsonResponse(
      {
        error:
          "Target host is not allowed",

        host:
          hostname,

        message:
          "Add this hostname to ALLOWED_HOSTS in worker.js",
      },
      403
    );

  }


  /* -------------------------------------------------------
     UPSTREAM HEADERS
  ------------------------------------------------------- */

  const upstreamHeaders =
    new Headers();


  /*
   * Range is important for:
   *
   * MP4
   * M4S
   * DASH
   * seeking
   */

  const range =
    request.headers.get(
      "Range"
    );


  if (range) {

    upstreamHeaders.set(
      "Range",
      range
    );

  }


  /*
   * Accept
   */

  const accept =
    request.headers.get(
      "Accept"
    );


  if (accept) {

    upstreamHeaders.set(
      "Accept",
      accept
    );

  }


  /*
   * Accept-Encoding
   */

  const acceptEncoding =
    request.headers.get(
      "Accept-Encoding"
    );


  if (acceptEncoding) {

    upstreamHeaders.set(
      "Accept-Encoding",
      acceptEncoding
    );

  }


  /* -------------------------------------------------------
     UPSTREAM REQUEST
  ------------------------------------------------------- */

  const upstreamRequest =
    new Request(
      targetUrl.toString(),
      {
        method:
          request.method,

        headers:
          upstreamHeaders,

        redirect:
          "follow",
      }
    );


  /* -------------------------------------------------------
     FETCH UPSTREAM
  ------------------------------------------------------- */

  let response;

  try {

    response =
      await fetch(
        upstreamRequest
      );

  } catch (error) {

    return jsonResponse(
      {
        error:
          "Upstream request failed",

        message:
          String(error),
      },
      502
    );

  }


  /* -------------------------------------------------------
     RESPONSE HEADERS
  ------------------------------------------------------- */

  const responseHeaders =
    new Headers();


  /*
   * Headers required/useful for
   * media playback.
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


  for (
    const header
    of headersToCopy
  ) {

    const value =
      response.headers.get(
        header
      );


    if (
      value !== null
    ) {

      responseHeaders.set(
        header,
        value
      );

    }

  }


  /* -------------------------------------------------------
     CORS
  ------------------------------------------------------- */

  for (
    const [
      key,
      value
    ]
    of Object.entries(
      CORS_HEADERS
    )
  ) {

    responseHeaders.set(
      key,
      value
    );

  }


  /* -------------------------------------------------------
     DETECT CONTENT TYPE
  ------------------------------------------------------- */

  const contentType =
    (
      response.headers.get(
        "Content-Type"
      ) || ""
    ).toLowerCase();


  const targetPath =
    targetUrl.pathname.toLowerCase();


  /* -------------------------------------------------------
     HLS
  ------------------------------------------------------- */

  const isHls =

    contentType.includes(
      "application/vnd.apple.mpegurl"
    ) ||

    contentType.includes(
      "application/x-mpegurl"
    ) ||

    contentType.includes(
      "audio/mpegurl"
    ) ||

    targetPath.endsWith(
      ".m3u8"
    );


  /* -------------------------------------------------------
     DASH
  ------------------------------------------------------- */

  const isDash =

    contentType.includes(
      "application/dash+xml"
    ) ||

    targetPath.endsWith(
      ".mpd"
    );


  /* -------------------------------------------------------
     MANIFEST REWRITE
  ------------------------------------------------------- */

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


  /* -------------------------------------------------------
     NORMAL MEDIA RESPONSE
  ------------------------------------------------------- */

  return new Response(
    response.body,
    {
      status:
        response.status,

      statusText:
        response.statusText,

      headers:
        responseHeaders,
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


  /* -------------------------------------------------------
     CHECK CONTENT LENGTH
  ------------------------------------------------------- */

  const contentLength =
    Number(
      response.headers.get(
        "Content-Length"
      ) || 0
    );


  if (
    contentLength >
    MAX_MANIFEST_SIZE
  ) {

    const headers = {

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

    };


    return new Response(
      response.body,
      {
        status:
          response.status,

        statusText:
          response.statusText,

        headers,
      }
    );

  }


  /* -------------------------------------------------------
     READ MANIFEST
  ------------------------------------------------------- */

  let text;

  try {

    text =
      await response.text();

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


  /* -------------------------------------------------------
     SIZE PROTECTION
  ------------------------------------------------------- */

  if (
    text.length >
    MAX_MANIFEST_SIZE
  ) {

    return new Response(
      text,
      {
        status:
          response.status,

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


  /* -------------------------------------------------------
     REWRITE
  ------------------------------------------------------- */

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


  /* -------------------------------------------------------
     RESPONSE
  ------------------------------------------------------- */

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

    "Content-Type":
      outputType,

    "Cache-Control":
      response.headers.get(
        "Cache-Control"
      ) ||
      "no-cache",

    ...CORS_HEADERS,

  };


  /*
   * Do not copy original Content-Length.
   *
   * The manifest changed after rewriting.
   */


  return new Response(
    rewritten,
    {
      status:
        response.status,

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


  /* -------------------------------------------------------
     URI="..."
     
     Handles:
     
     #EXT-X-KEY
     #EXT-X-MAP
     #EXT-X-MEDIA
     #EXT-X-I-FRAME-STREAM-INF
  ------------------------------------------------------- */

  text =
    text.replace(
      /URI="([^"]+)"/gi,
      (match, uri) => {

        if (
          uri.startsWith(
            "data:"
          )
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


        return (
          'URI="' +
          makeProxyUrl(
            absolute,
            workerUrl
          ) +
          '"'
        );

      }
    );


  /* -------------------------------------------------------
     NORMAL HLS URL LINES
     
     Example:
     
     segment.ts
     video/segment.m4s
     https://cdn.example.com/video.ts
  ------------------------------------------------------- */

  const lines =
    text.split(
      /\r?\n/
    );


  const output = [];


  for (
    const line
    of lines
  ) {

    const trimmed =
      line.trim();


    /*
     * Empty lines.
     */

    if (
      trimmed === ""
    ) {

      output.push(
        line
      );

      continue;

    }


    /*
     * HLS tags.
     */

    if (
      trimmed.startsWith(
        "#"
      )
    ) {

      output.push(
        line
      );

      continue;

    }


    /*
     * Resolve media URL.
     */

    const absolute =
      resolveUrl(
        trimmed,
        baseUrl
      );


    if (!absolute) {

      output.push(
        line
      );

      continue;

    }


    /*
     * Replace with proxy URL.
     */

    output.push(
      makeProxyUrl(
        absolute,
        workerUrl
      )
    );

  }


  return output.join(
    "\n"
  );

}


/* =========================================================
   DASH MPD MANIFEST
========================================================= */

function rewriteDashManifest(
  text,
  baseUrl,
  workerUrl
) {


  /* -------------------------------------------------------
     MEDIA / INITIALIZATION / SOURCEURL / INDEX
  ------------------------------------------------------- */

  text =
    text.replace(
      /(\b(?:media|initialization|sourceURL|index)=")([^"]+)(")/gi,
      (
        match,
        prefix,
        value,
        suffix
      ) => {

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


  /* -------------------------------------------------------
     BASEURL
  ------------------------------------------------------- */

  text =
    text.replace(
      /(<BaseURL[^>]*>)([^<]+)(<\/BaseURL>)/gi,
      (
        match,
        prefix,
        value,
        suffix
      ) => {

        const cleanValue =
          value.trim();


        const absolute =
          resolveUrl(
            cleanValue,
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
   RESOLVE URL
========================================================= */

function resolveUrl(
  value,
  baseUrl
) {

  try {

    /*
     * Ignore data/blob URLs.
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


    /*
     * DASH templates are supported.
     *
     * Example:
     *
     * video-$Number$.m4s
     */

    return new URL(
      value,
      baseUrl
    ).toString();


  } catch {

    return null;

  }

}


/* =========================================================
   MAKE PROXY URL
========================================================= */

function makeProxyUrl(
  target,
  workerUrl
) {

  /*
   * IMPORTANT:
   *
   * The entire target URL is encoded once.
   *
   * Result:
   *
   * /proxy/https%3A%2F%2Fexample.com%2Fvideo.m3u8
   */

  return (
    workerUrl.origin +
    PROXY_PATH +
    encodeURIComponent(
      target
    )
  );

}


/* =========================================================
   ALLOWED HOSTS
========================================================= */

function isAllowedHost(
  hostname
) {


  /*
   * Optional open-proxy mode.
   *
   * Keep false.
   */

  if (
    ALLOW_ALL_HOSTS
  ) {

    return true;

  }


  const host =
    hostname
      .toLowerCase();


  return ALLOWED_HOSTS.some(
    allowed => {

      const domain =
        allowed
          .toLowerCase()
          .replace(
            /^\.+/,
            ""
          );


      /*
       * Exact hostname.
       */

      if (
        host === domain
      ) {

        return true;

      }


      /*
       * Subdomain.
       */

      return host.endsWith(
        "." + domain
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

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
Media CORS Proxy
</title>

<style>

body {

  font-family:
    Arial,
    sans-serif;

  max-width:
    900px;

  margin:
    40px auto;

  padding:
    20px;

  line-height:
    1.5;

}

h1 {

  margin-bottom:
    10px;

}

input {

  width:
    100%;

  box-sizing:
    border-box;

  padding:
    12px;

  font-size:
    15px;

  margin:
    10px 0;

}

button {

  padding:
    12px 20px;

  font-size:
    15px;

  cursor:
    pointer;

}

pre {

  background:
    #f4f4f4;

  padding:
    15px;

  border-radius:
    8px;

  overflow-wrap:
    anywhere;

}

.note {

  margin-top:
    20px;

  padding:
    12px;

  background:
    #fff3cd;

  border-radius:
    8px;

}

</style>

</head>

<body>

<h1>
Media CORS Proxy
</h1>

<p>
Enter an authorized media URL:
</p>

<input
  id="source"
  placeholder="https://example.com/live/master.m3u8"
>

<button
  onclick="generate()"
>
Generate Proxy URL
</button>

<pre id="result">
Waiting...
</pre>

<div class="note">

Use this proxy only with media servers
and URLs that you own or are authorized
to proxy.

</div>

<script>

function generate() {

  const source =
    document
      .getElementById("source")
      .value
      .trim();


  const result =
    document
      .getElementById("result");


  if (!source) {

    result.textContent =
      "Please enter a URL.";

    return;

  }


  try {

    const proxy =
      window.location.origin +
      "/proxy/" +
      encodeURIComponent(
        source
      );


    result.textContent =
      proxy;


  } catch (error) {

    result.textContent =
      "Invalid URL.";

  }

}

</script>

</body>

</html>`;

}
