// CloudFront Function (viewer-request) shared by every behaviour on the portal distribution.
//
// The ROUTE_TABLE line below is REGENERATED AT SYNTH TIME from the apps hosted in the target stage;
// see renderSpaRewriteCode() in ../infrastructure-stack.ts. The literal default keeps this file
// valid JavaScript so eslint still checks it, and describes the historical single-app setup.
// Do not reformat that line onto multiple lines: synth asserts it can replace it and fails if not.
//
// Each entry maps a path prefix to that app's client routing mode:
//   'spa'           one index.html shell, so every route rewrites to <prefix>/index.html
//   'static-export' one HTML file per route, so a route rewrites to <route>/index.html
// The '' key is the root app, which owns anything no other prefix claims. Any other key's bare path
// ('/v2', no trailing slash) is redirected to '/v2/' rather than rewritten.
var ROUTE_TABLE = { '': 'spa', v2: 'spa' };

// The query string exactly as the viewer sent it, with its leading '?', or '' if there is none.
function queryStringOf(request) {
  if (typeof request.rawQueryString === 'function') {
    var raw = request.rawQueryString();
    return raw ? '?' + raw : '';
  }
  // Fallback for a runtime without rawQueryString(): rebuild it from the parsed object, as AWS's
  // own CloudFront Functions examples do.
  var parts = [];
  var querystring = request.querystring || {};
  for (var key in querystring) {
    var entry = querystring[key];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var i = 0; i < values.length; i++) {
      parts.push(key + '=' + values[i].value);
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Requests for static files are served by key. We match known extensions explicitly rather than
  // checking for a dot, because orcabus IDs contain dots (e.g. wfr.xxx, fil.xxx, sqs.xxx, lib.xxx)
  // and would otherwise be mistaken for filenames.
  if (
    /\.(js|css|html|json|map|ico|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|eot|txt|xml|webmanifest)$/i.test(
      uri
    )
  ) {
    return request;
  }

  // The first path segment selects the app. Anything unrecognised belongs to the root app, whose
  // prefix is the empty string.
  var firstSegment = uri.split('/')[1];
  var prefix = Object.prototype.hasOwnProperty.call(ROUTE_TABLE, firstSegment) ? firstSegment : '';
  var base = prefix === '' ? '' : '/' + prefix;

  // A bare prefix ('/v2') matches no '/v2/*' behaviour, so CloudFront has already sent it to the
  // root app's bucket, and rewriting the URI cannot change that origin. Redirect it to the base path
  // the app is built for instead; the follow-up request matches the app's own behaviour.
  if (prefix !== '' && uri === base) {
    return {
      statusCode: 302,
      statusDescription: 'Found',
      headers: { location: { value: base + '/' + queryStringOf(request) } },
    };
  }

  if (ROUTE_TABLE[prefix] === 'static-export') {
    // Per-route HTML: keep the requested path and append the directory index.
    // '/orcahouse/a/b' and '/orcahouse/a/b/' both resolve to '/orcahouse/a/b/index.html'.
    var path = uri.charAt(uri.length - 1) === '/' ? uri.slice(0, -1) : uri;
    request.uri = path + '/index.html';
    return request;
  }

  // Single shell: every client-side route loads the app's index.html.
  request.uri = base + '/index.html';
  return request;
}
