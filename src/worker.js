export default {
  async fetch(request) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    };

    /*
     * Default test API
     * You can replace this with your own authorized API.
     */
    const DEFAULT_API =
      "https://httpbin.org/anything";

    /*
     * Proxy endpoint
     *
     * Example:
     * /corsproxy/?apiurl=https://httpbin.org/anything
     */
    const PROXY_ENDPOINT = "/corsproxy/";

    /*
     * Handle CORS preflight
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    /*
     * Only allow GET, HEAD and POST
     */
    if (!["GET", "HEAD", "POST"].includes(request.method)) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders,
      });
    }

    /*
     * Only proxy requests on /corsproxy/
     */
    if (url.pathname.startsWith(PROXY_ENDPOINT)) {
      return handleProxy(request, url);
    }

    /*
     * Simple test page
     */
    return new Response(
      `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>CORS Proxy</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      padding: 30px;
      line-height: 1.5;
    }

    pre {
      background: #f3f3f3;
      padding: 15px;
      border-radius: 8px;
      white-space: pre-wrap;
    }

    button {
      padding: 10px 18px;
      cursor: pointer;
    }
  </style>
</head>

<body>

<h1>CORS Proxy Test</h1>

<button onclick="testProxy()">Test Proxy</button>

<pre id="result">Waiting...</pre>

<script>

async function testProxy() {

  const result = document.getElementById("result");

  result.textContent = "Loading...";

  try {

    const target =
      "https://httpbin.org/anything";

    const proxy =
      window.location.origin +
      "/corsproxy/?apiurl=" +
      encodeURIComponent(target);

    const response = await fetch(proxy);

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        "HTTP " + response.status + "\\n" + text
      );
    }

    try {
      const data = JSON.parse(text);

      result.textContent =
        JSON.stringify(data, null, 2);

    } catch {
      result.textContent = text;
    }

  } catch (error) {

    result.textContent =
      "ERROR:\\n" + error;

  }

}

</script>

</body>
</html>`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=UTF-8",
        },
      }
    );
  },
};


/* =========================================================
   PROXY HANDLER
========================================================= */

async function handleProxy(request, url) {

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };

  /*
   * Get target URL
   */
  const apiUrl = url.searchParams.get("apiurl");

  if (!apiUrl) {

    return new Response(
      JSON.stringify({
        error: "Missing apiurl parameter",
        example:
          "/corsproxy/?apiurl=https://httpbin.org/anything",
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }

  /*
   * Validate URL
   */
  let target;

  try {

    target = new URL(apiUrl);

  } catch {

    return new Response(
      JSON.stringify({
        error: "Invalid URL",
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }

  /*
   * Only HTTP/HTTPS
   */
  if (
    target.protocol !== "http:" &&
    target.protocol !== "https:"
  ) {

    return new Response(
      JSON.stringify({
        error: "Only HTTP and HTTPS URLs are allowed",
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }

  /*
   * Copy incoming headers
   */
  const headers = new Headers(request.headers);

  /*
   * Remove browser-specific headers that should not
   * be forwarded to the remote server.
   */
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");

  /*
   * Create upstream request
   */
  const upstreamRequest = new Request(target.toString(), {
    method: request.method,
    headers,
    body:
      request.method === "GET" ||
      request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "follow",
  });

  let response;

  try {

    response = await fetch(upstreamRequest);

  } catch (error) {

    return new Response(
      JSON.stringify({
        error: "Upstream request failed",
        message: String(error),
      }),
      {
        status: 502,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }

  /*
   * Copy upstream response
   */
  const responseHeaders = new Headers(response.headers);

  /*
   * Remove upstream CORS restrictions
   */
  responseHeaders.delete("Access-Control-Allow-Origin");
  responseHeaders.delete("Access-Control-Allow-Credentials");

  /*
   * Add our CORS headers
   */
  responseHeaders.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  responseHeaders.set(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, OPTIONS"
  );

  responseHeaders.set(
    "Access-Control-Allow-Headers",
    "*"
  );

  /*
   * Preserve useful media headers
   */
  if (response.headers.has("Content-Type")) {
    responseHeaders.set(
      "Content-Type",
      response.headers.get("Content-Type")
    );
  }

  if (response.headers.has("Content-Length")) {
    responseHeaders.set(
      "Content-Length",
      response.headers.get("Content-Length")
    );
  }

  if (response.headers.has("Accept-Ranges")) {
    responseHeaders.set(
      "Accept-Ranges",
      response.headers.get("Accept-Ranges")
    );
  }

  if (response.headers.has("Content-Range")) {
    responseHeaders.set(
      "Content-Range",
      response.headers.get("Content-Range")
    );
  }

  /*
   * Return streamed response
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
