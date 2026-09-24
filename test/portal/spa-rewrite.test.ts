import { runInNewContext } from 'node:vm';
import { describe, expect, test } from '@jest/globals';
import { AppStage } from '../../lib/common/config';
import { renderSpaRewriteCode } from '../../lib/portal/infra/infrastructure-stack';
import { getHostedApps, HostedApp } from '../../lib/portal/infra/apps';

/**
 * Behavioural tests for the generated CloudFront viewer-request function.
 *
 * The function decides which app's HTML serves a URL, so a mistake here routes users to the wrong
 * frontend, or to the wrong page within the right frontend. Asserting on the generated source string
 * is not enough, so these tests execute it.
 */

type CloudFrontEvent = { request: { uri: string } };
type Handler = (event: CloudFrontEvent) => { uri: string };

/**
 * Run the generated function source in a fresh context and return its `handler`, the way CloudFront
 * evaluates the function code it is given. The declaration lands on the sandbox as a global.
 */
const loadHandlerFor = (hostedApps: HostedApp[]): Handler => {
  const sandbox: { handler?: Handler } = {};
  runInNewContext(renderSpaRewriteCode(hostedApps), sandbox);

  expect(typeof sandbox.handler).toBe('function');
  return sandbox.handler!;
};

const loadHandler = (appStage: AppStage): Handler => loadHandlerFor(getHostedApps(appStage));

const route = (handler: Handler, uri: string): string => handler({ request: { uri } }).uri;

describe('beta, where every app is hosted', () => {
  const handler = loadHandler(AppStage.BETA);

  test.each([
    // Root app (SPA) owns the site root and anything unrecognised.
    ['/', '/index.html'],
    ['/subjects', '/index.html'],
    ['/libraries/lib.12345', '/index.html'],
    ['/not-an-app/page', '/index.html'],
    // SPA apps: every route loads that app's single shell.
    ['/v2', '/v2/index.html'],
    ['/v2/', '/v2/index.html'],
    ['/v2/workflows', '/v2/index.html'],
    ['/v2/workflows/deeply/nested', '/v2/index.html'],
    ['/hub', '/hub/index.html'],
    ['/hub/', '/hub/index.html'],
    ['/hub/dashboard', '/hub/index.html'],
    ['/hub/a/b/c', '/hub/index.html'],
  ])('SPA: routes %s to %s', (uri, expected) => {
    expect(route(handler, uri)).toBe(expected);
  });

  test.each([
    // Static export: the requested path is preserved and resolved to its own exported HTML file,
    // so a deep link renders that page rather than the app's home page.
    ['/orcahouse', '/orcahouse/index.html'],
    ['/orcahouse/', '/orcahouse/index.html'],
    ['/orcahouse/tables', '/orcahouse/tables/index.html'],
    ['/orcahouse/tables/', '/orcahouse/tables/index.html'],
    ['/orcahouse/tables/subjects', '/orcahouse/tables/subjects/index.html'],
    ['/orcahouse/a/b/c', '/orcahouse/a/b/c/index.html'],
  ])('static export: routes %s to %s', (uri, expected) => {
    expect(route(handler, uri)).toBe(expected);
  });

  test.each([
    // Static assets are served by key, never rewritten, at the root and under any prefix.
    '/env.js',
    '/assets/main-abc123.js',
    '/manifest.json',
    '/robots.txt',
    '/favicon.ico',
    '/hub/env.js',
    '/hub/assets/main-abc123.css',
    '/orcahouse/env.js',
    '/orcahouse/manifest.json',
    '/orcahouse/_next/static/chunks/main-abc123.js',
    '/v2/assets/index-9f8e7d.js',
  ])('serves %s unchanged', (uri) => {
    expect(route(handler, uri)).toBe(uri);
  });

  test('does not mistake a dotted orcabus ID for a filename', () => {
    // The reason the function matches known extensions instead of checking for a dot.
    expect(route(handler, '/runs/wfr.01ABCDEF')).toBe('/index.html');
    expect(route(handler, '/hub/files/fil.01ABCDEF')).toBe('/hub/index.html');
    expect(route(handler, '/orcahouse/rows/lib.01ABCDEF')).toBe(
      '/orcahouse/rows/lib.01ABCDEF/index.html'
    );
  });

  test('a prefix is not matched as a bare substring', () => {
    // '/hubbub' is a root-app route, not Hub.
    expect(route(handler, '/hubbub')).toBe('/index.html');
    expect(route(handler, '/v2beta')).toBe('/index.html');
    expect(route(handler, '/orcahouse-admin')).toBe('/index.html');
  });

  test('prefix matching is case sensitive, as CloudFront path patterns are', () => {
    expect(route(handler, '/HUB/page')).toBe('/index.html');
    expect(route(handler, '/OrcaHouse/page')).toBe('/index.html');
  });

  test('a JavaScript object property name is not mistaken for an app prefix', () => {
    // ROUTE_TABLE is a plain object, so a segment like 'constructor' or 'toString' would be
    // truthy on the prototype chain if membership were tested with `in` or a bare lookup.
    expect(route(handler, '/constructor/page')).toBe('/index.html');
    expect(route(handler, '/toString')).toBe('/index.html');
    expect(route(handler, '/__proto__/x')).toBe('/index.html');
  });
});

describe('prod, where Hub and OrcaHouse are hosted but gamma is skipped', () => {
  const handler = loadHandler(AppStage.PROD);

  test('keeps serving OrcaUI and v2 exactly as before', () => {
    expect(route(handler, '/')).toBe('/index.html');
    expect(route(handler, '/subjects')).toBe('/index.html');
    expect(route(handler, '/v2')).toBe('/v2/index.html');
    expect(route(handler, '/v2/workflows')).toBe('/v2/index.html');
    expect(route(handler, '/env.js')).toBe('/env.js');
  });

  test('serves the new apps', () => {
    expect(route(handler, '/hub/dashboard')).toBe('/hub/index.html');
    expect(route(handler, '/orcahouse/tables')).toBe('/orcahouse/tables/index.html');
  });
});

describe('gamma, where Hub and OrcaHouse are not hosted', () => {
  const handler = loadHandler(AppStage.GAMMA);

  test('routes an unprovisioned app to the root app rather than a missing origin', () => {
    // No bucket in gamma means no /hub/* behaviour and no route table entry, so these fall through
    // to the root app, which renders its own not-found route.
    expect(route(handler, '/hub')).toBe('/index.html');
    expect(route(handler, '/hub/dashboard')).toBe('/index.html');
    expect(route(handler, '/orcahouse/tables')).toBe('/index.html');
  });
});

describe('routing mode is taken from the registry, not the prefix', () => {
  const asStaticExport: HostedApp[] = [
    { id: 'root', pathPrefix: '', clientRouting: 'static-export', bucketName: 'root-bucket' },
    { id: 'app', pathPrefix: 'app', clientRouting: 'spa', bucketName: 'app-bucket' },
  ];

  test('a static-export root app resolves its own directory indexes', () => {
    const handler = loadHandlerFor(asStaticExport);

    expect(route(handler, '/')).toBe('/index.html');
    expect(route(handler, '/about')).toBe('/about/index.html');
    expect(route(handler, '/about/team')).toBe('/about/team/index.html');
    // The nested app still uses its own mode.
    expect(route(handler, '/app/anything/deep')).toBe('/app/index.html');
  });
});
